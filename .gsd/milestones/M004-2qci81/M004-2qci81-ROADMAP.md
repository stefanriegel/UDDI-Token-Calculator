# M004-2qci81: Enterprise-Scale Cloud Scanning

**Vision:** A pre-sales engineer can scan an entire AWS Organization (200+ accounts), full Azure tenant, or GCP org hierarchy in one session — with automatic retry, checkpoint/resume, and comprehensive DNS + resource coverage.

## Success Criteria

- User enters org-level AWS credentials and the tool discovers + scans all child accounts via AssumeRole without manual per-account re-runs
- User authenticates to Azure once and the tool auto-discovers and scans all tenant subscriptions concurrently
- User authenticates to GCP with org-level service account and the tool discovers all projects via folder traversal and scans them in parallel
- API throttling (429) and transient errors (500/502/503/504) trigger automatic retry with exponential backoff instead of scan failure
- A long-running scan interrupted mid-way can resume from checkpoint without re-scanning completed accounts/subscriptions/projects
- DNS findings include per-record-type counts (A, AAAA, CNAME, MX, TXT, SRV, etc.) with supported/unsupported split
- Concurrency limits are configurable per provider via the scan UI
- Token-relevant resource types match cloud-object-counter coverage (Elastic IPs, NAT Gateways, Transit Gateways, Security Groups, etc.)

## Key Risks / Unknowns

- AWS Organizations API permissions — not all customers grant org-level access; must degrade gracefully to single-account with warning
- STS AssumeRole rate limiting under fan-out — 200+ concurrent assume-role calls will hit STS throttle limits; need pacing
- Azure ARM per-principal throttle bucket — 250 tokens with 25/sec refill means ~10 concurrent subscriptions before throttling
- GCP Resource Manager list rate limits — 10 req/sec for v3 APIs; large orgs with 1000+ projects need careful pacing
- Checkpoint format forward-compatibility — must survive tool version upgrades without data loss

## Proof Strategy

- AWS org fan-out rate limiting → retire in S02 by proving 50+ account scan completes with visible retry events and no throttle failures
- Azure ARM throttling under parallel subscriptions → retire in S03 by proving multi-subscription scan with configurable concurrency respects ARM limits
- GCP project discovery at scale → retire in S04 by proving org-wide discovery + scan with paging handles 100+ projects
- Checkpoint durability → retire in S05 by proving interrupted scan resumes correctly from persisted checkpoint

## Verification Classes

- Contract verification: Unit tests for retry logic, checkpoint serialization/deserialization, DNS type splitting, org discovery mocking, resource type counting
- Integration verification: Real AWS/Azure/GCP API calls with retry under throttle conditions; multi-account scan produces combined results
- Operational verification: Long-running scan interruption + checkpoint resume; configurable concurrency affects actual parallelism
- UAT / human verification: Frontend credential forms display org fields correctly; results page shows DNS breakdown and expanded resources

## Milestone Definition of Done

This milestone is complete only when all are true:

- All 7 slice deliverables are complete with passing tests
- Multi-account AWS scanning works end-to-end via org discovery + assume-role fan-out
- Multi-subscription Azure scanning works with auto-discovery + parallel execution
- Multi-project GCP scanning works with org/folder traversal + parallel execution
- Retry infrastructure handles throttle + transient errors across all three providers
- Checkpoint/resume works for interrupted long scans
- DNS findings show per-record-type breakdown with supported/unsupported split
- Frontend credential forms include org/role/project discovery configuration
- All existing tests pass — no regressions in NIOS, AD, Bluecat, EfficientIP flows
- Success criteria are re-checked against live cloud API behavior

## Requirement Coverage

- Covers: R040, R041, R042, R043, R044, R045, R046, R047, R048, R049, R050, R051, R052, R053
- Partially covers: none
- Leaves for later: R054 (K8s probing), R055 (DNS-only mode), R056 (managed IP filtering), R057 (IP dedup)
- Orphan risks: none

## Slices

- [x] **S01: Retry/Backoff Infrastructure + Configurable Scan Parameters** `risk:high` `depends:[]`
  > After this: Scan against a rate-limited API completes with visible retry events in progress stream instead of failing; concurrency limits configurable via scan request
- [x] **S02: AWS Multi-Account Org Scanning + Expanded Resources** `risk:high` `depends:[S01]`
  > After this: User enters org master credentials + role name, tool discovers all child accounts and scans them in parallel with per-account progress and expanded resource coverage
- [x] **S03: Azure Parallel Multi-Subscription + Expanded Resources** `risk:medium` `depends:[S01]`
  > After this: User authenticates once, tool auto-discovers all tenant subscriptions, scans them concurrently with configurable parallelism, shows combined results with expanded resource types
- [x] **S04: GCP Multi-Project Org Discovery + Expanded Resources** `risk:medium` `depends:[S01]`
  > After this: User authenticates with org-level SA, tool discovers all projects via Resource Manager folder traversal, scans in parallel with expanded resource coverage
- [x] **S05: Checkpoint/Resume for Long Scans** `risk:medium` `depends:[S01]`
  > After this: Interrupted 50+ account scan can resume from checkpoint file without re-scanning completed accounts/subscriptions/projects
- [x] **S06: DNS Record Type Breakdown** `risk:low` `depends:[S01]`
  > After this: Results show per-type DNS record counts (A, AAAA, CNAME, MX, TXT, SRV, etc.) with supported/unsupported split across all three cloud providers
- [ ] **S07: Frontend UI Extensions for Multi-Account Scanning** `risk:low` `depends:[S02,S03,S04]`
  > After this: Credential forms include AWS org ID + role name, Azure subscription auto-select with checkboxes, GCP project discovery with selection — all wired to backend multi-account scanning

## Boundary Map

### S01 → S02, S03, S04, S05, S06

Produces:
- `internal/cloudutil/retry.go` — `CallWithBackoff(ctx, fn, opts)` generic retry wrapper with exponential backoff + jitter for throttle (429) and transient (500/502/503/504) errors
- `internal/cloudutil/semaphore.go` — `NewSemaphore(maxWorkers)` configurable concurrency limiter
- `scanner.ScanRequest.MaxWorkers` and `scanner.ScanRequest.RequestTimeout` — configurable scan parameters threaded from API → orchestrator → scanner
- `orchestrator.ScanProviderRequest.MaxWorkers` and `.RequestTimeout` — new fields on the request struct

Consumes:
- nothing (first slice)

### S02 → S07

Produces:
- `internal/scanner/aws/org.go` — `DiscoverAccounts(ctx, cfg)` returning `[]AccountInfo` (account ID, name, status)
- `internal/scanner/aws/scanner.go` updated — multi-account fan-out with per-account assume-role + progress events
- `server/validate.go` updated — AWS validate returns discovered org accounts as SubscriptionItems
- Expanded AWS resource scanners (elastic IPs, NAT gateways, transit gateways, etc.)

Consumes:
- S01 retry infrastructure + configurable concurrency

### S03 → S07

Produces:
- `internal/scanner/azure/subscriptions.go` — `DiscoverSubscriptions(ctx, cred)` returning all tenant subscriptions
- `internal/scanner/azure/scanner.go` updated — multi-subscription parallel fan-out with per-subscription progress
- Expanded Azure resource scanners (NIC IPs, public IPs, NAT gateways, firewalls, etc.)

Consumes:
- S01 retry infrastructure + configurable concurrency

### S04 → S07

Produces:
- `internal/scanner/gcp/projects.go` — `DiscoverProjects(ctx, cred, orgID)` returning all org/folder projects
- `internal/scanner/gcp/scanner.go` updated — multi-project parallel fan-out with per-project progress
- Expanded GCP resource scanners (addresses, firewalls, routers, VPN, GKE CIDRs, etc.)

Consumes:
- S01 retry infrastructure + configurable concurrency

### S05 → (standalone)

Produces:
- `internal/checkpoint/checkpoint.go` — `Save(path, state)` / `Load(path)` / `Resume(state)` for scan progress persistence
- Orchestrator integration — checkpoint written after each account/subscription/project completes

Consumes:
- S01 retry infrastructure (checkpoint wraps around the retry-aware scan loop)

### S06 → (standalone, output visible in results)

Produces:
- Updated `FindingRow.Item` values — `dns_record_A`, `dns_record_AAAA`, `dns_record_CNAME`, etc. instead of generic `dns_record`
- `internal/scanner/aws/route53.go`, `internal/scanner/azure/dns.go`, `internal/scanner/gcp/dns.go` updated — per-type counting
- `internal/cloudutil/dns.go` — shared `SupportedDNSTypes` / `UnsupportedDNSTypes` sets

Consumes:
- S01 retry infrastructure (DNS API calls use retry wrapper)

### S07 → (frontend-only, consumes all backend slices)

Produces:
- Updated credential forms in `frontend/src/wizard.tsx` — AWS org fields, Azure subscription checkboxes, GCP project discovery
- Updated `frontend/src/api-client.ts` — new validate response handling for multi-account discovery
- Updated `frontend/src/use-backend.ts` — state management for discovered accounts/subscriptions/projects

Consumes:
- S02 AWS org discovery validate endpoint + SubscriptionItems
- S03 Azure subscription discovery validate endpoint + SubscriptionItems
- S04 GCP project discovery validate endpoint + SubscriptionItems
