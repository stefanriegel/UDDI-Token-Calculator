/**
 * import-confirm-dialog.test.tsx — Tests for the Phase 32 D-02 confirmation
 * dialog (`<ImportConfirmDialog/>`).
 *
 * Covers plan 32-04 Task 1 done criteria:
 *   1. Trigger child renders unchanged before opening (asChild pattern).
 *   2. Opening shows the count summary text per D-02.
 *   3. Confirm button click invokes `onConfirm` exactly once.
 *   4. Cancel button click does NOT invoke `onConfirm`.
 *   5. Dedup-aware count: when existing state already contains one of the AWS
 *      regions, the will-add Region count drops by one.
 *   6. data-testid hooks exist for downstream e2e harnesses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ImportConfirmDialog } from '../import-confirm-dialog';
import { initialSizerState } from '../sizer-state';
import { importFromScan } from '../sizer-import';
import { awsFindings, niosMetrics } from './fixtures/scan-import';

beforeEach(() => {
  // userEvent v14 prefers fake timers off by default; ensure we are not under
  // any leftover fake clock from sibling test files.
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderDialog(opts: {
  existing?: ReturnType<typeof initialSizerState>;
  onConfirm?: () => void;
  findings?: typeof awsFindings;
  niosMetrics?: typeof niosMetrics;
}) {
  const onConfirm = opts.onConfirm ?? vi.fn();
  const existing = opts.existing ?? initialSizerState();
  const findings = opts.findings ?? awsFindings;
  const metrics = opts.niosMetrics ?? niosMetrics;
  const utils = render(
    <ImportConfirmDialog
      findings={findings}
      niosServerMetrics={metrics}
      existing={existing}
      onConfirm={onConfirm}
    >
      <button type="button" data-testid="open-trigger">
        Use as Sizer Input
      </button>
    </ImportConfirmDialog>,
  );
  return { ...utils, onConfirm };
}

describe('ImportConfirmDialog', () => {
  it('renders trigger child unchanged when closed (asChild pattern)', () => {
    renderDialog({});
    const trigger = screen.getByTestId('open-trigger');
    expect(trigger).toBeTruthy();
    expect(trigger.textContent).toBe('Use as Sizer Input');
    // Dialog content is portalled but not present until opened.
    expect(screen.queryByTestId('sizer-import-dialog')).toBeNull();
  });

  it('opens on trigger click and shows the count summary per D-02', async () => {
    const user = userEvent.setup();
    renderDialog({});
    await user.click(screen.getByTestId('open-trigger'));

    const summary = await screen.findByTestId('sizer-import-summary');
    const text = summary.textContent ?? '';
    // Will-add: 2 AWS regions × 1 site each + 3 NIOS-X members
    expect(text).toContain('Will add: 2 Regions, 2 Sites, 3 NIOS-X systems.');
    expect(text).toContain(
      'Existing Sizer data (0 Regions, 0 Sites, 0 NIOS-X) will be preserved.',
    );

    // Title + button labels
    expect(screen.getByText('Import scan results into Sizer?')).toBeTruthy();
    expect(screen.getByTestId('sizer-import-confirm').textContent).toBe(
      'Import & open Sizer',
    );
    expect(screen.getByTestId('sizer-import-cancel').textContent).toBe('Cancel');
  });

  it('confirm button click invokes onConfirm exactly once', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    renderDialog({ onConfirm });
    await user.click(screen.getByTestId('open-trigger'));
    const confirm = await screen.findByTestId('sizer-import-confirm');
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancel button click does NOT invoke onConfirm', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    renderDialog({ onConfirm });
    await user.click(screen.getByTestId('open-trigger'));
    const cancel = await screen.findByTestId('sizer-import-cancel');
    await user.click(cancel);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('dedup-aware: pre-existing AWS region drops will-add Region count by one', async () => {
    // Build an existing state seeded with the AWS subset (only us-east-1 row).
    const subset = awsFindings.filter((f) => f.region === 'us-east-1');
    const existing = importFromScan(subset);
    // Sanity: existing has exactly 1 Region, 1 Site, 0 NIOS-X.
    expect(existing.core.regions.length).toBe(1);
    expect(existing.core.infrastructure.niosx.length).toBe(0);

    const user = userEvent.setup();
    renderDialog({ existing });
    await user.click(screen.getByTestId('open-trigger'));
    const summary = await screen.findByTestId('sizer-import-summary');
    const text = summary.textContent ?? '';

    // Will-add Regions drops from 2 → 1 (us-east-1 already exists). Site
    // count likewise drops from 2 → 1. NIOS-X stays 3.
    expect(text).toContain('Will add: 1 Regions, 1 Sites, 3 NIOS-X systems.');
    expect(text).toContain(
      'Existing Sizer data (1 Regions, 1 Sites, 0 NIOS-X) will be preserved.',
    );
  });

  it('exposes a data-testid on the dialog content', async () => {
    const user = userEvent.setup();
    renderDialog({});
    await user.click(screen.getByTestId('open-trigger'));
    const dialog = await screen.findByTestId('sizer-import-dialog');
    expect(dialog).toBeTruthy();
    // Summary lives inside the dialog
    expect(within(dialog).getByTestId('sizer-import-summary')).toBeTruthy();
  });
});
