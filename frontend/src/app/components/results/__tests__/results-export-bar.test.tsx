/**
 * results-export-bar.test.tsx — unit tests for `<ResultsExportBar/>` (Phase 33 Plan 06).
 *
 * Locks D-13 (export wires to onExport prop) and D-15 (mode-specific Start
 * Over copy from UI-SPEC Copywriting table) behind automated assertions.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ResultsExportBar, type ResultsExportBarProps } from '../results-export-bar';

const baseProps: ResultsExportBarProps = {
  mode: 'scan',
  onExport: () => {},
};

const make = (over: Partial<ResultsExportBarProps> = {}): ResultsExportBarProps => ({
  ...baseProps,
  ...over,
});

describe('<ResultsExportBar/>', () => {
  it('mode="scan" Start Over dialog uses scan-mode copy verbatim (D-15)', async () => {
    const user = userEvent.setup();
    render(<ResultsExportBar {...make({ mode: 'scan', onReset: () => {} })} />);

    await user.click(screen.getByRole('button', { name: /start over/i }));

    expect(
      screen.getByText(
        'This clears scan results from this session. Credentials remain server-side.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Start Over?' })).toBeInTheDocument();
  });

  it('mode="sizer" Start Over dialog uses sizer-mode copy verbatim (D-15)', async () => {
    const user = userEvent.setup();
    render(<ResultsExportBar {...make({ mode: 'sizer', onReset: () => {} })} />);

    await user.click(screen.getByRole('button', { name: /start over/i }));

    expect(
      screen.getByText(
        'This clears Sizer state stored in this browser. Your inputs cannot be recovered.',
      ),
    ).toBeInTheDocument();
  });

  it('omits Start Over button when onReset is not provided', () => {
    render(<ResultsExportBar {...make({ mode: 'sizer' })} />);
    expect(screen.queryByRole('button', { name: /start over/i })).not.toBeInTheDocument();
    // Export button still rendered.
    expect(screen.getByRole('button', { name: /download xlsx/i })).toBeInTheDocument();
  });

  it('clicking Download XLSX invokes onExport exactly once (D-13)', async () => {
    const onExport = vi.fn();
    const user = userEvent.setup();
    render(<ResultsExportBar {...make({ onExport })} />);

    await user.click(screen.getByRole('button', { name: /download xlsx/i }));

    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it('custom resetCopy prop overrides defaults (caller-supplied copy)', async () => {
    const user = userEvent.setup();
    render(
      <ResultsExportBar
        {...make({
          mode: 'sizer',
          onReset: () => {},
          resetCopy: {
            title: 'Bespoke Title',
            description: 'Bespoke description text.',
            cancel: 'Nope',
            confirm: 'Yep',
          },
        })}
      />,
    );

    await user.click(screen.getByRole('button', { name: /start over/i }));

    expect(screen.getByRole('heading', { name: 'Bespoke Title' })).toBeInTheDocument();
    expect(screen.getByText('Bespoke description text.')).toBeInTheDocument();
  });

  it('respects exportLabel override prop', () => {
    render(<ResultsExportBar {...make({ exportLabel: 'Save Sizer Workbook' })} />);
    expect(
      screen.getByRole('button', { name: /save sizer workbook/i }),
    ).toBeInTheDocument();
  });
});
