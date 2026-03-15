---
id: S01
parent: M004-2qci81
milestone: M004-2qci81
provides:
  - Generic CallWithBackoff[T] retry primitive with exponential backoff, full jitter, RetryableError/RetryAfterError interfaces
  - Context-aware Semaphore concurrency limiter (channel-based)
  - HTTPStatusError for HTTP 429/5xx retry classification
  - MaxWorkers and RequestTimeout fields threaded through full scan pipeline (frontend → server → orchestrator → scanner)
  - AWS scanAllRegions using cloudutil.Semaphore instead of raw buffered channel
requires: []
affects:
  - S02
  - S03
  - S04
  - S05
  - S06
key_files:
  - internal/cloudutil/retry.go
  - internal/cloudutil/semaphore.go
  - internal/cloudutil/retry_test.go
  - internal/cloudutil/semaphore_test.go
  - internal/scanner/provider.go
  - internal/orchestrator/orchestrator.go
  - server/types.go
  - server/scan.go
  - internal/scanner/aws/regions.go
  - internal/scanner/aws/scanner.go
  - frontend/src/app/components/api-client.ts
key_decisions:
  - CallWithBackoff uses RetryableError/RetryAfterError interfaces (not HTTP-specific) — works for both HTTP calls and arbitrary function retry
  - Semaphore is a thin channel wrapper matching existing aws/regions.go pattern — minimal diff for extraction
  - MaxWorkers/RequestTimeout use zero-means-default semantics with omitempty JSON — old clients get provider defaults
  - math/rand/v2.Int64N for jitter — no seeding required
  - OnRetry callback uses 1-based attempt numbering (attempt 1 = first retry after initial failure)
  - scanAllRegions accepts maxWorkers param directly (not full ScanRequest) — keeps function signature focused
patterns_established:
  - RetryableError / RetryAfterError interfaces for typed error classification — scanners implement these on their HTTP error types
  - BackoffOptions struct with zero-value defaults — callers only set what they need
  - Semaphore wraps buffered channel with context-aware Acquire — replaces raw channel patterns in scanners
  - Zero-means-default for scan parameters — preserves backward compatibility with no API changes
observability_surfaces:
  - OnRetry callback receives attempt number, error, and delay before each sleep — downstream scanners emit scanner.Event{Type: "retry"}
  - Exhaustion error wraps last error with "after N attempts:" prefix — grep-able in logs
  - MaxWorkers and RequestTimeout visible on ScanRequest — scanners can log these values at scan start
drill_down_paths:
  - .gsd/milestones/M004-2qci81/slices/S01/tasks/T01-SUMMARY.md
  - .gsd/milestones/M004-2qci81/slices/S01/tasks/T02-SUMMARY.md
duration: 40m
verification_result: passed
completed_at: 2026-03-15
---

# S01: Retry/Backoff Infrastructure + Configurable Scan Parameters

**Shared retry/backoff and concurrency-limiting primitives in `internal/cloudutil/`, with configurable MaxWorkers/RequestTimeout threaded from frontend API through the entire scan pipeline.**

## What Happened

Created the `internal/cloudutil` package with two foundational utilities that all six downstream slices depend on:

**T01** built `CallWithBackoff[T]` — a generic retry wrapper using exponential backoff with full jitter (`random(0, min(maxDelay, baseDelay * 2^attempt))`). Uses `RetryableError` and `RetryAfterError` interfaces for typed error classification, so it works with any error type (not just HTTP). Includes `HTTPStatusError` that classifies 429/500/502/503/504 as retryable. Also built `Semaphore` — a channel-based concurrency limiter with context-aware `Acquire()`. Both have comprehensive tests (13 total) covering success paths, retry exhaustion, context cancellation, RetryAfter override, jitter bounds, and concurrency limiting.

**T02** threaded `MaxWorkers` and `RequestTimeout` through the full scan pipeline: `ScanProviderSpec` (JSON API) → `ScanProviderRequest` (orchestrator) → `ScanRequest` (scanner). Updated `toOrchestratorProviders()` and `buildScanRequest()` to copy fields through. Replaced the raw buffered channel in AWS `scanAllRegions` with `cloudutil.NewSemaphore(maxWorkers)`. Added optional `maxWorkers?` and `requestTimeout?` to the frontend TypeScript `ScanRequest` type.

## Verification

- `go test ./internal/cloudutil/... -v -count=1` — 13/13 PASS (retry + semaphore)
- `go test ./internal/scanner/aws/... -v -count=1` — 5/5 PASS (AWS with semaphore extraction)
- `go test ./... -count=1` — all packages pass (root embed failure is pre-existing missing `frontend/dist`)
- `cd frontend && npx tsc --noEmit` — no new errors (pre-existing shadcn/ui type issues only)

## Deviations

None.

## Known Limitations

- `RequestTimeout` is threaded through but not yet consumed by any scanner — S02+ will use it for per-request HTTP client timeouts
- Bluecat/EfficientIP scanners still use their own retry logic — migration to `CallWithBackoff` deferred (existing logic works and is tested)
- Pre-existing TypeScript errors in shadcn/ui components (calendar.tsx, chart.tsx, resizable.tsx) are unrelated to this work

## Follow-ups

None — all planned work completed.

## Files Created/Modified

- `internal/cloudutil/retry.go` — `CallWithBackoff[T]`, `BackoffOptions`, `RetryableError`, `RetryAfterError`, `HTTPStatusError`
- `internal/cloudutil/semaphore.go` — `Semaphore`, `NewSemaphore`, `Acquire`, `Release`
- `internal/cloudutil/retry_test.go` — 9 test cases covering all retry behaviors
- `internal/cloudutil/semaphore_test.go` — 4 test cases covering concurrency and cancellation
- `internal/scanner/provider.go` — added `MaxWorkers` and `RequestTimeout` to `ScanRequest`
- `internal/orchestrator/orchestrator.go` — added fields to `ScanProviderRequest`; updated `buildScanRequest()`
- `server/types.go` — added JSON-tagged fields to `ScanProviderSpec` with `omitempty`
- `server/scan.go` — updated `toOrchestratorProviders()` to copy new fields
- `internal/scanner/aws/regions.go` — replaced raw channel with `cloudutil.Semaphore`; added `maxWorkers` parameter
- `internal/scanner/aws/scanner.go` — updated `scanAllRegions` call to pass `req.MaxWorkers`
- `frontend/src/app/components/api-client.ts` — added optional `maxWorkers` and `requestTimeout` to `ScanRequest` type

## Forward Intelligence

### What the next slice should know
- `CallWithBackoff` returns `(T, error)` — wrap your cloud API call in `func() (T, error)` and pass to it. The `OnRetry` callback is the hook for emitting `scanner.Event{Type: "retry"}` progress events.
- `Semaphore` is already proven in `scanAllRegions` — use the same `Acquire`/`Release` pattern for multi-account/subscription/project fan-out in S02-S04.
- `MaxWorkers` flows all the way to `ScanRequest` — read `req.MaxWorkers` in your scanner and default to a provider constant when it's 0.
- `RequestTimeout` flows through but is not consumed yet — S02+ should use it to set `http.Client.Timeout`.

### What's fragile
- `computeDelay` overflow guard clamps to `maxDelay` when `baseDelay * 2^attempt` overflows — correct but untested for extreme attempt counts (>62). Unlikely to matter since `MaxRetries` defaults to 3.

### Authoritative diagnostics
- `go test ./internal/cloudutil/... -v` — shows retry behavior and jitter bounds in test output
- `TestCallWithBackoff_OnRetryCallback` — validates the callback contract downstream scanners depend on
- grep `"after .* attempts:"` in logs to find exhausted retries in production

### What assumptions changed
- None — all assumptions from planning held.
