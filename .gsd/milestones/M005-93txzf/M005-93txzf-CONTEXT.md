---
depends_on: []
---

# M005-93txzf: AD→NIOS-X Migration Sizing & Multi-Forest Support

**Gathered:** 2026-03-18
**Status:** Queued — pending auto-mode execution

## Project Description

Extend the MS DHCP/DNS (Active Directory) scanning pipeline with NIOS-X server token calculation, migration/hybrid scenario comparison, multi-forest credential support, Knowledge Worker metrics, computer/device inventory, static IP detection, and optional Entra ID enrichment via Microsoft Graph API.

## Why This Milestone

When a customer runs on-prem Windows DNS + DHCP, the pre-sales engineer needs to calculate how many NIOS-X server tokens a migration would require — the same sizing exercise already available for NIOS Grid migrations. Today the AD scan only produces management token estimates. This milestone bridges the gap so that AD environments get the same migration planner experience as NIOS, including per-server tier calculation, hybrid/full migration scenarios, and Knowledge Worker counts.

Multi-forest support addresses enterprise customers where separate AD forests have separate admin credentials and cannot be auto-discovered from a single entry point.

## User-Visible Outcome

### When this milestone is complete, the user can:

- Scan a Windows AD environment and see per-server NIOS-X tier recommendations (2XS–XL) based on DNS object counts, DHCP object counts (+20% overhead), QPS (from DNS event logs), and LPS (from DHCP event logs)
- Choose an event log time window (1h, 24h, 72h default, 7d) from a dropdown for QPS/LPS calculation
- See Current / Hybrid / Full Migration scenario comparison for AD results — same UX as the NIOS migration planner
- Add multiple forests with separate credentials within a single MS AD provider card ("Add Forest" button)
- See Knowledge Worker (employee) count from AD user accounts in the report
- See computer/device counts per user and static IP assignments from AD
- Optionally connect Entra ID (via existing Azure auth) to enrich user/device data for hybrid or full Entra environments
- Export all new metrics in the Excel report

### Entry point / environment

- Entry point: Browser UI at `http://127.0.0.1:<port>` (auto-opened on launch)
- Environment: Windows desktop (primary), macOS/Linux dev
- Live dependencies involved: Windows AD domain controllers via WinRM, optionally Microsoft Graph API for Entra ID

## Completion Class

- Contract complete means: Unit tests cover DHCP +20% overhead calculation, tier selection with QPS/LPS/objects, event log parsing, multi-forest credential routing, computer/static IP aggregation. Mock-based tests verify multi-forest fan-out and Entra Graph API integration.
- Integration complete means: Real AD scan produces per-server tier recommendations, migration planner scenarios render correctly, multi-forest credentials route to separate WinRM sessions, Entra ID data merges with on-prem AD data.
- Operational complete means: Multi-forest customer scan with 2+ forests produces correct aggregated results; event log QPS/LPS degrades gracefully when DNS/DHCP analytical logs are disabled.

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- A Windows AD scan produces per-server NIOS-X tier calculations with DHCP +20% overhead applied
- The migration planner shows Current/Hybrid/Full scenarios for AD results with correct token math
- Multi-forest scanning with separate credentials works within a single provider card
- Knowledge Worker count, computer count, and static IPs appear in results and Excel export
- Entra ID enrichment works when Azure auth is available and is skipped gracefully when not
- QPS/LPS extraction from event logs degrades gracefully when logs are empty or disabled (falls back to 0)

## Risks and Unknowns

- **DNS analytical log availability** — `Microsoft-Windows-DNS-Server/Analytical` may not be enabled on all customer DCs. Must degrade gracefully to QPS=0 with a warning when the log is empty or disabled.
- **DHCP event log format** — DHCP Server event log structure varies between Windows Server versions. Need to identify the correct event IDs for lease acknowledgments across Server 2016/2019/2022/2025.
- **Event log volume** — In high-traffic environments, 72h of DNS query events could be millions of rows. `Get-WinEvent` with `-FilterHashtable` and `Measure-Object` should count without loading all events into memory, but this needs verification.
- **Microsoft Graph SDK binary size** — `msgraph-sdk-go` pulls in Kiota abstractions + generated models. Could significantly increase binary size. Need to evaluate whether to use the full SDK or make raw REST calls with the existing `azidentity` token.
- **CGO_ENABLED=0 compatibility** — Microsoft Graph Go SDK should be pure Go (Kiota-generated), but needs verification. If CGO is required, fall back to raw HTTP + `azidentity` token.
- **Multi-forest UX complexity** — Adding "Add Forest" within a single provider card is a new UX pattern. The current wizard assumes one credential set per provider. This needs careful state management.

## Existing Codebase / Prior Art

- `internal/scanner/ad/scanner.go` — Current AD scanner: WinRM fan-out across DCs, `dcAggregator` for set-union dedup, outputs 6 FindingRow types (dns_zone, dns_record, dhcp_scope, dhcp_lease, dhcp_reservation, user_account)
- `internal/scanner/ad/discover.go` — Forest auto-discovery: `DiscoverForest` probes for additional DCs, DNS servers, DHCP servers across child/sibling domains
- `internal/scanner/ad/sspi_windows.go` / `sspi_stub.go` — SSPI pass-through auth (Windows only)
- `frontend/src/app/components/nios-calc.ts` — NIOS-X tier tables (`SERVER_TOKEN_TIERS`, `XAAS_TOKEN_TIERS`), `calcServerTokenTier()`, `consolidateXaasInstances()`, `NiosServerMetrics` interface
- `frontend/src/app/components/wizard.tsx` — NIOS Migration Planner UI (lines ~2520-2800): three-scenario comparison (Current/Hybrid/Full), member selection with form factor toggle, Server Token Calculator panel
- `frontend/src/app/components/mock-data.ts` — MS AD provider definition (`id: 'microsoft'`), auth methods (SSPI, Kerberos, NTLM, PowerShell Remoting), `ProviderType` union
- `server/validate.go` — AD credential validation endpoints, `realADValidator`, Kerberos/NTLM/SSPI routing
- `internal/session/session.go` — Session store with per-provider credentials
- `internal/orchestrator/orchestrator.go` — Provider fan-out via WaitGroup
- Azure auth (`azidentity`) — Already in `go.mod`: `NewInteractiveBrowserCredential`, `NewDeviceCodeCredential` — reusable for Graph API

> See `.gsd/DECISIONS.md` for all architectural and pattern decisions — it is an append-only register; read it during planning, append to it during execution.

## Relevant Requirements

- New: AD→NIOS-X server token calculation with per-server tier sizing
- New: DHCP +20% overhead in NIOS-X token calculation
- New: Multi-forest credential support within single provider card
- New: Knowledge Worker (employee) count metric
- New: Computer/device inventory with per-user correlation
- New: Static IP detection (DHCP reservations + AD computer IPv4)
- New: Event log QPS/LPS extraction with configurable time window
- New: Entra ID enrichment via Microsoft Graph API (conditional on hybrid/full Entra topology)
- New: Migration/Hybrid scenario comparison for AD results (same UX as NIOS planner)

## Scope

### In Scope

- Per-server NIOS-X tier calculation using existing tier tables from `nios-calc.ts`
- DHCP object count +20% overhead multiplier before tier calculation
- DNS QPS extraction from DNS Server event logs via `Get-WinEvent` over WinRM
- DHCP LPS extraction from DHCP Server event logs via `Get-WinEvent` over WinRM
- Configurable event log time window dropdown (1h, 24h, 72h default, 7d)
- Graceful fallback to QPS=0 / LPS=0 when event logs are empty or disabled
- Current / Hybrid / Full Migration scenario comparison panel for AD results
- Hybrid scenario uses same formula as full (no special hybrid calculation unlike NIOS)
- Multi-forest support: "Add Forest" button within single MS AD provider card, each forest with own credentials
- Knowledge Worker count from `Get-ADUser` (already collected, needs surfacing as named metric)
- Computer/device inventory via `Get-ADComputer` over WinRM
- Devices-per-user correlation
- Static IP detection: DHCP reservations + AD computer objects with static IPv4Address
- Entra ID data enrichment via Microsoft Graph API when customer has hybrid or full Entra setup
- Entra ID auth reuses existing Azure provider credentials (browser-SSO / device-code)
- Graph API: user count, device count, device-to-user ownership mapping
- Excel export extension with all new metrics
- Demo mode mock data for AD migration planner

### Out of Scope / Non-Goals

- NIOS-X as a Service (XaaS) tier calculation for AD — only NIOS-X on-prem tiers
- Real-time DNS/DHCP monitoring or continuous metric collection
- Entra ID-only environments without any on-prem AD — this is for on-prem or hybrid scenarios
- Automated migration execution — this is sizing/estimation only
- DNS/DHCP service configuration analysis (zone transfers, conditional forwarders, etc.)
- AD Group Policy or OU structure analysis

## Technical Constraints

- CGO_ENABLED=0 mandatory — Microsoft Graph SDK or raw REST calls must work without CGO
- Existing WinRM session reuse — QPS/LPS extraction, computer queries, and static IP detection must run over the same authenticated WinRM connection
- Event log queries must use `-FilterHashtable` with time bounds to avoid loading millions of events into memory
- Multi-forest state management must not break the existing single-credential-per-provider wizard pattern
- DHCP +20% overhead must be applied before tier calculation, not after
- Binary size impact from Microsoft Graph SDK must be evaluated — may need raw REST + azidentity token instead

## Integration Points

- **Windows AD domain controllers (WinRM)** — Extended PowerShell commands for `Get-ADComputer`, `Get-WinEvent` (DNS/DHCP logs)
- **Microsoft Graph API** — `/users`, `/devices`, `/users/{id}/ownedDevices` endpoints for Entra ID enrichment
- **Existing Azure auth (`azidentity`)** — Reuse browser-SSO / device-code credentials for Graph API token acquisition
- **NIOS-X tier tables (`nios-calc.ts`)** — Reuse `SERVER_TOKEN_TIERS` and `calcServerTokenTier()` for AD server sizing
- **NIOS Migration Planner UI** — Adapt the three-scenario comparison panel for AD provider results
- **Excel export (`excelize`)** — Extend with AD migration planner sheet, Knowledge Worker counts, computer inventory

## Open Questions

- **Graph SDK vs raw REST** — Is the Microsoft Graph Go SDK too heavy for binary size? Leaning toward evaluating SDK size first, falling back to raw REST + `azidentity.GetToken()` if the SDK adds >5MB.
- **DNS event log event IDs** — Need to verify which event IDs represent DNS queries across Server 2016/2019/2022/2025. Analytical log (Event ID 256-259) vs Audit log differences.
- **DHCP event log event IDs** — Need to identify correct event IDs for DHCP lease acknowledgments (ACKs) across Windows Server versions.
- **Entra ID app registration** — Does the pre-sales engineer need to register an app in the customer's Entra ID tenant, or can we use the well-known Azure CLI client ID (04b07795...) with dynamic consent for Graph scopes?
- **Computer-to-user mapping** — AD's `Get-ADComputer` has `ManagedBy` attribute. Is that sufficient for devices-per-user, or do we need `Get-ADUser` cross-reference with `Get-ADComputer` ownership?
