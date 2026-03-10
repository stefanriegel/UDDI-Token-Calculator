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
      { memberId: 'm1', memberName: 'member-1', role: 'DNS', qps: 100, lps: 1, objectCount: 10 },
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
      { memberId: 'm1', memberName: 'member-1', role: 'DNS',  qps: 60000, lps: 300, objectCount: 400000 },
      { memberId: 'm2', memberName: 'member-2', role: 'DNS',  qps: 50000, lps: 300, objectCount: 400000 },
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
      { memberId: 'm1', memberName: 'member-1', role: 'DNS', qps: 60000, lps: 300, objectCount: 400000 },
      { memberId: 'm2', memberName: 'member-2', role: 'DNS', qps: 60000, lps: 300, objectCount: 400000 },
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
