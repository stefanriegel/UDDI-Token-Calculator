---
id: T01
parent: S03
milestone: M002
provides: []
requires: []
affects: []
key_files: []
key_decisions: []
patterns_established: []
observability_surfaces: []
drill_down_paths: []
duration: 
verification_result: passed
completed_at: 
blocker_discovered: false
---
# T01: 11-frontend-nios-features 01

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
