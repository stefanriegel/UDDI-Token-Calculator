---
estimated_steps: 5
estimated_files: 6
---

# T03: Multi-project fan-out + orchestrator/validate wiring

**Slice:** S04 — GCP Multi-Project Org Discovery + Expanded Resources
**Milestone:** M004-2qci81

## Description

Wire T01 (discovery) and T02 (expanded resources) into the scanner and connect the full pipeline from validate → session → orchestrator → scanner. Extract `scanOneProject()` from the existing `Scan()` body, add all 7 new resource scans, implement `scanAllProjects()` with semaphore fan-out, and update `Scan()` dispatch. Add org mode support in the validate endpoint, session, and orchestrator.

## Steps

1. Add `OrgID string` field to `session.GCPCredentials` in `internal/session/session.go`. In `internal/orchestrator/orchestrator.go`, add `req.Credentials["org_id"] = sess.GCP.OrgID` to the `ProviderGCP` case of `buildScanRequest`.
2. In `server/validate.go`: add `case "org":` to `realGCPValidator` that dispatches to a new `realGCPOrgValidator(ctx, creds)`. The org validator extracts `orgId` from creds, validates it's non-empty, builds a token source (service account JSON or ADC), calls `gcp.DiscoverProjects(ctx, ts, orgID)`, and returns projects as `[]SubscriptionItem`. Cache the token source using the existing `gcpTokenCache` pattern. In `storeCredentials` GCP case, also read `creds["org_id"]` into `sess.GCP.OrgID`.
3. Refactor `internal/scanner/gcp/scanner.go`:
   - Extract the body of `Scan()` into `scanOneProject(ctx context.Context, projectID string, opts []option.ClientOption, publish func(scanner.Event)) []calculator.FindingRow`. This function runs all existing 6 resource scans PLUS the 7 new ones from T02 (addresses → DDI Objects, firewalls → DDI Objects, routers → Managed Assets, VPN gateways → Managed Assets, VPN tunnels → Managed Assets, GKE CIDRs → DDI Objects, secondary ranges → DDI Objects).
   - Add `const maxConcurrentProjects = 5`.
   - Add `scanAllProjects(ctx, ts oauth2.TokenSource, projects []string, maxWorkers int, publish func(scanner.Event)) ([]calculator.FindingRow, error)` — follows the AWS `scanOrg` / Azure `scanAllSubscriptions` pattern: semaphore + WaitGroup + mu.Lock aggregation + per-project progress events. Each project creates its own `[]option.ClientOption` from the shared token source.
   - Update `Scan()`: after building the token source, if `len(req.Subscriptions) > 1`, call `scanAllProjects`; otherwise call `scanOneProject` for `Subscriptions[0]` (or `credentials["project_id"]` fallback).
   - Add `auth_method == "org"` to the `buildTokenSource` switch — same handling as `"service-account"` (org mode uses a service account with org-level permissions).
4. Update `internal/scanner/gcp/scanner_test.go`: add compile-time signature assertion for `scanOneProject`. Add a test that verifies `Scan()` with a single subscription returns findings (existing behavior preserved). Add a test verifying `buildTokenSource` handles `auth_method=org`.
5. Run full test suite: `go test ./... -count=1` and `cd frontend && npx tsc --noEmit`.

## Must-Haves

- [ ] `scanOneProject` produces FindingRows for all 13 resource types (6 original + 7 new)
- [ ] `scanAllProjects` uses `cloudutil.NewSemaphore(maxWorkers)` with default 5
- [ ] Per-project errors are non-fatal — warning published, other projects continue scanning
- [ ] `Scan()` dispatches multi vs single based on `len(req.Subscriptions) > 1`
- [ ] `session.GCPCredentials.OrgID` threaded through orchestrator to scanner credentials
- [ ] `realGCPOrgValidator` calls `DiscoverProjects` and returns `[]SubscriptionItem`
- [ ] `buildTokenSource` handles `auth_method=org` (service account key path)
- [ ] Existing single-project scan behavior is unaffected
- [ ] Full test suite passes with no regressions

## Verification

- `go test ./internal/scanner/gcp/... -v -count=1` — all GCP tests pass
- `go test ./... -count=1` — full suite green (including existing AWS, Azure, NIOS, Bluecat, EfficientIP tests)
- `cd frontend && npx tsc --noEmit` — no new TypeScript errors
- `go vet ./...` — no vet issues

## Observability Impact

- Signals added/changed: `project_progress` events with Type="project_progress" for per-project scan lifecycle; existing `resource_progress` events now include project-specific Source field
- How a future agent inspects this: scan status endpoint shows per-project progress; grep "project_progress" in event logs
- Failure state exposed: per-project AssumeRole / permission errors include project ID in message

## Inputs

- `internal/scanner/gcp/projects.go` (from T01) — `DiscoverProjects`, `ProjectInfo`
- `internal/scanner/gcp/compute_expanded.go` (from T02) — 5 count functions
- `internal/scanner/gcp/gke.go` (from T02) — `countGKEClusterCIDRs`, `countSecondarySubnetRanges`
- `internal/scanner/gcp/retryable.go` (from T01) — `isGCPRetryable` for error classification
- `internal/cloudutil/semaphore.go` — `NewSemaphore` for fan-out concurrency
- `internal/scanner/aws/scanner.go` — `scanOrg` pattern to replicate
- `internal/scanner/azure/scanner.go` — `scanAllSubscriptions` pattern to replicate

## Expected Output

- `internal/scanner/gcp/scanner.go` — refactored with `scanOneProject`, `scanAllProjects`, updated `Scan()` dispatch, `buildTokenSource` org case
- `internal/scanner/gcp/scanner_test.go` — updated with fan-out and dispatch tests
- `internal/session/session.go` — `OrgID` field on `GCPCredentials`
- `internal/orchestrator/orchestrator.go` — `org_id` credential threading
- `server/validate.go` — `realGCPOrgValidator` + org case dispatch + storeCredentials OrgID
