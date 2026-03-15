---
estimated_steps: 5
estimated_files: 2
---

# T01: Multi-subscription parallel fan-out with subscription_progress events

**Slice:** S03 — Azure Parallel Multi-Subscription + Expanded Resources
**Milestone:** M004-2qci81

## Description

Convert Azure `Scan()` from sequential subscription iteration to parallel fan-out using `cloudutil.Semaphore`, following the AWS `scanOrg()` pattern established in S02. Each subscription scan runs concurrently (default 5, configurable via `MaxWorkers`), emits `subscription_progress` events, and tolerates per-subscription failures without aborting the entire scan.

## Steps

1. Add `maxConcurrentSubscriptions = 5` const. Extract `scanAllSubscriptions(ctx, cred, subscriptions, maxWorkers, publish)` method that creates a `cloudutil.NewSemaphore(workers)`, launches goroutines per subscription with `WaitGroup`, aggregates findings under `mu.Lock()`, and emits `subscription_progress` events (scanning before scan, complete/error after).
2. Move subscription display-name resolution into `scanAllSubscriptions` (keep the existing map lookup pattern but inside the new function). Per-subscription failures: catch error from `scanSubscription`, publish `subscription_progress` with status `"error"` and the error message, continue other subscriptions.
3. Update `Scan()` to call `scanAllSubscriptions()` instead of the sequential `for` loop. Pass `req.MaxWorkers` through. Remove the old sequential loop and early-return-on-error pattern (partial results now come from all subscriptions that succeeded).
4. Add `TestScanAllSubscriptions_FanOut` test that verifies: (a) multiple subscriptions are scanned, (b) subscription_progress events are emitted per subscription, (c) a failing subscription doesn't abort others. Use a test helper that swaps `scanSubscription` behavior via a function variable or by testing the orchestration pattern directly.
5. Run `go test ./internal/scanner/azure/... -v -count=1` and `go vet ./internal/scanner/azure/...`.

## Must-Haves

- [ ] `scanAllSubscriptions()` uses `cloudutil.Semaphore` for concurrency limiting
- [ ] Default concurrency is 5, overridden by `req.MaxWorkers` when non-zero
- [ ] `subscription_progress` events emitted: scanning (start), complete (success), error (failure) per subscription
- [ ] Per-subscription failure is non-fatal — other subscriptions continue
- [ ] Same credential passed to all subscription goroutines (no per-sub credential exchange)
- [ ] Existing tests still pass

## Verification

- `go test ./internal/scanner/azure/... -v -count=1` — all pass
- `go vet ./internal/scanner/azure/...` — clean
- Confirm `subscription_progress` event emissions in test output

## Observability Impact

- Signals added: `scanner.Event{Type: "subscription_progress"}` with Status scanning/complete/error
- How a future agent inspects this: grep `subscription_progress` in scan status events
- Failure state exposed: per-subscription error message includes subscription ID, display name, and wrapped error

## Inputs

- `internal/scanner/azure/scanner.go` — current sequential `Scan()` with `scanSubscription()` already extracted
- `internal/scanner/aws/scanner.go` — `scanOrg()` as reference pattern for fan-out
- `internal/cloudutil/semaphore.go` — `NewSemaphore`, `Acquire`, `Release`

## Expected Output

- `internal/scanner/azure/scanner.go` — `Scan()` calls `scanAllSubscriptions()`, sequential loop replaced with parallel fan-out
- `internal/scanner/azure/scanner_test.go` — new fan-out test added
