---
id: T01
parent: S01
milestone: M004-2qci81
provides:
  - Generic CallWithBackoff[T] retry primitive with exponential backoff + full jitter
  - Context-aware Semaphore concurrency limiter
  - HTTPStatusError for HTTP status-based retry classification
key_files:
  - internal/cloudutil/retry.go
  - internal/cloudutil/semaphore.go
  - internal/cloudutil/retry_test.go
  - internal/cloudutil/semaphore_test.go
key_decisions:
  - Used math/rand/v2.Int64N for jitter — no seeding required, cryptographically adequate for backoff
  - OnRetry callback uses 1-based attempt numbering (attempt 1 = first retry after initial failure)
  - computeDelay includes overflow guard — if baseDelay * 2^attempt overflows, clamps to maxDelay
patterns_established:
  - RetryableError / RetryAfterError interfaces for typed error classification — scanners implement these on their HTTP error types
  - BackoffOptions struct with zero-value defaults pattern — callers only set what they need
  - Semaphore wraps buffered channel with context-aware Acquire — replaces raw channel patterns in scanners
observability_surfaces:
  - OnRetry callback receives attempt number, error, and delay before each sleep — downstream scanners will use this to emit scanner.Event{Type: "retry"}
  - Exhaustion error wraps last error with "after N attempts:" prefix — grep-able in logs
duration: 25m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T01: Build CallWithBackoff and Semaphore primitives with comprehensive tests

**Created `internal/cloudutil` package with generic retry/backoff and concurrency-limiting primitives — all 13 tests pass with `-race`, zero data races.**

## What Happened

Implemented two foundational utilities in the new `internal/cloudutil` package:

1. **`CallWithBackoff[T]`** — Generic retry wrapper using exponential backoff with full jitter (`random(0, min(maxDelay, baseDelay * 2^attempt))`). Supports `RetryableError` and `RetryAfterError` interfaces for typed error classification and server-specified delays. Context-aware sleep exits immediately on cancellation. Optional `OnRetry` callback for observability.

2. **`Semaphore`** — Channel-based concurrency limiter with context-aware `Acquire()`. `NewSemaphore(0)` safely defaults to capacity 1.

3. **`HTTPStatusError`** — Implements both `RetryableError` and `RetryAfterError`. Classifies 429/500/502/503/504 as retryable.

Wrote 9 retry tests and 4 semaphore tests covering success paths, retry exhaustion, context cancellation, RetryAfter override, non-retryable short-circuit, jitter bounds, and concurrency limiting.

## Verification

- `go test ./internal/cloudutil/... -v -count=1 -race` — **13/13 PASS**, no data races
- `go vet ./internal/cloudutil/...` — clean, no warnings
- `go test ./... -count=1` — all Go packages pass (root package fails on pre-existing missing `frontend/dist` embed, unrelated)

### Slice-level verification status (T01 of 2):
- ✅ `go test ./internal/cloudutil/... -v -count=1` — all retry and semaphore tests pass
- ⏳ `go test ./internal/scanner/aws/... -v -count=1` — passes (no changes to AWS yet, that's T02)
- ✅ `go test ./... -count=1` — all Go packages pass (embed issue is pre-existing)
- ⏳ `cd frontend && npx tsc --noEmit` — not yet applicable (T02 adds frontend fields)

## Diagnostics

- Run `go test ./internal/cloudutil/... -v` to see retry behavior and jitter bounds
- `TestCallWithBackoff_OnRetryCallback` validates the callback contract that downstream scanners depend on
- `TestCallWithBackoff_JitterBounded` validates delay distribution stays within `[0, ceiling)` bounds
- Error messages from exhausted retries contain "after N attempts:" — searchable in production logs

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `internal/cloudutil/retry.go` — `CallWithBackoff[T]`, `BackoffOptions`, `RetryableError`, `RetryAfterError`, `HTTPStatusError`
- `internal/cloudutil/semaphore.go` — `Semaphore`, `NewSemaphore`, `Acquire`, `Release`
- `internal/cloudutil/retry_test.go` — 9 test cases covering all retry behaviors
- `internal/cloudutil/semaphore_test.go` — 4 test cases covering concurrency and cancellation
- `.gsd/milestones/M004-2qci81/slices/S01/tasks/T01-PLAN.md` — added Observability Impact section
