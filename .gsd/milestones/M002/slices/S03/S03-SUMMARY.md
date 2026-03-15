---
id: S03
parent: M002
milestone: M002
provides:
  - Top Consumer Cards accordion UI (DNS, DHCP, IP/Network) in wizard.tsx results step
  - topDnsExpanded/topDhcpExpanded/topIpExpanded expand state with restart() reset
  - Migration Planner panel (FE-04): three scenario cards + per-member migration checkbox table
  - Server Token Calculator panel (FE-05): per-member NIOS-X/XaaS toggle with tier lookup
  - XaaS Consolidation (FE-06): consolidated XaaS instances embedded as grouped rows in Server Token Calculator
  - niosMigrationMap state (Map<string, ServerFormFactor>) in wizard.tsx
  - niosServerMetrics useMemo derivation (demo vs live) in wizard.tsx
requires: []
affects: []
key_files: []
key_decisions:
  - "Top Consumer Cards use regex-based item filtering against FindingRow.item — no new backend fields needed"
  - "consumerCards array defined inside IIFE — keeps filter/toggle callbacks local, no useMemo overhead"
  - "ArrowRightLeft imported but not yet used in cards — included per plan interfaces spec for future use"
  - "XaaS Consolidation is embedded as grouped rows in Server Token Calculator — not a separate panel (per plan spec)"
  - "niosServerMetrics useMemo casts via unknown to bridge NiosServerMetricAPI (loose role string) and NiosServerMetrics (typed role union)"
  - "Migration Planner Hybrid token estimate uses proportional remainder: currentNiosTokens * (1 - migratedCount/totalCount)"
patterns_established:
  - "Consumer card IIFE: build array of card configs, map to items via filter/sort/slice, filter out empty cards, render grid"
  - "NIOS panels gated on selectedProviders.includes('nios') && niosServerMetrics.length > 0"
  - "QPS/LPS em-dash: m.qps > 0 ? m.qps.toLocaleString() : <span>&mdash;</span>"
observability_surfaces: []
drill_down_paths: []
duration: 15min
verification_result: passed
completed_at: 2026-03-10
blocker_discovered: false
---
# S03: Frontend Nios Features

**# Phase 11 Plan 01: Vitest Infrastructure + nios-calc.ts Foundation Summary**

## What Happened

# Phase 11 Plan 01: Vitest Infrastructure + nios-calc.ts Foundation Summary

vitest test infra installed, nios-calc.ts created with tier tables and pure calc functions (calcServerTokenTier + consolidateXaasInstances), api-client.ts updated with NiosServerMetricAPI type and niosServerMetrics field on ScanResultsResponse.

## What Was Built

### nios-calc.ts (new file)
Pure TypeScript computation module. No React. No side effects. Exports:
- `ServerFormFactor` type union (`'nios-x' | 'nios-xaas'`)
- `ServerTokenTier`, `NiosServerMetrics`, `ConsolidatedXaasInstance` interfaces
- `SERVER_TOKEN_TIERS`: 6 NIOS-X on-prem tiers (2XS through XL) — values from performance-specs.csv
- `XAAS_TOKEN_TIERS`: 4 XaaS tiers (S through XL) — values from performance-metrics.csv
- `XAAS_EXTRA_CONNECTION_COST = 100`, `XAAS_MAX_EXTRA_CONNECTIONS = 400`
- `calcServerTokenTier(qps, lps, objectCount, formFactor)`: linear scan, caps at XL
- `consolidateXaasInstances(members)`: sort by QPS desc, max-aggregation, flush on XL overflow
- `MOCK_NIOS_SERVER_METRICS`: 8 representative members (GM, GMC, DNS×2, DHCP, DNS/DHCP, IPAM, Reporting)

### nios-calc.test.ts (new file)
13 unit tests covering all behavior cases from the plan spec:
- 7 `calcServerTokenTier` tests: 2XS zero case, XS boundary, M tier exact match, XL cap, XaaS S tier, default form factor, XaaS XL cap
- 6 `consolidateXaasInstances` tests: empty input, single member, 11 members (S tier + 1 extra connection + 100 extra tokens), metrics overflow split, XAAS_EXTRA_CONNECTION_COST constant

### api-client.ts (modified)
Added `NiosServerMetricAPI` interface (memberId, memberName, role, qps, lps, objectCount) and `niosServerMetrics?: NiosServerMetricAPI[]` as last field of `ScanResultsResponse`. Wizard.tsx can now access `scanResults.niosServerMetrics` without TypeScript errors.

### vite.config.ts (modified)
Added `/// <reference types="vitest" />` triple-slash directive and `test: { environment: 'jsdom', globals: true }` block. All other config blocks (plugins, resolve, assetsInclude, server, build) untouched.

### package.json (modified)
Added `"test": "vitest run"` script alongside existing `build` and `dev`.

## Test Results

```
Test Files: 1 passed (1)
Tests:      13 passed (13)
Duration:   ~600ms
```

`npm run test` exits 0. `npx tsc --noEmit` exits 0.

## Deviations from Plan

None — plan executed exactly as written.

The TDD order in the plan is: Task 1 = implementation, Task 2 = tests. In practice the TDD cycle ran as: install deps → configure → write tests (RED) → write implementation (GREEN) → verify all pass. Both tasks committed separately per protocol. The reversal is a natural consequence of TDD (test before code).

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1    | da70ae5 | feat(11-01): create nios-calc.ts with types, tier tables, and pure calc functions |
| 2    | cf19f74 | feat(11-01): install vitest, add test script, configure jsdom env, write nios-calc tests, update api-client.ts |

## Self-Check: PASSED

- `frontend/src/app/components/nios-calc.ts` — FOUND
- `frontend/src/app/components/nios-calc.test.ts` — FOUND
- Commit da70ae5 — FOUND
- Commit cf19f74 — FOUND
- All 13 tests pass
- TypeScript: no errors

# Phase 11 Plan 02: Top Consumer Cards Summary

**Three expandable accordion cards (DNS, DHCP, IP/Network) injected into results step, each showing top-5 findings by managementTokens computed client-side from existing findings state**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-03-10T09:49:00Z
- **Completed:** 2026-03-10T09:53:00Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Added `Activity`, `Gauge`, `ArrowRightLeft`, `ChevronUp` to lucide-react import in wizard.tsx
- Added `topDnsExpanded`, `topDhcpExpanded`, `topIpExpanded` boolean state with reset in `restart()`
- Inserted Top Consumer Cards JSX block (IIFE pattern) between per-source contribution bars and 3-category-columns section
- Cards filter findings by item-name regex, sort top-5 descending by managementTokens, expand/collapse on header click
- Cards hidden when no matching findings exist (`visibleCards.length === 0 return null`)
- TypeScript compiles with zero errors; all 13 vitest tests still pass

## Task Commits

Each task was committed atomically:

1. **Task 1: Add state, icons, and Top Consumer Cards to wizard.tsx** - `ed630e8` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `frontend/src/app/components/wizard.tsx` - Added icons, expand state, restart resets, Top Consumer Cards JSX block

## Decisions Made
- Top Consumer Cards use regex-based item filtering against `FindingRow.item` — no new backend fields needed, works across all providers
- `ArrowRightLeft` imported per plan interfaces spec (reserved for future XaaS consolidation panel use)
- Accordion pattern uses inline `useState` toggle — consistent with IIFE pattern already established in this file

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Top Consumer Cards (FE-03) complete and rendering in results step
- wizard.tsx ready for Plan 11-03 (Migration Planner) additions

---
*Phase: 11-frontend-nios-features*
*Completed: 2026-03-10*

# Phase 11 Plan 03: NIOS Migration Planner + Server Token Calculator + XaaS Consolidation Summary

**NIOS-X Migration Planner, Server Token Calculator, and XaaS Consolidation panels added to wizard.tsx, completing all four NIOS result panels (FE-03 through FE-06)**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-03-10T08:38:00Z
- **Completed:** 2026-03-10T08:53:22Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments
- Added nios-calc.ts imports, niosMigrationMap state, and niosServerMetrics useMemo to wizard.tsx (Task 1)
- Inserted NIOS-X Migration Planner JSX with three scenario cards and per-member checkbox table (Task 2 / FE-04)
- Inserted Server Token Calculator JSX with per-member NIOS-X/XaaS form factor toggle and tier lookup (Task 2 / FE-05)
- XaaS Consolidation grouped rows embedded within Server Token Calculator (Task 2 / FE-06)
- Zero TypeScript errors, 13 vitest tests pass, production build succeeds (237.54 kB JS, 1.17s)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add niosMigrationMap state, niosServerMetrics derivation, and nios-calc imports** - `681a464` (feat)
2. **Task 2: Add Migration Planner, Server Token Calculator, and XaaS Consolidation JSX panels** - `ec8e475` (feat)

**Plan metadata:** _(docs commit follows)_

## Files Created/Modified
- `frontend/src/app/components/wizard.tsx` - Added nios-calc imports, NiosServerMetricAPI import, niosMigrationMap state, restart reset, niosServerMetrics useMemo, Migration Planner JSX block, Server Token Calculator + XaaS Consolidation JSX block

## Decisions Made
- XaaS Consolidation is embedded as grouped rows inside the Server Token Calculator table — not a separate panel. This matches the plan spec and avoids UI duplication.
- `niosServerMetrics` useMemo casts via `unknown` to bridge the `NiosServerMetricAPI.role: string` (loose type from api-client) and `NiosServerMetrics.role` (typed union in nios-calc). No structural change needed.
- Migration Planner Hybrid scenario uses proportional remainder formula rather than tracking individual member tokens, keeping the estimate lightweight and responsive to checkbox toggling.

## Deviations from Plan

None - plan executed exactly as written. Fragment was already imported on line 1 of wizard.tsx.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- All four NIOS result panels (FE-03 through FE-06) are now complete
- Phase 11 is fully implemented: plan 01 (nios-calc.ts), plan 02 (Top Consumer Cards), plan 03 (Migration Planner + Server Token Calculator + XaaS)
- No blockers for phase completion

## Self-Check

- [x] wizard.tsx modified: FOUND via git log (681a464, ec8e475)
- [x] niosMigrationMap state present: added after topIpExpanded
- [x] restart() reset: setNiosMigrationMap(new Map()) present
- [x] niosServerMetrics useMemo: present before totalTokens useMemo
- [x] Migration Planner JSX: gated on selectedProviders.includes('nios') && niosServerMetrics.length > 0
- [x] Server Token Calculator JSX: gated on same condition
- [x] TypeScript: zero errors confirmed
- [x] Tests: 13/13 pass
- [x] Build: success (237.54 kB, 1.17s)

---
*Phase: 11-frontend-nios-features*
*Completed: 2026-03-10*
