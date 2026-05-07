/**
 * sizer-import.test.ts — coverage for SIZER-15 (Phase 32 scan import bridge).
 *
 * Strategy: assert exact counts, exact dedup-key strings, and structural
 * invariants. No snapshots; spec-as-oracle per CONTEXT D-04..D-15.
 *
 * Test groups:
 *   - shortenSource / formatCloudRegionName helpers (Pitfall 4 single source of truth)
 *   - importNios (D-04, D-05)
 *   - importCloud per provider (D-07, D-08)
 *   - importAd (D-10, Pitfall 9)
 *   - importFromScan composition (D-13 untouched slices)
 *   - mergeFullState additive append + dedup-skip (D-09, D-12)
 *   - mergeFullState idempotency (D-14)
 *   - mergeFullState untouched slices (D-13)
 *   - Defensive numeric coercion (RESEARCH §Security Domain V5)
 */

import { describe, it, expect } from 'vitest';

import {
  shortenSource,
  formatCloudRegionName,
  importNios,
  importCloud,
  importAd,
  importFromScan,
  mergeFullState,
} from '../sizer-import';
import { initialSizerState } from '../sizer-state';
import { UNASSIGNED_PLACEHOLDER, type Region, type Site } from '../sizer-types';
import type { FindingRow } from '../../mock-data';
import {
  awsFindings,
  azureFindings,
  gcpFindings,
  adFindings,
  niosFindings,
  niosMetrics,
  adMetrics,
  mixedFindings,
} from './fixtures/scan-import';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findSiteByName(region: Region, name: string): Site | undefined {
  for (const c of region.countries) {
    for (const ct of c.cities) {
      for (const s of ct.sites) {
        if (s.name === name) return s;
      }
    }
  }
  return undefined;
}

function countSites(region: Region): number {
  let n = 0;
  for (const c of region.countries) {
    for (const ct of c.cities) {
      n += ct.sites.length;
    }
  }
  return n;
}

// ─── Format helpers ──────────────────────────────────────────────────────────

describe('shortenSource', () => {
  it('shortens 12-char source to first-4 … last-4 form', () => {
    // Canonical "first 4 + ellipsis + last 4" pattern used by token displays.
    expect(shortenSource('1234567890ab')).toBe('1234…90ab');
  });

  it('preserves source ≤ 8 characters verbatim', () => {
    expect(shortenSource('short')).toBe('short');
    expect(shortenSource('12345678')).toBe('12345678');
  });

  it('shortens 9-char source', () => {
    expect(shortenSource('123456789')).toBe('1234…6789');
  });
});

describe('formatCloudRegionName', () => {
  it('formats AWS account + region (shortens 12-char account ID)', () => {
    expect(formatCloudRegionName('aws', '1234567890ab', 'us-east-1')).toBe(
      'AWS 1234…90ab — us-east-1',
    );
  });

  it('formats Azure subscription + region (shortens >8 char source)', () => {
    expect(formatCloudRegionName('azure', 'sub-prod-01', 'eastus')).toBe(
      'AZURE sub-…d-01 — eastus',
    );
  });

  it('formats GCP project + region (shortens >8 char source)', () => {
    expect(formatCloudRegionName('gcp', 'gcp-prod-01', 'us-central1')).toBe(
      'GCP gcp-…d-01 — us-central1',
    );
  });

  it('preserves short source verbatim (≤8 chars)', () => {
    expect(formatCloudRegionName('azure', 'short', 'eastus')).toBe(
      'AZURE short — eastus',
    );
  });
});

// ─── importNios ──────────────────────────────────────────────────────────────

describe('importNios', () => {
  it('returns one NiosXSystem per metric with defaults (D-04)', () => {
    const out = importNios(niosMetrics);
    expect(out).toHaveLength(niosMetrics.length);
    for (let i = 0; i < out.length; i++) {
      expect(out[i].name).toBe(niosMetrics[i].memberName);
      expect(out[i].siteId).toBe('');
      expect(out[i].formFactor).toBe('nios-x');
      expect(out[i].tierName).toBe('M');
      expect(out[i].id).toBeTruthy();
    }
  });

  it('returns empty array for empty input', () => {
    expect(importNios([])).toEqual([]);
  });
});

// ─── importCloud ─────────────────────────────────────────────────────────────

describe.each([
  ['aws' as const, awsFindings, '123456789012', 'us-east-1', 'us-west-2'],
  ['azure' as const, azureFindings, 'sub-prod-01', 'eastus', 'westeurope'],
  ['gcp' as const, gcpFindings, 'gcp-prod-01', 'us-central1', 'europe-west1'],
])(
  'importCloud(%s)',
  (provider, findings, source, regionA, regionB) => {
    it('returns one Region per (source, region) tuple (D-07)', () => {
      const regions = importCloud(provider, findings);
      expect(regions).toHaveLength(2);
      const names = regions.map((r) => r.name).sort();
      expect(names).toEqual(
        [
          formatCloudRegionName(provider, source, regionA),
          formatCloudRegionName(provider, source, regionB),
        ].sort(),
      );
    });

    it('Region.type matches provider and cloudNativeDns=true', () => {
      const regions = importCloud(provider, findings);
      for (const r of regions) {
        expect(r.type).toBe(provider);
        expect(r.cloudNativeDns).toBe(true);
      }
    });

    it('each Region contains (Unassigned)/(Unassigned)/Site tree (D-08)', () => {
      const regions = importCloud(provider, findings);
      for (const r of regions) {
        expect(r.countries).toHaveLength(1);
        expect(r.countries[0].name).toBe(UNASSIGNED_PLACEHOLDER);
        expect(r.countries[0].cities).toHaveLength(1);
        expect(r.countries[0].cities[0].name).toBe(UNASSIGNED_PLACEHOLDER);
        expect(r.countries[0].cities[0].sites).toHaveLength(1);
        const site = r.countries[0].cities[0].sites[0];
        expect(site.multiplier).toBe(1);
      }
    });

    it('Site name is "{shortenSource(source)} {region}" and activeIPs sums Active IP rows', () => {
      const regions = importCloud(provider, findings);
      const expectedName = `${shortenSource(source)} ${regionA}`;
      const r = regions.find((rg) => rg.name === formatCloudRegionName(provider, source, regionA));
      expect(r).toBeTruthy();
      const site = findSiteByName(r!, expectedName);
      expect(site).toBeTruthy();
      const expectedActiveIPs = findings
        .filter((f) => f.region === regionA && f.category === 'Active IP')
        .reduce((s, f) => s + f.count, 0);
      expect(site!.activeIPs).toBe(expectedActiveIPs);
    });
  },
);

// ─── importAd ────────────────────────────────────────────────────────────────

describe('importAd', () => {
  it('returns on-premises Region + Site keyed off domain (D-10)', () => {
    const { region, site } = importAd(adFindings);
    expect(region.type).toBe('on-premises');
    expect(site.name).toBe('corp.example.com');
    expect(site.multiplier).toBe(1);
  });

  it('users computed via Asset rows when present (Pitfall 9)', () => {
    // adFindings has Asset row with count=1200 (Entra Users)
    const { site } = importAd(adFindings);
    // Pitfall 9: prefer Managed Asset / user rows; sum matches asset count
    expect(site.users).toBe(1200);
  });

  it('falls back to Active IP sum when no user/asset rows match', () => {
    const fallback: FindingRow[] = [
      {
        provider: 'microsoft',
        source: 'corp.example.com',
        region: '',
        category: 'Active IP',
        item: 'DHCP Active Leases',
        count: 260,
        tokensPerUnit: 13,
        managementTokens: 20,
      },
    ];
    const { site } = importAd(fallback);
    expect(site.users).toBe(260);
  });

  it('returned region carries (Unassigned) Country + City placeholders', () => {
    const { region } = importAd(adFindings);
    expect(region.countries).toHaveLength(1);
    expect(region.countries[0].name).toBe(UNASSIGNED_PLACEHOLDER);
    expect(region.countries[0].cities[0].name).toBe(UNASSIGNED_PLACEHOLDER);
  });
});

// ─── importFromScan ──────────────────────────────────────────────────────────

describe('importFromScan', () => {
  it('builds a fresh SizerFullState from initialSizerState() (D-17)', () => {
    const out = importFromScan(mixedFindings, niosMetrics, adMetrics);
    const initial = initialSizerState();
    // ui slice deep-equals initialSizerState().ui (D-13: import never touches ui)
    expect(out.ui).toEqual(initial.ui);
    // globalSettings + security untouched
    expect(out.core.globalSettings).toEqual(initial.core.globalSettings);
    expect(out.core.security).toEqual(initial.core.security);
  });

  it('core.regions contains AWS + Azure + GCP + On-Premises Regions', () => {
    const out = importFromScan(mixedFindings, niosMetrics, adMetrics);
    const types = out.core.regions.map((r) => r.type).sort();
    // 2 AWS + 2 Azure + 2 GCP + 1 On-Premises = 7
    expect(out.core.regions.filter((r) => r.type === 'aws')).toHaveLength(2);
    expect(out.core.regions.filter((r) => r.type === 'azure')).toHaveLength(2);
    expect(out.core.regions.filter((r) => r.type === 'gcp')).toHaveLength(2);
    expect(out.core.regions.filter((r) => r.type === 'on-premises')).toHaveLength(1);
    expect(types).toHaveLength(7);
  });

  it('core.infrastructure.niosx length matches niosMetrics length', () => {
    const out = importFromScan(mixedFindings, niosMetrics, adMetrics);
    expect(out.core.infrastructure.niosx).toHaveLength(niosMetrics.length);
  });

  it('handles empty findings + no metrics gracefully', () => {
    const out = importFromScan([], undefined, undefined);
    expect(out.core.regions).toEqual([]);
    expect(out.core.infrastructure.niosx).toEqual([]);
  });

  it('NIOS-only import synthesizes "Imported NIOS Grid" Region with one Site per member (2026-04-26)', () => {
    const out = importFromScan(niosFindings, niosMetrics);
    expect(out.core.regions).toHaveLength(1);
    const r = out.core.regions[0];
    expect(r.name).toBe('Imported NIOS Grid');
    expect(r.type).toBe('on-premises');
    const sites = r.countries.flatMap((c) => c.cities.flatMap((ct) => ct.sites));
    expect(sites).toHaveLength(niosMetrics.length);
    expect(sites.map((s) => s.name).sort()).toEqual(
      niosMetrics.map((m) => m.memberName).sort(),
    );
    // niosx members linked to their synthesized Site (no orphans).
    expect(out.core.infrastructure.niosx).toHaveLength(niosMetrics.length);
    const siteIds = new Set(sites.map((s) => s.id));
    for (const n of out.core.infrastructure.niosx) {
      expect(siteIds.has(n.siteId)).toBe(true);
    }
  });

  it('synthesized Site carries the per-member NIOS objectCount as dnsRecords (issue #7)', () => {
    const out = importFromScan(niosFindings, niosMetrics);
    const sites = out.core.regions[0].countries.flatMap((c) =>
      c.cities.flatMap((ct) => ct.sites),
    );
    const sitesByName = new Map(sites.map((s) => [s.name, s]));
    for (const m of niosMetrics) {
      const s = sitesByName.get(m.memberName);
      expect(s).toBeDefined();
      if (m.objectCount > 0) {
        expect(s!.dnsRecords).toBe(m.objectCount);
      } else {
        expect(s!.dnsRecords).toBeUndefined();
      }
      expect(s!.dhcpScopes).toBeUndefined();
    }
  });
});

// ─── mergeFullState ──────────────────────────────────────────────────────────

describe('mergeFullState — additive append', () => {
  it('appends a brand-new Region (no dedup match)', () => {
    const existing = importFromScan(adFindings); // 1 on-premises region
    const incoming = importFromScan(awsFindings); // 2 aws regions
    const merged = mergeFullState(existing, incoming);
    expect(merged.core.regions).toHaveLength(3);
    // existing on-premises preserved
    expect(merged.core.regions.filter((r) => r.type === 'on-premises')).toHaveLength(1);
    expect(merged.core.regions.filter((r) => r.type === 'aws')).toHaveLength(2);
  });
});

describe('mergeFullState — dedup skip (D-09 / D-12)', () => {
  it('skips Region with matching (type, name) — preserves existing children intact', () => {
    const existing = importFromScan(awsFindings);
    // Mutate one Site in existing with a non-default multiplier
    const targetRegion = existing.core.regions[0];
    const targetSite = targetRegion.countries[0].cities[0].sites[0];
    const modifiedExisting = {
      ...existing,
      core: {
        ...existing.core,
        regions: existing.core.regions.map((r, i) => {
          if (i !== 0) return r;
          return {
            ...r,
            countries: r.countries.map((c, ci) =>
              ci !== 0
                ? c
                : {
                    ...c,
                    cities: c.cities.map((ct, cti) =>
                      cti !== 0
                        ? ct
                        : {
                            ...ct,
                            sites: ct.sites.map((s) =>
                              s.id === targetSite.id ? { ...s, multiplier: 99 } : s,
                            ),
                          },
                    ),
                  },
            ),
          };
        }),
      },
    };
    const incoming = importFromScan(awsFindings); // same fixture → same dedup keys
    const merged = mergeFullState(modifiedExisting, incoming);
    // Still 2 regions (no duplication)
    expect(merged.core.regions).toHaveLength(2);
    // multiplier 99 preserved (no field-level overwrite)
    const mergedTargetRegion = merged.core.regions.find((r) => r.name === targetRegion.name);
    expect(mergedTargetRegion).toBeTruthy();
    const mergedSite = mergedTargetRegion!.countries[0].cities[0].sites.find(
      (s) => s.id === targetSite.id,
    );
    expect(mergedSite?.multiplier).toBe(99);
  });

  it('Site dedup is case-insensitive on name within matched Region', () => {
    const existing = importFromScan(awsFindings);
    // Lowercase the site name so dedup case-insensitive match still hits
    const target = existing.core.regions[0].countries[0].cities[0].sites[0];
    const lowerName = target.name.toLowerCase();
    const modified = {
      ...existing,
      core: {
        ...existing.core,
        regions: existing.core.regions.map((r, i) =>
          i !== 0
            ? r
            : {
                ...r,
                countries: r.countries.map((c) => ({
                  ...c,
                  cities: c.cities.map((ct) => ({
                    ...ct,
                    sites: ct.sites.map((s) =>
                      s.id === target.id ? { ...s, name: lowerName } : s,
                    ),
                  })),
                })),
              },
        ),
      },
    };
    const incoming = importFromScan(awsFindings);
    const merged = mergeFullState(modified, incoming);
    const mergedRegion = merged.core.regions.find(
      (r) => r.name === existing.core.regions[0].name,
    );
    expect(countSites(mergedRegion!)).toBe(1); // dedup skipped, no duplicate
  });

  it('NIOS-X dedup is case-insensitive on name (D-05)', () => {
    const existing = importFromScan([], niosMetrics);
    // Modify case in existing
    const modified = {
      ...existing,
      core: {
        ...existing.core,
        infrastructure: {
          ...existing.core.infrastructure,
          niosx: existing.core.infrastructure.niosx.map((n) => ({
            ...n,
            name: n.name.toUpperCase(),
          })),
        },
      },
    };
    const incoming = importFromScan([], niosMetrics);
    const merged = mergeFullState(modified, incoming);
    expect(merged.core.infrastructure.niosx).toHaveLength(niosMetrics.length);
  });
});

describe('mergeFullState — untouched slices (D-13)', () => {
  it('leaves ui referentially unchanged', () => {
    const existing = importFromScan(adFindings);
    const incoming = importFromScan(awsFindings);
    const merged = mergeFullState(existing, incoming);
    expect(merged.ui).toBe(existing.ui);
  });

  it('leaves core.globalSettings referentially unchanged', () => {
    const existing = importFromScan(adFindings);
    const incoming = importFromScan(awsFindings);
    const merged = mergeFullState(existing, incoming);
    expect(merged.core.globalSettings).toBe(existing.core.globalSettings);
  });

  it('leaves core.security referentially unchanged', () => {
    const existing = importFromScan(adFindings);
    const incoming = importFromScan(awsFindings);
    const merged = mergeFullState(existing, incoming);
    expect(merged.core.security).toBe(existing.core.security);
  });
});

describe('mergeFullState — idempotency (D-14)', () => {
  it('importing the same fixture twice equals one import', () => {
    const initial = initialSizerState();
    const incoming = importFromScan(mixedFindings, niosMetrics, adMetrics);
    const once = mergeFullState(initial, incoming);
    const twice = mergeFullState(once, incoming);
    expect(twice.core.regions.length).toBe(once.core.regions.length);
    expect(twice.core.infrastructure.niosx.length).toBe(
      once.core.infrastructure.niosx.length,
    );
    // Region names match exactly
    expect(twice.core.regions.map((r) => r.name).sort()).toEqual(
      once.core.regions.map((r) => r.name).sort(),
    );
    // Site count per region matches
    for (const r of once.core.regions) {
      const matching = twice.core.regions.find((tr) => tr.name === r.name);
      expect(matching).toBeTruthy();
      expect(countSites(matching!)).toBe(countSites(r));
    }
  });
});

// ─── Defensive coercion ──────────────────────────────────────────────────────

describe('defensive numeric coercion (RESEARCH §Security Domain V5)', () => {
  it('NaN count does not propagate to Site.activeIPs', () => {
    const bad: FindingRow[] = [
      {
        provider: 'aws',
        source: 'acct-x',
        region: 'us-east-1',
        category: 'Active IP',
        item: 'EC2 IPs',
        count: NaN,
        tokensPerUnit: 13,
        managementTokens: 0,
      },
    ];
    const regions = importCloud('aws', bad);
    expect(regions).toHaveLength(1);
    const site = regions[0].countries[0].cities[0].sites[0];
    expect(site.activeIPs).toBe(0);
    expect(Number.isNaN(site.activeIPs)).toBe(false);
  });

  it('negative count clamps to zero', () => {
    const bad: FindingRow[] = [
      {
        provider: 'aws',
        source: 'acct-x',
        region: 'us-east-1',
        category: 'Active IP',
        item: 'EC2 IPs',
        count: -5,
        tokensPerUnit: 13,
        managementTokens: 0,
      },
    ];
    const regions = importCloud('aws', bad);
    const site = regions[0].countries[0].cities[0].sites[0];
    expect(site.activeIPs).toBe(0);
  });
});
