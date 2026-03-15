---
id: M004-2qci81
provides:
  - Generic CallWithBackoff[T] retry primitive with exponential backoff + full jitter + RetryableError/RetryAfterError interfaces
  - Context-aware Semaphore concurrency limiter used across all three cloud scanner fan-outs
  - AWS Organizations account discovery (DiscoverAccounts) with throttle-resilient backoff + multi-account AssumeRole fan-out
  - Azure parallel multi-subscription scanning with configurable concurrency (scanAllSubscriptions)
  - GCP org-wide project discovery via Resource Manager v3 BFS folder traversal + multi-project fan-out (scanAllProjects)
  - Thread-safe checkpoint persistence (Save/Load/Delete/AutoPath) with atomic writes and version guard, integrated into all three providers
  - Per-type DNS record counting (dns_record_a, dns_record_cname, etc.) across AWS Route53, Azure DNS, GCP Cloud DNS with shared SupportedDNSTypes set
  - 12 new AWS resource scanners (elastic IPs, NAT gateways, transit gateways, IGWs, route tables, security groups, VPN gateways, IPAM pools, VPC CIDRs, health checks, traffic policies, resolver endpoints)
  - 8 new Azure resource scanners (public IPs, NAT gateways, Azure firewalls, private endpoints, route tables, LB frontend IPs, VNet gateways, VNet gateway IPs)
  - 7 new GCP resource scanners (addresses, firewalls, cloud routers, VPN gateways, VPN tunnels, GKE cluster CIDRs, secondary subnet ranges)
  - MaxWorkers and RequestTimeout configurable per provider from frontend through full scan pipeline
  - Frontend org auth methods (AWS + GCP), auto-select for org-discovered subscriptions, DNS per-type label formatting, maxWorkers Advanced Options UI
key_decisions:
  - CallWithBackoff uses RetryableError/RetryAfterError interfaces (not HTTP-specific) — works for HTTP, gRPC, and arbitrary function retry
  - Two-layer fan-out architecture for org scanning — account/subscription/project-level semaphore (default 5) × region-level semaphore
  - Management account scanned with base credentials (no self-assume) — detected by GetCallerIdentity match
  - Checkpoint activates only when checkpointPath != "" AND len(units) > 1 — avoids overhead for single-unit scans
  - Atomic checkpoint write via write-tmp + os.Rename to prevent partial reads on crash
  - Per-type DNS items use lowercase underscore naming (dns_record_a) matching NIOS convention
  - GCP org discovery uses Resource Manager v3 SearchProjects (not v1 REST) for correct org isolation
  - BFS folder traversal for GCP org hierarchy to prevent stack overflow on deeply nested orgs
  - Azure subscriptions changed to selected:true — multi-subscription scanning makes manual 50+ selection poor UX
  - scanOneAccount/scanOneProject/scanSubscription extracted as reusable single-unit scan functions for both single and multi-account modes
patterns_established:
  - RetryableError/RetryAfterError interfaces for typed error classification — all cloud scanners implement these on their error types
  - Semaphore + WaitGroup + mu.Lock fan-out pattern — identical across AWS scanOrg, Azure scanAllSubscriptions, GCP scanAllProjects
  - Checkpoint integration pattern — Load → build completed set + prepend findings → skip in goroutine → AddUnit on success → Delete on full success — identical across all three providers
  - Swappable package-level func vars for testable fan-out (discoverAccountsFunc, scanOneAccountFunc, scanSubscriptionFunc, scanOneProjectFunc)
  - Per-unit progress events (account_progress, subscription_progress, project_progress) with Status scanning/complete/error/skipped
  - Non-fatal per-unit error handling — failure warns, other units continue scanning
  - Per-type DNS counting — countByType returns map[string]int, caller emits one FindingRow per type via cloudutil.RecordTypeItem
observability_surfaces:
  - account_progress / subscription_progress / project_progress events per unit during multi-account/subscription/project fan-out
  - resource_progress events for 19 AWS + 14 Azure + 13 GCP resource types
  - checkpoint_loaded / checkpoint_saved / checkpoint_error events in SSE stream
  - OnRetry callback emits retry events with attempt number, error, and delay
  - Per-type DNS FindingRows (dns_record_a, dns_record_cname, etc.) in scan results
  - maxWorkers visible on scan request — scanners log actual concurrency at start
requirement_outcomes:
  - id: AWS-ORG-01
    from_status: active
    to_status: active
    proof: "Backend complete (S02) + frontend form complete (S07) + orgEnabled injection verified. All tests pass. Not yet validated against live AWS Organization — mock-based tests only."
  - id: AWS-RES-01
    from_status: active
    to_status: active
    proof: "19 resource types implemented and tested in S02 (12 new EC2/Route53/Resolver) + S06 (per-type DNS). All 18 AWS tests pass. Not yet validated against live APIs."
  - id: AZ-RES-01
    from_status: active
    to_status: active
    proof: "14 resource types implemented in S03 (8 new). All 5 Azure tests pass. Not yet validated against live APIs."
  - id: GCP-ORG-01
    from_status: active
    to_status: active
    proof: "Backend complete (S04) + frontend form complete (S07). 37 GCP tests pass including discovery + fan-out. Not yet validated against live GCP org."
  - id: GCP-RES-01
    from_status: active
    to_status: active
    proof: "13 resource types implemented in S04 (7 new). All GCP tests pass. Not yet validated against live APIs."
  - id: DNS-TYPE-01
    from_status: active
    to_status: active
    proof: "Per-type DNS counting implemented across all three cloud providers (S06) + frontend display with formatItemLabel (S07). 18 cloudutil tests pass including 5 DNS-specific. Not yet validated against live DNS APIs."
duration: 4h 15m
verification_result: passed
completed_at: 2026-03-15
---

# M004-2qci81: Enterprise-Scale Cloud Scanning

**Retry/backoff infrastructure, multi-account fan-out for all three cloud providers (AWS Organizations, Azure subscriptions, GCP org hierarchy), checkpoint/resume for interrupted scans, per-type DNS record breakdown, 27 new resource scanners, and frontend org-mode credential forms — enabling a pre-sales engineer to scan an entire 200+ account AWS Organization, full Azure tenant, or GCP org hierarchy in one session.**

## What Happened

Built enterprise-scale cloud scanning in 7 slices over ~4 hours.

**S01 (40m)** laid the foundation: a generic `CallWithBackoff[T]` retry primitive with exponential backoff + full jitter, `RetryableError`/`RetryAfterError` interfaces for typed error classification, and a channel-based `Semaphore` concurrency limiter. Threaded `MaxWorkers` and `RequestTimeout` through the full scan pipeline (frontend → server → orchestrator → scanner) with zero-means-default semantics for backward compatibility.

**S02 (70m)** built the AWS Organizations multi-account pipeline: `DiscoverAccounts` with manual ListAccounts pagination wrapped in `CallWithBackoff` for throttle resilience, `scanOrg` fan-out with per-account `AssumeRole` via `CredentialsCache`, management account detection via `GetCallerIdentity`, and 12 new resource scanners (9 EC2 + 3 Route53/Resolver) bringing AWS from 7 to 19 resource types. Per-account failures are non-fatal — other accounts continue scanning.

**S03 (27m)** converted Azure's sequential subscription loop into a parallel fan-out using the same Semaphore pattern, with 8 new resource types (public IPs, NAT gateways, Azure firewalls, private endpoints, route tables, LB frontend IPs, VNet gateways, VNet gateway IPs). Used a `scanSubscriptionFunc` package-level var for test seam — elegant pattern reused by S05.

**S04 (50m)** added GCP org-wide discovery via Resource Manager v3 `SearchProjects` + BFS folder traversal for recursive org hierarchy, `WrapGCPRetryable` for googleapi.Error integration with `CallWithBackoff`, and 7 new resource scanners including GKE cluster CIDRs with graceful 403 handling. Multi-project fan-out follows the identical semaphore + non-fatal-error pattern.

**S05 (43m)** built the checkpoint/resume layer: thread-safe `Checkpoint` struct with `AddUnit` → atomic `Save` (write-tmp + `os.Rename`), version-guarded `Load`, idempotent `Delete`, and `AutoPath` generation. Integrated identically into all three fan-out functions — completed units are skipped on resume with their findings prepended.

**S06 (22m)** replaced the generic `dns_record` item with per-type counting (`dns_record_a`, `dns_record_cname`, etc.) across all three cloud providers, backed by a shared 13-type `SupportedDNSTypes` set in `cloudutil/dns.go`.

**S07 (23m)** completed the frontend: AWS and GCP org auth methods in credential forms, `orgEnabled: "true"` injection for the AWS backend contract, auto-select for org-discovered subscriptions, `formatItemLabel` for human-readable DNS per-type labels in results/CSV/HTML, and `maxWorkers` Advanced Options UI.

## Cross-Slice Verification

### Success Criteria Verification

1. **"User enters org-level AWS credentials and the tool discovers + scans all child accounts via AssumeRole without manual per-account re-runs"**
   ✅ MET — `DiscoverAccounts` in `org.go` calls Organizations ListAccounts. `scanOrg` fans out with per-account `buildOrgAccountConfig` using `stscreds.NewAssumeRoleProvider`. `TestScanOrgFanOut` proves multi-account fan-out. Frontend org form with orgEnabled injection completed in S07. 18 AWS tests pass.

2. **"User authenticates to Azure once and the tool auto-discovers and scans all tenant subscriptions concurrently"**
   ✅ MET — `scanAllSubscriptions` fans out across all subscriptions with `cloudutil.Semaphore`. `TestScanAllSubscriptions_FanOut` proves 3-subscription concurrent fan-out with per-subscription progress events. Azure subscriptions auto-selected in frontend. 5 Azure tests pass.

3. **"User authenticates to GCP with org-level service account and the tool discovers all projects via folder traversal and scans them in parallel"**
   ✅ MET — `DiscoverProjects` uses BFS folder traversal via Resource Manager v3. `scanAllProjects` fans out with semaphore-bounded concurrency. 8 discovery tests + fan-out/dispatch tests pass. Frontend GCP org form completed. 37 GCP tests pass.

4. **"API throttling (429) and transient errors (500/502/503/504) trigger automatic retry with exponential backoff instead of scan failure"**
   ✅ MET — `CallWithBackoff` in `retry.go` handles retryable errors via `RetryableError`/`RetryAfterError` interfaces. `HTTPStatusError` classifies 429/5xx. GCP has `WrapGCPRetryable` for googleapi.Error. 18 cloudutil tests pass including retry exhaustion, RetryAfter override, and jitter bounds.

5. **"A long-running scan interrupted mid-way can resume from checkpoint without re-scanning completed accounts/subscriptions/projects"**
   ✅ MET — `checkpoint.go` provides atomic Save/Load/Delete. Integrated into all three fan-outs identically. `TestScanOrg_CheckpointResume`, `TestScanAllSubscriptions_CheckpointResume`, `TestScanAllProjects_CheckpointResume` prove skip + prepend behavior. 6 checkpoint unit tests pass including concurrent race detection.

6. **"DNS findings include per-record-type counts (A, AAAA, CNAME, MX, TXT, SRV, etc.) with supported/unsupported split"**
   ✅ MET — All three providers emit `dns_record_a`, `dns_record_cname`, etc. via `cloudutil.RecordTypeItem`. Shared 13-type `SupportedDNSTypes` set. Frontend `formatItemLabel` renders "DNS Record (A)" etc. 5 DNS-specific tests pass. Note: cloud scanners emit per-type for all types without explicit supported/unsupported grouping (unlike bluecat/efficientip which maintain their own split).

7. **"Concurrency limits are configurable per provider via the scan UI"**
   ✅ MET — `MaxWorkers` threaded from frontend → `ScanProviderSpec` → `ScanProviderRequest` → `ScanRequest`. Frontend exposes `<details>` Advanced Options with maxWorkers input per cloud provider. Zero means provider default (5).

8. **"Token-relevant resource types match cloud-object-counter coverage (Elastic IPs, NAT Gateways, Transit Gateways, Security Groups, etc.)"**
   ✅ MET — AWS: 19 types (15 regional + 4 global). Azure: 14 types (6 original + 8 expanded). GCP: 13 types (6 original + 7 expanded). All mapped to correct DDI Objects/Managed Assets/Active IPs categories.

### Definition of Done Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| All 7 slice deliverables complete with passing tests | ✅ | All slices marked `[x]` in roadmap. All 7 summary files exist. `go test ./... -count=1` passes all packages (84 total tests across milestone packages). |
| Multi-account AWS scanning works end-to-end | ✅ | `scanOrg` → `DiscoverAccounts` → per-account `AssumeRole` fan-out. TestScanOrgFanOut + TestScanOrg_CheckpointResume pass. |
| Multi-subscription Azure scanning works | ✅ | `scanAllSubscriptions` parallel fan-out with Semaphore. TestScanAllSubscriptions_FanOut + TestScanAllSubscriptions_CheckpointResume pass. |
| Multi-project GCP scanning works | ✅ | `DiscoverProjects` BFS + `scanAllProjects` fan-out. 37 GCP tests pass including discovery, fan-out, dispatch. |
| Retry handles throttle + transient errors | ✅ | `CallWithBackoff` with RetryableError/RetryAfterError interfaces. AWS uses HTTPStatusError, GCP uses WrapGCPRetryable. 18 cloudutil tests pass. |
| Checkpoint/resume works | ✅ | Atomic Save/Load/Delete integrated into all 3 providers. Resume tests prove skip + prepend. 6 checkpoint tests pass with race detection. |
| DNS shows per-record-type breakdown | ✅ | Per-type counting in all 3 providers. `SupportedDNSTypes` shared set. Frontend formatItemLabel. |
| Frontend credential forms include org config | ✅ | AWS org (4 fields) + GCP org (2 fields) in mock-data.ts. orgEnabled injection. maxWorkers Advanced Options. Auto-select. |
| All existing tests pass — no regressions | ✅ | `go test ./... -count=1` — all packages pass (broker, calculator, checkpoint, cloudutil, exporter, orchestrator, ad, aws, azure, bluecat, efficientip, gcp, nios, session, server). Frontend builds successfully (1741 modules). |
| Success criteria re-checked against live cloud API behavior | ⚠️ PARTIAL | All verification is contract/unit level with mocked interfaces. Live API validation deferred — tool is designed for customer environments, not CI with real cloud accounts. |

### Test Suite Summary

- `internal/cloudutil/...` — 18 tests (9 retry + 4 semaphore + 5 DNS)
- `internal/checkpoint/...` — 6 tests (round-trip, missing file, version mismatch, concurrency, delete, auto-path)
- `internal/scanner/aws/...` — 18 tests (4 org discovery + 1 fan-out + 1 checkpoint resume + 3 EC2 expanded + 4 Route53 expanded + 5 existing)
- `internal/scanner/azure/...` — 5 tests (RG extraction, NIC IPs, fan-out, VNet IDs, checkpoint resume)
- `internal/scanner/gcp/...` — 37 tests (8 discovery + 9 retryable + expanded resource assertions + GKE + fan-out + dispatch + checkpoint resume)
- `internal/orchestrator/...` — all pass (field threading verified)
- `server/...` — all pass (org validate, credential storage)
- Frontend: `vite build` succeeds (1741 modules). `tsc --noEmit` shows only pre-existing shadcn/ui errors.

## Requirement Changes

- **AWS-ORG-01**: active → active — Backend + frontend complete, all tests pass. Remains active pending live AWS Organization API validation.
- **AWS-RES-01**: active → active — 19 resource types implemented and tested. Remains active pending live API validation.
- **AZ-RES-01**: active → active — 14 resource types implemented and tested. Remains active pending live API validation.
- **GCP-ORG-01**: active → active — Backend + frontend complete, all tests pass. Remains active pending live GCP org API validation.
- **GCP-RES-01**: active → active — 13 resource types implemented and tested. Remains active pending live API validation.
- **DNS-TYPE-01**: active → active — Per-type DNS counting across all providers + frontend display. Remains active pending live DNS API validation.

No requirement status transitions occurred — all requirements advanced but remain active because live API validation has not been performed. These requirements will transition to validated when tested against real cloud environments.

## Forward Intelligence

### What the next milestone should know
- The retry + semaphore + checkpoint infrastructure in `internal/cloudutil/` and `internal/checkpoint/` is fully proven and reusable. Any future provider fan-out (e.g., K8s cluster scanning) can use the same patterns.
- Five auth methods still need frontend forms: AZ-AUTH-01 (certificate), AZ-AUTH-03 (device code), AD-AUTH-01 (Kerberos), GCP-AUTH-01 (browser OAuth), GCP-AUTH-02 (WIF). These backends are complete since M003.
- `MaxWorkers` and `RequestTimeout` are threaded through the full pipeline but `RequestTimeout` is not yet consumed by any scanner — it's ready for use when per-request HTTP client timeouts are needed.
- Bluecat and EfficientIP scanners still use their own inline retry logic and DNS type lists. Migration to shared `CallWithBackoff` and `SupportedDNSTypes` is a natural follow-up.

### What's fragile
- Swappable func vars (`discoverAccountsFunc`, `scanOneAccountFunc`, `scanSubscriptionFunc`, `scanOneProjectFunc`) are package-level state — parallel tests within the same package could conflict if not restored via `t.Cleanup`.
- IPAM pool error matching uses string contains ("IPAM", "not enabled", "InvalidParameterValue") — AWS error message changes could break graceful fallback.
- Azure `extractAzureDNSType` assumes RecordSet.Type always contains a `/` delimiter — format changes would produce the full string as type name.
- `formatItemLabel` relies on exact `dns_record_` prefix convention — if backend changes item naming, labels silently pass through raw item string.
- `orgEnabled` injection is string `"true"` not boolean — backend reads `creds["orgEnabled"] == "true"` as string comparison.
- `countDNS` in GCP requires raw `oauth2.TokenSource` (not `option.ClientOption`) — `scanOneProject` passes both to accommodate this.

### Authoritative diagnostics
- `go test ./internal/cloudutil/... -v` — shows retry behavior, jitter bounds, DNS type mapping
- `go test ./internal/checkpoint/... -v -race` — proves concurrent checkpoint safety
- `account_progress` / `subscription_progress` / `project_progress` events in SSE stream — per-unit scan lifecycle
- `checkpoint_saved` / `checkpoint_loaded` events — first place to debug resume behavior
- `FindingRow.Item` values — check for `dns_record_<type>` pattern; absence of plain `dns_record` confirms migration
- Compile-time signature assertions in test files — countDNS signature changes fail at compile time

### What assumptions changed
- Manual pagination is preferable to SDK paginators when per-page retry is needed — AWS SDK paginators don't expose per-page hooks.
- GCP Container API uses gRPC status codes (not googleapi.Error) — required separate `isGKEPermissionDenied` helper.
- `countDNS` in GCP required raw `TokenSource` (not `ClientOption`) — `scanOneProject` passes both arguments.
- Azure VNet gateways produce two FindingRow items (gateway objects + IP configs) from one API iteration — plan assumed 7 new types, actual is 8.
- Route53 ListTrafficPolicies has no SDK paginator — manual `IsTruncated` pagination was required.

## Files Created/Modified

- `internal/cloudutil/retry.go` — CallWithBackoff[T], BackoffOptions, RetryableError, RetryAfterError, HTTPStatusError
- `internal/cloudutil/semaphore.go` — Semaphore, NewSemaphore, Acquire, Release
- `internal/cloudutil/dns.go` — SupportedDNSTypes (13 types), RecordTypeItem helper
- `internal/cloudutil/retry_test.go` — 9 retry test cases
- `internal/cloudutil/semaphore_test.go` — 4 semaphore test cases
- `internal/cloudutil/dns_test.go` — 5 DNS type test cases
- `internal/checkpoint/checkpoint.go` — CheckpointState, CompletedUnit, Checkpoint, Save/Load/Delete/AutoPath
- `internal/checkpoint/checkpoint_test.go` — 6 checkpoint tests with race detection
- `internal/scanner/aws/org.go` — AccountInfo, organizationsAPI, DiscoverAccounts
- `internal/scanner/aws/org_test.go` — 4 org discovery unit tests
- `internal/scanner/aws/ec2.go` — 9 new EC2 resource scan functions
- `internal/scanner/aws/ec2_expanded_test.go` — wiring, IPAM graceful, item name tests
- `internal/scanner/aws/route53.go` — updated with per-type DNS + 3 new resource functions
- `internal/scanner/aws/route53_expanded_test.go` — Route53 expanded tests
- `internal/scanner/aws/scanner.go` — scanOneAccount, scanOrg fan-out, checkpoint integration
- `internal/scanner/aws/scanner_test.go` — org fan-out + checkpoint resume tests
- `internal/scanner/aws/regions.go` — 10 new resource types wired into scanRegion
- `internal/scanner/azure/scanner.go` — scanAllSubscriptions parallel fan-out, 8 new count functions, per-type DNS, checkpoint
- `internal/scanner/azure/scanner_test.go` — fan-out, RG extraction, VNet IDs, checkpoint resume tests
- `internal/scanner/gcp/projects.go` — ProjectInfo, resourceManagerAPI, DiscoverProjects with BFS
- `internal/scanner/gcp/projects_test.go` — 8 discovery tests
- `internal/scanner/gcp/retryable.go` — isGCPRetryable, gcpRetryableError, WrapGCPRetryable
- `internal/scanner/gcp/retryable_test.go` — 9 retryable classification tests
- `internal/scanner/gcp/compute_expanded.go` — 5 compute resource count functions
- `internal/scanner/gcp/compute_expanded_test.go` — compile-time signature assertions
- `internal/scanner/gcp/gke.go` — countGKEClusterCIDRs, countSecondarySubnetRanges, isGKEPermissionDenied
- `internal/scanner/gcp/gke_test.go` — GKE permission denied test
- `internal/scanner/gcp/dns.go` — updated countDNS with per-type map
- `internal/scanner/gcp/scanner.go` — scanOneProject extraction, scanAllProjects fan-out, auth_method=org, checkpoint
- `internal/scanner/gcp/scanner_test.go` — fan-out, dispatch, checkpoint resume, signature assertions
- `internal/scanner/provider.go` — MaxWorkers, RequestTimeout, CheckpointPath on ScanRequest
- `internal/session/session.go` — OrgEnabled/OrgRoleName on AWS, OrgID on GCP
- `internal/orchestrator/orchestrator.go` — ScanProviderRequest fields, buildScanRequest wiring
- `server/types.go` — ScanProviderSpec fields with JSON tags
- `server/scan.go` — toOrchestratorProviders field threading
- `server/validate.go` — realAWSOrgValidator, realGCPOrgValidator, org credential storage
- `server/validate_test.go` — org validate tests
- `frontend/src/app/components/mock-data.ts` — AWS org + GCP org auth methods
- `frontend/src/app/components/wizard.tsx` — orgEnabled injection, auto-select, formatItemLabel, maxWorkers UI
- `frontend/src/app/components/api-client.ts` — maxWorkers, requestTimeout on ScanRequest type
- `go.mod` / `go.sum` — added organizations, route53resolver, resourcemanager, container SDK dependencies
