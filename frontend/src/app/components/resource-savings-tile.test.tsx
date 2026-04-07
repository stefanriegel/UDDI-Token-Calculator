import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ResourceSavingsTile } from './resource-savings-tile';
import type { FleetSavings } from './resource-savings';

const mixedFleet: FleetSavings = {
  memberCount: 32,
  totalOldVCPU: 580, totalOldRamGB: 2460,
  totalNewVCPU: 268, totalNewRamGB: 1224,
  totalDeltaVCPU: -312, totalDeltaRamGB: -1236,
  niosXSavings: { vCPU: 188, ramGB: 820, memberCount: 24 },
  xaasSavings: { vCPU: 124, ramGB: 400, memberCount: 8 },
  physicalUnitsRetired: 14,
  unknownModels: [], invalidCombinations: [],
};

const emptyFleet: FleetSavings = {
  memberCount: 0,
  totalOldVCPU: 0, totalOldRamGB: 0, totalNewVCPU: 0, totalNewRamGB: 0,
  totalDeltaVCPU: 0, totalDeltaRamGB: 0,
  niosXSavings: { vCPU: 0, ramGB: 0, memberCount: 0 },
  xaasSavings: { vCPU: 0, ramGB: 0, memberCount: 0 },
  physicalUnitsRetired: 0,
  unknownModels: [], invalidCombinations: [],
};

const allXaasFleet: FleetSavings = {
  ...mixedFleet,
  niosXSavings: { vCPU: 0, ramGB: 0, memberCount: 0 },
};

describe('ResourceSavingsTile', () => {
  it('renders mixed fleet snapshot', () => {
    const { container } = render(<ResourceSavingsTile fleet={mixedFleet} />);
    expect(container.firstChild).toMatchSnapshot();
  });

  it('shows empty state when no valid members', () => {
    const { getByRole } = render(<ResourceSavingsTile fleet={emptyFleet} />);
    expect(getByRole('status').textContent).toContain('No data');
  });

  it('hides NIOS-X line when all members are XaaS', () => {
    const { container } = render(<ResourceSavingsTile fleet={allXaasFleet} />);
    expect(container.textContent).not.toContain('Self-managed (NIOS-X)');
    expect(container.textContent).toContain('Fully eliminated (NIOS-XaaS)');
  });

  it('formats RAM ≥ 1024 GB as TB with 1 decimal', () => {
    const { container } = render(<ResourceSavingsTile fleet={mixedFleet} />);
    expect(container.textContent).toContain('1.2 TB RAM');
  });
});
