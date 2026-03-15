# S04: GCP Multi-Project Org Discovery + Expanded Resources — Research

**Date:** 2026-03-15

## Summary

S04 extends the GCP scanner with two capabilities: (1) org-level project discovery using the Cloud Resource Manager v3 API (`SearchProjects` + `ListFolders`) so a single org-level service account scan discovers all projects automatically, and (2) expanded resource counting (compute addresses, firewalls, cloud routers, VPN gateways/tunnels, secondary subnets, GKE cluster CIDRs) matching the cloud-object-counter crosswalk.

The existing GCP scanner (`internal/scanner/gcp/scanner.go`) is single-project — it reads `Subscriptions[0]` for the project ID and runs all resource scans sequentially against that one project. The multi-project fan-out needs the same architecture as AWS `scanOrg` and Azure `scanAllSubscriptions`: semaphore-bounded goroutines, per-project progress events, non-fatal per-project errors, and `mu.Lock` aggregation of findings.

A key design question is whether to use the `cloud.google.com/go/resourcemanager/apiv3` Go client library (which provides typed `FoldersClient.ListFolders` and `ProjectsClient.SearchProjects`) or the REST API v1 approach already used in `validate.go`. The client library is the better choice: it provides automatic pagination, typed responses, built-in retry, and aligns with the Compute/DNS client pattern already used. The REST v1 API approach in `validate.go` was a shortcut for simple project listing — org discovery needs recursive folder traversal which is cleaner with the typed SDK.

## Recommendation

**Two-layer approach**: Add `cloud.google.com/go/resourcemanager` and `cloud.google.com/go/container` as new dependencies. Create `projects.go` for `DiscoverProjects()` (matching `aws/org.go` pattern) and `compute_expanded.go` for new resource counters. Modify `scanner.go` to detect org mode via `Subscriptions` length and fan out like AWS/Azure.

**Multi-project fan-out**: When `len(req.Subscriptions) > 1`, use `scanAllProjects()` with `cloudutil.Semaphore` (default 5, overridable by `MaxWorkers`). When single project, use existing direct path. This avoids needing an `org_enabled` flag — the validate endpoint already returns all discoverable projects as `SubscriptionItems`.

**Org discovery in validate**: Add a `realGCPOrgValidator` function dispatched when `authMethod == "org"`. It uses `SearchProjects(query: "parent:organizations/{orgID}")` plus recursive `ListFolders` to discover all ACTIVE projects under the org. Returns them as `SubscriptionItems`. Requires `resourcemanager.projects.search` + `resourcemanager.folders.list` permissions (covered by `roles/browser` at org level).

**Expanded resources**: Add 6 new resource count functions following the existing `countNetworks` / `countSubnets` pattern — each creates a REST client, does an AggregatedList (or List for global resources), iterates, and returns count. GKE cluster CIDRs use the Container API `ListClusters` and extract `ClusterIpv4Cidr` + `ServicesIpv4Cidr` + secondary ranges.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| GCP project discovery with org/folder traversal | `cloud.google.com/go/resourcemanager/apiv3` `ProjectsClient.SearchProjects` + `FoldersClient.ListFolders` | Auto-paginates, typed responses, retry built-in, avoids manual REST + JSON parsing |
| GKE cluster CIDR enumeration | `cloud.google.com/go/container/apiv1` `ClusterManagerClient.ListClusters` | Typed `Cluster` struct with `ClusterIpv4Cidr`, `ServicesIpv4Cidr`, `IPAllocationPolicy.ClusterSecondaryRangeName` |
| Multi-project fan-out concurrency | `cloudutil.NewSemaphore(maxWorkers)` from S01 | Already proven in AWS scanOrg and Azure scanAllSubscriptions |
| Per-API-call throttle resilience | `cloudutil.CallWithBackoff` from S01 | RetryableError interface works with `googleapi.Error` for 429/5xx classification |
| Compute addresses, firewalls, routers, VPN gateways/tunnels | `cloud.google.com/go/compute/apiv1` — `AddressesRESTClient`, `FirewallsRESTClient`, `RoutersRESTClient`, `VpnTunnelsRESTClient`, `TargetVpnGatewaysRESTClient` (or HA: `VpnGatewaysRESTClient`) | Already a dependency, consistent pattern with existing countNetworks/countSubnets |

## Existing Code and Patterns

- `internal/scanner/gcp/scanner.go` — Single-project `Scan()` method. Will be split: existing logic → `scanOneProject()`, new `scanAllProjects()` wraps fan-out. `buildTokenSource()` already handles all 4 auth methods and returns a shared `oauth2.TokenSource`.
- `internal/scanner/gcp/compute.go` — `countNetworks`, `countSubnets`, `countInstances`, `countInstanceIPs` follow identical patterns: create REST client → AggregatedList/List → iterate → count. New expanded functions follow this exactly.
- `internal/scanner/gcp/dns.go` — `countDNS` uses discovery-based DNS v1 service. No changes needed here.
- `internal/scanner/aws/org.go` — `DiscoverAccounts` pattern to replicate: `discoverProjectsWithClient()` as testable core with interface for mocking.
- `internal/scanner/aws/scanner.go` — `scanOrg()` fan-out pattern: semaphore + WaitGroup + mu.Lock aggregation + per-entity progress events. GCP should follow this exactly.
- `internal/scanner/azure/scanner.go` — `scanAllSubscriptions()` pattern: near-identical to AWS but with subscription display name resolution upfront. GCP will need project name resolution (available from `SearchProjects` response).
- `internal/cloudutil/retry.go` — `CallWithBackoff[T]` with `RetryableError` interface. GCP's `googleapi.Error` can implement this — create an `isGCPRetryable()` helper that checks for 429/500/502/503/504.
- `internal/cloudutil/semaphore.go` — `NewSemaphore(workers)` for bounded concurrency.
- `server/validate.go` — `realGCPValidator()` dispatches by authMethod. Add `"org"` case that calls `realGCPOrgValidator()` using Resource Manager SDK.
- `server/validate.go` — `storeCredentials` GCP case stores `ProjectID` as single string. For multi-project, the project list flows through `Subscriptions` (same as AWS/Azure) — `ProjectID` in session becomes the default/fallback.
- `internal/session/session.go` — `GCPCredentials` needs `OrgID` field for org discovery mode.

## Constraints

- **CGO_ENABLED=0** — both `cloud.google.com/go/resourcemanager` and `cloud.google.com/go/container` are pure Go; no cgo issue.
- **Two new go.mod dependencies required** — `cloud.google.com/go/resourcemanager` (latest v1.10.x) and `cloud.google.com/go/container` (latest v1.46.x). These pull in `google.golang.org/genproto` which is already an indirect dependency.
- **GCP Resource Manager rate limits** — `projects.search`: 4 req/sec, `folders.list`: 4 req/sec. For large orgs (1000+ folders), recursive folder traversal must be paced. `CallWithBackoff` with `isGCPRetryable` handles 429s.
- **Compute API quotas** — Each new resource type adds one aggregated API call per project. With 6 new resource types + existing 6 = 12 API calls per project. At 5 concurrent projects, that's 60 concurrent requests — well within default quota (20 req/sec per project for compute).
- **GKE CIDR counting** — The roadmap says "GKE cluster CIDR ranges" but the scope explicitly excludes "K8s probing". Listing clusters via `container.ListClusters` only requires `container.clusters.list` permission — it reads cluster metadata, not pod/service resources. This is analogous to counting EC2 instances, not inspecting their applications. Each cluster contributes 2 CIDR ranges (pod + service) to DDI Objects.
- **Secondary subnets** — `SubnetworkSecondaryRange` is available on the `computepb.Subnetwork` object during `AggregatedList`. Can be counted alongside primary subnets in the existing `countSubnets` function or as a separate item.
- **Token source sharing** — All projects in an org scan share the same `oauth2.TokenSource` (org-level SA). This is safe — `oauth2.TokenSource` is goroutine-safe and auto-refreshes.
- **Existing validate REST v1 approach** — The 3 existing validators (`realGCPADCValidator`, `realGCPBrowserOAuth`, `realGCPWorkloadIdentity`) use REST v1 `GET /v1/projects?filter=lifecycleState:ACTIVE` for project listing. These already return all accessible projects — org mode needs the Resource Manager v3 `SearchProjects` for scoped org/folder discovery. The old validators can remain as-is for non-org auth methods.

## Common Pitfalls

- **Resource Manager v3 vs v1 confusion** — The REST API at `cloudresourcemanager.googleapis.com/v1/projects` lists *all* projects the SA has access to (flat, no org scoping). The v3 `SearchProjects` with `parent:organizations/{orgID}` correctly scopes to the org hierarchy. Use v3 for org discovery.
- **Recursive folder traversal without depth limit** — GCP org hierarchies can be deeply nested. While GCP recommends max 10 levels, a pathological org could cause stack overflow. Use iterative traversal with a folder queue (BFS), not recursion.
- **Project lifecycle state filtering** — `SearchProjects` returns all projects including DELETING/DELETE_REQUESTED. Must filter to `ACTIVE` only (matching existing validator behavior).
- **HA VPN vs Classic VPN** — Two different VPN gateway resources: `VpnGatewaysRESTClient` (HA VPN) and `TargetVpnGatewaysRESTClient` (Classic VPN). Must count both or pick the more common one. HA VPN is the modern standard — count via `VpnGatewaysRESTClient.AggregatedList`.
- **GKE permission not always granted** — `container.clusters.list` requires `container.viewer` role. Not all service accounts have this. Must handle 403 gracefully (return 0 with warning, not scan failure).
- **Empty org ID** — If the user provides ADC or service-account auth without an org ID, the validate endpoint should not try org discovery — fall back to the existing project list behavior.

## Open Risks

- **Resource Manager API enablement** — The Cloud Resource Manager API must be enabled in the project where the SA lives. If disabled, `SearchProjects` returns a 403 "API not enabled" error. Must handle gracefully with a clear error message.
- **Org-level permission gap** — `roles/browser` at org level grants `resourcemanager.projects.search` + `resourcemanager.folders.list` but not `container.clusters.list` (separate role). Some SAs may discover projects but fail GKE enumeration. Per-resource error handling (already in `runResourceScan`) covers this.
- **Large org discovery time** — An org with 1000+ projects and deep folder nesting could take 30-60 seconds just for discovery. The validate endpoint should set a reasonable timeout (60s?). For the scan itself, this is amortized across the concurrent project scans.
- **New dependency size** — `cloud.google.com/go/resourcemanager` and `cloud.google.com/go/container` add transitive gRPC dependencies. Need to verify binary size impact doesn't break any deployment constraints.

## GCP Expanded Resource Category Mapping

Based on the cloud-object-counter crosswalk and AWS/Azure precedents:

| Resource | GCP API | Category | Tokens/Unit | Rationale |
|----------|---------|----------|-------------|-----------|
| Compute Addresses | `compute.AddressesRESTClient.AggregatedList` | DDI Objects | 25 | IP address objects (like AWS Elastic IPs) |
| Firewalls | `compute.FirewallsRESTClient.List` | DDI Objects | 25 | Network rules (like AWS Security Groups) |
| Cloud Routers | `compute.RoutersRESTClient.AggregatedList` | Managed Assets | 3 | Infrastructure devices (like AWS Transit Gateways) |
| VPN Gateways (HA) | `compute.VpnGatewaysRESTClient.AggregatedList` | Managed Assets | 3 | Gateway devices (like AWS VPN Gateways) |
| VPN Tunnels | `compute.VpnTunnelsRESTClient.AggregatedList` | Managed Assets | 3 | Connection objects |
| GKE Cluster CIDRs | `container.ClusterManagerClient.ListClusters` | DDI Objects | 25 | IP ranges (pod CIDR + service CIDR per cluster) |
| Secondary Subnet Ranges | `compute.SubnetworksRESTClient.AggregatedList` (extend existing) | DDI Objects | 25 | Additional IP ranges on subnets |

**Note:** Secondary subnet ranges can be counted in the existing `countSubnets` function by also iterating `SecondaryIpRanges` on each `Subnetwork`. This avoids a separate API call. Expose as a new FindingRow item `secondary_subnet_range`.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| GCP Go client libraries | `googlecloudplatform/devrel-demos@go-architect` | available (30 installs, not installed — too general for this specific task) |
| Go testing | None directly relevant | none found |

## Sources

- GCP Resource Manager v3 Go client: `SearchProjects` with `parent:organizations/{orgID}` for scoped org discovery; `ListFolders` for recursive folder traversal (source: Google Cloud Go SDK docs via google_search)
- Compute REST client patterns: `AddressesRESTClient.AggregatedList`, `FirewallsRESTClient.List`, `RoutersRESTClient.AggregatedList`, `VpnTunnelsRESTClient.AggregatedList` (source: cloud.google.com/go/compute/apiv1 package docs via google_search)
- GKE cluster CIDR fields: `Cluster.ClusterIpv4Cidr` and `Cluster.ServicesIpv4Cidr` from `container/apiv1` (source: GKE networking docs via google_search)
- VPN tunnel secondary ranges: `localTrafficSelector` field includes both primary and secondary subnet CIDRs (source: Google Cloud VPN docs via google_search)
- Existing codebase patterns: AWS `scanOrg`, Azure `scanAllSubscriptions` — direct code inspection
