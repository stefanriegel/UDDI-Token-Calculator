---
id: T02
parent: S04
milestone: M004-2qci81
provides:
  - 7 new GCP resource counting functions (addresses, firewalls, routers, VPN gateways, VPN tunnels, GKE cluster CIDRs, secondary subnet ranges)
  - isGKEPermissionDenied helper for graceful 403 handling on gRPC-based Container API
key_files:
  - internal/scanner/gcp/compute_expanded.go
  - internal/scanner/gcp/gke.go
  - internal/scanner/gcp/compute_expanded_test.go
  - internal/scanner/gcp/gke_test.go
key_decisions:
  - countFirewalls uses List (not AggregatedList) because GCP firewalls are global resources
  - GKE permission check uses gRPC status codes (codes.PermissionDenied) not googleapi.Error since Container API is gRPC-based
  - countGKEClusterCIDRs counts only non-empty CIDRs (guards against clusters mid-provisioning with empty CIDR fields)
  - countSecondarySubnetRanges implemented as separate function (not extension of countSubnets) to keep concerns isolated
patterns_established:
  - isGKEPermissionDenied helper pattern for gRPC PermissionDenied detection (parallel to wrapGCPError for REST APIs)
  - Compute expanded counters follow identical create-client/defer-close/iterate/wrapGCPError pattern from compute.go
observability_surfaces:
  - GKE 403 warning logged via log.Printf with project ID — grep "GKE permission denied" for affected projects
  - All errors flow through wrapGCPError for consistent tagged error messages
duration: 15m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T02: Expanded GCP resource counters

**Added 7 new GCP resource counting functions: 5 compute (addresses, firewalls, routers, VPN gateways, VPN tunnels), GKE cluster CIDRs with graceful 403 handling, and secondary subnet ranges.**

## What Happened

Added `cloud.google.com/go/container/apiv1` dependency for GKE cluster listing. Created `compute_expanded.go` with 5 functions following the established `countNetworks`/`countSubnets` pattern: `countAddresses`, `countFirewalls`, `countRouters`, `countVPNGateways`, `countVPNTunnels`. All use `wrapGCPError` and `ReturnPartialSuccess: true`. `countFirewalls` uses `List` (global resource) while the others use `AggregatedList`.

Created `gke.go` with `countGKEClusterCIDRs` and `countSecondarySubnetRanges`. The GKE function uses the Container API's gRPC `ClusterManagerClient.ListClusters` with `parent: "projects/{id}/locations/-"`. It counts 2 CIDRs per cluster (pod + service), only counting non-empty values. Permission denied (gRPC `codes.PermissionDenied`) returns `(0, nil)` with a warning log — not a scan failure. `countSecondarySubnetRanges` reuses the subnet `AggregatedList` pattern but sums `len(SecondaryIpRanges)` per subnet.

## Verification

- `go get cloud.google.com/go/container/apiv1 && go mod tidy` — ✅ succeeded
- `go build ./internal/scanner/gcp/...` — ✅ compiles clean
- `go test ./internal/scanner/gcp/... -v -count=1` — ✅ all 34 tests pass (8 new + 26 existing)
- `go vet ./internal/scanner/gcp/...` — ✅ no issues
- `go test ./internal/cloudutil/... -v -count=1` — ✅ all 13 tests pass
- `go test ./... -count=1` — ⚠️ root package embed failure (pre-existing, no frontend/dist); all other packages pass
- `cd frontend && npx tsc --noEmit` — ⚠️ pre-existing TS errors in calendar/chart/resizable UI components (not related to this task)

## Diagnostics

- `grep "countAddresses\|countFirewalls\|countRouters\|countVPNGateways\|countVPNTunnels" internal/scanner/gcp/compute_expanded.go` — find compute counter implementations
- `grep "countGKEClusterCIDRs\|countSecondarySubnetRanges" internal/scanner/gcp/gke.go` — find GKE/subnet counter implementations
- `grep "GKE permission denied" <logs>` — find projects where GKE API access is denied
- `grep "isGKEPermissionDenied" internal/scanner/gcp/gke.go` — find permission check logic

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `internal/scanner/gcp/compute_expanded.go` — new: 5 compute resource count functions (addresses, firewalls, routers, VPN gateways, VPN tunnels)
- `internal/scanner/gcp/compute_expanded_test.go` — new: compile-time signature assertions for all 5 functions
- `internal/scanner/gcp/gke.go` — new: countGKEClusterCIDRs + countSecondarySubnetRanges + isGKEPermissionDenied helper
- `internal/scanner/gcp/gke_test.go` — new: compile-time signature assertions + isGKEPermissionDenied nil test
- `go.mod` — modified: added cloud.google.com/go/container v1.46.0 dependency
- `go.sum` — modified: updated by go mod tidy
- `.gsd/milestones/M004-2qci81/slices/S04/tasks/T02-PLAN.md` — modified: added Observability Impact section
