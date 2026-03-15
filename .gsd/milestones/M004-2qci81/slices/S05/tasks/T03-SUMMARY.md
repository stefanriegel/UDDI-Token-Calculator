---
id: T03
parent: S05
milestone: M004-2qci81
provides:
  - Checkpoint load/save/skip/delete integrated into AWS scanOrg, Azure scanAllSubscriptions, GCP scanAllProjects
  - Resume tests proving completed units are skipped and their findings prepended
key_files:
  - internal/scanner/aws/scanner.go
  - internal/scanner/azure/scanner.go
  - internal/scanner/gcp/scanner.go
  - internal/scanner/aws/scanner_test.go
  - internal/scanner/azure/scanner_test.go
  - internal/scanner/gcp/scanner_test.go
key_decisions:
  - Added swappable func vars (discoverAccountsFunc, getAccountIDFunc, scanOneAccountFunc for AWS; scanOneProjectFunc for GCP) to enable fan-out testing without real cloud API calls
  - Checkpoint only activates when checkpointPath != "" AND len(units) > 1; single-unit scans skip checkpoint overhead
  - checkpoint.Delete on full success cleans up the checkpoint file so it doesn't persist after complete scans
  - checkpoint_saved event publishes the file path as Message for observability
patterns_established:
  - Checkpoint integration pattern: Load → build completed map + prepend findings → skip in goroutine → AddUnit on success → Delete on full success; identical across all three providers
  - Swappable package-level func vars for testable fan-out functions (matches Azure's existing scanSubscriptionFunc pattern)
observability_surfaces:
  - checkpoint_loaded event (Provider, Message="resuming from checkpoint: N units already complete")
  - checkpoint_saved event after each successful unit (Provider, Message=file path)
  - checkpoint_error event (non-fatal) if Load or Save fails (Provider, Message includes error details)
  - Skipped units publish progress event with Status="skipped"
duration: 25m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T03: Integrate checkpoint into AWS scanOrg, Azure scanAllSubscriptions, GCP scanAllProjects

**Checkpoint load/save/skip/delete integrated into all three scanner fan-out loops with resume tests proving skipped units and prepended findings.**

## What Happened

Integrated the T01 checkpoint package into the three fan-out functions:

1. **AWS `scanOrg`** — Added `checkpointPath` parameter. On entry: Load checkpoint, build completed map, prepend saved findings. In goroutine: skip completed accounts (publish "skipped" event). On success: AddUnit with findings. After wg.Wait: Delete checkpoint file. Added swappable func vars (`discoverAccountsFunc`, `getAccountIDFunc`, `scanOneAccountFunc`) to enable testing without real AWS APIs.

2. **Azure `scanAllSubscriptions`** — Added `checkpointPath` parameter with identical checkpoint pattern. Updated existing `TestScanAllSubscriptions_FanOut` call site to pass empty checkpoint path (backward compatible). Leveraged existing `scanSubscriptionFunc` var for testing.

3. **GCP `scanAllProjects`** — Added `checkpointPath` parameter with identical checkpoint pattern. Added `scanOneProjectFunc` swappable var for testing.

All three follow the same pattern: checkpoint activates only when path is non-empty AND multiple units exist.

## Verification

- `go test ./internal/scanner/aws/... -v -race -count=1` — **18/18 PASS** (17 existing + 1 new TestScanOrg_CheckpointResume), no data races
- `go test ./internal/scanner/azure/... -v -race -count=1` — **5/5 PASS** (4 existing + 1 new TestScanAllSubscriptions_CheckpointResume), no data races
- `go test ./internal/scanner/gcp/... -v -race -count=1` — **37/37 PASS** (36 existing + 1 new TestScanAllProjects_CheckpointResume), no data races
- `go test ./internal/checkpoint/... -v -count=1` — 6/6 PASS (no regressions)
- `go test ./internal/orchestrator/... ./server/... -v -count=1` — 62/62 PASS (no regressions)
- `go test ./... -count=1` — all packages pass (root embed error is pre-existing)
- `go vet ./internal/... ./server/...` — clean

### Slice Verification Status (T03 — final task)

| Check | Status |
|---|---|
| `go test ./internal/checkpoint/... -v -count=1` | ✅ PASS (6 tests) |
| `go test ./internal/scanner/aws/... -v -count=1` | ✅ PASS (18 tests) |
| `go test ./internal/scanner/azure/... -v -count=1` | ✅ PASS (5 tests) |
| `go test ./internal/scanner/gcp/... -v -count=1` | ✅ PASS (37 tests) |
| `go test ./internal/orchestrator/... ./server/... -v -count=1` | ✅ PASS (62 tests) |
| `go test ./... -count=1` | ✅ PASS (root embed pre-existing) |
| `go vet ./internal/... ./server/...` | ✅ clean |

## Diagnostics

- Checkpoint events visible in SSE stream: `checkpoint_loaded` (resume), `checkpoint_saved` (per-unit), `checkpoint_error` (non-fatal failures)
- Skipped units emit progress events with Status="skipped" for visibility in scan progress UI
- Checkpoint file at AutoPath location is plain JSON, human-readable, greppable
- Save errors include path + underlying OS error in event Message for triage

## Deviations

- Added swappable func vars (`discoverAccountsFunc`, `getAccountIDFunc`, `scanOneAccountFunc`) to AWS scanner to enable checkpoint resume testing. This matches Azure's existing `scanSubscriptionFunc` pattern and was necessary because scanOrg calls multiple internal functions that require real AWS APIs.
- Added `scanOneProjectFunc` swappable var to GCP scanner for the same reason.
- Both AWS `scanOrg` and GCP `scanAllProjects` now use these func vars in their fan-out loops.

## Known Issues

None.

## Files Created/Modified

- `internal/scanner/aws/scanner.go` — Added checkpoint import, `checkpointPath` param to scanOrg, swappable func vars, checkpoint load/skip/save/delete logic
- `internal/scanner/azure/scanner.go` — Added checkpoint import, `checkpointPath` param to scanAllSubscriptions, checkpoint load/skip/save/delete logic
- `internal/scanner/gcp/scanner.go` — Added checkpoint import, `checkpointPath` param to scanAllProjects, `scanOneProjectFunc` var, checkpoint load/skip/save/delete logic
- `internal/scanner/aws/scanner_test.go` — Added TestScanOrg_CheckpointResume; updated imports
- `internal/scanner/azure/scanner_test.go` — Added TestScanAllSubscriptions_CheckpointResume; updated existing FanOut test call site for new signature; updated imports
- `internal/scanner/gcp/scanner_test.go` — Added TestScanAllProjects_CheckpointResume; updated imports
