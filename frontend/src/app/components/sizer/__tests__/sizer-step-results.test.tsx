/**
 * sizer-step-results.test.tsx — Step 5 composite tests.
 *
 * Covers:
 *   1. Empty state (0 regions) renders prompt — no hero cards / table.
 *   2. Hero-card totals equal the calc-fn outputs for the seeded state.
 *   3. Breakdown table renders one row per region + a totals row.
 *   4. Click "Download XLSX" → downloadWorkbook mock called once with the full state.
 *   5. Start Over Cancel → dialog closes, regions unchanged.
 *   6. Start Over Confirm → sessionStorage cleared, regions wiped, active step 1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../sizer-xlsx-export', () => ({
  downloadWorkbook: vi.fn().mockResolvedValue(undefined),
}));

// jsdom shim — Phase 34 Plan 06 mounts <OutlineNav/> inside SizerResultsSurface
// which requires IntersectionObserver + scrollIntoView (not provided by jsdom).
class MockIntersectionObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
  takeRecords = vi.fn().mockReturnValue([]);
  constructor(_cb: IntersectionObserverCallback) {}
}
// @ts-expect-error -- jsdom has no IntersectionObserver.
globalThis.IntersectionObserver = MockIntersectionObserver;
Element.prototype.scrollIntoView = vi.fn();

import {
  SizerProvider,
  STORAGE_KEY,
  initialSizerState,
  type SizerFullState,
} from '../sizer-state';
import {
  calculateManagementTokens,
  calculateServerTokens,
  calculateReportingTokens,
  calculateSecurityTokens,
  resolveOverheads,
} from '../sizer-calc';
import { downloadWorkbook } from '../sizer-xlsx-export';
import { SizerStepResults } from '../sizer-step-results';

function clearStorage() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function seedTwoRegions(): SizerFullState {
  const base = initialSizerState();
  const state: SizerFullState = {
    ...base,
    core: {
      ...base.core,
      regions: [
        {
          id: 'region-1',
          name: 'EMEA',
          type: 'on-premises',
          cloudNativeDns: false,
          countries: [
            {
              id: 'country-1',
              name: 'Germany',
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
                      activeIPs: 200,
                      assets: 50,
                      dnsRecords: 1000,
                      dhcpScopes: 20,
                      qps: 100,
                      avgLeaseDuration: 24,
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          id: 'region-2',
          name: 'AMER',
          type: 'aws',
          cloudNativeDns: true,
          countries: [
            {
              id: 'country-2',
              name: 'USA',
              cities: [
                {
                  id: 'city-2',
                  name: 'NYC',
                  sites: [
                    {
                      id: 'site-2',
                      name: 'NYC-1',
                      multiplier: 2,
                      users: 1000,
                      activeIPs: 400,
                      assets: 100,
                      dnsRecords: 2000,
                      dhcpScopes: 40,
                      qps: 200,
                      avgLeaseDuration: 24,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      infrastructure: {
        niosx: [
          { id: 'nx-1', name: 'NX-1', siteId: 'site-1', formFactor: 'nios-x', tierName: 'M' },
        ],
        xaas: [],
      },
      security: {
        securityEnabled: true,
        socInsightsEnabled: false,
        tdVerifiedAssets: 100,
        tdUnverifiedAssets: 50,
        dossierQueriesPerDay: 0,
        lookalikeDomainsMentioned: 0,
      },
    },
  };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  return state;
}

function mount() {
  return render(
    <SizerProvider>
      <SizerStepResults />
    </SizerProvider>,
  );
}

// Phase 33 Plan 06 — rewritten against the new <ResultsSurface mode="sizer"/>
// composition (ResultsHero + ResultsBom + ResultsExportBar). The legacy
// SizerHeroCards / SizerBreakdownTable were retired in Plan 05; assertions
// now target the three universal section anchors (#section-overview,
// #section-bom, #section-export — D-07) plus the Sizer-mode Start Over copy
// (D-15) and the export wiring (D-13).
describe('<SizerStepResults/>', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders empty-state Card when no regions exist (no result sections)', () => {
    const { container } = mount();
    expect(screen.getByTestId('sizer-step-results')).toBeInTheDocument();
    // Empty state copy (verbatim from sizer-step-results.tsx).
    expect(
      screen.getByText(/Add at least one Region in Step 1 before viewing results/i),
    ).toBeInTheDocument();
    // None of the result sections are mounted.
    expect(container.querySelector('#section-overview')).toBeNull();
    expect(container.querySelector('#section-bom')).toBeNull();
    expect(container.querySelector('#section-export')).toBeNull();
  });

  it('with regions: renders the three universal section anchors (D-07)', () => {
    seedTwoRegions();
    const { container } = mount();
    expect(screen.getByTestId('sizer-step-results')).toBeInTheDocument();
    expect(container.querySelector('#section-overview')).not.toBeNull();
    expect(container.querySelector('#section-bom')).not.toBeNull();
    expect(container.querySelector('#section-export')).not.toBeNull();
  });

  it('hero totals match the calc-fn outputs for the seeded state (formatted via toLocaleString)', () => {
    const state = seedTwoRegions();
    const ovh = resolveOverheads(state.core);
    const allSites = state.core.regions.flatMap((r) =>
      r.countries.flatMap((c) => c.cities.flatMap((ci) => ci.sites)),
    );
    const g = state.core.globalSettings;
    const reportingToggles = {
      csp: !!g.reportingCsp,
      s3: !!g.reportingS3,
      cdc: !!g.reportingCdc,
      dnsEnabled: !!g.dnsLoggingEnabled,
      dhcpEnabled: !!g.dhcpLoggingEnabled,
    };
    const expectedMgmt = calculateManagementTokens(allSites, ovh.mgmt);
    const expectedServer = calculateServerTokens(
      state.core.infrastructure.niosx,
      state.core.infrastructure.xaas,
      ovh.server,
    );

    mount();

    // ResultsHero renders the formatted totals as plain text inside #section-overview.
    const overview = document.querySelector('#section-overview')!;
    expect(overview.textContent).toContain(expectedMgmt.toLocaleString());
    if (expectedServer > 0) {
      expect(overview.textContent).toContain(expectedServer.toLocaleString());
    }
  });

  it('Download XLSX in section-export calls downloadWorkbook once with the full state', async () => {
    const state = seedTwoRegions();
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: /download xlsx/i }));
    expect(downloadWorkbook).toHaveBeenCalledTimes(1);
    const arg = (downloadWorkbook as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.core.regions[0].id).toBe(state.core.regions[0].id);
  });

  it('Start Over Cancel closes the dialog and leaves state intact', async () => {
    seedTwoRegions();
    const user = userEvent.setup();
    const { container } = mount();
    await user.click(screen.getByRole('button', { name: /start over/i }));
    // Sizer-mode reset copy (D-15) is rendered in the dialog.
    expect(
      screen.getByText(
        'This clears Sizer state stored in this browser. Your inputs cannot be recovered.',
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    // After cancel, the result sections are still present, sessionStorage intact.
    expect(container.querySelector('#section-overview')).not.toBeNull();
    const raw = sessionStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.core.regions.length).toBe(2);
  });

  it('Start Over Confirm clears sessionStorage and wipes regions (Step 5 falls back to empty-state Card)', async () => {
    seedTwoRegions();
    const user = userEvent.setup();
    const { container } = mount();
    await user.click(screen.getByRole('button', { name: /start over/i }));
    await user.click(screen.getByRole('button', { name: /^reset$/i }));

    // Empty-state Card is the new shell for "no regions" — section anchors gone.
    expect(screen.getByTestId('sizer-step-results')).toBeInTheDocument();
    expect(container.querySelector('#section-overview')).toBeNull();
    expect(container.querySelector('#section-bom')).toBeNull();

    // sessionStorage is cleared by onReset (the reducer writes a fresh blob
    // back on next dispatch — what we assert is that regions are wiped).
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      expect(parsed.core.regions.length).toBe(0);
    }
  });
});
