# S05: Checkpoint/Resume for Long Scans — Research

**Date:** 2026-03-15

## Summary

S05 adds a checkpoint/resume mechanism so that an interrupted multi-account/subscription/project scan can be restarted from where it left off — skipping already-completed accounts and replaying their saved findings — without re-scanning. The slice is self-contained: it produces `internal/checkpoint/checkpoint.go` and integration hooks in the three multi-account fan-out loops (AWS `scanOrg`, Azure `scanAllSubscriptions`, GCP `scanAllProjects`).

The main complexity is deciding *what* to persist, *where*, and *how the user passes the path back on resume*. The checkpoint must store: the list of all accounts/subscriptions/projects for the scan, which ones completed successfully, and the `[]calculator.FindingRow` rows for each completed unit — so a resumed scan can reconstruct the partial result set from disk and skip those units in the fan-out. JSON is the mandated format (portable, human-readable, forward-compatible per CONTEXT.md).

The integration point is the per-unit completion callback inside each `wg.Add(1)` goroutine, after `rows` are collected and before they are appended to the shared findings slice. The checkpoint write is non-fatal — if it fails the scan continues with a warning event. The checkpoint path flows from `ScanStartRequest` → `ScanProviderSpec` → `ScanProviderRequest` → `ScanRequest` → scanner, following the exact same pipeline pattern already established for `MaxWorkers` and `RequestTimeout`.

## Recommendation

**Add `CheckpointPath string` to `ScanRequest` and thread it from frontend → API → orchestrator → scanner.** Each scanner reads the checkpoint at startup (skipping completed units + prepending saved rows), and writes an updated checkpoint file atomically after each unit completes. The path is auto-generated in `os.TempDir()` when not provided — zero-config by default, but user-overridable for testing/debugging.

The checkpoint state struct persists: `ScanID`, `Provider`, `CreatedAt`, `CompletedUnits []CompletedUnit` (each with `ID`, `Name`, `Findings []FindingRow`), and `Version int` (forward-compatibility guard). A `V1` version constant ensures old checkpoints can be detected and rejected on format change. Atomic write uses the `rename(tmp → final)` idiom via `os.WriteFile` to a `.tmp` path + `os.Rename` — the only safe way to write JSON checkpoints without corruption on interrupt.

Do **not** try to hook this at the orchestrator level. The orchestrator does not know about per-account granularity — it sees one `Scan()` call per provider. The hooks belong inside the scanner fan-out loops where `acct.ID` / `subID` / `projID` are visible.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Atomic JSON file write | `os.WriteFile(tmp) + os.Rename(tmp, final)` | rename() is atomic on POSIX; prevents corrupt checkpoint on crash mid-write |
| Concurrent checkpoint access | sync.Mutex wrapping Save() | Multiple goroutines complete simultaneously; mu-protected write prevents interleaving |
| Checkpoint file location | `os.TempDir()` | Already used for NIOS backup files (server/scan.go:185); zero-config default |
| Retry wrapper | `cloudutil.CallWithBackoff` (S01) | CONTEXT.md says "checkpoint wraps around the retry-aware scan loop" — retry is already in the scanner; no new retry logic needed in checkpoint |
| Fan-out semaphore | `cloudutil.NewSemaphore` (S01) | Already used in all three scanners; checkpoint hooks go inside the existing goroutine bodies |

## Existing Code and Patterns

- `internal/cloudutil/retry.go` — `CallWithBackoff[T]` and `Semaphore` already used in all three fan-out loops; checkpoint write is a side-effect inside those loops, not a replacement
- `internal/scanner/aws/scanner.go:133–203` — `scanOrg()` fan-out loop: after `rows, scanErr := scanOneAccount(...)` at line 177, the per-account completion block (lines 191–197) is the exact injection point for checkpoint write + skip logic
- `internal/scanner/azure/scanner.go:81–130` — `scanAllSubscriptions()` fan-out loop: after `rows, scanErr := scanSubscriptionFunc(...)` at line 104, the per-subscription completion block (lines 118–124) is the injection point
- `internal/scanner/gcp/scanner.go:348–385` — `scanAllProjects()` fan-out loop: after `rows := scanOneProject(...)` at line 368, the per-project completion event (lines 374–379) is the injection point
- `internal/scanner/provider.go` — `ScanRequest` struct already has `MaxWorkers int` and `RequestTimeout int` as the model for adding `CheckpointPath string`; zero-value (empty string) means "no checkpoint" using the same zero-means-default semantics
- `server/types.go` — `ScanProviderSpec` and `ScanStartRequest` follow the same pattern as adding `MaxWorkers`; `CheckpointPath string` with `omitempty` preserves backward compatibility
- `internal/orchestrator/orchestrator.go` — `buildScanRequest()` copies `MaxWorkers` and `RequestTimeout` from `ScanProviderRequest` into `ScanRequest`; same copy pattern for `CheckpointPath`
- `internal/calculator/calculator.go` — `FindingRow` has no json tags; Go's default JSON encoding (capitalized field names) is correct and sufficient for checkpoint persistence since we control the format entirely
- `server/scan.go:185` — `os.CreateTemp("", "nios-onedb-*.xml")` shows the project convention: use `os.TempDir()` for transient files; the checkpoint should follow the same convention with `"checkpoint-{scanId}-{provider}-*.json"` naming

## Constraints

- **`FindingRow` has no json tags** — Go default encoding is used (`Provider`, `Source`, `Region`, etc. as field names). This is fine for checkpoint files since we own the format. Do NOT add json tags to `FindingRow` — it would require updating all test fixtures and server response handling.
- **No credentials in checkpoint** — `ScanRequest.Credentials` is explicitly excluded. The checkpoint stores only findings (resource counts) and unit IDs. Credentials are never serialized to disk (enforced by session.go comment: "Credentials are never serialized to disk").
- **Atomic write required** — Process may die mid-write. Must write to `.tmp`, then `os.Rename`. `os.WriteFile` alone is not atomic.
- **CGO_ENABLED=0 mandatory** — No cgo-dependent libraries. Pure Go JSON + os package only.
- **Fan-out is concurrent** — Multiple goroutines write checkpoint updates simultaneously. The checkpoint package must be thread-safe internally (sync.Mutex on the in-memory state) and use atomic rename for the disk write.
- **Forward-compatibility** — `Version int` field on the checkpoint struct allows future format changes to be detected. V1 is the initial version. On version mismatch, `Load()` returns an error and the scan starts fresh (graceful degradation, not a fatal error).
- **Resume path threading** — The checkpoint path must flow through the full pipeline: `ScanStartRequest.CheckpointPath` → `ScanProviderSpec.CheckpointPath` → `ScanProviderRequest.CheckpointPath` → `ScanRequest.CheckpointPath`. The orchestrator can optionally auto-generate the path in `os.TempDir()` when `CheckpointPath == ""` and there is more than one subscription (i.e., multi-unit scan). For single-account scans, no checkpoint is written.

## Common Pitfalls

- **Writing to checkpoint inside the mutex-holding section** — Don't. Disk I/O inside `mu.Lock()` blocks all other goroutines from appending their findings. Instead: collect `rows` → release `mu` → write checkpoint → re-acquire `mu` to append findings. Or better: use a separate `cpMu sync.Mutex` in the checkpoint package.
- **Storing the full checkpoint on every write** — Must store ALL previously-completed units, not just the current one. `Save()` receives the full `CheckpointState` (all completed units so far). This means the scanner maintains an in-memory `CheckpointState` that accumulates completed units, then calls `Save()` after each addition.
- **Skipping units without propagating their findings** — On resume, `Load()` returns the `CheckpointState` with all completed units. The scanner must prepend `completedUnit.Findings` to the running `findings` slice AND add the unit ID to a `completed` set used to skip it in the fan-out loop.
- **Checkpoint path for multi-provider scans** — Each provider gets its own checkpoint file. The `ScanRequest.CheckpointPath` is per-provider (it flows through `ScanProviderRequest`, which is per-provider). The orchestrator generates one path per provider when auto-generating.
- **TempDir checkpoint leaks** — Auto-generated checkpoint files in `os.TempDir()` should be cleaned up after a successful (non-resumed) scan completes. Add a `Delete(path)` helper to the checkpoint package. Call it at the end of `scanOrg`/`scanAllSubscriptions`/`scanAllProjects` on success. Interrupted scans should NOT delete the checkpoint.
- **Empty subscriptions list** — Only write checkpoints in multi-unit mode (`len(accounts) > 1`). Single-account scans have nothing to checkpoint.

## Open Risks

- **Resume across version upgrade** — If the tool is upgraded between interruption and resume, the `Version` field mismatch causes a fresh scan. This is safe but the user loses progress. Document this in the checkpoint package comment.
- **TempDir location on Windows** — `os.TempDir()` returns `%TEMP%` on Windows (e.g., `C:\Users\<user>\AppData\Local\Temp`). Cross-platform rename is atomic on Windows (MoveFile is atomic within a volume). Test on both POSIX and Windows if possible.
- **Large checkpoint files** — A 200-account AWS org scan with ~19 FindingRow items per account = ~3800 rows per checkpoint file. At ~150 bytes per row JSON: ~570KB per file. Acceptable. No streaming needed.
- **Checkpoint path passed from frontend** — The frontend currently has no UI for checkpoint path. S05 is backend-only; the path can be passed via direct API calls or auto-generated. S07 could optionally expose it. For now, auto-generation in TempDir covers all cases.
- **Race condition on context cancellation** — If `ctx` is cancelled while a goroutine is mid-checkpoint-write, the atomic rename may not complete. The resulting `.tmp` file would be left on disk. This is harmless (checkpoint file just doesn't exist), but `.tmp` cleanup is a nice-to-have.

## Required File Changes

### New files
- `internal/checkpoint/checkpoint.go` — `CheckpointState`, `CompletedUnit`, `Save(path, state)`, `Load(path)`, `Delete(path)`, `AutoPath(dir, scanID, provider)`, version constant
- `internal/checkpoint/checkpoint_test.go` — round-trip Save/Load, atomic-write verification, version mismatch rejection, concurrent-write safety

### Modified files
- `internal/scanner/provider.go` — add `CheckpointPath string` to `ScanRequest`
- `internal/orchestrator/orchestrator.go` — add `CheckpointPath string` to `ScanProviderRequest`; thread through `buildScanRequest()`; auto-generate path in `os.TempDir()` when empty and multi-unit
- `server/types.go` — add `CheckpointPath string` with `omitempty` to `ScanProviderSpec`
- `server/scan.go` — thread `CheckpointPath` through `toOrchestratorProviders()`
- `internal/scanner/aws/scanner.go` — `scanOrg()`: load checkpoint at start, skip completed accounts, save after each account, delete on success
- `internal/scanner/azure/scanner.go` — `scanAllSubscriptions()`: same pattern as AWS
- `internal/scanner/gcp/scanner.go` — `scanAllProjects()`: same pattern as AWS

## CheckpointState JSON Shape

```json
{
  "version": 1,
  "scan_id": "abc123",
  "provider": "aws",
  "created_at": "2026-03-15T12:00:00Z",
  "completed_units": [
    {
      "id": "111111111111",
      "name": "Management Account",
      "completed_at": "2026-03-15T12:01:30Z",
      "findings": [
        {
          "Provider": "aws",
          "Source": "Management Account",
          "Region": "us-east-1",
          "Category": "DDI Objects",
          "Item": "vpc",
          "Count": 3,
          "TokensPerUnit": 25,
          "ManagementTokens": 1
        }
      ]
    }
  ]
}
```

Note: `FindingRow` fields serialize with Go's default capitalized names (no json tags on the struct).

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| Go stdlib (os, encoding/json) | — | none needed — pure stdlib |

## Sources

- S01 Forward Intelligence: `CallWithBackoff` and `Semaphore` patterns already in use in all three scanners
- S04 Forward Intelligence: "S05 checkpoint/resume will need to integrate with GCP multi-project fan-out (same pattern as AWS/Azure)"
- Roadmap boundary map: S05 produces `internal/checkpoint/checkpoint.go` with `Save/Load/Resume`; orchestrator integration writes checkpoint after each account/subscription/project
- `server/scan.go:185`: `os.CreateTemp("", "nios-onedb-*.xml")` — project convention for TempDir transient files
- `internal/session/session.go`: "Credentials are never serialized to disk" — enforces that checkpoint must not contain credentials
- Baseline test run: all packages pass (13 cloudutil, 29 gcp, 5 aws, azure, orchestrator — no regressions)
