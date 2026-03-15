# S03: Azure Parallel Multi-Subscription + Expanded Resources — Research

**Date:** 2026-03-15

## Summary

This slice converts Azure scanning from sequential per-subscription to parallel fan-out with configurable concurrency, adds auto-discovery of all tenant subscriptions within the scanner (for when validate already discovered them), and adds 7 new resource scanners covering the reference crosswalk's Azure inventory. The S02 AWS org fan-out pattern (`scanOrg`/`scanOneAccount` + `Semaphore`) maps directly — the Azure equivalent is simpler because no credential exchange (AssumeRole) is needed; the same `azcore.TokenCredential` works across all subscriptions in a tenant.

The existing codebase is well-positioned: `listAzureSubscriptions()` in `server/validate.go` already discovers all tenant subscriptions, `scanSubscription()` is already extracted as a single-subscription scan unit, and `armnetwork/v6` already provides clients for all needed resource types. The main work is (1) wrapping the subscription loop in goroutines with `cloudutil.Semaphore`, (2) adding `subscription_progress` events, (3) implementing 7 new count functions, and (4) updating `scanSubscription` to call them.

## Recommendation

Follow the S02 pattern exactly: extract a `scanAllSubscriptions()` method that fans out `scanSubscription()` calls through `cloudutil.Semaphore`. Default concurrency of 5 (matching AWS). Per-subscription failures are non-fatal — publish warning, continue others. Expanded resource scanners use `NewListAllPager`/`NewListBySubscriptionPager` where available. VNet gateways require per-resource-group iteration — extract unique RG names from already-discovered VNet resource IDs rather than adding `armresources` as a new dependency.

No new `go.mod` dependencies needed — `armnetwork/v6` covers all expanded resource types.

## Requirements Targeted

| Requirement | What S03 delivers |
|---|---|
| R041 (multi-subscription parallel) | Parallel fan-out with configurable concurrency, per-subscription progress |
| R042 (Azure auto-discovery) | Scanner uses all subscriptions from validate, subscription_progress events |
| R048 (expanded resources) | 7 new resource types matching cloud-object-counter crosswalk |
| R043 (configurable concurrency) | `MaxWorkers` from S01 controls subscription-level parallelism |

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Concurrency limiting | `cloudutil.NewSemaphore(n)` from S01 | Proven in AWS `scanAllRegions`; context-aware |
| Per-request retry/429 | Azure SDK built-in retry policy | `azcore` pipeline handles 429 + Retry-After natively for each API call |
| Cross-subscription throttle pacing | `cloudutil.Semaphore` as global subscription semaphore | Limits concurrent subscription scans to avoid ARM principal-level throttle bucket exhaustion (250 tokens, 25/sec refill) |
| Subscription discovery | `listAzureSubscriptions()` in `server/validate.go` | Already used by all 5 Azure auth methods; returns `[]SubscriptionItem` |
| Resource group extraction | `resourceGroupFromID()` in scanner.go | Already handles Azure resource ID parsing |

## Existing Code and Patterns

- `internal/scanner/azure/scanner.go` — `scanSubscription()` already extracted as single-subscription unit. Sequential `for _, subID := range subscriptions` loop is the only change point for parallelization.
- `internal/scanner/azure/scanner.go` — `buildCredential()` handles all 5 auth methods with credential caching. Same credential works across all subscriptions (no per-sub credential exchange).
- `internal/scanner/aws/scanner.go` — `scanOrg()` is the template: `Semaphore` + `WaitGroup` + `mu.Lock()` for result aggregation + `account_progress` events. Direct port with `subscription_progress` event type.
- `internal/cloudutil/semaphore.go` — `Acquire(ctx)/Release()` pattern. Already used in AWS `scanAllRegions`.
- `internal/cloudutil/retry.go` — `CallWithBackoff[T]` available but likely not needed at the scanner level since Azure SDK handles per-request retry. Use if we add subscription-level retry on catastrophic failure.
- `server/validate.go:716` — `listAzureSubscriptions()` paginates `armsubscriptions.NewClient.NewListPager()` and returns `[]SubscriptionItem{ID, Name}`. Already called by all Azure auth validators.
- `internal/scanner/azure/scanner.go:466` — `resourceGroupFromID()` extracts RG name from Azure resource ID. Reusable for VNet gateway RG iteration.
- `internal/scanner/provider.go` — `ScanRequest.MaxWorkers` already threaded by S01.
- `frontend/src/imports/cloud-bucket-crosswalk.md` — authoritative Azure resource → token category mapping.

## Expanded Resource Types

Based on the crosswalk and context scope:

| Resource Type | API Client | List Method | Token Category | Item Name |
|---|---|---|---|---|
| Public IPs | `armnetwork.NewPublicIPAddressesClient` | `NewListAllPager` | DDI Objects | `public_ip` |
| NAT Gateways | `armnetwork.NewNatGatewaysClient` | `NewListAllPager` | Managed Assets | `nat_gateway` |
| Azure Firewalls | `armnetwork.NewAzureFirewallsClient` | `NewListAllPager` | Managed Assets | `azure_firewall` |
| Private Endpoints | `armnetwork.NewPrivateEndpointsClient` | `NewListBySubscriptionPager` | Managed Assets | `private_endpoint` |
| Route Tables | `armnetwork.NewRouteTablesClient` | `NewListAllPager` | DDI Objects | `route_table` |
| LB Frontend IPs | (from existing LB response) | Properties.FrontendIPConfigurations | Active IPs | `lb_frontend_ip` |
| VNet Gateway IPs | `armnetwork.NewVirtualNetworkGatewaysClient` | `NewListPager(rgName)` per-RG | Active IPs | `vnet_gateway_ip` |

**LB Frontend IPs** — counted from existing `countLBsAndGateways` response by iterating `lb.Properties.FrontendIPConfigurations`. Refactor to return three values: `(lbs, gateways, lbFrontendIPs)`.

**VNet Gateway IPs** — VNet gateways only have per-RG listing. Strategy: collect unique RG names from VNet resource IDs (already enumerated in `countVNetsAndSubnets`), then list VNet gateways per-RG and count their `Properties.IPConfigurations`. Also count the gateway objects themselves as Managed Assets.

### Category Mapping (from crosswalk)

- **DDI Objects** (25 tokens/unit): VNets, subnets, DNS zones, DNS records, public IPs, route tables
- **Active IPs** (13 tokens/unit): VM NIC IPs, LB frontend IPs, VNet gateway IPs
- **Managed Assets** (3 tokens/unit): LBs, app gateways, NAT gateways, firewalls, private endpoints, VNet gateways

## Constraints

- **Azure SDK built-in retry handles per-request 429** — we do NOT need `CallWithBackoff` for individual API calls. The SDK's retry policy respects `Retry-After` headers automatically.
- **ARM throttle is per-principal, not per-subscription** — a single credential hitting 10 subscriptions in parallel shares one throttle bucket (250 read tokens, refilling at 25/sec). The global `Semaphore` limits concurrent subscriptions to prevent bucket exhaustion.
- **VNet gateways lack subscription-wide ListAll** — must iterate per resource group. Collect RG names from VNet IDs to avoid adding `armresources` dependency.
- **Same credential for all subscriptions** — unlike AWS org scanning (AssumeRole per account), Azure uses one TokenCredential across the entire tenant. Simpler fan-out.
- **CGO_ENABLED=0** — no constraint impact; all Azure SDK packages are pure Go.
- **`scanSubscription` already has error-per-resource isolation** — each resource type publishes its own error event and continues. Parallel subscription scanning adds per-subscription error isolation on top.

## Common Pitfalls

- **Mixing subscription-level and per-request concurrency** — the Semaphore limits *subscription-level* parallelism (how many subscriptions scan simultaneously). Each subscription's internal API calls are sequential. Don't add a second semaphore layer for individual API calls — the SDK handles per-request queuing.
- **VNet gateway RG iteration adding O(N) API calls** — if a subscription has many resource groups, per-RG VNet gateway listing could be slow. Mitigate by only iterating RGs that actually contain VNets (from the VNet response IDs). Most subscriptions have <20 RGs with VNets.
- **Forgetting to pass `displayName` through goroutine** — the `subID` and `displayName` must be captured in the goroutine closure (or passed as params). The S02 `acct := acct` pattern handles this.
- **`countLBsAndGateways` refactor breaking existing tests** — changing the return type from `(lbs, gateways, error)` to `(lbs, gateways, lbFrontendIPs, error)` is a signature change. Existing tests only check compile-time assertions, so the test will need updating.

## Architecture Decisions to Make

1. **VNet gateway enumeration strategy**: Extract RG names from VNet IDs (no new deps) vs. add `armresources` for RG listing (cleaner but adds dependency). **Recommendation:** Extract from VNet IDs — data is already available, no new dep.

2. **Parallel scan trigger**: Always parallel when >1 subscription, or only when explicitly requested? **Recommendation:** Always parallel (matching AWS behavior) — Semaphore default of 5 provides safe concurrency.

3. **scanSubscription signature**: Add `resourceGroups []string` parameter for VNet gateway iteration, or have it discover internally? **Recommendation:** Internal discovery within a new VNet gateway count function that accepts the VNet findings slice and extracts RGs. Keeps `scanSubscription` signature stable.

## Open Risks

- **ARM throttle bucket exhaustion with 5 concurrent subscriptions** — each subscription scan hits ~10 API calls. At 5 concurrent subs × 10 calls = 50 calls in burst. At 25 tokens/sec refill, this should be fine for typical scans but could be tight for tenants with many resource groups (VNet gateway RG iteration). The Semaphore default of 5 is conservative.
- **VNet gateway per-RG iteration adds latency** — for subscriptions with many RGs, this adds sequential API calls. Acceptable because VNet gateways are rare and the per-RG call is fast (<100ms typically).
- **Azure SDK retry may mask throttle issues** — the SDK silently retries 429s. If concurrency is too high, scans slow down without visible errors. The `subscription_progress` events will show completion times, making this diagnosable.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| Azure SDK for Go | none relevant | none found (SDK is well-documented; existing codebase patterns sufficient) |
| Go cloud scanning | none relevant | none found |

## Task Decomposition Sketch

**T01: Multi-subscription parallel fan-out + subscription_progress events**
- Refactor `Scan()` to call `scanAllSubscriptions()` for parallel execution
- Add `subscription_progress` events matching AWS `account_progress` pattern
- Per-subscription failure tolerance (non-fatal, warning event)
- Default 5 concurrent subscriptions, configurable via `MaxWorkers`

**T02: Expanded resource scanners (7 new types)**
- `countPublicIPs` — `PublicIPAddressesClient.NewListAllPager`
- `countNATGateways` — `NatGatewaysClient.NewListAllPager`
- `countAzureFirewalls` — `AzureFirewallsClient.NewListAllPager`
- `countPrivateEndpoints` — `PrivateEndpointsClient.NewListBySubscriptionPager`
- `countRouteTables` — `RouteTablesClient.NewListAllPager`
- Refactor `countLBsAndGateways` → also return LB frontend IP count
- `countVNetGatewayIPs` — per-RG iteration using RG names from VNet IDs
- Wire all into `scanSubscription()` with FindingRow emission + progress events
- Update tests

## Sources

- Azure SDK armnetwork/v6 source at `/home/sr/go/pkg/mod/github.com/!azure/azure-sdk-for-go/sdk/resourcemanager/network/armnetwork/v6@v6.2.0/` — confirmed API availability for all resource types
- `frontend/src/imports/cloud-bucket-crosswalk.md` — authoritative category mapping from cloud-object-counter reference
- S02 summary — established fan-out + Semaphore + progress event patterns
- Azure ARM throttle limits — 250 tokens per principal, 25/sec refill (from M004 context)
