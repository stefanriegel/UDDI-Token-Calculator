---
estimated_steps: 5
estimated_files: 5
---

# T01: GCP project discovery + retryable error classification

**Slice:** S04 — GCP Multi-Project Org Discovery + Expanded Resources
**Milestone:** M004-2qci81

## Description

Create `DiscoverProjects()` that discovers all ACTIVE projects under a GCP organization using the Resource Manager v3 SDK (`SearchProjects` + `ListFolders` for recursive folder traversal). Also create `isGCPRetryable()` that classifies `googleapi.Error` codes for integration with `CallWithBackoff`. Both are foundational for T02 (expanded resources use retryable) and T03 (fan-out uses discovery).

## Steps

1. Run `go get cloud.google.com/go/resourcemanager/apiv3` to add the Resource Manager dependency. Run `go mod tidy`.
2. Create `internal/scanner/gcp/retryable.go`: implement `isGCPRetryable(err error) bool` that extracts `googleapi.Error` and returns true for codes 429, 500, 502, 503, 504. Also implement `IsRetryable() bool` and `RetryAfter() time.Duration` on a `gcpRetryableError` wrapper so it satisfies `cloudutil.RetryableError` and `cloudutil.RetryAfterError` interfaces. Export a `WrapGCPRetryable(err) error` function that wraps a retryable `googleapi.Error` into `gcpRetryableError`, returns original error for non-retryable cases.
3. Create `internal/scanner/gcp/retryable_test.go`: test `isGCPRetryable` for 429, 500, 502, 503, 504 (true), 400, 403, 404 (false), nil (false), non-googleapi error (false). Test `WrapGCPRetryable` preserves retryable/non-retryable semantics.
4. Create `internal/scanner/gcp/projects.go`: define `ProjectInfo` struct (ID, Name, State), `resourceManagerAPI` interface with `SearchProjects` and `ListFolders` method signatures. Implement `DiscoverProjects(ctx, ts oauth2.TokenSource, orgID string) ([]ProjectInfo, error)` that creates the real client and calls `discoverProjectsWithClient`. Implement `discoverProjectsWithClient(ctx, client resourceManagerAPI, orgID string) ([]ProjectInfo, error)` using: (a) `SearchProjects(query: "parent:organizations/{orgID}")` to find all org projects, (b) BFS `ListFolders` starting from org root to discover nested folder projects, (c) filter to ACTIVE state, (d) deduplicate by project ID. Use `CallWithBackoff` wrapping each API call with `isGCPRetryable`.
5. Create `internal/scanner/gcp/projects_test.go`: mock `resourceManagerAPI` interface. Test: happy path (2 projects returned), pagination (mock returns multiple pages), filtering (ACTIVE vs DELETE_REQUESTED), empty org (0 projects), API error propagation. Follow the AWS `org_test.go` pattern with table-driven or explicit test functions.

## Must-Haves

- [ ] `isGCPRetryable` correctly classifies 429/500/502/503/504 as retryable
- [ ] `DiscoverProjects` returns ACTIVE projects only, filtering DELETE_REQUESTED and other states
- [ ] `discoverProjectsWithClient` is the testable core (interface-based, like AWS `discoverAccountsWithClient`)
- [ ] BFS folder traversal (not recursion) to avoid stack overflow on deep hierarchies
- [ ] Pagination handled (Resource Manager iterators)
- [ ] API errors propagated with context

## Verification

- `go get cloud.google.com/go/resourcemanager/apiv3 && go mod tidy` succeeds
- `go test ./internal/scanner/gcp/... -v -count=1 -run TestIsGCP` — retryable classification tests pass
- `go test ./internal/scanner/gcp/... -v -count=1 -run TestDiscover` — discovery tests pass
- `go vet ./internal/scanner/gcp/...` — no vet issues

## Observability Impact

- Signals added/changed: `CallWithBackoff` wrapping on Resource Manager calls will emit retry events when throttled
- How a future agent inspects this: `grep "isGCPRetryable" internal/scanner/gcp/` to find error classification; `grep "DiscoverProjects" internal/scanner/gcp/` to find discovery entry point
- Failure state exposed: API errors wrapped with "organizations/{orgID}" context for log traceability

## Inputs

- `internal/cloudutil/retry.go` — `CallWithBackoff`, `RetryableError`, `RetryAfterError` interfaces
- `internal/scanner/aws/org.go` — `DiscoverAccounts` pattern with `discoverAccountsWithClient` + interface mock
- `google.golang.org/api/googleapi` — `googleapi.Error` type for error code extraction

## Expected Output

- `internal/scanner/gcp/retryable.go` — `isGCPRetryable`, `WrapGCPRetryable`, `gcpRetryableError` type
- `internal/scanner/gcp/retryable_test.go` — classification tests
- `internal/scanner/gcp/projects.go` — `ProjectInfo`, `DiscoverProjects`, `discoverProjectsWithClient`, `resourceManagerAPI` interface
- `internal/scanner/gcp/projects_test.go` — mock-based discovery tests
- `go.mod` / `go.sum` — updated with `cloud.google.com/go/resourcemanager` dependency
