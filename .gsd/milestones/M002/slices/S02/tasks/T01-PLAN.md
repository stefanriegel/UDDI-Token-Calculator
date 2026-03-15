# T01: 10-nios-backend-scanner 01

**Slice:** S02 — **Milestone:** M002

## Description

Create the Wave 0 test infrastructure for Phase 10. All tests start in RED (failing/skipped) and turn GREEN as implementation proceeds in Waves 1-3.

Purpose: Establishes Nyquist-compliant automated verification so every Wave 1-3 task has an `<automated>` command to run against.
Output: scanner_test.go stubs, testdata/minimal.tar.gz generator, scan_nios_test.go stub.

## Must-Haves

- [ ] "go test ./internal/scanner/nios/... compiles and all stubs fail (RED) before implementation"
- [ ] "go test ./server/... -run TestHandleScanResultsNIOS compiles and fails (RED) before implementation"
- [ ] "testdata/minimal.tar.gz exists as a synthetic gzip+tar fixture with a onedb.xml containing 2 members (GM + DNS-only) and representative OBJECT elements"

## Files

- `internal/scanner/nios/scanner_test.go`
- `internal/scanner/nios/testdata/gen_test.go`
- `server/scan_nios_test.go`
