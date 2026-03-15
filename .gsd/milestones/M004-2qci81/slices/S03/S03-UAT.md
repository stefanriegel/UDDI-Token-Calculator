# S03: Azure Parallel Multi-Subscription + Expanded Resources — UAT

**Milestone:** M004-2qci81
**Written:** 2026-03-15

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: All Azure SDK interactions are behind interfaces; fan-out logic and resource counting are verified through unit tests with mocked clients. No live Azure tenant required — contract verification proves correctness.

## Preconditions

- Go 1.24+ installed
- Working directory is project root (`UDDI-GO-Token-Calculator/`)
- All dependencies fetched (`go mod download`)

## Smoke Test

Run `go test ./internal/scanner/azure/... -v -count=1` — all 4 tests pass, no failures.

## Test Cases

### 1. Multi-subscription parallel fan-out dispatches all subscriptions

1. Run `go test ./internal/scanner/azure/... -v -run TestScanAllSubscriptions_FanOut`
2. Observe test output — 3 subscriptions configured (sub-1, sub-2 fails, sub-3)
3. **Expected:** Test passes. All 3 subscriptions are scanned (sub-2 failure does not abort sub-1 or sub-3). Findings from sub-1 and sub-3 are aggregated into the result.

### 2. subscription_progress events emitted for each subscription

1. In `TestScanAllSubscriptions_FanOut`, the test captures all emitted events
2. **Expected:** Events include `subscription_progress` with Status `scanning` for all 3 subscriptions, `complete` for sub-1 and sub-3, and `error` for sub-2. Error event for sub-2 includes subscription ID and display name.

### 3. Per-subscription failure is non-fatal

1. In `TestScanAllSubscriptions_FanOut`, sub-2 is configured to return an error
2. **Expected:** sub-1 and sub-3 findings are present in aggregated results. No panic, no early termination. Error event published for sub-2 with descriptive message.

### 4. Concurrency bounded by semaphore

1. In `scanAllSubscriptions()`, verify `cloudutil.NewSemaphore(workers)` is created with `maxConcurrentSubscriptions` (5) as default
2. If `req.MaxWorkers > 0`, that value overrides the default
3. **Expected:** Each goroutine calls `sem.Acquire()` before scanning and `sem.Release()` when done. Compile-time: `cloudutil.NewSemaphore` returns a Semaphore used consistently.

### 5. New resource count functions have correct signatures

1. Run `go test ./internal/scanner/azure/... -v -run TestExtractResourceGroupsFromVNetIDs`
2. Check compile-time signature assertions in `scanner_test.go`
3. **Expected:** All compile-time assertions pass: `countPublicIPs(ctx, cred, subID)`, `countNATGateways(ctx, cred, subID)`, `countAzureFirewalls(ctx, cred, subID)`, `countPrivateEndpoints(ctx, cred, subID)`, `countRouteTables(ctx, cred, subID)`, `countLBsAndGateways(ctx, cred, subID)` returns `(int, int, int, error)`, `countVNetGatewayIPs(ctx, cred, subID, vnetIDs)` returns `(int, int, error)`.

### 6. VNet gateway RG extraction handles edge cases

1. Run `go test ./internal/scanner/azure/... -v -run TestExtractResourceGroupsFromVNetIDs`
2. **Expected:** 5 sub-cases pass:
   - Two VNets in same RG → 1 unique RG
   - VNets in different RGs → 2 unique RGs
   - Empty VNet list → 0 RGs
   - Malformed ID without `resourceGroups` → skipped gracefully
   - Mix of valid and invalid → only valid RGs extracted

### 7. countVNetsAndSubnets returns VNet resource IDs

1. Check `countVNetsAndSubnets` signature in `scanner.go`
2. **Expected:** Returns `(vnets int, subnets int, vnetIDs []string, err error)`. VNet IDs are collected during pager iteration and passed to `countVNetGatewayIPs` in `scanSubscription()`.

### 8. Token category mapping matches crosswalk

1. Inspect `scanSubscription()` FindingRow emissions in `scanner.go`
2. **Expected:**
   - DDI Objects: `public_ip`, `route_table`
   - Active IPs: `lb_frontend_ip`, `vnet_gateway_ip`
   - Managed Assets: `nat_gateway`, `azure_firewall`, `private_endpoint`, `vnet_gateway`

### 9. resource_progress events emitted for each new resource type

1. Inspect `scanSubscription()` in `scanner.go`
2. **Expected:** Each new resource block emits `scanner.Event{Type: "resource_progress", Resource: "<type>"}` with Status `complete` on success or `error` on failure. Resource names: `public_ip`, `nat_gateway`, `azure_firewall`, `private_endpoint`, `route_table`, `lb_frontend_ip`, `vnet_gateway`, `vnet_gateway_ip`.

### 10. Full test suite passes without regressions

1. Run `go test ./... -count=1`
2. **Expected:** All packages pass. Only failure is pre-existing `frontend/dist` embed error (not a regression). Specifically: `internal/scanner/azure`, `internal/scanner/aws`, `internal/scanner/gcp`, `internal/scanner/nios`, `internal/scanner/bluecat`, `internal/scanner/efficientip`, `internal/scanner/ad`, `server`, `internal/orchestrator` all pass.

## Edge Cases

### Single-subscription tenant

1. Configure Azure tenant with exactly 1 subscription
2. `scanAllSubscriptions()` creates semaphore and launches 1 goroutine
3. **Expected:** Behaves identically to previous sequential behavior — 1 subscription_progress scanning event, 1 complete event, all resources scanned.

### All subscriptions fail

1. In fan-out, every subscription returns an error
2. **Expected:** All subscriptions emit error events. Result has zero findings. No panic, no deadlock. WaitGroup completes normally.

### MaxWorkers = 1 (sequential)

1. Set `req.MaxWorkers = 1` for 3 subscriptions
2. **Expected:** Semaphore allows only 1 concurrent scan. Subscriptions scanned one at a time (effectively sequential). All subscription_progress events emitted correctly.

### VNet enumeration fails before gateway scan

1. If `countVNetsAndSubnets` returns error, `vnetIDs` is nil/empty
2. **Expected:** `countVNetGatewayIPs` receives empty slice, returns (0, 0, nil). No panic, no API calls made for gateways.

### resourceGroupFromID with malformed IDs

1. Run `go test -run TestResourceGroupFromID`
2. **Expected:** Empty string → empty. No `resourceGroups` segment → empty. ID ending at RG without trailing path → returns RG name.

## Failure Signals

- Any test in `internal/scanner/azure/...` fails → regression in fan-out or resource counting
- `go vet` warnings in azure package → code quality issue
- Missing `subscription_progress` events in scan status → fan-out not emitting events
- Incorrect token category on FindingRow → crosswalk mapping error (will produce wrong token estimates)
- `countLBsAndGateways` caller not handling 4th return value → compilation error
- `countVNetsAndSubnets` caller not handling 3rd return value → compilation error

## Requirements Proved By This UAT

- R048 (expanded Azure resource coverage) — 8 new resource types scanned with correct categories
- R041/R042/R043 (Azure multi-subscription parallel scanning) — fan-out with configurable concurrency, per-subscription progress, fault tolerance

## Not Proven By This UAT

- Live Azure ARM throttle behavior under real parallel load (would require multi-subscription tenant)
- Frontend subscription discovery and selection UI (deferred to S07)
- Azure validate endpoint returning discovered subscriptions as SubscriptionItems (follow-up)
- End-to-end scan from frontend credential entry to results display (requires S07)

## Notes for Tester

- The `frontend/dist` embed failure in `go test ./...` is pre-existing and unrelated to S03. It's caused by missing `frontend/dist` directory (frontend not built). All Go packages test independently.
- VNet gateway scanning uses a per-RG iteration pattern because the Azure SDK has no subscription-wide VNet gateway list API. This is by design, not a limitation.
- The fan-out test uses `scanSubscriptionFunc` package-level var override — this is the intended test seam, not a hack.
