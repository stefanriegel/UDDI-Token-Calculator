# S03: Frontend Nios Features

**Goal:** Install vitest test infrastructure, create nios-calc.
**Demo:** Install vitest test infrastructure, create nios-calc.

## Must-Haves


## Tasks

- [x] **T01: 11-frontend-nios-features 01**
  - Install vitest test infrastructure, create nios-calc.ts with all pure computation functions and types, and add the NiosServerMetricAPI type to api-client.ts.

Purpose: Wave 0 foundation — all downstream wizard.tsx changes depend on nios-calc.ts exports and api-client.ts type. Unit tests lock in the calc function contracts before JSX panels are added.
Output: nios-calc.ts (types + functions), nios-calc.test.ts (unit tests RED→GREEN), api-client.ts updated, vitest running.
- [x] **T02: 11-frontend-nios-features 02** `est:5min`
  - Add Top Consumer Cards (FE-03) to the wizard.tsx results step: three expandable accordion cards (DNS, DHCP, IP/Network) showing top-5 findings by managementTokens across all providers.

Purpose: FE-03 — users see which sources contribute most to each DDI object category, computed client-side from the existing `findings` state.
Output: Three accordion cards injected into the results step immediately after the per-source contribution bars section.
- [x] **T03: 11-frontend-nios-features 03** `est:15min`
  - Add NIOS-X Migration Planner (FE-04), Server Token Calculator (FE-05), and XaaS Consolidation (FE-06) panels to wizard.tsx. All three are client-side only, rendered only when 'nios' is in selectedProviders. XaaS Consolidation is embedded as grouped rows in the Server Token Calculator — not a separate panel.

Purpose: Complete the four NIOS result panels. Together with Plan 02's Top Consumer Cards, this satisfies FE-03 through FE-06.
Output: wizard.tsx gains niosMigrationMap state, niosServerMetrics derivation (useMemo), and three JSX blocks in the results step.
- [ ] **T04: 11-frontend-nios-features 04**
  - Human verification of all four NIOS result panels implemented in Plans 01–03. Confirm visual correctness, interactive behavior, and no regressions in existing provider results.

Purpose: Gate before marking Phase 11 complete. All automated tests pass but visual layout, color contrast, and interactive state transitions require human confirmation.
Output: Approved or issues reported for gap closure.

## Files Likely Touched

- `frontend/package.json`
- `frontend/vite.config.ts`
- `frontend/src/app/components/nios-calc.ts`
- `frontend/src/app/components/nios-calc.test.ts`
- `frontend/src/app/components/api-client.ts`
- `frontend/src/app/components/wizard.tsx`
- `frontend/src/app/components/wizard.tsx`
