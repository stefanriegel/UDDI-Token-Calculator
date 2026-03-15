# T01: 15-quick-win-auth-methods 00

**Slice:** S01 — **Milestone:** M003

## Description

Create failing test stubs (Wave 0 / Nyquist compliance) for the 5 new auth method behaviors that plans 15-01 and 15-02 will implement.

Purpose: Tests exist before implementation so that plan executors can use them as verification targets. Each test fails with a clear message indicating the behavior is not yet implemented ("Coming soon" or missing feature).

Output: 5 failing test functions across 3 test files. All tests compile against the current codebase.

## Must-Haves

- [ ] "Failing test stubs exist for all 5 new auth method behaviors before any implementation begins"
- [ ] "Tests compile against the current codebase (call existing functions/types)"
- [ ] "Every test fails with a clear assertion message indicating the unimplemented behavior"

## Files

- `server/validate_test.go`
- `internal/scanner/aws/scanner_test.go`
- `internal/scanner/ad/scanner_test.go`
