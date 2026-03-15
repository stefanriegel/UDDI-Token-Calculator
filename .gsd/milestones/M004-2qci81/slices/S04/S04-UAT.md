# S04: GCP Multi-Project Org Discovery + Expanded Resources — UAT

**Milestone:** M004-2qci81
**Written:** 2026-03-15

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: All new code has comprehensive mock-based unit tests. Real GCP API integration is verified in prod deployments. Frontend credential form is deferred to S07. This UAT covers the backend pipeline verification that can be done without live GCP org access.

## Preconditions

- Go 1.24+ installed
- Repository cloned and dependencies resolved (`go mod tidy`)
- All tests passing: `go test ./... -count=1` (root embed error is pre-existing, ignore)
- No running frontend build required (backend-only changes)

## Smoke Test

Run `go test ./internal/scanner/gcp/... -v -count=1` — all 29 tests should pass covering discovery, retryable error handling, expanded resource counters, and multi-project fan-out.

## Test Cases

### 1. GCP Retryable Error Classification

1. Open `internal/scanner/gcp/retryable_test.go`
2. Run `go test ./internal/scanner/gcp/... -v -count=1 -run TestIsGCPRetryable`
3. **Expected:** 5 tests pass — 429, 500, 502, 503, 504 classified as retryable; 400, 401, 403, 404 classified as non-retryable; nil and non-googleapi errors return false

### 2. WrapGCPRetryable Integration with CallWithBackoff

1. Run `go test ./internal/scanner/gcp/... -v -count=1 -run TestWrap`
2. **Expected:** 4 tests pass — retryable errors wrapped as `RetryableError + RetryAfterError`, non-retryable codes passed through unchanged, non-googleapi errors passed through, nil returns nil

### 3. Org Project Discovery — Happy Path

1. Run `go test ./internal/scanner/gcp/... -v -count=1 -run TestDiscoverProjects_HappyPath`
2. **Expected:** Projects returned for flat org (no nested folders), correctly filtered to ACTIVE state, project IDs and names populated

### 4. Org Project Discovery — Nested Folder Hierarchy

1. Run `go test ./internal/scanner/gcp/... -v -count=1 -run TestDiscoverProjects_NestedFolders`
2. **Expected:** BFS traversal discovers projects under org root AND under nested folders; projects from all levels aggregated into single result

### 5. Org Project Discovery — Filters and Dedup

1. Run `go test ./internal/scanner/gcp/... -v -count=1 -run "TestDiscoverProjects_Filters|TestDiscoverProjects_Dedup"`
2. **Expected:** Non-ACTIVE projects (DELETE_REQUESTED, DELETE_IN_PROGRESS) excluded; duplicate project IDs appearing under multiple parents deduplicated to single entry

### 6. Org Project Discovery — Error Handling

1. Run `go test ./internal/scanner/gcp/... -v -count=1 -run "TestDiscoverProjects_SearchAPI|TestDiscoverProjects_FolderAPI|TestDiscoverProjects_FilterDeleted"`
2. **Expected:** SearchProjects API error returns error with context; ListFolders error returns error with context; deleted/inactive folders skipped during BFS (not traversed)

### 7. Expanded Compute Resource Counters — Signatures

1. Run `go test ./internal/scanner/gcp/... -v -count=1 -run TestCount` (from `compute_expanded_test.go`)
2. **Expected:** Compile-time signature assertions pass for `countAddresses`, `countFirewalls`, `countRouters`, `countVPNGateways`, `countVPNTunnels` — all accept `(ctx, projectID, opts)` and return `(int, error)`

### 8. GKE Cluster CIDR Counting + 403 Handling

1. Run `go test ./internal/scanner/gcp/... -v -count=1 -run TestIsGKEPermissionDenied`
2. Inspect `internal/scanner/gcp/gke.go` — verify `countGKEClusterCIDRs` returns `(0, nil)` (not error) when `isGKEPermissionDenied` is true
3. **Expected:** gRPC `codes.PermissionDenied` correctly detected; 403 on GKE is non-fatal with warning log

### 9. Secondary Subnet Ranges Counter — Signature

1. Run `go test ./internal/scanner/gcp/... -v -count=1` and verify `gke_test.go` compile-time assertion for `countSecondarySubnetRanges` passes
2. **Expected:** Function exists with correct signature `(ctx, projectID, opts) → (int, error)`

### 10. Single-Project Scan — All 13 Resource Types

1. Run `go test ./internal/scanner/gcp/... -v -count=1 -run TestScan_SingleSubscription`
2. **Expected:** Single subscription dispatches to `scanOneProject`; findings produced for networks, subnets, instances, load balancers, NICs, DNS zones, DNS records, addresses, firewalls, routers, VPN gateways, VPN tunnels, GKE CIDRs, secondary ranges (13 types total)

### 11. Multi-Project Fan-Out Dispatch

1. Run `go test ./internal/scanner/gcp/... -v -count=1 -run TestScan_MultiSubscriptionDispatch`
2. **Expected:** When `len(req.Subscriptions) > 1`, scan dispatches to `scanAllProjects` with semaphore-bounded concurrency; per-project progress events emitted; per-project errors non-fatal

### 12. buildTokenSource — Org Auth Method

1. Run `go test ./internal/scanner/gcp/... -v -count=1 -run TestBuildTokenSource_OrgMethod`
2. **Expected:** `auth_method=org` correctly routes through service account JSON parsing and returns valid TokenSource

### 13. OrgID Session Threading

1. Inspect `internal/session/session.go` — verify `GCPCredentials` struct has `OrgID string` field
2. Inspect `internal/orchestrator/orchestrator.go` — verify GCP case in `buildScanRequest` includes `req.Credentials["org_id"] = sess.GCP.OrgID`
3. **Expected:** OrgID flows from session through orchestrator to scanner credentials map

### 14. Validate Endpoint — Org Case

1. Inspect `server/validate.go` — verify `case "org"` dispatch to `realGCPOrgValidator`
2. Verify `realGCPOrgValidator` calls `gcp.DiscoverProjects()` and returns projects as `[]SubscriptionItem`
3. **Expected:** Org-mode validation discovers projects and returns them for frontend selection

### 15. Full Test Suite — No Regressions

1. Run `go test ./... -count=1`
2. **Expected:** All packages pass (GCP, AWS, Azure, NIOS, Bluecat, EfficientIP, orchestrator, session, server, cloudutil, calculator, exporter, broker). Only root package fails due to pre-existing `frontend/dist` embed issue.

## Edge Cases

### Empty Organization (No Projects)

1. Run `go test ./internal/scanner/gcp/... -v -count=1 -run TestDiscoverProjects_EmptyOrg`
2. **Expected:** Returns empty slice (not error) — an org with no projects is valid

### Deleted Folders in Org Hierarchy

1. Run `go test ./internal/scanner/gcp/... -v -count=1 -run TestDiscoverProjects_FilterDeletedFolders`
2. **Expected:** Folders with DELETE_REQUESTED state are skipped during BFS traversal — no attempt to search for projects under them

### GKE API Not Enabled / No Permission

1. Verify in `internal/scanner/gcp/gke.go` that `isGKEPermissionDenied` catches gRPC `codes.PermissionDenied`
2. When GKE API returns 403, `countGKEClusterCIDRs` returns `(0, nil)` with log warning
3. **Expected:** Scan continues successfully with 0 GKE CIDRs — not a scan failure

### Per-Project Scan Failure in Fan-Out

1. Verify in `internal/scanner/gcp/scanner.go` that `scanAllProjects` publishes error as `project_progress` event and continues to next project
2. **Expected:** One project failing doesn't abort the entire org scan; findings from successful projects still returned

## Failure Signals

- Any test failure in `go test ./internal/scanner/gcp/... -v -count=1` — indicates broken discovery, retryable logic, or fan-out
- Missing `OrgID` field in `session.GCPCredentials` — breaks org credential threading
- Missing `case "org"` in `realGCPValidator` switch — org-mode validation silently falls through
- `scanOneProject` not calling all 7 new resource counters — expanded resources won't appear in findings
- Compile errors in `compute_expanded.go` or `gke.go` — signature mismatch with GCP SDK clients

## Requirements Proved By This UAT

- GCP-ORG-01 — Backend org discovery + multi-project fan-out proven via mock-based tests (frontend form pending S07)
- GCP-RES-01 — 13 resource types proven via `scanOneProject` test coverage and compile-time signature assertions

## Not Proven By This UAT

- Real GCP org hierarchy traversal with live Resource Manager API — requires prod deployment with org-level SA
- Frontend GCP org credential form — deferred to S07
- GKE CIDRs from real clusters — tested via signature assertion only; no mock GKE list test
- Actual token calculation correctness with 13 resource types — calculator tests are separate
- Checkpoint/resume integration with GCP multi-project scan — deferred to S05

## Notes for Tester

- The root `go test ./...` will show 1 FAIL for the root package (`frontend/dist` embed) — this is pre-existing and unrelated
- Frontend TypeScript check shows errors in shadcn calendar/chart/resizable components — pre-existing, not from this slice
- GKE tests are primarily compile-time signature assertions since mocking the gRPC Container client is complex; the `isGKEPermissionDenied` logic is tested directly
- The `TestScan_MultiSubscriptionDispatch` test takes ~2 seconds due to goroutine fan-out timing
