/**
 * results-migration-planner.test.tsx — unit tests for `<ResultsMigrationPlanner/>`
 * (Phase 34 Plan 01).
 *
 * Locks the lift-first contract from D-03/D-04/D-05: pure presentation,
 * props in / callbacks out, no Sizer or scan-store coupling. Verifies the
 * 4 behaviors mandated by 34-01-PLAN <behavior>:
 *   1. one row per member when given 3 NiosServerMetrics
 *   2. tier picker change invokes onTierChange with (memberId, newTier)
 *   3. empty members array renders nothing (no card chrome)
 *   4. root container exposes data-testid="results-migration-planner"
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  ResultsMigrationPlanner,
  type ResultsMigrationPlannerProps,
} from '../results-migration-planner';
import type { NiosServerMetrics } from '../../mock-data';

const member = (over: Partial<NiosServerMetrics> = {}): NiosServerMetrics => ({
  memberId: 'm1',
  memberName: 'gm.example.com',
  role: 'DNS/DHCP',
  qps: 100,
  lps: 10,
  objectCount: 200,
  activeIPCount: 50,
  model: 'IB-2225',
  platform: 'physical',
  managedIPCount: 0,
  staticHosts: 0,
  dynamicHosts: 0,
  dhcpUtilization: 0,
  ...over,
});

const baseProps = (over: Partial<ResultsMigrationPlannerProps> = {}): ResultsMigrationPlannerProps => ({
  mode: 'scan',
  members: [],
  findings: [],
  effectiveFindings: [],
  selectedProviders: ['nios'],
  growthBufferPct: 0,
  fleetSavings: {
    memberCount: 0,
    totalOldVCPU: 0,
    totalOldRamGB: 0,
    totalNewVCPU: 0,
    totalNewRamGB: 0,
    totalDeltaVCPU: 0,
    totalDeltaRamGB: 0,
    niosXSavings: { vCPU: 0, ramGB: 0, memberCount: 0 },
    xaasSavings: { vCPU: 0, ramGB: 0, memberCount: 0 },
    physicalUnitsRetired: 0,
    unknownModels: [],
    invalidCombinations: [],
  },
  memberSavings: [],
  niosMigrationMap: new Map(),
  setNiosMigrationMap: vi.fn(),
  setVariantOverrides: vi.fn(),
  serverMetricOverrides: {},
  setServerMetricOverrides: vi.fn(),
  editingServerMetric: null,
  setEditingServerMetric: vi.fn(),
  editingServerValue: '',
  setEditingServerValue: vi.fn(),
  memberSearchFilter: '',
  setMemberSearchFilter: vi.fn(),
  showGridMemberDetails: false,
  setShowGridMemberDetails: vi.fn(),
  gridMemberDetailSearch: '',
  setGridMemberDetailSearch: vi.fn(),
  niosGridFeatures: null,
  niosGridLicenses: null,
  niosMigrationFlags: null,
  gridFeaturesOpen: false,
  setGridFeaturesOpen: vi.fn(),
  migrationFlagsOpen: false,
  setMigrationFlagsOpen: vi.fn(),
  onTierChange: vi.fn(),
  ...over,
});

describe('<ResultsMigrationPlanner/>', () => {
  it('Test 4: root container has data-testid="results-migration-planner"', () => {
    const members = [member({ memberId: 'm1', memberName: 'a.example.com' })];
    const { container } = render(<ResultsMigrationPlanner {...baseProps({ members })} />);
    expect(container.querySelector('[data-testid="results-migration-planner"]')).not.toBeNull();
  });

  it('Test 1: renders one row per member when given 3 NiosServerMetrics', () => {
    const members = [
      member({ memberId: 'm1', memberName: 'a.example.com' }),
      member({ memberId: 'm2', memberName: 'b.example.com' }),
      member({ memberId: 'm3', memberName: 'c.example.com' }),
    ];
    render(<ResultsMigrationPlanner {...baseProps({ members })} />);
    // Each member name should be rendered at least once in the planner
    expect(screen.getAllByText('a.example.com').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('b.example.com').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('c.example.com').length).toBeGreaterThanOrEqual(1);
  });

  it('Test 2: tier picker change invokes onTierChange with (memberId, newTier)', async () => {
    const onTierChange = vi.fn();
    // Pre-mark the member as migrating so the NIOS-X / XaaS picker is visible
    const members = [member({ memberId: 'm1', memberName: 'edge.example.com' })];
    const niosMigrationMap = new Map<string, any>([['edge.example.com', 'nios-x']]);
    const user = userEvent.setup();
    render(
      <ResultsMigrationPlanner
        {...baseProps({ members, niosMigrationMap, onTierChange })}
      />,
    );

    // The XaaS picker button — pick the first one in the migration-planner section
    const planner = screen.getByTestId('results-migration-planner');
    const xaasButton = within(planner).getAllByRole('button', { name: /xaas/i })[0];
    await user.click(xaasButton);
    expect(onTierChange).toHaveBeenCalledWith('edge.example.com', 'nios-xaas');
  });

  it('Test 3: empty members array renders nothing (no planner card)', () => {
    const { container } = render(<ResultsMigrationPlanner {...baseProps({ members: [] })} />);
    expect(container.querySelector('[data-testid="results-migration-planner"]')).toBeNull();
  });
});
