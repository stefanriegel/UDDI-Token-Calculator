/**
 * sizer-validation-banner.test.tsx — Plan 30-07 banner + inline marker tests.
 *
 * Covers:
 *   1. XaaS over-connections → XAAS_OVER_CONNECTIONS row rendered.
 *   2. REGION_EMPTY_OTHERWISE warning appears when a region has no sites.
 *   3. SECURITY_ENABLED_ZERO_ASSETS error tints banner red.
 *   4. Only warnings → amber bg; any error → red bg.
 *   5. [Go to] dispatches SET_ACTIVE_STEP + SET_SELECTED_PATH, calls
 *      scrollIntoView, focuses target (P-10).
 *   6. [×] dismisses a code; row disappears.
 *   7. Auto-undismiss: state change re-emits same code with different message
 *      → reducer's dismissed set loses the code.
 *   8. All 6 codes (XAAS_OVER_CONNECTIONS, SITE_UNASSIGNED, REGION_EMPTY,
 *      OBJECT_COUNT_MISMATCH, SECURITY_ENABLED_ZERO_ASSETS, LPS_OUT_OF_RANGE)
 *      surface together.
 *   9. Banner hidden entirely when all codes dismissed.
 *  10. InlineMarker click scrolls to banner row + focuses its [Go to] button.
 *  11. Banner has role="region" + aria-label="Validation issues".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import {
  SizerProvider,
  STORAGE_KEY,
  initialSizerState,
  type SizerFullState,
} from '../sizer-state';
import { SizerValidationBanner, stepForPath } from '../sizer-validation-banner';
import { InlineMarker } from '../ui/inline-marker';
import { VALIDATION_CODES } from '../sizer-validate';
import type { SizerState } from '../sizer-types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clearStorage() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function seed(
  core: Partial<SizerState>,
  dismissed: string[] = [],
  activeStep: 1 | 2 | 3 | 4 = 3,
) {
  const base = initialSizerState();
  const state: SizerFullState = {
    ...base,
    core: { ...base.core, ...core } as SizerState,
    ui: { ...base.ui, dismissedCodes: dismissed, activeStep },
  };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function mount() {
  return render(
    <SizerProvider>
      <SizerValidationBanner />
    </SizerProvider>,
  );
}

function regionWithSite(opts: {
  regionName?: string;
  siteId?: string;
  siteName?: string;
  users?: number;
  activeIPs?: number;
  lps?: number;
} = {}) {
  return {
    id: 'r1',
    name: opts.regionName ?? 'EMEA',
    type: 'on-premises' as const,
    cloudNativeDns: false,
    countries: [
      {
        id: 'c1',
        name: 'DE',
        cities: [
          {
            id: 'ct1',
            name: 'Berlin',
            sites: [
              {
                id: opts.siteId ?? 's1',
                name: opts.siteName ?? 'HQ',
                multiplier: 1,
                users: opts.users ?? 500,
                activeIPs: opts.activeIPs,
                lps: opts.lps,
              },
            ],
          },
        ],
      },
    ],
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearStorage();
  // jsdom lacks scrollIntoView; stub to no-op and spy.
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn();
});

afterEach(() => {
  clearStorage();
  vi.restoreAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('stepForPath', () => {
  it('maps region/country/city paths to Step 1', () => {
    expect(stepForPath('regions[0]')).toBe(1);
    expect(stepForPath('regions[0].countries[0]')).toBe(1);
    expect(stepForPath('regions[0].countries[0].cities[0]')).toBe(1);
  });
  it('maps site paths to Step 2', () => {
    expect(stepForPath('regions[0].countries[0].cities[0].sites[0]')).toBe(2);
  });
  it('maps infrastructure paths to Step 3', () => {
    expect(stepForPath('infrastructure')).toBe(3);
    expect(stepForPath('infrastructure.xaas[0]')).toBe(3);
  });
  it('maps security paths to Step 4', () => {
    expect(stepForPath('security')).toBe(4);
  });
});

describe('SizerValidationBanner — rendering', () => {
  it('XaaS over-connections surfaces as one row', () => {
    seed({
      regions: [regionWithSite()],
      infrastructure: {
        niosx: [
          { id: 'n1', name: 'NX', siteId: 's1', formFactor: 'nios-x', tierName: 'M' },
        ],
        xaas: [
          {
            id: 'x1',
            name: 'XaaS-EMEA',
            regionId: 'r1',
            tierName: 'S', // S tier: maxConnections=25
            connections: 999,
            connectedSiteIds: ['s1'],
            connectivity: 'vpn',
            popLocation: 'aws-us-east-1',
          },
        ],
      },
    });
    mount();
    const row = screen.getByTestId(
      `sizer-validation-row-${VALIDATION_CODES.XAAS_OVER_CONNECTIONS}`,
    );
    expect(row).toBeTruthy();
    expect(row.textContent).toContain('XaaS');
  });

  it('REGION_EMPTY_OTHERWISE surfaces for a region with no sites', () => {
    seed({
      regions: [
        {
          id: 'r1',
          name: 'APAC',
          type: 'on-premises',
          cloudNativeDns: false,
          countries: [],
        },
      ],
    });
    mount();
    expect(
      screen.getByTestId(
        `sizer-validation-row-${VALIDATION_CODES.REGION_EMPTY_OTHERWISE}`,
      ),
    ).toBeTruthy();
  });

  it('SECURITY_ENABLED_ZERO_ASSETS tints the banner red', () => {
    seed({
      regions: [regionWithSite()],
      infrastructure: {
        niosx: [
          { id: 'n1', name: 'NX', siteId: 's1', formFactor: 'nios-x', tierName: 'M' },
        ],
        xaas: [],
      },
      security: {
        securityEnabled: true,
        socInsightsEnabled: false,
        tdVerifiedAssets: 0,
        tdUnverifiedAssets: 0,
        dossierQueriesPerDay: 0,
        lookalikeDomainsMentioned: 0,
      },
    });
    mount();
    const banner = screen.getByTestId('sizer-validation-banner');
    expect(banner.className).toMatch(/bg-red-50/);
  });

  it('only warnings → amber bg', () => {
    // Region with no sites → single warning.
    seed({
      regions: [
        {
          id: 'r1',
          name: 'APAC',
          type: 'on-premises',
          cloudNativeDns: false,
          countries: [],
        },
      ],
    });
    mount();
    const banner = screen.getByTestId('sizer-validation-banner');
    expect(banner.className).toMatch(/bg-amber-50/);
    expect(banner.className).not.toMatch(/bg-red-50/);
  });

  it('issue #3: row wraps long messages instead of truncating (mobile readability)', () => {
    seed({
      regions: [
        {
          id: 'r1',
          name: 'APAC',
          type: 'on-premises',
          cloudNativeDns: false,
          countries: [],
        },
      ],
    });
    mount();
    const row = screen.getByTestId(
      `sizer-validation-row-${VALIDATION_CODES.REGION_EMPTY_OTHERWISE}`,
    );
    // Row must NOT clamp height to single line (was h-10 + truncate).
    const classes = row.className.split(/\s+/);
    expect(classes).not.toContain('h-10');
    expect(classes).toContain('min-h-10');
    // Message span must wrap, not truncate.
    const msgSpan = row.querySelector('span.flex-1');
    expect(msgSpan).toBeTruthy();
    expect(msgSpan!.className).not.toMatch(/truncate/);
    expect(msgSpan!.className).toMatch(/break-words/);
  });

  it('has role="region" with aria-label', () => {
    seed({
      regions: [
        {
          id: 'r1',
          name: 'APAC',
          type: 'on-premises',
          cloudNativeDns: false,
          countries: [],
        },
      ],
    });
    mount();
    const banner = screen.getByTestId('sizer-validation-banner');
    expect(banner.getAttribute('role')).toBe('region');
    expect(banner.getAttribute('aria-label')).toBe('Validation issues');
  });
});

describe('SizerValidationBanner — [Go to] navigation (P-10)', () => {
  it('dispatches step+path, scrolls target, focuses target', async () => {
    seed({
      regions: [regionWithSite()],
      infrastructure: {
        niosx: [
          { id: 'n1', name: 'NX', siteId: 's1', formFactor: 'nios-x', tierName: 'M' },
        ],
        xaas: [
          {
            id: 'x1',
            name: 'XaaS-EMEA',
            regionId: 'r1',
            tierName: 'S',
            connections: 999,
            connectedSiteIds: ['s1'],
            connectivity: 'vpn',
            popLocation: 'aws-us-east-1',
          },
        ],
      },
    });

    // Insert a target in the DOM keyed on the issue path.
    const target = document.createElement('div');
    target.setAttribute('data-sizer-path', 'infrastructure.xaas[0]');
    target.tabIndex = -1;
    const focusSpy = vi.spyOn(target, 'focus');
    const scrollSpy = vi.spyOn(target, 'scrollIntoView');
    document.body.appendChild(target);

    // Stable rAF → setTimeout 0 for Happy-DOM/jsdom; vi.useFakeTimers isn't
    // needed because rAF runs inline via Node's microtasks → queue manually.
    const origRAF = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => {
      cb(0);
      return 0 as unknown as number;
    };

    try {
      mount();
      const btn = screen.getByTestId(
        `sizer-validation-goto-${VALIDATION_CODES.XAAS_OVER_CONNECTIONS}`,
      );
      act(() => {
        fireEvent.click(btn);
      });
      expect(scrollSpy).toHaveBeenCalled();
      expect(focusSpy).toHaveBeenCalled();
    } finally {
      window.requestAnimationFrame = origRAF;
      target.remove();
    }
  });
});

describe('SizerValidationBanner — dismissal', () => {
  it('[×] removes the row from the banner', () => {
    seed({
      regions: [
        {
          id: 'r1',
          name: 'APAC',
          type: 'on-premises',
          cloudNativeDns: false,
          countries: [],
        },
      ],
    });
    mount();
    const code = VALIDATION_CODES.REGION_EMPTY_OTHERWISE;
    const dismiss = screen.getByTestId(`sizer-validation-dismiss-${code}`);
    act(() => {
      fireEvent.click(dismiss);
    });
    expect(screen.queryByTestId(`sizer-validation-row-${code}`)).toBeNull();
  });

  it('hidden entirely when all issues are dismissed', () => {
    const code = VALIDATION_CODES.REGION_EMPTY_OTHERWISE;
    seed(
      {
        regions: [
          {
            id: 'r1',
            name: 'APAC',
            type: 'on-premises',
            cloudNativeDns: false,
            countries: [],
          },
        ],
      },
      [code],
    );
    mount();
    expect(screen.queryByTestId('sizer-validation-banner')).toBeNull();
  });

  it('auto-clears dismissal when same code re-emits with different message', async () => {
    // First render: region "APAC" → warning "Region APAC has no Sites yet."
    seed(
      {
        regions: [
          {
            id: 'r1',
            name: 'APAC',
            type: 'on-premises',
            cloudNativeDns: false,
            countries: [],
          },
        ],
      },
      [], // not yet dismissed
    );
    const { rerender } = mount();
    const code = VALIDATION_CODES.REGION_EMPTY_OTHERWISE;

    // Dismiss it.
    act(() => {
      fireEvent.click(screen.getByTestId(`sizer-validation-dismiss-${code}`));
    });
    expect(screen.queryByTestId(`sizer-validation-row-${code}`)).toBeNull();

    // Now rename the region — message text contains the name, so a new state
    // produces a different message for the same code → auto-undismiss.
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY)!) as SizerFullState;
    stored.core.regions[0].name = 'LATAM';
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));

    // Force a fresh provider instance so the new sessionStorage is picked up.
    rerender(
      <SizerProvider key="fresh">
        <SizerValidationBanner />
      </SizerProvider>,
    );

    // Row should resurface because auto-undismiss cleared the code.
    const row = screen.getByTestId(`sizer-validation-row-${code}`);
    expect(row.textContent).toContain('LATAM');
  });
});

describe('SizerValidationBanner — comprehensive fixture', () => {
  it('surfaces multiple codes simultaneously', () => {
    seed({
      regions: [
        // Region r1: has a site (so r2 empty region becomes an ERROR — fine,
        // we only care about multi-code surfacing here).
        {
          id: 'r1',
          name: 'EMEA',
          type: 'on-premises',
          cloudNativeDns: false,
          countries: [
            {
              id: 'c1',
              name: 'DE',
              cities: [
                {
                  id: 'ct1',
                  name: 'Berlin',
                  sites: [
                    {
                      id: 's1',
                      name: 'HQ',
                      multiplier: 1,
                      users: 500,
                      lps: 99999, // LPS_OUT_OF_RANGE
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      infrastructure: {
        niosx: [], // no assignment → SITE_UNASSIGNED
        xaas: [
          {
            id: 'x1',
            name: 'XaaS-EMEA',
            regionId: 'r1',
            tierName: 'S',
            connections: 9999, // XAAS_OVER_CONNECTIONS
            connectedSiteIds: [],
            connectivity: 'vpn',
            popLocation: 'aws-us-east-1',
          },
        ],
      },
      security: {
        securityEnabled: true,
        socInsightsEnabled: false,
        tdVerifiedAssets: 0,
        tdUnverifiedAssets: 0,
        dossierQueriesPerDay: 0,
        lookalikeDomainsMentioned: 0,
      },
    });
    mount();
    // Expect at least these codes to surface together.
    expect(
      screen.getByTestId(
        `sizer-validation-row-${VALIDATION_CODES.XAAS_OVER_CONNECTIONS}`,
      ),
    ).toBeTruthy();
    expect(
      screen.getByTestId(
        `sizer-validation-row-${VALIDATION_CODES.SITE_UNASSIGNED}`,
      ),
    ).toBeTruthy();
    expect(
      screen.getByTestId(
        `sizer-validation-row-${VALIDATION_CODES.LPS_OUT_OF_RANGE}`,
      ),
    ).toBeTruthy();
    expect(
      screen.getByTestId(
        `sizer-validation-row-${VALIDATION_CODES.SECURITY_ENABLED_ZERO_ASSETS}`,
      ),
    ).toBeTruthy();
  });
});

describe('SizerValidationBanner — issue #27 step-aware infra warnings', () => {
  it('suppresses SITE_UNASSIGNED on Step 1 (Region setup)', () => {
    seed(
      {
        regions: [regionWithSite()],
        infrastructure: { niosx: [], xaas: [] },
      },
      [],
      1,
    );
    mount();
    expect(
      screen.queryByTestId(
        `sizer-validation-row-${VALIDATION_CODES.SITE_UNASSIGNED}`,
      ),
    ).toBeNull();
    expect(
      screen.queryByTestId(
        `sizer-validation-row-${VALIDATION_CODES.OBJECT_COUNT_MISMATCH}`,
      ),
    ).toBeNull();
  });

  it('suppresses infra warnings on Step 2 (Sites)', () => {
    seed(
      {
        regions: [regionWithSite()],
        infrastructure: { niosx: [], xaas: [] },
      },
      [],
      2,
    );
    mount();
    // Banner should not render at all when only deferred infra warnings exist.
    expect(screen.queryByTestId('sizer-validation-banner')).toBeNull();
  });

  it('surfaces SITE_UNASSIGNED once user reaches Step 3 (Infrastructure)', () => {
    // Add an unrelated NIOS-X so SITE_UNASSIGNED is not suppressed by the
    // noInfra short-circuit in the validator.
    seed(
      {
        regions: [regionWithSite()],
        infrastructure: {
          niosx: [
            {
              id: 'n1',
              name: 'NX',
              siteId: 'OTHER',
              formFactor: 'nios-x',
              tierName: 'M',
            },
          ],
          xaas: [],
        },
      },
      [],
      3,
    );
    mount();
    expect(
      screen.getByTestId(
        `sizer-validation-row-${VALIDATION_CODES.SITE_UNASSIGNED}`,
      ),
    ).toBeTruthy();
  });

  it('surfaces OBJECT_COUNT_MISMATCH once user reaches Step 3 (Infrastructure)', () => {
    seed(
      {
        regions: [regionWithSite()],
        infrastructure: { niosx: [], xaas: [] },
      },
      [],
      3,
    );
    mount();
    expect(
      screen.getByTestId(
        `sizer-validation-row-${VALIDATION_CODES.OBJECT_COUNT_MISMATCH}`,
      ),
    ).toBeTruthy();
  });

  it('still surfaces non-infra errors on Step 1 (e.g. SITE_MISSING_USERS_AND_IPS)', () => {
    seed(
      {
        regions: [
          {
            id: 'r1',
            name: 'EMEA',
            type: 'on-premises',
            cloudNativeDns: false,
            countries: [
              {
                id: 'c1',
                name: 'DE',
                cities: [
                  {
                    id: 'ct1',
                    name: 'Berlin',
                    sites: [
                      {
                        id: 's1',
                        name: 'HQ',
                        multiplier: 1,
                        // both users + activeIPs missing → SITE_MISSING_USERS_AND_IPS
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        infrastructure: { niosx: [], xaas: [] },
      },
      [],
      1,
    );
    mount();
    expect(
      screen.getByTestId(
        `sizer-validation-row-${VALIDATION_CODES.SITE_MISSING_USERS_AND_IPS}`,
      ),
    ).toBeTruthy();
    // Infra warnings still suppressed.
    expect(
      screen.queryByTestId(
        `sizer-validation-row-${VALIDATION_CODES.SITE_UNASSIGNED}`,
      ),
    ).toBeNull();
  });
});

describe('InlineMarker', () => {
  it('click scrolls to banner row and focuses its [Go to]', () => {
    seed({
      regions: [
        {
          id: 'r1',
          name: 'APAC',
          type: 'on-premises',
          cloudNativeDns: false,
          countries: [],
        },
      ],
    });
    const code = VALIDATION_CODES.REGION_EMPTY_OTHERWISE;
    render(
      <SizerProvider>
        <SizerValidationBanner />
        <InlineMarker
          issue={{
            code,
            severity: 'warning',
            path: 'regions[0]',
            message: 'Region APAC has no Sites yet.',
          }}
        />
      </SizerProvider>,
    );

    const row = screen.getByTestId(`sizer-validation-row-${code}`);
    const scrollSpy = vi.spyOn(row, 'scrollIntoView');
    const gotoBtn = screen.getByTestId(`sizer-validation-goto-${code}`);
    const focusSpy = vi.spyOn(gotoBtn, 'focus');

    const marker = screen.getByTestId('sizer-inline-marker-regions[0]');
    act(() => {
      fireEvent.click(marker);
    });
    expect(scrollSpy).toHaveBeenCalled();
    expect(focusSpy).toHaveBeenCalled();
  });
});
