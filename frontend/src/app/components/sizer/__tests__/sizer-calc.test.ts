/**
 * sizer-calc.test.ts — Unit tests for the Sizer calc engine.
 *
 * Every expected value in this file is computed INLINE from the spec formulas
 * in `docs/superpowers/specs/2026-04-23-enhanced-manual-sizer-v2-design.md`
 * §Token Calculation. Per Phase 29 CONTEXT D-01/D-02:
 *   - No imports from `research-tokens-infoblox-dist.js` (would fail CI).
 *   - No golden-master fixture files.
 *   - Spec formula is the oracle; hand-arithmetic confirms the expectations.
 */

import { describe, it, expect } from 'vitest';

import {
  CALC,
  MGMT_RATES,
  REPORTING_RATES,
  resolveOverheads,
  calculateManagementTokens,
  calculateServerTokens,
  calculateReportingTokens,
  calculateSecurityTokens,
} from '../sizer-calc';
import type {
  Site,
  NiosXSystem,
  XaasServicePoint,
  SecurityInputs,
  SizerState,
  GlobalSettings,
} from '../sizer-types';
import { SERVER_TOKEN_TIERS, XAAS_TOKEN_TIERS } from '../../shared/token-tiers';

// ─── Constant sanity checks ────────────────────────────────────────────────────

describe('CALC / MGMT_RATES / REPORTING_RATES constants', () => {
  it('exports frozen CALC with spec values', () => {
    expect(Object.isFrozen(CALC)).toBe(true);
    expect(CALC.workDayPerMonth).toBe(22);
    expect(CALC.dayPermonth).toBe(31);
    expect(CALC.hoursPerWorkday).toBe(9);
    expect(CALC.dnsRecPerIp).toBe(2);
    expect(CALC.dnsRecPerLease).toBe(3.5);
    expect(CALC.assetMultiplier).toBe(3);
    expect(CALC.socInsightMultiplier).toBe(1.35);
    expect(CALC.dossierListPrice).toBe(4500);
    expect(CALC.lookalikesListPrice).toBe(12000);
    expect(CALC.tokenPrice).toBe(10);
    expect(CALC.CSPQTYEvents).toBe(1e7);
    expect(CALC.S3BucketQTYEvents).toBe(1e7);
    expect(CALC.EcosystemQTYEvents).toBe(1e7);
  });

  it('exports frozen MGMT_RATES = {25, 13, 3}', () => {
    expect(Object.isFrozen(MGMT_RATES)).toBe(true);
    expect(MGMT_RATES.ddi).toBe(25);
    expect(MGMT_RATES.activeIP).toBe(13);
    expect(MGMT_RATES.asset).toBe(3);
  });

  it('exports frozen REPORTING_RATES = {80, 40, 40}', () => {
    expect(Object.isFrozen(REPORTING_RATES)).toBe(true);
    expect(REPORTING_RATES.search).toBe(80);
    expect(REPORTING_RATES.log).toBe(40);
    expect(REPORTING_RATES.cdc).toBe(40);
  });
});

// ─── Test factories ────────────────────────────────────────────────────────────

function makeSite(partial: Partial<Site> = {}): Site {
  return {
    id: 'site-1',
    name: 'Site',
    multiplier: 1,
    users: 1500,
    activeIPs: 2250,
    qps: 4800,
    lps: 1,
    assets: 3000,
    verifiedAssets: 330,
    unverifiedAssets: 2670,
    dhcpPct: 0.8,
    dnsZones: 3,
    networksPerSite: 6,
    dnsRecords: 500,
    dhcpScopes: 6,
    avgLeaseDuration: 1,
    ...partial,
  };
}

function makeGlobalSettings(partial: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    growthBuffer: 0.2,
    growthBufferAdvanced: false,
    ...partial,
  };
}

function makeState(partial: Partial<SizerState> = {}): SizerState {
  return {
    regions: [],
    globalSettings: makeGlobalSettings(),
    security: {
      securityEnabled: false,
      socInsightsEnabled: false,
      tdVerifiedAssets: 0,
      tdUnverifiedAssets: 0,
      dossierQueriesPerDay: 0,
      lookalikeDomainsMentioned: 0,
    },
    infrastructure: { niosx: [], xaas: [] },
    ...partial,
  };
}

// ─── resolveOverheads ──────────────────────────────────────────────────────────

describe('resolveOverheads', () => {
  it('falls back all four to growthBuffer when advanced === false', () => {
    const state = makeState({
      globalSettings: makeGlobalSettings({
        growthBuffer: 0.2,
        growthBufferAdvanced: false,
        mgmtOverhead: 0.99,
        serverOverhead: 0.77,
        reportingOverhead: 0.55,
        securityOverhead: 0.33,
      }),
    });
    const ovh = resolveOverheads(state);
    expect(ovh).toEqual({ mgmt: 0.2, server: 0.2, reporting: 0.2, security: 0.2 });
  });

  it('honors per-category when advanced === true; missing falls back to growthBuffer', () => {
    const state = makeState({
      globalSettings: makeGlobalSettings({
        growthBuffer: 0.1,
        growthBufferAdvanced: true,
        mgmtOverhead: 0.15,
        serverOverhead: 0.25,
        // reportingOverhead intentionally undefined
        securityOverhead: 0.05,
      }),
    });
    const ovh = resolveOverheads(state);
    expect(ovh.mgmt).toBe(0.15);
    expect(ovh.server).toBe(0.25);
    expect(ovh.reporting).toBe(0.1); // falls back to growthBuffer
    expect(ovh.security).toBe(0.05);
  });

  it('returns a frozen object', () => {
    const state = makeState();
    const ovh = resolveOverheads(state);
    expect(Object.isFrozen(ovh)).toBe(true);
  });
});

// ─── calculateManagementTokens ─────────────────────────────────────────────────

describe('calculateManagementTokens', () => {
  it('computes max(ddi/25, ip/13, assets/3) single-site with overhead = 0', () => {
    // dnsRecords=500, dhcpScopes=100 → ddi = 500 + 100*2 = 700
    // activeIPs=2250, assets=3000, multiplier=1
    const sites = [
      makeSite({ dnsRecords: 500, dhcpScopes: 100, activeIPs: 2250, assets: 3000, multiplier: 1 }),
    ];
    // ceil(700/25)=28, ceil(2250/13)=174, ceil(3000/3)=1000 → max=1000
    expect(calculateManagementTokens(sites, 0)).toBe(1000);
  });

  it('applies overhead via ceil(max * (1 + mgmtOverhead))', () => {
    const sites = [
      makeSite({ dnsRecords: 500, dhcpScopes: 100, activeIPs: 2250, assets: 3000, multiplier: 1 }),
    ];
    // max=1000, ovh=0.2 → ceil(1000 * 1.2) = 1200
    expect(calculateManagementTokens(sites, 0.2)).toBe(1200);
  });

  it('aggregates multi-site with multipliers', () => {
    // Site A: dns=100, dhcp=10 → ddi=120; ip=500, assets=300, multiplier=3
    // Site B: dns=200, dhcp=20 → ddi=240; ip=1000, assets=600, multiplier=3
    // ddiTotal = (120 + 240) * 3 = 1080
    // ipTotal = (500 + 1000) * 3 = 4500
    // assetsTotal = (300 + 600) * 3 = 2700
    // ceil(1080/25)=44, ceil(4500/13)=347, ceil(2700/3)=900 → max=900
    const sites = [
      makeSite({ dnsRecords: 100, dhcpScopes: 10, activeIPs: 500, assets: 300, multiplier: 3 }),
      makeSite({
        id: 'site-2',
        name: 'B',
        dnsRecords: 200,
        dhcpScopes: 20,
        activeIPs: 1000,
        assets: 600,
        multiplier: 3,
      }),
    ];
    expect(calculateManagementTokens(sites, 0)).toBe(900);
  });

  it('treats missing Site fields as 0', () => {
    const sites: Site[] = [
      { id: 'x', name: 'empty', multiplier: 1 }, // no numeric fields
    ];
    expect(calculateManagementTokens(sites, 0)).toBe(0);
    expect(calculateManagementTokens(sites, 0.5)).toBe(0);
  });

  it('returns 0 for empty site list', () => {
    expect(calculateManagementTokens([], 0.2)).toBe(0);
  });
});

// ─── calculateServerTokens ─────────────────────────────────────────────────────

describe('calculateServerTokens', () => {
  const niosM = SERVER_TOKEN_TIERS.find((t) => t.name === 'M')!; // 880
  const xaasS = XAAS_TOKEN_TIERS.find((t) => t.name === 'S')!; // 2400 maxConnections=10

  it('NIOS-X only: returns ceil(tier.serverTokens * (1 + ovh))', () => {
    const niosx: NiosXSystem[] = [
      { id: 'n1', name: 'n1', siteId: 's1', formFactor: 'nios-x', tierName: 'M' },
    ];
    // 880 * 1.1 → ceil() with IEEE-754 floating point ≈ 969
    expect(calculateServerTokens(niosx, [], 0.1)).toBe(Math.ceil(niosM.serverTokens * 1.1));
  });

  it('XaaS at maxConnections: no extra penalty', () => {
    const xaas: XaasServicePoint[] = [
      {
        id: 'x1',
        name: 'x1',
        regionId: 'r1',
        tierName: 'S',
        connections: xaasS.maxConnections!, // exactly at max
        connectedSiteIds: [],
        connectivity: 'vpn',
        popLocation: 'aws-us-east-1',
      },
    ];
    // 2400 * 1 = 2400 → ceil(2400) = 2400
    expect(calculateServerTokens([], xaas, 0)).toBe(xaasS.serverTokens);
  });

  it('XaaS over-connection: adds (extras * 100) tokens', () => {
    const xaas: XaasServicePoint[] = [
      {
        id: 'x1',
        name: 'x1',
        regionId: 'r1',
        tierName: 'S',
        connections: xaasS.maxConnections! + 7, // 7 extras
        connectedSiteIds: [],
        connectivity: 'vpn',
        popLocation: 'aws-us-east-1',
      },
    ];
    // extras = 7 * 100 = 700; base = 2400; total = 3100; ovh = 0 → 3100
    expect(calculateServerTokens([], xaas, 0)).toBe(xaasS.serverTokens + 700);
  });

  it('Mixed NIOS + XaaS with overhead', () => {
    const niosx: NiosXSystem[] = [
      { id: 'n1', name: 'n1', siteId: 's1', formFactor: 'nios-x', tierName: 'M' }, // 880
    ];
    const xaas: XaasServicePoint[] = [
      {
        id: 'x1',
        name: 'x1',
        regionId: 'r1',
        tierName: 'S',
        connections: xaasS.maxConnections! + 3, // extras = 300
        connectedSiteIds: [],
        connectivity: 'vpn',
        popLocation: 'aws-us-east-1',
      },
    ];
    // sum = 880 + (2400 + 300) = 3580; ovh = 0.1 → ceil(3580 * 1.1) — IEEE-754 floating point
    expect(calculateServerTokens(niosx, xaas, 0.1)).toBe(Math.ceil((880 + 2400 + 300) * 1.1));
  });

  it('Unknown tierName: system silently skipped', () => {
    const niosx: NiosXSystem[] = [
      { id: 'n1', name: 'n1', siteId: 's1', formFactor: 'nios-x', tierName: 'NOPE' },
    ];
    expect(calculateServerTokens(niosx, [], 0)).toBe(0);
  });

  it('returns 0 for empty inputs', () => {
    expect(calculateServerTokens([], [], 0.5)).toBe(0);
  });
});

// ─── calculateReportingTokens ──────────────────────────────────────────────────

describe('calculateReportingTokens', () => {
  const allTogglesOff = {
    csp: false,
    s3: false,
    cdc: false,
    dnsEnabled: false,
    dhcpEnabled: false,
  };

  // Shared site fixture used by hand-arithmetic assertions below.
  // activeIPs=2250, dhcpPct=0.8 → dhcpIPs = 1800
  // dnsRecords=500 → Dynamic = (500 - 1800*2) / (3.5 - 2) = (500 - 3600)/1.5 = -2066.67 < 0
  //   → fallback Static = 0.2*1800 = 360, Dynamic = 0.8*1800 = 1440
  // qps=4800 → dnsQPD = 4800 * 86400 = 414_720_000
  // leaseDuration=1, multiplier=1
  const site = makeSite({
    activeIPs: 2250,
    dhcpPct: 0.8,
    dnsRecords: 500,
    qps: 4800,
    avgLeaseDuration: 1,
    multiplier: 1,
  });
  const StaticIPs = 360;
  const DynamicIPs = 1440;
  const dnsQPD = 4800 * 86400;

  it('all destination toggles off → 0', () => {
    expect(calculateReportingTokens([site], 0.1, allTogglesOff)).toBe(0);
  });

  it('all DNS/DHCP toggles off but CSP on → 0 logs → ceil(0/1e7) * 80 = 0', () => {
    expect(
      calculateReportingTokens([site], 0.1, {
        csp: true,
        s3: false,
        cdc: false,
        dnsEnabled: false,
        dhcpEnabled: false,
      }),
    ).toBe(0);
  });

  it('DNS-only + CSP-only matches spec formula exactly', () => {
    // dnsLogs = dnsQPD * (31 * StaticIPs + 22 * DynamicIPs) * multiplier
    const dnsLogs = dnsQPD * (31 * StaticIPs + 22 * DynamicIPs) * 1;
    const totalLogs = dnsLogs;
    // searchTk = ceil(ceil(totalLogs / 1e7) * (1+ovh) * 80)
    const ovh = 0.1;
    const expected = Math.ceil(Math.ceil(totalLogs / 1e7) * (1 + ovh) * 80);

    expect(
      calculateReportingTokens([site], ovh, {
        csp: true,
        s3: false,
        cdc: false,
        dnsEnabled: true,
        dhcpEnabled: false,
      }),
    ).toBe(expected);
  });

  it('DHCP-only + CDC-only matches spec formula exactly', () => {
    // dhcpLogs = (1 + 9 / (leaseDuration / 2)) * 22 * DynamicIPs * multiplier
    const leaseDuration = 1;
    const dhcpLogs = (1 + 9 / (leaseDuration / 2)) * 22 * DynamicIPs * 1;
    const totalLogs = dhcpLogs;
    const ovh = 0;
    // cdcTk = ceil(ceil(totalLogs / 1e7) * 1 * 40)
    const expected = Math.ceil(Math.ceil(totalLogs / 1e7) * (1 + ovh) * 40);

    expect(
      calculateReportingTokens([site], ovh, {
        csp: false,
        s3: false,
        cdc: true,
        dnsEnabled: false,
        dhcpEnabled: true,
      }),
    ).toBe(expected);
  });

  it('all destinations + both DNS/DHCP: sum of three applyDest calls', () => {
    const leaseDuration = 1;
    const dnsLogs = dnsQPD * (31 * StaticIPs + 22 * DynamicIPs);
    const dhcpLogs = (1 + 9 / (leaseDuration / 2)) * 22 * DynamicIPs;
    const totalLogs = dnsLogs + dhcpLogs;
    const ovh = 0.05;
    const per = (rate: number) => Math.ceil(Math.ceil(totalLogs / 1e7) * (1 + ovh) * rate);
    const expected = per(80) + per(40) + per(40);

    expect(
      calculateReportingTokens([site], ovh, {
        csp: true,
        s3: true,
        cdc: true,
        dnsEnabled: true,
        dhcpEnabled: true,
      }),
    ).toBe(expected);
  });

  it('two sites with different multipliers aggregate before rate application', () => {
    const siteA = makeSite({
      id: 'a',
      activeIPs: 2250,
      dhcpPct: 0.8,
      dnsRecords: 500,
      qps: 4800,
      avgLeaseDuration: 1,
      multiplier: 2,
    });
    const siteB = makeSite({
      id: 'b',
      activeIPs: 2250,
      dhcpPct: 0.8,
      dnsRecords: 500,
      qps: 4800,
      avgLeaseDuration: 1,
      multiplier: 3,
    });
    // Each site produces same per-unit logs; multiplier 2 + 3 = 5
    const dnsLogsPerUnit = dnsQPD * (31 * StaticIPs + 22 * DynamicIPs);
    const totalLogs = dnsLogsPerUnit * 2 + dnsLogsPerUnit * 3;
    const ovh = 0;
    const expected = Math.ceil(Math.ceil(totalLogs / 1e7) * (1 + ovh) * 80);

    expect(
      calculateReportingTokens([siteA, siteB], ovh, {
        csp: true,
        s3: false,
        cdc: false,
        dnsEnabled: true,
        dhcpEnabled: false,
      }),
    ).toBe(expected);
  });
});

// ─── calculateSecurityTokens ───────────────────────────────────────────────────

describe('calculateSecurityTokens', () => {
  function makeSec(partial: Partial<SecurityInputs> = {}): SecurityInputs {
    return {
      securityEnabled: true,
      socInsightsEnabled: false,
      tdVerifiedAssets: 0,
      tdUnverifiedAssets: 0,
      dossierQueriesPerDay: 0,
      lookalikeDomainsMentioned: 0,
      ...partial,
    };
  }

  it('returns 0 when securityEnabled === false regardless of other fields', () => {
    const inputs = makeSec({
      securityEnabled: false,
      tdVerifiedAssets: 1000,
      tdUnverifiedAssets: 500,
      dossierQueriesPerDay: 100,
      lookalikeDomainsMentioned: 50,
    });
    expect(calculateSecurityTokens(inputs, 0.2)).toBe(0);
  });

  it('enabled without SOC: tdCloud = ceil((v+u) * 3 * (1+ovh)); dossier & lookalikes = 0', () => {
    // (100 + 50) * 3 * 1.1 → Math.ceil() (IEEE-754 float math)
    const inputs = makeSec({ tdVerifiedAssets: 100, tdUnverifiedAssets: 50 });
    const expectedTdCloud = Math.ceil((100 + 50) * 3 * 1.1);
    expect(calculateSecurityTokens(inputs, 0.1)).toBe(expectedTdCloud);
  });

  it('enabled with SOC: tdCloud includes 1.35× multiplier', () => {
    // (100 + 50) * 3 * 1.35 = 607.5; * 1 = 607.5; ceil=608
    const inputs = makeSec({
      tdVerifiedAssets: 100,
      tdUnverifiedAssets: 50,
      socInsightsEnabled: true,
    });
    const expected = Math.ceil((100 + 50) * 3 * 1.35 * 1);
    expect(calculateSecurityTokens(inputs, 0)).toBe(expected);
    expect(expected).toBe(608);
  });

  it('dossier rounding: ceil(25/25)=1 * 450 * (1+ovh), Math.ceil applied', () => {
    // tdCloud=0, dossier = 1 * 450 * 1.1 = 495; ceil(495) = 495
    const inputs = makeSec({ dossierQueriesPerDay: 25 });
    // 495.0 is exact; try a value that would exercise ceil
    const expected = 0 + Math.ceil(1 * 450 * 1.1) + Math.round(0);
    expect(calculateSecurityTokens(inputs, 0.1)).toBe(expected);
  });

  it('lookalikes rounding: ceil(37/25)=2 * 1200 * (1+ovh), Math.round applied', () => {
    // ceil(37/25) = 2; 2 * 1200 * 1.1 = 2640; round(2640)=2640
    const inputs = makeSec({ lookalikeDomainsMentioned: 37 });
    const expected = 0 + Math.ceil(0) + Math.round(2 * 1200 * 1.1);
    expect(calculateSecurityTokens(inputs, 0.1)).toBe(expected);
    expect(expected).toBe(2640);
  });

  it('lookalikes Math.round differs from Math.ceil for fractional results', () => {
    // Craft ovh so lookalikes is non-integer and ceil != round.
    // ceil(1/25) = 1; 1 * 1200 * 1.001 = 1201.2 → round=1201, ceil=1202
    const inputs = makeSec({ lookalikeDomainsMentioned: 1 });
    const lookalikesRaw = 1 * 1200 * 1.001;
    expect(Math.round(lookalikesRaw)).toBe(1201);
    expect(Math.ceil(lookalikesRaw)).toBe(1202);
    expect(calculateSecurityTokens(inputs, 0.001)).toBe(Math.round(lookalikesRaw));
  });

  it('combined: all three categories with overhead = 0.1', () => {
    const inputs = makeSec({
      tdVerifiedAssets: 100,
      tdUnverifiedAssets: 50,
      socInsightsEnabled: true,
      dossierQueriesPerDay: 25,
      lookalikeDomainsMentioned: 37,
    });
    const ovh = 0.1;
    const tdCloud = Math.ceil((100 + 50) * 3 * 1.35 * (1 + ovh));
    const dossier = Math.ceil(Math.ceil(25 / 25) * 450 * (1 + ovh));
    const lookalikes = Math.round(Math.ceil(37 / 25) * 1200 * (1 + ovh));
    expect(calculateSecurityTokens(inputs, ovh)).toBe(tdCloud + dossier + lookalikes);
  });
});
