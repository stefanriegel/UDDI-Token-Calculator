# S04: GCP Multi-Project Org Discovery + Expanded Resources

**Goal:** GCP scanner discovers all projects in an org via Resource Manager folder traversal and scans them in parallel with expanded resource coverage (addresses, firewalls, routers, VPN gateways/tunnels, GKE cluster CIDRs, secondary subnet ranges).
**Demo:** A scan request with `len(Subscriptions) > 1` fans out per-project using semaphore-bounded goroutines, aggregates findings, and includes 7 new resource types alongside the original 6.

## Must-Haves

- `DiscoverProjects(ctx, cred, orgID)` discovers all ACTIVE projects under a GCP org using Resource Manager v3 `SearchProjects` + recursive `ListFolders`
- `isGCPRetryable(err)` classifies `googleapi.Error` 429/500/502/503/504 for `CallWithBackoff` integration
- 7 new resource count functions: compute addresses, firewalls, cloud routers, VPN gateways (HA), VPN tunnels, GKE cluster CIDRs, secondary subnet ranges
- `scanOneProject()` extracted from existing `Scan()` — single-project scan unit reusable by fan-out
- `scanAllProjects()` implements semaphore-bounded goroutine fan-out with per-project progress events and non-fatal per-project errors
- `Scan()` dispatches to `scanAllProjects()` when `len(req.Subscriptions) > 1`, otherwise `scanOneProject()`
- `session.GCPCredentials.OrgID` field for org discovery mode
- Orchestrator threads `OrgID` credential to scanner
- Validate endpoint adds `"org"` auth method dispatching to `realGCPOrgValidator()` using Resource Manager SDK
- Per-project errors are non-fatal — warning published, other projects continue
- GKE 403 handled gracefully (0 count with warning, not scan failure)
- All new code has tests

## Proof Level

- This slice proves: integration (multi-project fan-out architecture + expanded resource counting)
- Real runtime required: no (mock-based unit tests; real GCP APIs verified in prod)
- Human/UAT required: no

## Verification

- `go test ./internal/scanner/gcp/... -v -count=1` — all tests pass including new discovery, expanded resource, and fan-out tests
- `go test ./internal/cloudutil/... -v -count=1` — retry tests still pass with new `isGCPRetryable` helper
- `go test ./... -count=1` — full suite passes, no regressions
- `cd frontend && npx tsc --noEmit` — no new type errors

## Observability / Diagnostics

- Runtime signals: `project_progress` events (scanning/done/error per project), `resource_progress` events per resource type per project, retry events via `CallWithBackoff.OnRetry`
- Inspection surfaces: scan status endpoint shows per-project progress; resource_progress events include duration
- Failure visibility: per-project errors include project ID + error message; GKE permission denial logged as warning with 0 count
- Redaction constraints: service account JSON never logged; only project IDs in progress events

## Integration Closure

- Upstream surfaces consumed: `internal/cloudutil/retry.go` (CallWithBackoff, RetryableError), `internal/cloudutil/semaphore.go` (Semaphore), `internal/session/session.go` (GCPCredentials), `internal/orchestrator/orchestrator.go` (buildScanRequest), `server/validate.go` (realGCPValidator)
- New wiring introduced in this slice: `realGCPOrgValidator` validate case, `OrgID` session→orchestrator→scanner threading, `scanAllProjects` fan-out in scanner, two new go.mod dependencies (`cloud.google.com/go/resourcemanager`, `cloud.google.com/go/container`)
- What remains before the milestone is truly usable end-to-end: S05 (checkpoint/resume), S06 (DNS record type breakdown), S07 (frontend UI for GCP org credential form)

## Tasks

- [x] **T01: GCP project discovery + retryable error classification** `est:45m`
  - Why: Core org discovery capability — `DiscoverProjects()` is the entry point for multi-project scanning and `isGCPRetryable` is needed by all GCP API calls to integrate with CallWithBackoff
  - Files: `internal/scanner/gcp/projects.go`, `internal/scanner/gcp/projects_test.go`, `internal/scanner/gcp/retryable.go`, `internal/scanner/gcp/retryable_test.go`
  - Do: Add `cloud.google.com/go/resourcemanager` dependency. Implement `DiscoverProjects(ctx, cred, orgID)` using `SearchProjects(parent:organizations/{orgID})` + BFS `ListFolders` for recursive folder traversal. Filter to ACTIVE projects only. Use `CallWithBackoff` for each API call. Create `isGCPRetryable(err)` that checks `googleapi.Error` for 429/500/502/503/504. Define `resourceManagerAPI` interface for testability (same pattern as AWS `organizationsAPI`). Handle pagination via iterator.
  - Verify: `go test ./internal/scanner/gcp/... -v -count=1 -run TestDiscover` passes; `go test ./internal/scanner/gcp/... -v -count=1 -run TestIsGCP` passes
  - Done when: `DiscoverProjects` returns correct projects from mock, filters non-ACTIVE, handles pagination, handles API errors; `isGCPRetryable` correctly classifies 429/5xx as retryable and 4xx as non-retryable

- [x] **T02: Expanded GCP resource counters** `est:40m`
  - Why: Token calculation accuracy requires counting 7 additional resource types matching the cloud-object-counter crosswalk
  - Files: `internal/scanner/gcp/compute_expanded.go`, `internal/scanner/gcp/compute_expanded_test.go`, `internal/scanner/gcp/gke.go`, `internal/scanner/gcp/gke_test.go`
  - Do: Add `cloud.google.com/go/container` dependency. Implement `countAddresses`, `countFirewalls`, `countRouters`, `countVPNGateways`, `countVPNTunnels` (all using compute REST clients with AggregatedList/List + `wrapGCPError`). Implement `countGKEClusterCIDRs` using container `ClusterManagerClient.ListClusters` — count 2 CIDRs per cluster (pod + service). Extend `countSubnets` to also return secondary range count (or add `countSecondarySubnetRanges` as separate function). Handle 403 on GKE gracefully (return 0, nil with log).
  - Verify: `go test ./internal/scanner/gcp/... -v -count=1 -run TestCount` passes; compile-time signature assertions for all new functions
  - Done when: All 7 new count functions exist with correct signatures, compile-time assertions pass, GKE 403 handling tested

- [x] **T03: Multi-project fan-out + orchestrator/validate wiring** `est:50m`
  - Why: Wires discovery + expanded resources into the scanner and connects the full pipeline (validate → session → orchestrator → scanner)
  - Files: `internal/scanner/gcp/scanner.go`, `internal/scanner/gcp/scanner_test.go`, `internal/session/session.go`, `internal/orchestrator/orchestrator.go`, `server/validate.go`
  - Do: Extract `scanOneProject()` from existing `Scan()` body, adding all 7 new resource scans. Add `scanAllProjects()` with semaphore fan-out (pattern: AWS `scanOrg`, Azure `scanAllSubscriptions`). Update `Scan()` to dispatch based on `len(req.Subscriptions) > 1`. Add `OrgID` to `session.GCPCredentials`. Thread `OrgID` through orchestrator `buildScanRequest`. Add `"org"` case to `realGCPValidator` dispatching to `realGCPOrgValidator()` that calls `DiscoverProjects` and returns projects as `SubscriptionItems`. Add `auth_method=org` handling in `buildTokenSource`. Add `maxConcurrentProjects` const (default 5). Wire project display names into progress events.
  - Verify: `go test ./internal/scanner/gcp/... -v -count=1` all pass; `go test ./... -count=1` full suite passes; `cd frontend && npx tsc --noEmit` no new errors
  - Done when: `scanOneProject` produces findings for all 13 resource types; `scanAllProjects` fans out with semaphore and aggregates findings; validate `"org"` case returns discovered projects; orchestrator threads OrgID; full test suite green

## Files Likely Touched

- `internal/scanner/gcp/projects.go` — new: DiscoverProjects + resourceManagerAPI interface
- `internal/scanner/gcp/projects_test.go` — new: mock-based discovery tests
- `internal/scanner/gcp/retryable.go` — new: isGCPRetryable helper
- `internal/scanner/gcp/retryable_test.go` — new: retryable classification tests
- `internal/scanner/gcp/compute_expanded.go` — new: 5 expanded compute count functions
- `internal/scanner/gcp/compute_expanded_test.go` — new: signature + unit tests
- `internal/scanner/gcp/gke.go` — new: countGKEClusterCIDRs
- `internal/scanner/gcp/gke_test.go` — new: GKE counter tests
- `internal/scanner/gcp/scanner.go` — modified: scanOneProject extraction, scanAllProjects fan-out, Scan dispatch
- `internal/scanner/gcp/scanner_test.go` — modified: add fan-out and dispatch tests
- `internal/session/session.go` — modified: add OrgID to GCPCredentials
- `internal/orchestrator/orchestrator.go` — modified: thread OrgID in buildScanRequest
- `server/validate.go` — modified: add org case to realGCPValidator, implement realGCPOrgValidator
- `go.mod` — modified: add resourcemanager + container dependencies
- `go.sum` — modified: updated by go mod tidy
