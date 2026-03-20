---
estimated_steps: 5
estimated_files: 2
skills_used:
  - frontend-design
  - react-best-practices
---

# T02: Wire estimator provider into wizard — ProviderType, questionnaire UI, scan routing, and results

**Slice:** S02 — Manual Estimator Connector
**Milestone:** M011

## Description

Integrate the Manual Estimator connector end-to-end into the wizard. This task:
1. Extends `mock-data.ts` — adds `'estimator'` to `ProviderType`, `PROVIDERS`, `BACKEND_PROVIDER_ID`, and `MOCK_SUBSCRIPTIONS`
2. Updates `wizard.tsx` — expands every `Record<ProviderType,...>` initial state to include `'estimator'`; adds questionnaire UI in the credentials step; short-circuits `startScan` for the estimator (synchronous client-side calc, no API call); stores `estimatorMonthlyLogVolume` state; produces `FindingRow[]` that the existing results view renders without modification

The estimator provider bypasses three steps that don't apply to it:
- **Credentials step**: replaced by the questionnaire form (no servers, no API keys)
- **Sources step**: skipped (no subscriptions to enumerate)  
- **Scan step**: completes instantly (synchronous JS calculation)

## Steps

1. **Extend `mock-data.ts`**:
   - Add `'estimator'` to the `ProviderType` union type
   - Add `BACKEND_PROVIDER_ID.estimator = 'estimator'`
   - Add `toFrontendProvider` mapping: `'estimator' → 'estimator'`
   - Add estimator entry to `PROVIDER_LOGOS` (use `INFOBLOX_LOGO` — already imported)
   - Add estimator entry to `PROVIDERS` array:
     ```ts
     {
       id: 'estimator',
       name: 'Manual Estimator',
       fullName: 'Manual Sizing Estimator',
       color: '#00A5E5',
       description: 'Calculate tokens from environment size without a live scan',
       subscriptionLabel: 'Environments',
       authMethods: [], // no credentials
     }
     ```
   - Add `estimator: []` to `MOCK_SUBSCRIPTIONS`

2. **Update `wizard.tsx` — state initialisation**:
   Expand every `Record<ProviderType, ...>` literal to include the `'estimator'` key. The places that need updating (search for `efficientip:` to find each one):
   - `credentials` state initial value: `estimator: {}`
   - `credentialStatus` state: `estimator: 'idle'`
   - `subscriptions` state: `estimator: []`
   - `providerScanProgress` state: `estimator: 0`
   - `credentialError` state: `estimator: { message: '' }`
   - `selectedAuthMethod` state: `estimator: ''`
   - `sourceSearch` state: `estimator: ''`
   - `advancedOptions` state: `estimator: { maxWorkers: 0 }`
   - `selectionMode` state: `estimator: 'include'`
   - `initProgress` inside `startScan`: `estimator: 0`
   - `restart()` function: all reset objects above
   - `adMigrationMap` and other NIOS/AD specific state: these are ProviderType-keyed only where they use `Record<ProviderType,...>` literals — check each one

3. **Add `estimatorAnswers` and `estimatorMonthlyLogVolume` state**:
   ```ts
   import { EstimatorInputs, EstimatorDefaults, calcEstimator } from './estimator-calc';

   const [estimatorAnswers, setEstimatorAnswers] = useState<EstimatorInputs>({
     ...EstimatorDefaults,
   });
   const [estimatorMonthlyLogVolume, setEstimatorMonthlyLogVolume] = useState<number>(0);
   ```
   Add both to `restart()` (reset to defaults / 0).

4. **Questionnaire UI in credentials step**:
   In the `currentStep === 'credentials'` block, before (or instead of) the per-provider credential form, add a branch for `selectedProviders[0] === 'estimator'`:
   ```tsx
   {selectedProviders.includes('estimator') && (
     <EstimatorQuestionnaire
       answers={estimatorAnswers}
       onChange={(updated) => {
         setEstimatorAnswers(updated);
         // Mark estimator as "valid" as soon as there are any answers (no API validation needed)
         setCredentialStatus(prev => ({ ...prev, estimator: 'valid' }));
       }}
     />
   )}
   ```
   
   Implement `EstimatorQuestionnaire` as a local function component (inside wizard.tsx) with these fields — use `<input type="number">` for numeric values, checkboxes for toggles:
   
   | Field | Label | Default | Type |
   |---|---|---|---|
   | activeIPs | Active IP Addresses | 1000 | number |
   | dhcpPct | DHCP Percentage (%) | 80 | number (0–100, stored as 0.01–1.0 by dividing by 100) |
   | enableIPAM | Enable IPAM | true | checkbox |
   | enableDNS | DNS Management | true | checkbox |
   | enableDNSProtocol | DNS Protocol Logging | false | checkbox |
   | enableDHCP | DHCP Management | true | checkbox |
   | enableDHCPLog | DHCP Logging | false | checkbox |
   | sites | Number of Sites/Branches | 1 | number |
   | networksPerSite | Networks per Site | 4 | number |
   
   Set `credentialStatus.estimator = 'valid'` on first render (no validation needed).

5. **Short-circuit `startScan` for estimator**:
   At the top of the `startScan` callback, before the `if (backend.isDemo)` branch, add:
   ```ts
   if (selectedProviders.includes('estimator')) {
     const out = calcEstimator(estimatorAnswers);
     const estimatorFindings: FindingRow[] = [];
     if (out.ddiObjects > 0) estimatorFindings.push({
       provider: 'estimator', source: 'Manual Estimator',
       category: 'DDI Object', item: 'Estimated DDI Objects', count: out.ddiObjects,
       tokensPerUnit: TOKEN_RATES['DDI Object'], managementTokens: Math.ceil(out.ddiObjects / TOKEN_RATES['DDI Object']),
     });
     if (out.activeIPs > 0) estimatorFindings.push({
       provider: 'estimator', source: 'Manual Estimator',
       category: 'Active IP', item: 'Estimated Active IPs', count: out.activeIPs,
       tokensPerUnit: TOKEN_RATES['Active IP'], managementTokens: Math.ceil(out.activeIPs / TOKEN_RATES['Active IP']),
     });
     if (out.discoveredAssets > 0) estimatorFindings.push({
       provider: 'estimator', source: 'Manual Estimator',
       category: 'Asset', item: 'Estimated Assets', count: out.discoveredAssets,
       tokensPerUnit: TOKEN_RATES['Asset'], managementTokens: Math.ceil(out.discoveredAssets / TOKEN_RATES['Asset']),
     });
     setFindings(estimatorFindings);
     setEstimatorMonthlyLogVolume(out.monthlyLogVolume);
     setScanProgress(100);
     setProviderScanProgress(prev => ({ ...prev, estimator: 100 }));
     return;
   }
   ```

   Also skip the sources step for estimator: in `canGoNext()` for `'sources'`, treat the estimator as always having ≥ 1 effective source; or more simply — in `goNext()`, when the current step is `'credentials'` and the estimator is selected, advance directly to `'scanning'` (skipping `'sources'`).

   **Sources step skip logic**: in `goNext()`, add before the existing logic:
   ```ts
   if (currentStep === 'credentials' && selectedProviders.includes('estimator')) {
     setCurrentStep('scanning');
     startScan();
     return;
   }
   ```

   In `canGoNext()` for `'sources'`: add `|| selectedProviders.includes('estimator')` to the sources condition so it always passes if the estimator is selected.

## Must-Haves

- [ ] `'estimator'` added to `ProviderType` union and `PROVIDERS` array — compiler confirms no missed Record initialisation
- [ ] All `Record<ProviderType, ...>` literals in wizard.tsx include `estimator` key (search `efficientip:` and add `estimator:` after each one)
- [ ] `estimatorAnswers` and `estimatorMonthlyLogVolume` state added; both reset in `restart()`
- [ ] Estimator credential step shows a questionnaire form (not a credential form); `credentialStatus.estimator` becomes `'valid'` on component mount so "Next" button is enabled
- [ ] `startScan` detects estimator and calls `calcEstimator`, producing `FindingRow[]` synchronously — no fetch, no interval
- [ ] Sources step is skipped for the estimator path (go from credentials directly to scanning)
- [ ] `FindingRow[]` uses `category: 'DDI Object'` / `'Active IP'` / `'Asset'` strings (matching existing mock-data conventions, not the `'DDI Objects'` backend strings)
- [ ] `estimatorMonthlyLogVolume` is stored in state and reset to 0 in `restart()`
- [ ] TypeScript compiles with zero new errors (`npx tsc --noEmit | grep -v activeIPCount`)

## Verification

- `cd frontend && npx tsc --noEmit 2>&1 | grep -v "activeIPCount"` — zero errors output
- `cd frontend && npx vitest run` — all tests pass (no regressions)
- `grep -c "'estimator'" frontend/src/app/components/mock-data.ts` — returns ≥ 1
- `grep -c "estimatorMonthlyLogVolume" frontend/src/app/components/wizard.tsx` — returns ≥ 1

## Observability Impact

- Signals added/changed: `estimatorMonthlyLogVolume` state is non-zero when DNS or DHCP protocol logging is enabled — S03 reads this to compute Reporting Tokens
- How a future agent inspects this: React DevTools → Wizard state → `estimatorMonthlyLogVolume`; also visible as a prop in `EstimatorQuestionnaire` renders
- Failure state exposed: if `startScan` is called with estimator but `calcEstimator` throws, `scanError` state is set (existing error path)

## Inputs

- `frontend/src/app/components/estimator-calc.ts` — output of T01; provides `EstimatorInputs`, `EstimatorDefaults`, `calcEstimator`
- `frontend/src/app/components/mock-data.ts` — `ProviderType`, `PROVIDERS`, `BACKEND_PROVIDER_ID`, `TOKEN_RATES`, `FindingRow`
- `frontend/src/app/components/wizard.tsx` — main wizard component (all state, step machine, startScan logic)

## Expected Output

- `frontend/src/app/components/mock-data.ts` — updated with `'estimator'` in `ProviderType`, `PROVIDERS`, `BACKEND_PROVIDER_ID`, `MOCK_SUBSCRIPTIONS`, `PROVIDER_LOGOS`
- `frontend/src/app/components/wizard.tsx` — updated with questionnaire state, questionnaire UI, sources-step skip, estimator scan short-circuit, and `estimatorMonthlyLogVolume` state
