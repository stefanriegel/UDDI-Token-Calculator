# M004-2qci81: Enterprise-Scale Cloud Scanning — Context

**Gathered:** 2026-03-15
**Status:** Ready for planning

## Project Description

Harden the UDDI-GO Token Calculator's cloud scanning (AWS, Azure, GCP) for enterprise-scale environments by adding multi-account/subscription/project scanning with auto-discovery, throttle-aware retry with exponential backoff, checkpoint/resume for long scans, DNS record type breakdown, configurable concurrency, and expanded token-relevant resource type coverage.

## Why This Milestone

The tool is handed to pre-sales engineers scanning customer environments that range from a few accounts to 200+ AWS accounts in an Organization, dozens of Azure subscriptions in a tenant, and multi-project GCP organizations. The current single-account scanning model with no retry infrastructure can't handle that scale reliably. Two reference Python implementations (cloud-object-counter and Infoblox-Universal-DDI-cloud-usage) have solved these problems — we need parity in Go.

## User-Visible Outcome

### When this milestone is complete, the user can:

- Enter org-level AWS credentials + role name and scan all child accounts automatically
- Authenticate to Azure once and have the tool discover + scan all tenant subscriptions
- Authenticate to GCP with an org-level service account and scan all discoverable projects
- See retry progress when API rate limiting occurs instead of scan failures
- Resume an interrupted multi-account scan from where it left off
- See per-DNS-record-type breakdown (A, AAAA, CNAME, MX, etc.) in results
- Configure concurrency limits per provider via the UI

### Entry point / environment

- Entry point: Browser UI at `http://127.0.0.1:<port>` (auto-opened on launch)
- Environment: Windows desktop (primary), macOS/Linux dev
- Live dependencies involved: AWS Organizations + STS, Azure Resource Manager, GCP Resource Manager, all three cloud provider APIs

## Completion Class

- Contract complete means: Unit tests cover retry logic, checkpoint serialization, multi-account fan-out, DNS type splitting. Mock-based tests verify org discovery → assume-role → scan flow.
- Integration complete means: Real cloud API calls succeed with retry on throttle, multi-account scanning produces combined results, checkpoint files survive process restart.
- Operational complete means: 100+ account AWS org scan completes successfully; interrupted scan resumes from checkpoint.

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- A multi-account AWS scan with org discovery, assume-role fan-out, and retry produces correct combined token results
- An Azure multi-subscription scan with auto-discovery produces per-subscription findings aggregated into a single result
- A GCP multi-project scan with org/folder traversal discovers and scans all projects
- An interrupted scan checkpoint can be loaded and scanning resumes from the correct point
- DNS record type breakdown shows in results with supported/unsupported split
- All existing tests still pass — no regressions in NIOS, AD, Bluecat, EfficientIP flows

## Risks and Unknowns

- AWS Organizations API permissions — not all customer environments have org-level access; must gracefully degrade to single-account mode
- STS AssumeRole rate limiting — 8 req/sec for ListAccounts; fan-out across 200+ accounts needs pacing
- Azure ARM throttling — subscription-level token bucket (250 tokens, 25/sec refill); parallel subscription scanning must respect per-principal limits
- GCP Resource Manager rate limits — 10 req/sec for v3 list operations; project count in large orgs can be thousands
- Checkpoint file format stability — needs to be forward-compatible across tool versions
- Frontend complexity — org/role/project discovery UI must not overwhelm the simple wizard flow

## Existing Codebase / Prior Art

- `internal/scanner/provider.go` — Scanner interface with `Scan(ctx, ScanRequest, publish)` signature
- `internal/orchestrator/orchestrator.go` — Fan-out via sync.WaitGroup with partial failure tolerance (RES-01)
- `internal/scanner/aws/scanner.go` — AWS scanner with `maxConcurrentRegions=5` semaphore, per-region goroutines
- `internal/scanner/azure/scanner.go` — Azure scanner with subscription-level scanning, parallel DNS/Network goroutines
- `internal/scanner/gcp/scanner.go` — GCP scanner with sequential resource scanning per project
- `internal/session/session.go` — Session store with provider progress tracking
- `internal/calculator/calculator.go` — FindingRow + TokenResult + Calculate() aggregation
- `server/scan.go` — HTTP handlers for scan lifecycle (start → status → results)
- `server/validate.go` — Credential validation endpoints returning SubscriptionItems for source selection
- Reference: `IngmarVG-IB/cloud-object-counter` — Python tool with `_call_with_backoff`, `ThreadPoolExecutor`, checkpoint JSON, org-wide discovery
- Reference: `stefanriegel/Infoblox-Universal-DDI-cloud-usage` — Python tool with IP dedup and managed-service filtering

> See `.gsd/DECISIONS.md` for all architectural and pattern decisions — it is an append-only register; read it during planning, append to it during execution.

## Relevant Requirements

- R040–R053 — All active M004 requirements (multi-account, retry, checkpoint, DNS breakdown, expanded resources, UI)
- AZ-AUTH-01, AZ-AUTH-03, AD-AUTH-01, GCP-AUTH-01, GCP-AUTH-02 — Existing active requirements (frontend forms) are NOT in M004 scope

## Scope

### In Scope

- AWS Organizations API integration for account discovery + STS AssumeRole fan-out
- Azure subscription auto-discovery via ARM + parallel multi-subscription scanning
- GCP project auto-discovery via Resource Manager org/folder traversal + parallel multi-project scanning
- Retry with exponential backoff + jitter for throttle (429) and transient (500/502/503/504) errors across all providers
- Checkpoint/resume mechanism for long-running multi-account scans
- DNS record type breakdown (supported vs unsupported, per-type counts) for all three cloud providers
- Configurable concurrency limits (max_workers per provider) via scan API + UI
- Configurable request timeouts per provider
- Expanded AWS resource types: Elastic IPs, NAT Gateways, Transit Gateways, IGWs, Route Tables, Security Groups, VPN Gateways, IPAM Pools, VPC CIDR blocks, Route53 Health Checks/Traffic Policies/Resolver Endpoints
- Expanded Azure resource types: NIC IP Configs, LB Frontend IPs, VNet Gateway IPs, Private Endpoints, Public IPs, NAT Gateways, Application Gateways, Firewalls
- Expanded GCP resource types: Compute Addresses, Firewalls, Cloud Routers, VPN Gateways/Tunnels, Secondary Subnetworks, GKE cluster CIDR ranges
- Frontend UI extensions for org ID, role name, project discovery, subscription auto-select

### Out of Scope / Non-Goals

- GKE/EKS/AKS Kubernetes API probing for pod/service IPs (deferred to future milestone)
- `--subset dns` DNS-only scan mode
- Managed-service IP filtering (exclude EKS/AKS/GKE managed IPs)
- IP deduplication by network space
- Storage resource counting (S3, Azure Storage, GCP Cloud Storage)
- CloudShell credential expiry guard (Python-specific)
- Frontend auth forms for existing pending methods (AZ-AUTH-01, AZ-AUTH-03, etc.)

## Technical Constraints

- CGO_ENABLED=0 mandatory — no cgo-dependent retry/rate-limit libraries
- AWS SDK Go v2 has built-in retry but we need additional backoff for org-level fan-out pacing
- Azure SDK for Go azcore pipeline handles 429 natively but we need cross-subscription rate coordination
- GCP Go client libraries handle retry internally but we need project-level fan-out pacing
- Checkpoint files must be JSON — portable, human-readable, forward-compatible
- New go.mod dependencies needed: `aws-sdk-go-v2/service/organizations`, potentially `cloud.google.com/go/resourcemanager`

## Integration Points

- AWS Organizations API — ListAccounts, ListAccountsForParent (us-east-1 only)
- AWS STS — AssumeRole for cross-account credential fan-out
- Azure Resource Manager — armsubscriptions.Client for tenant subscription listing
- GCP Resource Manager — cloudresourcemanager.ProjectsClient / FoldersClient for org traversal
- Existing scanner.Scanner interface — must remain backward compatible
- Existing orchestrator.Orchestrator — fan-out model must extend to support multi-account within a single provider
- Existing session.Session — must track per-account/subscription/project progress
- Frontend wizard — credential forms need new fields without breaking existing flow

## Open Questions

- Checkpoint file location — os.TempDir() or user-configurable? Leaning TempDir for zero-config.
- Org discovery fallback — if Organizations ListAccounts fails (no permissions), should we silently fall back to single-account? Leaning yes with a warning event.
- Azure cross-subscription rate coordination — global semaphore or per-subscription? Leaning global semaphore matching AWS pattern.
