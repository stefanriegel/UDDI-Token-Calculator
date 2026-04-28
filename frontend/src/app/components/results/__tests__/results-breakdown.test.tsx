/**
 * results-breakdown.test.tsx — unit tests for `<ResultsBreakdown/>`
 * (Phase 34 Plan 05).
 *
 * Locks REQ-01 (hierarchical Region/Country/City/Site table with per-level
 * token contribution) and REQ-05 (click-to-edit per-Site cells dispatching
 * via `onSiteEdit` callback). Pure presentation: props in / callbacks out;
 * never reaches into Sizer state.
 *
 * Behavior matrix from 34-05-PLAN <behavior>:
 *   1. Tree renders Region root with all expanded leaf-site rows when expanded.
 *   2. Regions expanded by default; Cities collapsed by default (D-10).
 *   3. Token-contribution column on every level; aggregate-then-divide (D-11).
 *   4. Clicking activeIPs cell on a Site row swaps to <input> auto-focused.
 *   5. Pressing Enter with valid value → onSiteEdit({siteId, patch:{activeIPs}}).
 *   6. Pressing Esc cancels — no callback fired, read mode restored.
 *   7. Invalid input blocks dispatch + shows validation error styling/copy.
 *   8. Opening a second edit cell auto-cancels the first (one-cell-at-a-time).
 *   9. Blur outside cell while in edit mode = cancel (no dispatch).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  ResultsBreakdown,
  type ResultsBreakdownProps,
} from '../results-breakdown';
import type { Region, Site } from '../../sizer/sizer-types';

// ─── Fixture helpers ─────────────────────────────────────────────────────────

let nextId = 0;
function id(prefix: string): string {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

function site(over: Partial<Site> = {}): Site {
  return {
    id: id('site'),
    name: 'HQ',
    multiplier: 1,
    activeIPs: 100,
    users: 50,
    qps: 200,
    lps: 20,
    ...over,
  };
}

function regionWithSites(
  regionName: string,
  countryName: string,
  cityName: string,
  sites: Site[],
): Region {
  return {
    id: id('region'),
    name: regionName,
    type: 'on-premises',
    cloudNativeDns: false,
    countries: [
      {
        id: id('country'),
        name: countryName,
        cities: [
          {
            id: id('city'),
            name: cityName,
            sites,
          },
        ],
      },
    ],
  };
}

const baseDivisors = {
  tokensPerActiveIP: 13,
  tokensPerUser: 25, // arbitrary for the tests; only ratio matters
  tokensPerQps: 100,
  tokensPerLps: 100,
};

function makeProps(
  over: Partial<ResultsBreakdownProps> = {},
): ResultsBreakdownProps {
  return {
    mode: 'sizer',
    regions: [],
    onSiteEdit: () => {},
    ...baseDivisors,
    ...over,
  };
}

describe('<ResultsBreakdown/>', () => {
  it('renders Region root + all 3 Site leaf rows by default (D-10 revised)', async () => {
    const user = userEvent.setup();
    const sites = [
      site({ name: 'Site A', activeIPs: 130 }),
      site({ name: 'Site B', activeIPs: 260 }),
      site({ name: 'Site C', activeIPs: 390 }),
    ];
    const region = regionWithSites('NA', 'US', 'NYC', sites);

    render(<ResultsBreakdown {...makeProps({ regions: [region] })} />);

    // Region row visible by default.
    expect(screen.getByText('NA')).toBeInTheDocument();

    // Issue #15: Sites are visible by default — site names must surface
    // without an extra click (sizer auto-creates `(Unassigned)` placeholders
    // and hiding sites left users with only those placeholder labels).
    expect(screen.getByText('Site A')).toBeInTheDocument();
    expect(screen.getByText('Site B')).toBeInTheDocument();
    expect(screen.getByText('Site C')).toBeInTheDocument();

    // Cities can still be collapsed on demand — clicking the toggle hides
    // the Site rows again.
    const cityToggle = screen.getByRole('button', { name: /toggle nyc/i });
    await user.click(cityToggle);
    expect(screen.queryByText('Site A')).not.toBeInTheDocument();
  });

  it('skips `(Unassigned)` Country/City placeholder rows in the rendered hierarchy (issue #16)', () => {
    // D-09 auto-creates `(Unassigned)` Country + City when a Site is added
    // directly under a Region. The breakdown report must not surface those
    // placeholder rows — Sites should appear directly under the Region.
    const region = regionWithSites('Europe Core', '(Unassigned)', '(Unassigned)', [
      site({ name: 'Berlin HQ', activeIPs: 3750 }),
      site({ name: 'Berlin Branch', activeIPs: 1200 }),
    ]);

    render(<ResultsBreakdown {...makeProps({ regions: [region] })} />);

    expect(screen.getByText('Europe Core')).toBeInTheDocument();
    expect(screen.getByText('Berlin HQ')).toBeInTheDocument();
    expect(screen.getByText('Berlin Branch')).toBeInTheDocument();
    // Phantom containers must not render their own rows.
    expect(screen.queryByText('(Unassigned)')).not.toBeInTheDocument();
    // No toggle button for the suppressed placeholders.
    expect(
      screen.queryByRole('button', { name: /toggle \(unassigned\)/i }),
    ).not.toBeInTheDocument();
  });

  it('renames default `New Region` to `Region {n}` in the rendered hierarchy (issue #16)', () => {
    // Wizard adds Regions with default name "New Region". Users may forget
    // to rename them; the report shouldn't surface the placeholder label.
    const r1 = regionWithSites('Europe Core', 'DE', 'BER', [site({ name: 'A' })]);
    const r2 = regionWithSites('New Region', 'US', 'DAL', [site({ name: 'B' })]);

    render(<ResultsBreakdown {...makeProps({ regions: [r1, r2] })} />);

    expect(screen.getByText('Europe Core')).toBeInTheDocument();
    expect(screen.queryByText('New Region')).not.toBeInTheDocument();
    expect(screen.getByText('Region 2')).toBeInTheDocument();
  });

  it('Regions, Countries and Cities all expanded by default (D-10 revised, issue #15)', () => {
    const region = regionWithSites('NA', 'US', 'NYC', [site({ name: 'OnlySite' })]);

    render(<ResultsBreakdown {...makeProps({ regions: [region] })} />);

    expect(screen.getByText('US')).toBeInTheDocument();
    expect(screen.getByText('NYC')).toBeInTheDocument();
    // Issue #15: Site name must be visible without expanding the City.
    expect(screen.getByText('OnlySite')).toBeInTheDocument();
  });

  it('renders token-contribution column on every level using aggregate-then-divide (D-11)', () => {
    // 3 sites, activeIPs = 100 / 200 / 300 (sum 600). Divisor = 13.
    // Aggregate-then-divide: ceil(600 / 13) = 47.
    // Sum-of-pre-divided would be ceil(100/13)+ceil(200/13)+ceil(300/13)
    //   = 8 + 16 + 24 = 48. The roll-up MUST equal 47, NOT 48.
    const sites = [
      site({ name: 'S1', activeIPs: 100, users: 0, qps: 0, lps: 0 }),
      site({ name: 'S2', activeIPs: 200, users: 0, qps: 0, lps: 0 }),
      site({ name: 'S3', activeIPs: 300, users: 0, qps: 0, lps: 0 }),
    ];
    const region = regionWithSites('EMEA', 'DE', 'BER', sites);

    render(
      <ResultsBreakdown
        {...makeProps({
          regions: [region],
          tokensPerActiveIP: 13,
          tokensPerUser: 1,
          tokensPerQps: 1,
          tokensPerLps: 1,
        })}
      />,
    );

    // Region row exposes its roll-up token total via data-testid for stability.
    const regionRow = screen.getByTestId(`breakdown-row-${region.id}`);
    const regionTokens = within(regionRow).getByTestId('breakdown-tokens');
    expect(regionTokens).toHaveTextContent('47');
    expect(regionTokens).not.toHaveTextContent('48');
  });

  it('clicking the activeIPs cell on a Site row swaps to <input type="number"> auto-focused', async () => {
    const user = userEvent.setup();
    const target = site({ name: 'Editable', activeIPs: 123 });
    const region = regionWithSites('NA', 'US', 'NYC', [target]);

    render(<ResultsBreakdown {...makeProps({ regions: [region] })} />);

    // Click the activeIPs cell of the editable Site.
    const cell = screen.getByTestId(`breakdown-cell-${target.id}-activeIPs`);
    await user.click(cell);

    const input = within(cell).getByRole('spinbutton') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.type).toBe('number');
    expect(input).toHaveFocus();
    // Existing value is the input's current value.
    expect(input.value).toBe('123');
  });

  it('Enter with valid value calls onSiteEdit({siteId, patch:{activeIPs:N}})', async () => {
    const user = userEvent.setup();
    const onSiteEdit = vi.fn();
    const target = site({ name: 'Editable', activeIPs: 100 });
    const region = regionWithSites('NA', 'US', 'NYC', [target]);

    render(
      <ResultsBreakdown {...makeProps({ regions: [region], onSiteEdit })} />,
    );

    const cell = screen.getByTestId(`breakdown-cell-${target.id}-activeIPs`);
    await user.click(cell);

    const input = within(cell).getByRole('spinbutton') as HTMLInputElement;
    // Replace selection (autoselect) with new value.
    await user.keyboard('250{Enter}');

    expect(onSiteEdit).toHaveBeenCalledTimes(1);
    expect(onSiteEdit).toHaveBeenCalledWith(target.id, { activeIPs: 250 });
  });

  it('Esc cancels edit — no callback, read mode restored', async () => {
    const user = userEvent.setup();
    const onSiteEdit = vi.fn();
    const target = site({ name: 'Editable', activeIPs: 100 });
    const region = regionWithSites('NA', 'US', 'NYC', [target]);

    render(
      <ResultsBreakdown {...makeProps({ regions: [region], onSiteEdit })} />,
    );

    const cell = screen.getByTestId(`breakdown-cell-${target.id}-activeIPs`);
    await user.click(cell);
    await user.keyboard('999{Escape}');

    expect(onSiteEdit).not.toHaveBeenCalled();
    // Read mode restored — input no longer in DOM.
    expect(within(cell).queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('invalid input blocks dispatch and shows validation error', async () => {
    const user = userEvent.setup();
    const onSiteEdit = vi.fn();
    const target = site({ name: 'Editable', activeIPs: 100 });
    const region = regionWithSites('NA', 'US', 'NYC', [target]);

    render(
      <ResultsBreakdown {...makeProps({ regions: [region], onSiteEdit })} />,
    );

    const cell = screen.getByTestId(`breakdown-cell-${target.id}-activeIPs`);
    await user.click(cell);
    // Clear existing value, leave it empty (invalid per UI-SPEC).
    const input = within(cell).getByRole('spinbutton') as HTMLInputElement;
    await user.clear(input);
    await user.keyboard('{Enter}');

    expect(onSiteEdit).not.toHaveBeenCalled();
    // Helper text from UI-SPEC Copywriting visible.
    expect(
      within(cell).getByText('Must be a non-negative whole number.'),
    ).toBeInTheDocument();
    // Still in edit mode for correction.
    expect(within(cell).getByRole('spinbutton')).toBeInTheDocument();
  });

  it('opening a second edit cell auto-cancels the first (one-cell-at-a-time)', async () => {
    const user = userEvent.setup();
    const onSiteEdit = vi.fn();
    const target = site({ name: 'Editable', activeIPs: 100, qps: 200 });
    const region = regionWithSites('NA', 'US', 'NYC', [target]);

    render(
      <ResultsBreakdown {...makeProps({ regions: [region], onSiteEdit })} />,
    );

    const ipCell = screen.getByTestId(`breakdown-cell-${target.id}-activeIPs`);
    const qpsCell = screen.getByTestId(`breakdown-cell-${target.id}-qps`);

    await user.click(ipCell);
    expect(within(ipCell).getByRole('spinbutton')).toBeInTheDocument();

    // Opening qps cell auto-cancels activeIPs edit.
    await user.click(qpsCell);

    expect(within(ipCell).queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(within(qpsCell).getByRole('spinbutton')).toBeInTheDocument();
    expect(onSiteEdit).not.toHaveBeenCalled();
  });

  it('blur outside the cell while editing cancels (no dispatch)', async () => {
    const user = userEvent.setup();
    const onSiteEdit = vi.fn();
    const target = site({ name: 'Editable', activeIPs: 100 });
    const region = regionWithSites('NA', 'US', 'NYC', [target]);

    render(
      <>
        <ResultsBreakdown {...makeProps({ regions: [region], onSiteEdit })} />
        <button type="button" data-testid="outside">
          outside
        </button>
      </>,
    );

    const cell = screen.getByTestId(`breakdown-cell-${target.id}-activeIPs`);
    await user.click(cell);
    expect(within(cell).getByRole('spinbutton')).toBeInTheDocument();

    // Blur by clicking an outside element — keep the change buffered, the
    // component must NOT silently persist it.
    await user.click(screen.getByTestId('outside'));

    expect(onSiteEdit).not.toHaveBeenCalled();
    expect(within(cell).queryByRole('spinbutton')).not.toBeInTheDocument();
  });
});
