---
estimated_steps: 4
estimated_files: 6
---

# T02: Expanded GCP resource counters

**Slice:** S04 — GCP Multi-Project Org Discovery + Expanded Resources
**Milestone:** M004-2qci81

## Description

Add 7 new resource counting functions following the existing `countNetworks`/`countSubnets` pattern. Five use Compute REST clients (addresses, firewalls, routers, VPN gateways, VPN tunnels), one uses the Container API (GKE cluster CIDRs), and one extends the existing subnet scan (secondary ranges). These will be wired into `scanOneProject` in T03.

## Steps

1. Run `go get cloud.google.com/go/container/apiv1` to add the Container dependency. Run `go mod tidy`.
2. Create `internal/scanner/gcp/compute_expanded.go` with 5 functions:
   - `countAddresses(ctx, opts, projectID) (int, error)` — `AddressesRESTClient.AggregatedList`, count all addresses
   - `countFirewalls(ctx, opts, projectID) (int, error)` — `FirewallsRESTClient.List` (firewalls are global, not regional)
   - `countRouters(ctx, opts, projectID) (int, error)` — `RoutersRESTClient.AggregatedList`
   - `countVPNGateways(ctx, opts, projectID) (int, error)` — `VpnGatewaysRESTClient.AggregatedList` (HA VPN)
   - `countVPNTunnels(ctx, opts, projectID) (int, error)` — `VpnTunnelsRESTClient.AggregatedList`
   All follow the identical pattern: create REST client → defer Close → List/AggregatedList with `ReturnPartialSuccess: true` → iterate counting items → `wrapGCPError` on errors.
3. Create `internal/scanner/gcp/gke.go`:
   - `countGKEClusterCIDRs(ctx, opts, projectID) (int, error)` — Create `ClusterManagerClient` via container apiv1. Call `ListClusters` with `parent: "projects/{projectID}/locations/-"` (all locations). For each cluster, count 2 CIDRs (ClusterIpv4Cidr + ServicesIpv4Cidr). Handle 403 gracefully: if error is `googleapi.Error` with code 403 or error message contains "PERMISSION_DENIED", return `(0, nil)` — log a warning via stderr but don't fail.
   - `countSecondarySubnetRanges(ctx, opts, projectID) (int, error)` — `SubnetworksRESTClient.AggregatedList` (same pattern as existing `countSubnets`), but count `len(subnet.SecondaryIpRanges)` instead of counting subnets.
4. Create test files:
   - `internal/scanner/gcp/compute_expanded_test.go`: compile-time signature assertions for all 5 compute functions (matching existing `TestCountNetworks_Stub` pattern). Test `countFirewalls` signature specifically since it uses List (not AggregatedList).
   - `internal/scanner/gcp/gke_test.go`: compile-time signature assertion for `countGKEClusterCIDRs` and `countSecondarySubnetRanges`. Test that the GKE function signature accepts `option.ClientOption` variadic.

## Must-Haves

- [ ] `countAddresses` uses AggregatedList with ReturnPartialSuccess
- [ ] `countFirewalls` uses global List (firewalls are not regional)
- [ ] `countRouters`, `countVPNGateways`, `countVPNTunnels` use AggregatedList
- [ ] `countGKEClusterCIDRs` counts 2 CIDRs per cluster (pod + service)
- [ ] GKE 403 returns (0, nil) not scan failure
- [ ] `countSecondarySubnetRanges` counts SecondaryIpRanges across all subnets
- [ ] All functions use `wrapGCPError` for error wrapping

## Verification

- `go get cloud.google.com/go/container/apiv1 && go mod tidy` succeeds
- `go build ./internal/scanner/gcp/...` — compiles clean
- `go test ./internal/scanner/gcp/... -v -count=1` — all existing + new tests pass
- `go vet ./internal/scanner/gcp/...` — no vet issues

## Inputs

- `internal/scanner/gcp/compute.go` — existing `countNetworks`, `countSubnets` patterns to replicate
- `internal/scanner/gcp/scanner.go` — `wrapGCPError`, `runResourceScan` (consumed in T03)
- `cloud.google.com/go/compute/apiv1` — already a dependency; new client types needed
- `cloud.google.com/go/container/apiv1` — new dependency for GKE

## Expected Output

- `internal/scanner/gcp/compute_expanded.go` — 5 new compute resource count functions
- `internal/scanner/gcp/compute_expanded_test.go` — compile-time assertions + basic tests
- `internal/scanner/gcp/gke.go` — `countGKEClusterCIDRs` + `countSecondarySubnetRanges`
- `internal/scanner/gcp/gke_test.go` — compile-time assertions + GKE 403 handling test
- `go.mod` / `go.sum` — updated with `cloud.google.com/go/container` dependency

## Observability Impact

- **GKE 403 warning log**: `log.Printf("gcp: GKE permission denied for project %s — skipping cluster CIDRs", projectID)` emitted when GKE Container API returns PermissionDenied. Surfaces in stderr; a future agent can `grep "GKE permission denied"` to find projects missing `container.clusters.list` IAM permission.
- **Error wrapping**: All 7 functions use `wrapGCPError` which tags errors with `GCP permission denied`, `GCP resource not found`, or `GCP API error {code}` — same pattern as existing counters. These surface through `runResourceScan` as `resource_progress` events with status `error` (wired in T03).
- **Diagnostic grep targets**: `grep "countAddresses\|countFirewalls\|countRouters\|countVPNGateways\|countVPNTunnels\|countGKEClusterCIDRs\|countSecondarySubnetRanges" internal/scanner/gcp/` finds all counter implementations.
- **Failure visibility**: `isGKEPermissionDenied` distinguishes gRPC PermissionDenied from other errors — only permission errors are soft-failed; all other errors propagate through `wrapGCPError`.
