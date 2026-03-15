---
id: S05
parent: M004-2qci81
milestone: M004-2qci81
provides:
  - Thread-safe checkpoint persistence layer (Save/Load/Delete/AutoPath) with atomic writes and version guard
  - CheckpointPath field threaded from API layer through orchestrator to scanner ScanRequest
  - Checkpoint load/save/skip/delete integrated into AWS scanOrg, Azure scanAllSubscriptions, GCP scanAllProjects
  - Resume tests proving completed units are skipped and their findings prepended
requires:
  - slice: S01
    provides: Retry/backoff infrastructure (CallWithBackoff), configurable MaxWorkers/RequestTimeout pipeline threading pattern
affects:
  - S07 (frontend could optionally surface checkpoint path on scan complete screen)
key_files:
  - internal/checkpoint/checkpoint.go
  - internal/checkpoint/checkpoint_test.go
  - internal/scanner/provider.go
  - internal/orchestrator/orchestrator.go
  - server/types.go
  - server/scan.go
  - internal/scanner/aws/scanner.go
  - internal/scanner/azure/scanner.go
  - internal/scanner/gcp/scanner.go
  - internal/scanner/aws/scanner_test.go
  - internal/scanner/azure/scanner_test.go
  - internal/scanner/gcp/scanner_test.go
key_decisions:
  - Atomic write via write-tmp + os.Rename to prevent partial reads
  - Version field (const 1) for forward-compatibility; Load rejects mismatches
  - Load returns (nil, nil) for non-existent file so callers treat as fresh scan
  - Delete is idempotent (ignores os.IsNotExist)
  - Checkpoint activates only when checkpointPath != "" AND len(units) > 1 — avoids overhead for single-unit scans
  - Swappable func vars (discoverAccountsFunc, getAccountIDFunc, scanOneAccountFunc, scanOneProjectFunc) for testable fan-out
  - CheckpointPath placed after RequestTimeout in all structs following S01 field-threading pattern
patterns_established:
  - Checkpoint struct with mutex-protected AddUnit + atomicSave pattern for thread-safe per-unit persistence
  - Checkpoint integration pattern: Load → build completed map + prepend findings → skip in goroutine → AddUnit on success → Delete on full success — identical across all three providers
  - snake_case JSON tags on all checkpoint structs for human-readable checkpoint files
  - Swappable package-level func vars for testable fan-out functions (matches Azure's existing scanSubscriptionFunc)
observability_surfaces:
  - checkpoint_loaded event (Provider, Message="resuming from checkpoint: N units already complete")
  - checkpoint_saved event after each successful unit (Provider, Message=file path)
  - checkpoint_error event (non-fatal) if Load or Save fails (Provider, Message includes error details)
  - Skipped units publish progress event with Status="skipped"
  - Checkpoint JSON file at AutoPath location is human-readable and greppable
drill_down_paths:
  - .gsd/milestones/M004-2qci81/slices/S05/tasks/T01-SUMMARY.md
  - .gsd/milestones/M004-2qci81/slices/S05/tasks/T02-SUMMARY.md
  - .gsd/milestones/M004-2qci81/slices/S05/tasks/T03-SUMMARY.md
duration: 43m
verification_result: passed
completed_at: 2026-03-15
---

# S05: Checkpoint/Resume for Long Scans

**Thread-safe checkpoint persistence with atomic writes, version guard, and resume integration across all three cloud scanner fan-out loops — interrupted multi-account scans resume from checkpoint without re-scanning completed units.**

## What Happened

Built checkpoint/resume capability for long-running multi-account/subscription/project scans in three tasks:

**T01 (12m):** Created `internal/checkpoint/` package with `CheckpointState`/`CompletedUnit` types, a mutex-guarded `Checkpoint` struct with `AddUnit()` → `atomicSave()` (write `.tmp` + `os.Rename`), `Load()` with version mismatch rejection and nil-for-missing-file semantics, idempotent `Delete()`, and deterministic `AutoPath()`. Six tests including concurrent race detection all pass.

**T02 (6m):** Threaded `CheckpointPath string` through the four-layer scan pipeline: `ScanProviderSpec` → `ScanProviderRequest` → `buildScanRequest()` → `ScanRequest`. Follows the exact same pattern established by S01 for MaxWorkers/RequestTimeout. Zero-value empty string means no checkpointing (backward compatible).

**T03 (25m):** Integrated the checkpoint package into all three fan-out functions (`scanOrg`, `scanAllSubscriptions`, `scanAllProjects`). Each follows an identical pattern: Load checkpoint → build completed set + prepend saved findings → skip completed units in goroutine (publish "skipped" event) → AddUnit on success (publish `checkpoint_saved`) → Delete on full success. Added swappable func vars for testable fan-out in AWS and GCP (Azure already had `scanSubscriptionFunc`). Three new resume tests prove skip + prepend behavior.

## Verification

| Check | Status | Details |
|---|---|---|
| `go test ./internal/checkpoint/... -v -race -count=1` | ✅ PASS | 6 tests, no data races |
| `go test ./internal/scanner/aws/... -v -race -count=1` | ✅ PASS | 18 tests (17 existing + 1 new resume test), no regressions |
| `go test ./internal/scanner/azure/... -v -race -count=1` | ✅ PASS | 5 tests (4 existing + 1 new resume test), no regressions |
| `go test ./internal/scanner/gcp/... -v -race -count=1` | ✅ PASS | 37 tests (36 existing + 1 new resume test), no regressions |
| `go test ./internal/orchestrator/... ./server/... -v -count=1` | ✅ PASS | 62 tests, no regressions |
| `go test ./... -count=1` | ✅ PASS | All packages pass (root embed error is pre-existing) |
| `go vet ./internal/... ./server/...` | ✅ clean | No issues |

## Requirements Advanced

- None — this slice is infrastructure-only (no new user-facing capability); it enables the milestone success criterion "interrupted scan resumes from checkpoint"

## Requirements Validated

- None — checkpoint/resume is proven at contract+integration level via unit tests; full operational validation requires a real interrupted 50+ account scan (deferred to milestone-level DoD)

## New Requirements Surfaced

- None

## Requirements Invalidated or Re-scoped

- None

## Deviations

- Added swappable func vars (`discoverAccountsFunc`, `getAccountIDFunc`, `scanOneAccountFunc`) to AWS scanner and `scanOneProjectFunc` to GCP scanner for checkpoint resume testing. This was necessary because the fan-out functions call multiple internal APIs that require real cloud credentials. Matches Azure's pre-existing `scanSubscriptionFunc` pattern.

## Known Limitations

- Checkpoint path must be provided by the caller (or auto-generated via `AutoPath`). S07 frontend does not yet surface the checkpoint path — today it's auto-generated and logged.
- Checkpoint file format is version 1 only. Version upgrades require explicit migration logic in `Load()`.
- Single-account/subscription/project scans skip checkpoint overhead entirely (by design).
- Checkpoint does not persist partial results within a single unit — if account scanning fails mid-way through regions, that entire account is re-scanned on resume.

## Follow-ups

- S07 frontend could optionally surface the auto-generated checkpoint path on the scan progress/complete screen for user visibility.

## Files Created/Modified

- `internal/checkpoint/checkpoint.go` — new package: CheckpointState, CompletedUnit, Checkpoint struct, New, AddUnit, atomicSave, Load, Delete, AutoPath
- `internal/checkpoint/checkpoint_test.go` — 6 tests: round-trip, missing file, version mismatch, concurrency, delete, auto-path
- `internal/scanner/provider.go` — added CheckpointPath field to ScanRequest
- `internal/orchestrator/orchestrator.go` — added CheckpointPath field to ScanProviderRequest + buildScanRequest() wiring
- `server/types.go` — added CheckpointPath field to ScanProviderSpec with JSON tag
- `server/scan.go` — threaded CheckpointPath in toOrchestratorProviders()
- `internal/scanner/aws/scanner.go` — checkpoint import, checkpointPath param to scanOrg, swappable func vars, load/skip/save/delete logic
- `internal/scanner/azure/scanner.go` — checkpoint import, checkpointPath param to scanAllSubscriptions, load/skip/save/delete logic
- `internal/scanner/gcp/scanner.go` — checkpoint import, checkpointPath param to scanAllProjects, scanOneProjectFunc var, load/skip/save/delete logic
- `internal/scanner/aws/scanner_test.go` — TestScanOrg_CheckpointResume
- `internal/scanner/azure/scanner_test.go` — TestScanAllSubscriptions_CheckpointResume, updated existing FanOut test
- `internal/scanner/gcp/scanner_test.go` — TestScanAllProjects_CheckpointResume

## Forward Intelligence

### What the next slice should know
- CheckpointPath is threaded but currently always empty string from API callers. To activate, set it on ScanProviderSpec or call checkpoint.AutoPath() in the scan handler.
- The checkpoint integration pattern is identical across all three providers — any future provider fan-out can copy-paste the Load → skip → AddUnit → Delete pattern.

### What's fragile
- Swappable func vars (discoverAccountsFunc, scanOneAccountFunc, scanOneProjectFunc) are package-level state — tests that override them must restore originals via t.Cleanup or defer. Parallel test runs within the same package could conflict if not careful.
- atomicSave relies on os.Rename atomicity — works on same-filesystem only. TempDir + Rename is safe because .tmp file is written in the same directory as the target.

### Authoritative diagnostics
- `checkpoint_saved` / `checkpoint_loaded` / `checkpoint_error` events in the SSE stream — these are the first place to look when debugging checkpoint behavior
- Checkpoint JSON at `AutoPath()` location — human-readable, greppable for completed unit IDs

### What assumptions changed
- No assumptions changed — the slice delivered exactly as planned with the expected three-task structure.
