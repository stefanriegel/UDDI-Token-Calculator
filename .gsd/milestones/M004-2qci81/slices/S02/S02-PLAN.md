# S02: AWS Multi-Account Org Scanning + Expanded Resources

**Goal:** AWS Organizations API discovers child accounts, scanner fans out per-account with AssumeRole, and 12 new resource types are counted alongside existing ones.
**Demo:** User enters org master credentials + role name → validate returns discovered accounts as SubscriptionItems → scan produces per-account findings with expanded resource coverage (elastic IPs, NAT gateways, transit gateways, etc.).

## Must-Haves

- `DiscoverAccounts(ctx, cfg)` calls Organizations ListAccounts (us-east-1), filters to ACTIVE, returns `[]AccountInfo`
- Validate endpoint `realAWSValidator` has `"org"` auth method branch returning discovered accounts as `[]SubscriptionItem`
- `AWSCredentials` gains `OrgEnabled` and `OrgRoleName` fields; `storeCredentials` and `buildScanRequest` thread them
- Scanner detects org mode, fans out per-account with `cloudutil.Semaphore` (default 5 concurrent), each account gets AssumeRole config
- Management account scanned with base credentials (no self-assume-role); detected via `GetCallerIdentity` match
- Per-account `FindingRow.Source` uses account name (not shared source) so `aggregateFindings` keeps them distinct
- AssumeRole failure for one account logs warning event and continues scanning other accounts
- Single-account auth methods (access_key, profile, sso, assume_role) continue working unchanged
- 9 new EC2 resource scanners: elastic IPs, NAT gateways, transit gateways, internet gateways, route tables, security groups, VPN gateways, IPAM pools, VPC CIDR blocks
- 3 new Route53 resource scanners: health checks, traffic policies, resolver endpoints
- All new resource scanners use correct token categories from research table
- Unit tests for org discovery (mocked), multi-account fan-out logic, and expanded resource scanners
- Validate endpoint test for org auth method branch

## Proof Level

- This slice proves: integration (org discovery → fan-out → per-account scanning → combined results)
- Real runtime required: no (AWS API calls are mocked in tests; real API testing deferred to milestone-level verification)
- Human/UAT required: no

## Verification

- `go test ./internal/scanner/aws/... -v -count=1` — all tests pass including new org discovery, multi-account fan-out, and expanded resource scanner tests
- `go test ./server/... -v -count=1` — validate endpoint test for org auth method passes
- `go test ./internal/orchestrator/... -v -count=1` — org credential threading passes
- `go test ./... -count=1` — no regressions (pre-existing `frontend/dist` embed error excluded)
- `go vet ./internal/scanner/aws/... ./server/... ./internal/session/... ./internal/orchestrator/...` — no warnings

## Observability / Diagnostics

- Runtime signals: `scanner.Event{Type: "resource_progress"}` emitted per-account per-resource with account name in event context; `scanner.Event{Type: "account_progress"}` for account-level start/complete/error
- Inspection surfaces: per-account findings visible in scan results with distinct `Source` values; retry events from `CallWithBackoff.OnRetry` for throttled org API calls
- Failure visibility: AssumeRole failures logged as warning events with account ID + error message; org discovery failure triggers graceful fallback to single-account with warning
- Redaction constraints: AWS credentials never in event messages or logs; account IDs are not secrets

## Integration Closure

- Upstream surfaces consumed: `internal/cloudutil/retry.go` (`CallWithBackoff`), `internal/cloudutil/semaphore.go` (`Semaphore`), `internal/scanner/provider.go` (`ScanRequest.MaxWorkers`)
- New wiring introduced in this slice: `session.AWSCredentials` org fields → `orchestrator.buildScanRequest` → `scanner.ScanRequest.Credentials` org keys → AWS scanner org detection; validate endpoint org branch → `SubscriptionItem` list
- What remains before the milestone is truly usable end-to-end: S07 frontend UI for org credential input; S06 DNS type breakdown replaces generic `dns_record` item

## Tasks

- [x] **T01: AWS Organizations discovery, multi-account fan-out scanner, and validate endpoint wiring** `est:2h`
  - Why: Core architectural change — org discovery + per-account AssumeRole fan-out is the primary deliverable of S02 and the riskiest work. Validate endpoint, session types, and orchestrator credential threading must land together since they form a single testable unit.
  - Files: `internal/scanner/aws/org.go`, `internal/scanner/aws/scanner.go`, `internal/session/session.go`, `server/validate.go`, `internal/orchestrator/orchestrator.go`, `internal/scanner/aws/org_test.go`, `server/validate_test.go`, `go.mod`, `go.sum`
  - Do: (1) `go get github.com/aws/aws-sdk-go-v2/service/organizations`. (2) Create `org.go` with `AccountInfo` struct and `DiscoverAccounts(ctx, cfg)` using Organizations ListAccounts paginator (force us-east-1 region), filter ACTIVE only, wrap in `CallWithBackoff`. (3) Add `OrgEnabled bool` and `OrgRoleName string` to `session.AWSCredentials`. (4) Add `"org"` case in `realAWSValidator` — call `DiscoverAccounts`, return accounts as `[]SubscriptionItem`. (5) Update `storeCredentials` AWS case to read `orgEnabled`/`orgRoleName` from creds map. (6) Update `buildScanRequest` to copy `org_enabled` and `org_role_name` into credentials map. (7) In `scanner.go` `Scan()`, detect org mode (`creds["org_enabled"] == "true"`), call `DiscoverAccounts`, fan out per-account using `cloudutil.Semaphore` (default 5). For each account: format role ARN as `arn:aws:iam::{accountId}:role/{roleName}`, create config via `stscreds.NewAssumeRoleProvider` + `CredentialsCache`, call new `scanOneAccount(ctx, cfg, accountName, maxWorkers, publish)` which runs `scanRoute53` + `scanAllRegions`. Skip self-assume for management account (match via `GetCallerIdentity`). On per-account AssumeRole failure, publish warning event and continue. (8) Write `org_test.go` with mocked Organizations interface testing `DiscoverAccounts` (happy path, pagination, filters SUSPENDED). (9) Write scanner test for multi-account fan-out (mock interface for credential builder, verify per-account Source in findings). (10) Add validate endpoint test for org auth method in `validate_test.go`.
  - Verify: `go test ./internal/scanner/aws/... -v -count=1 && go test ./server/... -v -count=1 && go test ./internal/orchestrator/... -v -count=1`
  - Done when: org discovery returns ACTIVE accounts, scanner fans out per-account with per-account Source, validate returns org accounts, single-account paths unchanged, all tests pass

- [x] **T02: Expanded EC2 resource scanners (9 types) wired into scanRegion** `est:45m`
  - Why: R048 requires matching cloud-object-counter coverage. These are mechanical paginator functions following the proven `scanVPCs`/`scanSubnets` pattern — low risk but necessary for token accuracy.
  - Files: `internal/scanner/aws/ec2.go`, `internal/scanner/aws/regions.go`, `internal/scanner/aws/ec2_expanded_test.go`
  - Do: (1) Add 9 scan functions to `ec2.go`: `scanElasticIPs` (DescribeAddresses), `scanNATGateways` (DescribeNatGateways, filter available), `scanTransitGateways` (DescribeTransitGateways), `scanInternetGateways` (DescribeInternetGateways), `scanRouteTables` (DescribeRouteTables), `scanSecurityGroups` (DescribeSecurityGroups), `scanVPNGateways` (DescribeVpnGateways), `scanIPAMPools` (DescribeIpamPools — handle "IPAM not enabled" gracefully by returning 0), `scanVPCCIDRBlocks` (DescribeVpcs counting CidrBlockAssociationSet entries). Each follows the exact paginator pattern from existing functions. (2) Wire all 9 into `scanRegion()` in `regions.go` with correct category/tokens-per-unit from research table. (3) Write `ec2_expanded_test.go` with at least one table-driven test verifying token category and item name for each new resource type (using the `runResourceScan` return value shape).
  - Verify: `go test ./internal/scanner/aws/... -v -count=1 -run Expanded`
  - Done when: `scanRegion` calls all 9 new resource types, each uses correct category constant, IPAM gracefully handles not-enabled error, tests pass

- [x] **T03: Expanded Route53 scanners (health checks, traffic policies, resolver endpoints) + slice verification** `est:45m`
  - Why: Completes R048 coverage for Route53-adjacent resources. Resolver endpoints require the `route53resolver` SDK package (separate service). This task also runs full slice verification.
  - Files: `internal/scanner/aws/route53.go`, `internal/scanner/aws/route53_expanded_test.go`, `go.mod`, `go.sum`
  - Do: (1) `go get github.com/aws/aws-sdk-go-v2/service/route53resolver`. (2) Add `scanRoute53HealthChecks` (ListHealthChecks paginator), `scanRoute53TrafficPolicies` (ListTrafficPolicies paginator) to `route53.go`. (3) Add `scanResolverEndpoints` using `route53resolver.NewFromConfig` + `ListResolverEndpoints` paginator — handle "not available in region" gracefully. (4) Wire health checks and traffic policies into `scanRoute53()` (global). Wire resolver endpoints into `scanRegion()` in `regions.go` (regional service). All use `CategoryDDIObjects` / `TokensPerDDIObject`. (5) Write `route53_expanded_test.go` testing the new scan functions. (6) Run full slice verification: `go test ./... -count=1`, `go vet ./...`.
  - Verify: `go test ./internal/scanner/aws/... -v -count=1 && go test ./... -count=1 && go vet ./internal/scanner/aws/... ./server/... ./internal/session/... ./internal/orchestrator/...`
  - Done when: All 12 expanded resource types wired, full test suite passes with no regressions, go vet clean

## Files Likely Touched

- `internal/scanner/aws/org.go` (new — org discovery + AccountInfo type)
- `internal/scanner/aws/org_test.go` (new — org discovery tests)
- `internal/scanner/aws/scanner.go` (multi-account fan-out in Scan())
- `internal/scanner/aws/ec2.go` (9 new resource scan functions)
- `internal/scanner/aws/ec2_expanded_test.go` (new — expanded EC2 tests)
- `internal/scanner/aws/route53.go` (health checks, traffic policies)
- `internal/scanner/aws/route53_expanded_test.go` (new — expanded Route53 tests)
- `internal/scanner/aws/regions.go` (wire new resource types into scanRegion)
- `internal/session/session.go` (OrgEnabled, OrgRoleName on AWSCredentials)
- `internal/orchestrator/orchestrator.go` (thread org fields in buildScanRequest)
- `server/validate.go` (org auth method branch in realAWSValidator)
- `server/validate_test.go` (org validate test)
- `go.mod` (organizations + route53resolver dependencies)
- `go.sum`
