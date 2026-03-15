---
id: T03
parent: S04
milestone: M004-2qci81
provides:
  - scanOneProject function extracting all 13 resource scans into a reusable unit
  - scanAllProjects semaphore-bounded fan-out for multi-project org scanning
  - realGCPOrgValidator dispatching DiscoverProjects for org-mode credential validation
  - OrgID session→orchestrator→scanner credential threading
  - buildTokenSource auth_method=org support
key_files:
  - internal/scanner/gcp/scanner.go
  - internal/scanner/gcp/scanner_test.go
  - internal/session/session.go
  - internal/orchestrator/orchestrator.go
  - server/validate.go
key_decisions:
  - scanOneProject receives both TokenSource and ClientOption slice — countDNS requires TokenSource directly while compute functions use ClientOption
  - scanAllProjects returns (findings, nil) not (nil, error) because per-project failures are non-fatal (matched AWS/Azure pattern)
  - realGCPOrgValidator requests cloud-platform.read-only scope alongside cloudplatformprojects.readonly for Resource Manager folder traversal
patterns_established:
  - project_progress event pattern for GCP multi-project fan-out (parallel to AWS account_progress and Azure subscription_progress)
  - GCP org validate→session→orchestrator→scanner credential threading (parallel to AWS org_enabled + org_role_name flow)
observability_surfaces:
  - project_progress events with Status scanning/complete per project during fan-out
  - resource_progress events include project-specific Source field for per-project attribution
  - Per-project scan errors published as project_progress events (non-fatal)
duration: 15m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T03: Multi-project fan-out + orchestrator/validate wiring

**Wired T01 discovery + T02 expanded resources into the scanner pipeline with semaphore fan-out, org-mode validation, and full session→orchestrator→scanner credential threading.**

## What Happened

Extracted `scanOneProject()` from the existing `Scan()` body, adding all 7 new resource scans from T02 alongside the original 6 (13 total resource types). Implemented `scanAllProjects()` with semaphore-bounded goroutine fan-out following the AWS `scanOrg` and Azure `scanAllSubscriptions` patterns. Updated `Scan()` to dispatch multi-project when `len(req.Subscriptions) > 1`.

Added `OrgID string` field to `session.GCPCredentials` and threaded it through `buildScanRequest` in the orchestrator. Added `realGCPOrgValidator` in `server/validate.go` that extracts org credentials, builds a token source, calls `gcp.DiscoverProjects()`, and returns discovered projects as `[]SubscriptionItem`. Added `auth_method=org` case to `buildTokenSource` supporting both cached token source (from validate) and direct SA JSON parsing.

Updated `storeCredentials` GCP case to also read and store `orgId` from the credentials map.

## Verification

- `go test ./internal/scanner/gcp/... -v -count=1` — **37 tests pass** including new `TestBuildTokenSource_OrgMethod`, `TestScan_SingleSubscription`, `TestScan_MultiSubscriptionDispatch`, and compile-time signature assertion for `scanOneProject`
- `go test ./... -count=1` — **all Go packages pass** (GCP, AWS, Azure, NIOS, Bluecat, EfficientIP, orchestrator, session, server, cloudutil, calculator, exporter, broker). Root embed error is pre-existing (no frontend/dist)
- `go vet ./internal/... ./server/...` — clean, no issues
- `cd frontend && npx tsc --noEmit` — pre-existing TS errors in shadcn calendar/chart/resizable components only; no new errors introduced
- `go build ./internal/... ./server/...` — compiles cleanly

### Slice-level verification status (3/3 tasks complete):
- ✅ `go test ./internal/scanner/gcp/... -v -count=1` — all pass
- ✅ `go test ./internal/cloudutil/... -v -count=1` — passes (verified in full suite run)
- ✅ `go test ./... -count=1` — all packages pass (root embed is pre-existing)
- ⚠️ `cd frontend && npx tsc --noEmit` — pre-existing TS errors only (not introduced by this slice)

## Diagnostics

- `grep "project_progress" <logs>` — find per-project fan-out lifecycle events
- `grep "scanOneProject\|scanAllProjects" internal/scanner/gcp/scanner.go` — find fan-out entry points
- `grep "realGCPOrgValidator" server/validate.go` — find org-mode validation logic
- `grep "OrgID" internal/session/session.go internal/orchestrator/orchestrator.go` — trace OrgID threading
- Per-project errors include project ID in message for log traceability

## Deviations

- `scanOneProject` takes both `oauth2.TokenSource` and `[]option.ClientOption` instead of just opts — `countDNS` requires a raw TokenSource (not ClientOption) by its existing signature. This is a minor API shape deviation from the plan but avoids modifying `countDNS` signature which would be a larger change.

## Known Issues

- Pre-existing: root `go build ./...` fails due to missing `frontend/dist` embed dir (no frontend build artifacts). Not a regression.
- Pre-existing: frontend TypeScript errors in shadcn UI components (calendar, chart, resizable). Not introduced by this slice.

## Files Created/Modified

- `internal/scanner/gcp/scanner.go` — extracted `scanOneProject` (13 resource types), added `scanAllProjects` fan-out, `maxConcurrentProjects` const, `auth_method=org` in `buildTokenSource`, updated `Scan()` dispatch
- `internal/scanner/gcp/scanner_test.go` — added compile-time `scanOneProject` signature assertion, `TestBuildTokenSource_OrgMethod`, `TestScan_SingleSubscription`, `TestScan_MultiSubscriptionDispatch`
- `internal/session/session.go` — added `OrgID string` field to `GCPCredentials`
- `internal/orchestrator/orchestrator.go` — added `req.Credentials["org_id"] = sess.GCP.OrgID` in GCP case of `buildScanRequest`
- `server/validate.go` — added `gcpscanner` import, `case "org"` dispatch in `realGCPValidator`, `realGCPOrgValidator` function, `OrgID` in `storeCredentials` GCP case
