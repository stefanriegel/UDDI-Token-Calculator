# S02: Nios Backend Scanner

**Goal:** Create the Wave 0 test infrastructure for Phase 10.
**Demo:** Create the Wave 0 test infrastructure for Phase 10.

## Must-Haves


## Tasks

- [x] **T01: 10-nios-backend-scanner 01** `est:6min`
  - Create the Wave 0 test infrastructure for Phase 10. All tests start in RED (failing/skipped) and turn GREEN as implementation proceeds in Waves 1-3.

Purpose: Establishes Nyquist-compliant automated verification so every Wave 1-3 task has an `<automated>` command to run against.
Output: scanner_test.go stubs, testdata/minimal.tar.gz generator, scan_nios_test.go stub.
- [x] **T02: 10-nios-backend-scanner 02**
  - Implement the three pure-logic packages for the NIOS scanner: family mapping, counting accumulator, and service role extraction. No file I/O or XML streaming in this plan — that is Wave 2.

Purpose: Isolates testable business logic from I/O so unit tests run in microseconds without touching the filesystem.
Output: families.go, counter.go, roles.go — all pure functions, no imports of archive/tar or compress/gzip.
- [x] **T03: 10-nios-backend-scanner 03** `est:35min`
  - Wire the production NIOS scanner: replace the stub Scan() with two-pass streaming XML parse, fix the upload handler (PROPERTY element parsing + temp file write + service roles), store selectedMembers, and propagate NiosServerMetrics through session and orchestrator.

Purpose: This is the core implementation wave — all five scanner unit tests should turn GREEN after this plan.
Output: Real scanner.go, fixed server/scan.go, updated server/types.go, session.go and orchestrator.go.
- [x] **T04: 10-nios-backend-scanner 04** `est:8min`
  - Complete the results API extension: add the typed NiosServerMetric struct to server/types.go, replace the json.RawMessage placeholder from Plan 03 with the proper typed field, decode NiosServerMetricsJSON in HandleScanResults, and make the API-02 test go GREEN.

Purpose: Closes the loop between the NIOS scanner output and the frontend API contract (§6 of API_CONTRACT.md).
Output: Typed NiosServerMetric in types.go, HandleScanResults updated, scan_nios_test.go test passing.

## Files Likely Touched

- `internal/scanner/nios/scanner_test.go`
- `internal/scanner/nios/testdata/gen_test.go`
- `server/scan_nios_test.go`
- `internal/scanner/nios/families.go`
- `internal/scanner/nios/counter.go`
- `internal/scanner/nios/roles.go`
- `internal/scanner/nios/scanner.go`
- `server/scan.go`
- `server/types.go`
- `internal/session/session.go`
- `internal/orchestrator/orchestrator.go`
- `server/types.go`
- `server/scan.go`
- `server/scan_nios_test.go`
