---
id: T01
parent: S02
milestone: M004-2qci81
provides:
  - AWS Organizations account discovery (DiscoverAccounts with throttle-resilient backoff)
  - Multi-account org fan-out scanner with per-account AssumeRole + CredentialsCache
  - Management account detection via GetCallerIdentity (no self-assume)
  - Validate endpoint "org" auth method returning discovered accounts as SubscriptionItems
  - Session + orchestrator end-to-end threading of OrgEnabled and OrgRoleName
  - Per-account failure tolerance (warning events, continue scanning other accounts)
key_files:
  - internal/scanner/aws/org.go
  - internal/scanner/aws/scanner.go
  - internal/session/session.go
  - internal/orchestrator/orchestrator.go
  - server/validate.go
key_decisions:
  - "org" auth method added as a case in buildConfig (treated as access_key alias) so the scanner can build a valid base config; org fan-out is handled at Scan() level, not in buildConfig
  - DiscoverAccounts uses a separate testable interface (organizationsAPI) and CallWithBackoff with custom IsRetryable for Throttling/TooManyRequests errors
  - buildOrgAccountConfig uses stscreds.NewAssumeRoleProvider with CredentialsCache (same pattern as assume_role auth), role session name "uddi-org-scan"
  - scanOneAccount extracted from Scan() as the unit of work for both single-account and org fan-out modes — keeps the existing code path identical
patterns_established:
  - organizationsAPI interface for mocking AWS Organizations in tests (same pattern as existing EC2/STS/IAM mocking)
  - scanOneAccount(ctx, cfg, accountName, maxWorkers, publish) as the reusable single-account scan unit
  - account_progress event type for multi-account scan observability
observability_surfaces:
  - scanner.Event{Type: "account_progress"} with Status "scanning"/"complete"/"error" published per account during org fan-out
  - AssumeRole failures include account ID and error message in event Message field
  - Per-account Source values in FindingRow enable distinct account identification in scan results
duration: 40m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T01: AWS Organizations discovery, multi-account fan-out scanner, and validate endpoint wiring

**Built the full org discovery → multi-account fan-out → validate endpoint pipeline with end-to-end credential threading and non-fatal per-account failure handling.**

## What Happened

1. Added `github.com/aws/aws-sdk-go-v2/service/organizations` SDK dependency.

2. Created `internal/scanner/aws/org.go` with `AccountInfo` struct, `organizationsAPI` interface for testability, and `DiscoverAccounts()` function. Uses `configForRegion(cfg, "us-east-1")` to force the Organizations API region, manual pagination with `CallWithBackoff` wrapping each page call, and filters to `ACTIVE` accounts only.

3. Added `OrgEnabled bool` and `OrgRoleName string` to `session.AWSCredentials`.

4. Added `realAWSOrgValidator` in `validate.go` — builds a config from access key credentials, verifies via GetCallerIdentity, then calls `DiscoverAccounts` to return org accounts as `SubscriptionItems`. Imported as `awsscanner` to avoid name collision.

5. Updated `storeCredentials` AWS case to read `orgEnabled` and `orgRoleName` from the creds map.

6. Updated `buildScanRequest` AWS case to copy `org_enabled` and `org_role_name` from session fields into `req.Credentials`.

7. Refactored `scanner.go`: extracted `scanOneAccount()` from `Scan()`, added `scanOrg()` for multi-account fan-out with `cloudutil.Semaphore`, and `buildOrgAccountConfig()` for per-account AssumeRole. Management account detected via `getAccountID()` match — scanned with base credentials. Child accounts get `stscreds.NewAssumeRoleProvider` + `CredentialsCache`. AssumeRole failures publish warning events and continue.

8. Added `"org"` to `buildConfig` switch as an alias for `access_key` — org mode uses access_key credentials as its base auth, with fan-out handled at the `Scan()` level.

9. Wrote `org_test.go` with 4 test cases: happy path (2 active accounts), pagination (2 pages), filters SUSPENDED accounts, handles API error.

10. Wrote scanner fan-out test in `scanner_test.go` verifying `buildOrgAccountConfig` creates valid configs with credentials, and that `scanOneAccount` function signature is accessible.

11. Wrote 2 validate tests: `TestValidate_OrgAuthMethod` (3 accounts returned as SubscriptionItems) and `TestValidate_OrgStoresCredentials` (OrgEnabled and OrgRoleName persisted in session).

## Verification

- `go test ./internal/scanner/aws/... -v -count=1` — 10/10 pass (4 org discovery + 1 org fan-out + 5 existing)
- `go test ./server/... -v -count=1` — all pass including 2 new org validate tests
- `go test ./internal/orchestrator/... -v -count=1` — 6/6 pass (org credential threading compiles and runs)
- `go vet ./internal/scanner/aws/... ./server/... ./internal/session/... ./internal/orchestrator/...` — clean

### Slice-level verification status (T01 of 3 tasks):
- ✅ `go test ./internal/scanner/aws/... -v -count=1` — passes
- ✅ `go test ./server/... -v -count=1` — passes
- ✅ `go test ./internal/orchestrator/... -v -count=1` — passes
- ⬜ `go test ./... -count=1` — not run (full suite includes frontend/dist embed; deferred to T03)
- ✅ `go vet ./internal/scanner/aws/... ./server/... ./internal/session/... ./internal/orchestrator/...` — clean

## Diagnostics

- Grep for `account_progress` events in scan status SSE stream to see per-account scanning lifecycle
- Per-account `FindingRow.Source` contains the human-friendly account name — query scan results grouped by Source to see per-account breakdown
- AssumeRole failures appear as `account_progress` events with Status `"error"` and the account ID + error in Message
- Org discovery failures from the validate endpoint return descriptive errors mentioning `organizations:ListAccounts` permission

## Deviations

- Added `"org"` to `buildConfig` switch as an access_key alias — not in the original plan but necessary because the scanner receives `auth_method = "org"` from the orchestrator and `buildConfig` would return "unknown auth_method" without it.
- Used manual pagination in `DiscoverAccounts` instead of `NewListAccountsPaginator` — the paginator doesn't integrate cleanly with `CallWithBackoff` per-page wrapping, and manual pagination gives better control over per-page retry behavior.

## Known Issues

- None.

## Files Created/Modified

- `internal/scanner/aws/org.go` — new: AccountInfo struct, organizationsAPI interface, DiscoverAccounts(), discoverAccountsWithClient()
- `internal/scanner/aws/org_test.go` — new: 4 org discovery unit tests
- `internal/scanner/aws/scanner.go` — modified: extracted scanOneAccount(), added scanOrg() fan-out, buildOrgAccountConfig(), "org" in buildConfig
- `internal/scanner/aws/scanner_test.go` — modified: added TestScanOrgFanOut
- `internal/session/session.go` — modified: added OrgEnabled, OrgRoleName to AWSCredentials
- `internal/orchestrator/orchestrator.go` — modified: buildScanRequest threads org_enabled and org_role_name
- `server/validate.go` — modified: added realAWSOrgValidator, "org" case in realAWSValidator, awsscanner import, orgEnabled/orgRoleName in storeCredentials
- `server/validate_test.go` — modified: added TestValidate_OrgAuthMethod, TestValidate_OrgStoresCredentials
- `go.mod` — modified: added organizations SDK dependency
- `go.sum` — modified: updated checksums
