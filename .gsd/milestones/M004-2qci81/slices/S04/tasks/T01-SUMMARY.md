---
id: T01
parent: S04
milestone: M004-2qci81
provides:
  - isGCPRetryable error classifier for googleapi.Error codes
  - WrapGCPRetryable wrapper satisfying cloudutil.RetryableError + RetryAfterError
  - DiscoverProjects for org-wide GCP project discovery via Resource Manager v3
  - resourceManagerAPI interface for testable project/folder operations
  - ProjectInfo struct for discovered project metadata
key_files:
  - internal/scanner/gcp/retryable.go
  - internal/scanner/gcp/retryable_test.go
  - internal/scanner/gcp/projects.go
  - internal/scanner/gcp/projects_test.go
key_decisions:
  - Interface defined at slice-return level (SearchProjects returns []*Project, ListFolders returns []*Folder) rather than raw SDK iterator level — the real implementation handles iterator.Done internally, keeping the mock simple
  - BFS folder traversal + per-parent SearchProjects rather than unscoped SearchProjects — correctly scopes to target org and avoids returning projects from other orgs the caller can see
  - Deleted/inactive folders skipped during BFS traversal — prevents searching for projects under folders being deleted
patterns_established:
  - resourceManagerAPI interface pattern for GCP Resource Manager mocking (parallel to AWS organizationsAPI)
  - gcpRetryableError wrapper pattern for integrating googleapi.Error with cloudutil.RetryableError/RetryAfterError
observability_surfaces:
  - CallWithBackoff wrapping on both SearchProjects and ListFolders calls — retry events emitted when GCP throttles
  - Error messages include resource path context (e.g. "organizations/{orgID}") for log traceability
duration: 20m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T01: GCP project discovery + retryable error classification

**Implemented `isGCPRetryable` classifier, `WrapGCPRetryable` wrapper, and `DiscoverProjects` with BFS folder traversal for org-wide GCP project discovery.**

## What Happened

Added `cloud.google.com/go/resourcemanager/apiv3` dependency and ran `go mod tidy`.

Created `retryable.go` with:
- `isGCPRetryable(err)` — extracts `googleapi.Error` via `errors.As` and returns true for 429/500/502/503/504
- `gcpRetryableError` wrapper type satisfying both `cloudutil.RetryableError` and `cloudutil.RetryAfterError`
- `WrapGCPRetryable(err)` — wraps retryable googleapi errors, passes through non-retryable and non-googleapi errors unchanged

Created `projects.go` with:
- `ProjectInfo` struct (ID, Name, State)
- `resourceManagerAPI` interface abstracting `SearchProjects` and `ListFolders` at the slice-return level (real implementation handles SDK iterators + `iterator.Done` internally)
- `DiscoverProjects(ctx, ts, orgID)` — production entry point that creates real Resource Manager clients
- `discoverProjectsWithClient(ctx, client, orgID)` — testable core using BFS folder traversal: discovers all ACTIVE folders under the org, then searches for projects under each parent (org + folders), filters to ACTIVE state, deduplicates by project ID. All API calls wrapped in `CallWithBackoff` with `isGCPRetryable`.

## Verification

- `go vet ./internal/scanner/gcp/...` — clean, no issues
- `go test ./internal/scanner/gcp/... -v -count=1 -run TestIsGCP` — 5/5 pass (retryable codes, non-retryable codes, nil, non-googleapi error, wrapped error)
- `go test ./internal/scanner/gcp/... -v -count=1 -run TestWrap` — 4/4 pass (retryable wrapping, non-retryable passthrough, non-googleapi passthrough, nil)
- `go test ./internal/scanner/gcp/... -v -count=1 -run TestDiscover` — 8/8 pass (happy path, nested folders, filter non-active, dedup, empty org, search error, folder error, deleted folder skip)
- `go test ./internal/scanner/gcp/... -v -count=1` — all 25 GCP tests pass
- `go test ./internal/cloudutil/... -v -count=1` — all 13 retry/semaphore tests pass
- `go test ./... -count=1` — all packages pass except pre-existing `frontend/dist` embed issue (not related)
- `cd frontend && npx tsc --noEmit` — pre-existing `resizable.tsx` type errors only (not related, no new errors)

## Diagnostics

- `grep "isGCPRetryable" internal/scanner/gcp/` — find error classification code
- `grep "DiscoverProjects" internal/scanner/gcp/` — find discovery entry point
- Error messages include org/folder resource paths for log traceability (e.g. "gcp: list folders under organizations/123: ...")
- CallWithBackoff retry events emitted when Resource Manager APIs throttle

## Deviations

None.

## Known Issues

- Pre-existing: `frontend/dist` embed pattern fails `go test` on root package (not built in dev)
- Pre-existing: `resizable.tsx` type errors in frontend TypeScript check

## Files Created/Modified

- `internal/scanner/gcp/retryable.go` — new: `isGCPRetryable`, `gcpRetryableError`, `WrapGCPRetryable`
- `internal/scanner/gcp/retryable_test.go` — new: 9 tests for retryable classification and wrapping
- `internal/scanner/gcp/projects.go` — new: `ProjectInfo`, `resourceManagerAPI`, `DiscoverProjects`, `discoverProjectsWithClient` with BFS folder traversal
- `internal/scanner/gcp/projects_test.go` — new: 8 tests for discovery (happy path, nested folders, filtering, dedup, empty org, errors)
- `go.mod` — modified: added `cloud.google.com/go/resourcemanager` dependency
- `go.sum` — modified: updated by `go mod tidy`
