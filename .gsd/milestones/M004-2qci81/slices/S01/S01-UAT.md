# S01: Retry/Backoff Infrastructure + Configurable Scan Parameters — UAT

**Milestone:** M004-2qci81
**Written:** 2026-03-15

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: S01 produces pure library code (retry/semaphore primitives) and structural field threading — no runtime behavior or UI to test live. Contract-level unit tests verify all behaviors. Human testing becomes relevant in S02+ when these primitives are exercised against real cloud APIs.

## Preconditions

- Go 1.24+ installed and in PATH
- Repository cloned with all dependencies resolved (`go mod download`)
- Frontend dependencies installed (`cd frontend && npm install`)

## Smoke Test

Run `go test ./internal/cloudutil/... -v -count=1` — all 13 tests pass, confirming retry and semaphore primitives are functional.

## Test Cases

### 1. CallWithBackoff retries transient errors and succeeds

1. Open `internal/cloudutil/retry_test.go`, locate `TestCallWithBackoff_RetryThenSuccess`
2. Run `go test ./internal/cloudutil/... -run TestCallWithBackoff_RetryThenSuccess -v`
3. **Expected:** Test passes. Function returns success after 2 retries. OnRetry callback receives attempts 1 and 2 with increasing delays.

### 2. CallWithBackoff respects max retries and returns last error

1. Run `go test ./internal/cloudutil/... -run TestCallWithBackoff_MaxRetriesExceeded -v`
2. **Expected:** Test passes. After 3 retries (default), returns error with "after 3 attempts:" prefix wrapping the original error.

### 3. CallWithBackoff cancels during backoff sleep

1. Run `go test ./internal/cloudutil/... -run TestCallWithBackoff_ContextCancelled -v`
2. **Expected:** Test passes. Context cancellation during backoff sleep returns `context.Canceled` immediately, not after the full delay.

### 4. CallWithBackoff respects Retry-After header

1. Run `go test ./internal/cloudutil/... -run TestCallWithBackoff_RetryAfterOverride -v`
2. **Expected:** Test passes. When error implements `RetryAfterError` returning 5s, the actual delay used is 5s (not the computed exponential backoff).

### 5. CallWithBackoff short-circuits on non-retryable errors

1. Run `go test ./internal/cloudutil/... -run TestCallWithBackoff_NonRetryableShortCircuits -v`
2. **Expected:** Test passes. A non-retryable error (e.g., 404) is returned immediately without any retry attempts.

### 6. CallWithBackoff jitter stays within bounds

1. Run `go test ./internal/cloudutil/... -run TestCallWithBackoff_JitterBounded -v`
2. **Expected:** Test passes. 100 iterations confirm all delays fall within `[0, min(maxDelay, baseDelay * 2^attempt))`.

### 7. Semaphore limits concurrency

1. Run `go test ./internal/cloudutil/... -run TestSemaphore_ConcurrencyLimit -v`
2. **Expected:** Test passes. With capacity 2, no more than 2 goroutines execute concurrently (verified via atomic counter).

### 8. Semaphore respects context cancellation

1. Run `go test ./internal/cloudutil/... -run TestSemaphore_ContextCancelled -v`
2. **Expected:** Test passes. Acquire on a full semaphore with a cancelled context returns `context.Canceled` instead of blocking.

### 9. MaxWorkers/RequestTimeout flow through scan pipeline

1. Run `go test ./... -count=1` and verify all packages pass
2. Inspect `server/types.go` — `ScanProviderSpec` has `MaxWorkers int` and `RequestTimeout int` with `json:"maxWorkers,omitempty"` / `json:"requestTimeout,omitempty"`
3. Inspect `server/scan.go` — `toOrchestratorProviders()` copies both fields
4. Inspect `internal/orchestrator/orchestrator.go` — `buildScanRequest()` copies both fields to `ScanRequest`
5. **Expected:** Fields are present at all four levels. Zero values produce no JSON output (omitempty). All existing tests pass.

### 10. AWS region fan-out uses Semaphore

1. Inspect `internal/scanner/aws/regions.go` — `scanAllRegions` function
2. Verify it imports `cloudutil` and calls `cloudutil.NewSemaphore(maxWorkers)`
3. Verify it calls `sem.Acquire(ctx)` before each goroutine and `sem.Release()` in defer
4. Verify fallback: when `maxWorkers <= 0`, uses `maxConcurrentRegions` (5)
5. Run `go test ./internal/scanner/aws/... -v -count=1`
6. **Expected:** AWS tests pass. Raw `make(chan struct{}, n)` pattern is gone, replaced by `Semaphore`.

### 11. Frontend types compile with new fields

1. Run `cd frontend && npx tsc --noEmit`
2. Inspect `frontend/src/app/components/api-client.ts` — `ScanRequest` type includes `maxWorkers?: number` and `requestTimeout?: number`
3. **Expected:** No new TypeScript errors. Fields are optional so existing callers are unaffected.

## Edge Cases

### Semaphore with zero capacity defaults to 1

1. Run `go test ./internal/cloudutil/... -run TestSemaphore_ZeroDefaultsToOne -v`
2. **Expected:** `NewSemaphore(0)` creates a semaphore with capacity 1 (not panic, not deadlock). Single acquire succeeds, second blocks.

### HTTPStatusError classifies retryable vs non-retryable

1. Run `go test ./internal/cloudutil/... -run TestHTTPStatusError_Retryable -v`
2. **Expected:** 429, 500, 502, 503, 504 → retryable. 400, 401, 403, 404 → not retryable.

### MaxWorkers=0 preserves backward compatibility

1. Send a scan request JSON with no `maxWorkers` field (or `maxWorkers: 0`)
2. **Expected:** AWS `scanAllRegions` uses default `maxConcurrentRegions` (5). No error, no behavioral change from pre-S01 behavior.

## Failure Signals

- Any test in `go test ./internal/cloudutil/... -v -count=1` fails → retry or semaphore primitive is broken
- Any test in `go test ./... -count=1` fails (excluding root embed) → regression introduced by field threading or semaphore extraction
- `npx tsc --noEmit` shows errors in `api-client.ts` → frontend type additions are wrong
- `scanAllRegions` still uses raw `make(chan struct{})` → semaphore extraction incomplete
- `buildScanRequest()` or `toOrchestratorProviders()` missing field copies → MaxWorkers/RequestTimeout won't reach scanner

## Requirements Proved By This UAT

- None directly — S01 is infrastructure. It provides primitives that S02-S07 use to prove milestone requirements (multi-account scanning, retry under throttling, checkpoint/resume, DNS breakdown).

## Not Proven By This UAT

- Retry behavior under real cloud API throttling (proved in S02-S04 with live API calls)
- MaxWorkers actually affecting scan parallelism end-to-end (proved in S02-S04 integration tests)
- RequestTimeout being consumed by any scanner (S02+ will wire it to http.Client.Timeout)
- Frontend UI controls for MaxWorkers/RequestTimeout (S07 builds the UI)
- Checkpoint/resume using retry infrastructure (S05)

## Notes for Tester

- The root package `go test` failure (`embed.go: pattern all:frontend/dist: no matching files found`) is pre-existing — the frontend hasn't been built into `frontend/dist` in this environment. This is unrelated to S01.
- Pre-existing TypeScript errors in `calendar.tsx`, `chart.tsx`, `resizable.tsx` are shadcn/ui component issues, not from our changes. Verify no errors in `api-client.ts` specifically.
- `RequestTimeout` being unused is intentional — it's threaded through structurally so S02+ can consume it without touching the pipeline again.
