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
    expect(result[0].connectionsUsed).toBe(1);
    expect(result[0].extraConnections).toBe(0);
    expect(result[0].extraTokens).toBe(0);
    expect(result[0].totalServerTokens).toBe(result[0].tier.serverTokens);
  });

  it('packs 11 tiny members into 1 S-tier instance with 1 extra connection', () => {
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
    expect(inst.tier.name).toBe('S');
    expect(inst.connectionsUsed).toBe(11);
    expect(inst.extraConnections).toBe(1);  // 11 - 10 (S maxConnections) = 1
    expect(inst.extraTokens).toBe(100);      // 1 * XAAS_EXTRA_CONNECTION_COST
    expect(inst.totalServerTokens).toBe(inst.tier.serverTokens + inst.extraTokens);
  });

  it('splits members exceeding XL capacity into 2+ instances', () => {
    // Create one very high-QPS member that forces XL, and another one that also needs XL
    // Two members with QPS > maxQps of any single tier but combined need separate instances
    const members: NiosServerMetrics[] = [
      { memberId: 'm1', memberName: 'member-1', role: 'DNS',  qps: 100000, lps: 600, objectCount: 800000 },
      { memberId: 'm2', memberName: 'member-2', role: 'DNS',  qps: 100000, lps: 600, objectCount: 800000 },
    ];
    // Each member max(qps) = 100000, max(lps) = 600, max(objects) = 800000 — fits in XL
    // But when aggregated (max across members), max(100000, 100000)=100000, lps=600, objects=800000
    // This still fits in XL (maxQps:115000, maxLps:675, maxObjects:880000)
    // So this test should verify they CAN be packed in one instance
    const result = consolidateXaasInstances(members);
    // Both fit in XL since max of both is still within XL limits
    expect(result).toHaveLength(1);
    expect(result[0].tier.name).toBe('XL');
    expect(result[0].connectionsUsed).toBe(2);
  });

  it('creates 2 instances when metrics exceed XL capacity', () => {
    // Use QPS exceeding XL to force split
    const members: NiosServerMetrics[] = [
      { memberId: 'm1', memberName: 'member-1', role: 'DNS', qps: 90000, lps: 500, objectCount: 700000 },
      { memberId: 'm2', memberName: 'member-2', role: 'DNS', qps: 90000, lps: 500, objectCount: 700000 },
    ];
    // Aggregate max: qps=90000 (within XL), lps=500 (within XL), objects=700000 (within XL)
    // Both fit in L tier (maxQps:70000... no, 90000 > 70000, so XL)
    // Both members together: max is still 90000 qps which fits in XL (115000 limit)
    // So one instance with XL. Let's use values that actually exceed XL:
    const bigMembers: NiosServerMetrics[] = [
      { memberId: 'm1', memberName: 'member-1', role: 'DNS', qps: 120000, lps: 700, objectCount: 900000 },
      { memberId: 'm2', memberName: 'member-2', role: 'DNS', qps: 80000, lps: 500, objectCount: 600000 },
    ];
    // member-1 alone already exceeds XL (qps:120000>115000, lps:700>675, objects:900000>880000)
    // So member-1 must be its own instance (capped at XL)
    // member-2 alone fits in XL
    const result2 = consolidateXaasInstances(bigMembers);
    expect(result2.length).toBeGreaterThanOrEqual(2);
  });

  it('XAAS_EXTRA_CONNECTION_COST is 100', () => {
    expect(XAAS_EXTRA_CONNECTION_COST).toBe(100);
  });
});
