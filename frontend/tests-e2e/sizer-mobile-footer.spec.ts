/**
 * sizer-mobile-footer.spec.ts — Issue #32 regression.
 *
 * On a narrow mobile viewport (390x844), the Sizer wizard's sticky bottom
 * action bar (`sizer-footer-back` / `sizer-footer-next`) must not overlap
 * the form content in the Sites step. The fix is bottom padding on the
 * main step body so users can scroll the last fields above the footer.
 *
 * Tag: @issue-32 — run with `pnpm exec playwright test --grep @issue-32`.
 */

import { test, expect, type Page } from '@playwright/test';

const APP_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173';

async function openSizerSitesStep(page: Page) {
  await page.goto(APP_URL);
  await page
    .getByRole('button', { name: /manual estimator/i })
    .first()
    .click();
  await page.getByRole('button', { name: /continue|next/i }).first().click();
  await page.getByTestId('sizer-wizard').waitFor({ state: 'visible', timeout: 10_000 });
  // Advance from Step 1 (Regions) → Step 2 (Sites).
  await page.getByTestId('sizer-footer-next').click();
}

test.describe('@issue-32 Sizer sticky footer mobile no-overlap', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('Sites step main content reserves enough bottom padding so the sticky footer does not cover form fields', async ({
    page,
  }) => {
    await openSizerSitesStep(page);

    const footer = page.getByTestId('sizer-footer-next').locator('..');
    const main = page.locator('main#sizer-step-panel, main[role="tabpanel"]').first();

    const footerBox = await footer.boundingBox();
    expect(footerBox).not.toBeNull();
    const mainPadBottom = await main.evaluate(
      (el) => parseFloat(getComputedStyle(el).paddingBottom),
    );

    // Footer is h-16 (64px). Padding-bottom on the step body must clear it
    // so the last form field can be scrolled fully into view above the bar.
    expect(mainPadBottom).toBeGreaterThanOrEqual(footerBox!.height);

    // Scroll to absolute end of page; assert bottom of main content sits at
    // or above top of sticky footer (no overlap of real content).
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(150);

    const footerRect = await footer.evaluate((el) => el.getBoundingClientRect().top);
    const mainContentRect = await main.evaluate((el) => {
      const last = el.lastElementChild as HTMLElement | null;
      return last ? last.getBoundingClientRect().bottom : el.getBoundingClientRect().bottom;
    });
    expect(mainContentRect).toBeLessThanOrEqual(footerRect + 1);
  });
});
