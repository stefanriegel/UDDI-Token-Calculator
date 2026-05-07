/**
 * results-resource-savings.test.tsx — Phase 34 Plan 03
 *
 * Locks the shim contract:
 *   1. Non-empty `savings` → renders inner <MemberResourceSavings/> per item
 *   2. Empty `savings` → renders null (REQ-07 scan-mode no-DOM guarantee)
 *   3. Section root has id="section-resource-savings" and
 *      data-testid="results-resource-savings" (D-13 OutlineNav anchor)
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ResultsResourceSavings } from '../results-resource-savings';
import type { MemberSavings, ApplianceSpec } from '../../resource-savings';

const spec: ApplianceSpec = {
  model: 'IB-V2326',
  generation: 'X6',
  platform: 'VMware',
  variants: [
    { configName: 'Small', vCPU: 12, ramGB: 128 },
    { configName: 'Large', vCPU: 20, ramGB: 192 },
  ],
  defaultVariantIndex: 0,
};

const savings = (over: Partial<MemberSavings> = {}): MemberSavings => ({
  memberId: 'm1',
  memberName: 'm1.example.com',
  oldModel: 'IB-V2326',
  oldPlatform: 'VMware',
  oldGeneration: 'X6',
  oldSpec: spec,
  oldVariantIndex: 0,
  oldVCPU: 12,
  oldRamGB: 128,
  targetFormFactor: 'nios-x',
  newTierName: '2XS',
  newVCPU: 3,
  newRamGB: 4,
  deltaVCPU: -9,
  deltaRamGB: -124,
  physicalDecommission: false,
  fullyManaged: false,
  lookupMissing: false,
  invalidPlatformForModel: false,
  ...over,
});

describe('ResultsResourceSavings', () => {
  it('renders one MemberResourceSavings tile per savings entry when non-empty', () => {
    const items = [
      savings({ memberId: 'a', memberName: 'a.example.com' }),
      savings({ memberId: 'b', memberName: 'b.example.com' }),
      savings({ memberId: 'c', memberName: 'c.example.com' }),
    ];
    render(
      <ResultsResourceSavings
        mode="sizer"
        savings={items}
        onVariantChange={() => {}}
      />,
    );
    // Each MemberResourceSavings renders the "Resource Savings" sub-label
    // inside its tile; expect 3 occurrences for the 3 members.
    const labels = screen.getAllByText('Resource Savings', { selector: 'div' });
    expect(labels.length).toBe(3);
  });

  it('renders null when savings is empty (REQ-07 scan-mode parity)', () => {
    const { container } = render(
      <ResultsResourceSavings
        mode="scan"
        savings={[]}
        onVariantChange={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('section root carries id="section-resource-savings" and data-testid="results-resource-savings"', () => {
    render(
      <ResultsResourceSavings
        mode="sizer"
        savings={[savings()]}
        onVariantChange={() => {}}
      />,
    );
    const root = screen.getByTestId('results-resource-savings');
    expect(root).toBeTruthy();
    expect(root.id).toBe('section-resource-savings');
    expect(root.getAttribute('data-mode')).toBe('sizer');
  });

  it('forwards variant changes with member id', () => {
    const onVariantChange = vi.fn();
    render(
      <ResultsResourceSavings
        mode="sizer"
        savings={[savings({ memberId: 'm-xyz' })]}
        onVariantChange={onVariantChange}
      />,
    );
    // Two variants in spec → two chip buttons rendered.
    const largeBtn = screen.getByRole('button', { name: 'Large' });
    fireEvent.click(largeBtn);
    expect(onVariantChange).toHaveBeenCalledWith('m-xyz', 1);
  });
});
