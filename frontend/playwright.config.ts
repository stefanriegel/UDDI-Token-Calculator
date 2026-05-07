/**
 * playwright.config.ts — Phase 32 Plan 06.
 *
 * Minimal config that boots the Vite dev server in demo mode (no Go backend
 * required) and runs specs from `tests-e2e/`.
 *
 * Install steps (one-time per checkout):
 *   pnpm add -D @playwright/test
 *   pnpm exec playwright install chromium
 *
 * Run:
 *   pnpm exec playwright test
 *   pnpm exec playwright test --grep @phase-32
 *   pnpm exec playwright test sizer-import.spec.ts --reporter=list
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests-e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: 'pnpm dev',
        url: 'http://localhost:5173',
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
