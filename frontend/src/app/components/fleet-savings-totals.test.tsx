import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { FleetSavingsTotals } from './fleet-savings-totals';
import type { FleetSavings } from './resource-savings';

const fleet: FleetSavings = {
  memberCount: 38,
  totalOldVCPU: 580, totalOldRamGB: 2460,
  totalNewVCPU: 268, totalNewRamGB: 1224,
  totalDeltaVCPU: -312, totalDeltaRamGB: -1236,
  niosXSavings: { vCPU: 188, ramGB: 820, memberCount: 24 },
  xaasSavings: { vCPU: 124, ramGB: 400, memberCount: 8 },
  physicalUnitsRetired: 14,
  unknownModels: ['IB-WEIRD'], invalidCombinations: [{ model: 'IB-V2215', platform: 'Azure' }],
};

describe('FleetSavingsTotals', () => {
  it('renders snapshot', () => {
    const { container } = render(<FleetSavingsTotals fleet={fleet} />);
    expect(container.firstChild).toMatchSnapshot();
  });

  it('shows excluded count when > 0', () => {
    const { container } = render(<FleetSavingsTotals fleet={fleet} />);
    expect(container.textContent).toContain('2 excluded');
  });

  it('renders physical retired line when > 0', () => {
    const { container } = render(<FleetSavingsTotals fleet={fleet} />);
    expect(container.textContent).toContain('Physical retired: 14 units');
  });
});
