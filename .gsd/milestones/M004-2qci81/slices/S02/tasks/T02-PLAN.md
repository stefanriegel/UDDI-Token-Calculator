---
estimated_steps: 3
estimated_files: 3
---

# T02: Expanded EC2 resource scanners (9 types) wired into scanRegion

**Slice:** S02 — AWS Multi-Account Org Scanning + Expanded Resources
**Milestone:** M004-2qci81

## Description

Add 9 new EC2 resource scan functions following the exact paginator pattern established by `scanVPCs`, `scanSubnets`, `scanInstanceCount`. Each is a straightforward `func scanX(ctx, cfg) (int, error)` that creates a paginator, iterates pages, counts items. Wire each into `scanRegion()` via `runResourceScan()` with the correct category and tokens-per-unit from the research resource type mapping.

Special handling: `scanIPAMPools` must gracefully return 0 when IPAM isn't enabled (the API may error). `scanVPCCIDRBlocks` counts `CidrBlockAssociationSet` entries per VPC (not VPC count — that's already covered by `scanVPCs`). `scanNATGateways` should count only available/non-deleted gateways.

## Steps

1. Add 9 scan functions to `ec2.go`:
   - `scanElasticIPs` — `DescribeAddresses`, count `len(page.Addresses)`. No paginator (single-call API with `Filters`), use `DescribeAddresses` directly.
   - `scanNATGateways` — `NewDescribeNatGatewaysPaginator`, count `len(page.NatGateways)`. Filter: exclude `deleted` state.
   - `scanTransitGateways` — `NewDescribeTransitGatewaysPaginator`, count `len(page.TransitGateways)`.
   - `scanInternetGateways` — `NewDescribeInternetGatewaysPaginator`, count `len(page.InternetGateways)`.
   - `scanRouteTables` — `NewDescribeRouteTablesPaginator`, count `len(page.RouteTables)`.
   - `scanSecurityGroups` — `NewDescribeSecurityGroupsPaginator`, count `len(page.SecurityGroups)`.
   - `scanVPNGateways` — `DescribeVpnGateways` (no paginator, single call), count `len(out.VpnGateways)`. Filter: exclude `deleted` state.
   - `scanIPAMPools` — `NewDescribeIpamPoolsPaginator`, count `len(page.IpamPools)`. Wrap error check: if error message contains "IPAM" or "not enabled", return 0, nil.
   - `scanVPCCIDRBlocks` — reuse `NewDescribeVpcsPaginator`, sum `len(vpc.CidrBlockAssociationSet)` per VPC.

2. Wire all 9 into `scanRegion()` in `regions.go` using `runResourceScan()`:
   - `elastic_ip` → DDI Objects (25)
   - `nat_gateway` → Managed Assets (3)
   - `transit_gateway` → Managed Assets (3)
   - `internet_gateway` → DDI Objects (25)
   - `route_table` → DDI Objects (25)
   - `security_group` → DDI Objects (25)
   - `vpn_gateway` → Managed Assets (3)
   - `ipam_pool` → DDI Objects (25)
   - `vpc_cidr_block` → DDI Objects (25)

3. Write `ec2_expanded_test.go` — table-driven test that verifies each new scan function is correctly wired: correct item name string, correct category constant, correct tokens-per-unit value. Use a mock EC2 client or verify the `runResourceScan` output shape directly.

## Must-Haves

- [ ] All 9 EC2 resource scan functions implemented with correct paginator/API pattern
- [ ] Each function wired into `scanRegion()` via `runResourceScan()` with correct category and tokens-per-unit
- [ ] `scanIPAMPools` returns 0 gracefully when IPAM not available
- [ ] `scanNATGateways` and `scanVPNGateways` exclude deleted resources
- [ ] `scanVPCCIDRBlocks` counts CIDR associations (not VPC count)
- [ ] Tests verify item names and category assignments

## Verification

- `go test ./internal/scanner/aws/... -v -count=1 -run Expanded` — new tests pass
- `go test ./internal/scanner/aws/... -v -count=1` — all existing tests still pass
- `go vet ./internal/scanner/aws/...` — clean

## Inputs

- `internal/scanner/aws/ec2.go` — existing scan functions as pattern template
- `internal/scanner/aws/regions.go` — existing `scanRegion()` and `runResourceScan()`
- `internal/calculator/calculator.go` — `CategoryDDIObjects`, `CategoryManagedAssets`, token constants
- S02 Research — resource type mapping table with categories and tokens-per-unit

## Expected Output

- `internal/scanner/aws/ec2.go` — 9 new scan functions added
- `internal/scanner/aws/regions.go` — `scanRegion()` extended with 9 new `runResourceScan` calls
- `internal/scanner/aws/ec2_expanded_test.go` — test file verifying expanded resource scanners

## Observability Impact

Each new resource type emits a `resource_progress` event via `runResourceScan()` with `Type: "resource_progress"`, `Resource: "<item_name>"`, `Status: "done"|"error"`, and `DurMS`. A future agent can:

- **Inspect scan coverage**: grep SSE stream for `resource_progress` events — should see 14 distinct `Resource` values per region (5 original + 9 new).
- **Debug specific resource failures**: filter events where `Status == "error"` — the `Message` field contains the AWS API error.
- **Verify IPAM handling**: if `ipam_pool` emits `Status: "done"` with `Count: 0`, IPAM is either not enabled or has no pools. If it emits `Status: "error"`, the error was non-IPAM-related (credentials, permissions, etc.).
- **Check deleted-resource filtering**: `nat_gateway` and `vpn_gateway` should never count resources in deleted state — verify by comparing against raw `DescribeNatGateways`/`DescribeVpnGateways` output in the AWS console.
