# T03: 11-frontend-nios-features 03

**Slice:** S03 — **Milestone:** M002

## Description

Add NIOS-X Migration Planner (FE-04), Server Token Calculator (FE-05), and XaaS Consolidation (FE-06) panels to wizard.tsx. All three are client-side only, rendered only when 'nios' is in selectedProviders. XaaS Consolidation is embedded as grouped rows in the Server Token Calculator — not a separate panel.

Purpose: Complete the four NIOS result panels. Together with Plan 02's Top Consumer Cards, this satisfies FE-03 through FE-06.
Output: wizard.tsx gains niosMigrationMap state, niosServerMetrics derivation (useMemo), and three JSX blocks in the results step.

## Must-Haves

- [ ] "Migration Planner panel renders only when selectedProviders includes 'nios'"
- [ ] "Migration Planner shows three scenario cards: Current NIOS, Hybrid, Full UDDI"
- [ ] "Server Token Calculator shows per-member rows with NIOS-X/XaaS toggle and tier lookup"
- [ ] "XaaS Consolidation instances appear as grouped rows within Server Token Calculator (no separate panel)"
- [ ] "Members with QPS=0/LPS=0 show em-dash instead of 0 in metric columns"
- [ ] "Live data comes from scanResults.niosServerMetrics; demo mode uses MOCK_NIOS_SERVER_METRICS"

## Files

- `frontend/src/app/components/wizard.tsx`
