/**
 * sizer-step-infra.test.tsx — Step 3 Infrastructure Placement tests.
 *
 * Covers plan 30-05 Task 2 done criteria:
 *   - Tabs switch between NIOS-X Systems and XaaS Service Points
 *   - "+ Add NIOS-X" dispatches ADD_NIOSX → row appears
 *   - NIOS-X row's site combobox selects a site → UPDATE_NIOSX
 *   - "+ Add Service Point" under a Region dispatches ADD_XAAS(regionId) → card appears
 *   - XaaS tier S (maxConn 10) + connections 25 → inline warning Alert with correct copy
 *   - XaaS tier XL (maxConn 85) + connections 25 → no Alert
 *   - XaaS sites multi-select trigger shows "{n} sites"
 *   - XaaS cards grouped under correct Region headers
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SizerProvider, STORAGE_KEY, useSizer } from '../sizer-state';
import { SizerStepInfra } from '../sizer-step-infra';
import { UNASSIGNED_PLACEHOLDER } from '../sizer-types';

function clearStorage() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Test harness that seeds the reducer with two regions (each containing one
 * site) BEFORE rendering <SizerStepInfra/>, so tests don't need to drive the
 * tree UI to set up fixtures.
 */
function Seeder({ children }: { children: ReactNode }) {
  const { state, dispatch } = useSizer();
  // Seed only once
  if (state.core.regions.length === 0) {
    dispatch({ type: 'HYDRATE', state: {
      core: {
        regions: [
          {
            id: 'r-eu',
            name: 'EU',
            type: 'on-premises',
            cloudNativeDns: false,
            countries: [
              {
                id: 'c-de',
                name: 'DE',
                cities: [
                  {
                    id: 'ct-berlin',
                    name: 'Berlin',
                    sites: [{ id: 's-a', name: 'Site-A', multiplier: 1, users: 500 }],
                  },
                ],
              },
            ],
          },
          {
            id: 'r-na',
            name: 'NA',
            type: 'on-premises',
            cloudNativeDns: false,
            countries: [
              {
                id: 'c-un',
                name: UNASSIGNED_PLACEHOLDER,
                cities: [
                  {
                    id: 'ct-un',
                    name: UNASSIGNED_PLACEHOLDER,
                    sites: [{ id: 's-hq', name: 'HQ', multiplier: 1, users: 1000 }],
                  },
                ],
              },
            ],
          },
        ],
        globalSettings: { growthBuffer: 0.2, growthBufferAdvanced: false },
        security: {
          securityEnabled: false,
          socInsightsEnabled: false,
          tdVerifiedAssets: 0,
          tdUnverifiedAssets: 0,
          dossierQueriesPerDay: 0,
          lookalikeDomainsMentioned: 0,
        },
        infrastructure: { niosx: [], xaas: [] },
      },
      ui: {
        activeStep: 3,
        selectedPath: null,
        siteMode: {},
        siteOverrides: {},
        expandedNodes: {},
        dismissedCodes: [],
        sectionsOpen: { modules: true, growth: true, security: true },
        growthBufferAdvanced: false,
        securityAutoFilled: { tdVerifiedAssets: false, tdUnverifiedAssets: false },
        _v: 1,
      },
    } });
  }
  return <>{children}</>;
}

function mount() {
  return render(
    <SizerProvider>
      <Seeder>
        <SizerStepInfra />
      </Seeder>
    </SizerProvider>,
  );
}

describe('<SizerStepInfra/>', () => {
  beforeEach(() => clearStorage());

  it('renders tabs and switches between NIOS-X and XaaS panels', async () => {
    const user = userEvent.setup();
    mount();
    // Default tab = NIOS-X
    expect(screen.getByTestId('sizer-niosx-table')).toBeInTheDocument();
    expect(screen.queryByTestId('sizer-xaas-region-group-r-eu')).not.toBeInTheDocument();
    // Switch to XaaS tab
    await user.click(screen.getByRole('tab', { name: /xaas service points/i }));
    expect(screen.getByTestId('sizer-xaas-region-group-r-eu')).toBeInTheDocument();
    expect(screen.getByTestId('sizer-xaas-region-group-r-na')).toBeInTheDocument();
    // Switch back
    await user.click(screen.getByRole('tab', { name: /nios-x systems/i }));
    expect(screen.getByTestId('sizer-niosx-table')).toBeInTheDocument();
  });

  it('"+ Add NIOS-X" dispatches ADD_NIOSX → a new row appears in the table', async () => {
    const user = userEvent.setup();
    mount();
    // Initially empty table body
    const table = screen.getByTestId('sizer-niosx-table');
    expect(within(table).queryAllByRole('row').length).toBe(1); // header row only
    await user.click(screen.getByTestId('sizer-niosx-add'));
    // A data row now exists.
    const rows = within(table).getAllByRole('row');
    expect(rows.length).toBe(2); // header + 1 data row
  });

  it('NIOS-X row site combobox selects a site → UPDATE_NIOSX populates siteId', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId('sizer-niosx-add'));
    // Open the site combobox in the new row.
    const trigger = screen.getByRole('combobox', { name: /select site/i });
    await user.click(trigger);
    await user.click(screen.getByTestId('sizer-site-combobox-option-s-a'));
    // Trigger label now shows Site-A's path
    const triggerAfter = screen.getByRole('combobox', { name: /select site/i });
    expect(triggerAfter.textContent).toContain('Site-A');
  });

  it('"+ Add Service Point" under a Region dispatches ADD_XAAS(regionId) → card appears', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('tab', { name: /xaas service points/i }));
    // Use the add button scoped to EU region
    await user.click(screen.getByTestId('sizer-xaas-add-r-eu'));
    const euGroup = screen.getByTestId('sizer-xaas-region-group-r-eu');
    // A card rendered under the EU group.
    expect(within(euGroup).getAllByTestId(/^sizer-xaas-card-/).length).toBe(1);
  });

  it('XaaS tier S (maxConn 10) with 25 connections shows inline warning Alert with correct copy', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('tab', { name: /xaas service points/i }));
    await user.click(screen.getByTestId('sizer-xaas-add-r-eu'));
    // Find the card + its id
    const card = screen.getByTestId(/^sizer-xaas-card-/);
    const cardId = card.getAttribute('data-testid')!.replace('sizer-xaas-card-', '');
    // Set tier to S via Radix Select — we directly dispatch-equivalent by interacting.
    // The connections input carries a stable test-id.
    const connInput = screen.getByTestId(`sizer-xaas-connections-${cardId}`) as HTMLInputElement;
    // Default tier from reducer is 'M'. Switch to 'S' first.
    const tierTrigger = screen.getByTestId(`sizer-xaas-tier-${cardId}`);
    await user.click(tierTrigger);
    // Select the 'S' option
    const sOption = await screen.findByRole('option', { name: /^S$/ });
    await user.click(sOption);
    // Set connections to 25
    await user.clear(connInput);
    await user.type(connInput, '25');
    // Inline warning Alert present with correct copy
    const warning = screen.getByTestId(`sizer-xaas-warning-${cardId}`);
    expect(warning).toBeInTheDocument();
    expect(warning.textContent).toMatch(/XaaS tier 'S'/);
    expect(warning.textContent).toMatch(/maxes at 10 connections/);
    expect(warning.textContent).toMatch(/has 25/);
    // 15 extra × 100 tokens = 1500 extra connection tokens
    expect(warning.textContent).toMatch(/\+1500 connection tokens/);
  });

  it('XaaS tier XL (maxConn 85) with 25 connections shows NO warning Alert', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('tab', { name: /xaas service points/i }));
    await user.click(screen.getByTestId('sizer-xaas-add-r-eu'));
    const card = screen.getByTestId(/^sizer-xaas-card-/);
    const cardId = card.getAttribute('data-testid')!.replace('sizer-xaas-card-', '');
    // Switch tier to XL
    await user.click(screen.getByTestId(`sizer-xaas-tier-${cardId}`));
    const xlOption = await screen.findByRole('option', { name: /^XL$/ });
    await user.click(xlOption);
    const connInput = screen.getByTestId(`sizer-xaas-connections-${cardId}`) as HTMLInputElement;
    await user.clear(connInput);
    await user.type(connInput, '25');
    expect(screen.queryByTestId(`sizer-xaas-warning-${cardId}`)).not.toBeInTheDocument();
  });

  it('XaaS sites multi-select: picking 2 sites shows "2 sites" in the card trigger', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('tab', { name: /xaas service points/i }));
    await user.click(screen.getByTestId('sizer-xaas-add-r-eu'));
    const card = screen.getByTestId(/^sizer-xaas-card-/);
    const cardId = card.getAttribute('data-testid')!.replace('sizer-xaas-card-', '');
    const sitesWrapper = screen.getByTestId(`sizer-xaas-sites-${cardId}`);
    // Click the inner combobox button to open the popover
    const sitesCombobox = within(sitesWrapper).getByRole('combobox', { name: /select sites/i });
    await user.click(sitesCombobox);
    await user.click(screen.getByTestId('sizer-site-combobox-option-s-a'));
    await user.click(screen.getByTestId('sizer-site-combobox-option-s-hq'));
    // Inner combobox trigger now shows "2 sites"
    const sitesComboboxAfter = within(sitesWrapper).getByRole('combobox', { name: /select sites/i });
    expect(sitesComboboxAfter.textContent).toMatch(/2 sites/);
  });

  it('XaaS cards render grouped under correct Region headers', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('tab', { name: /xaas service points/i }));
    // Add one card in EU, one in NA
    await user.click(screen.getByTestId('sizer-xaas-add-r-eu'));
    await user.click(screen.getByTestId('sizer-xaas-add-r-na'));
    const euGroup = screen.getByTestId('sizer-xaas-region-group-r-eu');
    const naGroup = screen.getByTestId('sizer-xaas-region-group-r-na');
    expect(within(euGroup).getAllByTestId(/^sizer-xaas-card-/).length).toBe(1);
    expect(within(naGroup).getAllByTestId(/^sizer-xaas-card-/).length).toBe(1);
    // EU header contains "EU" text
    expect(within(euGroup).getByText('EU')).toBeInTheDocument();
    expect(within(naGroup).getByText('NA')).toBeInTheDocument();
  });
});
