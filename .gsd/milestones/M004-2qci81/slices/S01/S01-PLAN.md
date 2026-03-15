# S01: Retry/Backoff Infrastructure + Configurable Scan Parameters

**Goal:** Provide shared retry/backoff and concurrency-limiting primitives in `internal/cloudutil/`, and thread configurable `MaxWorkers`/`RequestTimeout` fields from the frontend API through the HTTP handler → orchestrator → scanner interface.

**Demo:** A test proves `CallWithBackoff` retries transient errors with exponential backoff + jitter and respects context cancellation. A test proves `Semaphore` gates concurrency correctly. The AWS region fan-out uses the extracted `Semaphore`. `MaxWorkers` and `RequestTimeout` are accepted in the scan start API, threaded to `ScanRequest`, and default sensibly when omitted.

## Must-Haves

- `internal/cloudutil/retry.go` — generic `CallWithBackoff[T]` with configurable max retries, base delay, max delay, full jitter, retryable-error classifier, `Retry-After` header respect, context-aware sleep, and optional publish callback for retry events
- `internal/cloudutil/semaphore.go` — `Semaphore` struct with context-aware `Acquire(ctx)` / `Release()`, wrapping a buffered channel
- `internal/cloudutil/retry_test.go` — tests covering: successful call, retry on retryable error, max retries exceeded, context cancellation during backoff, `Retry-After` header override, non-retryable error short-circuits, jitter produces bounded delays, publish callback invoked on retry
- `internal/cloudutil/semaphore_test.go` — tests covering: acquire/release cycle, concurrency limiting, context cancellation blocks acquire
- `scanner.ScanRequest` gains `MaxWorkers int` and `RequestTimeout int` fields
- `orchestrator.ScanProviderRequest` gains `MaxWorkers int` and `RequestTimeout int` fields
- `server.ScanProviderSpec` gains `MaxWorkers int` and `RequestTimeout int` JSON fields with `omitempty`
- `toOrchestratorProviders()` copies new fields through
- `buildScanRequest()` copies new fields through
- Frontend `ScanRequest` type gains `maxWorkers?` and `requestTimeout?` optional fields
- AWS `scanAllRegions` uses `cloudutil.Semaphore` instead of raw buffered channel
- All existing tests pass — zero regressions

## Proof Level

- This slice proves: contract
- Real runtime required: no (unit tests exercise the primitives; field threading is structural)
- Human/UAT required: no

## Verification

- `go test ./internal/cloudutil/... -v -count=1` — all retry and semaphore tests pass
- `go test ./internal/scanner/aws/... -v -count=1` — AWS tests pass with semaphore extraction
- `go test ./... -count=1` — full suite passes, no regressions
- `cd frontend && npx tsc --noEmit` — frontend types compile with new fields

## Observability / Diagnostics

- Runtime signals: `CallWithBackoff` accepts an optional `OnRetry` callback that emits a `scanner.Event{Type: "retry"}` with attempt number and backoff duration in the message — downstream slices use this for progress visibility
- Inspection surfaces: retry events flow through existing broker → SSE path; not consumed by frontend yet (safe — frontend ignores unknown event types)
- Failure visibility: `CallWithBackoff` returns the last error wrapped with attempt count context
- Redaction constraints: none (no secrets flow through retry/semaphore)

## Integration Closure

- Upstream surfaces consumed: `scanner.Event` struct (Type field), `scanner.ScanRequest`, `orchestrator.ScanProviderRequest`, `server.ScanProviderSpec`, `server.toOrchestratorProviders()`, `orchestrator.buildScanRequest()`, frontend `ScanRequest` type
- New wiring introduced in this slice: `cloudutil` package created; AWS `scanAllRegions` imports `cloudutil.Semaphore`; field pass-through in scan start pipeline
- What remains before the milestone is truly usable end-to-end: S02–S07 consume these primitives for actual multi-account scanning, checkpoint, DNS breakdown, and frontend extensions

## Tasks

- [x] **T01: Build CallWithBackoff and Semaphore primitives with comprehensive tests** `est:1h`
  - Why: All six downstream slices depend on these two utilities — they're the foundation of S01
  - Files: `internal/cloudutil/retry.go`, `internal/cloudutil/semaphore.go`, `internal/cloudutil/retry_test.go`, `internal/cloudutil/semaphore_test.go`
  - Do: Create `internal/cloudutil/` package. Implement `CallWithBackoff[T any](ctx, fn, opts)` with: configurable `MaxRetries` (default 3), `BaseDelay` (default 1s), `MaxDelay` (default 30s), full jitter (`random(0, min(maxDelay, baseDelay * 2^attempt))`), `IsRetryable` func classifier (default: checks for `RetryableError` interface or HTTP status 429/500/502/503/504), `Retry-After` header respect via `RetryAfterError` interface, context-aware sleep using `select` with `time.After` and `ctx.Done()`, optional `OnRetry` callback. Implement `Semaphore` with `NewSemaphore(n int)`, `Acquire(ctx) error`, `Release()`. Guard against `n<=0` by defaulting to 1. Write thorough tests for both — see must-haves for test case list.
  - Verify: `go test ./internal/cloudutil/... -v -count=1` — all tests pass
  - Done when: Both utilities compile, are well-documented, and all test cases pass including context cancellation and jitter bounds

- [x] **T02: Thread MaxWorkers/RequestTimeout through scan pipeline and wire Semaphore into AWS** `est:45m`
  - Why: Completes the slice by making concurrency configurable from the API and proving the semaphore works in the existing AWS fan-out
  - Files: `internal/scanner/provider.go`, `internal/orchestrator/orchestrator.go`, `server/types.go`, `server/scan.go`, `internal/scanner/aws/regions.go`, `frontend/src/app/components/api-client.ts`
  - Do: Add `MaxWorkers int` and `RequestTimeout int` to `ScanRequest`, `ScanProviderRequest`, `ScanProviderSpec` (JSON `maxWorkers,omitempty` / `requestTimeout,omitempty`). Copy fields through in `toOrchestratorProviders()` and `buildScanRequest()`. In `aws/regions.go`, replace `sem := make(chan struct{}, maxConcurrentRegions)` with `cloudutil.NewSemaphore(req.MaxWorkers)` — if `MaxWorkers` is 0, use `maxConcurrentRegions` (5) as default. Keep `maxConcurrentRegions` const as the provider default. Update `scanAllRegions` signature to accept maxWorkers param. Add `maxWorkers?` and `requestTimeout?` to frontend `ScanRequest` type.
  - Verify: `go test ./... -count=1` passes (no regressions); `cd frontend && npx tsc --noEmit` compiles
  - Done when: New fields flow end-to-end from API to scanner, AWS region fan-out uses Semaphore, all existing tests pass, frontend types compile

## Files Likely Touched

- `internal/cloudutil/retry.go` (new)
- `internal/cloudutil/semaphore.go` (new)
- `internal/cloudutil/retry_test.go` (new)
- `internal/cloudutil/semaphore_test.go` (new)
- `internal/scanner/provider.go`
- `internal/orchestrator/orchestrator.go`
- `server/types.go`
- `server/scan.go`
- `internal/scanner/aws/regions.go`
- `frontend/src/app/components/api-client.ts`
