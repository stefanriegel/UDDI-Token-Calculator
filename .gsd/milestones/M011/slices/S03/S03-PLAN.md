# S03: BOM Panel, Reporting Tokens & Growth Buffer

**Goal:** Add the third SKU (Reporting Tokens, IB-TOKENS-REPORTING-40), a user-adjustable growth buffer (default 20%) that recalculates all pack counts live, a BOM panel with all three SKUs and copy-to-clipboard, and Reporting Token rows + growth buffer metadata in CSV/Excel exports — for both scan-based and estimator connectors.

**Demo:** An SE runs the estimator with DNS protocol logging enabled, lands on the results page, adjusts the growth buffer to 30%, watches all pack counts update live, sees the BOM panel with MGMT-1000, SERV-500, and REPORTING-40 rows, clicks "Copy BOM", pastes a clean SKU table into email, then downloads CSV and Excel exports that both include Reporting Token rows and a "Growth Buffer: 30%" metadata line.

## Must-Haves

- Reporting Token calculation: `monthlyLogVolume → reportingTokens` using three destination types (CSP: 10M/80tk, S3: 10M/40tk, Ecosystem: 10M/40tk); pack size 40 tokens (IB-TOKENS-REPORTING-40)
- Growth buffer state (`growthBufferPct`, default 0.20) that applies to management tokens and reporting tokens before pack rounding; SE can change it via a percentage input in the results view
- BOM panel showing MGMT-1000, SERV-500 (when applicable), and REPORTING-40 (when >0) with live pack counts that react to the buffer; Copy BOM button producing clean text ready to paste
- CSV and Excel exports include Reporting Token row in the SKU section and a "Growth Buffer: X%" metadata line
- All existing tests still pass (no regressions in the 22-test suite)

## Proof Level

- This slice proves: integration — growth buffer modifies `totalTokens` derived value → BOM pack counts → exports, all flowing through the same state
- Real runtime required: yes (browser UI must show live recalculation)
- Human/UAT required: yes (SE walkthrough per milestone DoD)

## Verification

- `cd frontend && npx vitest run` — all 22+ tests pass (no regressions)
- `grep -c "growthBufferPct" frontend/src/app/components/wizard.tsx` returns ≥ 3 (state, usage in totalTokens, usage in BOM)
- `grep -c "REPORTING-40\|IB-TOKENS-REPORTING-40" frontend/src/app/components/wizard.tsx` returns ≥ 3 (BOM panel, exportCSV, exportExcel)
- `grep -c "Growth Buffer" frontend/src/app/components/wizard.tsx` returns ≥ 2 (export CSV and Excel)
- `grep -c "calcReportingTokens" frontend/src/app/components/wizard.tsx` returns ≥ 2 (one call in reportingTokens useMemo, one in exports)

## Integration Closure

- Upstream surfaces consumed: `estimatorMonthlyLogVolume` state (set by S02's `startScan` short-circuit); `totalTokens` derived value; `totalServerTokens` derived value; `hasServerMetrics` flag; `exportCSV()` and `exportExcel()` functions
- New wiring introduced: `growthBufferPct` state → modified `totalTokens` useMemo (applies buffer before summing) → BOM panel pack counts → export SKU rows; `reportingTokens` derived value → BOM panel REPORTING-40 row → export Reporting Token row
- What remains: UAT SE walkthrough (per milestone DoD); nothing technical remains after this slice

## Tasks

- [ ] **T01: Add Reporting Token calculation and growth buffer state** `est:1h`
  - Why: Every downstream feature in S03 — BOM panel, exports, live recalculation — needs these two computed values. This task establishes the pure logic foundation before any UI is built.
  - Files: `frontend/src/app/components/wizard.tsx`
  - Do: (1) Add `growthBufferPct` useState (default 0.20) near the other state declarations; reset it in `restart()`. (2) Add a pure helper `calcReportingTokens(monthlyLogVolume, destinations)` near the existing `exportCSV` area — formula: `destinationTokens = Math.ceil(monthlyLogVolume / 10_000_000) * tokensPerDestination`, then `total = sum across destinations`, pack count = `Math.ceil(total / 40)`. Three destination types: CSP 30-day active search (80 tokens per 10M events), S3 bucket (40 per 10M), Ecosystem/CDC (40 per 10M). (3) Add `reportingTokens` useMemo that calls `calcReportingTokens(estimatorMonthlyLogVolume, selectedDestinations)` — for now hardcode all three destinations as selected (UI for destination selection is out of scope per R014 spec). (4) Modify `totalTokens` useMemo to apply the growth buffer: `Math.ceil(rawTotal * (1 + growthBufferPct))` — this single change propagates the buffer to all pack counts derived from `totalTokens`. (5) Add a `growthBufferInput` percentage input control in the results view near the overview section header.
  - Verify: `cd frontend && npx vitest run` returns 22/22; `grep -c "growthBufferPct" frontend/src/app/components/wizard.tsx` ≥ 3
  - Done when: `growthBufferPct` state exists, `calcReportingTokens` function exists, `reportingTokens` useMemo produces correct pack count for Reference Case A log volume, growth buffer input renders in results view and changing it immediately updates `totalTokens`

- [ ] **T02: Add BOM panel with copy-to-clipboard** `est:1h`
  - Why: R016 requires a visual BOM panel in the results view with all applicable SKUs and a copy button. This is the primary user-facing deliverable SEs use to copy SKUs into quotes.
  - Files: `frontend/src/app/components/wizard.tsx`
  - Do: Add a new `<div id="section-bom">` panel between `section-overview` and `section-migration-planner` (or `section-findings` when no migration data). The panel must: show MGMT-1000 row always (pack count = `Math.ceil(totalTokens / 1000)` — already includes growth buffer from T01); show SERV-500 row when `hasServerMetrics` (pack count = `Math.ceil(totalServerTokens / 500)` — note: server tokens do NOT get the management growth buffer); show REPORTING-40 row when `reportingTokens > 0` (pack count = `Math.ceil(reportingTokens / 40)` after applying the same growth buffer to raw reporting tokens). Add a "Copy BOM" button that calls `navigator.clipboard.writeText()` with a plain-text table like: `SKU Code | Description | Pack Count\nIB-TOKENS-UDDI-MGMT-1000 | Management Token Pack | N\n...`. Show a brief "Copied!" confirmation state for 2 seconds. Add "BOM" navigation entry to the sticky nav bar when it's rendered.
  - Verify: `grep -c "section-bom" frontend/src/app/components/wizard.tsx` ≥ 1; `grep -c "REPORTING-40\|IB-TOKENS-REPORTING-40" frontend/src/app/components/wizard.tsx` ≥ 1; `grep -c "clipboard" frontend/src/app/components/wizard.tsx` ≥ 1; `cd frontend && npx vitest run` still passes
  - Done when: BOM panel renders in results view with all three SKU rows (when applicable), pack counts update when growth buffer input changes, Copy BOM produces clean clipboard text

- [ ] **T03: Enhance CSV and Excel exports with Reporting Tokens and growth buffer** `est:45m`
  - Why: R017 requires exports to include Reporting Token rows and reflect the growth buffer. Exports are the deliverable SEs attach to opportunities — incomplete exports undermine the tool's value.
  - Files: `frontend/src/app/components/wizard.tsx`
  - Do: In `exportCSV()`: (1) add a `Growth Buffer: X%` line immediately before the "Recommended SKUs" section; (2) update MGMT-1000 pack count to use `Math.ceil(totalTokens / 1000)` — already includes buffer from T01 since totalTokens is the buffered value; (3) add IB-TOKENS-REPORTING-40 row after SERV-500 when `reportingTokens > 0`. In `exportExcel()`: apply the same three changes in the HTML SKU table section. The "Growth Buffer" line in CSV format: `\n\nGrowth Buffer,${Math.round(growthBufferPct * 100)}%`. In Excel: add `<p>Growth Buffer: ${Math.round(growthBufferPct * 100)}%</p>` before the SKU table. The pack count row for REPORTING-40: `\nIB-TOKENS-REPORTING-40,Reporting Token Pack (40 tokens),${Math.ceil(reportingTokens / 40)}`.
  - Verify: `grep -c "Growth Buffer" frontend/src/app/components/wizard.tsx` ≥ 2; `grep -c "REPORTING-40\|IB-TOKENS-REPORTING-40" frontend/src/app/components/wizard.tsx` ≥ 3; `cd frontend && npx vitest run` still passes
  - Done when: CSV export includes Growth Buffer metadata line and REPORTING-40 SKU row; Excel export includes the same; both correctly reflect the current buffer percentage

## Files Likely Touched

- `frontend/src/app/components/wizard.tsx` (all three tasks — single source of truth for state, UI, and exports)
- `frontend/src/app/components/mock-data.ts` (if Reporting Token types or constants need to be added there)
