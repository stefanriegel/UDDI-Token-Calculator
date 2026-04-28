# Enhanced Manual Sizing Estimator v2 — Universal DDI Sizer

**Date:** 2026-04-23
**Status:** Draft
**Supersedes:** `2026-04-10-enhanced-manual-sizer-design.md`
**Scope:** Replace the flat Manual Sizing Estimator with a multi-step Universal DDI Sizer that models 4-level geographic hierarchies, produces Management + Server + Reporting + Security token estimates, and renders an embedded Excalidraw topology view.

## Context

The v1 design (2026-04-10) was never implemented. SE feedback after reviewing the spec and `https://tokens.infoblox.com`:

1. Align calculation with the official tokens.infoblox.com engine (missing inputs / metrics / Security category).
2. Add Security Token sizing (Universal DDI / NIOS-X scope only — skip X5/X6 physical TD appliances).
3. Auto-derive QPS/LPS/Objects/IPs/Assets from a single "Users per Site" input.
4. Hierarchical architectural linking (Region → Country → City → Site) with diagram export — Excalidraw with in-app viewer.
5. Allow NIOS backup flow to seed the sizer (existing `scan-import` path, no new entry).

Calc engine details were reverse-engineered from the tokens.infoblox.com production bundle (`dist-DWbZU-yZ.js`, archived at `.planning/research-tokens-infoblox-dist.js`).

## Goal

Produce accurate multi-region token estimates and an exportable topology in a 5-step wizard optimised for SE pre-sales speed. Mirror the official tokens.infoblox.com math for Management / Reporting / Security; keep the existing internal NIOS-X and XaaS tier tables for Server tokens.

## Target User

System Engineers during/after customer discovery calls. Assumes DDI domain knowledge.

## Summary of Changes vs v1

| # | Change | Area |
|---|--------|------|
| 1 | Import infoblox calc constants verbatim | `sizer-calc.ts` |
| 2 | Add Security Tokens (TD Cloud + Dossier + Lookalikes + SOC Insights) | Calc + Step 4 |
| 3 | Users-per-site input with auto-derive and per-field override | Site model + Step 2 |
| 4 | 4-level hierarchy: Region → Country → City → Site | Data model + Steps 1-2 |
| 5 | In-app Excalidraw viewer + `.excalidraw` download | Step 5 |
| 6 | Growth buffer: single default + optional per-category override | Step 4 |
| 7 | Keep native token rates (25/13/3). No NIOS rate split. No package round-up. | Calc |
| 8 | Draw.io export dropped in favor of Excalidraw | Exports |
| 9 | NIOS backup import path unchanged (existing scan-import button) | Import |

Not changing: scanner backend, API endpoints, session model, overall wizard as 5 steps.

## Data Model

### Hierarchy

```
Region (EMEA)
└─ Country (Germany)
   └─ City (Frankfurt)
      └─ Site (Frankfurt HQ, Frankfurt DC-2, …)
```

Country and City are pure containers (no sizing fields). The UI auto-creates `(Unassigned)` Country/City placeholders when the SE adds a Site directly under a Region.

### Region

| Field | Type | Description |
|-------|------|-------------|
| `id` | uuid | Unique identifier |
| `name` | string | Display name (e.g. "EMEA", "AWS EU") |
| `type` | enum | `on-premises` \| `aws` \| `azure` \| `gcp` |
| `cloudNativeDns` | bool | Route53 / CloudDNS / AzureDNS managed through Universal DDI |

### Country

| Field | Type | Description |
|-------|------|-------------|
| `id`, `regionId`, `name` | | "Germany", "UAE" |
| `iso` | string? | Optional ISO-3166 alpha-2 (reserved for future map rendering) |

### City

| Field | Type | Description |
|-------|------|-------------|
| `id`, `countryId`, `name` | | "Frankfurt" |

### Site

| Field | Type | Description |
|-------|------|-------------|
| `id`, `cityId`, `name` | | |
| `multiplier` | number | Clone count (N identical sites) |
| `users` | number? | If set, triggers per-site derive |
| `activeIPs` | number | Derived or manual |
| `dhcpPct` | number (0-1) | Fraction of IPs served by DHCP |
| `dnsZones` | number | |
| `networksPerSite` | number | |
| `derivedFrom` | enum? | `users` \| `manual` — renders "Derived" badge per field |
| `dnsRecords` | number? | Override — auto-calc when omitted |
| `dhcpScopes` | number? | Override — defaults to `networksPerSite` |
| `avgLeaseDuration` | number? | Hours; default 1 |
| `qpsPerIP` | number? | Override for DNS QPD math |

Every auto-derived field shows a "Derived" badge and reverts to manual on edit.

### XaaS Service Point

Unchanged from v1. `connectedSiteIds` resolves Site by traversing City → Country → Region for display grouping. Fields: `id`, `name`, `popLocation` (from hardcoded PoP list), `capabilities {dns, dhcp, security, ntp}`, `connectivity` (`ipsec-vpn` | `aws-tgw`), `connectedSiteIds[]`, `objectOverride?`, `qpsOverride?`, `lpsOverride?`. Computed `aggregateQps/Lps/Objects`, `connections`, `tier`, `serverTokens`.

### NIOS-X System

Unchanged from v1. Fields: `id`, `name`, `locationSiteId?`, `role`, `capabilities`, `tierOverride?`, `qps`, `lps`, `objects`, `objectOverride?`. The `locationSiteId` dropdown now renders 4-level path "Region / Country / City / Site".

### Security Inputs (global)

| Field | Type | Description |
|-------|------|-------------|
| `securityEnabled` | bool | Gates Security calc |
| `tdVerifiedAssets` | number | Default = Σ site-derived assets × verifiedPct |
| `tdUnverifiedAssets` | number | Default = Σ site-derived assets × (1 − verifiedPct) |
| `socInsightsEnabled` | bool | × 1.35 multiplier on TD Cloud |
| `dossierQueriesPerDay` | number | |
| `lookalikeDomainsMentioned` | number | |

X5 / X6 physical TD appliances are intentionally out of scope — this tool covers Universal DDI / NIOS-X only.

### Global Settings

| Field | Type | Description |
|-------|------|-------------|
| `growthBuffer` | number (0-1) | Single default (e.g. 0.10) |
| `growthBufferAdvanced` | bool | Reveals per-category overrides |
| `mgmtOverhead`, `serverOverhead`, `reportingOverhead`, `securityOverhead` | number | Fall back to `growthBuffer` when advanced is off |

Plus existing module toggles (IPAM/DNS/DHCP), logging toggles, reporting destinations (CSP / S3 / CDC / Local Syslog), reporting rates.

## Official XaaS PoP Locations

Hardcoded from status.infoblox.com. Same list as v1 spec (9 AWS + 2 GCP).

## Wizard Flow

### Step 1: Regions, Countries, Cities

- Left: tree view with expand/collapse; right: detail pane
- "+ Region" at root; each Region gets "+ Country"; each Country gets "+ City"
- Breadcrumbs for quick nav
- Region card shows: name, type badge, aggregated site count
- Validation: ≥1 Region required; `(Unassigned)` placeholders auto-created when a Site is added under a Region or Country with no children

### Step 2: Sites

- Tree selector at top (Region → Country → City); selecting a City reveals that City's sites
- "+ Add Site" and "+ Clone Site (×N)" per City
- Site form has a toggle at the top:
  - **Users-driven** (default when `users` is set): one required input `users`; every other field shows derived value + "Derived" badge
  - **Manual:** all fields editable, derive disabled
- Collapsible "Workload Details" holds overrides (`dnsRecords`, `dhcpScopes`, `avgLeaseDuration`, `qpsPerIP`)
- Live preview strip under the form: `QPS · LPS · Objects · IPs · Assets`
- Validation: each Site must have `users` OR `activeIPs`

### Step 3: Infrastructure Placement

Two tabs: **XaaS Service Points** and **NIOS-X Systems**. Behaviour unchanged from v1 except:

- NIOS-X `locationSiteId` renders 4-level path
- XaaS `connectedSiteIds` groups options by Region
- Warning banner when a XaaS's connection count exceeds `tier.maxConnections`

### Step 4: Global Settings + Security

Three collapsible sections on one page:

**A. Modules & Logging** — existing IPAM/DNS/DHCP toggles, logging toggles, reporting destinations + per-10M-event rates, CSP / S3 / CDC / Local Syslog.

**B. Growth Buffer** — single slider (default 10%). "Advanced" expander reveals four per-category overrides (mgmt/server/reporting/security).

**C. Security** — top-level `securityEnabled` toggle, then:
- Verified assets (pre-filled from site-derived defaults)
- Unverified assets (pre-filled)
- SOC Insights toggle
- Dossier queries/day
- Lookalike domains mentioned
- Live Security token preview

### Step 5: Results & Topology

- **Hero row:** four cards — Management, Server, Reporting, **Security**
- Per-Region breakdown table: Region | Countries | Cities | Sites | Mgmt | Server | Reporting | Security
- **Topology pane:** embedded Excalidraw canvas, read-only by default with "Edit mode" toggle
- Actions: Download XLSX, Download `.excalidraw`, Copy Excalidraw JSON, Back, Start Over

## Token Calculation

Reverse-engineered from tokens.infoblox.com's `dist-DWbZU-yZ.js`. All constants imported into `sizer-calc.ts`:

```ts
export const CALC = {
  workDayPerMonth: 22,
  dayPermonth: 31,
  hoursPerWorkday: 9,
  dnsRecPerIp: 2,
  dnsRecPerLease: 3.5,
  dnsMultiplier: 3.2,           // QPS per user
  assetMultiplier: 3,
  socInsightMultiplier: 1.35,
  dossierListPrice: 4500,
  lookalikesListPrice: 12000,
  tokenPrice: 10,               // → 450 tk / dossier unit, 1200 tk / lookalike unit
  tdEstimatedQueriesPerDay: 2200,
  tdDaysPerMonth: 30,
  CSPQTYEvents: 1e7,
  S3BucketQTYEvents: 1e7,
  EcosystemQTYEvents: 1e7,
};

export const MGMT_RATES = { ddi: 25, activeIP: 13, asset: 3 };   // native only
export const REPORTING_RATES = { search: 80, log: 40, cdc: 40 }; // per 10M events
```

Server tier tables (`nxvs` XXS-XL, `nxaas` S-XL) reuse the existing `SERVER_TOKEN_TIERS` / `XAAS_TOKEN_TIERS` in `nios-calc.ts` (already align with tokens.infoblox.com numbers).

### Management Tokens (global)

```
for each Site s (× multiplier):
  ddiObjects += s.dnsRecords + s.dhcpScopes * 2
  activeIPs  += s.activeIPs
  assets     += s.assets

mgmtMax = max(
  ceil(ddiObjects / 25),
  ceil(activeIPs  / 13),
  ceil(assets     / 3)
)
managementTokens = ceil(mgmtMax * (1 + mgmtOverhead))
```

Per-site `dnsRecords` derivation (when not overridden): uses infoblox `splitByUsers` → `Static × 2 + Dynamic × 3.5`.

### Server Tokens

```
for each NIOS-X: tier = findTier(qps, lps, objects, SERVER_TIERS); tk = tier.tk
for each XaaS:   tier = findTier(aggQps, aggLps, aggObj, XAAS_TIERS)
                 tk   = tier.tk + max(0, connections - tier.maxConnections) * perConnTk
serverTokens = ceil(Σ tk * (1 + serverOverhead))
```

### Reporting Tokens

Ported from infoblox `calculateReportingTokens`:

```
dnsLogs/month  = dnsQPD × (31 × StaticIPs + 22 × DynamicIPs)
dhcpLogs/month = (1 + 9 / (leaseDuration / 2)) × 22 × DynamicIPs

searchTk = ceil( ceil(totalLogs / 1e7) * (1+ovh) * 80 )   // 30-day search
s3Tk     = ceil( ceil(totalLogs / 1e7) * (1+ovh) * 40 )   // S3 destination
cdcTk    = ceil( ceil(totalLogs / 1e7) * (1+ovh) * 40 )   // CDC / Ecosystem
```

Per-destination DNS/DHCP toggles honoured (matches infoblox semantics).

### Security Tokens

```
if !securityEnabled: return 0

tdCloud = (verifiedAssets + unverifiedAssets) * 3
if socInsightsEnabled: tdCloud *= 1.35
tdCloud = ceil(tdCloud * (1 + securityOverhead))

dossier    = ceil(dossierQueriesPerDay    / 25) * 450  * (1 + securityOverhead)
lookalikes = ceil(lookalikeDomainsMentioned / 25) * 1200 * (1 + securityOverhead)

securityTokens = tdCloud + dossier + lookalikes
```

### User → Site Derive

Proposed heuristics (reviewable). Called whenever `site.users` is set and a field is not overridden.

```ts
function deriveFromUsers(users, overrides = {}) {
  const assetsPerUser = users <= 1249 ? 2
                      : users <= 2499 ? 2
                      : users <= 4999 ? 2
                      : users <= 9999 ? 1.5
                      : 1;
  const verifiedPct   = users <= 1249 ? 0.22
                      : users <= 2499 ? 0.11
                      : users <= 4999 ? 0.38
                      : users <= 9999 ? 0.19
                      : 0.18;
  const activeIPs        = overrides.activeIPs        ?? Math.ceil(users * 1.5);
  const qps              = overrides.qps              ?? Math.ceil(users * 3.2);
  const assets           = overrides.assets           ?? Math.round(users * assetsPerUser);
  const verifiedAssets   = Math.round(assets * verifiedPct);
  const unverifiedAssets = assets - verifiedAssets;
  const networksPerSite  = overrides.networksPerSite  ?? Math.max(1, Math.ceil(users / 250));
  const dnsZones         = overrides.dnsZones         ?? Math.max(1, Math.ceil(users / 500));
  const dhcpScopes       = overrides.dhcpScopes       ?? networksPerSite;
  const dhcpPct          = overrides.dhcpPct          ?? 0.8;
  const avgLeaseDuration = overrides.avgLeaseDuration ?? 1;
  const dhcpIPs          = activeIPs * dhcpPct;
  const lps              = overrides.lps              ?? Math.max(1,
                               Math.ceil(dhcpIPs / (avgLeaseDuration * 3600)));
  return { activeIPs, qps, lps, assets, verifiedAssets, unverifiedAssets,
           networksPerSite, dnsZones, dhcpScopes, dhcpPct, avgLeaseDuration };
}
```

Heuristic rationale:
- `activeIPs = users × 1.5`: 1 workstation + ~0.5 phone/IoT per user
- `networksPerSite = ceil(users / 250)`: one /24 per ~250 users
- `dnsZones = ceil(users / 500)`: coarse departmental-zone density
- `dhcpPct = 0.8`: DHCP-dominant, 20% static assumption
- `lps = dhcpIPs / (lease × 3600)`: steady-state renewal rate

The heuristics live in `sizer-derive.ts` as named constants so SE can adjust in one place.

## Excalidraw Viewer + Export

### Library & Integration

- `@excalidraw/excalidraw` React package, embedded on Step 5
- Read-only by default; "Edit mode" toggle allows SE nudges before export
- Canvas renders from an `ExcalidrawElement[]` produced by `excalidraw-export.ts` from sizer state

### Combined Nested Layout

Hierarchy containers wrap their children; XaaS PoPs live in a dedicated band below the region band with cross-region edges.

```
┌─ Region: EMEA (on-premises) ──────────────────────────────────┐
│  ┌─ Country: Germany ──────────────────────────────────────┐  │
│  │  ┌─ City: Frankfurt ───────────────────────────────────┐ │  │
│  │  │  ┌─ Site: HQ-DC (×1) ─┐   ┌─ Site: DC-2 (×1) ────┐ │ │  │
│  │  │  │ QPS 12k  Obj 8k    │   │ QPS 8k  Obj 4k       │ │ │  │
│  │  │  │ [NIOS-X XL]────────┼───┤ [NIOS-X L]           │ │ │  │
│  │  │  └────────────────────┘   └───────────────────────┘ │ │  │
│  │  └────────────────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────────────┘  │
│                         │                                      │
│                         └─── (VPN) ──────┐                     │
│                                          ▼                     │
│                                ┌─ XaaS EU (Frankfurt PoP) ┐    │
│                                │ S tier · 2,400 tk        │    │
│                                └──────────────────────────┘    │
└────────────────────────────────────────────────────────────────┘
```

### Element Mapping

| Entity | Element | Label |
|---|---|---|
| Region | `rectangle`, thick border, tinted by `type` | `name · type badge · Σ tokens` |
| Country | `rectangle`, medium border | `name` |
| City | `rectangle`, thin dashed | `name` |
| Site | `rectangle`, filled opacity 0.1 | `name · ×multiplier · QPS/LPS/Obj` |
| NIOS-X | `rectangle` inside Site | `role · tier · tk` |
| XaaS PoP | `ellipse` below region band | `name · tier · tk · N connections` |
| Cloud-native DNS | small icon inside Region | Route53 / CloudDNS / AzureDNS |
| Connection | `arrow` Site → XaaS | `VPN` or `TGW` |

### Layout Algorithm

- Nested box packing: each container sizes to fit its children plus padding
- Sibling containers laid left-to-right, wrapping at 3 per row
- XaaS PoPs placed in a band below the region band
- One-pass coordinate compute (`computeLayout(sizerState)`) emits all elements
- SE can drag in "Edit mode"; edits persist inside sizer state for the session

### Export Actions (Step 5)

| Button | Output |
|---|---|
| Download `.excalidraw` | JSON compatible with excalidraw.com and Excalidraw desktop |
| Copy Excalidraw JSON | Clipboard — paste into an existing board |
| Download XLSX | Extended workbook (per-region sheets + new Security sheet) |

### Out of Scope

- Geographic map rendering (country ISO stored for future use)
- Draw.io export (dropped)
- Auto-layout refinement beyond box-packing

## Scan Import

Unchanged from v1 spec. NIOS Grid backup → NIOS-X systems; cloud scans → Regions + Sites (default Country/City are `(Unassigned)`); AD scan → Sites. Non-destructive merge. "Use as Sizer Input" button on the scan results page. Feedback item #5 is satisfied by this existing path.

## Files Changed

### New

```
frontend/src/app/components/sizer/
  sizer-types.ts
  sizer-calc.ts
  sizer-derive.ts
  sizer-wizard.tsx
  regions-step.tsx
  sites-step.tsx
  infrastructure-step.tsx
  settings-security-step.tsx
  results-step.tsx
  excalidraw-export.ts
  excalidraw-viewer.tsx
  xaas-pop-locations.ts
  scan-import.ts
frontend/src/app/components/sizer/__tests__/
  sizer-derive.test.ts
  sizer-calc.test.ts            # includes infoblox golden-sample test
  excalidraw-export.test.ts
```

### Modified

- `frontend/src/app/components/wizard.tsx` — route "Manual Sizing Estimator" into the new sizer wizard; add "Use as Sizer Input" button on scan results
- `frontend/src/app/components/estimator-calc.ts` — retain for legacy reuse; re-export shared helpers from `sizer-calc.ts` where they overlap
- `frontend/package.json` — add `@excalidraw/excalidraw`

### Unchanged

- Go backend (server, scanners, orchestrator, calculator, exporter)
- API client — no new endpoints
- Session / scan-import backend code

### Deferred

- Backend XLSX `Security` sheet (frontend-driven workbook is sufficient for v1)
- Excalidraw geo-map rendering
- Draw.io export

## Testing

- `sizer-derive.test.ts` — snapshot `deriveFromUsers` at 500 / 1,500 / 3,000 / 7,500 / 20,000 users
- `sizer-calc.test.ts`:
  - `calculateManagementTokens` against an infoblox reference fixture
  - `calculateReportingTokens` against infoblox `l()` + `u()` logic for representative inputs
  - `calculateSecurityTokens` matches the hard-coded sample at the bottom of the infoblox bundle (golden-master test)
  - Integration fixture: 3 Regions × 2 Countries × 4 Sites with mixed users-driven + manual entries
- `excalidraw-export.test.ts` — element counts, bounding-box containment (Site inside City inside Country inside Region), edge endpoints

## Validation Warnings

Same warning system as v1, extended:

- XaaS connection limit exceeded
- Site not assigned to any XaaS or NIOS-X
- Region with no Countries / Cities / Sites
- Object count mismatch between Sites and Server totals
- Security enabled but `tdVerifiedAssets + tdUnverifiedAssets == 0`
- `users` derivation produces implausible LPS (< 1 or > 10 000) — suggest manual override
