---
id: S04
parent: M004-2qci81
milestone: M004-2qci81
provides:
  - DiscoverProjects with BFS folder traversal for org-wide GCP project discovery via Resource Manager v3
  - isGCPRetryable + WrapGCPRetryable for googleapi.Error integration with CallWithBackoff
  - 7 expanded resource counters (addresses, firewalls, routers, VPN gateways, VPN tunnels, GKE cluster CIDRs, secondary subnet ranges)
  - scanOneProject extraction with 13 resource types (6 original + 7 new)
  - scanAllProjects semaphore-bounded fan-out for multi-project org scanning
  - realGCPOrgValidator dispatching org-mode credential validation
  - OrgID session→orchestrator→scanner credential threading
  - buildTokenSource auth_method=org support
requires:
  - slice: S01
    provides: CallWithBackoff retry wrapper, Semaphore concurrency limiter, MaxWorkers/RequestTimeout configurable scan parameters
affects:
  - S07
key_files:
  - internal/scanner/gcp/projects.go
  - internal/scanner/gcp/retryable.go
  - internal/scanner/gcp/compute_expanded.go
  - internal/scanner/gcp/gke.go
  - internal/scanner/gcp/scanner.go
  - internal/session/session.go
  - internal/orchestrator/orchestrator.go
  - server/validate.go
key_decisions:
  - GCP org discovery uses Resource Manager v3 SearchProjects scoped by parent (not unscoped v1 REST) for correct org isolation
  - BFS folder traversal prevents stack overflow on deeply nested orgs; deleted/inactive folders skipped
  - resourceManagerAPI interface defined at slice-return level (SearchProjects returns []*Project, ListFolders returns []*Folder) — real implementation handles iterators internally, keeping mocks simple
  - GKE permission check uses gRPC status codes (codes.PermissionDenied) not googleapi.Error since Container API is gRPC-based
  - countFirewalls uses List (not AggregatedList) because GCP firewalls are global resources
  - countGKEClusterCIDRs counts only non-empty CIDRs — guards against clusters mid-provisioning
  - countSecondarySubnetRanges is a separate function (not merged into countSubnets) — keeps existing countSubnets unchanged
  - scanOneProject receives both TokenSource and ClientOption — countDNS requires raw TokenSource by its existing signature
  - scanAllProjects returns (findings, nil) on per-project failures — non-fatal, matching AWS/Azure pattern
  - GCP multi-project dispatch uses len(Subscriptions) > 1 (not org_enabled flag) — validate endpoint already returns discovered projects as SubscriptionItems
  - HA VPN gateways only (VpnGatewaysRESTClient) — Classic VPN is legacy
patterns_established:
  - resourceManagerAPI interface pattern for GCP Resource Manager mocking (parallel to AWS organizationsAPI)
  - gcpRetryableError wrapper for integrating googleapi.Error with cloudutil.RetryableError/RetryAfterError
  - isGKEPermissionDenied helper for gRPC PermissionDenied detection (parallel to wrapGCPError for REST APIs)
  - project_progress event pattern for GCP multi-project fan-out (parallel to AWS account_progress and Azure subscription_progress)
observability_surfaces:
  - project_progress events with Status scanning/complete/error per project during fan-out
  - resource_progress events include project-specific Source field for per-project attribution
  - CallWithBackoff wrapping on SearchProjects and ListFolders — retry events emitted when GCP throttles
  - GKE 403 warning logged via log.Printf with project ID — grep "GKE permission denied"
  - Error messages include org/folder resource paths for log traceability
drill_down_paths:
  - .gsd/milestones/M004-2qci81/slices/S04/tasks/T01-SUMMARY.md
  - .gsd/milestones/M004-2qci81/slices/S04/tasks/T02-SUMMARY.md
  - .gsd/milestones/M004-2qci81/slices/S04/tasks/T03-SUMMARY.md
duration: 50m
verification_result: passed
completed_at: 2026-03-15
---

# S04: GCP Multi-Project Org Discovery + Expanded Resources

**GCP scanner discovers all org projects via Resource Manager v3 BFS folder traversal and scans them in parallel with 13 resource types (6 original + 7 new), wired through validate→session→orchestrator→scanner credential pipeline.**

## What Happened

T01 added `isGCPRetryable` error classifier for googleapi.Error 429/500/502/503/504, `WrapGCPRetryable` wrapper satisfying both `cloudutil.RetryableError` and `RetryAfterError`, and `DiscoverProjects` using Resource Manager v3 `SearchProjects` + BFS `ListFolders` for recursive org hierarchy traversal. Projects are filtered to ACTIVE state and deduplicated by ID. All API calls wrapped in `CallWithBackoff`. The `resourceManagerAPI` interface abstracts SDK iterators at the return-value level for clean testability.

T02 added 7 new resource counting functions: 5 compute (addresses, firewalls, routers, VPN gateways, VPN tunnels) following the established `wrapGCPError`/`AggregatedList` pattern, plus GKE cluster CIDRs via Container API gRPC client and secondary subnet ranges. GKE 403 is gracefully handled (returns 0, nil with warning log) since not all service accounts have `container.viewer` role.

T03 wired everything into the scanner pipeline. Extracted `scanOneProject()` from `Scan()` with all 13 resource types. Implemented `scanAllProjects()` with semaphore-bounded goroutine fan-out (maxConcurrentProjects=5) with per-project progress events and non-fatal per-project errors. Added `OrgID` to `session.GCPCredentials`, threaded through orchestrator `buildScanRequest`, added `realGCPOrgValidator` in validate.go that calls `DiscoverProjects` and returns projects as `SubscriptionItems`, and added `auth_method=org` support in `buildTokenSource`.

## Verification

- `go test ./internal/scanner/gcp/... -v -count=1` — 29 tests pass (discovery, retryable, expanded resources, fan-out, dispatch)
- `go test ./internal/cloudutil/... -v -count=1` — 13 tests pass (retry/semaphore infrastructure)
- `go test ./... -count=1` — all packages pass (GCP, AWS, Azure, NIOS, Bluecat, EfficientIP, orchestrator, session, server, cloudutil, calculator, exporter, broker). Root embed error is pre-existing (no `frontend/dist`)
- `cd frontend && npx tsc --noEmit` — pre-existing TS errors in shadcn calendar/chart/resizable only; no new errors
- `go vet ./internal/... ./server/...` — clean

## Requirements Advanced

- GCP-ORG-01 — GCP scanner now discovers all org projects via Resource Manager and scans them in parallel (backend complete, frontend form pending S07)
- GCP-RES-01 — GCP scanner counts 13 resource types (6 original + 7 expanded) with correct token categories

## Requirements Validated

- none — new GCP org/resource requirements are advanced, not yet validated (need frontend form in S07 for full end-to-end)

## New Requirements Surfaced

- GCP-ORG-01: User can authenticate with org-level SA and discover all org projects via Resource Manager folder traversal for parallel scanning (backend complete M004-2qci81/S04, frontend form pending S07)
- GCP-RES-01: GCP scanner counts 13 resource types (6 original + 7 expanded: addresses, firewalls, cloud routers, VPN gateways, VPN tunnels, GKE cluster CIDRs, secondary subnet ranges) with correct DDI Objects/Managed Assets categories

## Requirements Invalidated or Re-scoped

- none

## Deviations

- `scanOneProject` takes both `oauth2.TokenSource` and `[]option.ClientOption` instead of just opts — `countDNS` requires a raw TokenSource by its existing signature. Minor API shape difference from plan, avoids modifying `countDNS` which would be a larger change.

## Known Limitations

- Frontend GCP org credential form not yet built (S07)
- No real GCP org API integration tests — mock-based unit tests only (real APIs verified in prod)
- GKE cluster counting requires `container.viewer` role — degrades gracefully but org SA may not have it by default

## Follow-ups

- S07 needs to add GCP org ID field to credential form and wire project discovery results into subscription selection UI
- S05 checkpoint/resume will need to integrate with GCP multi-project fan-out (same pattern as AWS/Azure)

## Files Created/Modified

- `internal/scanner/gcp/retryable.go` — new: `isGCPRetryable`, `gcpRetryableError`, `WrapGCPRetryable`
- `internal/scanner/gcp/retryable_test.go` — new: 9 tests for retryable classification and wrapping
- `internal/scanner/gcp/projects.go` — new: `ProjectInfo`, `resourceManagerAPI`, `DiscoverProjects`, `discoverProjectsWithClient` with BFS folder traversal
- `internal/scanner/gcp/projects_test.go` — new: 8 tests for discovery (happy path, nested folders, filtering, dedup, empty org, errors)
- `internal/scanner/gcp/compute_expanded.go` — new: 5 compute resource count functions (addresses, firewalls, routers, VPN gateways, VPN tunnels)
- `internal/scanner/gcp/compute_expanded_test.go` — new: compile-time signature assertions
- `internal/scanner/gcp/gke.go` — new: `countGKEClusterCIDRs`, `countSecondarySubnetRanges`, `isGKEPermissionDenied`
- `internal/scanner/gcp/gke_test.go` — new: compile-time signature assertions, GKE permission denied test
- `internal/scanner/gcp/scanner.go` — modified: `scanOneProject` extraction (13 resource types), `scanAllProjects` fan-out, `Scan()` dispatch, `auth_method=org` in `buildTokenSource`
- `internal/scanner/gcp/scanner_test.go` — modified: fan-out/dispatch tests, `TestBuildTokenSource_OrgMethod`
- `internal/session/session.go` — modified: `OrgID string` added to `GCPCredentials`
- `internal/orchestrator/orchestrator.go` — modified: `org_id` threaded in GCP `buildScanRequest`
- `server/validate.go` — modified: `realGCPOrgValidator`, `"org"` case dispatch, `OrgID` in `storeCredentials`
- `go.mod` — modified: added `cloud.google.com/go/resourcemanager`, `cloud.google.com/go/container`
- `go.sum` — modified: updated by `go mod tidy`

## Forward Intelligence

### What the next slice should know
- GCP multi-project fan-out follows the same semaphore + non-fatal-error pattern as AWS (`scanOrg`) and Azure (`scanAllSubscriptions`) — S05 checkpoint integration should use the same per-project completion callback pattern for all three providers
- `project_progress` events follow the same schema as `account_progress` (AWS) and `subscription_progress` (Azure) — S07 frontend can use a single progress component for all three

### What's fragile
- `countDNS` requires a raw `oauth2.TokenSource` (not `option.ClientOption`) — if DNS counting is refactored, `scanOneProject`'s dual-argument pattern needs updating
- GKE 403 handling relies on gRPC `codes.PermissionDenied` — if Google changes the Container API error surface, `isGKEPermissionDenied` may need updating

### Authoritative diagnostics
- `go test ./internal/scanner/gcp/... -v -count=1` — covers discovery, retryable, expanded resources, fan-out, dispatch (29 tests)
- `grep "project_progress" internal/scanner/gcp/scanner.go` — verify per-project event emissions
- `grep "realGCPOrgValidator" server/validate.go` — verify org-mode validate wiring

### What assumptions changed
- Assumed `countDNS` could take `option.ClientOption` like compute functions — it requires raw `TokenSource`, so `scanOneProject` passes both
- Assumed Container API would use `googleapi.Error` like Compute — it uses gRPC status codes, requiring separate `isGKEPermissionDenied` helper
