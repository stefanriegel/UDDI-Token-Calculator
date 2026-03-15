# S05: Checkpoint/Resume for Long Scans — UAT

**Milestone:** M004-2qci81
**Written:** 2026-03-15

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: Checkpoint/resume is a backend-only infrastructure feature with no UI surfaces. All behavior is testable through unit tests exercising the checkpoint package, pipeline threading, and scanner fan-out resume logic. Real runtime interruption testing requires actual multi-account cloud scans which are covered by milestone-level operational verification.

## Preconditions

- Go 1.24+ installed with `go test` available
- Repository checked out with all S05 files present
- No frontend build required (backend-only slice)

## Smoke Test

Run `go test ./internal/checkpoint/... -v -race -count=1` — all 6 tests pass with no data races detected. This confirms the core persistence layer works.

## Test Cases

### 1. Checkpoint Round-Trip Persistence

1. Create a new Checkpoint with `checkpoint.New(tempPath, "scan-123", "aws")`
2. Call `AddUnit` with a CompletedUnit containing ID="acct-1", Name="Account One", and two FindingRow items
3. Call `checkpoint.Load(tempPath)` to read back the persisted state
4. **Expected:** Loaded state has Version=1, Provider="aws", CompletedUnits length=1, unit ID="acct-1", Findings length=2 with matching Item/Count values

### 2. Missing Checkpoint File Treated as Fresh Start

1. Call `checkpoint.Load("/nonexistent/path/checkpoint.json")`
2. **Expected:** Returns `(nil, nil)` — no error, no state. Callers proceed with a fresh scan.

### 3. Version Mismatch Rejection

1. Write a JSON file with `{"version": 99, "scan_id": "test", "provider": "aws"}` to a temp path
2. Call `checkpoint.Load(path)`
3. **Expected:** Returns non-nil error containing the string "not supported". State is nil.

### 4. Concurrent AddUnit Safety

1. Create a Checkpoint
2. Launch 10 goroutines, each calling `AddUnit` with a unique unit ID
3. Wait for all goroutines to complete
4. Call `Load` and inspect CompletedUnits
5. **Expected:** Exactly 10 units present, all with unique IDs. No duplicates, no data corruption. Test passes under `-race` flag.

### 5. Idempotent Delete

1. Create a Checkpoint and AddUnit to persist the file
2. Call `checkpoint.Delete(path)` — file removed
3. Call `checkpoint.Delete(path)` again on the now-missing file
4. **Expected:** First Delete succeeds (file gone). Second Delete returns nil (no error on missing file).

### 6. AutoPath Determinism

1. Call `checkpoint.AutoPath("scan-abc", "azure")`
2. **Expected:** Returned path contains `os.TempDir()`, contains "azure", contains "scan-abc", ends with ".json"

### 7. CheckpointPath Pipeline Threading

1. Construct a `ScanProviderSpec` with `CheckpointPath: "/tmp/test-checkpoint.json"`
2. Call `toOrchestratorProviders()` to convert to `ScanProviderRequest`
3. Verify `ScanProviderRequest.CheckpointPath` equals `/tmp/test-checkpoint.json`
4. Call `buildScanRequest()` on the orchestrator request
5. **Expected:** Resulting `ScanRequest.CheckpointPath` equals `/tmp/test-checkpoint.json`

### 8. AWS scanOrg Checkpoint Resume

1. Pre-populate a checkpoint file with one completed account (ID="111111111111") containing 2 FindingRow items
2. Set up mock `discoverAccountsFunc` returning 3 accounts (including the completed one)
3. Set up mock `scanOneAccountFunc` that tracks which account IDs are scanned and returns 1 FindingRow per account
4. Call `scanOrg` with the checkpoint path
5. **Expected:** Mock records only 2 scanned accounts (the completed one is skipped). Result contains 4 FindingRows total: 2 from checkpoint + 2 from live scans. Events include `checkpoint_loaded` with message about 1 account already complete.

### 9. Azure scanAllSubscriptions Checkpoint Resume

1. Pre-populate a checkpoint file with subscription "sub-A-id" completed with 3 FindingRow items
2. Set up mock `scanSubscriptionFunc` tracking scanned subscription IDs
3. Call `scanAllSubscriptions` with 3 subscriptions including sub-A-id
4. **Expected:** sub-A-id is not scanned. Result includes the 3 checkpoint findings plus findings from the 2 live scans. `checkpoint_loaded` event published.

### 10. GCP scanAllProjects Checkpoint Resume

1. Pre-populate a checkpoint file with project "proj-1" completed with 1 FindingRow item
2. Set up mock `scanOneProjectFunc` tracking scanned project IDs
3. Call `scanAllProjects` with 2 projects including proj-1
4. **Expected:** proj-1 is not scanned. Result includes the 1 checkpoint finding plus findings from the 1 live scan. `checkpoint_loaded` event published.

## Edge Cases

### Checkpoint Disabled (Empty Path)

1. Call `scanOrg` / `scanAllSubscriptions` / `scanAllProjects` with `checkpointPath = ""`
2. **Expected:** No checkpoint operations occur. No checkpoint_loaded/saved/error events. Scan runs normally. No files created in TempDir.

### Single-Unit Scan Skips Checkpoint

1. Call `scanOrg` with checkpointPath set but only 1 account discovered
2. **Expected:** Checkpoint is not activated (cp remains nil). No checkpoint events published. Scan completes normally.

### Checkpoint Load Error (Corrupt File)

1. Write non-JSON garbage to a file at the checkpoint path
2. Call a scanner fan-out function with that checkpoint path
3. **Expected:** `checkpoint_error` event published with message containing "failed to load checkpoint, starting fresh". Scan proceeds from scratch (no skip).

### Checkpoint Save Error (Read-Only Directory)

1. Set checkpointPath to a path in a read-only directory
2. Run a multi-account scan
3. **Expected:** `checkpoint_error` event published with message containing "failed to save checkpoint". Scan continues normally — save failure is non-fatal.

### Checkpoint Delete After Full Success

1. Pre-populate a checkpoint, then run a scan that successfully completes all units
2. **Expected:** After `wg.Wait()`, the checkpoint file is deleted. The file no longer exists at the checkpoint path.

## Failure Signals

- Any test in `go test ./internal/checkpoint/... -v -race -count=1` fails or reports data races
- Any existing scanner test regresses (test count drops below: AWS 17, Azure 4, GCP 36)
- New resume tests fail or are skipped
- `go vet ./internal/... ./server/...` reports issues
- Checkpoint events (`checkpoint_loaded`, `checkpoint_saved`, `checkpoint_error`) not present in scanner event publishing code
- `go build ./...` fails (pipeline threading type errors)

## Requirements Proved By This UAT

- Checkpoint durability at contract level: Save/Load round-trip, version guard, atomic write, concurrent safety
- Scan resume correctness: completed units are skipped, their findings are prepended, live units are scanned normally
- No regressions: all pre-existing scanner, orchestrator, and server tests continue to pass

## Not Proven By This UAT

- Real interrupted 50+ account AWS org scan resuming from checkpoint (operational verification — requires real cloud APIs)
- Real Azure/GCP multi-subscription/project interrupted scan resume (same)
- Frontend checkpoint path display (deferred to S07)
- Checkpoint file forward-compatibility across tool version upgrades (requires future version bump test)
- Checkpoint behavior under disk-full or filesystem error conditions beyond simple read-only

## Notes for Tester

- The root `go test ./...` will show a FAIL for the root package due to pre-existing `embed.go` missing `frontend/dist` — this is expected and unrelated to S05.
- All scanner resume tests use swappable func vars that must be restored after tests. Check that `t.Cleanup` or `defer` blocks are present in each resume test.
- The checkpoint JSON file is human-readable. After running a test, you can `cat` the checkpoint file to inspect its structure for manual verification.
- Run all tests with `-race` flag to catch concurrency issues in the checkpoint package.
