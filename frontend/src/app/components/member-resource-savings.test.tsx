import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { MemberResourceSavings } from './member-resource-savings';
import type { MemberSavings, ApplianceSpec } from './resource-savings';

const x6VmwareSpec: ApplianceSpec = {
  model: 'IB-V2326',
  generation: 'X6',
  platform: 'VMware',
  variants: [
    { configName: 'Small', vCPU: 12, ramGB: 128 },
    { configName: 'Large', vCPU: 20, ramGB: 192 },
  ],
  defaultVariantIndex: 0,
};

const healthyNiosX: MemberSavings = {
  memberId: 'gm-01', memberName: 'gm-01.example.com',
  oldModel: 'IB-V2326', oldPlatform: 'VMware', oldGeneration: 'X6',
  oldSpec: x6VmwareSpec, oldVariantIndex: 0, oldVCPU: 12, oldRamGB: 128,
  targetFormFactor: 'nios-x', newTierName: '2XS', newVCPU: 3, newRamGB: 4,
  deltaVCPU: -9, deltaRamGB: -124,
  physicalDecommission: false, fullyManaged: false,
  lookupMissing: false, invalidPlatformForModel: false,
};

const xaasMember: MemberSavings = {
  ...healthyNiosX,
  targetFormFactor: 'nios-xaas',
  newTierName: 'S',
  newVCPU: 0,
  newRamGB: 0,
  deltaVCPU: -12,
  deltaRamGB: -128,
  fullyManaged: true,
};

const physicalSpec: ApplianceSpec = {
  model: 'IB-4030',
  generation: 'Physical',
  platform: 'Physical',
  variants: [{ configName: 'Standard', vCPU: 8, ramGB: 16 }],
  defaultVariantIndex: 0,
};

const physicalMember: MemberSavings = {
  ...healthyNiosX,
  oldModel: 'IB-4030',
  oldPlatform: 'Physical',
  oldGeneration: 'Physical',
  oldSpec: physicalSpec,
  oldVCPU: 8,
  oldRamGB: 16,
  deltaVCPU: -5,
  deltaRamGB: -12,
  physicalDecommission: true,
};

const lookupMiss: MemberSavings = {
  ...healthyNiosX,
  oldModel: 'IB-WEIRD',
  oldSpec: null,
  oldVCPU: 0,
  oldRamGB: 0,
  deltaVCPU: 0,
  deltaRamGB: 0,
  lookupMissing: true,
};

const invalidCombo: MemberSavings = {
  ...healthyNiosX,
  oldModel: 'IB-V2215',
  oldPlatform: 'Azure',
  oldSpec: null,
  oldVCPU: 0,
  oldRamGB: 0,
  deltaVCPU: 0,
  deltaRamGB: 0,
  invalidPlatformForModel: true,
};

describe('MemberResourceSavings', () => {
  it('renders healthy NIOS-X snapshot', () => {
    const { container } = render(<MemberResourceSavings savings={healthyNiosX} onVariantChange={() => {}} />);
    expect(container.firstChild).toMatchSnapshot();
  });

  it('renders variant chips when spec has >1 variant', () => {
    const { getByText } = render(<MemberResourceSavings savings={healthyNiosX} onVariantChange={() => {}} />);
    expect(getByText('Small')).toBeDefined();
    expect(getByText('Large')).toBeDefined();
  });

  it('calls onVariantChange with clicked index', () => {
    const onChange = vi.fn();
    const { getByText } = render(<MemberResourceSavings savings={healthyNiosX} onVariantChange={onChange} />);
    fireEvent.click(getByText('Large'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it('renders XaaS fully managed badge', () => {
    const { container } = render(<MemberResourceSavings savings={xaasMember} onVariantChange={() => {}} />);
    expect(container.textContent).toContain('✨ Fully managed by Infoblox — zero customer footprint');
    expect(container.textContent).toContain('NIOS-XaaS (Fully managed)');
    expect(container.textContent).toContain('(100%)');
  });

  it('renders physical decommission pill', () => {
    const { container } = render(<MemberResourceSavings savings={physicalMember} onVariantChange={() => {}} />);
    expect(container.textContent).toContain('🏢 Physical decommission — frees rack space, power, and cooling');
  });

  it('renders lookup miss warning with role=alert', () => {
    const { getByRole } = render(<MemberResourceSavings savings={lookupMiss} onVariantChange={() => {}} />);
    expect(getByRole('alert').textContent).toContain('⚠ Unknown model — verify member configuration');
  });

  it('renders invalid combo warning verbatim', () => {
    const { getByRole } = render(<MemberResourceSavings savings={invalidCombo} onVariantChange={() => {}} />);
    expect(getByRole('alert').textContent).toContain('⚠ Model "IB-V2215" is not supported on Azure (VMware-only)');
  });
});
