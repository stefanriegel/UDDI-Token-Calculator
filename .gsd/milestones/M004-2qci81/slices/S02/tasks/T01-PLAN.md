---
estimated_steps: 10
estimated_files: 9
---

# T01: AWS Organizations discovery, multi-account fan-out scanner, and validate endpoint wiring

**Slice:** S02 — AWS Multi-Account Org Scanning + Expanded Resources
**Milestone:** M004-2qci81

## Description

Build the core org discovery + multi-account scanning architecture. This is the highest-risk work in S02 — it introduces a new auth method (`org`), a new fan-out layer in the scanner (accounts × regions), and wiring through session/orchestrator/validate endpoint. All three layers must land together since they form a single testable unit.

The key architectural decisions: (1) `DiscoverAccounts` calls Organizations ListAccounts in us-east-1 with CallWithBackoff for throttle handling. (2) Scanner detects org mode from credentials map, fans out per-account with Semaphore, each account gets its own AssumeRole config via `stscreds.NewAssumeRoleProvider` + `CredentialsCache`. (3) Management account uses base credentials directly (detected via GetCallerIdentity account ID match). (4) Per-account failures are non-fatal — warning event published, other accounts continue.

## Steps

1. Add `organizations` SDK dependency: `go get github.com/aws/aws-sdk-go-v2/service/organizations`
2. Create `internal/scanner/aws/org.go` — define `AccountInfo{ID, Name, Status string}` struct. Implement `DiscoverAccounts(ctx context.Context, cfg awssdk.Config) ([]AccountInfo, error)` using `organizations.NewFromConfig` with forced us-east-1 region (`configForRegion(cfg, "us-east-1")`). Use `NewListAccountsPaginator`, wrap in `cloudutil.CallWithBackoff` for throttle resilience. Filter to `StatusActive` only.
3. Add `OrgEnabled bool` and `OrgRoleName string` fields to `session.AWSCredentials` in `session.go`.
4. Add `"org"` case in `realAWSValidator` in `validate.go` — use base credentials to build config, call `DiscoverAccounts`, return ACTIVE accounts as `[]SubscriptionItem{ID: accountID, Name: accountName}`. Fall back to single-account with error message if ListAccounts fails (insufficient permissions).
5. Update `storeCredentials` AWS case in `validate.go` — read `orgEnabled` and `orgRoleName` from creds map, set `sess.AWS.OrgEnabled` and `sess.AWS.OrgRoleName`.
6. Update `buildScanRequest` AWS case in `orchestrator.go` — copy `org_enabled` and `org_role_name` from session AWS fields into `req.Credentials` map.
7. Refactor `scanner.go` `Scan()` — extract existing single-account logic into `scanOneAccount(ctx, cfg, accountName, maxWorkers, publish) ([]FindingRow, error)` which calls `scanRoute53` + `scanAllRegions`. In `Scan()`, detect org mode (`creds["org_enabled"] == "true"`), call `DiscoverAccounts`, identify management account via `getAccountID` match, fan out with `cloudutil.Semaphore` (maxWorkers default 5). For management account: call `scanOneAccount` with base config. For each child account: build per-account config with `stscreds.NewAssumeRoleProvider` using `arn:aws:iam::{accountID}:role/{orgRoleName}`, wrap in `CredentialsCache`, call `scanOneAccount`. On AssumeRole error: publish warning event, continue. Collect all findings with per-account Source.
8. Write `org_test.go` — define local `organizationsAPI` interface for mocking. Test `DiscoverAccounts`: happy path (2 active accounts), pagination (2 pages), filters out SUSPENDED accounts, handles API error.
9. Write scanner fan-out test — verify that multi-account mode produces findings with distinct per-account Source values. Mock the org discovery and config builder to avoid real AWS calls.
10. Add org validate test in `validate_test.go` — inject mock AWSValidator returning multiple accounts for org auth method, verify response has multiple SubscriptionItems.

## Must-Haves

- [ ] `DiscoverAccounts` calls ListAccounts with us-east-1 region, filters ACTIVE, uses CallWithBackoff
- [ ] Validate endpoint `org` auth method returns discovered accounts as SubscriptionItems
- [ ] Session and orchestrator thread `OrgEnabled` and `OrgRoleName` end-to-end
- [ ] Scanner org mode fans out per-account with Semaphore, each gets AssumeRole config
- [ ] Management account detected and scanned with base credentials (no self-assume)
- [ ] Per-account AssumeRole failure is non-fatal (warning event, continue others)
- [ ] Single-account auth methods (access_key, profile, sso, assume_role) unchanged
- [ ] Unit tests for org discovery, multi-account fan-out, and validate endpoint

## Verification

- `go test ./internal/scanner/aws/... -v -count=1` — includes new org discovery and fan-out tests
- `go test ./server/... -v -count=1` — includes org validate endpoint test
- `go test ./internal/orchestrator/... -v -count=1` — org credential threading compiles and passes
- `go vet ./internal/scanner/aws/... ./server/... ./internal/session/... ./internal/orchestrator/...` — clean

## Observability Impact

- Signals added: `scanner.Event{Type: "account_progress", Status: "scanning"|"complete"|"error"}` per account during org fan-out; AssumeRole failure events include account ID and error
- How a future agent inspects this: grep for `account_progress` events in scan status response; per-account Source in findings
- Failure state exposed: account-level AssumeRole errors published as events with account ID; org discovery failure returns user-facing error from validate endpoint

## Inputs

- `internal/cloudutil/retry.go` — `CallWithBackoff[T]` for org API throttle handling
- `internal/cloudutil/semaphore.go` — `Semaphore` for account-level concurrency
- `internal/scanner/aws/scanner.go` — existing `Scan()`, `buildConfig()`, `getAccountID()`, `getAccountName()`
- `internal/scanner/aws/regions.go` — existing `scanAllRegions()`, `configForRegion()`
- `server/validate.go` — existing `realAWSValidator`, `storeCredentials`
- `internal/orchestrator/orchestrator.go` — existing `buildScanRequest`
- S01 summary — `MaxWorkers` flows to `ScanRequest`, `Semaphore` proven in `scanAllRegions`

## Expected Output

- `internal/scanner/aws/org.go` — `AccountInfo`, `DiscoverAccounts()`, org API interface
- `internal/scanner/aws/org_test.go` — org discovery unit tests (4+ cases)
- `internal/scanner/aws/scanner.go` — modified with `scanOneAccount()` extraction + org fan-out logic
- `internal/session/session.go` — `AWSCredentials` with `OrgEnabled`, `OrgRoleName`
- `internal/orchestrator/orchestrator.go` — `buildScanRequest` threading org fields
- `server/validate.go` — `realAWSValidator` org case + `storeCredentials` org fields
- `server/validate_test.go` — org validate test added
- `go.mod` / `go.sum` — `organizations` SDK dependency added
