---
id: T02
parent: S02
milestone: M004-2qci81
provides:
  - 9 new EC2 resource scanners (elastic IPs, NAT gateways, transit gateways, internet gateways, route tables, security groups, VPN gateways, IPAM pools, VPC CIDR blocks)
  - All 9 wired into scanRegion() with correct category and tokens-per-unit
key_files:
  - internal/scanner/aws/ec2.go
  - internal/scanner/aws/regions.go
  - internal/scanner/aws/ec2_expanded_test.go
key_decisions:
  - NAT gateways and VPN gateways use API-level filters (state != deleted) rather than client-side filtering — reduces data transfer and is idiomatic for AWS APIs
  - scanIPAMPools catches errors containing "IPAM", "not enabled", or "InvalidParameterValue" to gracefully return 0 — covers AWS accounts without IPAM enabled
  - Elastic IPs and VPN gateways use single-call APIs (no paginator exists for these) while other 7 use standard paginators
  - scanVPCCIDRBlocks reuses the VPC paginator but counts CidrBlockAssociationSet entries per VPC (distinct from scanVPCs which counts VPCs)
patterns_established:
  - Same func scanX(ctx, cfg) (int, error) pattern for all resource types — wire into scanRegion via runResourceScan with category + tokens-per-unit
observability_surfaces:
  - resource_progress events emitted per new resource type with item name, count, status, and duration — 14 total resource types per region now
duration: 15min
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T02: Expanded EC2 resource scanners (9 types) wired into scanRegion

**Added 9 EC2 resource scan functions using paginator/single-call patterns, wired into scanRegion with correct DDI Objects / Managed Assets categories and tokens-per-unit values.**

## What Happened

Implemented 9 scan functions in `ec2.go` following the established `func scanX(ctx, cfg) (int, error)` pattern:

- **Paginated** (7): `scanNATGateways`, `scanTransitGateways`, `scanInternetGateways`, `scanRouteTables`, `scanSecurityGroups`, `scanIPAMPools`, `scanVPCCIDRBlocks`
- **Single-call** (2): `scanElasticIPs` (DescribeAddresses), `scanVPNGateways` (DescribeVpnGateways)

Special handling:
- NAT gateways: state filter excludes "deleted" via API-level `Filter`
- VPN gateways: state filter excludes "deleted" via `Filters` parameter
- IPAM pools: error strings checked for "IPAM"/"not enabled"/"InvalidParameterValue" → returns (0, nil)
- VPC CIDR blocks: iterates VPCs and sums `len(vpc.CidrBlockAssociationSet)`

Wired all 9 into `scanRegion()` with correct categories:
- DDI Objects (25): elastic_ip, internet_gateway, route_table, security_group, ipam_pool, vpc_cidr_block
- Managed Assets (3): nat_gateway, transit_gateway, vpn_gateway

## Verification

- `go test ./internal/scanner/aws/... -v -count=1 -run Expanded` — 3/3 new tests pass (Wiring, IPAMGraceful, NewItemNames)
- `go test ./internal/scanner/aws/... -v -count=1` — 13/13 all tests pass (3 new + 10 existing)
- `go vet ./internal/scanner/aws/...` — clean
- `go test ./server/... -v -count=1` — all pass (slice-level)
- `go test ./internal/orchestrator/... -v -count=1` — all pass (slice-level)
- `go vet ./internal/scanner/aws/... ./server/... ./internal/session/... ./internal/orchestrator/...` — clean

## Diagnostics

- Grep SSE stream for `resource_progress` events — should see 14 distinct `Resource` values per region (was 5, now 14)
- Filter `resource_progress` events where `Status == "error"` to see per-resource API failures with error message in `Message` field
- `ipam_pool` with `Status: "done"` and `Count: 0` means IPAM not enabled (graceful); `Status: "error"` means non-IPAM failure
- `nat_gateway` and `vpn_gateway` counts should never include deleted resources — API-level filters prevent this

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `internal/scanner/aws/ec2.go` — Added 9 scan functions + `strings` import for IPAM error handling
- `internal/scanner/aws/regions.go` — Extended `scanRegion()` with 9 new `runResourceScan` calls
- `internal/scanner/aws/ec2_expanded_test.go` — New test file: wiring verification, IPAM graceful handling, item name uniqueness
- `.gsd/milestones/M004-2qci81/slices/S02/tasks/T02-PLAN.md` — Added Observability Impact section
