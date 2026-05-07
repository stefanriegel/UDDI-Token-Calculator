/**
 * sizer-step-regions.test.tsx — Step 1 (Regions) component tests.
 *
 * Covers plan 30-03 Task 2 done criteria:
 *   - Empty state renders and CTA adds first Region.
 *   - Adding Country/City/Site inline appears under the correct parent.
 *   - Adding Site directly under a Region auto-creates (Unassigned) Country +
 *     City and renders them italic muted (D-09).
 *   - Tree has role="tree" and nodes have role="treeitem" with aria-level.
 *   - Keyboard: ArrowDown moves selection; ArrowRight expands collapsed node;
 *     ArrowLeft on expanded node collapses.
 *   - Renaming an (Unassigned) Country via click → type → Enter dispatches
 *     UPDATE_COUNTRY (visible in the breadcrumb / label).
 *   - Delete Region button opens an AlertDialog with destructive CTA.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SizerProvider } from '../sizer-state';
import { SizerStepRegions } from '../sizer-step-regions';
import { SIZER_IMPORT_BADGE_KEY, STORAGE_KEY, type SizerFullState } from '../sizer-state';
import { UNASSIGNED_PLACEHOLDER } from '../sizer-types';

function clearStorage() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function mount() {
  return render(
    <SizerProvider>
      <SizerStepRegions />
    </SizerProvider>,
  );
}

describe('<SizerStepRegions/>', () => {
  beforeEach(() => clearStorage());

  it('empty state CTA adds first Region', async () => {
    const user = userEvent.setup();
    mount();
    expect(screen.getByTestId('sizer-empty-state')).toBeInTheDocument();
    await user.click(screen.getByTestId('sizer-empty-add-region'));
    // Empty state gone, tree present
    expect(screen.queryByTestId('sizer-empty-state')).not.toBeInTheDocument();
    expect(screen.getByTestId('sizer-tree')).toBeInTheDocument();
    // Default name shows in region form.
    expect(screen.getByTestId('sizer-region-name')).toHaveValue('Region 1');
  });

  it('tree container has role="tree" and rows have role="treeitem" with aria-level', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId('sizer-tree-add-region'));
    const tree = screen.getByTestId('sizer-tree');
    expect(tree).toHaveAttribute('role', 'tree');
    const items = within(tree).getAllByRole('treeitem');
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toHaveAttribute('aria-level', '1');
  });

  it('adding a Country inline appears under the region expanded', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId('sizer-tree-add-region'));
    // Add country using the inline button
    const tree = screen.getByTestId('sizer-tree');
    const addCountryBtn = within(tree).getByText(/Add Country/i);
    await user.click(addCountryBtn);
    // A level-2 tree item should now exist.
    const items = within(tree).getAllByRole('treeitem');
    expect(items.some((el) => el.getAttribute('aria-level') === '2')).toBe(true);
  });

  it('adding a Site directly under a Region auto-creates (Unassigned) Country + City (D-09)', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId('sizer-tree-add-region'));
    // Click the inline "+ Add Site" under the Region (bypassing Country/City).
    const addSiteBtns = screen.getAllByText(/Add Site/i);
    // Pick the one with test-id prefix sizer-tree-add-site-under-region-*
    const underRegionBtn = addSiteBtns.find((el) =>
      (el.getAttribute('data-testid') ?? '').startsWith(
        'sizer-tree-add-site-under-region-',
      ),
    );
    expect(underRegionBtn).toBeTruthy();
    await user.click(underRegionBtn!);
    // Two (Unassigned) labels should appear (Country + City)
    const placeholders = screen.getAllByText(UNASSIGNED_PLACEHOLDER);
    expect(placeholders.length).toBeGreaterThanOrEqual(2);
    // They should be styled italic + muted (class contains italic).
    expect(placeholders[0].className).toMatch(/italic/);
  });

  it('ArrowDown moves selection to the next visible row', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId('sizer-tree-add-region'));
    // Add a country so we have a second row.
    const addCountryBtn = await screen.findByText(/Add Country/i);
    await user.click(addCountryBtn);
    // Select the region (click its label area).
    const tree = screen.getByTestId('sizer-tree');
    const items = within(tree).getAllByRole('treeitem');
    // Focus the tree container wrapper (parent of the UL) to receive keydown.
    const wrapper = tree.parentElement!;
    wrapper.focus();
    // Select first item (region).
    await user.click(items[0]);
    await user.keyboard('{ArrowDown}');
    // Now some level-2 item should be aria-selected.
    const selected = within(tree)
      .getAllByRole('treeitem')
      .find((el) => el.getAttribute('aria-selected') === 'true');
    expect(selected).toBeTruthy();
    expect(selected?.getAttribute('aria-level')).toBe('2');
  });

  it('ArrowLeft on an expanded region collapses it', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId('sizer-tree-add-region'));
    const addCountryBtn = await screen.findByText(/Add Country/i);
    await user.click(addCountryBtn);
    const tree = screen.getByTestId('sizer-tree');
    let items = within(tree).getAllByRole('treeitem');
    const region = items[0];
    await user.click(region);
    expect(region).toHaveAttribute('aria-expanded', 'true');
    const wrapper = tree.parentElement!;
    wrapper.focus();
    await user.keyboard('{ArrowLeft}');
    items = within(tree).getAllByRole('treeitem');
    expect(items[0]).toHaveAttribute('aria-expanded', 'false');
  });

  it('renaming an (Unassigned) Country via click → type → Enter updates the tree', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId('sizer-tree-add-region'));
    // Auto-create (Unassigned) Country + City by adding a Site under Region.
    const addSiteBtns = screen.getAllByText(/Add Site/i);
    const underRegionBtn = addSiteBtns.find((el) =>
      (el.getAttribute('data-testid') ?? '').startsWith(
        'sizer-tree-add-site-under-region-',
      ),
    );
    await user.click(underRegionBtn!);
    // Find the first (Unassigned) placeholder — that's the Country.
    const countryLabels = screen.getAllByText(UNASSIGNED_PLACEHOLDER);
    await user.click(countryLabels[0]);
    // Input appears
    const input = await screen.findAllByRole('textbox');
    const renameInput = input.find((el) =>
      (el.getAttribute('data-testid') ?? '').startsWith('sizer-unassigned-input-'),
    );
    expect(renameInput).toBeTruthy();
    await user.clear(renameInput!);
    await user.type(renameInput!, 'Germany');
    await user.keyboard('{Enter}');
    // "Germany" now present in the tree.
    expect(screen.getAllByText('Germany').length).toBeGreaterThan(0);
  });

  it('Delete Region button opens an AlertDialog with destructive CTA', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId('sizer-tree-add-region'));
    // Find the delete icon button for the first region.
    const deleteBtns = screen.getAllByLabelText('Delete region');
    await user.click(deleteBtns[0]);
    const dialog = await screen.findByTestId('sizer-delete-dialog');
    expect(dialog).toBeInTheDocument();
    expect(
      within(dialog).getByTestId('sizer-delete-dialog-confirm'),
    ).toHaveTextContent(/Delete/i);
  });
});

// Sanity: persisted state round-trip doesn't pollute other tests.
describe('<SizerStepRegions/> persistence cleanup', () => {
  it('leaves no stored state after clearStorage', () => {
    clearStorage();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    // guard against unused-var complaints in TS config
    const _: SizerFullState | null = null;
    void _;
  });
});

// Phase 32 D-18 — post-import badge consumer
describe('<SizerStepRegions/> import badge (D-18)', () => {
  beforeEach(() => {
    sessionStorage.removeItem(SIZER_IMPORT_BADGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
  });
  afterEach(() => {
    sessionStorage.removeItem(SIZER_IMPORT_BADGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
  });

  it('renders verbatim D-18 copy when sessionStorage badge is present and clears the key on read', () => {
    sessionStorage.setItem(
      SIZER_IMPORT_BADGE_KEY,
      JSON.stringify({ regions: 2, sites: 3, niosx: 1 }),
    );
    mount();
    const badge = screen.getByTestId('sizer-import-badge');
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toBe(
      'Imported 2 Regions, 3 Sites, 1 NIOS-X systems into the Sizer.',
    );
    // Key consumed on first read so manual reload does not replay it.
    expect(sessionStorage.getItem(SIZER_IMPORT_BADGE_KEY)).toBeNull();
  });

  it('does not render badge when sessionStorage entry is absent', () => {
    mount();
    expect(screen.queryByTestId('sizer-import-badge')).toBeNull();
  });

  it('does not render badge and does not throw when sessionStorage payload is malformed', () => {
    sessionStorage.setItem(SIZER_IMPORT_BADGE_KEY, 'not-json{');
    expect(() => mount()).not.toThrow();
    expect(screen.queryByTestId('sizer-import-badge')).toBeNull();
  });

  it('does not render badge when count fields are missing/non-numeric', () => {
    sessionStorage.setItem(
      SIZER_IMPORT_BADGE_KEY,
      JSON.stringify({ regions: 'two', sites: 3 }),
    );
    mount();
    expect(screen.queryByTestId('sizer-import-badge')).toBeNull();
  });

  it('region row exposes an inline type pill labelled with the current type (discoverability)', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId('sizer-tree-add-region'));
    const regionRow = screen.getByTestId('sizer-tree').querySelector('[data-level="1"]');
    expect(regionRow).not.toBeNull();
    const pill = within(regionRow as HTMLElement).getByRole('combobox');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveAccessibleName(/Region type: On-Prem/);
    expect(pill.textContent).toMatch(/On-Prem/);
  });

  it('auto-clears the badge from the DOM after 4000ms', () => {
    vi.useFakeTimers();
    try {
      sessionStorage.setItem(
        SIZER_IMPORT_BADGE_KEY,
        JSON.stringify({ regions: 1, sites: 1, niosx: 0 }),
      );
      mount();
      expect(screen.getByTestId('sizer-import-badge')).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(screen.queryByTestId('sizer-import-badge')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
