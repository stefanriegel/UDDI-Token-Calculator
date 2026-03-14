# UDDI-GO Token Calculator

## Current Milestone: v2.1 — Auth Method Completion

**Goal:** Implement or gracefully handle all 9 unimplemented auth methods across AWS, Azure, GCP, and AD providers — eliminating silent mismatches, confusing fall-through errors, and "Coming soon" stubs.

**Target features:**
- AD: Kerberos and PowerShell Remoting auth methods (currently silently fall through to NTLM)
- Azure: Certificate-based and az-cli auth methods (currently produce confusing errors)
- GCP: Browser OAuth and Workload Identity Federation auth methods (currently produce confusing errors)
- AWS: CLI Profile and Assume Role (Cross-Account) auth methods (currently return "Coming soon")
- Azure: Device Code Flow auth method (currently returns "Coming soon")

## What This Is

A Go single-binary tool that estimates Infoblox Universal DDI management tokens by scanning cloud infrastructure (AWS, Azure, GCP), Active Directory environments (via WinRM), and NIOS Grid backups. The binary embeds a React web UI that auto-opens in the browser on launch and exports results as Excel. Distributed as a Windows `.exe` — no runtime, no setup, no Python venv required.

The tool ships with SSO/browser-OAuth for AWS and Azure as additional auth methods alongside static credentials, multi-DC concurrent AD scanning with cross-DC deduplication, re-scan capability without re-entering credentials, and a streaming `.xlsx` export with per-provider breakdown and error traceability.

## Core Value

A pre-sales engineer can hand this `.exe` to any customer and get an accurate token estimate in one double-click — no installation, no Python, no complex setup.

## Requirements

### Validated

- ✓ Single Go binary with embedded web UI (embed.FS) that auto-opens browser on launch — v1.0
- ✓ AWS discovery: VPCs, subnets, Route53 zones/records, EC2 instances, load balancers — v1.0
- ✓ Azure discovery: VNets, subnets, DNS zones/records, VMs, load balancers, gateways — v1.0
- ✓ GCP discovery: VPC networks, subnets, Cloud DNS zones/records, compute instances — v1.0
- ✓ AD discovery via WinRM: DNS zones/records, DHCP scopes/leases, user accounts (NTLM) — v1.0
- ✓ Token calculation: DDI Objects (25/token), Active IPs (13/token), Managed Assets (3/token) — v1.0
- ✓ Excel export (.xlsx) with per-provider breakdown and error traceability — v1.0
- ✓ GitHub Actions CI pipeline that builds `.exe` via GoReleaser OSS v2 — v1.0
- ✓ Credentials entered via web UI (not CLI flags) — never written to disk — v1.0
- ✓ SSO / browser-OAuth for AWS (SSO) and Azure (browser MSAL flow) — v1.0 (quick tasks)
- ✓ Re-scan capability via session clone — no credential re-entry — v1.0 (quick task 10)
- ✓ Multi-DC concurrent AD scanning with cross-DC deduplication — v1.0

### Active

- [ ] AD Kerberos auth via WinRM (implemented in S02 — pure Go gokrb5, frontend form pending)
- [ ] AD PowerShell Remoting auth via WinRM (currently silently uses NTLM, ignores useSSL)
- [ ] Azure Certificate-based Service Principal auth (implemented in S02 — backend complete, frontend form pending)
- [ ] Azure az-cli auth (currently falls through requiring tenantId/clientId/clientSecret)
- [ ] Azure Device Code Flow auth (implemented in S02 — backend complete, frontend display pending)
- [ ] GCP Browser OAuth auth (currently falls through to service account JSON)
- [ ] GCP Workload Identity Federation auth (currently falls through to service account JSON)
- [ ] AWS CLI Profile auth (currently returns "Coming soon")
- [ ] AWS Assume Role (Cross-Account) auth (currently returns "Coming soon")

### Out of Scope

- NIOS Grid backup analysis — dropped in Go rewrite; cloud+AD is the v1 scope
- macOS/Linux binaries for v1 — Windows `.exe` is the distribution target (v2 PLT-01/PLT-02)
- Real-time/scheduled scanning — on-demand only; contradicts single-binary hand-off model
- Infoblox BloxOne API integration — this tool feeds into sales, not into the product
- Multi-user sharing — share the Excel file or the binary
- PDF export — Excel is sufficient; PDF adds a rendering dependency

## Context

**Shipped v1.0** — 2026-03-09
- 8 phases, 27 plans, 13 quick tasks across 2 days
- ~4,800 LOC Go, ~8,000 LOC TypeScript (frontend + tests)
- 81 commits

**Tech stack:** Go 1.24+, chi v5, HTMX+React+Vite, embed.FS, excelize v2.10.1, masterzen/winrm, dpotapov/winrm-auth-ntlm, aws-sdk-go-v2, azure-sdk-for-go (azidentity, armnetwork, armdns, armcompute), google-cloud-go, GoReleaser OSS v2

**Known tech debt:**
- DIST-02: Binary unsigned — customers see SmartScreen "More info → Run anyway". Signing via DigiCert/Sectigo/SignPath.io deferred to v2 (Azure Artifact Signing unavailable in Germany)
- AD-02: Kerberos implemented — pure Go gokrb5 with programmatic krb5.conf (no domain-joined machine required); frontend form pending

**Binary size:** ~30MB stripped (-s -w) with all 3 cloud SDKs

## Constraints

- **Platform**: Windows `.exe` primary target — cross-compiled from macOS/Linux CI
- **No runtime**: Binary must be fully self-contained (embed.FS for UI assets)
- **Credentials**: Must never be persisted to disk — in-memory only for scan duration
- **SDKs**: aws-sdk-go-v2, azure-sdk-for-go, google-cloud-go, masterzen/winrm — no alternatives
- **CGO_ENABLED=0**: Mandatory from day one (cross-compile prerequisite)
- **Distribution**: Unsigned binary ships for v1; signing is v2 target

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Go over Python | Single binary, no runtime dependency, better Windows distribution story | ✓ Good — eliminated venv/PowerShell signing issues |
| embed.FS for web UI | No separate asset deployment, truly self-contained binary | ✓ Good — works perfectly with fs.Sub() + SPA fallback |
| Auto-open browser via net.Listen-first | Removes UX friction; no race condition | ✓ Good — eliminates "address already in use" crash |
| Drop NIOS | Simplifies scope; NIOS is legacy, cloud+AD is the sales motion | ✓ Good |
| WinRM for AD | masterzen/winrm matches Python reference; pure Go | ✓ Good — NTLM works reliably |
| NTLM as default (Kerberos deferred) | Domain-joined client required for Kerberos; non-domain machines can't use it | ✓ Good — covers all pre-sales scenarios |
| SSE not WebSocket for progress | Simpler server push; no bidirectional needed | ✓ Good |
| WaitGroup over errgroup for scan fan-out | errgroup cancels all on first error; WaitGroup gives partial results (RES-01) | ✓ Good |
| Azure ClientSecretCredential explicit | Never DefaultAzureCredential — respects UI-supplied creds only | ✓ Good |
| Aggregation-before-division | Sum all FindingRows per category first, then single ceiling division | ✓ Good — correct token math |
| StreamWriter for Excel export | Prevents OOM on large AD environments; no disk writes | ✓ Good |
| GoReleaser OSS + snapshot tags | Every-push releases without GoReleaser Pro | ✓ Good — nightly free tier requires tag |
| azure/artifact-signing-action@v1 | Service rebranded from Trusted Signing → Artifact Signing January 2026 | ⚠ Revisit — unavailable in DE; switch to DigiCert/SignPath.io for v2 |
| Binary published without signing for v1 | Azure Artifact Signing unavailable in Germany; unsigned .exe acceptable for pre-sales | — Pending v2 resolution |
| Three-job CI pipeline (test/build/sign) | azure/artifact-signing-action is Windows-only; cross-compile on ubuntu-latest faster | — Revisit when signing resolved |
| Session clone for re-scan | SSO credential objects (azcore.TokenCredential) shared by pointer — prevents second browser popup | ✓ Good |

---
*Last updated: 2026-03-14 after v2.1 milestone start*
