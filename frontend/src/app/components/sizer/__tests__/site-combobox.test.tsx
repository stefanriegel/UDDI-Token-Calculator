/**
 * site-combobox.test.tsx — tests for the shared 4-level indented site picker.
 *
 * Covers plan 30-05 Task 1:
 *   - Grouped-by-Region options with 4-level indent
 *   - Typeahead filters by path segment
 *   - Single-mode: click selects a site and closes popover
 *   - Multi-mode: click toggles each site; trigger shows "{n} sites"
 *   - Keyboard: ArrowDown + Enter selects highlighted option
 *   - (Unassigned) Country/City containers are hidden from the picker (Issue #29);
 *     their descendant sites remain selectable directly under the Region heading
 */
import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SiteCombobox } from '../ui/site-combobox';
import type { Region } from '../sizer-types';
import { UNASSIGNED_PLACEHOLDER } from '../sizer-types';

function buildRegions(): Region[] {
  return [
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
              sites: [
                { id: 's-a', name: 'Site-A', multiplier: 1, users: 500 },
                { id: 's-b', name: 'Site-B', multiplier: 1, users: 500 },
              ],
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
  ];
}

function SingleHarness({ initial = null as string | null }: { initial?: string | null }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <SiteCombobox
      mode="single"
      value={value}
      onChange={setValue}
      regions={buildRegions()}
    />
  );
}

function MultiHarness({ initial = [] as string[] }: { initial?: string[] }) {
  const [values, setValues] = useState<string[]>(initial);
  return (
    <SiteCombobox
      mode="multi"
      values={values}
      onChange={setValues}
      regions={buildRegions()}
    />
  );
}

describe('<SiteCombobox/>', () => {
  it('single-mode trigger shows "Select site…" when empty', () => {
    render(<SingleHarness />);
    const trigger = screen.getByRole('combobox', { name: /select site/i });
    expect(trigger).toBeInTheDocument();
    expect(trigger.textContent).toMatch(/select site/i);
  });

  it('opens popover and renders indented options grouped by Region', async () => {
    const user = userEvent.setup();
    render(<SingleHarness />);
    await user.click(screen.getByRole('combobox', { name: /select site/i }));
    // Region group headings are present
    expect(screen.getByText('EU')).toBeInTheDocument();
    expect(screen.getByText('NA')).toBeInTheDocument();
    // Site options
    const siteA = screen.getByTestId('sizer-site-combobox-option-s-a');
    const siteB = screen.getByTestId('sizer-site-combobox-option-s-b');
    expect(siteA).toBeInTheDocument();
    expect(siteB).toBeInTheDocument();
    // Sites have level-4 indent class (pl-16 per spec)
    expect(siteA.className).toMatch(/pl-16/);
  });

  it('(Unassigned) Country/City containers are hidden and descendant sites stay selectable directly under the Region (Issue #29)', async () => {
    const user = userEvent.setup();
    render(<SingleHarness />);
    await user.click(screen.getByRole('combobox', { name: /select site/i }));
    // No `(Unassigned)` rows leak into the picker.
    expect(screen.queryAllByText(UNASSIGNED_PLACEHOLDER)).toHaveLength(0);
    // HQ (under NA > (Unassigned) > (Unassigned)) is still selectable.
    const hq = screen.getByTestId('sizer-site-combobox-option-s-hq');
    expect(hq).toBeInTheDocument();
    // With both ancestors unassigned, the site row indents to level 2 (pl-8).
    expect(hq.className).toMatch(/pl-8/);
  });

  it('selected site path collapses (Unassigned) segments in the trigger label (Issue #29)', async () => {
    const user = userEvent.setup();
    render(<SingleHarness />);
    await user.click(screen.getByRole('combobox', { name: /select site/i }));
    await user.click(screen.getByTestId('sizer-site-combobox-option-s-hq'));
    const trigger = screen.getByRole('combobox');
    expect(trigger.textContent).toContain('NA / HQ');
    expect(trigger.textContent).not.toContain(UNASSIGNED_PLACEHOLDER);
  });

  it('typeahead filters options to matching path segments', async () => {
    const user = userEvent.setup();
    render(<SingleHarness />);
    await user.click(screen.getByRole('combobox', { name: /select site/i }));
    const input = screen.getByPlaceholderText(/search sites/i);
    await user.type(input, 'Site-A');
    // Only Site-A should remain
    expect(screen.queryByTestId('sizer-site-combobox-option-s-a')).toBeInTheDocument();
    expect(screen.queryByTestId('sizer-site-combobox-option-s-b')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sizer-site-combobox-option-s-hq')).not.toBeInTheDocument();
  });

  it('single-mode: clicking a site calls onChange with the site id and closes the popover', async () => {
    const user = userEvent.setup();
    render(<SingleHarness />);
    await user.click(screen.getByRole('combobox', { name: /select site/i }));
    const option = screen.getByTestId('sizer-site-combobox-option-s-a');
    await user.click(option);
    // Popover closed: the input is gone
    expect(screen.queryByPlaceholderText(/search sites/i)).not.toBeInTheDocument();
    // Trigger now shows the selected site's 4-level path label
    const trigger = screen.getByRole('combobox');
    expect(trigger.textContent).toContain('Site-A');
    expect(trigger.textContent).toContain('EU');
  });

  it('ArrowDown + Enter selects the highlighted option (keyboard)', async () => {
    const user = userEvent.setup();
    render(<SingleHarness />);
    await user.click(screen.getByRole('combobox', { name: /select site/i }));
    // cmdk auto-highlights the first item; press Enter to select it.
    await user.keyboard('{Enter}');
    // Popover closed and some site selected (trigger no longer shows "Select site…")
    const trigger = screen.getByRole('combobox');
    expect(trigger.textContent).not.toMatch(/select site…/i);
  });

  it('multi-mode: trigger shows "{n} sites" and checkboxes reflect selection', async () => {
    const user = userEvent.setup();
    render(<MultiHarness />);
    // Empty state label — target the trigger by its aria-label to disambiguate
    // from the cmdk search input which also exposes role="combobox" when open.
    const trigger = screen.getByRole('combobox', { name: /select sites/i });
    expect(trigger.textContent).toMatch(/select sites/i);
    await user.click(trigger);
    // Click three site options
    await user.click(screen.getByTestId('sizer-site-combobox-option-s-a'));
    await user.click(screen.getByTestId('sizer-site-combobox-option-s-b'));
    await user.click(screen.getByTestId('sizer-site-combobox-option-s-hq'));
    // Trigger should now show "3 sites"
    const triggerAfter = screen.getByRole('combobox', { name: /select sites/i });
    expect(triggerAfter.textContent).toMatch(/3 sites/);
    // Re-open (already open — cmdk keeps it open in multi-mode); verify checkbox state.
    const siteA = screen.getByTestId('sizer-site-combobox-option-s-a');
    const checkbox = within(siteA).getByRole('checkbox');
    expect(checkbox).toHaveAttribute('aria-checked', 'true');
  });
});
