---
id: T02
parent: S05
milestone: M004-2qci81
provides:
  - CheckpointPath field threaded from API layer through orchestrator to scanner ScanRequest
key_files:
  - internal/scanner/provider.go
  - internal/orchestrator/orchestrator.go
  - server/types.go
  - server/scan.go
key_decisions:
  - Placed CheckpointPath after RequestTimeout in all four structs for consistent field ordering
  - Used json tag `checkpointPath,omitempty` on ScanProviderSpec so empty string is omitted from API JSON
patterns_established:
  - Same field-threading pattern as MaxWorkers/RequestTimeout from S01: ScanProviderSpec → ScanProviderRequest → buildScanRequest → ScanRequest
observability_surfaces:
  - none (pure data-threading task; observability comes in T03 when scanners use the field)
duration: 6m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T02: Thread CheckpointPath through the scan pipeline

**Added `CheckpointPath string` field to ScanRequest, ScanProviderRequest, and ScanProviderSpec, wired through buildScanRequest() and toOrchestratorProviders().**

## What Happened

Added the `CheckpointPath` field to all four structs in the scan pipeline so that T03's scanner integration can receive the checkpoint path from the API caller:

1. `internal/scanner/provider.go` → `ScanRequest.CheckpointPath` with comment
2. `internal/orchestrator/orchestrator.go` → `ScanProviderRequest.CheckpointPath` with comment + `buildScanRequest()` initializer line
3. `server/types.go` → `ScanProviderSpec.CheckpointPath` with `json:"checkpointPath,omitempty"` tag
4. `server/scan.go` → `toOrchestratorProviders()` initializer line

No frontend changes — empty string zero-value means no checkpointing (backward compatible).

## Verification

- `go build ./internal/... ./server/...` — clean (no compile errors)
- `go test ./internal/orchestrator/... -v -count=1` — 6/6 PASS
- `go test ./server/... -v -count=1` — 56/56 PASS
- `go vet ./internal/... ./server/...` — clean
- `go test ./internal/checkpoint/... -v -count=1` — 6/6 PASS (no regressions)
- `go test ./internal/scanner/aws/... -v -count=1` — 17/17 PASS (no regressions)
- `go test ./internal/scanner/azure/... -v -count=1` — all PASS (no regressions)
- `go test ./internal/scanner/gcp/... -v -count=1` — 36/36 PASS (no regressions)

### Slice Verification Status (T02 — intermediate)

| Check | Status |
|---|---|
| `go test ./internal/checkpoint/... -v -count=1` | ✅ PASS |
| `go test ./internal/scanner/aws/... -v -count=1` | ✅ PASS (17 tests) |
| `go test ./internal/scanner/azure/... -v -count=1` | ✅ PASS |
| `go test ./internal/scanner/gcp/... -v -count=1` | ✅ PASS (36 tests) |
| `go test ./internal/orchestrator/... ./server/... -v -count=1` | ✅ PASS (62 tests) |
| `go vet ./internal/... ./server/...` | ✅ clean |
| Scanner checkpoint resume tests | ⏳ T03 |
| Full `go test ./...` | ⏳ T03 |

## Diagnostics

None — this is a pure data-threading task with no runtime behavior. Diagnostics surface in T03 when scanners read CheckpointPath.

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `internal/scanner/provider.go` — added `CheckpointPath string` field to `ScanRequest`
- `internal/orchestrator/orchestrator.go` — added `CheckpointPath string` field to `ScanProviderRequest`; threaded in `buildScanRequest()`
- `server/types.go` — added `CheckpointPath string` field to `ScanProviderSpec` with JSON tag
- `server/scan.go` — threaded `CheckpointPath` in `toOrchestratorProviders()`
