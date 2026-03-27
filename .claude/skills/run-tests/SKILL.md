---
name: run-tests
description: Runs Go backend tests (go test ./...) and/or frontend vitest tests (cd frontend && pnpm test). Understands project test patterns: Go stdlib assertions (no testify), table-driven tests, httptest servers with chi context injection, function-variable stubs, t.TempDir() fixtures; frontend vitest describe/it blocks with spread-defaults pattern. Use when user says 'run tests', 'check tests', 'verify', 'validate changes', or after code changes that need validation. Do NOT use for writing new test files from scratch — use coding-standards skill instead.
---
# Run Tests

## Critical

1. **Go tests use pure stdlib only** — no testify, no gomock, no ginkgo. Assertions use `if got != want { t.Errorf(...) }`. Never suggest or import third-party test packages.
2. **Frontend has only 2 test files** — `frontend/src/app/components/estimator-calc.test.ts` and `frontend/src/app/components/nios-calc.test.ts`. No component/UI tests exist. Don't expect broader frontend test coverage.
3. **Always use `-count=1`** for Go tests when debugging failures to bypass the test cache.
4. **Never run `go test` with `-race`** unless explicitly asked — CGO_ENABLED=0 is enforced and race detector requires CGO.

## Instructions

### Step 1: Determine which tests to run

If the change is:
- **Go only** (files in `internal/`, `server/`, `cmd/`, `*.go`) → run Go tests
- **Frontend only** (files in `frontend/src/`) → run frontend tests
- **Both or unclear** → run both

### Step 2: Run Go tests

```bash
# All tests
go test ./... -count=1

# Single package (when you know which is affected)
go test ./internal/calculator/... -count=1
go test ./server/... -count=1

# Verbose (to see individual test names)
go test ./internal/scanner/nios/... -v -count=1

# Run a specific test function
go test ./internal/calculator/... -run TestCalculate_GrandTotalIsMax -count=1
```

**Verify**: Exit code 0 and `ok` for each package. If a package shows `FAIL`, read the error output to identify the failing test function and assertion.

### Step 3: Run frontend tests

```bash
cd frontend && pnpm test
```

This runs `vitest run` (single execution, not watch mode). Output shows pass/fail per `describe`/`it` block.

**Verify**: All test suites pass with 0 failures. Check the summary line at the end.

### Step 4: Interpret failures

For Go failures, look for:
- `got X, want Y` — direct value mismatch (stdlib assertion pattern)
- `t.Errorf` / `t.Fatalf` messages — custom failure descriptions
- `--- FAIL: TestName` — the specific test function that failed

For frontend failures, look for:
- `expect(received).toBe(expected)` — value mismatch
- `Expected: X, Received: Y` — vitest diff output
- The `it('...')` description tells you which case failed

### Step 5: Re-run after fixes

After fixing a failure, re-run only the affected package/file:
```bash
# Go — targeted re-run
go test ./internal/calculator/... -count=1

# Frontend — targeted re-run (run from frontend/ directory)
cd frontend && pnpm exec vitest run src/app/components/nios-calc.test.ts
```

Then run the full suite once to confirm no regressions:
```bash
go test ./... -count=1
cd frontend && pnpm test
```

## Examples

**User says**: "run tests" after modifying `internal/calculator/calculator.go`

**Actions**:
1. Run `go test ./internal/calculator/... -count=1` (targeted)
2. If passes, run `go test ./... -count=1` (full suite for regressions)
3. Skip frontend tests (no frontend changes)
4. Report: "All 36 Go test files pass. No frontend changes detected."

**User says**: "verify" after modifying `frontend/src/app/components/estimator-calc.ts`

**Actions**:
1. Run `cd frontend && pnpm test`
2. Check `frontend/src/app/components/estimator-calc.test.ts` results (13 reference cases A-I, R1-R6 plus W1-W5 warning tests)
3. Report: "All 13 estimator cases and 5 warning tests pass."

**User says**: "check tests" after modifying `server/scan.go` and `frontend/src/app/components/nios-calc.ts`

**Actions**:
1. Run `go test ./server/... -count=1` and `cd frontend && pnpm test` in parallel
2. If both pass, run `go test ./... -count=1` for full Go regression check
3. Report results for both stacks

## Common Issues

**`cannot find package` or `no Go files in` error**:
You're running from the wrong directory. Ensure CWD is the project root (`/Users/mustermann/Documents/coding/UDDI-GO-Token-Calculator`), not a subdirectory.

**`build constraints exclude all Go files`**:
Don't pass `-race` flag. The project enforces `CGO_ENABLED=0` and race detector needs CGO. Run: `go test ./... -count=1` without `-race`.

**Go test passes but shouldn't (stale cache)**:
Go caches test results. Always use `-count=1` to force re-execution: `go test ./... -count=1`.

**`ERR_PNPM_NO_LOCKFILE` or missing deps in frontend**:
Run `cd frontend && pnpm install` first, then `pnpm test`.

**Frontend test fails with `ReferenceError: describe is not defined`**:
Vitest globals are configured in `vite.config.ts` (`globals: true`). Don't run with plain `node` — always use `pnpm test` or `pnpm exec vitest run`.

**`open internal/scanner/nios/testdata/minimal.tar.gz: no such file or directory`**:
NIOS scanner tests use fixture files in `internal/scanner/nios/testdata/`. Tests must run from the package directory or project root. `go test ./internal/scanner/nios/... -count=1` handles this correctly.

**Chi route context errors in server tests (`chi.URLParam returns empty`)**:
Server handler tests must inject chi route context. Existing pattern in `server/server_test.go`:
```go
rctx := chi.NewRouteContext()
rctx.URLParams.Add("scanId", scanID)
req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
```
