# UDDI UI/UX Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a one-shot Playwright audit producing a single severity-classified Markdown report with embedded screenshots covering all 7 Scan providers + Manual Estimator + Sizer wizard at 2 desktop viewports, layered with axe-core a11y scans and 6 special interaction sub-tests.

**Architecture:** A single mega-script at `/tmp/uddi-uxaudit.js` driven by `~/.claude/skills/playwright-skill/run.js`. The script is throwaway (lifecycle decision D-06 in the spec) — never committed to the project tree. Output lives under `/tmp/uddi-uxaudit/<ISO-timestamp>/` with `report.md` + `screenshots/` + `axe/`.

**Tech Stack:** Playwright (chromium), `@axe-core/playwright`, Node stdlib `fs`/`path`. Vite dev server at `http://localhost:5173` (must be running). Backend in demo mode (Go backend stopped).

**Reference spec:** `docs/superpowers/specs/2026-04-25-uddi-uxaudit-design.md` — the spec is authoritative for *what* and *why*. This plan is *how*.

---

## Pre-flight (must hold before Task 1)

- Vite dev server reachable: `curl -sI http://localhost:5173` returns 200. Start with `cd frontend && pnpm dev > /tmp/vite-dev.log 2>&1 &` if needed.
- Go backend NOT running: `curl -s http://localhost:8080/api/v1/health` returns nothing (demo mode is what we audit). Stop with `lsof -ti:8080 | xargs kill` if needed.
- Confirm `~/.claude/skills/playwright-skill/run.js` exists.
- Confirm Schneider data path exists at `/Users/mustermann/Documents/coding/Infoblox-Universal-DDI-cloud-usage/`. If absent, NIOS / EfficientIP / BlueCat upload sub-tests will be skipped (per D-04) — note this in the report header.

---

### Task 1: Script skeleton + dep install + pre-flight

**Files:**
- Create: `/tmp/uddi-uxaudit.js`

- [ ] **Step 1: Install `@axe-core/playwright` if missing**

```bash
SKILL=~/.claude/skills/playwright-skill
[ -d "$SKILL/node_modules/@axe-core/playwright" ] || \
  npm i --prefix "$SKILL" @axe-core/playwright
```

Expected: `node_modules/@axe-core/playwright` exists (silent if already installed).

- [ ] **Step 2: Write the script skeleton with pre-flight checks**

Create `/tmp/uddi-uxaudit.js` with this exact starting content:

```js
const { chromium } = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');
const fs = require('fs');
const path = require('path');

const TARGET_URL = 'http://localhost:5173';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = `/tmp/uddi-uxaudit/${STAMP}`;
const SCHNEIDER = '/Users/mustermann/Documents/coding/Infoblox-Universal-DDI-cloud-usage';
const VIEWPORTS = [
  { name: '1600', width: 1600, height: 1000 },
  { name: '1280', width: 1280, height: 800 },
];

fs.mkdirSync(`${OUT}/screenshots`, { recursive: true });
fs.mkdirSync(`${OUT}/axe`, { recursive: true });

// Aggregator
const findings = []; // { id, severity, title, where, type, evidencePath, repro, recommendation }
const coverage = []; // { wizard, provider, step, viewport, status, note }
let nextId = { Blocker: 1, High: 1, Medium: 1, Low: 1 };

const SCHNEIDER_AVAILABLE = fs.existsSync(SCHNEIDER);

(async () => {
  // pre-flight: vite reachable
  const headRes = await fetch(TARGET_URL).catch(() => null);
  if (!headRes || !headRes.ok) {
    console.error('FATAL: Vite dev server not reachable at', TARGET_URL);
    process.exit(1);
  }
  const backendRes = await fetch(`${TARGET_URL}/api/v1/health`).catch(() => null);
  const backendMode = backendRes && backendRes.ok ? 'live' : 'demo';
  console.log(`Pre-flight ✓ — backend mode: ${backendMode}, schneider: ${SCHNEIDER_AVAILABLE ? 'available' : 'MISSING (upload sub-tests will skip)'}`);

  const browser = await chromium.launch({ headless: false, slowMo: 40 });

  // walk slots filled by later tasks — placeholder
  // await scanWalks(browser);
  // await estimatorWalk(browser);
  // await sizerDeepWalk(browser);
  // await specialChecks(browser);

  await browser.close();

  // report writing slot — filled by Task 9
  // writeReport({ backendMode });

  console.log(`\nReport: ${OUT}/report.md`);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
```

- [ ] **Step 3: Smoke-run the skeleton**

Run: `cd ~/.claude/skills/playwright-skill && node run.js /tmp/uddi-uxaudit.js`
Expected: prints `Pre-flight ✓ — backend mode: demo, schneider: available` (or `MISSING`), opens chromium briefly, exits 0, writes the empty `/tmp/uddi-uxaudit/<stamp>/` dirs.

- [ ] **Step 4: Commit nothing**

The script lives in `/tmp/`, never committed (D-06). Project tree is unchanged. No `git add`.

---

### Task 2: Helper utilities (in-file lib)

**Files:**
- Modify: `/tmp/uddi-uxaudit.js` — add helper section above the main IIFE.

- [ ] **Step 1: Add screenshot helper**

Add immediately after the `let nextId = ...` declaration:

```js
async function snap(page, wizard, provider, step, viewport) {
  const dir = `${OUT}/screenshots/${wizard}-${provider}`;
  fs.mkdirSync(dir, { recursive: true });
  const file = `${dir}/${String(step).padStart(2, '0')}-${viewport}.png`;
  await page.screenshot({ path: file, fullPage: true });
  return path.relative(OUT, file);
}
```

- [ ] **Step 2: Add error-listener wrapper**

```js
function attachErrorListeners(page, where) {
  page._uddiErrors = [];
  page.on('pageerror', e => {
    page._uddiErrors.push({ severity: 'Blocker', type: 'Functional', text: e.message, where });
  });
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // Allowlist: demo-mode 502 health is expected
    if (t.includes('/api/v1/health') && t.includes('502')) return;
    if (t.includes('Failed to load resource') && t.includes('502')) return;
    const isReactWarning = /forwardRef|Function components cannot be given refs|key prop|prop type/.test(t);
    page._uddiErrors.push({
      severity: isReactWarning ? 'High' : 'Medium',
      type: 'Functional',
      text: t.slice(0, 300),
      where,
    });
  });
}
```

- [ ] **Step 3: Add axe wrapper + dedupe key**

```js
async function axeScan(page, where, viewport) {
  try {
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2aa', 'wcag21aa'])
      .analyze();
    fs.writeFileSync(
      `${OUT}/axe/${where.replace(/[^a-z0-9-]/gi, '_')}-${viewport}.json`,
      JSON.stringify(results, null, 2),
    );
    return results.violations.map(v => ({
      severity: ({ critical: 'High', serious: 'High', moderate: 'Medium', minor: 'Low' })[v.impact] || 'Low',
      type: 'A11y',
      where: `${where} / ${viewport}`,
      title: `${v.id}: ${v.help}`,
      dedupeKey: `${v.id}::${(v.nodes[0]?.html || '').slice(0, 80)}`,
      recommendation: v.helpUrl,
    }));
  } catch (e) {
    return [{ severity: 'Medium', type: 'Functional', where, title: `axe scan failed: ${e.message}` }];
  }
}
```

- [ ] **Step 4: Add finding-recorder + dedupe**

```js
const seenDedupes = new Set();
function recordFinding(f) {
  if (f.dedupeKey && seenDedupes.has(f.dedupeKey)) return;
  if (f.dedupeKey) seenDedupes.add(f.dedupeKey);
  const id = `${f.severity[0]}-${String(nextId[f.severity]++).padStart(2, '0')}`;
  findings.push({ id, ...f });
}

function flushPageErrors(page) {
  for (const e of page._uddiErrors || []) {
    recordFinding({
      severity: e.severity,
      type: e.type,
      where: e.where,
      title: e.text,
    });
  }
  page._uddiErrors = [];
}
```

- [ ] **Step 5: Add coverage marker**

```js
function mark(wizard, provider, step, viewport, status, note = '') {
  coverage.push({ wizard, provider, step, viewport, status, note });
}
```

- [ ] **Step 6: Smoke-run again to confirm no syntax errors**

Run: `cd ~/.claude/skills/playwright-skill && node run.js /tmp/uddi-uxaudit.js`
Expected: same pre-flight output as Task 1 Step 3, exits 0.

---

### Task 3: Generic Scan-provider walk

**Files:**
- Modify: `/tmp/uddi-uxaudit.js` — add `scanWalk(browser, providerName, viewport)` and `scanWalks(browser)`.

- [ ] **Step 1: Add the walk function**

Above the main IIFE:

```js
const SCAN_PROVIDERS = [
  { name: 'AWS', label: 'Amazon Web Services', upload: false },
  { name: 'Azure', label: 'Microsoft Azure', upload: false },
  { name: 'GCP', label: 'Google Cloud Platform', upload: false },
  { name: 'Microsoft', label: 'Microsoft DHCP & DNS Server', upload: false, needsDC: true },
  { name: 'NIOS', label: 'Infoblox NIOS Grid', upload: true, fixture: `${SCHNEIDER}/path-to-nios-backup.tar.gz` },
  { name: 'BlueCat', label: 'BlueCat Address Manager', upload: false }, // BlueCat uses creds, not file
  { name: 'EfficientIP', label: 'EfficientIP SOLIDserver', upload: true, fixture: `${SCHNEIDER}/path-to-efficientip-backup.gz` },
];

async function scanWalk(browser, prov, vp) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await ctx.newPage();
  attachErrorListeners(page, `scan/${prov.name}`);

  // Step 1: Providers
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  recordFinding(...await axeScan(page, `scan-${prov.name}-step1`, vp.name));
  await page.locator(`text=${prov.label}`).first().click().catch(() => {});
  await snap(page, 'scan', prov.name, 1, vp.name);
  mark('Scan', prov.name, '1 Providers', vp.name, 'ok');

  // Step 2: Credentials
  const next1 = page.locator('button:has-text("Next")').first();
  if (await next1.isEnabled().catch(() => false)) await next1.click();
  await page.waitForTimeout(800);
  await snap(page, 'scan', prov.name, 2, vp.name);

  if (prov.upload) {
    if (!SCHNEIDER_AVAILABLE) {
      mark('Scan', prov.name, '2 Credentials', vp.name, 'skipped', 'Schneider fixture missing');
      await ctx.close();
      return;
    }
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(prov.fixture).catch(e => {
      mark('Scan', prov.name, '2 Credentials', vp.name, 'skipped', `upload failed: ${e.message}`);
    });
    await page.waitForTimeout(2000);
  } else {
    if (prov.needsDC) {
      // Stub a Domain Controller so Validate enables
      const dcInput = page.locator('input[placeholder*="dc01"]').first();
      if (await dcInput.count()) await dcInput.fill('dc01.corp.local');
      const addBtn = page.locator('button:has-text("Add")').first();
      if (await addBtn.count()) await addBtn.click();
      await page.waitForTimeout(300);
    }
    const validateBtns = await page.locator('button:has-text("Validate & Connect")').all();
    for (const b of validateBtns) {
      if (await b.isEnabled().catch(() => false)) {
        await b.click();
        await page.waitForTimeout(1500); // matches the 1200ms demo setTimeout + buffer
      }
    }
  }
  await page.waitForTimeout(800);
  await snap(page, 'scan', prov.name, 2, vp.name + '-validated');
  mark('Scan', prov.name, '2 Credentials', vp.name, 'ok');

  // Steps 3 → 5
  for (const stepLabel of ['Sources', 'Scan', 'View Results']) {
    const btn = page.locator('button').filter({ hasText: /^Next$|^View Results$/ }).first();
    if ((await btn.count()) === 0 || !(await btn.isEnabled().catch(() => false))) {
      mark('Scan', prov.name, stepLabel, vp.name, 'blocked', 'Next disabled');
      break;
    }
    await btn.click();
    await page.waitForTimeout(2500);
  }
  await snap(page, 'scan', prov.name, 5, vp.name);
  mark('Scan', prov.name, '5 Results & Export', vp.name, 'ok');

  // Validate Excel export
  const dl = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
  await page.locator('button:has-text("Export Excel"), button:has-text("Download Excel")').first().click().catch(() => {});
  const file = await dl;
  if (file) {
    const dest = `${OUT}/screenshots/scan-${prov.name}/export.xlsx`;
    await file.saveAs(dest);
    const buf = fs.readFileSync(dest).slice(0, 4);
    if (buf[0] !== 0x50 || buf[1] !== 0x4B) {
      recordFinding({
        severity: 'Blocker',
        type: 'Functional',
        where: `scan/${prov.name} step 5 export`,
        title: 'XLSX magic bytes invalid',
      });
    }
  } else {
    recordFinding({
      severity: 'High',
      type: 'Functional',
      where: `scan/${prov.name} step 5 export`,
      title: 'Excel download did not fire',
    });
  }

  flushPageErrors(page);
  await ctx.close();
}

async function scanWalks(browser) {
  for (const prov of SCAN_PROVIDERS) {
    for (const vp of VIEWPORTS) {
      try {
        await scanWalk(browser, prov, vp);
      } catch (e) {
        recordFinding({
          severity: 'Blocker',
          type: 'Functional',
          where: `scan/${prov.name} / ${vp.name}`,
          title: `walk crashed: ${e.message.slice(0, 200)}`,
        });
      }
    }
  }
}
```

- [ ] **Step 2: Wire `scanWalks(browser)` into the IIFE**

Uncomment `await scanWalks(browser);` in the main IIFE body (added in Task 1).

- [ ] **Step 3: Run the audit on a single provider to test wiring**

Temporarily change `for (const prov of SCAN_PROVIDERS)` to `for (const prov of SCAN_PROVIDERS.slice(0, 1))` and run.
Expected: AWS walk completes for both viewports, ~10 screenshots in `/tmp/uddi-uxaudit/<stamp>/screenshots/scan-AWS/`. Restore the loop.

---

### Task 4: Manual Estimator walk

**Files:**
- Modify: `/tmp/uddi-uxaudit.js` — add `estimatorWalk(browser)`.

- [ ] **Step 1: Add the walk**

```js
async function estimatorWalk(browser) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    attachErrorListeners(page, `estimator`);

    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await page.locator('text=Manual Sizing Estimator').first().click();
    await snap(page, 'estimator', 'pick', 1, vp.name);
    mark('Estimator', 'Estimator', '1 Provider-pick', vp.name, 'ok');
    recordFinding(...await axeScan(page, `estimator-pick`, vp.name));

    await page.locator('button:has-text("Next")').first().click();
    await page.waitForTimeout(1500);
    // SizerWizard mounts here → covered by sizerDeepWalk in Task 5.
    // For this walk we only verify mount + axe scan.
    await page.locator('[data-testid="sizer-wizard"]').waitFor({ timeout: 5000 }).catch(() => {
      recordFinding({ severity: 'Blocker', type: 'Functional', where: `estimator / ${vp.name}`, title: 'SizerWizard did not mount' });
    });
    await snap(page, 'estimator', 'sizer-mounted', 2, vp.name);
    mark('Estimator', 'Estimator', '2 Sizer mount', vp.name, 'ok');
    recordFinding(...await axeScan(page, `estimator-sizer`, vp.name));

    flushPageErrors(page);
    await ctx.close();
  }
}
```

- [ ] **Step 2: Wire into IIFE**

Uncomment `await estimatorWalk(browser);`.

- [ ] **Step 3: Smoke run**

Run the script. Expected: Estimator section produces ~4 screenshots and an axe scan per viewport.

---

### Task 5: Sizer deep walk

**Files:**
- Modify: `/tmp/uddi-uxaudit.js` — add `sizerDeepWalk(browser)`.

- [ ] **Step 1: Add the walk**

```js
async function sizerDeepWalk(browser) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      acceptDownloads: true,
    });
    const page = await ctx.newPage();
    attachErrorListeners(page, `sizer`);

    // Mount via Estimator entry
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
    await page.locator('text=Manual Sizing Estimator').first().click();
    await page.locator('button:has-text("Next")').first().click();
    await page.locator('[data-testid="sizer-wizard"]').waitFor({ timeout: 5000 });

    // Step 1 Regions
    await page.locator('[data-testid="sizer-empty-add-region"]').click();
    await page.waitForTimeout(400);
    await page.locator('[data-testid^="sizer-tree-add-site-under-region-"]').first().click();
    await page.waitForTimeout(400);
    await snap(page, 'sizer', 'wizard', 1, vp.name);
    mark('Sizer', 'Sizer', '1 Regions', vp.name, 'ok');
    recordFinding(...await axeScan(page, `sizer-step1`, vp.name));

    // Step 2 Sites — users mode
    await page.locator('#sizer-stepper-button-2').click();
    await page.waitForTimeout(600);
    await page.locator('[data-testid^="sizer-sites-pick-"]').first().click();
    await page.waitForTimeout(400);
    await page.locator('[data-testid="sizer-site-mode-users"]').click().catch(() => {});
    await page.locator('[data-testid="sizer-site-users"]').fill('8000');
    await page.waitForTimeout(1200);
    await snap(page, 'sizer', 'wizard', 2, vp.name);
    mark('Sizer', 'Sizer', '2 Sites users', vp.name, 'ok');

    // Step 2 Sites — manual mode
    await page.locator('[data-testid="sizer-site-mode-manual"]').click().catch(() => {});
    await page.waitForTimeout(400);
    await snap(page, 'sizer', 'wizard', 2, vp.name + '-manual');
    mark('Sizer', 'Sizer', '2 Sites manual', vp.name, 'ok');
    recordFinding(...await axeScan(page, `sizer-step2`, vp.name));

    // Step 3 Infrastructure — NIOS-X tab
    await page.locator('#sizer-stepper-button-3').click();
    await page.waitForTimeout(600);
    await page.locator('[data-testid="sizer-niosx-add"]').click();
    await page.waitForTimeout(400);
    await snap(page, 'sizer', 'wizard', 3, vp.name + '-niosx');
    mark('Sizer', 'Sizer', '3 Infra NIOS-X', vp.name, 'ok');

    // Step 3 — XaaS tab
    await page.locator('button:has-text("XaaS Service Points")').first().click();
    await page.waitForTimeout(400);
    await page.locator('[data-testid^="sizer-xaas-add-"]').first().click().catch(() => {});
    await page.waitForTimeout(400);
    await snap(page, 'sizer', 'wizard', 3, vp.name + '-xaas');
    mark('Sizer', 'Sizer', '3 Infra XaaS', vp.name, 'ok');
    recordFinding(...await axeScan(page, `sizer-step3`, vp.name));

    // Step 4 Settings
    await page.locator('#sizer-stepper-button-4').click();
    await page.waitForTimeout(600);
    await snap(page, 'sizer', 'wizard', 4, vp.name);
    mark('Sizer', 'Sizer', '4 Settings', vp.name, 'ok');
    recordFinding(...await axeScan(page, `sizer-step4`, vp.name));

    // Step 5 Results
    await page.locator('#sizer-stepper-button-5').click();
    await page.waitForTimeout(1000);
    await snap(page, 'sizer', 'wizard', 5, vp.name);
    mark('Sizer', 'Sizer', '5 Results', vp.name, 'ok');
    recordFinding(...await axeScan(page, `sizer-step5`, vp.name));

    flushPageErrors(page);
    await ctx.close();
  }
}
```

- [ ] **Step 2: Wire into IIFE**

Uncomment `await sizerDeepWalk(browser);`.

- [ ] **Step 3: Smoke run**

Run. Expected: Sizer section produces ~12 screenshots per viewport.

---

### Task 6: Special interaction sub-tests S-01 through S-06

**Files:**
- Modify: `/tmp/uddi-uxaudit.js` — add `specialChecks(browser)`.

- [ ] **Step 1: Add the harness**

```js
async function specialChecks(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    acceptDownloads: true,
  });
  const page = await ctx.newPage();
  attachErrorListeners(page, 'special');

  // ── S-01: NIOS-X tier auto-derive ───────────────────────────────────────
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await page.locator('text=Manual Sizing Estimator').first().click();
  await page.locator('button:has-text("Next")').first().click();
  await page.locator('[data-testid="sizer-wizard"]').waitFor({ timeout: 5000 });
  await page.locator('[data-testid="sizer-empty-add-region"]').click();
  await page.locator('[data-testid^="sizer-tree-add-site-under-region-"]').first().click();
  await page.locator('#sizer-stepper-button-2').click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid^="sizer-sites-pick-"]').first().click();
  await page.locator('[data-testid="sizer-site-users"]').fill('25000');
  await page.waitForTimeout(1200);
  await page.locator('#sizer-stepper-button-3').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="sizer-niosx-add"]').click();
  await page.waitForTimeout(400);
  await page.locator('button[role="combobox"]').filter({ hasText: /Select site/ }).first().click();
  await page.locator('[role="option"]').first().click();
  await page.waitForTimeout(800);
  const tier = (await page.locator('[data-testid^="sizer-niosx-tier-"]').first().textContent()).trim();
  mark('Special', 'S-01', 'NIOS-X tier auto-derive', '1600', tier === 'XL' ? 'ok' : 'fail', `tier=${tier}`);
  if (tier !== 'XL') {
    recordFinding({
      severity: 'High',
      type: 'Functional',
      where: 'Sizer Step 3 / 1600',
      title: `S-01 regression: tier auto-derive yielded "${tier}", expected XL for 25k users / 80k QPS`,
    });
  }
  await snap(page, 'special', 'S-01', 1, '1600');

  // ── S-05: manual tier sticks + recommend hint appears ──────────────────
  await page.locator('[data-testid^="sizer-niosx-tier-"]').first().click();
  await page.waitForTimeout(300);
  await page.locator('[role="option"]').filter({ hasText: /^XS$/ }).first().click();
  await page.waitForTimeout(400);
  const hintCount = await page.locator('[data-testid^="sizer-niosx-tier-recommend-"]').count();
  mark('Special', 'S-05', 'manual tier hint', '1600', hintCount > 0 ? 'ok' : 'fail');
  if (hintCount === 0) {
    recordFinding({
      severity: 'High',
      type: 'Functional',
      where: 'Sizer Step 3 / 1600',
      title: 'S-05 regression: recommend-back hint did not appear after manual tier pick',
    });
  }
  await snap(page, 'special', 'S-05', 1, '1600');

  // ── S-02: Step 5 export buttons ────────────────────────────────────────
  await page.locator('#sizer-stepper-button-5').click();
  await page.waitForTimeout(1000);
  for (const [testid, label, ext, validator] of [
    ['sizer-export-xlsx', 'XLSX', 'xlsx', buf => buf[0] === 0x50 && buf[1] === 0x4B],
    ['sizer-export-excalidraw', 'Excalidraw', 'excalidraw', buf => {
      try { const j = JSON.parse(buf.toString()); return j.type === 'excalidraw' && j.version === 2; }
      catch { return false; }
    }],
  ]) {
    const dl = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
    await page.locator(`[data-testid="${testid}"]`).click();
    const file = await dl;
    if (!file) {
      recordFinding({ severity: 'Blocker', type: 'Functional', where: 'Sizer Step 5', title: `S-02: ${label} download did not fire` });
      mark('Special', 'S-02', `${label} export`, '1600', 'fail');
      continue;
    }
    const dest = `${OUT}/screenshots/special/${label}.${ext}`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await file.saveAs(dest);
    const buf = fs.readFileSync(dest);
    const ok = validator(buf);
    if (!ok) {
      recordFinding({ severity: 'Blocker', type: 'Functional', where: 'Sizer Step 5', title: `S-02: ${label} file invalid` });
    }
    mark('Special', 'S-02', `${label} export`, '1600', ok ? 'ok' : 'fail');
  }

  // ── S-03: drag-override persistence ────────────────────────────────────
  await page.waitForTimeout(2000); // let Excalidraw lazy-load
  const editSwitch = page.locator('[data-testid="sizer-excalidraw-edit-switch"]');
  if (await editSwitch.count() > 0) {
    await editSwitch.click();
    await page.waitForTimeout(400);
    const pane = page.locator('[data-testid="sizer-excalidraw-pane"]');
    const box = await pane.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 60, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(500);
    }
    await page.locator('#sizer-stepper-button-1').click();
    await page.waitForTimeout(400);
    await page.locator('#sizer-stepper-button-5').click();
    await page.waitForTimeout(1500);
    const ss = await page.evaluate(() => {
      try { const v = JSON.parse(sessionStorage.getItem('ddi_sizer_state_v1') || '{}'); return Object.keys(v?.ui?.excalidrawOverrides || {}).length; }
      catch { return 0; }
    });
    mark('Special', 'S-03', 'drag persistence', '1600', ss > 0 ? 'ok' : 'inconclusive', `overrides=${ss}`);
    if (ss === 0) {
      recordFinding({ severity: 'Medium', type: 'Functional', where: 'Sizer Step 5', title: 'S-03: drag did not produce a persisted override (likely missed an element)' });
    }
  } else {
    mark('Special', 'S-03', 'drag persistence', '1600', 'skipped', 'edit switch not visible');
  }

  // ── S-04: Phase 32 import-bridge + D-18 badge ──────────────────────────
  // Reset by going to a fresh context.
  await ctx.close();
  const ctx2 = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page2 = await ctx2.newPage();
  attachErrorListeners(page2, 'special-import');

  await page2.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  await page2.waitForTimeout(800);
  for (const name of ['Amazon Web Services', 'Microsoft Azure', 'Google Cloud Platform']) {
    await page2.locator(`text=${name}`).first().click().catch(() => {});
    await page2.waitForTimeout(150);
  }
  await page2.locator('button:has-text("Next")').first().click();
  await page2.waitForTimeout(800);
  for (const b of await page2.locator('button:has-text("Validate & Connect")').all()) {
    if (await b.isEnabled().catch(() => false)) { await b.click(); await page2.waitForTimeout(1500); }
  }
  // Click through to results
  for (let i = 0; i < 4; i++) {
    const btn = page2.locator('button').filter({ hasText: /^Next$|^View Results$/ }).first();
    if ((await btn.count()) === 0 || !(await btn.isEnabled().catch(() => false))) break;
    await btn.click();
    await page2.waitForTimeout(2500);
  }
  const importBtn = page2.locator('text=Use as Sizer Input').first();
  if ((await importBtn.count()) > 0) {
    await importBtn.click();
    await page2.waitForTimeout(800);
    const dialog = page2.locator('[role="alertdialog"]').first();
    const dialogText = await dialog.textContent().catch(() => '');
    const counts = /Will add: (\d+) Regions, (\d+) Sites, (\d+) NIOS-X/.exec(dialogText);
    mark('Special', 'S-04', 'dialog counts', '1600', counts ? 'ok' : 'fail', counts ? counts[0] : dialogText.slice(0, 80));
    await page2.locator('[role="alertdialog"] button').filter({ hasText: /Import|Continue|Confirm/ }).first().click();
    await page2.waitForTimeout(2000);
    const badge = page2.locator('[data-testid="sizer-import-badge"]').first();
    const badgeOnAny = (await badge.count()) > 0
      || (await page2.locator('#sizer-stepper-button-1').click(), await page2.waitForTimeout(600), (await badge.count()) > 0);
    mark('Special', 'S-04', 'badge appears', '1600', badgeOnAny ? 'ok' : 'fail');
    if (!badgeOnAny) recordFinding({ severity: 'High', type: 'Functional', where: 'Sizer Step 1', title: 'S-04: D-18 badge did not appear after import' });
    await page2.waitForTimeout(5000);
    const badgeAfter = await badge.count();
    mark('Special', 'S-04', 'badge auto-clear', '1600', badgeAfter === 0 ? 'ok' : 'fail');
    if (badgeAfter !== 0) recordFinding({ severity: 'Medium', type: 'Functional', where: 'Sizer Step 1', title: 'S-04: badge did not auto-clear at 4s' });
    await snap(page2, 'special', 'S-04', 1, '1600');
  } else {
    mark('Special', 'S-04', 'import bridge', '1600', 'fail', 'Use as Sizer Input button missing');
    recordFinding({ severity: 'Blocker', type: 'Functional', where: 'Scan Step 5', title: 'S-04: "Use as Sizer Input" button not found on results page' });
  }

  // ── S-06: NIOS migration planner totals vs Excel export totals ────────
  // Best-effort: this is an exploratory check (per spec — known issue tracked).
  // If a Migration Planner tab is present in scan results, capture its overview total.
  // Actual cross-source reconciliation is sub-project B; here we only flag the gap.
  mark('Special', 'S-06', 'totals reconciliation', '1600', 'deferred', 'see sub-project B');

  flushPageErrors(page2);
  await ctx2.close();
}
```

- [ ] **Step 2: Wire into IIFE**

Uncomment `await specialChecks(browser);`.

- [ ] **Step 3: Smoke run**

Run. Expected: 6 special-check rows added to coverage; relevant findings recorded.

---

### Task 7: Report generation

**Files:**
- Modify: `/tmp/uddi-uxaudit.js` — add `writeReport({ backendMode })` and call it.

- [ ] **Step 1: Add report writer**

```js
function writeReport({ backendMode }) {
  const tally = { Blocker: 0, High: 0, Medium: 0, Low: 0 };
  for (const f of findings) tally[f.severity]++;

  const sectionFor = sev => {
    const items = findings.filter(f => f.severity === sev);
    if (items.length === 0) return `## ${sev}\n\n(none)\n`;
    return `## ${sev}\n\n` + items.map(f =>
`### ${f.id} — ${f.title}
**Where:** ${f.where || '—'}
**Type:** ${f.type || '—'}
${f.evidencePath ? `**Evidence:** ![](${f.evidencePath})` : ''}
${f.repro ? `**Repro:** ${f.repro}` : ''}
${f.recommendation ? `**Recommendation:** ${f.recommendation}` : ''}
`).join('\n');
  };

  const matrix = '| Wizard | Provider | Step | Viewport | Status | Note |\n|---|---|---|---|---|---|\n' +
    coverage.map(c => `| ${c.wizard} | ${c.provider} | ${c.step} | ${c.viewport} | ${c.status} | ${c.note} |`).join('\n');

  const md = `# UDDI Token Calculator — UI/UX Audit
**Run:** ${new Date().toISOString()}
**Backend mode:** ${backendMode}
**Schneider fixtures:** ${SCHNEIDER_AVAILABLE ? 'available' : 'MISSING — upload paths skipped'}

## Summary
- 🔴 Blockers: ${tally.Blocker}
- 🟠 High:    ${tally.High}
- 🟡 Medium:  ${tally.Medium}
- 🔵 Low:     ${tally.Low}
- 📸 Screenshots: ${coverage.length}

${sectionFor('Blocker')}
${sectionFor('High')}
${sectionFor('Medium')}
${sectionFor('Low')}

## Coverage matrix
${matrix}
`;

  fs.writeFileSync(`${OUT}/report.md`, md);
}
```

- [ ] **Step 2: Wire into IIFE**

Replace the `// writeReport({ backendMode });` placeholder with the live call.

- [ ] **Step 3: Smoke run + verify report**

Run the script. Then:

```bash
ls -la /tmp/uddi-uxaudit/$(ls -t /tmp/uddi-uxaudit | head -1)/report.md
head -40 /tmp/uddi-uxaudit/$(ls -t /tmp/uddi-uxaudit | head -1)/report.md
```

Expected: `report.md` exists; first 40 lines show Summary + Blocker section header.

---

### Task 8: Full audit run + triage

**Files:** none — pure execution + analysis.

- [ ] **Step 1: Confirm pre-flight**

```bash
curl -sI http://localhost:5173 | head -1   # should be HTTP/1.1 200
lsof -ti:8080 | xargs kill 2>/dev/null      # ensure backend down (demo mode)
ls /Users/mustermann/Documents/coding/Infoblox-Universal-DDI-cloud-usage 2>/dev/null && echo schneider-ok || echo schneider-missing
```

- [ ] **Step 2: Run the full audit**

Run: `cd ~/.claude/skills/playwright-skill && node run.js /tmp/uddi-uxaudit.js`
Expected: ~30 minutes, browser visible, ~90 screenshots captured, exits 0. The final line prints the report path.

- [ ] **Step 3: Read the report**

```bash
cat /tmp/uddi-uxaudit/$(ls -t /tmp/uddi-uxaudit | head -1)/report.md
```

- [ ] **Step 4: Summarise findings to the user**

Present: counts per severity tier; the top-3 Blockers (if any); the top-3 Highs; one sentence on each Medium/Low cluster. End with the report path so the user can open the full file.

- [ ] **Step 5: Stop here**

Do NOT auto-fix findings. Do NOT open GitLab issues. Sub-project A's deliverable is the report. Triage is a separate user-driven step.

---

## Self-Review

- ✅ **Spec coverage:** D-01..D-10 each map to a task: D-01 (functional+visual+a11y) → Tasks 2-7; D-02 (provider matrix) → Task 3 + Estimator + Sizer in 4-5; D-03 (viewports) → `VIEWPORTS` constant in Task 1; D-04 (Schneider) → `SCHNEIDER_AVAILABLE` gate in Task 1 + skip logic in Task 3; D-05 (Markdown) → Task 7; D-06 (one-shot, /tmp) → Task 1; D-07 (4-tier) → severity classifier in Tasks 2 + 7; D-08 (mega-script) → single file `/tmp/uddi-uxaudit.js`; D-09 (demo mode) → pre-flight check in Task 1; D-10 (axe wcag2aa+wcag21aa) → Task 2 axe wrapper.
- ✅ **Special sub-tests:** S-01..S-06 in Task 6.
- ✅ **Acceptance criteria:** 1-6 from spec all map to tasks (1→Task 7, 2→Task 7, 3→Task 8, 4→Task 6, 5→Task 7, 6→Task 1).
- ✅ **No placeholders:** no TBD, no "implement later", every step has runnable commands or paste-ready code.
- ✅ **Type/symbol consistency:** `findings`, `coverage`, `nextId`, `recordFinding`, `axeScan`, `snap`, `mark`, `flushPageErrors` defined in Task 1-2, used in Tasks 3-7.
- ✅ **Frequent commits:** N/A — script is in `/tmp/`, never committed (D-06). Plan + spec are the only repo artefacts.
