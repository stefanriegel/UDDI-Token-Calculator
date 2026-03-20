# S02: Manual Estimator Connector

**Goal:** Add a "Manual Estimator" provider to the connector list. Selecting it skips straight to a guided questionnaire, runs a client-side calculation, and lands at the standard results view with `FindingRow[]` data shaped identically to scan connectors — formula output proven to match the official spreadsheet.
**Demo:** SE opens the tool → clicks "Manual Estimator" → completes the questionnaire (workers, active IPs, DHCP %, DNS/DHCP toggles, sites, networks/site, reporting destinations) → clicks through → sees management token totals in the results view. Three reference inputs from the official spreadsheet produce the same DDI/IP/Asset counts and management tokens as the spreadsheet.

## Must-Haves

- `estimator-calc.ts` pure-math module implementing the full ESTIMATOR formula chain from the spreadsheet, with no React imports
- Vitest tests in `estimator-calc.test.ts` proving three reference cases match the spreadsheet exactly (DDI Objects, Active IPs, Assets, monthly log volume)
- `'estimator'` added to `ProviderType` union; all wizard state Records initialised correctly (no TypeScript errors)
- Provider card for Manual Estimator appears in Step 1 with Infoblox logo and no credentials step
- Questionnaire UI collects all required inputs across the question steps defined in the ESTIMATOR sheet; "Scan" step runs instantly and populates `findings` with `FindingRow[]`
- Results view shows Management Token calculation from estimator data (same display as scan connectors)
- `FindingRow[]` produced by the estimator uses the same field names and category strings (`'DDI Objects'`, `'Active IPs'`, `'Managed Assets'`) as scan connectors so the existing export pipeline in S03 works unchanged
- Monthly log volume is stored on estimator state (as `estimatorMonthlyLogVolume`) for S03 Reporting Token consumption

## Proof Level

- This slice proves: contract + integration
- Real runtime required: no (pure frontend math; vitest + tsc verify correctness)
- Human/UAT required: yes (SE walkthrough of questionnaire clarity after code is done)

## Verification

- `cd frontend && npx vitest run src/app/components/estimator-calc.test.ts` — all reference-case tests pass
- `cd frontend && npx vitest run` — full test suite passes (no regressions in existing nios-calc.test.ts)
- `cd frontend && npx tsc --noEmit 2>&1 | grep -v "activeIPCount"` — zero new TypeScript errors (only the pre-existing `activeIPCount` errors from nios-calc.test.ts that S01 documented)
- `grep -c "'estimator'" frontend/src/app/components/mock-data.ts` — returns ≥ 1 (estimator in PROVIDERS)
- `grep -c "estimatorMonthlyLogVolume" frontend/src/app/components/wizard.tsx` — returns ≥ 1 (log volume stored for S03)

## Observability / Diagnostics

- Runtime signals: estimator results are synchronous (no async); all `FindingRow[]` objects written to `findings` state immediately on questionnaire submit, same path as demo-mode scan findings
- Inspection surfaces: browser DevTools React state — `findings` should contain rows with `provider: 'estimator'`; `estimatorMonthlyLogVolume` state should be a positive number when DNS or DHCP protocol logging is enabled
- Failure visibility: if formulas produce wrong totals, the reference-case Vitest tests catch it before the UI is reached; TypeScript catches shape mismatches at compile time

## Integration Closure

- Upstream surfaces consumed: `FindingRow` type from `mock-data.ts`; `TOKEN_RATES` constants; existing `startScan`/`findings`/results machinery in `wizard.tsx`
- New wiring introduced: `estimator-calc.ts` imported into `wizard.tsx`; `'estimator'` added to `ProviderType` union and all state Records; questionnaire answers short-circuit the credentials + sources steps; `startScan` detects the estimator provider and skips API calls
- What remains before the milestone is truly usable end-to-end: S03 (BOM panel, Reporting Tokens using `estimatorMonthlyLogVolume`, growth buffer UI, export enhancements)

## Tasks

- [ ] **T01: Implement estimator-calc.ts with formula chain and Vitest reference tests** `est:1h`
  - Why: The formula chain is the core risk of this slice. Isolating it in a pure module (no React) means it can be unit-tested independently of UI complexity, and S03 can import `calcMonthlyLogVolume` directly without touching the wizard.
  - Files: `frontend/src/app/components/estimator-calc.ts`, `frontend/src/app/components/estimator-calc.test.ts`
  - Do: Implement the full ESTIMATOR derivation chain from M011-CONTEXT.md (variables → DNS → IPAM/DHCP → DDI Objects / Active IPs / Assets / monthly log volume). Export `EstimatorInputs`, `EstimatorOutputs`, and `calcEstimator(inputs)`. Add three reference test cases whose inputs and expected outputs are derived from the spreadsheet. Provide the reference case values inline in the task plan.
  - Verify: `cd frontend && npx vitest run src/app/components/estimator-calc.test.ts`
  - Done when: All three reference-case tests pass and `estimator-calc.ts` has zero TypeScript errors

- [ ] **T02: Wire estimator provider into wizard — ProviderType, questionnaire UI, scan routing, and results** `est:2h`
  - Why: Adds `'estimator'` to every state Record in wizard.tsx, builds the questionnaire UI in the credentials/sources steps, routes through startScan without an API call, populates `findings` and `estimatorMonthlyLogVolume`, and surfaces results in the existing results view.
  - Files: `frontend/src/app/components/mock-data.ts`, `frontend/src/app/components/wizard.tsx`
  - Do: (1) Add `'estimator'` to `ProviderType` union and `PROVIDERS` array in mock-data.ts; add `BACKEND_PROVIDER_ID.estimator = 'estimator'` and empty MOCK_SUBSCRIPTIONS entry. (2) In wizard.tsx, expand all `Record<ProviderType,...>` initial values to include `'estimator'`. (3) In the credentials step, render a questionnaire form when `selectedProviders[0] === 'estimator'` and set `credentialStatus.estimator = 'valid'` immediately on any change. (4) In `startScan`, if `selectedProviders.includes('estimator')`, call `calcEstimator` from `estimator-calc.ts`, convert outputs to `FindingRow[]`, populate `findings`, set `estimatorMonthlyLogVolume`, and mark `scanProgress = 100` synchronously — no API call. (5) Sources step: skip (estimator has no subscriptions). (6) Keep the `restart()` function consistent (add estimator keys to all reset Records).
  - Verify: `cd frontend && npx tsc --noEmit 2>&1 | grep -v "activeIPCount"` produces zero new errors; `cd frontend && npx vitest run` stays green
  - Done when: TypeScript compiles clean; selecting "Manual Estimator" in the UI, entering questionnaire values, and clicking through produces a non-empty `findings` array with `provider: 'estimator'` rows visible in the results view

## Files Likely Touched

- `frontend/src/app/components/estimator-calc.ts` (new)
- `frontend/src/app/components/estimator-calc.test.ts` (new)
- `frontend/src/app/components/mock-data.ts`
- `frontend/src/app/components/wizard.tsx`
