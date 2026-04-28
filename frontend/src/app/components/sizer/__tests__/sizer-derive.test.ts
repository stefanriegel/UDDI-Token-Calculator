/**
 * sizer-derive.test.ts — coverage for SIZER-04 (5-tier derive engine).
 *
 * Strategy per Phase 29 D-01/D-02: expected values come from the spec
 * formula arithmetic inline. No fixture files, no `research-tokens-infoblox-dist.js`.
 *
 * Test structure:
 *   1. Snapshot lock at [500, 1500, 3000, 7500, 20000] — SIZER-04 breakpoints,
 *      one sample per tier. Plus invariant assertions.
 *   2. Override precedence (D-09) — one test per DeriveOverrides key;
 *      `verifiedAssets` coupling through `assets` override; composite lps
 *      override via activeIPs + dhcpPct.
 *   3. CALC_HEURISTICS integrity — frozen-ness, tier ordering, pinned
 *      spec constants.
 */

import { describe, it, expect } from 'vitest';
import {
  CALC_HEURISTICS,
  deriveFromUsers,
  deriveMembersFromNiosx,
  deriveSizerResultsProps,
  computeSizerMgmtScenarios,
} from '../sizer-derive';
import { calculateManagementTokens } from '../sizer-calc';
import type {
  DeriveOverrides,
  NiosXSystem,
  Region,
  SizerState,
} from '../sizer-types';
import { initialSizerState } from '../sizer-state';

// Breakpoints chosen so each tier of CALC_HEURISTICS.tiers is crossed once:
//   500 → tier 0 (maxUsers 1249)
//   1500 → tier 1 (maxUsers 2499)
//   3000 → tier 2 (maxUsers 4999)
//   7500 → tier 3 (maxUsers 9999)
//   20000 → tier 4 (maxUsers Infinity)
const SNAPSHOT_USERS = [500, 1500, 3000, 7500, 20000] as const;

describe('deriveFromUsers - snapshot (SIZER-04)', () => {
  it('returns stable output for [500, 1500, 3000, 7500, 20000]', () => {
    const results = SNAPSHOT_USERS.map((users) => ({
      users,
      derived: deriveFromUsers(users),
    }));
    expect(results).toMatchSnapshot();
  });

  it('verifiedAssets + unverifiedAssets === assets for every breakpoint', () => {
    for (const users of SNAPSHOT_USERS) {
      const d = deriveFromUsers(users);
      expect(d.verifiedAssets + d.unverifiedAssets).toBe(d.assets);
    }
  });

  it('lps >= CALC_HEURISTICS.lpsMin for every breakpoint', () => {
    for (const users of SNAPSHOT_USERS) {
      const d = deriveFromUsers(users);
      expect(d.lps).toBeGreaterThanOrEqual(CALC_HEURISTICS.lpsMin);
    }
  });
});

describe('deriveFromUsers - override precedence (D-09)', () => {
  // Per-field override sentinels chosen to be obviously-wrong (would never be
  // produced by the formula at users=1500). Covers every DeriveOverrides key.
  const cases: Array<[keyof DeriveOverrides, number]> = [
    ['activeIPs', 99999],
    ['qps', 99999],
    ['assets', 99999],
    ['networksPerSite', 99999],
    ['dnsZones', 99999],
    ['dhcpScopes', 99999],
    ['dhcpPct', 0.12345],
    ['avgLeaseDuration', 99999],
    ['lps', 99999],
  ];

  for (const [key, sentinel] of cases) {
    it(`override.${key} wins over computed value`, () => {
      const result = deriveFromUsers(1500, { [key]: sentinel } as DeriveOverrides);
      expect(result[key]).toBe(sentinel);
    });
  }

  it('overriding `assets` recomputes verifiedAssets from the override × tier.verifiedPct', () => {
    // At users=1500 the selected tier has verifiedPct = 0.11 (second tier).
    const tier = CALC_HEURISTICS.tiers.find((t) => 1500 <= t.maxUsers)!;
    const override = 10;
    const result = deriveFromUsers(1500, { assets: override });
    expect(result.assets).toBe(override);
    expect(result.verifiedAssets).toBe(Math.round(override * tier.verifiedPct));
    expect(result.unverifiedAssets).toBe(override - result.verifiedAssets);
  });

  it('overriding both activeIPs and dhcpPct changes lps via the formula', () => {
    const activeIPs = 10000;
    const dhcpPct = 0.5;
    // avgLeaseDuration defaults to CALC_HEURISTICS.avgLeaseDurationHours = 1
    // dhcpIPs = 10000 * 0.5 = 5000; lps = max(1, ceil(5000 / 3600)) = 2
    const expectedLps = Math.max(
      CALC_HEURISTICS.lpsMin,
      Math.ceil((activeIPs * dhcpPct) / (CALC_HEURISTICS.avgLeaseDurationHours * 3600)),
    );
    const result = deriveFromUsers(1500, { activeIPs, dhcpPct });
    expect(result.lps).toBe(expectedLps);
  });
});

describe('CALC_HEURISTICS - integrity', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(CALC_HEURISTICS)).toBe(true);
  });

  it('tier maxUsers are strictly ascending and end at Infinity', () => {
    const maxUsersList = CALC_HEURISTICS.tiers.map((t) => t.maxUsers);
    for (let i = 1; i < maxUsersList.length; i++) {
      expect(maxUsersList[i]).toBeGreaterThan(maxUsersList[i - 1]);
    }
    expect(maxUsersList[maxUsersList.length - 1]).toBe(Infinity);
  });

  it('pins spec constants: qpsPerUser=3.2, activeIPsPerUser=1.5, dhcpPct=0.8', () => {
    expect(CALC_HEURISTICS.qpsPerUser).toBe(3.2);
    expect(CALC_HEURISTICS.activeIPsPerUser).toBe(1.5);
    expect(CALC_HEURISTICS.dhcpPct).toBe(0.8);
  });

  it('pins spec constants: usersPerNetwork=250, usersPerZone=500, avgLeaseDurationHours=1, lpsMin=1', () => {
    expect(CALC_HEURISTICS.usersPerNetwork).toBe(250);
    expect(CALC_HEURISTICS.usersPerZone).toBe(500);
    expect(CALC_HEURISTICS.avgLeaseDurationHours).toBe(1);
    expect(CALC_HEURISTICS.lpsMin).toBe(1);
  });

  it('tier 0 (maxUsers=1249) has assetsPerUser=2 and verifiedPct=0.22', () => {
    const t = CALC_HEURISTICS.tiers[0];
    expect(t.maxUsers).toBe(1249);
    expect(t.assetsPerUser).toBe(2);
    expect(t.verifiedPct).toBe(0.22);
  });

  it('final tier (Infinity) has assetsPerUser=1 and verifiedPct=0.18', () => {
    const t = CALC_HEURISTICS.tiers[CALC_HEURISTICS.tiers.length - 1];
    expect(t.maxUsers).toBe(Infinity);
    expect(t.assetsPerUser).toBe(1);
    expect(t.verifiedPct).toBe(0.18);
  });
});

// ─── Phase 33 Plan 06: deriveSizerResultsProps ───────────────────────────────

/**
 * Local fixture builder — vitest spread-defaults pattern. Returns the
 * Sizer-state core slice (which is what `deriveSizerResultsProps` accepts).
 * Not exported; co-located with the only call site that needs it.
 */
function makeSizerState(over: Partial<SizerState> = {}): SizerState {
  const base = initialSizerState().core;
  return { ...base, ...over };
}

/** Single Region → Country → City → Site tree, parameterized by `users`. */
function regionWithSite(opts: {
  regionId?: string;
  siteId?: string;
  users?: number;
}) {
  const { regionId = 'region-1', siteId = 'site-1', users = 500 } = opts;
  return {
    id: regionId,
    name: 'EMEA',
    type: 'on-premises' as const,
    cloudNativeDns: false,
    countries: [
      {
        id: `${regionId}-c1`,
        name: 'Germany',
        cities: [
          {
            id: `${regionId}-city1`,
            name: 'Berlin',
            sites: [
              {
                id: siteId,
                name: 'HQ',
                multiplier: 1,
                users,
                activeIPs: Math.ceil(users * 1.5),
                qps: Math.ceil(users * 3.2),
                lps: 1,
                assets: users * 2,
                verifiedAssets: Math.round(users * 2 * 0.22),
                unverifiedAssets: users * 2 - Math.round(users * 2 * 0.22),
                dnsRecords: 1000,
                dhcpScopes: 5,
                dhcpPct: 0.8,
                avgLeaseDuration: 1,
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('deriveSizerResultsProps (Phase 33 Plan 05/06)', () => {
  it('empty state (no regions): zeros for all token totals; hasServerMetrics=false; outline = 3 entries', () => {
    const state = makeSizerState();
    const out = deriveSizerResultsProps(state);

    expect(out.totalManagementTokens).toBe(0);
    expect(out.totalServerTokens).toBe(0);
    expect(out.reportingTokens).toBe(0);
    expect(out.securityTokens).toBe(0);
    expect(out.hasServerMetrics).toBe(false);

    expect(out.outlineSections).toHaveLength(3);
    expect(out.outlineSections.map((s) => s.id)).toEqual([
      'section-overview',
      'section-bom',
      'section-export',
    ]);
  });

  it('1 region / 1 site / 1 NIOS-X member: management + server tokens > 0; hasServerMetrics=true', () => {
    const state = makeSizerState({
      regions: [regionWithSite({ users: 500 })],
      infrastructure: {
        niosx: [
          {
            id: 'nx-1',
            name: 'NX-1',
            siteId: 'site-1',
            formFactor: 'nios-x',
            tierName: 'M',
          },
        ],
        xaas: [],
      },
    });
    const out = deriveSizerResultsProps(state);

    expect(out.totalManagementTokens).toBeGreaterThan(0);
    expect(out.totalServerTokens).toBeGreaterThan(0);
    expect(out.hasServerMetrics).toBe(true);
  });

  it('reporting toggles enabled (csp/s3/cdc): reportingTokens > 0', () => {
    const base = initialSizerState().core;
    const state: SizerState = {
      ...base,
      regions: [regionWithSite({ users: 500 })],
      globalSettings: {
        ...base.globalSettings,
        reportingCsp: true,
        reportingS3: true,
        reportingCdc: true,
        dnsLoggingEnabled: true,
        dhcpLoggingEnabled: true,
      },
    };
    const out = deriveSizerResultsProps(state);
    expect(out.reportingTokens).toBeGreaterThan(0);
  });

  it('security enabled with verified+unverified counts: securityTokens > 0', () => {
    const base = initialSizerState().core;
    const state: SizerState = {
      ...base,
      regions: [regionWithSite({ users: 500 })],
      security: {
        securityEnabled: true,
        socInsightsEnabled: false,
        tdVerifiedAssets: 100,
        tdUnverifiedAssets: 50,
        dossierQueriesPerDay: 0,
        lookalikeDomainsMentioned: 0,
      },
    };
    const out = deriveSizerResultsProps(state);
    expect(out.securityTokens).toBeGreaterThan(0);
  });

  it('pure Sizer flow: scan-side migration data stays empty/null (D-07); per-Site findings populate the hero by-source breakdown (Issue #11)', () => {
    const state = makeSizerState({
      regions: [regionWithSite({ users: 1500 })],
    });
    const out = deriveSizerResultsProps(state);

    // D-07 — no scan-side providers, hybrid scenario, or pre-computed breakdown.
    expect(out.selectedProviders).toEqual([]);
    expect(out.hybridScenario).toBeNull();
    expect(out.breakdownBySource).toEqual([]);

    // Issue #11 — findings carry one row per Site so the hero's "By Source —
    // Management" breakdown renders meaningful rows in Sizer mode.
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.effectiveFindings).toBe(out.findings);
    for (const row of out.findings) {
      expect(row.provider).toBe('nios');
      expect(row.managementTokens).toBeGreaterThan(0);
      expect(typeof row.source).toBe('string');
      expect(row.source.length).toBeGreaterThan(0);
    }
  });

  it('outlineSections always returns exactly the 3 pure-Sizer ids regardless of state', () => {
    const cases: SizerState[] = [
      makeSizerState(), // empty
      makeSizerState({ regions: [regionWithSite({ users: 100 })] }), // 1 region
      makeSizerState({
        regions: [
          regionWithSite({ regionId: 'r1', siteId: 's1', users: 500 }),
          regionWithSite({ regionId: 'r2', siteId: 's2', users: 9000 }),
        ],
      }), // 2 regions
    ];
    for (const state of cases) {
      const out = deriveSizerResultsProps(state);
      expect(out.outlineSections.map((s) => s.id)).toEqual([
        'section-overview',
        'section-bom',
        'section-export',
      ]);
    }
  });

  it('growthBufferPct + serverGrowthBufferPct mirror state.globalSettings.growthBuffer', () => {
    const base = initialSizerState().core;
    const state: SizerState = {
      ...base,
      globalSettings: { ...base.globalSettings, growthBuffer: 0.35 },
    };
    const out = deriveSizerResultsProps(state);
    expect(out.growthBufferPct).toBe(0.35);
    expect(out.serverGrowthBufferPct).toBe(0.35);
  });
});

// ─── Phase 34 Plan 04: deriveMembersFromNiosx (D-01/D-02) ────────────────────

/**
 * Build a single Region containing the given Sites, grouped under one
 * Country/City. The adapter only needs to look up Sites by id, so the
 * intermediate names don't matter — but the tree structure does.
 */
function regionWithSites(
  regionId: string,
  sites: Array<{
    id: string;
    name?: string;
    activeIPs?: number;
    qps?: number;
    lps?: number;
    users?: number;
    dnsRecords?: number;
    dhcpScopes?: number;
    multiplier?: number;
  }>,
): Region {
  return {
    id: regionId,
    name: 'EMEA',
    type: 'on-premises',
    cloudNativeDns: false,
    countries: [
      {
        id: `${regionId}-c1`,
        name: 'Germany',
        cities: [
          {
            id: `${regionId}-city1`,
            name: 'Berlin',
            sites: sites.map((s) => ({
              id: s.id,
              name: s.name ?? `site-${s.id}`,
              multiplier: s.multiplier ?? 1,
              users: s.users,
              activeIPs: s.activeIPs,
              qps: s.qps,
              lps: s.lps,
              dnsRecords: s.dnsRecords,
              dhcpScopes: s.dhcpScopes,
            })),
          },
        ],
      },
    ],
  };
}

function nx(over: Partial<NiosXSystem> & Pick<NiosXSystem, 'id' | 'name' | 'siteId'>): NiosXSystem {
  return {
    formFactor: 'nios-x',
    tierName: 'M',
    ...over,
  };
}

describe('deriveMembersFromNiosx (Phase 34 Plan 04, D-01/D-02)', () => {
  it('empty niosx array → empty result', () => {
    expect(deriveMembersFromNiosx([], [])).toEqual([]);
  });

  it('3 niosx members → 3 NiosServerMetrics in input order', () => {
    const region = regionWithSites('r1', [
      { id: 's1', activeIPs: 100, qps: 10, lps: 1 },
      { id: 's2', activeIPs: 200, qps: 20, lps: 2 },
      { id: 's3', activeIPs: 300, qps: 30, lps: 3 },
    ]);
    const niosx: NiosXSystem[] = [
      nx({ id: 'm1', name: 'gm.example.com', siteId: 's1' }),
      nx({ id: 'm2', name: 'dns1.example.com', siteId: 's2' }),
      nx({ id: 'm3', name: 'dhcp1.example.com', siteId: 's3' }),
    ];
    const out = deriveMembersFromNiosx(niosx, [region]);
    expect(out).toHaveLength(3);
    expect(out.map((m) => m.memberId)).toEqual(['m1', 'm2', 'm3']);
    expect(out.map((m) => m.memberName)).toEqual([
      'gm.example.com',
      'dns1.example.com',
      'dhcp1.example.com',
    ]);
  });

  it('per-site metrics (activeIPs, qps, lps) flow through to NiosServerMetrics fields', () => {
    const region = regionWithSites('r1', [
      { id: 's1', activeIPs: 12345, qps: 678, lps: 90 },
    ]);
    const niosx: NiosXSystem[] = [nx({ id: 'm1', name: 'NX-1', siteId: 's1' })];
    const out = deriveMembersFromNiosx(niosx, [region]);
    expect(out[0].activeIPCount).toBe(12345);
    expect(out[0].qps).toBe(678);
    expect(out[0].lps).toBe(90);
  });

  it('member name + tierName-derived role/model are preserved on the output', () => {
    const region = regionWithSites('r1', [{ id: 's1', activeIPs: 10 }]);
    const niosx: NiosXSystem[] = [
      nx({ id: 'm1', name: 'host-a.lab', siteId: 's1', formFactor: 'nios-x', tierName: 'L' }),
    ];
    const out = deriveMembersFromNiosx(niosx, [region]);
    expect(out[0].memberId).toBe('m1');
    expect(out[0].memberName).toBe('host-a.lab');
    // model/platform are populated (non-empty) so downstream presenters
    // (`results-migration-planner.tsx`) don't surface "—"/"unknown" cells.
    expect(typeof out[0].model).toBe('string');
    expect(out[0].model.length).toBeGreaterThan(0);
    expect(typeof out[0].platform).toBe('string');
    // role is a string; for NIOS-X members with no explicit role we default
    // to a benign value rather than leaving it empty.
    expect(typeof out[0].role).toBe('string');
    expect(out[0].role.length).toBeGreaterThan(0);
  });

  it('joins niosx.siteId to the matching Site in regions[]; missing sites fall back to defined zero defaults', () => {
    const region = regionWithSites('r1', [{ id: 's1', activeIPs: 99, qps: 11, lps: 1 }]);
    const niosx: NiosXSystem[] = [
      nx({ id: 'm1', name: 'has-site', siteId: 's1' }),
      nx({ id: 'm2', name: 'orphan', siteId: 'no-such-site' }),
    ];
    const out = deriveMembersFromNiosx(niosx, [region]);
    // Joined member picks up site metrics.
    expect(out[0].activeIPCount).toBe(99);
    expect(out[0].qps).toBe(11);
    expect(out[0].lps).toBe(1);
    // Orphan member falls back to defined zero defaults — never undefined,
    // so the NiosServerMetrics contract holds for downstream consumers.
    expect(out[1].activeIPCount).toBe(0);
    expect(out[1].qps).toBe(0);
    expect(out[1].lps).toBe(0);
    expect(out[1].objectCount).toBe(0);
    expect(out[1].managedIPCount).toBe(0);
    expect(out[1].staticHosts).toBe(0);
    expect(out[1].dynamicHosts).toBe(0);
    expect(out[1].dhcpUtilization).toBe(0);
  });

  it('issue #5: projects DDI object count from Site (dnsRecords + dhcpScopes×2) × multiplier', () => {
    const region = regionWithSites('r1', [
      { id: 's1', activeIPs: 5250, qps: 11200, lps: 2, dnsRecords: 1000, dhcpScopes: 50, multiplier: 1 },
    ]);
    const niosx: NiosXSystem[] = [nx({ id: 'm1', name: 'NX-1', siteId: 's1' })];
    const out = deriveMembersFromNiosx(niosx, [region]);
    // (1000 + 50×2) × 1 = 1100
    expect(out[0].objectCount).toBe(1100);
    // Existing fields stay consistent.
    expect(out[0].activeIPCount).toBe(5250);
    expect(out[0].qps).toBe(11200);
    expect(out[0].lps).toBe(2);
  });

  it('issue #5: DDI object count scales with site multiplier', () => {
    const region = regionWithSites('r1', [
      { id: 's1', dnsRecords: 200, dhcpScopes: 10, multiplier: 5 },
    ]);
    const niosx: NiosXSystem[] = [nx({ id: 'm1', name: 'NX-1', siteId: 's1' })];
    const out = deriveMembersFromNiosx(niosx, [region]);
    // (200 + 10×2) × 5 = 1100
    expect(out[0].objectCount).toBe(1100);
  });

  it('issue #8: managementTokens omitted when mgmtOverhead is undefined', () => {
    const region = regionWithSites('r1', [
      { id: 's1', dnsRecords: 1000, dhcpScopes: 50, multiplier: 1, activeIPs: 100 },
    ]);
    const niosx: NiosXSystem[] = [nx({ id: 'm1', name: 'NX-1', siteId: 's1' })];
    const out = deriveMembersFromNiosx(niosx, [region]);
    expect(out[0].managementTokens).toBeUndefined();
  });

  it('issue #8: managementTokens populated per-member from site mgmt tokens when mgmtOverhead supplied', () => {
    const region = regionWithSites('r1', [
      { id: 's1', dnsRecords: 1000, dhcpScopes: 50, multiplier: 1, activeIPs: 100 },
    ]);
    const niosx: NiosXSystem[] = [nx({ id: 'm1', name: 'NX-1', siteId: 's1' })];
    const out = deriveMembersFromNiosx(niosx, [region], 0);
    // ddiObjects=1100 → ceil(1100/25)=44; activeIPs=100 → ceil(100/13)=8;
    // assets=0; max=44; ×(1+0)=44.
    expect(out[0].managementTokens).toBe(44);
  });

  it('issue #8: managementTokens evenly distributed across members at the same Site', () => {
    const region = regionWithSites('r1', [
      { id: 's1', dnsRecords: 1000, dhcpScopes: 50, multiplier: 1, activeIPs: 100 },
    ]);
    const niosx: NiosXSystem[] = [
      nx({ id: 'm1', name: 'NX-1', siteId: 's1' }),
      nx({ id: 'm2', name: 'NX-2', siteId: 's1' }),
    ];
    const out = deriveMembersFromNiosx(niosx, [region], 0);
    // Site mgmt = 44; 2 members → ceil(44/2) = 22 each.
    expect(out[0].managementTokens).toBe(22);
    expect(out[1].managementTokens).toBe(22);
  });

  it('Issue #12: members sharing a name get a " #N" suffix so planner Maps/Sets keyed by memberName stay 1:1 with the array', () => {
    const region = regionWithSites('r1', [
      { id: 's1', activeIPs: 10, qps: 1, lps: 1 },
      { id: 's2', activeIPs: 20, qps: 2, lps: 2 },
    ]);
    const niosx: NiosXSystem[] = [
      nx({ id: 'm1', name: 'New NIOS-X', siteId: 's1' }),
      nx({ id: 'm2', name: 'New NIOS-X', siteId: 's2' }),
      nx({ id: 'm3', name: 'unique', siteId: 's1' }),
    ];
    const out = deriveMembersFromNiosx(niosx, [region]);
    const names = out.map((m) => m.memberName);
    expect(new Set(names).size).toBe(out.length);
    expect(names).toEqual(['New NIOS-X #1', 'New NIOS-X #2', 'unique']);
  });

  it('does not mutate input arrays', () => {
    const region = regionWithSites('r1', [{ id: 's1', activeIPs: 10, qps: 1, lps: 1 }]);
    const niosx: NiosXSystem[] = [nx({ id: 'm1', name: 'X', siteId: 's1' })];
    const niosxSnap = JSON.stringify(niosx);
    const regionsSnap = JSON.stringify([region]);
    deriveMembersFromNiosx(niosx, [region]);
    expect(JSON.stringify(niosx)).toBe(niosxSnap);
    expect(JSON.stringify([region])).toBe(regionsSnap);
  });
});

// ─── Issue #6: computeSizerMgmtScenarios ─────────────────────────────────────

describe('computeSizerMgmtScenarios (Issue #6 — Sizer migration-planner mgmt scenarios)', () => {
  it('returns 0/0/0 when there are no regions and no niosx members', () => {
    const out = computeSizerMgmtScenarios([], [], 0, new Set());
    expect(out).toEqual({ current: 0, hybrid: 0, full: 0 });
  });

  it('full scenario equals calculateManagementTokens over all sites (matches hero total)', () => {
    const region = regionWithSites('r1', [
      { id: 's1', dnsRecords: 1000, dhcpScopes: 50, activeIPs: 5000, multiplier: 1 },
    ]);
    // Site assets default to 0 in the helper builder; rely on activeIPs for max-of-three.
    const niosx = [{ name: 'NX-1', siteId: 's1' }];
    const mgmtOverhead = 0.2;
    const out = computeSizerMgmtScenarios(niosx, [region], mgmtOverhead, new Set(['NX-1']));
    const expectedFull = calculateManagementTokens(region.countries[0].cities[0].sites, mgmtOverhead);
    expect(out.full).toBe(expectedFull);
    expect(out.full).toBeGreaterThan(0);
  });

  it('current is always 0 (Sizer baseline = nothing migrated)', () => {
    const region = regionWithSites('r1', [
      { id: 's1', dnsRecords: 500, dhcpScopes: 10, activeIPs: 800, multiplier: 1 },
    ]);
    const niosx = [{ name: 'NX-1', siteId: 's1' }];
    const out = computeSizerMgmtScenarios(niosx, [region], 0, new Set(['NX-1']));
    expect(out.current).toBe(0);
  });

  it('hybrid covers only sites of migrating members; non-migrating sites excluded', () => {
    const region = regionWithSites('r1', [
      { id: 's1', dnsRecords: 1000, dhcpScopes: 50, activeIPs: 5000, multiplier: 1 },
      { id: 's2', dnsRecords: 1000, dhcpScopes: 50, activeIPs: 5000, multiplier: 1 },
    ]);
    const niosx = [
      { name: 'NX-1', siteId: 's1' },
      { name: 'NX-2', siteId: 's2' },
    ];
    const sites = region.countries[0].cities[0].sites;
    const fullExpected = calculateManagementTokens(sites, 0);
    const halfExpected = calculateManagementTokens([sites[0]], 0);

    const all = computeSizerMgmtScenarios(niosx, [region], 0, new Set(['NX-1', 'NX-2']));
    expect(all.hybrid).toBe(fullExpected);
    expect(all.full).toBe(fullExpected);

    const half = computeSizerMgmtScenarios(niosx, [region], 0, new Set(['NX-1']));
    expect(half.hybrid).toBe(halfExpected);
    expect(half.full).toBe(fullExpected);
    expect(half.hybrid).toBeLessThan(half.full);

    const none = computeSizerMgmtScenarios(niosx, [region], 0, new Set());
    expect(none.hybrid).toBe(0);
    expect(none.full).toBe(fullExpected);
  });

  it('full scenario is non-zero when hero shows non-zero mgmt tokens (issue #6 acceptance)', () => {
    // Mirror the issue's repro: realistic user count → non-zero hero → planner Full must match.
    const region = regionWithSites('r1', [
      { id: 's1', users: 1500, activeIPs: 2250, dnsRecords: 1000, dhcpScopes: 6, multiplier: 1 },
    ]);
    const niosx = [{ name: 'NX-1', siteId: 's1' }];
    const out = computeSizerMgmtScenarios(niosx, [region], 0.2, new Set(['NX-1']));
    expect(out.full).toBeGreaterThan(0);
    expect(out.hybrid).toBeGreaterThan(0);
  });
});
