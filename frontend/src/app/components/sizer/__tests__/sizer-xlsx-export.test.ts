/**
 * sizer-xlsx-export.test.ts — Phase 31 Plan 02.
 *
 * Covers:
 *   - `XAAS_POP_LOCATIONS` frozen-const sanity (plan 31-02 Task 1).
 *   - `safeStringCell` formula-injection guard (T-31-01 mitigation).
 *   - `buildWorkbook(state)` pure builder shape — Summary + per-Region + Security.
 *
 * Spec-as-oracle per `sizer-calc.test.ts` convention (no snapshots).
 */

import { describe, it, expect } from 'vitest';

import { buildWorkbook, safeSheetName, safeStringCell, type Cell, type SheetConfig } from '../sizer-xlsx-export';
import { XAAS_POP_LOCATIONS } from '../xaas-pop-locations';
import type { SizerFullState } from '../sizer-state';
import { initialSizerState } from '../sizer-state';
import type { NiosXSystem, Region, Site } from '../sizer-types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSite(name: string, partial: Partial<Site> = {}): Site {
  return {
    id: `site-${name}`,
    name,
    multiplier: 1,
    users: 1000,
    activeIPs: 1500,
    qps: 3200,
    lps: 1,
    assets: 2000,
    verifiedAssets: 1500,
    unverifiedAssets: 500,
    dnsRecords: 3000,
    dhcpScopes: 8,
    avgLeaseDuration: 24,
    qpsPerIP: 2.13,
    dhcpPct: 0.8,
    dnsZones: 1,
    networksPerSite: 2,
    ...partial,
  };
}

function makeRegion(name: string, sites: Site[], type: Region['type'] = 'on-premises'): Region {
  return {
    id: `region-${name}`,
    name,
    type,
    cloudNativeDns: false,
    countries: [
      {
        id: `country-${name}`,
        name: 'CountryA',
        cities: [{ id: `city-${name}`, name: 'CityA', sites }],
      },
    ],
  };
}

function fixtureTwoRegions(): SizerFullState {
  const base = initialSizerState();
  return {
    ...base,
    core: {
      ...base.core,
      regions: [
        makeRegion('Americas', [makeSite('HQ'), makeSite('Branch1')]),
        makeRegion('EMEA', [makeSite('London')], 'aws'),
      ],
      security: {
        securityEnabled: true,
        socInsightsEnabled: true,
        tdVerifiedAssets: 3000,
        tdUnverifiedAssets: 500,
        dossierQueriesPerDay: 100,
        lookalikeDomainsMentioned: 50,
      },
    },
  };
}

function fixtureMaliciousNames(): SizerFullState {
  const base = initialSizerState();
  return {
    ...base,
    core: {
      ...base.core,
      regions: [
        makeRegion('=SUM(A1)', [makeSite('=evil-site')]),
        makeRegion('@evil', [makeSite('benign')]),
        makeRegion('+cmd', [makeSite('plain')]),
        makeRegion('-attack', [makeSite('plain2')]),
      ],
    },
  };
}

// ─── XAAS_POP_LOCATIONS ───────────────────────────────────────────────────────

describe('XAAS_POP_LOCATIONS', () => {
  it('exports exactly 11 entries', () => {
    expect(XAAS_POP_LOCATIONS.length).toBe(11);
  });

  it('contains 9 AWS entries', () => {
    expect(XAAS_POP_LOCATIONS.filter((p) => p.provider === 'aws').length).toBe(9);
  });

  it('contains 2 GCP entries', () => {
    expect(XAAS_POP_LOCATIONS.filter((p) => p.provider === 'gcp').length).toBe(2);
  });

  it('is frozen at the top level', () => {
    expect(Object.isFrozen(XAAS_POP_LOCATIONS)).toBe(true);
  });

  it('every entry has a kebab-case id, non-empty regionCode, non-empty label', () => {
    for (const p of XAAS_POP_LOCATIONS) {
      expect(p.id).toMatch(/^[a-z0-9-]+$/);
      expect(p.regionCode.length).toBeGreaterThan(0);
      expect(p.label.length).toBeGreaterThan(0);
    }
  });
});

// ─── safeStringCell ───────────────────────────────────────────────────────────

describe('safeStringCell — formula-injection guard (T-31-01)', () => {
  it("prefixes leading '=' with apostrophe", () => {
    const c = safeStringCell('=SUM(A1)');
    expect(c.value).toBe("'=SUM(A1)");
    expect(c.type).toBe('String');
  });

  it("prefixes leading '+' with apostrophe", () => {
    const c = safeStringCell('+cmd');
    expect(c.value).toBe("'+cmd");
    expect(c.type).toBe('String');
  });

  it("prefixes leading '-' with apostrophe", () => {
    const c = safeStringCell('-attack');
    expect(c.value).toBe("'-attack");
    expect(c.type).toBe('String');
  });

  it("prefixes leading '@' with apostrophe", () => {
    const c = safeStringCell('@evil');
    expect(c.value).toBe("'@evil");
    expect(c.type).toBe('String');
  });

  it('leaves a benign string untouched', () => {
    const c = safeStringCell('Americas');
    expect(c.value).toBe('Americas');
    expect(c.type).toBe('String');
  });

  it('coerces null/undefined to empty string', () => {
    const c = safeStringCell(null as unknown as string);
    expect(c.value).toBe('');
    expect(c.type).toBe('String');
  });
});

// ─── safeSheetName ────────────────────────────────────────────────────────────

describe('safeSheetName — Excel sheet-name guard', () => {
  it('strips Excel-forbidden chars `\\ / ? * : [ ]`', () => {
    expect(safeSheetName('Region: New / Region')).toBe('Region- New - Region');
    expect(safeSheetName('a\\b?c*d:e[f]g/h')).toBe('a-b-c-d-e-f-g-h');
  });

  it('truncates to 31 chars (Excel max)', () => {
    const long = 'x'.repeat(50);
    expect(safeSheetName(long).length).toBe(31);
  });

  it('falls back to "Sheet" for blank/whitespace input', () => {
    expect(safeSheetName('')).toBe('Sheet');
    expect(safeSheetName('   ')).toBe('Sheet');
  });

  it('passes through clean names unchanged', () => {
    expect(safeSheetName('Americas')).toBe('Americas');
  });
});

// ─── buildWorkbook — sheet structure ──────────────────────────────────────────

describe('buildWorkbook — sheet structure', () => {
  it('returns Summary + per-Region + Security + Site Breakdown (5 sheets for 2-region fixture, no niosx)', () => {
    const sheets = buildWorkbook(fixtureTwoRegions());
    // Phase 31: Summary + 2 per-region + Security = 4.
    // Phase 34 Plan 07: + Site Breakdown when ≥1 region = 5.
    expect(sheets.length).toBe(5);
  });

  it('first sheet is named "Summary" with header row [Category, Tokens, Contribution]', () => {
    const sheets = buildWorkbook(fixtureTwoRegions());
    const summary = sheets[0];
    expect(summary.name).toBe('Summary');
    const headerRow = summary.rows[0];
    expect(headerRow.map((c) => c.value)).toEqual(['Category', 'Tokens', 'Contribution']);
  });

  it('per-region sheets are named "Region {name}" (no colon — Excel forbids `:` in sheet names)', () => {
    const sheets = buildWorkbook(fixtureTwoRegions());
    const regionSheets = sheets.filter((s) => s.name.startsWith('Region '));
    expect(regionSheets.length).toBe(2);
    expect(regionSheets[0].name).toBe('Region Americas');
    expect(regionSheets[1].name).toBe('Region EMEA');
  });

  it('contains a "Security" sheet (no longer last after Phase 34 Plan 07 added parity sheets)', () => {
    const sheets = buildWorkbook(fixtureTwoRegions());
    expect(sheets.find((s) => s.name === 'Security')).toBeDefined();
  });
});

// ─── buildWorkbook — Summary totals ───────────────────────────────────────────

describe('buildWorkbook — Summary totals', () => {
  it('Summary sheet has 4 category rows (Mgmt/Server/Reporting/Security) below header', () => {
    const sheets = buildWorkbook(fixtureTwoRegions());
    const summary = sheets[0];
    const categories = [1, 2, 3, 4].map((i) => summary.rows[i][0].value);
    expect(categories).toEqual(['Management', 'Server', 'Reporting', 'Security']);
  });

  it('Summary breakdown totals row uses fontWeight: bold', () => {
    const sheets = buildWorkbook(fixtureTwoRegions());
    const summary = sheets[0];
    const totalsRow = summary.rows.find((r) => r.length > 0 && r[0].value === 'Total');
    expect(totalsRow).toBeDefined();
    for (const cell of totalsRow!) {
      expect(cell.fontWeight).toBe('bold');
    }
  });

  it('Summary header row cells have fontWeight: bold and backgroundColor: #E5E7EB', () => {
    const sheets = buildWorkbook(fixtureTwoRegions());
    const summary = sheets[0];
    for (const cell of summary.rows[0]) {
      expect(cell.fontWeight).toBe('bold');
      expect(cell.backgroundColor).toBe('#E5E7EB');
    }
  });
});

// ─── formula-injection end-to-end ─────────────────────────────────────────────

describe('buildWorkbook — formula-injection end-to-end', () => {
  it('malicious region/site names appear apostrophe-prefixed in cells', () => {
    const sheets = buildWorkbook(fixtureMaliciousNames());

    const summary = sheets[0];
    const flatValues = summary.rows.flat().map((c) => String(c.value));
    expect(flatValues).toContain("'=SUM(A1)");
    expect(flatValues).toContain("'@evil");
    expect(flatValues).toContain("'+cmd");
    expect(flatValues).toContain("'-attack");
  });
});

// ─── Security sheet ────────────────────────────────────────────────────────────

describe('buildWorkbook — Security sheet', () => {
  it('Security sheet contains required fields when securityEnabled: true', () => {
    const sheets = buildWorkbook(fixtureTwoRegions());
    const security = sheets.find((s) => s.name === 'Security')!;
    const flat = security.rows.flat().map((c) => String(c.value));
    expect(flat).toContain('Security Enabled');
    expect(flat.some((v) => v === 'Verified Assets')).toBe(true);
    expect(flat.some((v) => v === 'Unverified Assets')).toBe(true);
    expect(flat.some((v) => v === 'SOC Insights')).toBe(true);
    expect(flat.some((v) => v === 'Dossier Queries / Day')).toBe(true);
    expect(flat.some((v) => v === 'Lookalike Domains')).toBe(true);
    expect(flat.some((v) => v === 'Total Security Tokens')).toBe(true);
  });
});

// ─── Phase 34 Plan 07 — Sizer Report Parity sheets ────────────────────────────
//
// New sheets added when matching Sizer state present:
//   - "Site Breakdown"      (always when ≥ 1 region)
//   - "NIOS Migration Plan" (when niosx.length > 0)
//   - "Member Details"      (when niosx.length > 0)
//   - "Resource Savings"    (when niosx.length > 0)
//
// Sheet names verbatim from 34-UI-SPEC.md "XLSX sheet names" copy block.

function makeNiosx(name: string, siteId: string, partial: Partial<NiosXSystem> = {}): NiosXSystem {
  return {
    id: `niosx-${name}`,
    name,
    siteId,
    formFactor: 'nios-x',
    tierName: 'M',
    ...partial,
  };
}

function fixtureWithNiosx(): SizerFullState {
  const base = initialSizerState();
  const siteHQ = makeSite('HQ');
  const siteBranch1 = makeSite('Branch1');
  const siteLondon = makeSite('London');
  return {
    ...base,
    core: {
      ...base.core,
      regions: [
        makeRegion('Americas', [siteHQ, siteBranch1]),
        makeRegion('EMEA', [siteLondon], 'aws'),
      ],
      infrastructure: {
        niosx: [
          makeNiosx('m1', siteHQ.id, { tierName: 'L' }),
          makeNiosx('m2', siteBranch1.id, { tierName: 'M' }),
          makeNiosx('m3', siteLondon.id, { tierName: 'S', formFactor: 'nios-xaas' }),
        ],
        xaas: [],
      },
    },
  };
}

describe('buildWorkbook — Site Breakdown sheet (REQ-06, always)', () => {
  it('emits a sheet named verbatim "Site Breakdown" when at least one region exists', () => {
    const sheets = buildWorkbook(fixtureTwoRegions());
    expect(sheets.find((s) => s.name === 'Site Breakdown')).toBeDefined();
  });

  it('Site Breakdown header row is [Region, Country, City, Site, Active IPs, Users, QPS, LPS, Tokens]', () => {
    const sheets = buildWorkbook(fixtureTwoRegions());
    const breakdown = sheets.find((s) => s.name === 'Site Breakdown')!;
    expect(breakdown.rows[0].map((c) => c.value)).toEqual([
      'Region', 'Country', 'City', 'Site', 'Active IPs', 'Users', 'QPS', 'LPS', 'Tokens',
    ]);
  });

  it('Site Breakdown emits one row per leaf Site (3 sites → 3 data rows)', () => {
    const sheets = buildWorkbook(fixtureTwoRegions());
    const breakdown = sheets.find((s) => s.name === 'Site Breakdown')!;
    expect(breakdown.rows.length).toBe(4); // 1 header + 3 site rows
    const siteNames = breakdown.rows.slice(1).map((r) => r[3].value);
    expect(siteNames).toEqual(['HQ', 'Branch1', 'London']);
  });

  it('Site Breakdown is omitted when state has zero regions', () => {
    const sheets = buildWorkbook(initialSizerState());
    expect(sheets.find((s) => s.name === 'Site Breakdown')).toBeUndefined();
  });
});

describe('buildWorkbook — niosx-gated sheets omitted when niosx empty', () => {
  it('omits "NIOS Migration Plan", "Member Details", "Resource Savings" when niosx.length === 0', () => {
    const sheets = buildWorkbook(fixtureTwoRegions());
    expect(sheets.find((s) => s.name === 'NIOS Migration Plan')).toBeUndefined();
    expect(sheets.find((s) => s.name === 'Member Details')).toBeUndefined();
    expect(sheets.find((s) => s.name === 'Resource Savings')).toBeUndefined();
  });
});

describe('buildWorkbook — NIOS Migration Plan sheet (REQ-06, gated)', () => {
  it('emits a sheet named verbatim "NIOS Migration Plan" when niosx.length > 0', () => {
    const sheets = buildWorkbook(fixtureWithNiosx());
    expect(sheets.find((s) => s.name === 'NIOS Migration Plan')).toBeDefined();
  });

  it('NIOS Migration Plan emits one data row per niosx member (3 members → 3 rows)', () => {
    const sheets = buildWorkbook(fixtureWithNiosx());
    const sheet = sheets.find((s) => s.name === 'NIOS Migration Plan')!;
    expect(sheet.rows.length).toBe(4); // 1 header + 3 rows
  });

  it('NIOS Migration Plan header includes Hostname, Role, Model, Target Tier columns', () => {
    const sheets = buildWorkbook(fixtureWithNiosx());
    const sheet = sheets.find((s) => s.name === 'NIOS Migration Plan')!;
    const header = sheet.rows[0].map((c) => String(c.value));
    expect(header).toContain('Hostname');
    expect(header).toContain('Role');
    expect(header).toContain('Model');
    expect(header).toContain('Target Tier');
  });
});

describe('buildWorkbook — Member Details sheet (REQ-06, gated)', () => {
  it('emits a sheet named verbatim "Member Details" when niosx.length > 0', () => {
    const sheets = buildWorkbook(fixtureWithNiosx());
    expect(sheets.find((s) => s.name === 'Member Details')).toBeDefined();
  });

  it('Member Details emits one data row per niosx member (3 members → 3 rows)', () => {
    const sheets = buildWorkbook(fixtureWithNiosx());
    const sheet = sheets.find((s) => s.name === 'Member Details')!;
    expect(sheet.rows.length).toBe(4);
  });

  it('Member Details header includes Hostname, QPS, LPS, Active IPs, Region columns', () => {
    const sheets = buildWorkbook(fixtureWithNiosx());
    const sheet = sheets.find((s) => s.name === 'Member Details')!;
    const header = sheet.rows[0].map((c) => String(c.value));
    expect(header).toContain('Hostname');
    expect(header).toContain('QPS');
    expect(header).toContain('LPS');
    expect(header).toContain('Active IPs');
    expect(header).toContain('Region');
  });

  it('Member Details rows reflect per-site QPS / Active IPs from Sizer state', () => {
    const sheets = buildWorkbook(fixtureWithNiosx());
    const sheet = sheets.find((s) => s.name === 'Member Details')!;
    const header = sheet.rows[0].map((c) => String(c.value));
    const qpsCol = header.indexOf('QPS');
    const ipCol = header.indexOf('Active IPs');
    // makeSite default: qps=3200, activeIPs=1500
    for (const row of sheet.rows.slice(1)) {
      expect(row[qpsCol].value).toBe(3200);
      expect(row[ipCol].value).toBe(1500);
    }
  });
});

describe('buildWorkbook — Resource Savings sheet (REQ-06, gated)', () => {
  it('emits a sheet named verbatim "Resource Savings" when niosx.length > 0', () => {
    const sheets = buildWorkbook(fixtureWithNiosx());
    expect(sheets.find((s) => s.name === 'Resource Savings')).toBeDefined();
  });

  it('Resource Savings includes a fleet section header and per-member rows (3 members)', () => {
    const sheets = buildWorkbook(fixtureWithNiosx());
    const sheet = sheets.find((s) => s.name === 'Resource Savings')!;
    const flat = sheet.rows.flat().map((c) => String(c.value));
    // Fleet totals section marker
    expect(flat.some((v) => v.toLowerCase().includes('fleet'))).toBe(true);
    // Per-member section column header
    expect(flat).toContain('Hostname');
    // 3 member-name rows present
    // makeNiosx assigns name = 'm1'/'m2'/'m3' (id is prefixed 'niosx-').
    expect(flat).toContain('m1');
    expect(flat).toContain('m2');
    expect(flat).toContain('m3');
  });
});

// ─── Type sanity ──────────────────────────────────────────────────────────────

describe('buildWorkbook — purity', () => {
  it('returns the same shape for identical input (no Date/random side effects)', () => {
    const state = fixtureTwoRegions();
    const a = buildWorkbook(state);
    const b = buildWorkbook(state);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('SheetConfig rows are Cell[][]', () => {
    const sheets: SheetConfig[] = buildWorkbook(fixtureTwoRegions());
    for (const s of sheets) {
      expect(Array.isArray(s.rows)).toBe(true);
      for (const row of s.rows) {
        expect(Array.isArray(row)).toBe(true);
        for (const cell of row as Cell[]) {
          expect(typeof cell.value === 'string' || typeof cell.value === 'number' || cell.value === null).toBe(true);
        }
      }
    }
  });
});
