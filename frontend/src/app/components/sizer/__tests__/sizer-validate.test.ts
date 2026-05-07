/**
 * sizer-validate.test.ts — Unit tests for the Phase 29 pure validator.
 *
 * Every value in VALIDATION_CODES is exercised at least once.
 * Pitfall 7 regression guard: empty state emits STATE_EMPTY only,
 * NOT REGION_EMPTY_WHEN_OTHERS_POPULATED or REGION_EMPTY_OTHERWISE.
 */

import { describe, it, expect } from 'vitest';
import { validate, VALIDATION_CODES } from '../sizer-validate';
import { XAAS_TOKEN_TIERS } from '../../shared/token-tiers';
import type {
  SizerState,
  Site,
  Region,
  NiosXSystem,
  XaasServicePoint,
  SecurityInputs,
  GlobalSettings,
} from '../sizer-types';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const baseSecurity: SecurityInputs = {
  securityEnabled: false,
  socInsightsEnabled: false,
  tdVerifiedAssets: 0,
  tdUnverifiedAssets: 0,
  dossierQueriesPerDay: 0,
  lookalikeDomainsMentioned: 0,
};

const baseGlobal: GlobalSettings = {
  growthBuffer: 0.2,
  growthBufferAdvanced: false,
};

function makeSite(overrides: Partial<Site> = {}): Site {
  return {
    id: overrides.id ?? 'site-1',
    name: overrides.name ?? 'HQ',
    multiplier: 1,
    users: 1500,
    activeIPs: 2250,
    ...overrides,
  };
}

function makeRegion(overrides: Partial<Region> = {}, sites: Site[] = [makeSite()]): Region {
  return {
    id: overrides.id ?? 'region-1',
    name: overrides.name ?? 'NA',
    type: 'on-premises',
    cloudNativeDns: false,
    countries: [
      {
        id: 'country-1',
        name: '(Unassigned)',
        cities: [{ id: 'city-1', name: '(Unassigned)', sites }],
      },
    ],
    ...overrides,
  };
}

interface StateOverrides {
  regions?: Region[];
  security?: Partial<SecurityInputs>;
  niosx?: NiosXSystem[];
  xaas?: XaasServicePoint[];
  globalSettings?: Partial<GlobalSettings>;
}

function makeState(overrides: StateOverrides = {}): SizerState {
  const site = overrides.regions == null ? makeSite({ id: 'site-1' }) : undefined;
  const defaultNiosx: NiosXSystem[] = site
    ? [{ id: 'niosx-1', name: 'NX-1', siteId: site.id, formFactor: 'nios-x', tierName: 'S' }]
    : [];
  return {
    regions: overrides.regions ?? [makeRegion({}, site ? [site] : [])],
    globalSettings: { ...baseGlobal, ...(overrides.globalSettings ?? {}) },
    security: { ...baseSecurity, ...(overrides.security ?? {}) },
    infrastructure: {
      niosx: overrides.niosx ?? defaultNiosx,
      xaas: overrides.xaas ?? [],
    },
  };
}

function codes(issues: { code: string }[]): string[] {
  return issues.map((i) => i.code);
}

// ─── Errors (D-14) ─────────────────────────────────────────────────────────────

describe('validate - errors (D-14)', () => {
  it('STATE_EMPTY fires (and no REGION_EMPTY_* false-positive) for regions: []', () => {
    const { errors, warnings } = validate(makeState({ regions: [] }));
    expect(codes(errors)).toEqual([VALIDATION_CODES.STATE_EMPTY]);
    expect(errors[0].path).toBe('');
    expect(warnings).toEqual([]);
    // Pitfall 7 guard: REGION_EMPTY_* must NOT fire on empty state.
    expect(codes(errors)).not.toContain(VALIDATION_CODES.REGION_EMPTY_WHEN_OTHERS_POPULATED);
    expect(codes(warnings)).not.toContain(VALIDATION_CODES.REGION_EMPTY_OTHERWISE);
  });

  it('SITE_MISSING_USERS_AND_IPS fires with exact dot-path when both are undefined', () => {
    const site = makeSite({ users: undefined, activeIPs: undefined });
    const state = makeState({ regions: [makeRegion({}, [site])] });
    const { errors } = validate(state);
    const issue = errors.find((e) => e.code === VALIDATION_CODES.SITE_MISSING_USERS_AND_IPS);
    expect(issue).toBeDefined();
    expect(issue!.path).toBe('regions[0].countries[0].cities[0].sites[0]');
    expect(issue!.severity).toBe('error');
  });

  it('REGION_EMPTY_WHEN_OTHERS_POPULATED fires when one region has sites and another is empty', () => {
    const populated = makeRegion({ id: 'r-pop', name: 'NA' }, [makeSite({ id: 's-1' })]);
    const empty: Region = {
      id: 'r-empty',
      name: 'EU',
      type: 'on-premises',
      cloudNativeDns: false,
      countries: [],
    };
    const state = makeState({ regions: [populated, empty] });
    const { errors } = validate(state);
    const issue = errors.find(
      (e) => e.code === VALIDATION_CODES.REGION_EMPTY_WHEN_OTHERS_POPULATED,
    );
    expect(issue).toBeDefined();
    expect(issue!.path).toBe('regions[1]');
  });

  it('SECURITY_ENABLED_ZERO_ASSETS fires when securityEnabled && verified+unverified === 0', () => {
    const state = makeState({
      security: { securityEnabled: true, tdVerifiedAssets: 0, tdUnverifiedAssets: 0 },
    });
    const { errors } = validate(state);
    const issue = errors.find((e) => e.code === VALIDATION_CODES.SECURITY_ENABLED_ZERO_ASSETS);
    expect(issue).toBeDefined();
    expect(issue!.path).toBe('security');
  });

  it('SECURITY_ENABLED_ZERO_ASSETS does NOT fire when verified+unverified > 0', () => {
    const state = makeState({
      security: { securityEnabled: true, tdVerifiedAssets: 5, tdUnverifiedAssets: 0 },
    });
    const { errors } = validate(state);
    expect(codes(errors)).not.toContain(VALIDATION_CODES.SECURITY_ENABLED_ZERO_ASSETS);
  });
});

// ─── Warnings (D-15) ───────────────────────────────────────────────────────────

describe('validate - warnings (D-15)', () => {
  it('REGION_EMPTY_OTHERWISE fires (as warning, not error) when the only region is empty', () => {
    const empty: Region = {
      id: 'r-empty',
      name: 'NA',
      type: 'on-premises',
      cloudNativeDns: false,
      countries: [],
    };
    const { errors, warnings } = validate(makeState({ regions: [empty] }));
    expect(codes(warnings)).toContain(VALIDATION_CODES.REGION_EMPTY_OTHERWISE);
    expect(codes(errors)).not.toContain(VALIDATION_CODES.REGION_EMPTY_WHEN_OTHERS_POPULATED);
    expect(codes(errors)).not.toContain(VALIDATION_CODES.STATE_EMPTY);
    const issue = warnings.find((w) => w.code === VALIDATION_CODES.REGION_EMPTY_OTHERWISE);
    expect(issue!.path).toBe('regions[0]');
  });

  it('LPS_OUT_OF_RANGE fires at lps=0 and lps=10001, not at lps=500', () => {
    const low = validate(makeState({ regions: [makeRegion({}, [makeSite({ lps: 0 })])] }));
    expect(codes(low.warnings)).toContain(VALIDATION_CODES.LPS_OUT_OF_RANGE);

    const high = validate(makeState({ regions: [makeRegion({}, [makeSite({ lps: 10001 })])] }));
    expect(codes(high.warnings)).toContain(VALIDATION_CODES.LPS_OUT_OF_RANGE);

    const ok = validate(makeState({ regions: [makeRegion({}, [makeSite({ lps: 500 })])] }));
    expect(codes(ok.warnings)).not.toContain(VALIDATION_CODES.LPS_OUT_OF_RANGE);
  });

  it('LPS_OUT_OF_RANGE does not fire when lps is undefined', () => {
    const { warnings } = validate(
      makeState({ regions: [makeRegion({}, [makeSite({ lps: undefined })])] }),
    );
    expect(codes(warnings)).not.toContain(VALIDATION_CODES.LPS_OUT_OF_RANGE);
  });

  it('XAAS_OVER_CONNECTIONS fires at maxConnections+1 and NOT at maxConnections', () => {
    const sTier = XAAS_TOKEN_TIERS.find((t) => t.name === 'S')!;
    const max = sTier.maxConnections!;
    const site = makeSite({ id: 's-1' });

    const over: XaasServicePoint = {
      id: 'x-1',
      name: 'XP-1',
      regionId: 'region-1',
      tierName: 'S',
      connections: max + 1,
      connectedSiteIds: [site.id],
      connectivity: 'vpn',
      popLocation: 'aws-us-east-1',
    };
    const overState = makeState({ regions: [makeRegion({}, [site])], xaas: [over] });
    const overRes = validate(overState);
    expect(codes(overRes.warnings)).toContain(VALIDATION_CODES.XAAS_OVER_CONNECTIONS);
    const warn = overRes.warnings.find(
      (w) => w.code === VALIDATION_CODES.XAAS_OVER_CONNECTIONS,
    );
    expect(warn!.path).toBe('infrastructure.xaas[0]');

    const atCap: XaasServicePoint = { ...over, id: 'x-2', connections: max };
    const atCapState = makeState({ regions: [makeRegion({}, [site])], xaas: [atCap] });
    expect(codes(validate(atCapState).warnings)).not.toContain(
      VALIDATION_CODES.XAAS_OVER_CONNECTIONS,
    );
  });

  it('SITE_UNASSIGNED fires when infra exists but does not reference the site', () => {
    const site = makeSite({ id: 'orphan' });
    // Some infra exists (covering a different site) so the global
    // OBJECT_COUNT_MISMATCH warning does not subsume per-site warnings.
    const niosx: NiosXSystem[] = [
      { id: 'nx-other', name: 'NX-Other', siteId: 'some-other-site', formFactor: 'nios-x', tierName: 'S' },
    ];
    const state = makeState({ regions: [makeRegion({}, [site])], niosx, xaas: [] });
    const { warnings } = validate(state);
    expect(codes(warnings)).toContain(VALIDATION_CODES.SITE_UNASSIGNED);
    const issue = warnings.find((w) => w.code === VALIDATION_CODES.SITE_UNASSIGNED);
    expect(issue!.path).toBe('regions[0].countries[0].cities[0].sites[0]');
  });

  it('SITE_UNASSIGNED is suppressed when no infra exists at all (global OBJECT_COUNT_MISMATCH covers it)', () => {
    const site = makeSite({ id: 'orphan' });
    const state = makeState({ regions: [makeRegion({}, [site])], niosx: [], xaas: [] });
    const { warnings } = validate(state);
    expect(codes(warnings)).not.toContain(VALIDATION_CODES.SITE_UNASSIGNED);
    expect(codes(warnings)).toContain(VALIDATION_CODES.OBJECT_COUNT_MISMATCH);
  });

  it('SITE_UNASSIGNED does NOT fire when site is connected via XaaS', () => {
    const site = makeSite({ id: 'connected' });
    const xp: XaasServicePoint = {
      id: 'x-1',
      name: 'XP-1',
      regionId: 'region-1',
      tierName: 'S',
      connections: 1,
      connectedSiteIds: ['connected'],
      connectivity: 'vpn',
      popLocation: 'aws-us-east-1',
    };
    const state = makeState({ regions: [makeRegion({}, [site])], niosx: [], xaas: [xp] });
    expect(codes(validate(state).warnings)).not.toContain(VALIDATION_CODES.SITE_UNASSIGNED);
  });

  it('OBJECT_COUNT_MISMATCH fires when Sites exist but no niosx and no xaas', () => {
    const site = makeSite({ id: 's-1' });
    const state = makeState({ regions: [makeRegion({}, [site])], niosx: [], xaas: [] });
    const { warnings } = validate(state);
    expect(codes(warnings)).toContain(VALIDATION_CODES.OBJECT_COUNT_MISMATCH);
    const issue = warnings.find((w) => w.code === VALIDATION_CODES.OBJECT_COUNT_MISMATCH);
    expect(issue!.path).toBe('infrastructure');
  });

  it('OBJECT_COUNT_MISMATCH does NOT fire when at least one NIOS-X exists', () => {
    const state = makeState(); // default provides one niosx for the site
    expect(codes(validate(state).warnings)).not.toContain(
      VALIDATION_CODES.OBJECT_COUNT_MISMATCH,
    );
  });
});

// ─── Happy path ────────────────────────────────────────────────────────────────

describe('validate - happy path', () => {
  it('well-formed state with minimal infrastructure returns no errors, no warnings', () => {
    const result = validate(makeState());
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

// ─── Path format ───────────────────────────────────────────────────────────────

describe('validate - path format', () => {
  it('uses bracket-indexed dot-path for a failing Site', () => {
    const site = makeSite({ users: undefined, activeIPs: undefined });
    const state = makeState({ regions: [makeRegion({}, [site])] });
    const issue = validate(state).errors.find(
      (e) => e.code === VALIDATION_CODES.SITE_MISSING_USERS_AND_IPS,
    );
    expect(issue!.path).toBe('regions[0].countries[0].cities[0].sites[0]');
  });

  it('uses regions[i] path for a failing empty Region', () => {
    const populated = makeRegion({ id: 'r0' }, [makeSite({ id: 's1' })]);
    const empty: Region = {
      id: 'r1',
      name: 'EU',
      type: 'on-premises',
      cloudNativeDns: false,
      countries: [],
    };
    const issue = validate(makeState({ regions: [populated, empty] })).errors.find(
      (e) => e.code === VALIDATION_CODES.REGION_EMPTY_WHEN_OTHERS_POPULATED,
    );
    expect(issue!.path).toBe('regions[1]');
  });

  it('uses "security" path for a failing security invariant', () => {
    const state = makeState({ security: { securityEnabled: true } });
    const issue = validate(state).errors.find(
      (e) => e.code === VALIDATION_CODES.SECURITY_ENABLED_ZERO_ASSETS,
    );
    expect(issue!.path).toBe('security');
  });
});

// ─── Code coverage meta-check ──────────────────────────────────────────────────

describe('validate - every VALIDATION_CODES key is exercised', () => {
  it('references every code value in at least one assertion above', () => {
    // This test is a reminder: if we add a new code, the list below must grow.
    const expected = [
      VALIDATION_CODES.SITE_MISSING_USERS_AND_IPS,
      VALIDATION_CODES.REGION_EMPTY_WHEN_OTHERS_POPULATED,
      VALIDATION_CODES.SECURITY_ENABLED_ZERO_ASSETS,
      VALIDATION_CODES.STATE_EMPTY,
      VALIDATION_CODES.XAAS_OVER_CONNECTIONS,
      VALIDATION_CODES.SITE_UNASSIGNED,
      VALIDATION_CODES.LPS_OUT_OF_RANGE,
      VALIDATION_CODES.OBJECT_COUNT_MISMATCH,
      VALIDATION_CODES.REGION_EMPTY_OTHERWISE,
    ];
    expect(new Set(expected).size).toBe(Object.keys(VALIDATION_CODES).length);
  });
});
