# S02: AWS Multi-Account Org Scanning + Expanded Resources — Research

**Date:** 2026-03-15

## Summary

This slice adds two major capabilities: (1) AWS Organizations API integration for multi-account discovery + STS AssumeRole fan-out scanning, and (2) expanded AWS resource type coverage (Elastic IPs, NAT Gateways, Transit Gateways, IGWs, Route Tables, Security Groups, VPN Gateways, IPAM Pools, VPC CIDR blocks, Route53 Health Checks/Traffic Policies/Resolver Endpoints).

The existing codebase has a single-account scanning model where `Scanner.Scan()` operates on one set of credentials. Multi-account requires a new org discovery layer (`DiscoverAccounts`) that calls the AWS Organizations ListAccounts API, followed by a fan-out that creates per-account `aws.Config` objects via `stscreds.NewAssumeRoleProvider`. The existing `scanAllRegions` pattern (semaphore + WaitGroup) is the proven template for this fan-out. The S01 `CallWithBackoff` and `Semaphore` primitives slot in directly.

The validate endpoint already returns `[]SubscriptionItem` — org discovery during validation is the natural hook to populate this list with discovered accounts. The session already stores `RoleARN` and related fields. The scanner already uses `stscreds.NewAssumeRoleProvider` with `CredentialsCache` for assume-role — extending this to per-account role assumption is straightforward.

A new go.mod dependency is required: `github.com/aws/aws-sdk-go-v2/service/organizations`. No CGo. The Organizations API is global (us-east-1 only). The expanded resource types all use the existing EC2 API client — no new service dependencies beyond organizations.

## Requirements Owned

This slice directly delivers or supports:

- **R040** — AWS Organizations API account discovery (ListAccounts)
- **R041** — STS AssumeRole fan-out for cross-account scanning
- **R044** — Configurable concurrency (already threaded from S01; consumed here for account-level fan-out)
- **R048** — Expanded AWS resource types matching cloud-object-counter coverage

It also partially supports:
- **R042** — Retry with exponential backoff (consumes S01 infrastructure for org API + resource calls)
- **R046** — Per-account progress events (new `scanner.Event` with per-account source)

## Recommendation

**Two-layer fan-out architecture:**

1. **Account-level fan-out** in new `internal/scanner/aws/org.go` — discovers accounts via Organizations API, then fans out per-account scanning using `cloudutil.Semaphore` (configurable via `MaxWorkers`, default 5 accounts concurrent). Each account gets its own `aws.Config` via `stscreds.NewAssumeRoleProvider`.

2. **Region-level fan-out** — existing `scanAllRegions` is called once per account with the account's assumed-role config. This creates a nested fan-out: accounts × regions, naturally bounded by two semaphores.

**Validate endpoint changes:** Add an `org_id` / `org_role_name` auth method branch in `realAWSValidator` that calls Organizations ListAccounts and returns all child accounts as `SubscriptionItem`. The frontend's existing subscription selection step then lets users include/exclude accounts.

**Graceful degradation:** If ListAccounts fails (insufficient permissions), fall back to single-account scanning with a warning event. This matches the roadmap's risk mitigation.

**Expanded resources:** Add new scan functions in `ec2.go` using the same `runResourceScan` pattern — each is a paginator-based count function. Route53 expanded types (health checks, traffic policies, resolver endpoints) go in `route53.go`.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Retry with backoff for Organizations API | `cloudutil.CallWithBackoff[T]` | Already proven in S01; handles 429 + transient errors |
| Concurrency limiting for account fan-out | `cloudutil.NewSemaphore(n)` | Already used in `scanAllRegions`; proven pattern |
| Per-account credential refresh | `stscreds.NewAssumeRoleProvider` + `aws.NewCredentialsCache` | Already used in assume-role `buildConfig`; auto-refreshes before expiry |
| Account listing pagination | `organizations.NewListAccountsPaginator` | AWS SDK v2 built-in paginator — same pattern as EC2/Route53 |
| Resource counting with progress events | `runResourceScan()` in `regions.go` | Existing helper handles timing, error events, FindingRow construction |

## Existing Code and Patterns

- `internal/scanner/aws/scanner.go` — `Scan()` entry point; `buildConfig()` routes auth methods including `assume_role` with `stscreds.NewAssumeRoleProvider` + `CredentialsCache`. Multi-account scanning wraps this per-account.
- `internal/scanner/aws/regions.go` — `scanAllRegions()` is the template for account-level fan-out: semaphore + WaitGroup + mutex for findings collection. `scanRegion()` calls `runResourceScan()` per resource type — new resources plug in here.
- `internal/scanner/aws/ec2.go` — All EC2 resource functions follow the same pattern: create paginator, iterate pages, count items. New resource scanners follow this exactly.
- `internal/scanner/aws/route53.go` — Global resource scanning (zones + records). Health checks, traffic policies, resolver endpoints extend this.
- `internal/cloudutil/retry.go` — `CallWithBackoff[T]` with `HTTPStatusError` for 429/5xx. Organizations API calls should use this.
- `internal/cloudutil/semaphore.go` — Channel-based semaphore used for region fan-out; reuse for account fan-out.
- `server/validate.go` — `realAWSValidator()` dispatches by `authMethod`. New org discovery branch adds here. Returns `[]SubscriptionItem`.
- `server/types.go` — `ScanProviderSpec` already has `Subscriptions []string` and `SelectionMode`. These carry account IDs for multi-account.
- `internal/session/session.go` — `AWSCredentials` has `RoleARN`, `SourceProfile`, `ExternalID`. Need to add `OrgRoleName` for the cross-account role name.
- `internal/orchestrator/orchestrator.go` — `buildScanRequest()` copies AWS credentials to `ScanRequest.Credentials` map. Org fields thread through here.

## Constraints

- **CGO_ENABLED=0** — no CGo dependencies. `organizations` SDK package is pure Go.
- **Organizations API is us-east-1 only** — ListAccounts must use us-east-1 region regardless of user's configured region.
- **STS rate limiting** — AssumeRole has a soft limit of ~46 calls/second per account. With 200+ accounts, pacing via semaphore (5 concurrent) + backoff is essential.
- **`Scanner` interface is immutable** — `Scan(ctx, ScanRequest, publish)` signature can't change. Multi-account logic lives inside the AWS scanner, not the orchestrator.
- **FindingRow.Source must be per-account** — each account's findings should have the account ID/name as Source for results aggregation. The existing `aggregateFindings()` in `scan.go` merges by (provider, source, item) — per-account source keeps them distinct.
- **Backward compatibility** — single-account scanning (access_key, profile, SSO) must still work exactly as before. Org discovery is a new auth method branch, not a replacement.
- **AWS SDK retry mode** — `buildConfig` already sets `RetryModeAdaptive` with 5 attempts. This handles per-API-call retries. `CallWithBackoff` is for higher-level orchestration retry (org-level pacing).

## Common Pitfalls

- **Assume-role role name vs role ARN** — Org scanning needs a _role name_ (e.g. "OrganizationAccountAccessRole") that gets formatted as `arn:aws:iam::{accountId}:role/{roleName}` per account. Don't confuse with the existing `RoleARN` field which is a full ARN for single-account assume-role.
- **Management account scanning** — The org management account shouldn't be scanned via AssumeRole (it's the caller's account). Use the base credentials directly for it. Detect via `GetCallerIdentity` account ID matching the org's management account ID.
- **Active vs suspended accounts** — Organizations ListAccounts returns all accounts including SUSPENDED ones. Filter to `ACTIVE` status only before fan-out.
- **Empty results on permission failure** — If AssumeRole fails for one account, log a warning event and continue scanning other accounts. Don't fail the entire scan.
- **Token computation** — `runResourceScan` already computes tokens via ceiling division. New resources must use the correct category constants (`CategoryDDIObjects`, `CategoryActiveIPs`, `CategoryManagedAssets`).

## Open Risks

- **Organizations API permissions granularity** — Some organizations restrict ListAccounts to specific OUs. ListAccounts returns all accounts; there's no OU-level filtering in the basic API. May need `ListAccountsForParent` for OU-targeted scanning in a future iteration.
- **STS cross-region throttling** — If accounts span many regions, the combination of account × region fan-out could hit regional STS limits. The two-level semaphore (accounts × regions) mitigates this, but extreme fan-out (200 accounts × 20 regions) needs testing.
- **Expanded resource API permissions** — Elastic IPs, NAT Gateways, Transit Gateways etc. require specific IAM permissions (ec2:DescribeAddresses, ec2:DescribeNatGateways, etc.). If the cross-account role lacks these, individual resource scans will error gracefully (existing pattern), but users may not understand why counts are zero.
- **Route53 Resolver endpoints** — Route53Resolver is a separate service (not Route53). Requires `route53resolver` SDK package and separate permissions. May need an additional go.mod dependency.
- **IPAM Pools** — IPAM is a relatively new EC2 feature. Not all accounts/regions have IPAM enabled. DescribeIpamPools may return empty or error with "IPAM not enabled" — handle gracefully.

## Architecture Sketch

```
realAWSValidator (auth_method="org")
  └─ Organizations.ListAccounts() → []SubscriptionItem (account IDs + names)

Scanner.Scan()
  ├─ If org credentials present:
  │   ├─ DiscoverAccounts() → filter ACTIVE only
  │   ├─ Account fan-out (Semaphore, WaitGroup)
  │   │   ├─ Account A: AssumeRole → scanOneAccount(cfg, accountID)
  │   │   │   ├─ scanRoute53(global)
  │   │   │   └─ scanAllRegions(per-region fan-out)
  │   │   │       ├─ scanRegion() — existing + new resource types
  │   │   ├─ Account B: AssumeRole → scanOneAccount(...)
  │   │   └─ ...
  │   └─ Collect all findings with per-account Source
  └─ If single-account credentials:
      └─ Existing flow (unchanged)
```

## Resource Type Mapping

New AWS resource types and their token categories (matching cloud-object-counter reference):

| Resource | EC2/Route53 API | Category | Tokens/Unit |
|----------|----------------|----------|-------------|
| Elastic IPs | DescribeAddresses | DDI Objects | 25 |
| NAT Gateways | DescribeNatGateways | Managed Assets | 3 |
| Transit Gateways | DescribeTransitGateways | Managed Assets | 3 |
| Internet Gateways | DescribeInternetGateways | DDI Objects | 25 |
| Route Tables | DescribeRouteTables | DDI Objects | 25 |
| Security Groups | DescribeSecurityGroups | DDI Objects | 25 |
| VPN Gateways | DescribeVpnGateways | Managed Assets | 3 |
| IPAM Pools | DescribeIpamPools | DDI Objects | 25 |
| VPC CIDR Blocks | DescribeVpcs (count CIDRs) | DDI Objects | 25 |
| Route53 Health Checks | ListHealthChecks | DDI Objects | 25 |
| Route53 Traffic Policies | ListTrafficPolicies | DDI Objects | 25 |
| Route53 Resolver Endpoints | ListResolverEndpoints | DDI Objects | 25 |

## New Dependency

```
github.com/aws/aws-sdk-go-v2/service/organizations
```

May also need (for Resolver Endpoints):
```
github.com/aws/aws-sdk-go-v2/service/route53resolver
```

## Session / Credential Flow Changes

New fields on `AWSCredentials`:
- `OrgEnabled bool` — flag indicating org scanning mode
- `OrgRoleName string` — role name to assume in each child account (e.g. "OrganizationAccountAccessRole")

Validate auth method `"org"` branch:
1. Use base credentials to call Organizations ListAccounts (us-east-1)
2. Return all ACTIVE accounts as SubscriptionItem
3. Store org-related fields in session
4. Scanner reads `org_role_name` from credentials map, detects multi-account mode

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| AWS SDK Go v2 | Java-only skills found (not relevant) | none found |
| Go testing | affaan-m/everything-claude-code@golang-testing | available (not installed — low relevance for this work) |

## Sources

- AWS Organizations API paginator pattern follows same convention as EC2/S3 paginators (source: [AWS SDK Go v2 docs](https://docs.aws.amazon.com/sdk-for-go/v2/developer-guide/))
- `stscreds.NewAssumeRoleProvider` already used in `buildConfig()` assume-role case — proven pattern for credential refresh (source: codebase analysis)
- STS AssumeRole rate limits: ~46 calls/sec soft limit per AWS account (source: [AWS STS docs](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html))
- Organizations ListAccounts is global (us-east-1 only) — no regional variance (source: [AWS Organizations API reference](https://docs.aws.amazon.com/organizations/latest/APIReference/API_ListAccounts.html))
- Resource category mapping (DDI Objects, Active IPs, Managed Assets) derived from M004 context document and existing codebase `calculator.go` constants
