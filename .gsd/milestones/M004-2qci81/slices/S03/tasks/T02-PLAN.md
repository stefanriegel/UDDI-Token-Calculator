---
estimated_steps: 5
estimated_files: 2
---

# T02: 7 expanded resource scanners wired into scanSubscription

**Slice:** S03 — Azure Parallel Multi-Subscription + Expanded Resources
**Milestone:** M004-2qci81

## Description

Add 7 new resource count functions covering the Azure inventory from the cloud-object-counter crosswalk: public IPs, NAT gateways, Azure firewalls, private endpoints, route tables, LB frontend IPs (refactored from existing `countLBsAndGateways`), and VNet gateway IPs (per-RG iteration using RG names from VNet resource IDs). Wire all into `scanSubscription()` with correct token categories and `resource_progress` events.

## Steps

1. Add 5 new count functions in `scanner.go`:
   - `countPublicIPs(ctx, cred, subID)` → `armnetwork.NewPublicIPAddressesClient` + `NewListAllPager`
   - `countNATGateways(ctx, cred, subID)` → `armnetwork.NewNatGatewaysClient` + `NewListAllPager`
   - `countAzureFirewalls(ctx, cred, subID)` → `armnetwork.NewAzureFirewallsClient` + `NewListAllPager`
   - `countPrivateEndpoints(ctx, cred, subID)` → `armnetwork.NewPrivateEndpointsClient` + `NewListBySubscriptionPager`
   - `countRouteTables(ctx, cred, subID)` → `armnetwork.NewRouteTablesClient` + `NewListAllPager`

2. Refactor `countLBsAndGateways` signature → `(lbs, gateways, lbFrontendIPs int, err error)`. In the LB pager loop, iterate `lb.Properties.FrontendIPConfigurations` to count frontend IPs. Update all call sites (in `scanSubscription`).

3. Add `countVNetGatewayIPs(ctx, cred, subID, vnetResourceIDs []string)` that: extracts unique RG names from the VNet resource IDs via `resourceGroupFromID`, creates `armnetwork.NewVirtualNetworkGatewaysClient`, calls `NewListPager(rgName)` per RG, counts gateway objects (Managed Assets) and their `IPConfigurations` entries (Active IPs). Returns `(gateways, gatewayIPs int, err error)`. The `vnetResourceIDs` parameter comes from a refactored `countVNetsAndSubnets` that also collects VNet resource IDs — or pass them through `scanSubscription` state.

4. Wire all new counts into `scanSubscription()` following the established pattern: each block has error event on failure, resource_progress + FindingRow on success. Category mapping:
   - DDI Objects (25 tokens): `public_ip`, `route_table`
   - Active IPs (13 tokens): `lb_frontend_ip`, `vnet_gateway_ip`
   - Managed Assets (3 tokens): `nat_gateway`, `azure_firewall`, `private_endpoint`, `vnet_gateway`

5. Update `scanner_test.go`: add compile-time signature assertions for all new functions. Add `TestExtractResourceGroupsFromVNetIDs` testing the RG extraction helper (or inline logic). Run `go test ./internal/scanner/azure/... -v -count=1` and `go test ./... -count=1`.

## Must-Haves

- [ ] 5 new standalone count functions using `armnetwork` clients with pagers
- [ ] `countLBsAndGateways` returns LB frontend IP count as third return value
- [ ] `countVNetGatewayIPs` iterates per-RG using RG names from VNet IDs — no `armresources` dependency
- [ ] All 7 new resource types emit `resource_progress` events and `FindingRow` with correct token categories
- [ ] Existing `countLBsAndGateways` call site updated for new signature
- [ ] All tests pass including new signature assertions

## Verification

- `go test ./internal/scanner/azure/... -v -count=1` — all pass
- `go test ./... -count=1` — all packages pass
- `go vet ./internal/scanner/azure/...` — clean
- Confirm 7 new item names in `FindingRow` emissions: `public_ip`, `nat_gateway`, `azure_firewall`, `private_endpoint`, `route_table`, `lb_frontend_ip`, `vnet_gateway_ip` (+ `vnet_gateway` as managed asset)

## Observability Impact

- **New `resource_progress` events:** 8 new resource types emit `resource_progress` events (public_ip, nat_gateway, azure_firewall, private_endpoint, route_table, lb_frontend_ip, vnet_gateway, vnet_gateway_ip). A future agent can grep for these in scan status polling responses to verify expanded resource coverage.
- **Error isolation per resource type:** Each new scanner block publishes an `error` event with the resource name on failure. Grep `Type: "error"` + `Resource: "<name>"` in events to diagnose which resource type failed.
- **FindingRow emissions:** 8 new item names in FindingRow output. Verify presence by checking `calculator.FindingRow.Item` values in scan results.
- **Failure state visibility:** If a resource count function fails, only that resource type is skipped — other resources and other subscriptions continue. The error event includes the wrapped error message for diagnosis.

## Inputs

- `internal/scanner/azure/scanner.go` — after T01 refactor with parallel `scanAllSubscriptions`
- `frontend/src/imports/cloud-bucket-crosswalk.md` — authoritative category mapping
- S03-RESEARCH.md — resource type table with API clients, list methods, and category assignments

## Expected Output

- `internal/scanner/azure/scanner.go` — 7 new count functions, refactored `countLBsAndGateways`, updated `scanSubscription()` with all new resource blocks
- `internal/scanner/azure/scanner_test.go` — compile-time assertions for new functions, VNet gateway RG extraction test
