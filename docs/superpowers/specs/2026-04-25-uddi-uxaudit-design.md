# UDDI Token Calculator — UI/UX Audit Design

**Date:** 2026-04-25
**Status:** Locked, ready for plan
**Scope:** Sub-project A of a larger 3-part initiative ("full Playwright UI/UX audit + numerical reconciliation + GitLab issue automation"). This spec covers **only** the UI/UX audit. Sub-projects B (cross-source numerical reconciliation) and C (GitLab issue pipeline) are deferred.

## Goal

Run a one-shot Playwright audit against the UDDI Token Calculator that captures functional, visual, and accessibility evidence across every supported wizard path, then produce a single severity-classified Markdown report with embedded screenshots so the user (Stefan) can triage the findings into v3.4 phases.

## Non-Goals

- Building a maintained Playwright suite committed to the repo. The audit is throwaway — generated, run, and discarded.
- Cross-view numerical reconciliation between Sizer / Scan / Excel. Deferred to sub-project B.
- Auto-creating GitLab issues. Deferred to sub-project C.
- Visual regression baselines. One-shot run has no baseline to diff against — screenshots are evidence for human review.
- Mobile / tablet support. App is desktop-only by design.
- Real-credential validation paths. Audit runs in backend-demo mode (auto-validates with mock data).
- CI integration. The audit is a manual local run.

## Locked Decisions

| ID | Decision |
|---|---|
| D-01 | Audit type: functional smoke + visual screenshots + axe-core a11y, layered. |
| D-02 | Coverage: all 7 Scan-wizard providers (AWS, Azure, GCP, Microsoft DHCP/AD, NIOS, BlueCat, EfficientIP) + Manual Estimator + Sizer wizard deep walk. |
| D-03 | Viewports: 1600×1000 + 1280×800. No mobile, no tablet. |
| D-04 | Upload-path fixtures: Schneider local data symlinked from `/Users/mustermann/Documents/coding/Infoblox-Universal-DDI-cloud-usage/...` per project memory. Skip upload paths gracefully if path missing. No fixtures committed. |
| D-05 | Output: single Markdown report at `/tmp/uddi-uxaudit/<timestamp>/report.md`, severity-grouped, with embedded screenshot links. |
| D-06 | Lifecycle: one-shot. Script lives at `/tmp/uddi-uxaudit.js` per the playwright-skill convention; never committed to project tree. |
| D-07 | Severity rubric: 4 tiers — Blocker / High / Medium / Low. See §Severity Heuristics. |
| D-08 | Implementation shape: single mega-script (one file, one run, one report). No per-provider files, no Playwright projects config. |
| D-09 | Backend mode: demo (Go backend stopped). The audit explicitly tests demo mode behavior; real-creds paths are out of scope. |
| D-10 | A11y rulesets: `wcag2aa` + `wcag21aa`. Axe `critical/serious` → High; `moderate` → Medium; `minor` → Low. |

## Architecture

**Entry point:** `/tmp/uddi-uxaudit.js` — single Node script driven by `node ~/.claude/skills/playwright-skill/run.js /tmp/uddi-uxaudit.js`.

**Dependencies:**
- `playwright` — already installed at `~/.claude/skills/playwright-skill/node_modules`.
- `@axe-core/playwright` — installed on first run via `npm i --prefix ~/.claude/skills/playwright-skill @axe-core/playwright` if missing.
- Node stdlib `fs` / `path` for report and screenshot writing.

**Output tree** (all under `/tmp/uddi-uxaudit/<ISO-timestamp>/`):
```
report.md                              ← human-facing severity-grouped report
screenshots/{wizard}-{provider}/{NN}-{state}-{viewport}.png
axe/{state}-{viewport}.json            ← raw axe-core output per page-state
traces/{failure-id}.zip                ← Playwright trace, only on functional failures
```

Filename convention is sortable + greppable; `{NN}` is a 2-digit step index.

**Pre-flight checks** at script start (fail fast if any miss):
1. Vite dev server reachable at `http://localhost:5173` (one HTTP `HEAD`).
2. Backend status — auto-detected. Audit logs which mode (`demo` vs `live`); demo is the assumed mode per D-09.
3. Schneider data path exists. If missing, mark NIOS / BlueCat / EfficientIP upload sub-tests as `skipped` in the coverage matrix and continue with the rest.

## Coverage Matrix

~90 page-states captured: 7 Scan providers × 5 steps × 2 viewports = 70; Estimator (3 states × 2) = 6; Sizer (5 steps × 2 + 2 Step-3 sub-tabs × 2) = 14. Plus 6 special interaction sub-tests (not viewport-multiplied — see below).

| Wizard | Providers | Steps | Viewports |
|---|---|---|---|
| Scan | AWS, Azure, GCP, Microsoft DHCP/AD, NIOS, BlueCat, EfficientIP (7) | 1 Providers · 2 Credentials · 3 Sources · 4 Scan · 5 Results & Export | 1600×1000, 1280×800 |
| Manual Estimator | Estimator (1) | 1 Provider-pick · Estimator inputs · 5 Results | both |
| Sizer (deep) | Sizer wizard | 1 Regions · 2 Sites (users + manual modes) · 3 Infrastructure (NIOS-X + XaaS tabs) · 4 Settings · 5 Results | both |

**Per-state checks:**
- Functional — page renders, no `pageerror`, no `console.error` (with allowlist for known-acceptable cases like the demo-mode 502 health check).
- Visual — `page.screenshot({ fullPage: true })`, embedded in report.
- A11y — `AxeBuilder({ page }).withTags(['wcag2aa', 'wcag21aa']).analyze()`, dedupe by `(rule, html-snippet-hash)`.

**Special interaction sub-tests** (not viewport-multiplied):
- **S-01** Sizer Step 3 NIOS-X tier auto-derive — assign site, verify recommended tier picked (regression for `f85d995`).
- **S-02** Step 5 export buttons — XLSX downloads valid Excel (Microsoft Excel 2007+ magic bytes, ≥1 sheet); `.excalidraw` downloads valid JSON v2; copy-button writes to clipboard without throwing.
- **S-03** Drag-override persistence — drag Excalidraw element, navigate away+back via stepper, verify position survives via sessionStorage inspection.
- **S-04** D-18 import badge — Phase 32 import flow: button click → AlertDialog → confirm → badge renders with correct counts → auto-clears at 4s → does not replay on reload.
- **S-05** Auto-tier hint button — manual XL pick → `↺ {recommended}` appears → click reverts to auto + clears `tierManual`.
- **S-06** NIOS migration planner totals match Excel export totals — single cross-check to surface the known *Token mismatch Findings vs Overview* memory note. Records the discrepancy as a finding rather than fixing it.

## Walk Recipes

**Generic Scan-provider walk (demo mode):**
1. `goto /`, screenshot `01-providers`.
2. Click provider tile, click Next, screenshot `02-credentials`.
3. Click `Validate & Connect`, wait 1500ms (matches the demo `setTimeout(1200ms)` + buffer), screenshot `02-validated`.
4. Next → screenshot `03-sources`.
5. Default selection → Next → wait for `Scan Complete` text → screenshot `04-scan-complete`.
6. Click `View Results` → screenshot `05-results`.
7. Click `Export Excel` → capture download → validate file (magic bytes + sheet count).
8. Run axe scan after each screenshot.

**Upload-path providers** (NIOS / EfficientIP / BlueCat): identical to above, but at step 2 use `setInputFiles()` to upload the Schneider fixture, wait for upload-success state. If Schneider path missing, sub-test marked `skipped` (not failed).

**Sizer deep walk:**
1. Provider-pick `Manual Sizing Estimator` → Next → SizerWizard mounts.
2. Step 1: add region, add country, add city, add 2 sites under that city.
3. Step 2: select first site, set users=8000 (medium load); switch to manual mode, set qps/lps/objects directly; assert live preview updates.
4. Step 3 — NIOS-X tab: add system, assign site (verify auto-tier per S-01), manually override tier (verify hint per S-05), revert via hint click.
5. Step 3 — XaaS tab: add card, change connectivity to TGW (verify F-02 select renders), change PoP location (verify F-02 select renders).
6. Step 4: toggle each setting, assert no crash and no NaN in derived totals.
7. Step 5: assert hero cards + breakdown table render; click each export button (S-02); toggle Excalidraw edit mode + drag (S-03).

**Phase 32 import-bridge walk** (combo Scan-AWS + Sizer): start scan as AWS, reach Step 5, click `Use as Sizer Input`, confirm dialog, assert badge per S-04.

## Visual Capture

- Strategy: `page.screenshot({ fullPage: true })` after every meaningful state change.
- Naming: `screenshots/{wizard}-{provider}/{NN}-{state}-{viewport}.png` — sortable, greppable.
- No baseline diff (one-shot per D-06). Screenshots are evidence for human review embedded in the report via relative `![](screenshots/...)` paths.

## A11y Integration

```js
const { AxeBuilder } = require('@axe-core/playwright');
const results = await new AxeBuilder({ page })
  .withTags(['wcag2aa', 'wcag21aa'])
  .analyze();
```

- Save raw JSON per page-state to `axe/{state}-{viewport}.json`.
- Aggregate violations: dedupe by `(rule, html-snippet-hash)` so the same offending button across N pages produces one finding, not N.
- Severity mapping per D-10.

## Functional Failure Capture

- `page.on('pageerror')` and `page.on('console', m => m.type() === 'error')` push to a per-page-state error log.
- Allowlist: `502 Bad Gateway` from `/api/v1/health` is expected in demo mode (backend not running). Suppress.
- Allowlist: the React `Cannot read properties of undefined` warning from the deliberate `expect(...).toThrow(/SizerProvider/)` test path — N/A in audit since we don't trigger that, but documented for clarity.
- Any unsuppressed `pageerror` → Blocker.
- React warnings from console (e.g. forwardRef misses) → High.
- Other unexpected `console.error` → Medium.

## Severity Heuristics

| Tier | Examples |
|---|---|
| **Blocker** | Page crashes, button doesn't fire its handler, scan returns no findings, export download fails or produces an invalid file, NaN in calc output, navigation breaks, demo-mode validation never resolves. |
| **High** | Wrong number, label, or copy; axe `critical` or `serious`; missing alt text on functional images; focus traps; contrast < 3:1; broken keyboard nav; dialog cannot be dismissed; React `forwardRef` warnings (regression). |
| **Medium** | axe `moderate`; layout overflow at 1280px width; visible jitter on hover; slow render (>2s); console warnings (React keys, prop type); copy nits affecting comprehension. |
| **Low** | axe `minor`; minor color/spacing inconsistencies; redundant testids; copy could be clearer but is correct. |

## Report Template

`report.md`:

```markdown
# UDDI Token Calculator — UI/UX Audit
**Run:** 2026-04-25T11:30:00Z
**Backend mode:** demo
**Coverage:** 7 Scan providers + Estimator + Sizer × 2 viewports + 6 special checks
**Total page-states captured:** ~90

## Summary
- 🔴 Blockers: N
- 🟠 High:    N
- 🟡 Medium:  N
- 🔵 Low:     N
- 📸 Screenshots captured: N
- ♿ axe runs: N (X total violations, Y deduped)

## Blockers
### B-01 — {short title}
**Where:** Sizer Step 3 / 1600×1000
**Type:** Functional | Visual | A11y
**Evidence:** ![](screenshots/sizer/03-infra-1600.png)
**Repro:** 1. … 2. … 3. …
**Recommendation:** …

## High / Medium / Low — same shape

## Coverage matrix
| Wizard | Provider | Step | 1600 | 1280 | Notes |
| Scan | AWS | 1 Providers | ✓ | ✓ | clean |
| ... |
```

## Pre-flight Knowns

- **Time estimate:** ~30 min for the script run itself; Markdown generation is in-script.
- **Token cost:** ~30k for the run + my read-through of the report.
- **Known limitation:** Demo mode masks real-creds bugs (e.g. a real Azure SSO redirect failure). Not in scope; covered by manual UAT.
- **Known limitation:** Demo-mode `Validate & Connect` for some providers (Microsoft DHCP/AD) needs at least one Domain Controller filled before Next enables. The walk handles this with a stub fill where required.
- **Carryover from earlier work:** AlertDialogOverlay fix `ff4cd0a` should silence the React forwardRef warning that surfaced in Phase 32 UAT. This audit will catch any leftover ref-forwarding warnings on other Radix primitives.

## Acceptance Criteria

1. Script runs to completion in demo mode (Vite up, Go backend down) and produces `/tmp/uddi-uxaudit/<timestamp>/report.md`.
2. Report contains at least one entry per severity tier section (sections may be empty if no findings — explicitly state "(none)").
3. Every page-state in the coverage matrix has a screenshot (or is explicitly marked `skipped` with a reason).
4. All 6 special interaction sub-tests run, each with pass/fail/skipped status.
5. Coverage matrix at the bottom of the report shows ✓/✗/skipped per (wizard × provider × step × viewport) cell.
6. Schneider-fixture-dependent tests are skipped (not failed) when the local path is missing.

## Out-of-Scope (explicit deferrals)

- Sub-project B (cross-source numerical reconciliation) — separate spec.
- Sub-project C (GitLab issue automation) — separate spec.
- Maintained suite + CI — see D-06.
- Mobile / tablet — see D-03.
- Real-credential paths — see D-09.
- Visual regression baselines — see D-06.
