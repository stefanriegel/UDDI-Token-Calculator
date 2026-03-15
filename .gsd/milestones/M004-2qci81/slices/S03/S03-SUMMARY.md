---
id: S03
parent: M004-2qci81
milestone: M004-2qci81
provides:
  - scanAllSubscriptions parallel fan-out with cloudutil.Semaphore (default 5, configurable via MaxWorkers)
  - subscription_progress event emissions (scanning/complete/error) per subscription
  - Non-fatal per-subscription error handling — failures warn, other subscriptions continue
  - 5 new standalone count functions (countPublicIPs, countNATGateways, countAzureFirewalls, countPrivateEndpoints, countRouteTables)
  - countLBsAndGateways refactored to return LB frontend IP count as additional return value
  - countVNetGatewayIPs with per-RG iteration using VNet resource IDs (no armresources dependency)
  - countVNetsAndSubnets extended to return VNet resource IDs for gateway enumeration
  - 8 new FindingRow resource types wired into scanSubscription with correct token categories
requires:
  - slice: S01
    provides: cloudutil.Semaphore, cloudutil.NewSemaphore(), ScanRequest.MaxWorkers
affects:
  - S07
key_files:
  - internal/scanner/azure/scanner.go
  - internal/scanner/azure/scanner_test.go
key_decisions:
  - "scanSubscriptionFunc package-level var for test seam — allows swapping scanSubscription in tests without interface indirection"
  - "Display name resolution stays in scanAllSubscriptions (shared map before goroutine launch) — avoids per-goroutine API calls"
  - "countVNetsAndSubnets extended to return vnetIDs slice — threading VNet IDs through scanSubscription local state to countVNetGatewayIPs"
  - "VNet gateway objects counted as Managed Assets AND their IPConfigurations counted as Active IPs — two separate FindingRow items from one API iteration"
  - "Per-RG iteration pattern for VNet gateways: extract RG names from already-enumerated VNet resource IDs via resourceGroupFromID"
patterns_established:
  - "Azure multi-subscription fan-out mirrors AWS scanOrg pattern: Semaphore + WaitGroup + mu.Lock aggregation"
  - "Simple count functions (countPublicIPs, countNATGateways, etc.) follow identical pattern: NewClient → NewListAllPager → count page.Value"
  - "Per-RG iteration for resources without subscription-wide list: extract RG names from existing resource IDs, iterate per-RG pager"
observability_surfaces:
  - "scanner.Event{Type: 'subscription_progress'} with Status scanning/complete/error per subscription"
  - "resource_progress events for 8 new resource types (public_ip, nat_gateway, azure_firewall, private_endpoint, route_table, lb_frontend_ip, vnet_gateway, vnet_gateway_ip)"
  - "Error events include subscription ID + display name + wrapped error for debugging"
drill_down_paths:
  - .gsd/milestones/M004-2qci81/slices/S03/tasks/T01-SUMMARY.md
  - .gsd/milestones/M004-2qci81/slices/S03/tasks/T02-SUMMARY.md
duration: 27m
verification_result: passed
completed_at: 2026-03-15
---

# S03: Azure Parallel Multi-Subscription + Expanded Resources

**Azure scanning fans out across all tenant subscriptions concurrently with configurable parallelism and covers 8 additional resource types matching the cloud-object-counter crosswalk.**

## What Happened

**T01** converted the sequential Azure subscription loop into a parallel fan-out using `cloudutil.Semaphore`. Extracted `scanAllSubscriptions()` from `Scan()`, following the AWS `scanOrg()` pattern from S02. The function resolves subscription display names upfront, launches one goroutine per subscription with semaphore-bounded concurrency (default 5, overridden by `req.MaxWorkers`), aggregates findings under `mu.Lock()`, and emits `subscription_progress` events per subscription. Per-subscription failures are non-fatal — error event published, other subscriptions continue. A `scanSubscriptionFunc` package-level variable provides the test seam for fan-out verification.

**T02** added 5 new standalone count functions (`countPublicIPs`, `countNATGateways`, `countAzureFirewalls`, `countPrivateEndpoints`, `countRouteTables`) using subscription-wide ARM pagers. Refactored `countLBsAndGateways` to additionally return LB frontend IP count by iterating `FrontendIPConfigurations`. Added `countVNetGatewayIPs` which extracts unique RG names from VNet resource IDs via `resourceGroupFromID` and iterates per-RG `NewListPager`, counting both gateway objects (Managed Assets) and their IP configurations (Active IPs). Extended `countVNetsAndSubnets` to also return VNet resource IDs. All 8 new resource types wired into `scanSubscription` with correct token category mapping: DDI Objects (public_ip, route_table), Active IPs (lb_frontend_ip, vnet_gateway_ip), Managed Assets (nat_gateway, azure_firewall, private_endpoint, vnet_gateway).

## Verification

- `go test ./internal/scanner/azure/... -v -count=1` — **4 tests pass**: TestResourceGroupFromID (5 cases), TestCountNICIPs_Logic (4 cases), TestScanAllSubscriptions_FanOut (fan-out + progress events + fault tolerance), TestExtractResourceGroupsFromVNetIDs (5 cases)
- `go vet ./internal/scanner/azure/...` — clean
- `go test ./... -count=1` — all packages pass (only pre-existing `frontend/dist` embed failure)
- Compile-time signature assertions verify all new/changed function signatures

## Requirements Advanced

- AWS-RES-01 analogue for Azure — 8 new Azure resource types scanned with correct token categories (no separate requirement ID yet, tracked under milestone R048)

## Requirements Validated

- None newly validated (Azure multi-subscription scanning backend complete but full end-to-end validation requires S07 frontend)

## New Requirements Surfaced

- AZ-RES-01 — Azure scanner counts 14+ resource types (6 original + 8 expanded) with correct token categories. Original: VNets, subnets, VMs, load balancers, app gateways, NIC IPs. Expanded: public IPs, NAT gateways, Azure firewalls, private endpoints, route tables, LB frontend IPs, VNet gateways, VNet gateway IPs.

## Requirements Invalidated or Re-scoped

- None

## Deviations

- `countVNetsAndSubnets` signature changed from `(vnets, subnets int, err error)` to `(vnets, subnets int, vnetIDs []string, err error)` — plan mentioned this as an option; chose to extend existing function since VNet IDs are naturally available during enumeration.

## Known Limitations

- Azure multi-subscription scanning is backend-only — frontend subscription discovery UI deferred to S07
- No live Azure API integration test — all verification is contract/unit level with mocked interfaces
- ARM per-principal throttle bucket (250 tokens, 25/sec refill) not explicitly tested under load — S01 retry infrastructure handles it, but real-world validation requires live multi-subscription tenant

## Follow-ups

- S07 needs Azure subscription discovery wired to frontend — `DiscoverSubscriptions` already exists, validate endpoint needs to return discovered subscriptions as `SubscriptionItems`
- Consider adding validate endpoint update for Azure to return discovered subscriptions (similar to AWS org validate in S02)

## Files Created/Modified

- `internal/scanner/azure/scanner.go` — `scanAllSubscriptions()` with parallel fan-out, 5 new count functions, refactored `countLBsAndGateways` (4 returns), `countVNetGatewayIPs` per-RG iterator, `countVNetsAndSubnets` extended
- `internal/scanner/azure/scanner_test.go` — `TestScanAllSubscriptions_FanOut`, `TestExtractResourceGroupsFromVNetIDs`, updated compile-time signature assertions

## Forward Intelligence

### What the next slice should know
- Azure fan-out pattern is identical to AWS `scanOrg()` — Semaphore + WaitGroup + mu.Lock. GCP S04 should follow the same pattern for consistency.
- The `scanSubscriptionFunc` test seam pattern works well for testing fan-out without mocking all Azure SDK clients — GCP should use the same approach.

### What's fragile
- `countVNetGatewayIPs` depends on VNet resource IDs from `countVNetsAndSubnets` — if VNet enumeration fails, gateway IPs are silently skipped (counted as 0). This is intentional but worth noting.
- `countLBsAndGateways` now returns 4 values — callers must handle all returns correctly.

### Authoritative diagnostics
- `subscription_progress` events in scan status polling — shows per-subscription scanning/complete/error state
- `resource_progress` events filterable by `Resource` field — one event per resource type per subscription
- Test output from `TestScanAllSubscriptions_FanOut` — confirms 3-subscription fan-out with sub-2 failure tolerance

### What assumptions changed
- Plan assumed 7 new resource types — actual count is 8 because VNet gateways produce both a gateway object count (Managed Assets) and an IP configuration count (Active IPs), making them two separate FindingRow items from one API iteration.
