# S05: Checkpoint/Resume for Long Scans

**Goal:** An interrupted multi-account/subscription/project scan can resume from a persisted checkpoint file without re-scanning already-completed units. The checkpoint is written atomically after each unit completes and loaded automatically when a `CheckpointPath` is provided on the resumed scan start.

**Demo:** Unit tests prove: (a) checkpoint round-trip Save/Load is correct, (b) a resumed scan skips completed accounts and prepends their saved findings, (c) all three scanner fan-out loops (AWS/Azure/GCP) write and load checkpoints correctly.

## Must-Haves

- `internal/checkpoint/checkpoint.go` with `CheckpointState`, `CompletedUnit`, `Save`, `Load`, `Delete`, `AutoPath` — thread-safe, atomic-write
- `CheckpointPath string` threaded from `ScanProviderSpec` → `ScanProviderRequest` → `ScanRequest`
- AWS `scanOrg`, Azure `scanAllSubscriptions`, GCP `scanAllProjects` each load checkpoint at start, skip completed units, save after each completion
- Unit tests covering round-trip serialization, version mismatch, concurrent saves, and resume-skip logic per scanner
- All existing tests still pass (no regressions)

## Proof Level

- This slice proves: contract + integration (unit-test level with mock fan-out)
- Real runtime required: no
- Human/UAT required: no

## Verification

- `go test ./internal/checkpoint/... -v -count=1` — all checkpoint package tests pass
- `go test ./internal/scanner/aws/... -v -count=1` — AWS checkpoint tests pass; existing 5 tests still pass
- `go test ./internal/scanner/azure/... -v -count=1` — Azure checkpoint tests pass; no regressions
- `go test ./internal/scanner/gcp/... -v -count=1` — GCP checkpoint tests pass; existing 29 tests still pass
- `go test ./internal/orchestrator/... ./server/... -v -count=1` — no regressions from pipeline threading
- `go test ./... -count=1` — all packages pass (root embed error is pre-existing, ignored)
- `go vet ./internal/... ./server/...` — clean

## Observability / Diagnostics

- Runtime signals: `checkpoint_saved` event published after each atomic write (Type="checkpoint_saved", Provider, Message=path); `checkpoint_loaded` event on successful resume; `checkpoint_error` event (non-fatal) if Save fails
- Inspection surfaces: checkpoint JSON file at `os.TempDir()/checkpoint-{provider}-{scanId}.json`; human-readable, greppable
- Failure visibility: save errors include path and underlying OS error in event Message; load errors cause fresh scan start with `checkpoint_error` event
- Redaction constraints: checkpoint file MUST NOT contain credentials — only unit IDs, names, and `[]FindingRow` (resource counts only)

## Integration Closure

- Upstream surfaces consumed: `internal/scanner/provider.go` ScanRequest, `internal/orchestrator/orchestrator.go` ScanProviderRequest + buildScanRequest(), `server/types.go` ScanProviderSpec, `server/scan.go` toOrchestratorProviders()
- New wiring introduced in this slice: `CheckpointPath` field on all three request structs; checkpoint load/save calls in three scanner fan-out functions; `checkpoint_saved`/`checkpoint_loaded`/`checkpoint_error` scanner events
- What remains before the milestone is truly usable end-to-end: S07 frontend could optionally surface the checkpoint path on the scan complete screen; today the path is auto-generated and logged

## Tasks

- [x] **T01: Build checkpoint package with Save/Load/Delete/AutoPath** `est:35m`
  - Why: Provides the persistence layer all three scanners will use. Must be thread-safe and atomic before any scanner integration.
  - Files: `internal/checkpoint/checkpoint.go`, `internal/checkpoint/checkpoint_test.go`
  - Do:
    - Create `internal/checkpoint/checkpoint.go` with package `checkpoint`:
      - `const Version = 1` — forward-compatibility guard
      - `type CompletedUnit struct { ID, Name string; CompletedAt time.Time; Findings []calculator.FindingRow }` — all json-tagged with snake_case keys
      - `type CheckpointState struct { Version int \`json:"version"\`; ScanID, Provider string; CreatedAt time.Time; CompletedUnits []CompletedUnit }` — json-tagged
      - `type Checkpoint struct { path string; mu sync.Mutex; state CheckpointState }` — in-memory accumulator
      - `func New(path, scanID, provider string) *Checkpoint` — initializes state with Version=1, CreatedAt=now, empty CompletedUnits
      - `func (c *Checkpoint) AddUnit(unit CompletedUnit) error` — mu-protected: appends to state.CompletedUnits, then calls atomicSave(c.path, c.state)
      - `func atomicSave(path string, state CheckpointState) error` — marshal to JSON, write to `path+".tmp"`, os.Rename to `path`
      - `func Load(path string) (*CheckpointState, error)` — reads + unmarshals; returns error if Version != 1 (with message "checkpoint version N not supported"); returns nil,nil if file does not exist (os.IsNotExist)
      - `func Delete(path string) error` — os.Remove; non-fatal (caller logs but continues)
      - `func AutoPath(scanID, provider string) string` — returns `filepath.Join(os.TempDir(), fmt.Sprintf("checkpoint-%s-%s.json", provider, scanID))`
      - Import only: `encoding/json`, `fmt`, `os`, `path/filepath`, `sync`, `time`, `github.com/infoblox/uddi-go-token-calculator/internal/calculator`
    - Create `internal/checkpoint/checkpoint_test.go`:
      - `TestCheckpoint_RoundTrip` — New + AddUnit + Load; verify CompletedUnits count, ID, Findings content
      - `TestLoad_FileNotExist` — Load on non-existent path returns nil,nil
      - `TestLoad_VersionMismatch` — write JSON with version=99; Load returns error containing "not supported"
      - `TestCheckpoint_ConcurrentAddUnit` — 10 goroutines each AddUnit; after all complete, Load and assert 10 units (no duplicates, no data races; run with `-race`)
      - `TestDelete` — New + AddUnit + Delete; verify file gone, second Delete returns nil (idempotent)
      - `TestAutoPath` — verify AutoPath returns a path containing os.TempDir(), provider, and scanID
  - Verify: `go test ./internal/checkpoint/... -v -race -count=1`
  - Done when: all 6 tests pass with `-race` flag; no data races detected

- [x] **T02: Thread CheckpointPath through the scan pipeline** `est:20m`
  - Why: Without this threading, scanners cannot receive the checkpoint path from the API caller. Follows the exact same pattern as MaxWorkers/RequestTimeout from S01.
  - Files: `internal/scanner/provider.go`, `internal/orchestrator/orchestrator.go`, `server/types.go`, `server/scan.go`
  - Do:
    - `internal/scanner/provider.go`: add `CheckpointPath string` to `ScanRequest` after `RequestTimeout`, with comment: "// CheckpointPath is the file path for checkpoint persistence. Empty means no checkpointing."
    - `internal/orchestrator/orchestrator.go` `ScanProviderRequest`: add `CheckpointPath string` after `RequestTimeout` with same comment
    - `internal/orchestrator/orchestrator.go` `buildScanRequest()`: add `CheckpointPath: p.CheckpointPath` in the `req := scanner.ScanRequest{...}` initializer
    - `server/types.go` `ScanProviderSpec`: add `CheckpointPath string \`json:"checkpointPath,omitempty"\`` after `RequestTimeout`; add comment matching orchestrator field
    - `server/scan.go` `toOrchestratorProviders()`: add `CheckpointPath: s.CheckpointPath` in the `req := orchestrator.ScanProviderRequest{...}` initializer
    - No frontend changes needed — S05 is backend-only; frontend sends empty string → zero-value → no checkpoint (backward compatible)
  - Verify: `go build ./...` (no compile errors); `go test ./internal/orchestrator/... ./server/... -v -count=1` (all existing tests pass)
  - Done when: `go build ./...` clean; orchestrator and server tests still pass

- [x] **T03: Integrate checkpoint into AWS scanOrg, Azure scanAllSubscriptions, GCP scanAllProjects** `est:45m`
  - Why: This is where checkpoint read/write actually happens — the three fan-out loops are the only places that know per-unit IDs. Must skip completed units on resume and save after each completion.
  - Files: `internal/scanner/aws/scanner.go`, `internal/scanner/azure/scanner.go`, `internal/scanner/gcp/scanner.go`, `internal/scanner/aws/scanner_test.go`, `internal/scanner/azure/scanner_test.go`, `internal/scanner/gcp/scanner_test.go`
  - Do:
    **AWS `scanOrg` signature change** — add `checkpointPath string` parameter; update the single call site in `Scan()`:
    ```
    return s.scanOrg(ctx, baseCfg, creds, req.MaxWorkers, req.CheckpointPath, publish)
    ```
    **AWS `scanOrg` checkpoint integration**:
    1. At top of function, after discovering accounts: call `checkpoint.Load(checkpointPath)` → get `*CheckpointState`
    2. Build `completed map[string]bool` and `var findings []calculator.FindingRow` from loaded state (prepend completed unit findings)
    3. Publish `checkpoint_loaded` event if state != nil (Message: "resuming from checkpoint: N accounts already complete")
    4. In the goroutine, before `scanOneAccount`: if `completed[acct.ID]` → publish skipped event + return (don't scan)
    5. After `rows, scanErr := scanOneAccount(...)` on success path: call `cp.AddUnit(checkpoint.CompletedUnit{ID: acct.ID, Name: accountName, CompletedAt: time.Now(), Findings: rows})` (non-fatal: log error to publish event, continue)
    6. After `wg.Wait()`: if no error and checkpointPath != "" → `checkpoint.Delete(checkpointPath)` (non-fatal)
    - Note: `cp` is a `*checkpoint.Checkpoint` initialized with `checkpoint.New(checkpointPath, "", scanner.ProviderAWS)` only when `checkpointPath != ""` and `len(accounts) > 1`; otherwise `cp` is nil and all checkpoint calls are guarded by `if cp != nil`

    **Azure `scanAllSubscriptions` signature change** — add `checkpointPath string` parameter; update call site in `Scan()`:
    ```
    return scanAllSubscriptions(ctx, cred, subscriptions, req.MaxWorkers, req.CheckpointPath, publish)
    ```
    Apply identical checkpoint pattern: Load → build completed set + prepend findings → skip in goroutine → AddUnit on success → Delete on full success.

    **GCP `scanAllProjects` signature change** — add `checkpointPath string` parameter; update call site in `Scan()`:
    ```
    return scanAllProjects(ctx, ts, req.Subscriptions, req.MaxWorkers, req.CheckpointPath, publish)
    ```
    Apply identical checkpoint pattern with `projID` as the unit ID.

    **Tests** — add to existing test files (do not create new test files; append to scanner_test.go in each package):
    - `TestScanOrg_CheckpointResume` (aws): create a mock that tracks which accountIDs were scanned; pre-populate a checkpoint with account A completed; verify account A is skipped and its findings appear in results without scanning
    - `TestScanAllSubscriptions_CheckpointResume` (azure): same pattern with subscription IDs
    - `TestScanAllProjects_CheckpointResume` (gcp): same pattern with project IDs
    - Each test: use `t.TempDir()` for checkpoint path; verify skip via mock call count; verify pre-loaded findings appear in return value

  - Verify: `go test ./internal/scanner/aws/... ./internal/scanner/azure/... ./internal/scanner/gcp/... -v -race -count=1`
  - Done when: new resume tests pass; all existing scanner tests still pass; no data races

## Files Likely Touched

- `internal/checkpoint/checkpoint.go` (new)
- `internal/checkpoint/checkpoint_test.go` (new)
- `internal/scanner/provider.go`
- `internal/orchestrator/orchestrator.go`
- `server/types.go`
- `server/scan.go`
- `internal/scanner/aws/scanner.go`
- `internal/scanner/azure/scanner.go`
- `internal/scanner/gcp/scanner.go`
- `internal/scanner/aws/scanner_test.go`
- `internal/scanner/azure/scanner_test.go`
- `internal/scanner/gcp/scanner_test.go`
