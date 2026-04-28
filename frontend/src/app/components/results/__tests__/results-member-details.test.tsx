/**
 * results-member-details.test.tsx — unit tests for `<ResultsMemberDetails/>`
 * (Phase 34 Plan 02).
 *
 * Locks the lift-first contract from D-03/D-04/D-05: pure presentation,
 * props in / callbacks out, no Sizer or scan-store coupling. Verifies the
 * 4 behaviors mandated by 34-02-PLAN <behavior>:
 *   1. 3 NiosServerMetrics → 3 rendered member cards
 *   2. per-row QPS/LPS/Objects/IPs columns reflect input values (REQ-03)
 *   3. override map applied — when override map has memberId, displayed
 *      QPS/LPS/Objects use the override over the base value (via the
 *      derived Server Tier display, which calls `calcServerTokenTier`
 *      on overridden values)
 *   4. root has data-testid="results-member-details" and id
 *      "section-member-details"
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import {
  ResultsMemberDetails,
  type ResultsMemberDetailsProps,
} from '../results-member-details';
import type { NiosServerMetrics } from '../../mock-data';
import type { FleetSavings } from '../../resource-savings';

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

const emptyFleet: FleetSavings = {
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
};

const baseProps = (
  over: Partial<ResultsMemberDetailsProps> = {},
): ResultsMemberDetailsProps => ({
  mode: 'scan',
  members: [],
  effectiveFindings: [],
  niosMigrationMap: new Map(),
  serverMetricOverrides: {},
  memberSavings: [],
  setVariantOverrides: vi.fn(),
  fleetSavings: emptyFleet,
  // Expanded by default for assertions to see the rendered cards.
  showGridMemberDetails: true,
  setShowGridMemberDetails: vi.fn(),
  gridMemberDetailSearch: '',
  setGridMemberDetailSearch: vi.fn(),
  ...over,
});

describe('<ResultsMemberDetails/>', () => {
  it('Test 4: root container has data-testid="results-member-details" and id "section-member-details"', () => {
    const members = [member({ memberId: 'm1', memberName: 'a.example.com' })];
    const { container } = render(<ResultsMemberDetails {...baseProps({ members })} />);
    const root = container.querySelector('[data-testid="results-member-details"]');
    expect(root).not.toBeNull();
    expect(root?.id).toBe('section-member-details');
  });

  it('Test 1: renders one card per member when given 3 NiosServerMetrics', () => {
    const members = [
      member({ memberId: 'm1', memberName: 'a.example.com' }),
      member({ memberId: 'm2', memberName: 'b.example.com' }),
      member({ memberId: 'm3', memberName: 'c.example.com' }),
    ];
    render(<ResultsMemberDetails {...baseProps({ members })} />);
    expect(screen.getAllByText('a.example.com').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('b.example.com').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('c.example.com').length).toBeGreaterThanOrEqual(1);
  });

  it('Test 2: per-row QPS/LPS/Objects/Active-IPs columns reflect input values', () => {
    const members = [
      member({
        memberId: 'm1',
        memberName: 'edge.example.com',
        qps: 1234,
        lps: 567,
        objectCount: 8910,
        activeIPCount: 1112,
      }),
    ];
    const { container } = render(
      <ResultsMemberDetails {...baseProps({ members })} />,
    );
    const root = container.querySelector(
      '[data-testid="results-member-details"]',
    ) as HTMLElement;
    // Each canonical metric is rendered via toLocaleString() — match using
    // the runtime's default locale (test host may be en-US, de-DE, etc.).
    const fmt = (n: number) => n.toLocaleString();
    expect(within(root).getAllByText(fmt(1234)).length).toBeGreaterThanOrEqual(1);
    expect(within(root).getAllByText(fmt(567)).length).toBeGreaterThanOrEqual(1);
    expect(within(root).getAllByText(fmt(8910)).length).toBeGreaterThanOrEqual(1);
    expect(within(root).getAllByText(fmt(1112)).length).toBeGreaterThanOrEqual(1);
  });

  it('Test 3: override map applied — overridden QPS drives a different Server Tier than base', () => {
    // Base values — should land at Server Tier "XS" (smallest tier)
    const m = member({
      memberId: 'm1',
      memberName: 'edge.example.com',
      qps: 1,
      lps: 1,
      objectCount: 1,
      activeIPCount: 0,
    });
    const baseRender = render(
      <ResultsMemberDetails {...baseProps({ members: [m] })} />,
    );
    const baseTierTokens = baseRender.container
      .querySelector('[data-testid="results-member-details"]')!
      .textContent ?? '';
    baseRender.unmount();

    // Override pushes QPS to a very large value — Server Tier should escalate.
    const overrideRender = render(
      <ResultsMemberDetails
        {...baseProps({
          members: [m],
          serverMetricOverrides: {
            m1: { qps: 5_000_000, lps: 5_000_000, objects: 5_000_000 },
          },
        })}
      />,
    );
    const overrideTierTokens = overrideRender.container
      .querySelector('[data-testid="results-member-details"]')!
      .textContent ?? '';
    expect(overrideTierTokens).not.toBe(baseTierTokens);
  });
});
