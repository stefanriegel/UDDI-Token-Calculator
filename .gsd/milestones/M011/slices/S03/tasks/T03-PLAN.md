---
estimated_steps: 4
estimated_files: 1
skills_used: []
---

# T03: Enhance CSV and Excel exports with Reporting Tokens and growth buffer

**Slice:** S03 — BOM Panel, Reporting Tokens & Growth Buffer
**Milestone:** M011

## Description

Update `exportCSV()` and `exportExcel()` in wizard.tsx to include (R017):
1. A "Growth Buffer: X%" metadata line so the export recipient knows the buffer was applied
2. An IB-TOKENS-REPORTING-40 row in the Recommended SKUs section when `reportingTokens > 0`

Both functions currently end with a "Recommended SKUs" section showing MGMT-1000 and optionally SERV-500. This task adds the growth buffer line before that section and adds the REPORTING-40 row after SERV-500 (when applicable).

**Important:** `totalTokens` is already growth-buffered from T01 (the useMemo applies `* (1 + growthBufferPct)`). So `Math.ceil(totalTokens / 1000)` in the export already produces the correct growth-buffered MGMT-1000 pack count — no change needed for that row. The REPORTING-40 pack count must apply the buffer separately: `Math.ceil(Math.ceil(reportingTokens * (1 + growthBufferPct)) / 40)`.

This task depends on T01's `growthBufferPct` and `reportingTokens` values.

## Steps

1. In `exportCSV()`, find the existing line (around line 1404):
   ```
   summary += `\n\nRecommended SKUs`;
   ```
   Before that line, add:
   ```ts
   summary += `\n\nGrowth Buffer,${Math.round(growthBufferPct * 100)}%`;
   ```

2. In `exportCSV()`, find the existing lines (around line 1406–1408):
   ```ts
   summary += `\nIB-TOKENS-UDDI-MGMT-1000,Management Token Pack (1000 tokens),${Math.ceil(totalTokens / 1000)}`;
   if (hasServerMetrics) {
     summary += `\nIB-TOKENS-UDDI-SERV-500,Server Token Pack (500 tokens),${Math.ceil(totalServerTokens / 500)}`;
   }
   ```
   After the SERV-500 block, add:
   ```ts
   if (reportingTokens > 0) {
     summary += `\nIB-TOKENS-REPORTING-40,Reporting Token Pack (40 tokens),${Math.ceil(Math.ceil(reportingTokens * (1 + growthBufferPct)) / 40)}`;
   }
   ```

3. In `exportExcel()`, find the HTML SKU table section (around line 1520–1528):
   ```html
   html += '<h3 style="margin-top:20px">Recommended SKUs</h3>';
   ```
   Before that line, add:
   ```ts
   html += `<p style="margin-top:16px"><b>Growth Buffer:</b> ${Math.round(growthBufferPct * 100)}%</p>`;
   ```

4. In `exportExcel()`, after the SERV-500 row (around line 1527), add:
   ```ts
   if (reportingTokens > 0) {
     html += `<tr><td>IB-TOKENS-REPORTING-40</td><td>Reporting Token Pack (40 tokens)</td><td style="text-align:center;font-weight:bold">${Math.ceil(Math.ceil(reportingTokens * (1 + growthBufferPct)) / 40).toLocaleString()}</td></tr>`;
   }
   ```

## Must-Haves

- [ ] `exportCSV()` includes "Growth Buffer,X%" line before "Recommended SKUs"
- [ ] `exportCSV()` includes IB-TOKENS-REPORTING-40 row when `reportingTokens > 0`
- [ ] `exportExcel()` includes "Growth Buffer: X%" `<p>` before the SKU table
- [ ] `exportExcel()` includes IB-TOKENS-REPORTING-40 `<tr>` when `reportingTokens > 0`
- [ ] Pack count for REPORTING-40 in both exports = `Math.ceil(Math.ceil(reportingTokens * (1 + growthBufferPct)) / 40)`
- [ ] All 22 existing tests still pass

## Verification

- `grep -c "Growth Buffer" frontend/src/app/components/wizard.tsx` returns ≥ 2
- `grep -c "REPORTING-40\|IB-TOKENS-REPORTING-40" frontend/src/app/components/wizard.tsx` returns ≥ 3 (BOM panel from T02 + both exports from this task)
- `cd frontend && npx vitest run` — all tests pass

## Inputs

- `frontend/src/app/components/wizard.tsx` — T01+T02's output; reads `growthBufferPct`, `reportingTokens`; modifies `exportCSV()` and `exportExcel()` functions

## Expected Output

- `frontend/src/app/components/wizard.tsx` — modified: `exportCSV()` and `exportExcel()` each include growth buffer metadata and REPORTING-40 SKU row
