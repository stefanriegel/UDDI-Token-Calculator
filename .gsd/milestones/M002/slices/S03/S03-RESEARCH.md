# Phase 11: Frontend NIOS Features - Research

**Researched:** 2026-03-10
**Domain:** React + TypeScript, client-side computation panels, wizard.tsx extension, Figma Make reference migration
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from STATE.md accumulated decisions)

### Locked Decisions
- All new frontend panels (Migration Planner, Server Token Calculator, XaaS Consolidation) are client-side only — backend provides raw per-member findings via niosServerMetrics.
- Frontend changes are INCREMENTAL — Figma Make export at `Web UI for Token Calculation Updated/` is the reference UI, not a replacement.
- The Figma export's wizard.tsx (2708 lines) contains the complete reference implementation for all four panels. Port from it, do NOT wholesale replace the existing wizard.tsx.
- `calcServerTokenTier`, `consolidateXaasInstances`, `SERVER_TOKEN_TIERS`, `XAAS_TOKEN_TIERS`, `XAAS_EXTRA_CONNECTION_COST`, `NiosServerMetrics`, `ServerFormFactor`, `ConsolidatedXaasInstance` must be added to the existing `mock-data.ts` (or a new co-located file).
- `MOCK_NIOS_SERVER_METRICS` is dev/demo mode only — in live mode, metrics come from `scanResults.niosServerMetrics`.
- XaaS extra connection cost = 100 tokens/extra connection, max 400 extra per instance (confirmed by both performance-metrics.csv and Figma reference).
- Panel ordering in results step: Top Consumer Cards → NIOS-X Migration Planner → Server Token Calculator → (XaaS Consolidation is folded into Server Token Calculator, not a separate panel) → Export buttons.
- Top Consumer Cards show ALL providers (DNS/DHCP/IP filter on item text), not NIOS-only.
- Migration Planner and Server Token Calculator only render when `selectedProviders.includes('nios')`.

### Claude's Discretion
- Whether to extract calc functions into a separate `nios-calc.ts` file vs. append to `mock-data.ts`.
- Whether `niosMigrationMap` state is `Map<string, ServerFormFactor>` (Figma approach) or an alternative structure.
- Exact Tailwind class choices for new panel styling (should follow existing patterns in wizard.tsx).
- Whether Top Consumer Cards use exact same regex filters as Figma or cleaner alternatives.
- How to handle the `figma:asset/...` PNG imports — Figma export uses asset protocol that Vite dev doesn't support; replace with paths to actual PNGs in `frontend/src/assets/`.

### Deferred Ideas (OUT OF SCOPE)
- Backend logic for Migration Planner, Server Token Calculator, XaaS Consolidation.
- Re-scan / session clone for NIOS.
- QPS/LPS extraction from RRD/reporting files (returns 0 from backend, shown as — in UI).
- CSV/Excel export of migration planner data (Figma reference includes this, but it is NOT a Phase 11 requirement — FE-03 through FE-06 do not include export).
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| FE-03 | Results step shows Top Consumer Cards (DNS, DHCP, IP/Network — expandable, top 5 per category, client-side only) | Figma reference at lines 1605–1746 of export wizard.tsx; uses `findings` state already present; three expand/collapse boolean states needed |
| FE-04 | Results step shows NIOS-X Migration Planner (3-scenario comparison: Current/Hybrid/Full UDDI) when NIOS was scanned | Figma reference at lines 2056–2266; needs `niosMigrationMap: Map<string, ServerFormFactor>` state; computation is pure arithmetic over findings |
| FE-05 | Results step shows Server Token Calculator (per-member form factor selection: NIOS-X on-prem vs XaaS) when NIOS was scanned | Figma reference at lines 2269–2611; needs `calcServerTokenTier` + `consolidateXaasInstances` functions; displays niosServerMetrics from results API |
| FE-06 | Results step shows XaaS Consolidation panel (bin-packing with S/M/L/XL tiers, connection limits, extra connections at 100 tokens each) | Folded into Server Token Calculator panel in Figma reference (XaaS instances displayed as grouped rows within the same table); no separate panel needed |
</phase_requirements>

---

## Summary

Phase 11 adds four NIOS-specific result panels to the existing `wizard.tsx` Results step. The Figma Make export (`Web UI for Token Calculation Updated/src/app/components/wizard.tsx`) is the authoritative reference implementation — all four panels are fully coded there, using `MOCK_NIOS_SERVER_METRICS` in demo mode and `scanResults.niosServerMetrics` in live mode.

The work is a surgical port: extract computation logic into `mock-data.ts` (or a co-located `nios-calc.ts`), add three new boolean state variables and one `Map` state variable to the existing `Wizard()` function, and insert the four JSX blocks into the results step at the correct position. No new files other than potentially `nios-calc.ts` are required. No backend changes are needed.

The most important gotcha: the Figma export uses `MOCK_NIOS_SERVER_METRICS` throughout. In the live app, the equivalent data comes from `scanResults.niosServerMetrics` (the `NiosServerMetric[]` returned by the results API). The port must wire real data, not the mock constant. The current `api-client.ts` `ScanResultsResponse` interface does NOT include `niosServerMetrics` — that field must be added as `niosServerMetrics?: NiosServerMetricAPI[]`.

**Primary recommendation:** Port the four JSX blocks and computation functions from the Figma export reference. Wire real `scanResults.niosServerMetrics` instead of mock data. Add three expand/collapse booleans and one `niosMigrationMap` Map to Wizard state.

---

## Standard Stack

### Core (already installed — no new installs needed)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| React | 18.3.1 (peerDep) | Component state, hooks | Already in use throughout wizard.tsx |
| TypeScript | ^5.9.3 | Type safety for calc functions and API types | Already in use |
| Tailwind CSS | 4.1.12 | Panel styling | Already in use |
| lucide-react | 0.487.0 | Icons (Activity, Gauge, Globe, ArrowRightLeft, ChevronUp) | Already in use; new icons needed: `Activity`, `Gauge`, `ArrowRightLeft`, `ChevronUp` (add to existing import) |

### New Icons Needed (add to wizard.tsx import)
```typescript
// Add to existing lucide-react import in wizard.tsx:
import { ..., Activity, Gauge, ArrowRightLeft, ChevronUp } from 'lucide-react';
```
(Confirm: `Activity` and `Gauge` are in lucide-react 0.487.0 — verified by Figma reference which uses the same version. `ChevronUp` must also be imported since accordion expand uses it.)

### No New Dependencies
All panels are pure React + existing Tailwind — zero new npm packages. The bin-packing algorithm in `consolidateXaasInstances` is hand-rolled JS (the standard approach for this constraint size).

---

## Architecture Patterns

### Recommended Structure for New Code

```
frontend/src/app/components/
├── wizard.tsx              # Add 3 boolean states + 1 Map state + 4 JSX blocks
├── mock-data.ts            # Add NiosServerMetrics type, calc functions, tier tables
└── api-client.ts           # Add niosServerMetrics?: NiosServerMetricAPI[] to ScanResultsResponse
```

Optionally, if mock-data.ts grows unwieldy:
```
frontend/src/app/components/
└── nios-calc.ts            # calcServerTokenTier, consolidateXaasInstances, tier tables, types
```

### Pattern 1: Client-Side Computation via useMemo or Inline IIFE

All four panels compute results inline using IIFE patterns `{(() => { ... })()}` as used in the existing wizard.tsx results section. This is the established pattern in this codebase — follow it for consistency.

**Example (existing pattern in wizard.tsx):**
```typescript
// Source: existing wizard.tsx results step (line ~1715)
{(() => {
  const sourceMap = new Map<string, { source: string; tokens: number }>();
  findings.forEach((f) => { ... });
  return <div>...</div>;
})()}
```

For computationally expensive operations (bin-packing over many members), wrap in `useMemo` instead:
```typescript
// Source: Figma reference pattern + React docs
const xaasInstances = useMemo(
  () => consolidateXaasInstances(xaasMembers),
  [xaasMembers] // xaasMembers derived from niosMigrationMap + niosServerMetrics
);
```

### Pattern 2: State for Panel Controls

Add to the existing `Wizard()` state block:
```typescript
// Top Consumer Cards — expand/collapse per card
const [topDnsExpanded, setTopDnsExpanded] = useState(false);
const [topDhcpExpanded, setTopDhcpExpanded] = useState(false);
const [topIpExpanded, setTopIpExpanded] = useState(false);

// Migration Planner — which members are marked for migration and their form factor
const [niosMigrationMap, setNiosMigrationMap] = useState<Map<string, ServerFormFactor>>(new Map());
```

### Pattern 3: Conditional Rendering for NIOS-Only Panels

```typescript
// Source: Figma reference wizard.tsx line 2057
{selectedProviders.includes('nios') && (() => {
  // Migration Planner + Server Token Calculator panels
})()}
```

Top Consumer Cards render unconditionally (they filter `findings` by item-name regex — if no matches, `visibleCards.length === 0` returns null).

### Pattern 4: Live vs. Demo Data Routing

```typescript
// The key adaptation from Figma reference (uses mock) to live app (uses API results):
const niosServerMetrics: NiosServerMetricAPI[] =
  backend.isDemo
    ? MOCK_NIOS_SERVER_METRICS        // from mock-data.ts
    : (scanResults?.niosServerMetrics ?? []);  // from GET /api/v1/scan/{id}/results
```

This pattern already exists for `findings` (mock vs. API). Apply same approach.

### Pattern 5: calcServerTokenTier (deterministic pure function)

```typescript
// Source: Figma mock-data.ts lines 585-591
export function calcServerTokenTier(
  qps: number,
  lps: number,
  objectCount: number = 0,
  formFactor: ServerFormFactor = 'nios-x'
): ServerTokenTier {
  const tiers = formFactor === 'nios-xaas' ? XAAS_TOKEN_TIERS : SERVER_TOKEN_TIERS;
  for (const tier of tiers) {
    if (qps <= tier.maxQps && lps <= tier.maxLps && objectCount <= tier.maxObjects) return tier;
  }
  return tiers[tiers.length - 1]; // cap at XL if all tiers exceeded
}
```

### Pattern 6: consolidateXaasInstances (bin-packing)

```typescript
// Source: Figma mock-data.ts lines 630-701
// Key logic: sort members by QPS desc → accumulate into current instance →
// if adding next member would exceed XL capacity (metrics OR connection count),
// flush current instance and start new one → extra connections = used - tier.maxConnections
export function consolidateXaasInstances(members: NiosServerMetrics[]): ConsolidatedXaasInstance[] {
  // ... see Figma reference for full implementation
}
```

### Tier Tables (verified against performance-metrics.csv and performance-specs.csv)

```typescript
// NIOS-X on-prem tiers (from performance-specs.csv):
export const SERVER_TOKEN_TIERS: ServerTokenTier[] = [
  { name: '2XS', maxQps: 5_000,   maxLps: 75,  maxObjects: 3_000,   serverTokens: 130,   cpu: '3 Core',  ram: '4 GB',  storage: '64 GB' },
  { name: 'XS',  maxQps: 10_000,  maxLps: 150, maxObjects: 7_500,   serverTokens: 250,   cpu: '3 Core',  ram: '4 GB',  storage: '64 GB' },
  { name: 'S',   maxQps: 20_000,  maxLps: 200, maxObjects: 29_000,  serverTokens: 470,   cpu: '4 Core',  ram: '4 GB',  storage: '128 GB' },
  { name: 'M',   maxQps: 40_000,  maxLps: 300, maxObjects: 110_000, serverTokens: 880,   cpu: '4 Core',  ram: '32 GB', storage: '1 TB' },
  { name: 'L',   maxQps: 70_000,  maxLps: 400, maxObjects: 440_000, serverTokens: 1_900, cpu: '16 Core', ram: '32 GB', storage: '1 TB' },
  { name: 'XL',  maxQps: 115_000, maxLps: 675, maxObjects: 880_000, serverTokens: 2_700, cpu: '24 Core', ram: '32 GB', storage: '1 TB' },
];

// XaaS tiers (from performance-metrics.csv):
export const XAAS_TOKEN_TIERS: ServerTokenTier[] = [
  { name: 'S',  maxQps: 20_000,  maxLps: 200, maxObjects: 29_000,  serverTokens: 2_400, cpu: '-', ram: '-', storage: '-', maxConnections: 10 },
  { name: 'M',  maxQps: 40_000,  maxLps: 300, maxObjects: 110_000, serverTokens: 4_100, cpu: '-', ram: '-', storage: '-', maxConnections: 20 },
  { name: 'L',  maxQps: 70_000,  maxLps: 400, maxObjects: 440_000, serverTokens: 6_100, cpu: '-', ram: '-', storage: '-', maxConnections: 35 },
  { name: 'XL', maxQps: 115_000, maxLps: 675, maxObjects: 880_000, serverTokens: 8_500, cpu: '-', ram: '-', storage: '-', maxConnections: 85 },
];

export const XAAS_EXTRA_CONNECTION_COST = 100; // tokens per extra connection, max 400 extra per instance
```

These values are CONFIRMED against:
1. `frontend/src/imports/performance-specs.csv` (NIOS-X tiers) — HIGH confidence
2. `frontend/src/imports/performance-metrics.csv` (XaaS tiers + extra connection note) — HIGH confidence
3. Figma reference `mock-data.ts` lines 564-583 — HIGH confidence (all three agree)

### Anti-Patterns to Avoid

- **Wholesale wizard.tsx replacement:** The Figma export has different provider names (`microsoft` vs `ad`) and references `figma:asset/...` PNGs that don't exist in the live app. Diff and port, never copy-paste whole file.
- **Using figma:asset imports:** The Figma export's `mock-data.ts` imports PNGs via `figma:asset/` protocol. Replace with paths to actual files in `frontend/src/assets/` (already copied in Phase 9).
- **Loading MOCK_NIOS_SERVER_METRICS unconditionally:** Only use in demo mode (`backend.isDemo`). Live mode must use `scanResults?.niosServerMetrics`.
- **Computing bin-packing on every render without memoization:** `consolidateXaasInstances` sorts and iterates — wrap in `useMemo` keyed on the xaasMembers list.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Accordion/expand-collapse | Custom accordion component | Simple `useState` boolean + conditional render | Pattern already used throughout wizard.tsx; shadcn accordion overkill here |
| Tier lookup table | Custom data structure | Static `SERVER_TOKEN_TIERS[]` array with linear scan | Only 6 tiers; O(n) is fine; verified tier data is the hard part |
| Bin-packing algorithm | General-purpose bin-packing lib | `consolidateXaasInstances()` from Figma reference | Exact algorithm is already specified (sort by QPS desc, flush when XL exceeded) |
| Token math | Custom formula | Existing `calcTokens()` in mock-data.ts | Already correct; `calcServerTokenTier()` is the new companion for server sizing |
| Progress bars | CSS animation lib | Existing inline `style={{ width: ${pct}% }}` pattern | Already established in wizard.tsx category cards |

---

## Common Pitfalls

### Pitfall 1: api-client.ts Missing niosServerMetrics Field
**What goes wrong:** `scanResults.niosServerMetrics` is `undefined` even when NIOS was scanned, because the `ScanResultsResponse` interface in `api-client.ts` doesn't declare the field.
**Why it happens:** Phase 10 added the field to `server/types.go` but `api-client.ts` was not updated (it predates Phase 10).
**How to avoid:** Add `niosServerMetrics?: NiosServerMetricAPI[]` to `ScanResultsResponse` in `api-client.ts` as part of Wave 0/Plan 1. Define `NiosServerMetricAPI` interface matching the backend struct (`memberId`, `memberName`, `role`, `qps`, `lps`, `objectCount`).
**Warning signs:** TypeScript error `Property 'niosServerMetrics' does not exist on type 'ScanResultsResponse'` or panels showing empty even after real scan.

### Pitfall 2: Top Consumer Cards with No NIOS Data
**What goes wrong:** Cards show DNS/DHCP/IP items from cloud providers even when NIOS was not selected, and the regex filters can match non-NIOS rows unexpectedly.
**Why it happens:** The item-name regex (`/dns|zone/i`, `/dhcp|scope|lease/i`, `/ip|subnet|network/i`) is broad — AWS "Route53 Record Sets" will match DNS, Azure "VMs" will not but Azure "VM IPs" will match IP, etc.
**How to avoid:** This is intentional behavior — Top Consumer Cards show top consumers across ALL providers. Verify with mock data that the filter returns sensible results. The Figma reference confirms this is correct. If empty (no item matches), `visibleCards.length === 0` returns `null` — the section simply doesn't render.
**Warning signs:** Cards showing with 0 items or failing to render when NIOS data is present.

### Pitfall 3: niosMigrationMap Key vs. Source Field Mismatch
**What goes wrong:** Migration Planner checkboxes don't connect to Server Token Calculator data because the map key (source name from `findings`) doesn't match `memberName` in `niosServerMetrics`.
**Why it happens:** `findings[].source` = member hostname (e.g., `infoblox-gm.corp.example.com`) and `NiosServerMetric.memberName` = same hostname. They SHOULD match, but only if the backend is populating them consistently. The Phase 10 decision states: `FindingRow.Source = member hostname` and `NiosServerMetric.memberName = hostname`. They are the same field.
**How to avoid:** Key `niosMigrationMap` on member hostname. Filter `niosServerMetrics` by `m.memberName` matching the map key. Test with mock data that uses the same hostname format.
**Warning signs:** Server Token Calculator shows 0 members even when Migration Planner has selections.

### Pitfall 4: XaaS Consolidation Misidentified as a Separate Panel
**What goes wrong:** Planner creates a fourth standalone "XaaS Consolidation" panel separate from Server Token Calculator.
**Why it happens:** FE-06 describes XaaS Consolidation as a distinct panel. The Figma reference implements it as grouped rows within the Server Token Calculator table (XaaS instance header rows + member sub-rows + aggregate row).
**How to avoid:** FE-06 ("XaaS Consolidation panel with bin-packing...") is satisfied by the XaaS instance section within the Server Token Calculator table. No separate panel div needed.
**Warning signs:** Two separate panel divs for FE-05 and FE-06 instead of one unified Server Token Calculator.

### Pitfall 5: QPS/LPS Defaults and 0-Value Display
**What goes wrong:** Members with QPS=0 and LPS=0 (IPAM, Reporting roles) display `0` in the table columns, making the layout look broken.
**How to avoid:** Follow the Figma reference pattern: `{member.qps > 0 ? member.qps.toLocaleString() : <span className="text-gray-300">&mdash;</span>}`. Show em-dash for zero values.
**Warning signs:** Table rows showing `0` in QPS/LPS columns for IPAM or Reporting members.

### Pitfall 6: Tier Data Source Confusion
**What goes wrong:** Using kQPS values directly (e.g., 5, 10, 20) from the CSV instead of converted absolute QPS values (5000, 10000, 20000).
**Why it happens:** `performance-specs.csv` header says "kQPS" — must multiply by 1000 to get absolute QPS for comparison against real metrics.
**How to avoid:** Tier table entries use absolute QPS (`maxQps: 5_000`, not `maxQps: 5`). The Figma reference already applies this conversion correctly.
**Warning signs:** All members getting `2XS` tier regardless of their actual QPS.

---

## Code Examples

### Verified: NiosServerMetricAPI Type to Add to api-client.ts

```typescript
// Add to frontend/src/app/components/api-client.ts
// Matches server/types.go NiosServerMetric struct (Phase 10-04)
export interface NiosServerMetricAPI {
  memberId: string;
  memberName: string;
  role: string;  // 'GM' | 'GMC' | 'DNS' | 'DHCP' | 'DNS/DHCP' | 'IPAM' | 'Reporting'
  qps: number;
  lps: number;
  objectCount: number;
}

// Add niosServerMetrics field to existing ScanResultsResponse:
export interface ScanResultsResponse {
  // ... existing fields ...
  niosServerMetrics?: NiosServerMetricAPI[];  // present only when NIOS was scanned
}
```

### Verified: Top Consumer Card State and Filter (from Figma reference lines 125-128, 1607-1656)

```typescript
// State (add to Wizard function)
const [topDnsExpanded, setTopDnsExpanded] = useState(false);
const [topDhcpExpanded, setTopDhcpExpanded] = useState(false);
const [topIpExpanded, setTopIpExpanded] = useState(false);

// Card definitions (inside results step IIFE)
const consumerCards = [
  {
    key: 'dns',
    label: 'Top 5 DNS Consumers',
    filter: (f: FindingRow) => /dns|zone/i.test(f.item) && !/unsupported/i.test(f.item),
    expanded: topDnsExpanded,
    toggle: () => setTopDnsExpanded((v) => !v),
    icon: Globe,
    iconBg: 'bg-blue-50', iconColor: 'text-blue-600', barColor: 'bg-blue-500',
  },
  {
    key: 'dhcp',
    label: 'Top 5 DHCP Consumers',
    filter: (f: FindingRow) => /dhcp|scope|lease|range|reservation/i.test(f.item) && !/unsupported/i.test(f.item),
    expanded: topDhcpExpanded,
    toggle: () => setTopDhcpExpanded((v) => !v),
    icon: Activity,
    iconBg: 'bg-purple-50', iconColor: 'text-purple-600', barColor: 'bg-purple-500',
  },
  {
    key: 'ip',
    label: 'Top 5 IP / Network Consumers',
    filter: (f: FindingRow) => /ip|subnet|network|cidr|address|vnet|vpc/i.test(f.item) && !/dhcp|dns|unsupported/i.test(f.item),
    expanded: topIpExpanded,
    toggle: () => setTopIpExpanded((v) => !v),
    icon: Gauge,
    iconBg: 'bg-green-50', iconColor: 'text-green-600', barColor: 'bg-green-500',
  },
];
// Source: Web UI for Token Calculation Updated/src/app/components/wizard.tsx lines 1607-1656
```

### Verified: Live/Demo Data Routing for niosServerMetrics

```typescript
// In Wizard(), derive niosServerMetrics from results or mock:
const niosServerMetrics: NiosServerMetricAPI[] = useMemo(() => {
  if (backend.isDemo) return MOCK_NIOS_SERVER_METRICS as NiosServerMetricAPI[];
  return scanResults?.niosServerMetrics ?? [];
}, [backend.isDemo, scanResults]);
```

### Verified: niosMigrationMap State (from Figma reference line 144)

```typescript
const [niosMigrationMap, setNiosMigrationMap] = useState<Map<string, ServerFormFactor>>(new Map());

// Reset on restart (add to restart() function):
setNiosMigrationMap(new Map());
```

---

## Key Implementation Gaps (Delta Between Figma and Live App)

These are changes the live wizard.tsx needs that the Figma export does NOT have (and therefore are NOT in the Figma reference):

| Gap | Where | Fix |
|-----|-------|-----|
| `niosServerMetrics` field missing | `api-client.ts` `ScanResultsResponse` | Add `niosServerMetrics?: NiosServerMetricAPI[]` |
| `NiosServerMetricAPI` type missing | `api-client.ts` | Add interface (see above) |
| `calcServerTokenTier` function missing | `mock-data.ts` | Port from Figma `mock-data.ts` lines 585–591 |
| `consolidateXaasInstances` function missing | `mock-data.ts` | Port from Figma `mock-data.ts` lines 630–701 |
| `SERVER_TOKEN_TIERS`, `XAAS_TOKEN_TIERS` missing | `mock-data.ts` | Port from Figma `mock-data.ts` lines 564–581 |
| `XAAS_EXTRA_CONNECTION_COST` constant missing | `mock-data.ts` | Add `export const XAAS_EXTRA_CONNECTION_COST = 100` |
| `NiosServerMetrics`, `ServerFormFactor`, `ConsolidatedXaasInstance`, `ServerTokenTier` types missing | `mock-data.ts` | Port from Figma `mock-data.ts` lines 539–622 |
| `MOCK_NIOS_SERVER_METRICS` mock data missing | `mock-data.ts` | Port from Figma `mock-data.ts` lines 735–800 |
| `topDnsExpanded`, `topDhcpExpanded`, `topIpExpanded` state missing | `wizard.tsx` | Add 3 booleans to Wizard state |
| `niosMigrationMap` state missing | `wizard.tsx` | Add Map state to Wizard state |
| `Activity`, `Gauge`, `ArrowRightLeft`, `ChevronUp` icons missing from import | `wizard.tsx` | Add to lucide-react import |
| Reset of `niosMigrationMap` missing from `restart()` | `wizard.tsx` | Add `setNiosMigrationMap(new Map())` |
| Four JSX panel blocks missing from results step | `wizard.tsx` | Port from Figma reference |

The Figma export also renames `ad` provider to `microsoft` — this rename does NOT apply to the live app. The live app uses `ad`.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| SSE progress streaming | Polling every 1.5s (Phase 9) | Phase 9 | No impact on Phase 11 |
| Mock-only NIOS data | Live niosServerMetrics from API | Phase 10 | Phase 11 must wire live data |
| No NIOS result panels | Four panels in results step | Phase 11 | This phase |

---

## Open Questions

1. **figma:asset PNG imports in Figma mock-data.ts**
   - What we know: Figma export imports `NIOS_GRID_LOGO_PNG`, `INFOBLOX_HEADER_PNG`, `AZURE_LOGO_PNG` via `figma:asset/` protocol. The live wizard.tsx already uses `NIOS_GRID_LOGO` (a string constant).
   - What's unclear: Whether the live app has the NIOS grid logo as a standalone importable PNG at a known path.
   - Recommendation: Search `frontend/src/assets/` for the logo files. If present, use `import NIOS_GRID_LOGO_PNG from '../../assets/...'`. If not, use an inline SVG data URI or omit the `<img>` tag in panel headers — the logo is decorative.

2. **NiosServerMetricAPI role type strictness**
   - What we know: Backend `role` is a `string` (no enum in Go). Figma reference uses `'GM' | 'GMC' | 'DNS' | 'DHCP' | 'DNS/DHCP' | 'IPAM' | 'Reporting'` as the role on `NiosServerMetrics`.
   - What's unclear: Whether to make the API type strict or keep `string`.
   - Recommendation: Use `string` in `NiosServerMetricAPI` (matches backend), use the union type only for the local `NiosServerMetrics` type used in calc functions. This mirrors the existing pattern (API types are loose, internal types are strict).

3. **XaaS Consolidation as FE-06 — separate panel or unified?**
   - What we know: FE-06 says "XaaS Consolidation panel." The Figma reference integrates it into Server Token Calculator.
   - Recommendation: Implement as unified within Server Token Calculator. FE-06 is satisfied when the XaaS bin-packing with tier display and extra connection pricing is visible. A separate panel div is unnecessary and would diverge from the Figma reference visual.

---

## Validation Architecture

> `workflow.nyquist_validation` is `true` in `.planning/config.json` — this section is required.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | None installed — `frontend/package.json` has no test runner or vitest/jest |
| Config file | None — Wave 0 must install vitest |
| Quick run command | `cd frontend && npx vitest run --reporter=verbose src/app/components/nios-calc.test.ts` |
| Full suite command | `cd frontend && npx vitest run` |

### What Can Be Unit Tested (Pure Functions — Zero React)

These functions are deterministic, stateless, and have no I/O:

| Req ID | Behavior | Test Type | Automated Command |
|--------|----------|-----------|-------------------|
| FE-05 | `calcServerTokenTier(0, 0, 0, 'nios-x')` → `2XS` tier | unit | `vitest run src/.../nios-calc.test.ts` |
| FE-05 | `calcServerTokenTier(115000, 675, 880000, 'nios-x')` → `XL` tier | unit | vitest |
| FE-05 | `calcServerTokenTier(200000, 0, 0, 'nios-x')` → `XL` (caps at max) | unit | vitest |
| FE-05 | `calcServerTokenTier(20000, 200, 29000, 'nios-xaas')` → XaaS `S` tier | unit | vitest |
| FE-06 | `consolidateXaasInstances([])` → `[]` | unit | vitest |
| FE-06 | Single member → 1 instance, connectionsUsed=1, extraConnections=0 | unit | vitest |
| FE-06 | 11 members (all tiny) → 1 XaaS `S` instance with 1 extra connection (10 included + 1 extra = 100 tokens extra) | unit | vitest |
| FE-06 | Members exceeding XL capacity spill into second instance | unit | vitest |
| FE-06 | Extra connection cost = extraConnections × 100 | unit | vitest |
| FE-03 | Top-N selection: given 8 items, returns top 5 by managementTokens | unit | vitest (plain JS, no React) |

### What Needs Integration Testing (Component Rendering)

These require React component rendering with mock data:

| Req ID | Behavior | Test Type | Automated Command |
|--------|----------|-----------|-------------------|
| FE-03 | Top Consumer Cards render with non-empty findings; `visibleCards.length > 0` | component | vitest + @testing-library/react |
| FE-03 | Card expands on click and shows 5-row table | component | vitest + @testing-library/react |
| FE-04 | Migration Planner renders only when `selectedProviders.includes('nios')` | component | vitest + @testing-library/react |
| FE-04 | Scenario totals update when member checkbox toggled | component | vitest + @testing-library/react |
| FE-05 | Server Token Calculator shows — for QPS=0 members | component | vitest + @testing-library/react |

### What Needs E2E / Human Verification

| Req ID | Behavior | Why Automated is Insufficient |
|--------|----------|-------------------------------|
| FE-03 | Visual layout of expandable cards in results step | CSS correctness, overflow, mobile layout |
| FE-04 | Scenario comparison cards highlight correct active scenario | Visual active state (orange border) |
| FE-05 | NIOS-X vs XaaS toggle per member — visual feedback (blue vs purple bg) | Color contrast, click target size |
| FE-06 | XaaS instance grouping rows visually separate from NIOS-X rows | Table row group visual hierarchy |
| ALL | No regressions in existing cloud provider results display | Full results step regression |

### Sampling Rate
- **Per task commit:** `cd /Users/mustermann/Documents/coding/UDDI-GO-Token-Calculator/frontend && npx vitest run --reporter=verbose src/app/components/nios-calc.test.ts 2>&1 | tail -20`
- **Per wave merge:** `cd /Users/mustermann/Documents/coding/UDDI-GO-Token-Calculator/frontend && npx vitest run 2>&1 | tail -20`
- **Phase gate:** Full suite green + human verification of visual panels before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `frontend/package.json` — add `vitest` + `@testing-library/react` + `@testing-library/jest-dom` devDependencies, add `"test": "vitest run"` script
- [ ] `frontend/vite.config.ts` — add vitest configuration (`test: { environment: 'jsdom' }`)
- [ ] `frontend/src/app/components/nios-calc.test.ts` — unit tests for `calcServerTokenTier` and `consolidateXaasInstances`
- [ ] `frontend/src/app/components/nios-calc.ts` (or additions to `mock-data.ts`) — the calc functions must exist before tests can reference them

**Install command:**
```bash
cd /Users/mustermann/Documents/coding/UDDI-GO-Token-Calculator/frontend && pnpm add -D vitest @testing-library/react @testing-library/jest-dom jsdom
```

---

## Sources

### Primary (HIGH confidence)
- `Web UI for Token Calculation Updated/src/app/components/wizard.tsx` — Complete reference implementation of all four panels (2708 lines, directly read)
- `Web UI for Token Calculation Updated/src/app/components/mock-data.ts` — `calcServerTokenTier`, `consolidateXaasInstances`, tier tables, type definitions (directly read)
- `frontend/src/imports/performance-specs.csv` — NIOS-X tier data (kQPS, LPS, Allocated Tokens, Objects) — directly read, cross-verified against Figma mock-data.ts
- `frontend/src/imports/performance-metrics.csv` — XaaS tier data including connection limits and extra connection note — directly read, cross-verified
- `server/types.go` lines 126-133 — `NiosServerMetric` struct field names and json tags (directly read)
- `frontend/src/app/components/api-client.ts` — Current `ScanResultsResponse` interface (missing `niosServerMetrics`) — directly read
- `frontend/src/app/components/wizard.tsx` — Existing state structure, IIFE rendering pattern, restart/rescan handlers — directly read
- `frontend/src/app/components/mock-data.ts` — Existing exports to extend — directly read

### Secondary (MEDIUM confidence)
- `.planning/phases/10-nios-backend-scanner/10-04-SUMMARY.md` — Confirms `NiosServerMetric` struct was added in Phase 10 Plan 4 commit `93d822a`
- `.planning/STATE.md` accumulated decisions — Confirms all-frontend approach, incremental strategy

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries; existing React + Tailwind + TS
- Architecture: HIGH — Figma reference is complete and directly readable; tier data verified against bundled CSVs
- Pitfalls: HIGH — identified from direct diff of Figma export vs. live app; all gaps enumerated
- Tier data accuracy: HIGH — three independent sources agree (CSVs, Figma mock-data.ts, Figma wizard.tsx comments)

**Research date:** 2026-03-10
**Valid until:** 2026-04-10 (stable — tier pricing unlikely to change within 30 days)