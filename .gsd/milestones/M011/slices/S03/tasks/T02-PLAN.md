---
estimated_steps: 4
estimated_files: 1
skills_used:
  - frontend-design
  - make-interfaces-feel-better
---

# T02: Add BOM panel with copy-to-clipboard

**Slice:** S03 — BOM Panel, Reporting Tokens & Growth Buffer
**Milestone:** M011

## Description

Add a "Bill of Materials" panel to the results view that shows all applicable SKUs with growth-buffered pack counts and a copy-to-clipboard button (R016). This panel is the primary deliverable for SEs who need to paste SKUs into quotes or emails without opening the export file.

**Panel content:**
- IB-TOKENS-UDDI-MGMT-1000 — Management Token Pack (1000 tokens) — always shown; pack count = `Math.ceil(totalTokens / 1000)` (already growth-buffered from T01)
- IB-TOKENS-UDDI-SERV-500 — Server Token Pack (500 tokens) — shown only when `hasServerMetrics` is true; pack count = `Math.ceil(totalServerTokens / 500)` (server tokens have their own sizing, no additional growth buffer)
- IB-TOKENS-REPORTING-40 — Reporting Token Pack (40 tokens) — shown only when `reportingTokens > 0`; pack count = `Math.ceil(Math.ceil(reportingTokens * (1 + growthBufferPct)) / 40)`. Note: apply the growth buffer to reporting tokens separately (same buffer rate, different pack size).

**Copy BOM format (plain text, tab-separated for pasting into email/Excel):**
```
SKU Code	Description	Qty
IB-TOKENS-UDDI-MGMT-1000	Management Token Pack (1000 tokens)	N
IB-TOKENS-UDDI-SERV-500	Server Token Pack (500 tokens)	N
IB-TOKENS-REPORTING-40	Reporting Token Pack (40 tokens)	N
```
Omit rows where their condition is false.

**Panel placement:** Between `section-overview` and the sticky navigation bar (when present) / before `section-migration-planner`. Add a "BOM" link to the sticky nav bar.

This task depends on T01's `growthBufferPct`, `reportingTokens`, `totalTokens`, `totalServerTokens`, and `hasServerMetrics` values being available in wizard state.

## Steps

1. Add `const [bomCopied, setBomCopied] = useState(false)` near other UI state declarations. This drives the "Copied!" feedback.

2. Add a `copyBOM` function (near `exportCSV`):
   ```ts
   const copyBOM = () => {
     const mgmtPacks = Math.ceil(totalTokens / 1000);
     const srvPacks = hasServerMetrics ? Math.ceil(totalServerTokens / 500) : 0;
     const repPacks = reportingTokens > 0
       ? Math.ceil(Math.ceil(reportingTokens * (1 + growthBufferPct)) / 40)
       : 0;
     const lines = [
       'SKU Code\tDescription\tQty',
       `IB-TOKENS-UDDI-MGMT-1000\tManagement Token Pack (1000 tokens)\t${mgmtPacks}`,
       ...(srvPacks > 0 ? [`IB-TOKENS-UDDI-SERV-500\tServer Token Pack (500 tokens)\t${srvPacks}`] : []),
       ...(repPacks > 0 ? [`IB-TOKENS-REPORTING-40\tReporting Token Pack (40 tokens)\t${repPacks}`] : []),
     ];
     navigator.clipboard.writeText(lines.join('\n'));
     setBomCopied(true);
     setTimeout(() => setBomCopied(false), 2000);
   };
   ```

3. Add the BOM panel JSX immediately after the `section-overview` closing `</div>` tag (around line 3360 area), before the sticky nav bar:
   ```tsx
   <div id="section-bom" className="bg-white rounded-xl border border-[var(--border)] p-5 mb-6">
     <div className="flex items-center justify-between mb-4">
       <h3 className="text-[14px] font-semibold text-[var(--foreground)]">Bill of Materials</h3>
       <button
         type="button"
         onClick={copyBOM}
         className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] border border-[var(--border)] rounded-lg hover:bg-gray-50 transition-colors"
       >
         {bomCopied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
         {bomCopied ? 'Copied!' : 'Copy BOM'}
       </button>
     </div>
     <table className="w-full text-[13px]">
       <thead>
         <tr className="border-b border-[var(--border)]">
           <th className="text-left py-2 font-medium text-[var(--muted-foreground)]">SKU Code</th>
           <th className="text-left py-2 font-medium text-[var(--muted-foreground)]">Description</th>
           <th className="text-right py-2 font-medium text-[var(--muted-foreground)]">Pack Count</th>
         </tr>
       </thead>
       <tbody>
         <tr className="border-b border-[var(--border)]/50">
           <td className="py-2.5 font-mono text-[11px] text-orange-800 bg-orange-50 rounded px-1.5">IB-TOKENS-UDDI-MGMT-1000</td>
           <td className="py-2.5 pl-3">Management Token Pack (1000 tokens)</td>
           <td className="py-2.5 text-right font-semibold">{Math.ceil(totalTokens / 1000).toLocaleString()}</td>
         </tr>
         {hasServerMetrics && (
           <tr className="border-b border-[var(--border)]/50">
             <td className="py-2.5 font-mono text-[11px] text-blue-800 bg-blue-50 rounded px-1.5">IB-TOKENS-UDDI-SERV-500</td>
             <td className="py-2.5 pl-3">Server Token Pack (500 tokens)</td>
             <td className="py-2.5 text-right font-semibold">{Math.ceil(totalServerTokens / 500).toLocaleString()}</td>
           </tr>
         )}
         {reportingTokens > 0 && (
           <tr>
             <td className="py-2.5 font-mono text-[11px] text-purple-800 bg-purple-50 rounded px-1.5">IB-TOKENS-REPORTING-40</td>
             <td className="py-2.5 pl-3">Reporting Token Pack (40 tokens)</td>
             <td className="py-2.5 text-right font-semibold">
               {Math.ceil(Math.ceil(reportingTokens * (1 + growthBufferPct)) / 40).toLocaleString()}
             </td>
           </tr>
         )}
       </tbody>
     </table>
   </div>
   ```

4. Add `{ id: 'section-bom', label: 'BOM' }` to the sticky nav bar entries array (near line 3364). `Check` is already imported from `lucide-react` (line 16). `Copy` is NOT imported — add it to the import list at line 2 of wizard.tsx alongside the other lucide-react icons before using it in the BOM button.

## Must-Haves

- [ ] `bomCopied` state and `copyBOM` function
- [ ] BOM panel renders with id `section-bom` between overview and sticky nav
- [ ] MGMT-1000 row always shown with correct growth-buffered pack count
- [ ] SERV-500 row conditional on `hasServerMetrics`
- [ ] REPORTING-40 row conditional on `reportingTokens > 0` with growth-buffered reporting pack count
- [ ] Copy BOM button writes tab-separated text and shows "Copied!" feedback for 2 seconds
- [ ] "BOM" nav link in sticky navigation bar
- [ ] All 22 existing tests still pass

## Verification

- `grep -c "section-bom" frontend/src/app/components/wizard.tsx` returns ≥ 1
- `grep -c "copyBOM\|copy.*BOM\|bomCopied" frontend/src/app/components/wizard.tsx` returns ≥ 3
- `grep -c "REPORTING-40\|IB-TOKENS-REPORTING-40" frontend/src/app/components/wizard.tsx` returns ≥ 1
- `grep -c "clipboard" frontend/src/app/components/wizard.tsx` returns ≥ 1
- `cd frontend && npx vitest run` — all tests pass

## Inputs

- `frontend/src/app/components/wizard.tsx` — T01's output; reads `growthBufferPct`, `reportingTokens`, `totalTokens`, `totalServerTokens`, `hasServerMetrics`; inserts BOM panel after `section-overview`

## Expected Output

- `frontend/src/app/components/wizard.tsx` — modified: `bomCopied` state, `copyBOM` function, BOM panel JSX in results view, "BOM" sticky nav entry
