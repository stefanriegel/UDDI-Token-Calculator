/**
 * results-surface.spec.ts — Phase 33 Plan 06.
 *
 * End-to-end smoke proving both wizards now render the unified
 * `<ResultsSurface/>` composition (Plans 04 + 05):
 *   1. Sizer flow: Step 5 mounts the sizer-mode surface — only the three
 *      universal section anchors (#section-overview, #section-bom,
 *      #section-export) and the Sizer-mode Start Over copy (D-15) are
 *      present. Scan-only sections (#section-migration-planner,
 *      #section-member-details, #section-ad-migration) are gated out
 *      (D-07/D-09).
 *   2. Scan flow: Step 5 in demo mode mounts the scan-mode surface —
 *      #section-overview, #section-bom, #section-findings, #section-export
 *      all visible; OutlineNav renders multiple anchors.
 *
 * Tag: @phase-33 — run with `pnpm exec playwright test --grep @phase-33`.
 */

import { test, expect, type Page } from '@playwright/test';

const APP_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Selects "Manual Estimator" on the scan wizard's Step 1 and continues —
 * which mounts the SizerWizard inside the same page (per wizard.tsx:2281).
 * Returns once the Sizer Step 1 (Regions) is visible.
 */
async function openSizerWizard(page: Page) {
  await page.goto(APP_URL);
  await page
    .getByRole('button', { name: /manual estimator/i })
    .first()
    .click();
  // Outer scan wizard's Continue/Next button to advance into the Sizer mount.
  await page.getByRole('button', { name: /continue|next/i }).first().click();
  await page.getByTestId('sizer-wizard').waitFor({ state: 'visible', timeout: 10_000 });
}

/**
 * Walks the scan wizard from Step 1 (provider select) through Step 5
 * (results) using demo-mode mock data with AWS as the selected provider.
 */
async function runDemoScan(page: Page, providers: string[] = ['AWS']) {
  await page.goto(APP_URL);
  for (const name of providers) {
    await page
      .getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
      .first()
      .click();
  }
  await page.getByRole('button', { name: /continue|next/i }).first().click();

  // Demo-mode auto-validates blank credentials; mash Continue/Next/Start Scan.
  for (let i = 0; i < 6; i++) {
    const next = page
      .getByRole('button', { name: /continue|next|start.*scan/i })
      .first();
    if (await next.isVisible().catch(() => false)) {
      await next.click();
      await page.waitForTimeout(300);
    } else {
      break;
    }
  }

  // Scan finishes when the results page surfaces. The Use-as-Sizer-Input
  // trigger is a stable anchor that only renders on Step 5.
  await page
    .getByTestId('sizer-import-trigger')
    .waitFor({ state: 'visible', timeout: 30_000 });
}

// ─── Sizer flow ──────────────────────────────────────────────────────────────

test.describe('@phase-33 ResultsSurface — Sizer flow (mode="sizer")', () => {
  test('Step 5 renders only the three universal sections (D-07) + Sizer reset copy (D-15)', async ({
    page,
  }) => {
    await openSizerWizard(page);

    // Add at least one Region so the report has data to render.
    await page.getByTestId('sizer-tree-add-region').click();

    // Jump to Step 4, then click "View Report →" — Sizer Step 5 was retired
    // 2026-04-26; the outer wizard's Results & Export step now hosts the report.
    await page.getByTestId('sizer-stepper-step-4').click();
    await page.getByTestId('sizer-footer-next').click();
    await page
      .getByTestId('sizer-step-results')
      .waitFor({ state: 'visible', timeout: 10_000 });

    // Three universal sections are present.
    await expect(page.locator('#section-overview')).toBeVisible();
    await expect(page.locator('#section-overview')).toContainText(
      'Total Management Tokens',
    );
    await expect(page.locator('#section-bom')).toBeVisible();
    await expect(page.locator('#section-export')).toBeVisible();
    await expect(
      page.getByRole('button', { name: /download xlsx/i }),
    ).toBeVisible();

    // Pure-Sizer flow — scan-only sections never mount (D-07/D-09).
    await expect(page.locator('#section-migration-planner')).toHaveCount(0);
    await expect(page.locator('#section-member-details')).toHaveCount(0);
    await expect(page.locator('#section-ad-migration')).toHaveCount(0);
    await expect(page.locator('#section-findings')).toHaveCount(0);

    // Start Over reveals the Sizer-mode AlertDialog with verbatim copy.
    await page.getByRole('button', { name: /start over/i }).click();
    await expect(
      page.getByText(
        'This clears Sizer state stored in this browser. Your inputs cannot be recovered.',
      ),
    ).toBeVisible();
  });
});

// ─── Scan flow ───────────────────────────────────────────────────────────────

test.describe('@phase-33 ResultsSurface — scan flow (mode="scan")', () => {
  test('Step 5 demo-mode renders overview + bom + findings + export sections', async ({
    page,
  }) => {
    await runDemoScan(page, ['AWS']);

    // The four reliably-present scan-mode sections.
    await expect(page.locator('#section-overview')).toBeVisible();
    await expect(page.locator('#section-overview')).toContainText(
      'Total Management Tokens',
    );
    await expect(page.locator('#section-bom')).toBeVisible();
    await expect(page.locator('#section-findings')).toBeVisible();
    await expect(page.locator('#section-export')).toBeVisible();
    await expect(
      page.getByRole('button', { name: /download xlsx/i }),
    ).toBeVisible();
  });
});
