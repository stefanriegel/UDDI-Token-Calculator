# S02: AWS Multi-Account Org Scanning + Expanded Resources — UAT

**Milestone:** M004-2qci81
**Written:** 2026-03-15

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: All AWS API calls use mocked interfaces in tests. Real org discovery requires an AWS Organization with multiple accounts. The mocked tests cover the full pipeline: discovery → fan-out → per-account scanning → combined results. Live runtime testing deferred to milestone-level verification.

## Preconditions

- Go 1.24+ installed with `/usr/local/go/bin` in PATH
- Working directory is the project root (`UDDI-GO-Token-Calculator/`)
- All dependencies fetched (`go mod download`)
- S01 retry/backoff infrastructure is merged (CallWithBackoff, Semaphore available)

## Smoke Test

Run `go test ./internal/scanner/aws/... -v -count=1` — expect 17/17 tests pass including org discovery, EC2 expanded, and Route53 expanded tests. Run time ~15-20s due to region fan-out in wiring tests.

## Test Cases

### 1. Org discovery returns only ACTIVE accounts

1. Run `go test ./internal/scanner/aws/... -v -count=1 -run TestDiscoverAccounts_HappyPath`
2. **Expected:** Test passes. DiscoverAccounts returns 2 accounts (both ACTIVE), each with correct ID, Name, and Status fields.

### 2. Org discovery paginates correctly

1. Run `go test ./internal/scanner/aws/... -v -count=1 -run TestDiscoverAccounts_Pagination`
2. **Expected:** Test passes. Mock returns 2 pages of results; DiscoverAccounts combines them into a single slice of 4 accounts.

### 3. Org discovery filters SUSPENDED accounts

1. Run `go test ./internal/scanner/aws/... -v -count=1 -run TestDiscoverAccounts_FiltersSuspended`
2. **Expected:** Test passes. Mock returns 3 accounts (2 ACTIVE + 1 SUSPENDED); DiscoverAccounts returns only the 2 ACTIVE ones.

### 4. Org discovery handles API errors gracefully

1. Run `go test ./internal/scanner/aws/... -v -count=1 -run TestDiscoverAccounts_APIError`
2. **Expected:** Test passes. Mock returns an error; DiscoverAccounts propagates it with a descriptive message.

### 5. Multi-account fan-out creates valid per-account configs

1. Run `go test ./internal/scanner/aws/... -v -count=1 -run TestScanOrgFanOut`
2. **Expected:** Test passes. `buildOrgAccountConfig` creates a config with credentials that can resolve without error, and `scanOneAccount` function exists with correct signature.

### 6. Validate endpoint returns org accounts as SubscriptionItems

1. Run `go test ./server/... -v -count=1 -run TestValidate_OrgAuthMethod`
2. **Expected:** Test passes. POST to `/api/v1/providers/aws/validate` with `auth_method: "org"` returns status `"valid"` and 3 SubscriptionItems (one per discovered account) with correct ID and Label fields.

### 7. Org credentials stored in session correctly

1. Run `go test ./server/... -v -count=1 -run TestValidate_OrgStoresCredentials`
2. **Expected:** Test passes. After validate with org auth method, session's AWSCredentials has `OrgEnabled = true` and `OrgRoleName = "TestRole"`.

### 8. All 9 expanded EC2 resource types wired into scanRegion

1. Run `go test ./internal/scanner/aws/... -v -count=1 -run TestExpandedResourceScanners_Wiring`
2. **Expected:** Test passes. scanRegion produces findings for all 15 regional resource types (5 original + 9 new EC2 + 1 resolver endpoint), each with correct category and tokens-per-unit.

### 9. IPAM pools gracefully handle not-enabled error

1. Run `go test ./internal/scanner/aws/... -v -count=1 -run TestExpandedResourceScanners_IPAMGraceful`
2. **Expected:** Test passes. When IPAM returns "IPAM is not enabled" error, scanIPAMPools returns (0, nil) instead of an error.

### 10. Expanded EC2 item names are unique and correct

1. Run `go test ./internal/scanner/aws/... -v -count=1 -run TestExpandedResourceScanners_NewItemNames`
2. **Expected:** Test passes. All 9 new item names are present and distinct: elastic_ip, nat_gateway, transit_gateway, internet_gateway, route_table, security_group, vpn_gateway, ipam_pool, vpc_cidr_block.

### 11. Route53 health checks and traffic policies wired as global resources

1. Run `go test ./internal/scanner/aws/... -v -count=1 -run TestRoute53ExpandedScanners_GlobalWiring`
2. **Expected:** Test passes. scanRoute53 produces findings for 4 global resource types (2 original: zones/records + 2 new: health checks, traffic policies).

### 12. Resolver endpoints wired into scanRegion as regional resource

1. Run `go test ./internal/scanner/aws/... -v -count=1 -run TestRoute53ExpandedScanners_ResolverInRegion`
2. **Expected:** Test passes. scanRegion includes resolver_endpoint in its 15 regional resource types.

### 13. Resolver endpoints gracefully handle unsupported regions

1. Run `go test ./internal/scanner/aws/... -v -count=1 -run TestRoute53ExpandedScanners_ResolverGraceful`
2. **Expected:** Test passes. When resolver returns "not available in region" error, scanResolverEndpoints returns (0, nil).

### 14. Orchestrator threads org fields in buildScanRequest

1. Run `go test ./internal/orchestrator/... -v -count=1`
2. **Expected:** All 6 tests pass. buildScanRequest copies org_enabled and org_role_name from session credentials into ScanRequest.Credentials map.

### 15. Full test suite — no regressions

1. Run `go test ./... -count=1`
2. **Expected:** All packages pass. Only failure is the pre-existing `frontend/dist` embed error (root package), which is excluded from slice scope.

### 16. Go vet clean on all touched packages

1. Run `go vet ./internal/scanner/aws/... ./server/... ./internal/session/... ./internal/orchestrator/...`
2. **Expected:** No output (clean).

## Edge Cases

### IPAM not enabled in any region

1. Run test case 9 above.
2. **Expected:** scanIPAMPools returns 0, not an error. The resource_progress event shows Status: "done", Count: 0.

### Resolver not available in region

1. Run test case 13 above.
2. **Expected:** scanResolverEndpoints returns 0, not an error. Catches "not available", "InvalidRequestException", "not supported", "UnknownEndpoint".

### AssumeRole failure for one account in org

1. In `scanner.go`, `scanOrg()` publishes a warning event for the failed account and continues scanning other accounts.
2. **Expected:** Scan completes with partial results — failed account's findings are absent but other accounts' findings are present.

### Management account in org

1. `scanOrg()` detects management account via `getAccountID()` match against the base config's caller identity.
2. **Expected:** Management account is scanned with base credentials (no AssumeRole). No "cannot assume role on self" error.

### Single-account auth methods unchanged

1. Run `go test ./internal/scanner/aws/... -v -count=1 -run TestBuildConfigAssumeRole`
2. **Expected:** Test passes. The existing assume_role, access_key, profile, and sso auth methods continue working without regression.

## Failure Signals

- Any test failure in `go test ./internal/scanner/aws/...` indicates broken org discovery or resource scanning
- `TestValidate_OrgAuthMethod` failure means the validate endpoint's org branch is broken
- `TestExpandedResourceScanners_Wiring` failure means new resource types aren't properly wired into scanRegion
- `go vet` warnings indicate type mismatches or unused imports
- Missing `account_progress` event type in scanner.go means org scan observability is broken
- `scanOneAccount` not calling both `scanRoute53` and `scanAllRegions` means org scans miss global resources

## Requirements Proved By This UAT

- R040 (AWS org discovery) — test cases 1-4 prove account discovery with pagination and filtering
- R041 (multi-account fan-out) — test cases 5-7 prove per-account AssumeRole fan-out with credential threading
- R048 (expanded resource coverage) — test cases 8-13 prove 12 new resource types with correct categories
- AWS-ORG-01 (backend complete) — full pipeline from validate through scan with combined results

## Not Proven By This UAT

- Real AWS API calls — all tests use mocked interfaces; live API testing deferred to milestone-level verification
- Frontend org credential form — S07 delivers the UI; this slice is backend-only
- STS rate limiting under 50+ concurrent AssumeRole calls — proven in S01 via retry infrastructure, not re-tested here with real API
- DNS record type breakdown — deferred to S06

## Notes for Tester

- The wiring tests (TestExpandedResourceScanners_Wiring, TestRoute53ExpandedScanners_ResolverInRegion) take 7-9s each because they fan out across mock regions. This is expected.
- The `frontend/dist` embed error on `go test ./...` is pre-existing and unrelated to S02 — the frontend is not built in the dev environment.
- IPAM graceful test may show different error strings on different AWS SDK versions — the matching is broad ("IPAM", "not enabled", "InvalidParameterValue").
