---
id: T01
parent: S03
milestone: M004-2qci81
provides:
  - scanAllSubscriptions parallel fan-out with cloudutil.Semaphore
  - subscription_progress event emissions (scanning/complete/error)
  - Non-fatal per-subscription error handling
key_files:
  - internal/scanner/azure/scanner.go
  - internal/scanner/azure/scanner_test.go
key_decisions:
  - "scanSubscriptionFunc package-level var for test seam — allows swapping scanSubscription in tests without interface indirection"
  - "Display name resolution stays in scanAllSubscriptions (shared map before goroutine launch) — avoids per-goroutine API calls"
patterns_established:
  - "Azure multi-subscription fan-out mirrors AWS scanOrg pattern: Semaphore + WaitGroup + mu.Lock aggregation"
observability_surfaces:
  - "scanner.Event{Type: 'subscription_progress'} with Status scanning/complete/error per subscription"
  - "Error messages include subscription ID, display name, and wrapped error"
duration: 15m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T01: Multi-subscription parallel fan-out with subscription_progress events

**Converted Azure `Scan()` from sequential subscription iteration to parallel fan-out using `cloudutil.Semaphore`, with `subscription_progress` events and per-subscription fault tolerance.**

## What Happened

Extracted `scanAllSubscriptions()` from `Scan()`, following the AWS `scanOrg()` pattern established in S02. The new function:

1. Resolves subscription display names upfront (shared map, single API pass)
2. Creates a `cloudutil.NewSemaphore(workers)` with default 5, overridden by `req.MaxWorkers`
3. Launches one goroutine per subscription with `WaitGroup`, each acquiring the semaphore before scanning
4. Aggregates findings under `mu.Lock()`
5. Emits `subscription_progress` events: `scanning` before scan starts, `complete` on success, `error` on failure
6. Per-subscription failures are non-fatal — error event published, other subscriptions continue

Added `scanSubscriptionFunc` package-level variable (defaults to `scanSubscription`) as a test seam, allowing the fan-out test to stub individual subscription scan behavior.

## Verification

- `go test ./internal/scanner/azure/... -v -count=1` — **3 tests pass** (TestResourceGroupFromID, TestCountNICIPs_Logic, TestScanAllSubscriptions_FanOut)
- `go vet ./internal/scanner/azure/...` — **clean**
- `go test ./... -count=1` — **all packages pass** (excluding pre-existing `frontend/dist` embed error)
- Fan-out test confirms: 3 subscriptions scanned, sub-2 failure doesn't abort sub-1/sub-3, subscription_progress events emitted for all three with correct statuses

## Diagnostics

- Grep `subscription_progress` in scan status events to see per-subscription progress
- Error events include subscription ID + display name + wrapped error for debugging
- Concurrency configurable via `MaxWorkers` field on `ScanRequest`

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `internal/scanner/azure/scanner.go` — Added `maxConcurrentSubscriptions` const, `scanSubscriptionFunc` var, extracted `scanAllSubscriptions()` with parallel fan-out, updated `Scan()` to delegate to it
- `internal/scanner/azure/scanner_test.go` — Added `TestScanAllSubscriptions_FanOut` with stub-based verification of fan-out, progress events, and fault tolerance; added `containsSubstring`/`containsStatus` helpers
