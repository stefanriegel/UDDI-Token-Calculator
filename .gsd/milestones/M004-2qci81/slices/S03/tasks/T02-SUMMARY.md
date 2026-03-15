---
id: T02
parent: S03
milestone: M004-2qci81
provides:
  - 5 new standalone count functions (publicIPs, NATGateways, azureFirewalls, privateEndpoints, routeTables)
  - countLBsAndGateways refactored to return LB frontend IP count as third return value
  - countVNetGatewayIPs with per-RG iteration using VNet IDs (no armresources dependency)
  - countVNetsAndSubnets extended to collect VNet resource IDs for gateway enumeration
  - All 8 new resource types wired into scanSubscription with resource_progress events and FindingRow emissions
key_files:
  - internal/scanner/azure/scanner.go
  - internal/scanner/azure/scanner_test.go
key_decisions:
  - "countVNetsAndSubnets extended to return vnetIDs slice — threading VNet IDs to countVNetGatewayIPs through scanSubscription local state rather than a separate parameter"
  - "LB frontend IPs grouped under same error block as LBs/app gateways — single countLBsAndGateways call, three FindingRow emissions on success"
  - "VNet gateway objects counted as Managed Assets AND their IPConfigurations counted as Active IPs — two separate FindingRow items from one API iteration"
patterns_established:
  - "Simple count functions (countPublicIPs, countNATGateways, etc.) follow identical pattern: NewClient → NewListAllPager → count page.Value — consistent with existing countVMIPs style"
  - "Per-RG iteration pattern for resources without subscription-wide list: extract RG names from already-enumerated resource IDs via resourceGroupFromID, iterate per-RG pager"
observability_surfaces:
  - "resource_progress events for 8 new resource types (public_ip, nat_gateway, azure_firewall, private_endpoint, route_table, lb_frontend_ip, vnet_gateway, vnet_gateway_ip) — visible in scan status polling"
  - "Error events per resource type include resource name in Resource field — grep Type:error + Resource:<name> for per-type failure diagnosis"
duration: 12 minutes
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T02: 7 expanded resource scanners wired into scanSubscription

**Added 7 new Azure resource count functions and wired all 8 new resource types into scanSubscription with correct token categories, resource_progress events, and FindingRow emissions.**

## What Happened

Implemented 5 new standalone count functions using armnetwork clients with subscription-wide pagers: `countPublicIPs`, `countNATGateways`, `countAzureFirewalls`, `countPrivateEndpoints`, `countRouteTables`. Each follows the established pattern from `countVMIPs` — create client, iterate pager, count `page.Value`.

Refactored `countLBsAndGateways` from `(lbs, gateways int, err error)` to `(lbs, gateways, lbFrontendIPs int, err error)`. The LB pager loop now iterates each `lb.Properties.FrontendIPConfigurations` to count frontend IPs.

Added `countVNetGatewayIPs(ctx, cred, subID, vnetResourceIDs)` that extracts unique RG names from VNet resource IDs via `resourceGroupFromID`, then iterates `NewListPager(rgName)` per RG, counting gateway objects (Managed Assets) and their `IPConfigurations` (Active IPs).

Extended `countVNetsAndSubnets` to also return `[]string` of VNet resource IDs — these feed into `countVNetGatewayIPs` through `scanSubscription` local state.

Wired all new counts into `scanSubscription` with error events on failure, resource_progress events + FindingRow on success. Category mapping matches the crosswalk exactly.

Updated test compile-time signature assertions for all new/changed functions and added `TestExtractResourceGroupsFromVNetIDs` with 5 cases.

## Verification

- `go vet ./internal/scanner/azure/...` — clean
- `go test ./internal/scanner/azure/... -v -count=1` — 4 tests pass (TestResourceGroupFromID, TestCountNICIPs_Logic, TestScanAllSubscriptions_FanOut, TestExtractResourceGroupsFromVNetIDs)
- `go test ./... -count=1` — all packages pass (only pre-existing `frontend/dist` embed failure)
- Confirmed 8 new FindingRow item names: `public_ip`, `nat_gateway`, `azure_firewall`, `private_endpoint`, `route_table`, `lb_frontend_ip`, `vnet_gateway`, `vnet_gateway_ip`
- Confirmed category mapping: DDI Objects (public_ip, route_table), Active IPs (lb_frontend_ip, vnet_gateway_ip), Managed Assets (nat_gateway, azure_firewall, private_endpoint, vnet_gateway)

## Diagnostics

- Grep `resource_progress` events by `Resource` field to verify per-resource-type scan completion
- Grep `Type: "error"` events by `Resource` field to identify which resource types failed during a scan
- LB frontend IPs, VNet gateways, and VNet gateway IPs are all derived from existing API calls (LBs and VNets) — if those parent calls fail, dependent counts are skipped under the same error block
- VNet gateway enumeration iterates only RGs containing VNets — `TestExtractResourceGroupsFromVNetIDs` covers deduplication and malformed-ID handling

## Deviations

- `countVNetsAndSubnets` signature changed from `(vnets, subnets int, err error)` to `(vnets, subnets int, vnetIDs []string, err error)` — plan mentioned this as an option ("refactored countVNetsAndSubnets that also collects VNet resource IDs — or pass them through scanSubscription state"). Chose to extend the existing function since VNet IDs are naturally available during enumeration.

## Known Issues

None.

## Files Created/Modified

- `internal/scanner/azure/scanner.go` — 5 new count functions, refactored `countLBsAndGateways` (4 returns), `countVNetGatewayIPs` per-RG iterator, `countVNetsAndSubnets` extended to return VNet IDs, `scanSubscription` wired with all 8 new resource blocks
- `internal/scanner/azure/scanner_test.go` — updated compile-time assertions for all new/changed signatures, added `TestExtractResourceGroupsFromVNetIDs`
- `.gsd/milestones/M004-2qci81/slices/S03/tasks/T02-PLAN.md` — added Observability Impact section
