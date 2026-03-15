---
id: T03
parent: S03
milestone: M002
provides:
  - Migration Planner panel (FE-04): three scenario cards + per-member migration checkbox table
  - Server Token Calculator panel (FE-05): per-member NIOS-X/XaaS toggle with tier lookup
  - XaaS Consolidation (FE-06): consolidated XaaS instances embedded as grouped rows in Server Token Calculator
  - niosMigrationMap state (Map<string, ServerFormFactor>) in wizard.tsx
  - niosServerMetrics useMemo derivation (demo vs live) in wizard.tsx
requires: []
affects: []
key_files: []
key_decisions: []
patterns_established: []
observability_surfaces: []
drill_down_paths: []
duration: 15min
verification_result: passed
completed_at: 2026-03-10
blocker_discovered: false
---
# T03: 11-frontend-nios-features 03

**# Phase 11 Plan 03: NIOS Migration Planner + Server Token Calculator + XaaS Consolidation Summary**

## What Happened

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
