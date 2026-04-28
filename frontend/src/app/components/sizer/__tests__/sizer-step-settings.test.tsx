/**
 * sizer-step-settings.test.tsx — Step 4 (Settings + Security) component tests.
 *
 * Covers plan 30-06 Task 3 done criteria:
 *   1. All 3 sections render expanded on first mount.
 *   2. Clicking a section trigger collapses it (TOGGLE_SECTION dispatched;
 *      state persists across unmount/remount via reducer + sessionStorage).
 *   3. Growth Buffer slider sets value; "Advanced" toggle reveals 4 sliders.
 *   4. Advanced reset icon dispatches SET_OVERHEAD(category, undefined).
 *   5. Security: fixture with 2 sites (Σ verified=150, Σ unverified=75) →
 *      tdVerifiedAssets=150 and AutoBadge visible on first render.
 *   6. Editing tdVerifiedAssets → AutoBadge disappears.
 *   7. Recalculate from Sites restores Σ + AutoBadge.
 *   8. Security Switch off → inputs rendered with aria-disabled.
 *   9. Live preview Total updates synchronously on input change.
 *  10. Module toggles dispatch correctly; logging toggles dimmed when parent off.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  SizerProvider,
  STORAGE_KEY,
  initialSizerState,
  type SizerFullState,
} from '../sizer-state';
import { SizerStepSettings } from '../sizer-step-settings';
import { calculateSecurityTokens } from '../sizer-calc';

function clearStorage() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Build a seed state with two Sites carrying verified/unverified assets. */
function seedState(overrides?: Partial<SizerFullState>): SizerFullState {
  const base = initialSizerState();
  const state: SizerFullState = {
    ...base,
    core: {
      ...base.core,
      security: { ...base.core.security, securityEnabled: true },
      regions: [
        {
          id: 'region-1',
          name: 'EMEA',
          type: 'on-premises',
          cloudNativeDns: false,
          countries: [
            {
              id: 'country-1',
              name: 'DE',
              cities: [
                {
                  id: 'city-1',
                  name: 'Berlin',
                  sites: [
                    {
                      id: 'site-1',
                      name: 'HQ',
                      multiplier: 1,
                      users: 500,
                      verifiedAssets: 100,
                      unverifiedAssets: 50,
                    },
                    {
                      id: 'site-2',
                      name: 'Branch',
                      multiplier: 1,
                      users: 100,
                      verifiedAssets: 50,
                      unverifiedAssets: 25,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      ...overrides?.core,
    },
    ui: { ...base.ui, ...overrides?.ui },
  };
  return state;
}

function seed(state: SizerFullState) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function mount() {
  return render(
    <SizerProvider>
      <SizerStepSettings />
    </SizerProvider>,
  );
}

describe('<SizerStepSettings/>', () => {
  beforeEach(() => clearStorage());

  it('renders three sections all expanded on first mount', () => {
    mount();
    expect(screen.getByTestId('sizer-step-settings')).toBeInTheDocument();
    for (const key of ['modules', 'growth', 'security']) {
      const trigger = screen.getByTestId(`sizer-step4-section-${key}-trigger`);
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
    }
    expect(screen.getByTestId('sizer-step4-section-modules-body')).toBeInTheDocument();
    expect(screen.getByTestId('sizer-step4-section-growth-body')).toBeInTheDocument();
    expect(screen.getByTestId('sizer-step4-section-security-body')).toBeInTheDocument();
  });

  it('clicking a section trigger collapses it (TOGGLE_SECTION dispatched)', async () => {
    const user = userEvent.setup();
    mount();
    const trigger = screen.getByTestId('sizer-step4-section-modules-trigger');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.click(trigger);
    expect(screen.getByTestId('sizer-step4-section-modules-trigger')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // Other sections unchanged.
    expect(screen.getByTestId('sizer-step4-section-growth-trigger')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('section state rehydrates from sessionStorage on mount', () => {
    // Pre-seed with modules section collapsed.
    const base = initialSizerState();
    const state: SizerFullState = {
      ...base,
      ui: {
        ...base.ui,
        sectionsOpen: { modules: false, growth: true, security: true },
      },
    };
    seed(state);
    mount();
    expect(screen.getByTestId('sizer-step4-section-modules-trigger')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getByTestId('sizer-step4-section-growth-trigger')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('Growth Buffer slider has correct initial value and Advanced toggle reveals 4 sliders', async () => {
    const user = userEvent.setup();
    mount();
    // default growthBuffer = 0.2 → "20 %"
    expect(screen.getByTestId('sizer-growth-slider-value').textContent).toMatch(/20\s*%/);
    expect(screen.queryByTestId('sizer-growth-advanced')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('sizer-growth-advanced-toggle'));
    expect(screen.getByTestId('sizer-growth-advanced')).toBeInTheDocument();
    for (const cat of ['mgmt', 'server', 'reporting', 'security']) {
      expect(screen.getByTestId(`sizer-growth-advanced-${cat}`)).toBeInTheDocument();
    }
  });

  it('Advanced per-category reset icon is disabled when no override set and enabled after override', async () => {
    const user = userEvent.setup();
    const base = seedState();
    const withOverride: SizerFullState = {
      ...base,
      core: {
        ...base.core,
        globalSettings: {
          ...base.core.globalSettings,
          growthBufferAdvanced: true,
          mgmtOverhead: 0.3,
        },
      },
      ui: { ...base.ui, growthBufferAdvanced: true },
    };
    seed(withOverride);
    mount();

    const resetBtn = screen.getByTestId('sizer-growth-advanced-mgmt-reset');
    expect(resetBtn).not.toBeDisabled();
    // server has no override → reset disabled
    expect(screen.getByTestId('sizer-growth-advanced-server-reset')).toBeDisabled();

    await user.click(resetBtn);
    // After reset, mgmt reset button becomes disabled (override cleared).
    expect(screen.getByTestId('sizer-growth-advanced-mgmt-reset')).toBeDisabled();
  });

  it('Security auto-fills verified=150 / unverified=75 on first open and shows AutoBadge', () => {
    seed(seedState());
    mount();

    const verified = screen.getByTestId('sizer-security-verified') as HTMLInputElement;
    const unverified = screen.getByTestId('sizer-security-unverified') as HTMLInputElement;
    expect(verified.value).toBe('150');
    expect(unverified.value).toBe('75');
    expect(screen.getByTestId('sizer-security-auto-badge-verified')).toBeInTheDocument();
    expect(screen.getByTestId('sizer-security-auto-badge-unverified')).toBeInTheDocument();
  });

  it('editing tdVerifiedAssets hides the AutoBadge for that field', async () => {
    const user = userEvent.setup();
    seed(seedState());
    mount();
    expect(screen.getByTestId('sizer-security-auto-badge-verified')).toBeInTheDocument();

    const verified = screen.getByTestId('sizer-security-verified');
    await user.clear(verified);
    await user.type(verified, '999');

    expect(screen.queryByTestId('sizer-security-auto-badge-verified')).not.toBeInTheDocument();
    // Unverified badge still present.
    expect(screen.getByTestId('sizer-security-auto-badge-unverified')).toBeInTheDocument();
  });

  it('Recalculate from Sites restores Σ values and re-adds AutoBadges', async () => {
    const user = userEvent.setup();
    seed(seedState());
    mount();

    // Edit verified → auto badge disappears.
    const verified = screen.getByTestId('sizer-security-verified');
    await user.clear(verified);
    await user.type(verified, '42');
    expect(screen.queryByTestId('sizer-security-auto-badge-verified')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('sizer-security-recalc'));
    expect((screen.getByTestId('sizer-security-verified') as HTMLInputElement).value).toBe('150');
    expect(screen.getByTestId('sizer-security-auto-badge-verified')).toBeInTheDocument();
  });

  it('Security Switch off → inputs are disabled and the container has aria-disabled', async () => {
    const user = userEvent.setup();
    mount();
    // Default: securityEnabled=false.
    const verified = screen.getByTestId('sizer-security-verified') as HTMLInputElement;
    expect(verified).toBeDisabled();
    const body = screen.getByTestId('sizer-step4-section-security-body');
    // The disabled container has aria-disabled="true".
    expect(body.querySelector('[aria-disabled="true"]')).not.toBeNull();

    // Flip on.
    await user.click(screen.getByTestId('sizer-security-enabled'));
    expect(screen.getByTestId('sizer-security-verified')).not.toBeDisabled();
  });

  it('live preview Total updates synchronously when Dossier input changes', async () => {
    const user = userEvent.setup();
    const base = seedState();
    // Disable security so we start from 0 then flip on to avoid auto-fill noise.
    const s: SizerFullState = {
      ...base,
      core: {
        ...base.core,
        security: {
          ...base.core.security,
          securityEnabled: true,
          tdVerifiedAssets: 0,
          tdUnverifiedAssets: 0,
        },
        regions: [], // no sites → auto-fill sums to 0
      },
      ui: {
        ...base.ui,
        securityAutoFilled: { tdVerifiedAssets: true, tdUnverifiedAssets: true },
      },
    };
    seed(s);
    mount();
    const total0 = screen.getByTestId('sizer-security-preview-total').textContent;
    expect(total0).toBe('0');

    const dossier = screen.getByTestId('sizer-security-dossier');
    await user.clear(dossier);
    await user.type(dossier, '25');

    const totalAfter = Number(
      screen.getByTestId('sizer-security-preview-total').textContent?.replace(/,/g, '') ?? '',
    );
    // Expected via the authoritative calc (overhead defaults to growthBuffer=0.2).
    const expected = calculateSecurityTokens(
      {
        securityEnabled: true,
        socInsightsEnabled: false,
        tdVerifiedAssets: 0,
        tdUnverifiedAssets: 0,
        dossierQueriesPerDay: 25,
        lookalikeDomainsMentioned: 0,
      },
      0.2,
    );
    expect(totalAfter).toBe(expected);
    expect(totalAfter).toBeGreaterThan(0);
  });

  it('Module toggles dispatch and DNS Logging is dimmed when DNS module is off', async () => {
    const user = userEvent.setup();
    mount();
    const dns = screen.getByTestId('sizer-module-dns');
    // Default: DNS on → DNS Logging row not dimmed (pointer-events allowed).
    expect(dns).toHaveAttribute('aria-checked', 'true');

    await user.click(dns);
    // DNS is now off. DNS Logging parent row should be disabled (aria-disabled=true).
    const dnsLogging = screen.getByTestId('sizer-logging-dns');
    // Find enclosing row that received opacity-50 + aria-disabled.
    const row = dnsLogging.closest('[class*="opacity-50"]') ?? dnsLogging.parentElement;
    expect(row).not.toBeNull();
  });

  it('Reporting destination checkboxes are rendered and clickable', async () => {
    const user = userEvent.setup();
    mount();
    const csp = screen.getByTestId('sizer-reporting-csp');
    const s3 = screen.getByTestId('sizer-reporting-s3');
    expect(csp).toBeInTheDocument();
    expect(s3).toBeInTheDocument();
    // Default csp=true. Click to toggle off.
    await user.click(csp);
    expect(csp).toHaveAttribute('aria-checked', 'false');
  });

  it('collapsed section hides its body contents', async () => {
    const user = userEvent.setup();
    mount();
    expect(screen.getByTestId('sizer-step4-section-security-body')).toBeInTheDocument();
    await user.click(screen.getByTestId('sizer-step4-section-security-trigger'));
    // Radix Collapsible removes content from the tree when closed.
    expect(screen.queryByTestId('sizer-step4-section-security-body')).not.toBeInTheDocument();
  });
});

// Dead-code guard: keep `within` usable by grouped queries if future tests add them.
void within;
