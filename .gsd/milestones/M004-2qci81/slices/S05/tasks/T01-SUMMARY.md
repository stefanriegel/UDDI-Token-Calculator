---
id: T01
parent: S05
milestone: M004-2qci81
provides:
  - checkpoint persistence layer (Save/Load/Delete/AutoPath) for scan resume
key_files:
  - internal/checkpoint/checkpoint.go
  - internal/checkpoint/checkpoint_test.go
key_decisions:
  - Atomic write via write-tmp + os.Rename to prevent partial reads
  - Version field (const 1) for forward-compatibility; Load rejects mismatches
  - Load returns (nil, nil) for non-existent file so callers treat as fresh scan
  - Delete is idempotent (ignores os.IsNotExist)
patterns_established:
  - Checkpoint struct with mutex-protected AddUnit + atomicSave pattern for thread-safe per-unit persistence
  - snake_case JSON tags on all checkpoint structs for human-readable checkpoint files
observability_surfaces:
  - Checkpoint JSON file at AutoPath location is human-readable and greppable
duration: 12m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T01: Build checkpoint package with Save/Load/Delete/AutoPath

**Thread-safe checkpoint persistence layer with atomic writes, version guard, and 6 passing tests including concurrent race detection.**

## What Happened

Created `internal/checkpoint/` package with:
- `CheckpointState` / `CompletedUnit` types with snake_case JSON tags
- `Checkpoint` struct: mutex-guarded in-memory accumulator
- `New()`: initializes with Version=1, CreatedAt=now, empty CompletedUnits
- `AddUnit()`: appends unit under lock, calls `atomicSave` (write `.tmp` + `os.Rename`)
- `Load()`: reads + unmarshals; returns `(nil, nil)` for missing file; rejects version != 1
- `Delete()`: `os.Remove` with idempotent nil on `IsNotExist`
- `AutoPath()`: deterministic temp-dir path `checkpoint-{provider}-{scanID}.json`

Imports limited to: `encoding/json`, `fmt`, `os`, `path/filepath`, `sync`, `time`, plus `calculator.FindingRow`.

## Verification

- `go test ./internal/checkpoint/... -v -race -count=1` — **6/6 PASS**, no data races
  - TestCheckpoint_RoundTrip: New → AddUnit → Load; verified unit count, ID, findings
  - TestLoad_FileNotExist: returns (nil, nil)
  - TestLoad_VersionMismatch: version=99 file returns error containing "not supported"
  - TestCheckpoint_ConcurrentAddUnit: 10 goroutines, all 10 units present, no duplicates
  - TestDelete: file removed; second Delete returns nil (idempotent)
  - TestAutoPath: path contains TempDir, provider, scanID, ends with .json
- `go vet ./internal/... ./server/...` — clean
- Existing scanner tests: AWS 17 pass, Azure 4 pass, GCP 36 pass — no regressions

### Slice Verification Status (T01 — intermediate)

| Check | Status |
|---|---|
| `go test ./internal/checkpoint/... -v -count=1` | ✅ PASS |
| `go test ./internal/scanner/aws/... -v -count=1` | ✅ PASS (17 tests, no regressions) |
| `go test ./internal/scanner/azure/... -v -count=1` | ✅ PASS (4 tests, no regressions) |
| `go test ./internal/scanner/gcp/... -v -count=1` | ✅ PASS (36 tests, no regressions) |
| `go vet ./internal/... ./server/...` | ✅ clean |
| Scanner checkpoint resume tests | ⏳ T03 |
| Orchestrator/server regression | ⏳ T02 |
| Full `go test ./...` | ⏳ T03 |

## Diagnostics

- Checkpoint file at `AutoPath()` location is plain JSON, human-readable
- `Load()` errors include version number in message for easy triage
- `atomicSave` errors include path and underlying OS error

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `internal/checkpoint/checkpoint.go` — new package: types, New, AddUnit, atomicSave, Load, Delete, AutoPath
- `internal/checkpoint/checkpoint_test.go` — 6 tests covering round-trip, missing file, version mismatch, concurrency, delete, auto-path
