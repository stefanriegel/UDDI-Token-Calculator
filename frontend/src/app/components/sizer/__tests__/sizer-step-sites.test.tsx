/**
 * sizer-step-sites.test.tsx — Step 2 (Sites) component tests.
 *
 * Covers plan 30-04 Task 2 done criteria:
 *   1. Default mode is Users-driven when users is set.
 *   2. Editing Users debounces 150ms, then populates derived fields.
 *   3. DerivedBadge present for each derived field initially.
 *   4. Overriding `qps` hides that field's DerivedBadge.
 *   5. Pitfall 8 regression: after overriding qps, changing users and
 *      advancing timers leaves qps unchanged while other fields update.
 *   6. Switching to Manual mode hides Users input and all DerivedBadges.
 *   7. Clone ×3 popover creates `{name} (2)`, `{name} (3)`, `{name} (4)`.
 *   8. Live preview strip reflects current derived values.
 *   9. Multiplier chip dispatches UPDATE_SITE when edited.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SizerProvider, STORAGE_KEY, initialSizerState, type SizerFullState } from '../sizer-state';
import { SizerStepSites } from '../sizer-step-sites';

function clearStorage() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Build a seed state with one Region, one Country, one City, one Site (users=500).
 * Writes to sessionStorage so <SizerProvider> hydrates from it.
 */
function seedOneSite(overrides: Partial<Record<string, unknown>> = {}) {
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
                      ...overrides,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    ui: {
      ...base.ui,
      selectedPath: 'site:site-1',
    },
  };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function mount() {
  return render(
    <SizerProvider>
      <SizerStepSites />
    </SizerProvider>,
  );
}

describe('<SizerStepSites/>', () => {
  beforeEach(() => {
    clearStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the selected site form with Users-driven as the default mode', () => {
    seedOneSite();
    mount();
    const modeToggle = screen.getByTestId('sizer-site-mode-toggle');
    const usersTab = within(modeToggle).getByTestId('sizer-site-mode-users');
    expect(usersTab.getAttribute('data-state')).toBe('active');
    expect(screen.getByTestId('sizer-site-users')).toBeInTheDocument();
  });

  it('shows DerivedBadges for each derived field initially', () => {
    seedOneSite();
    mount();
    for (const key of [
      'activeIPs',
      'qps',
      'dnsZones',
      'networksPerSite',
      'assets',
      'verifiedAssets',
      'unverifiedAssets',
    ]) {
      // verifiedAssets / unverifiedAssets don't have override keys so they
      // don't show the badge — they are derived-only. Assert the inputs exist.
      expect(screen.getByTestId(`sizer-site-derived-${key}`)).toBeInTheDocument();
    }
    // Badges are only attached to overridable fields:
    for (const key of ['activeIPs', 'qps', 'dnsZones', 'networksPerSite', 'assets']) {
      expect(screen.getByTestId(`sizer-site-derived-${key}-badge`)).toBeInTheDocument();
    }
  });

  it('editing Users debounces 150ms then populates derived fields', () => {
    vi.useFakeTimers();
    // Seed users=1; typical starting state needs mode=users, which is default
    // whenever users != null.
    seedOneSite({ users: 1, qps: undefined, activeIPs: undefined });
    mount();
    const usersInput = screen.getByTestId('sizer-site-users') as HTMLInputElement;
    act(() => {
      fireEvent.change(usersInput, { target: { value: '500' } });
    });
    // Before debounce fires: qps input is still blank.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const qps = (screen.getByTestId('sizer-site-derived-qps') as HTMLInputElement).value;
    // users=500, qpsPerUser=3.2 → ceil(1600)=1600
    expect(qps).toBe('1600');
  });

  it('overriding qps removes the Derived badge for that field', async () => {
    seedOneSite();
    const user = userEvent.setup();
    mount();
    expect(screen.getByTestId('sizer-site-derived-qps-badge')).toBeInTheDocument();
    const qpsInput = screen.getByTestId('sizer-site-derived-qps') as HTMLInputElement;
    await user.clear(qpsInput);
    await user.type(qpsInput, '9999');
    expect(screen.queryByTestId('sizer-site-derived-qps-badge')).toBeNull();
  });

  it('Pitfall 8: after overriding qps, changing Users does not clobber qps but updates other fields', () => {
    vi.useFakeTimers();
    seedOneSite();
    mount();
    // Let the initial debounced derive fire so baseline fields exist.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    // Override qps — fireEvent.change so the keystroke doesn't stack with
    // userEvent + fake timers (which deadlocks).
    const qpsInput = screen.getByTestId('sizer-site-derived-qps') as HTMLInputElement;
    act(() => {
      fireEvent.change(qpsInput, { target: { value: '9999' } });
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect((screen.getByTestId('sizer-site-derived-qps') as HTMLInputElement).value).toBe('9999');

    // Change users 500 → 2000. activeIPs updates, qps stays pinned at 9999.
    const usersInput = screen.getByTestId('sizer-site-users') as HTMLInputElement;
    act(() => {
      fireEvent.change(usersInput, { target: { value: '2000' } });
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect((screen.getByTestId('sizer-site-derived-qps') as HTMLInputElement).value).toBe('9999');
    // activeIPs = ceil(2000 * 1.5) = 3000
    expect((screen.getByTestId('sizer-site-derived-activeIPs') as HTMLInputElement).value).toBe('3000');
  });

  it('switching to Manual mode hides Users input and all Derived badges', async () => {
    seedOneSite();
    const user = userEvent.setup();
    mount();
    expect(screen.getByTestId('sizer-site-users')).toBeInTheDocument();
    expect(screen.getByTestId('sizer-site-derived-qps-badge')).toBeInTheDocument();

    await user.click(screen.getByTestId('sizer-site-mode-manual'));

    expect(screen.queryByTestId('sizer-site-users')).toBeNull();
    for (const key of ['activeIPs', 'qps', 'dnsZones', 'networksPerSite', 'assets']) {
      expect(screen.queryByTestId(`sizer-site-derived-${key}-badge`)).toBeNull();
    }
    // All fields still editable.
    const qpsInput = screen.getByTestId('sizer-site-derived-qps') as HTMLInputElement;
    await user.clear(qpsInput);
    await user.type(qpsInput, '42');
    expect(qpsInput.value).toBe('42');
  });

  it('Clone ×3 creates three new sites named "HQ (2)" "HQ (3)" "HQ (4)"', async () => {
    seedOneSite();
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId('sizer-site-clone-trigger'));
    const countInput = await screen.findByTestId('sizer-site-clone-count') as HTMLInputElement;
    await user.clear(countInput);
    await user.type(countInput, '3');
    await user.click(screen.getByTestId('sizer-site-clone-submit'));

    const list = screen.getByTestId('sizer-sites-list');
    expect(within(list).getByText('HQ (2)')).toBeInTheDocument();
    expect(within(list).getByText('HQ (3)')).toBeInTheDocument();
    expect(within(list).getByText('HQ (4)')).toBeInTheDocument();
  });

  it('live preview strip shows derived values after debounced derive', async () => {
    vi.useFakeTimers();
    seedOneSite();
    mount();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const qpsCell = screen.getByTestId('sizer-site-preview-qps');
    // users=500 → qps=ceil(500*3.2)=1600
    expect(qpsCell.textContent).toBe('1,600');
    const ipsCell = screen.getByTestId('sizer-site-preview-ips');
    // users=500 → activeIPs=ceil(500*1.5)=750
    expect(ipsCell.textContent).toBe('750');
  });

  it('multiplier input dispatches UPDATE_SITE on edit', () => {
    seedOneSite();
    mount();
    const mult = screen.getByTestId('sizer-site-multiplier') as HTMLInputElement;
    act(() => {
      fireEvent.change(mult, { target: { value: '5' } });
    });
    expect(mult.value).toBe('5');
  });

  it('issue #31: hides (Unassigned) Country/City segments under quick-added Site', () => {
    // Quick-add Region → Site path: ADD_SITE with parentRegionId auto-creates
    // (Unassigned) Country + City. The Sites step list must not surface that
    // placeholder hierarchy as "(Unassigned) › (Unassigned)".
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
                name: '(Unassigned)',
                cities: [
                  {
                    id: 'city-1',
                    name: '(Unassigned)',
                    sites: [
                      { id: 'site-1', name: 'Site 1', multiplier: 1, users: 100 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      ui: { ...base.ui, selectedPath: 'site:site-1' },
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    mount();
    const list = screen.getByTestId('sizer-sites-list');
    expect(within(list).queryByText(/Unassigned/)).toBeNull();
    expect(within(list).queryByText(/›/)).toBeNull();
  });

  it('issue #31: keeps real Country/City names when present', () => {
    seedOneSite(); // Germany › Berlin
    mount();
    const list = screen.getByTestId('sizer-sites-list');
    expect(within(list).getByText('Germany')).toBeInTheDocument();
    expect(within(list).getByText('Berlin')).toBeInTheDocument();
  });
});
