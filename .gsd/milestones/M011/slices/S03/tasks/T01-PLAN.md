---
estimated_steps: 5
estimated_files: 1
skills_used: []
---

# T01: Add Reporting Token calculation and growth buffer state

**Slice:** S03 — BOM Panel, Reporting Tokens & Growth Buffer
**Milestone:** M011

## Description

Add the two foundational computed values that every other S03 feature depends on:

1. `growthBufferPct` state (default `0.20`) — a user-adjustable percentage that is multiplied into management token totals before pack rounding. Changing it must immediately recalculate all derived counts in the results view.
2. `calcReportingTokens` helper — converts `monthlyLogVolume` (events/month, set by the estimator's `startScan` short-circuit in S02) to a raw reporting token count across three destination types. Pack size is 40 tokens (IB-TOKENS-REPORTING-40).
3. `reportingTokens` useMemo — calls `calcReportingTokens(estimatorMonthlyLogVolume, allThreeDestinations)` so the BOM panel and exports can read a single value.
4. Modified `totalTokens` useMemo — applies the growth buffer: `Math.ceil(rawTotal * (1 + growthBufferPct))`. This single change propagates the buffer to every pack count derived from `totalTokens` (the MGMT-1000 pack label in the overview section, exports, etc.).
5. Growth buffer percentage input in the results view — a small `<input type="number">` control near the overview section header that lets the SE type a new percentage and watch counts update.

The estimator connector stores `monthlyLogVolume` in `estimatorMonthlyLogVolume` state (set at line 958 of wizard.tsx). That value is the sole input to Reporting Token calculation for now. Scan-based connectors do not produce a log volume, so their `reportingTokens` will be 0 unless an SE enters one manually — this manual-entry path is out of scope for S03 per R014.

**Reporting token formula (from R014 / official spreadsheet):**
- CSP 30-day active search: `ceil(monthlyLogVolume / 10_000_000) × 80`
- S3 bucket: `ceil(monthlyLogVolume / 10_000_000) × 40`
- Ecosystem/CDC: `ceil(monthlyLogVolume / 10_000_000) × 40`
- Total reporting tokens = sum of all three destinations
- Pack count = `ceil(reportingTokens / 40)`

**Growth buffer application rule (from KNOWLEDGE.md / P002):**
Apply after raw token calculation, before pack rounding:
`bufferedTokens = ROUNDDOWN(rawTokens × (1 + bufferPct), 0)` then `packCount = ROUNDUP(bufferedTokens / packSize, 0)`

For `totalTokens` specifically, the easiest correct implementation is:
`totalTokens = Math.ceil(rawTotal * (1 + growthBufferPct))`
where `rawTotal = effectiveFindings.reduce((s, f) => s + f.managementTokens, 0)`.

Server tokens (`totalServerTokens`) do NOT receive the management growth buffer — they have their own sizing methodology.

## Steps

1. Add `const [growthBufferPct, setGrowthBufferPct] = useState<number>(0.20)` near line 513 (Manual Estimator state block). Add `setGrowthBufferPct(0.20)` to the `restart()` function near line 686.

2. Add the `calcReportingTokens` helper function just above `exportCSV` (around line 1306). Signature:
   ```ts
   function calcReportingTokens(monthlyLogVolume: number): number {
     if (monthlyLogVolume <= 0) return 0;
     const billable10M = Math.ceil(monthlyLogVolume / 10_000_000);
     return billable10M * 80   // CSP 30-day active search
          + billable10M * 40   // S3 bucket
          + billable10M * 40;  // Ecosystem/CDC
   }
   ```

3. Add `const reportingTokens = useMemo(() => calcReportingTokens(estimatorMonthlyLogVolume), [estimatorMonthlyLogVolume])` near the `totalTokens` useMemo (around line 1135).

4. Modify the `totalTokens` useMemo to apply the growth buffer:
   ```ts
   const totalTokens = useMemo(
     () => Math.ceil(effectiveFindings.reduce((sum, f) => sum + f.managementTokens, 0) * (1 + growthBufferPct)),
     [effectiveFindings, growthBufferPct]
   );
   ```

5. Add a growth buffer input control in the results view. Find the `section-overview` div (around line 3160). Inside the overview panel, just before the "Total Management Tokens" grid, add a small row:
   ```tsx
   <div className="flex items-center gap-2 mb-4">
     <label className="text-[12px] text-[var(--muted-foreground)]">Growth Buffer</label>
     <input
       type="number" min={0} max={100} step={1}
       value={Math.round(growthBufferPct * 100)}
       onChange={(e) => setGrowthBufferPct(Math.max(0, Math.min(100, Number(e.target.value))) / 100)}
       className="w-16 px-2 py-1 text-[13px] border border-[var(--border)] rounded text-center"
     />
     <span className="text-[12px] text-[var(--muted-foreground)]">%</span>
   </div>
   ```

## Must-Haves

- [ ] `growthBufferPct` useState with default 0.20 and reset in `restart()`
- [ ] `calcReportingTokens(monthlyLogVolume)` pure function returning raw token count (not pack count)
- [ ] `reportingTokens` useMemo that calls `calcReportingTokens(estimatorMonthlyLogVolume)`
- [ ] `totalTokens` useMemo applies `* (1 + growthBufferPct)` before rounding — the buffer is baked into `totalTokens` so all derived pack counts automatically pick it up
- [ ] Growth buffer percentage input renders in the results view and live-updates `totalTokens` when changed
- [ ] All 22 existing Vitest tests still pass

## Verification

- `cd frontend && npx vitest run` — all tests pass (zero regressions)
- `grep -c "growthBufferPct" frontend/src/app/components/wizard.tsx` returns ≥ 3
- `grep -c "calcReportingTokens" frontend/src/app/components/wizard.tsx` returns ≥ 2
- `grep -c "reportingTokens" frontend/src/app/components/wizard.tsx` returns ≥ 2

## Inputs

- `frontend/src/app/components/wizard.tsx` — existing file; adds state near line 513, modifies `totalTokens` useMemo near line 1135, adds helper near line 1306, adds UI near line 3160
- `frontend/src/app/components/estimator-calc.ts` — read for `monthlyLogVolume` contract (returned in `EstimatorOutputs`, stored in `estimatorMonthlyLogVolume` state)

## Expected Output

- `frontend/src/app/components/wizard.tsx` — modified: `growthBufferPct` state, `calcReportingTokens` function, `reportingTokens` useMemo, updated `totalTokens` useMemo, growth buffer input UI in results view
