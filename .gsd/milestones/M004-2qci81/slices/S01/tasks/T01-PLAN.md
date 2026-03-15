---
estimated_steps: 5
estimated_files: 4
---

# T01: Build CallWithBackoff and Semaphore primitives with comprehensive tests

**Slice:** S01 — Retry/Backoff Infrastructure + Configurable Scan Parameters
**Milestone:** M004-2qci81

## Description

Create the `internal/cloudutil` package with two foundational utilities that all downstream slices (S02–S07) depend on:

1. **`CallWithBackoff[T]`** — A generic retry wrapper with exponential backoff + full jitter, retryable error classification, `Retry-After` header support, context-aware sleep, and an optional retry event callback.

2. **`Semaphore`** — A concurrency limiter wrapping a buffered channel with context-aware `Acquire()`, extracted from the existing pattern in `aws/regions.go`.

Both utilities must be pure Go (CGO_ENABLED=0), use `math/rand/v2` for jitter, and respect context cancellation in all blocking paths.

## Steps

1. Create `internal/cloudutil/retry.go`:
   - Define `BackoffOptions` struct: `MaxRetries int`, `BaseDelay time.Duration`, `MaxDelay time.Duration`, `IsRetryable func(error) bool`, `OnRetry func(attempt int, err error, delay time.Duration)`
   - Define `RetryableError` interface with `IsRetryable() bool` for typed error classification
   - Define `RetryAfterError` interface with `RetryAfter() time.Duration` for `Retry-After` header propagation
   - Implement `CallWithBackoff[T any](ctx context.Context, fn func() (T, error), opts BackoffOptions) (T, error)`:
     - Default `MaxRetries` to 3, `BaseDelay` to 1s, `MaxDelay` to 30s when zero
     - Default `IsRetryable` to check `RetryableError` interface
     - Full jitter: `delay = random(0, min(maxDelay, baseDelay * 2^attempt))`
     - `RetryAfter` override: if error implements `RetryAfterError`, use that duration instead
     - Context-aware sleep: `select { case <-time.After(delay): case <-ctx.Done(): return zero, ctx.Err() }`
     - Call `OnRetry` callback before sleeping (if non-nil)
     - Return last error wrapped with attempt count on exhaustion
   - Define `HTTPStatusError` struct implementing both `RetryableError` and `RetryAfterError` — carries status code + optional `Retry-After` duration. Default retryable set: 429, 500, 502, 503, 504.

2. Create `internal/cloudutil/semaphore.go`:
   - `NewSemaphore(n int) *Semaphore` — if n<=0, default to 1
   - `Acquire(ctx context.Context) error` — `select { case s.ch <- struct{}{}: return nil; case <-ctx.Done(): return ctx.Err() }`
   - `Release()` — `<-s.ch`

3. Create `internal/cloudutil/retry_test.go` with test cases:
   - `TestCallWithBackoff_Success` — fn succeeds on first call
   - `TestCallWithBackoff_RetryThenSuccess` — fn fails twice with retryable error, succeeds third
   - `TestCallWithBackoff_MaxRetriesExceeded` — fn always fails, returns error after max retries
   - `TestCallWithBackoff_ContextCancelled` — cancel context during backoff sleep, returns ctx.Err()
   - `TestCallWithBackoff_RetryAfterOverride` — error implements RetryAfterError, sleep uses that duration
   - `TestCallWithBackoff_NonRetryableShortCircuits` — non-retryable error returns immediately without retry
   - `TestCallWithBackoff_JitterBounded` — verify delay is within [0, min(maxDelay, baseDelay*2^attempt)] across multiple runs
   - `TestCallWithBackoff_OnRetryCallback` — verify callback receives correct attempt number and error
   - `TestHTTPStatusError_Retryable` — 429/500/502/503/504 are retryable, 400/401/403/404 are not

4. Create `internal/cloudutil/semaphore_test.go` with test cases:
   - `TestSemaphore_AcquireRelease` — basic acquire and release cycle
   - `TestSemaphore_ConcurrencyLimit` — n goroutines can acquire, n+1th blocks until release
   - `TestSemaphore_ContextCancelled` — cancelled context returns error from Acquire
   - `TestSemaphore_ZeroDefaultsToOne` — NewSemaphore(0) creates capacity-1 semaphore

5. Run tests: `go test ./internal/cloudutil/... -v -count=1 -race`

## Must-Haves

- [ ] `CallWithBackoff[T]` is generic (no interface{} boxing)
- [ ] Full jitter formula: `random(0, min(maxDelay, baseDelay * 2^attempt))`
- [ ] Context-aware sleep — cancelled context exits backoff immediately
- [ ] `RetryAfterError` interface overrides computed backoff delay
- [ ] `HTTPStatusError` classifies 429/500/502/503/504 as retryable
- [ ] `Semaphore.Acquire` respects context cancellation
- [ ] `NewSemaphore(0)` does not panic (defaults to 1)
- [ ] All test cases pass with `-race` flag

## Verification

- `go test ./internal/cloudutil/... -v -count=1 -race` — all tests pass, no data races
- `go vet ./internal/cloudutil/...` — no vet warnings

## Inputs

- Bluecat `doRequest` retry pattern (`internal/scanner/bluecat/scanner.go:69-113`) — reference for retry loop structure
- EfficientIP `doWithRetry` pattern (`internal/scanner/efficientip/scanner.go:252-288`) — reference for `Retry-After` parsing
- AWS semaphore pattern (`internal/scanner/aws/regions.go:47-81`) — reference for channel-based concurrency limiting

## Observability Impact

- **New signal:** `CallWithBackoff` accepts an `OnRetry` callback that downstream scanners will use to emit `scanner.Event{Type: "retry"}` events with attempt number, error message, and backoff duration — these flow through the existing broker → SSE path for progress visibility
- **Failure context:** On retry exhaustion, `CallWithBackoff` wraps the last error with attempt count (`"after N attempts: <err>"`) — agents and operators can grep logs for "after N attempts" to locate persistent failures
- **Inspection:** Future agents can verify retry behavior by running `go test ./internal/cloudutil/... -v` — the `OnRetryCallback` test asserts the callback receives correct attempt numbers and errors; the `JitterBounded` test validates delay distribution
- **No runtime state persisted:** These are stateless primitives — no files, no persistent failure counters. Observability is purely through the callback interface and error wrapping

## Expected Output

- `internal/cloudutil/retry.go` — `CallWithBackoff[T]`, `BackoffOptions`, `RetryableError`, `RetryAfterError`, `HTTPStatusError`
- `internal/cloudutil/semaphore.go` — `Semaphore`, `NewSemaphore`, `Acquire`, `Release`
- `internal/cloudutil/retry_test.go` — 9 test cases covering all retry behaviors
- `internal/cloudutil/semaphore_test.go` — 4 test cases covering concurrency and cancellation
