/**
 * sizer-stepper.test.tsx — Issue #33 regression.
 *
 * On narrow viewports, the active step's label must remain visible so the
 * user keeps orientation. Inactive labels stay hidden via the responsive
 * `hidden sm:block` utility to avoid horizontal overflow.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SizerProvider } from '../sizer-state';
import { SizerStepper } from '../sizer-stepper';

function renderStepper() {
  return render(
    <SizerProvider>
      <SizerStepper />
    </SizerProvider>,
  );
}

describe('SizerStepper @issue-33 mobile labeling', () => {
  it('active step label renders without responsive `hidden` (visible on mobile)', () => {
    renderStepper();
    const activeLabel = screen.getByTestId('sizer-stepper-label-1');
    expect(activeLabel).toBeInTheDocument();
    expect(activeLabel.className).not.toMatch(/\bhidden\b/);
  });

  it('inactive step labels keep `hidden sm:block` so mobile widths do not overflow', () => {
    renderStepper();
    for (const n of [2, 3, 4] as const) {
      const label = screen.getByTestId(`sizer-stepper-label-${n}`);
      expect(label.className).toMatch(/\bhidden\b/);
      expect(label.className).toMatch(/\bsm:block\b/);
    }
  });
});
