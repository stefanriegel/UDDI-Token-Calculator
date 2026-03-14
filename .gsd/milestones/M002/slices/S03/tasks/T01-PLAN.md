# T01: 11-frontend-nios-features 01

**Slice:** S03 — **Milestone:** M002

## Description

Install vitest test infrastructure, create nios-calc.ts with all pure computation functions and types, and add the NiosServerMetricAPI type to api-client.ts.

Purpose: Wave 0 foundation — all downstream wizard.tsx changes depend on nios-calc.ts exports and api-client.ts type. Unit tests lock in the calc function contracts before JSX panels are added.
Output: nios-calc.ts (types + functions), nios-calc.test.ts (unit tests RED→GREEN), api-client.ts updated, vitest running.

## Must-Haves

- [ ] "vitest runs and collects tests from frontend/src/"
- [ ] "calcServerTokenTier returns correct tier name for known QPS/LPS/objectCount inputs"
- [ ] "consolidateXaasInstances returns correct instance groupings and extra-connection costs"
- [ ] "ScanResultsResponse.niosServerMetrics field is typed so wizard.tsx can access it without TypeScript error"

## Files

- `frontend/package.json`
- `frontend/vite.config.ts`
- `frontend/src/app/components/nios-calc.ts`
- `frontend/src/app/components/nios-calc.test.ts`
- `frontend/src/app/components/api-client.ts`
