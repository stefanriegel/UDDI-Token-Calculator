import { describe, it, expect } from 'vitest';
import {
  calcServerTokenTier,
  consolidateXaasInstances,
  XAAS_EXTRA_CONNECTION_COST,
  SERVER_TOKEN_TIERS,
  XAAS_TOKEN_TIERS,
} from './nios-calc';
import type { NiosServerMetrics } from './nios-calc';

// ─── calcServerTokenTier ───────────────────────────────────────────────────────

describe('calcServerTokenTier', () => {
  it('returns 2XS tier for zero values (nios-x)', () => {
    const tier = calcServerTokenTier(0, 0, 0, 'nios-x');
    expect(tier.name).toBe('2XS');
    expect(tier.serverTokens).toBe(130);
  });

  it('returns XS when QPS is just over 2XS limit (nios-x)', () => {
    const tier = calcServerTokenTier(5001, 0, 0, 'nios-x');
    expect(tier.name).toBe('XS');
  });

  it('returns M tier for (40000, 300, 110000, nios-x)', () => {
    const tier = calcServerTokenTier(40000, 300, 110000, 'nios-x');
    expect(tier.name).toBe('M');
    expect(tier.serverTokens).toBe(880);
  });

  it('caps at XL when all tiers exceeded (nios-x)', () => {
    const tier = calcServerTokenTier(200000, 1000, 2000000, 'nios-x');
    expect(tier.name).toBe('XL');
    expect(tier.serverTokens).toBe(2700);
  });

  it('returns XaaS S tier for (20000, 200, 29000, nios-xaas)', () => {
    const tier = calcServerTokenTier(20000, 200, 29000, 'nios-xaas');
    expect(tier.name).toBe('S');
    expect(tier.serverTokens).toBe(2400);
  });

  it('uses nios-x tiers by default when no form factor given', () => {
    const tier = calcServerTokenTier(0, 0, 0);
    expect(tier.name).toBe('2XS');
    expect(SERVER_TOKEN_TIERS).toContain(tier);
  });

  it('XL tier is the cap for nios-xaas when limits exceeded', () => {
    const tier = calcServerTokenTier(200000, 1000, 2000000, 'nios-xaas');
    expect(tier.name).toBe('XL');
    expect(XAAS_TOKEN_TIERS).toContain(tier);
  });
});

// ─── consolidateXaasInstances ──────────────────────────────────────────────────

describe('consolidateXaasInstances', () => {
  it('returns empty array for empty input', () => {
    const result = consolidateXaasInstances([]);
    expect(result).toEqual([]);
  });

  it('returns 1 instance with no extra connections for a single tiny member', () => {
    const members: NiosServerMetrics[] = [
      { memberId: 'm1', memberName: 'member-1', role: 'DNS', qps: 100, lps: 1, objectCount: 10, activeIPCount: 0, managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: {} },
    ];
    const result = consolidateXaasInstances(members);
    expect(result).toHaveLength(1);
    expect(result[0].index).toBe(0);
    expect(result[0].connectionsUsed).toBe(1);
    expect(result[0].extraConnections).toBe(0);
    expect(result[0].extraConnectionTokens).toBe(0);
    expect(result[0].totalTokens).toBe(result[0].tier.serverTokens);
    expect(result[0].totalQps).toBe(100);
    expect(result[0].totalLps).toBe(1);
    expect(result[0].totalObjects).toBe(10);
  });

  it('upgrades 11 tiny members to M-tier (connections exceed S maxConnections=10)', () => {
    const members: NiosServerMetrics[] = Array.from({ length: 11 }, (_, i) => ({
      memberId: `m${i}`,
      memberName: `member-${i}`,
      role: 'DNS',
      qps: 100,
      lps: 1,
      objectCount: 10,
      activeIPCount: 0,
      managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: {},
    }));
    const result = consolidateXaasInstances(members);
    expect(result).toHaveLength(1);
    const inst = result[0];
    expect(inst.tier.name).toBe('M');
    expect(inst.connectionsUsed).toBe(11);
    expect(inst.extraConnections).toBe(0);  // 11 <= 20 (M maxConnections)
    expect(inst.extraConnectionTokens).toBe(0);
    expect(inst.totalTokens).toBe(inst.tier.serverTokens); // M = 4100, no extras
    // SUM aggregation: 11 * 100 = 1100 QPS
    expect(inst.totalQps).toBe(1100);
  });

  it('upgrades 21 tiny members to L-tier (connections exceed M maxConnections=20)', () => {
    const members: NiosServerMetrics[] = Array.from({ length: 21 }, (_, i) => ({
      memberId: `m${i}`,
      memberName: `member-${i}`,
      role: 'DNS',
      qps: 100,
      lps: 1,
      objectCount: 10,
      activeIPCount: 0,
      managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: {},
    }));
    const result = consolidateXaasInstances(members);
    expect(result).toHaveLength(1);
    const inst = result[0];
    expect(inst.tier.name).toBe('L');
    expect(inst.connectionsUsed).toBe(21);
    expect(inst.extraConnections).toBe(0);  // 21 <= 35 (L maxConnections)
    expect(inst.extraConnectionTokens).toBe(0);
    expect(inst.totalTokens).toBe(inst.tier.serverTokens); // L = 6100
  });

  it('uses XL-tier with extra connections for 86 tiny members (exceeds XL maxConnections=85)', () => {
    const members: NiosServerMetrics[] = Array.from({ length: 86 }, (_, i) => ({
      memberId: `m${i}`,
      memberName: `member-${i}`,
      role: 'DNS',
      qps: 100,
      lps: 1,
      objectCount: 10,
      activeIPCount: 0,
      managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: {},
    }));
    const result = consolidateXaasInstances(members);
    expect(result).toHaveLength(1);
    const inst = result[0];
    expect(inst.tier.name).toBe('XL');
    expect(inst.connectionsUsed).toBe(86);
    expect(inst.extraConnections).toBe(1);  // 86 - 85 (XL maxConnections) = 1
    expect(inst.extraConnectionTokens).toBe(100); // 1 * 100
    expect(inst.totalTokens).toBe(inst.tier.serverTokens + 100); // XL = 8500 + 100
  });

  it('packs 2 moderate members into 1 XL instance (SUM aggregation)', () => {
    // With SUM aggregation: 60000+50000=110000 QPS fits XL (115000 max)
    const members: NiosServerMetrics[] = [
      { memberId: 'm1', memberName: 'member-1', role: 'DNS',  qps: 60000, lps: 300, objectCount: 400000, activeIPCount: 0, managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: {} },
      { memberId: 'm2', memberName: 'member-2', role: 'DNS',  qps: 50000, lps: 300, objectCount: 400000, activeIPCount: 0, managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: {} },
    ];
    const result = consolidateXaasInstances(members);
    expect(result).toHaveLength(1);
    expect(result[0].tier.name).toBe('XL');
    expect(result[0].connectionsUsed).toBe(2);
    expect(result[0].totalQps).toBe(110000);
    expect(result[0].totalLps).toBe(600);
    expect(result[0].totalObjects).toBe(800000);
  });

  it('creates 2 instances when SUM exceeds XL capacity', () => {
    // With SUM: 60000+60000=120000 > 115000 XL max QPS -> must split
    const members: NiosServerMetrics[] = [
      { memberId: 'm1', memberName: 'member-1', role: 'DNS', qps: 60000, lps: 300, objectCount: 400000, activeIPCount: 0, managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: {} },
      { memberId: 'm2', memberName: 'member-2', role: 'DNS', qps: 60000, lps: 300, objectCount: 400000, activeIPCount: 0, managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: {} },
    ];
    const result = consolidateXaasInstances(members);
    expect(result).toHaveLength(2);
    expect(result[0].index).toBe(0);
    expect(result[1].index).toBe(1);
  });

  it('XAAS_EXTRA_CONNECTION_COST is 100', () => {
    expect(XAAS_EXTRA_CONNECTION_COST).toBe(100);
  });
});

// ─── AD XaaS Consolidation ───────────────────────────────────────────────────
// Tests verifying the AD-to-NiosServerMetrics mapping and XaaS consolidation
// when fed Active Directory domain controller metrics. AD DCs use the same
// bin-packing algorithm as NIOS members but always have activeIPCount=0.

describe('AD XaaS Consolidation', () => {
  // Mock AD DC data matching wizard.tsx mock values
  const mockDCs = {
    DC01: { hostname: 'DC01', dnsObjects: 1250, dhcpObjectsWithOverhead: 408, qps: 2800, lps: 45 },
    DC02: { hostname: 'DC02', dnsObjects: 3200, dhcpObjectsWithOverhead: 6740, qps: 12000, lps: 120 },
    DC03: { hostname: 'DC03', dnsObjects: 10600, dhcpObjectsWithOverhead: 24000, qps: 35000, lps: 250 },
  };

  // Replicate the toNiosMetrics mapping from wizard.tsx line 1511
  function toNiosMetrics(dc: { hostname: string; dnsObjects: number; dhcpObjectsWithOverhead: number; qps: number; lps: number }): NiosServerMetrics {
    return {
      memberId: dc.hostname,
      memberName: dc.hostname,
      role: 'DC',
      qps: dc.qps,
      lps: dc.lps,
      objectCount: dc.dnsObjects + dc.dhcpObjectsWithOverhead,
      activeIPCount: 0,
    };
  }

  it('correctly maps AD DC metrics to NiosServerMetrics', () => {
    const mapped = toNiosMetrics(mockDCs.DC01);
    expect(mapped.memberId).toBe('DC01');
    expect(mapped.memberName).toBe('DC01');
    expect(mapped.role).toBe('DC');
    expect(mapped.qps).toBe(2800);
    expect(mapped.lps).toBe(45);
    expect(mapped.objectCount).toBe(1250 + 408); // 1658
    expect(mapped.activeIPCount).toBe(0);
  });

  it('calcServerTokenTier returns 2XS for DC01 (nios-x)', () => {
    const m = toNiosMetrics(mockDCs.DC01);
    const tier = calcServerTokenTier(m.qps, m.lps, m.objectCount, 'nios-x');
    expect(tier.name).toBe('2XS');
    expect(tier.serverTokens).toBe(130);
  });

  it('calcServerTokenTier returns S for DC02 (nios-x)', () => {
    // DC02: qps=12000, lps=120, objects=3200+6740=9940
    // QPS 12000 > XS max 10000 -> S; LPS 120 < S max 200; objects 9940 < S max 29000
    const m = toNiosMetrics(mockDCs.DC02);
    expect(m.objectCount).toBe(9940);
    const tier = calcServerTokenTier(m.qps, m.lps, m.objectCount, 'nios-x');
    expect(tier.name).toBe('S');
    expect(tier.serverTokens).toBe(470);
  });

  it('calcServerTokenTier returns M for DC03 (nios-x)', () => {
    // DC03: qps=35000, lps=250, objects=10600+24000=34600
    // QPS 35000 > S max 20000 -> M; LPS 250 < M max 300; objects 34600 < M max 110000
    const m = toNiosMetrics(mockDCs.DC03);
    expect(m.objectCount).toBe(34600);
    const tier = calcServerTokenTier(m.qps, m.lps, m.objectCount, 'nios-x');
    expect(tier.name).toBe('M');
    expect(tier.serverTokens).toBe(880);
  });

  it('consolidateXaasInstances packs all 3 DCs into a single XaaS instance', () => {
    // All 3 DCs as XaaS: aggregate QPS=2800+12000+35000=49800, LPS=45+120+250=415, objects=1658+9940+34600=46198
    // 49800 QPS fits L (70000 max), 415 LPS fits XL (675), objects 46198 fits L (440000)
    // Connections = 3, fits S tier (maxConnections=10) but metrics need L
    const members = [mockDCs.DC01, mockDCs.DC02, mockDCs.DC03].map(toNiosMetrics);
    const result = consolidateXaasInstances(members);
    expect(result).toHaveLength(1);
    expect(result[0].totalQps).toBe(49800);
    expect(result[0].totalLps).toBe(415);
    expect(result[0].totalObjects).toBe(46198);
    expect(result[0].connectionsUsed).toBe(3);
    // LPS 415 > L max 400 -> XL tier
    expect(result[0].tier.name).toBe('XL');
    expect(result[0].extraConnections).toBe(0); // 3 < 85 (XL maxConnections)
    expect(result[0].totalTokens).toBe(result[0].tier.serverTokens); // 8500
  });

  it('single DC mapped to XaaS produces 1 instance with correct token count', () => {
    const members = [toNiosMetrics(mockDCs.DC01)];
    const result = consolidateXaasInstances(members);
    expect(result).toHaveLength(1);
    const inst = result[0];
    expect(inst.connectionsUsed).toBe(1);
    expect(inst.totalQps).toBe(2800);
    expect(inst.totalLps).toBe(45);
    expect(inst.totalObjects).toBe(1658);
    // Metrics fit S tier (qps 2800 < 20000, lps 45 < 200, objects 1658 < 29000)
    // Connections 1 < 10 (S maxConnections)
    expect(inst.tier.name).toBe('S');
    expect(inst.totalTokens).toBe(2400); // S XaaS = 2400 tokens
  });

  it('mixed NIOS-X/XaaS split produces correct totals', () => {
    // Simulate wizard logic: DC01+DC02 as NIOS-X (sum serverTokens), DC03 as XaaS
    const dc01Tier = calcServerTokenTier(
      mockDCs.DC01.qps, mockDCs.DC01.lps,
      mockDCs.DC01.dnsObjects + mockDCs.DC01.dhcpObjectsWithOverhead, 'nios-x',
    );
    const dc02Tier = calcServerTokenTier(
      mockDCs.DC02.qps, mockDCs.DC02.lps,
      mockDCs.DC02.dnsObjects + mockDCs.DC02.dhcpObjectsWithOverhead, 'nios-x',
    );
    const niosXTokens = dc01Tier.serverTokens + dc02Tier.serverTokens; // 130 + 470 = 600

    const xaasMembers = [toNiosMetrics(mockDCs.DC03)];
    const xaasResult = consolidateXaasInstances(xaasMembers);
    expect(xaasResult).toHaveLength(1);
    // DC03: qps=35000, lps=250, objects=34600
    // All fit S tier (qps 35000 > S max 20000 -> M, lps 250 < M max 300, objects 34600 < M max 110000)
    // Connections 1 < 20 (M maxConnections)
    expect(xaasResult[0].tier.name).toBe('M');
    const xaasTokens = xaasResult[0].totalTokens; // 4100

    const totalTokens = niosXTokens + xaasTokens;
    expect(niosXTokens).toBe(600);  // 2XS(130) + S(470)
    expect(xaasTokens).toBe(4100);   // M XaaS
    expect(totalTokens).toBe(4700);
  });
});
