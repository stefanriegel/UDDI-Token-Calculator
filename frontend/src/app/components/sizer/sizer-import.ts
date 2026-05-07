/**
 * sizer-import.ts — Pure scan-results → SizerFullState mappers + additive merge engine.
 *
 * Per CONTEXT decisions:
 *   - D-04..D-06: NIOS metrics → NiosXSystem[] only (no Site creation).
 *   - D-07..D-09: Cloud findings → Region per (provider, source, region) + Site per (source, region).
 *   - D-10..D-11: AD findings → Site under On-Premises Region (auto-create if missing).
 *   - D-12..D-15: Strictly additive merge; dedup-skip on key match; ui/security/globalSettings untouched.
 *   - D-17: importFromScan is pure (no reads from current Sizer state).
 *   - Pitfall 1: Consumed by wizard.tsx via sessionStorage handoff (NOT direct dispatch).
 *   - Pitfall 4: Single helper formatCloudRegionName() shared by build + dedup paths.
 *   - Pitfall 7: Consumes the frontend FindingRow shape (mock-data.ts) which now carries `region`.
 *   - Pitfall 9: AD users prefers Asset rows whose item ~/user/i; falls back to Active IP sum.
 *
 * Consumers: sizer/import-confirm-dialog.tsx (count summary), wizard.tsx (handoff handler),
 *            sizer-state.ts reducer case IMPORT_SCAN (mergeFullState delegate).
 *
 * This file never imports React. All functions are deterministic and unit-tested.
 */

import {
  UNASSIGNED_PLACEHOLDER,
  type City,
  type Country,
  type NiosXSystem,
  type Region,
  type Site,
} from './sizer-types';
import {
  initialSizerState,
  newId,
  type SizerFullState,
} from './sizer-state';
import type { FindingRow } from '../mock-data';
import type { NiosServerMetricAPI, ADServerMetricAPI } from '../api-client';

// ─── Numeric coercion (RESEARCH §Security Domain V5) ─────────────────────────

/** Coerce to a non-negative integer; NaN/undefined/negative → 0. */
function safeCount(n: number | undefined): number {
  if (n === undefined || n === null) return 0;
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function sumCount(rows: FindingRow[]): number {
  let total = 0;
  for (const r of rows) total += safeCount(r.count);
  return total;
}

// ─── Format helpers (Pitfall 4 — single source of truth) ─────────────────────

export function shortenSource(s: string): string {
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export function formatCloudRegionName(
  provider: 'aws' | 'azure' | 'gcp',
  source: string,
  region: string,
): string {
  return `${provider.toUpperCase()} ${shortenSource(source)} — ${region}`;
}

// ─── Dedup keys ──────────────────────────────────────────────────────────────

function niosKey(n: { name: string }): string {
  return n.name.trim().toLowerCase();
}

function cloudRegionKey(r: { type: Region['type']; name: string }): string {
  return `${r.type}::${r.name.toLowerCase()}`;
}

function siteKey(parentRegionName: string, s: { name: string }): string {
  return `${parentRegionName.toLowerCase()}::${s.name.toLowerCase()}`;
}

// ─── Tree builders ───────────────────────────────────────────────────────────

function unassignedCity(sites: Site[] = []): City {
  return { id: newId(), name: UNASSIGNED_PLACEHOLDER, sites };
}

function unassignedCountry(sites: Site[] = []): Country {
  return { id: newId(), name: UNASSIGNED_PLACEHOLDER, cities: [unassignedCity(sites)] };
}

// ─── Hostname → Country / City heuristic (NIOS Grid synthesis) ───────────────

/**
 * Best-effort parse of a NIOS member hostname into a Country / City pair so
 * the synthesized "Imported NIOS Grid" Region groups members geographically
 * instead of dumping everything under (Unassigned)/(Unassigned).
 *
 * Matches three observed patterns in production NIOS deployments:
 *   • `cc-city-…`    → Country = `CC`, City = `CITY`  (e.g. `de-fra-…`)
 *   • `cloud-…`      → Country = "Cloud", City = `CLOUD-PREFIX`
 *                       (e.g. `frc-az-…`, `apse1-aws-…`, `eus2-az-…`,
 *                        `use4-gcp-…`, `euw3-aws-…`, `we-az-…`, `euw-…`)
 *   • anything else  → Country = "(Unassigned)", City = "(Unassigned)"
 *
 * The user can rename / regroup any of these in Step 1; the goal is a useful
 * starting hierarchy, not a perfect mapping.
 */
const ISO2_COUNTRY = new Set([
  'ad','ae','af','ag','ai','al','am','ao','ar','as','at','au','aw','ax','az',
  'ba','bb','bd','be','bf','bg','bh','bi','bj','bm','bn','bo','br','bs','bt',
  'bw','by','bz','ca','cc','cd','cf','cg','ch','ci','ck','cl','cm','cn','co',
  'cr','cu','cv','cw','cx','cy','cz','de','dj','dk','dm','do','dz','ec','ee',
  'eg','er','es','et','fi','fj','fk','fm','fo','fr','ga','gb','gd','ge','gf',
  'gg','gh','gi','gl','gm','gn','gp','gq','gr','gs','gt','gu','gw','gy','hk',
  'hn','hr','ht','hu','id','ie','il','im','in','io','iq','ir','is','it','je',
  'jm','jo','jp','ke','kg','kh','ki','km','kn','kp','kr','kw','ky','kz','la',
  'lb','lc','li','lk','lr','ls','lt','lu','lv','ly','ma','mc','md','me','mg',
  'mh','mk','ml','mm','mn','mo','mp','mq','mr','ms','mt','mu','mv','mw','mx',
  'my','mz','na','nc','ne','nf','ng','ni','nl','no','np','nr','nu','nz','om',
  'pa','pe','pf','pg','ph','pk','pl','pm','pr','ps','pt','pw','py','qa','re',
  'ro','rs','ru','rw','sa','sb','sc','sd','se','sg','sh','si','sk','sl','sm',
  'sn','so','sr','ss','st','sv','sx','sy','sz','tc','td','tf','tg','th','tj',
  'tk','tl','tm','tn','to','tr','tt','tv','tw','tz','ua','ug','uk','us','uy',
  'uz','va','vc','ve','vg','vi','vn','vu','wf','ws','ye','yt','za','zm','zw',
]);

export function parseGeoFromHostname(host: string): { country: string; city: string } {
  const head = host.toLowerCase().split('.')[0];
  const parts = head.split('-');
  if (parts.length >= 2 && parts[0].length === 2 && ISO2_COUNTRY.has(parts[0])) {
    return { country: parts[0].toUpperCase(), city: parts[1].toUpperCase() };
  }
  // Cloud-region-style prefixes (frc, apse1, eus2, use4, euw3, ncus, we, …).
  // Only treat as cloud when the first segment is alphanumeric and ≤ 6 chars
  // so we don't grab arbitrary garbage.
  if (parts[0] && /^[a-z][a-z0-9]{1,5}$/.test(parts[0])) {
    return { country: 'Cloud', city: parts[0].toUpperCase() };
  }
  return { country: UNASSIGNED_PLACEHOLDER, city: UNASSIGNED_PLACEHOLDER };
}

// ─── Tree count helper (Phase 32 D-18 badge derivation) ──────────────────────

/**
 * Tally Regions / Sites / NIOS-X across a SizerFullState. Used by the
 * wizard.tsx handoff handler to derive *new entity* counts via
 * `count(merged) - count(existing)` for the D-18 import badge.
 */
export function countTreeEntities(state: SizerFullState): {
  regions: number;
  sites: number;
  niosx: number;
} {
  let sites = 0;
  for (const r of state.core.regions) {
    for (const c of r.countries) {
      for (const ct of c.cities) {
        sites += ct.sites.length;
      }
    }
  }
  return {
    regions: state.core.regions.length,
    sites,
    niosx: state.core.infrastructure.niosx.length,
  };
}

// ─── importNios (D-04, D-05) ─────────────────────────────────────────────────

export function importNios(metrics: NiosServerMetricAPI[]): NiosXSystem[] {
  return metrics.map((m) => ({
    id: newId(),
    name: m.memberName,
    siteId: '',
    formFactor: 'nios-x',
    tierName: 'M',
    // Issue #10: capture the workload metrics that don't round-trip through
    // the synthesized Site (role/model/platform/managed-IPs/host counts/dhcp
    // util/licenses) so the Sizer-mode report can render them per-member.
    importedMetrics: {
      role: m.role,
      model: m.model,
      platform: m.platform,
      managedIPCount: m.managedIPCount,
      staticHosts: m.staticHosts,
      dynamicHosts: m.dynamicHosts,
      dhcpUtilization: m.dhcpUtilization,
      licenses: m.licenses,
    },
  }));
}

// ─── importCloud (D-07, D-08) ────────────────────────────────────────────────

export function importCloud(
  provider: 'aws' | 'azure' | 'gcp',
  findings: FindingRow[],
): Region[] {
  // Group by (source, region). Filter findings to the requested provider.
  const groups = new Map<string, FindingRow[]>();
  for (const f of findings) {
    if (f.provider !== provider) continue;
    const key = `${f.source}::${f.region}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(f);
    } else {
      groups.set(key, [f]);
    }
  }

  const regions: Region[] = [];
  for (const rows of groups.values()) {
    const first = rows[0];
    const regionName = formatCloudRegionName(provider, first.source, first.region);
    const siteName = `${shortenSource(first.source)} ${first.region}`;
    const activeIPs = sumCount(rows.filter((r) => r.category === 'Active IP'));

    const site: Site = {
      id: newId(),
      name: siteName,
      multiplier: 1,
      activeIPs,
    };

    regions.push({
      id: newId(),
      name: regionName,
      type: provider,
      cloudNativeDns: true,
      countries: [unassignedCountry([site])],
    });
  }
  return regions;
}

// ─── importAd (D-10, D-11, Pitfall 9) ────────────────────────────────────────

export function importAd(
  findings: FindingRow[],
  _adMetrics?: ADServerMetricAPI[],
): { region: Region; site: Site } {
  const adRows = findings.filter((f) => f.provider === 'microsoft');
  const domain = adRows[0]?.source ?? 'Unknown Domain';

  // Pitfall 9: prefer Asset rows whose item matches /user/i; else fall back to
  // total Asset sum; else fall back to Active IP sum.
  const userAssetRows = adRows.filter(
    (f) => f.category === 'Asset' && /user/i.test(f.item),
  );
  const allAssetRows = adRows.filter((f) => f.category === 'Asset');
  const activeIPRows = adRows.filter((f) => f.category === 'Active IP');

  let users: number;
  if (userAssetRows.length > 0) {
    users = sumCount(userAssetRows);
  } else if (allAssetRows.length > 0) {
    users = sumCount(allAssetRows);
  } else {
    users = sumCount(activeIPRows);
  }

  const site: Site = {
    id: newId(),
    name: domain,
    multiplier: 1,
    users,
  };

  const region: Region = {
    id: newId(),
    name: 'On-Premises',
    type: 'on-premises',
    cloudNativeDns: false,
    countries: [unassignedCountry([site])],
  };

  return { region, site };
}

// ─── importFromScan (D-13, D-17) ─────────────────────────────────────────────

export function importFromScan(
  findings: FindingRow[],
  niosServerMetrics?: NiosServerMetricAPI[],
  adServerMetrics?: ADServerMetricAPI[],
): SizerFullState {
  const base = initialSizerState();

  // Cloud regions
  const awsRegions = importCloud('aws', findings);
  const azureRegions = importCloud('azure', findings);
  const gcpRegions = importCloud('gcp', findings);

  const regions: Region[] = [...awsRegions, ...azureRegions, ...gcpRegions];

  // AD: only emit a region if there are AD findings
  const adRows = findings.filter((f) => f.provider === 'microsoft');
  if (adRows.length > 0) {
    const { region } = importAd(adRows, adServerMetrics);
    regions.push(region);
  }

  // NIOS-X (D-04: from metrics, not findings)
  let niosx = niosServerMetrics ? importNios(niosServerMetrics) : [];

  // When the scan emitted NIOS-X members but no Regions (typical for a
  // NIOS Grid backup with no cloud / AD findings), synthesize a single
  // "Imported NIOS Grid" Region with one Site per member. The user then
  // lands on Step 2 with a usable hierarchy and can rename / regroup
  // members to real geographic Sites. NIOS-X rows are also linked to
  // their synthesized Site via `siteId` so the validator doesn't flag
  // them as orphans.
  if (regions.length === 0 && niosx.length > 0 && niosServerMetrics) {
    type Bucket = { country: string; city: string; sites: Site[] };
    const buckets = new Map<string, Bucket>();
    const memberIdToSiteId = new Map<string, string>();

    for (const m of niosServerMetrics) {
      const siteId = newId();
      memberIdToSiteId.set(m.memberId, siteId);
      // Pick the best non-zero IP metric per member so the validator's
      // "users OR activeIPs required" check is always satisfied. NIOS Grid
      // backups frequently report `activeIPCount = 0` for DHCP-only
      // members; `managedIPCount` and `staticHosts + dynamicHosts` cover
      // those rows. Fall back to 0 (defined, not undefined) when nothing
      // is available so the row doesn't trip SITE_NO_DRIVER.
      const hostsSum = (m.staticHosts ?? 0) + (m.dynamicHosts ?? 0);
      const ips =
        m.activeIPCount > 0
          ? m.activeIPCount
          : m.managedIPCount > 0
            ? m.managedIPCount
            : hostsSum > 0
              ? hostsSum
              : 0;
      // Issue #7: project the per-member NIOS DDI objectCount into the
      // synthesized Site so deriveMembersFromNiosx() — which derives member
      // objectCount as `(dnsRecords + dhcpScopes × 2) × multiplier` — surfaces
      // non-zero DDI in Migration Planner / Member Details after import.
      // dhcpScopes stays 0 so the value round-trips exactly (×2 doubling
      // would otherwise inflate the projection).
      const site: Site = {
        id: siteId,
        name: m.memberName,
        multiplier: 1,
        activeIPs: ips,
        dnsRecords: m.objectCount > 0 ? m.objectCount : undefined,
        qps: m.qps > 0 ? m.qps : undefined,
        lps: m.lps > 0 ? m.lps : undefined,
      };
      const { country, city } = parseGeoFromHostname(m.memberName);
      const key = `${country}::${city}`;
      const b = buckets.get(key);
      if (b) {
        b.sites.push(site);
      } else {
        buckets.set(key, { country, city, sites: [site] });
      }
    }

    // Build Country → City → Sites tree. Group buckets by country first.
    const byCountry = new Map<string, Map<string, Site[]>>();
    for (const b of buckets.values()) {
      let cities = byCountry.get(b.country);
      if (!cities) {
        cities = new Map();
        byCountry.set(b.country, cities);
      }
      cities.set(b.city, b.sites);
    }
    const countries: Country[] = [];
    for (const [countryName, cities] of byCountry) {
      const cityNodes: City[] = [];
      for (const [cityName, sites] of cities) {
        cityNodes.push({ id: newId(), name: cityName, sites });
      }
      countries.push({ id: newId(), name: countryName, cities: cityNodes });
    }
    regions.push({
      id: newId(),
      name: 'Imported NIOS Grid',
      type: 'on-premises',
      cloudNativeDns: false,
      countries: countries.length > 0 ? countries : [unassignedCountry()],
    });
    niosx = niosx.map((n, i) => ({
      ...n,
      siteId: memberIdToSiteId.get(niosServerMetrics[i].memberId) ?? n.siteId,
    }));
  }

  return {
    ...base,
    core: {
      ...base.core,
      regions,
      infrastructure: {
        ...base.core.infrastructure,
        niosx,
      },
    },
  };
}

// ─── mergeFullState (D-09, D-12, D-13, D-14) ─────────────────────────────────

export function mergeFullState(
  existing: SizerFullState,
  incoming: SizerFullState,
): SizerFullState {
  // Build dedup sets from existing tree.
  const existingRegionKeys = new Set<string>();
  const existingSiteKeysByRegion = new Map<string, Set<string>>();
  for (const r of existing.core.regions) {
    const rk = cloudRegionKey({ type: r.type, name: r.name });
    existingRegionKeys.add(rk);
    const skSet = new Set<string>();
    for (const c of r.countries) {
      for (const ct of c.cities) {
        for (const s of ct.sites) {
          skSet.add(siteKey(r.name, s));
        }
      }
    }
    existingSiteKeysByRegion.set(rk, skSet);
  }

  // Walk incoming regions
  let mergedRegions = existing.core.regions;
  for (const inR of incoming.core.regions) {
    const rk = cloudRegionKey({ type: inR.type, name: inR.name });
    if (!existingRegionKeys.has(rk)) {
      // Append entire Region tree as-is
      mergedRegions = [...mergedRegions, inR];
      continue;
    }
    // Region matched: walk its incoming Sites and append only new ones
    // (under the FIRST country/city for now — D-08 places Sites under
    // (Unassigned)/(Unassigned)).
    const existingSiteKeys = existingSiteKeysByRegion.get(rk)!;
    const newSites: Site[] = [];
    for (const c of inR.countries) {
      for (const ct of c.cities) {
        for (const s of ct.sites) {
          const sk = siteKey(inR.name, s);
          if (!existingSiteKeys.has(sk)) {
            newSites.push(s);
            existingSiteKeys.add(sk);
          }
        }
      }
    }
    if (newSites.length === 0) continue;
    // Append the new Sites under the matched Region's first country/first city.
    mergedRegions = mergedRegions.map((r) => {
      if (cloudRegionKey({ type: r.type, name: r.name }) !== rk) return r;
      if (r.countries.length === 0) {
        return { ...r, countries: [unassignedCountry(newSites)] };
      }
      const [firstC, ...restC] = r.countries;
      let cities = firstC.cities;
      if (cities.length === 0) {
        cities = [unassignedCity(newSites)];
      } else {
        cities = [
          { ...cities[0], sites: [...cities[0].sites, ...newSites] },
          ...cities.slice(1),
        ];
      }
      return { ...r, countries: [{ ...firstC, cities }, ...restC] };
    });
  }

  // NIOS-X dedup (D-05 case-insensitive name match)
  const existingNiosKeys = new Set<string>(
    existing.core.infrastructure.niosx.map(niosKey),
  );
  const newNiosx: NiosXSystem[] = [];
  for (const n of incoming.core.infrastructure.niosx) {
    const k = niosKey(n);
    if (existingNiosKeys.has(k)) continue;
    newNiosx.push(n);
    existingNiosKeys.add(k);
  }
  const mergedNiosx =
    newNiosx.length > 0
      ? [...existing.core.infrastructure.niosx, ...newNiosx]
      : existing.core.infrastructure.niosx;

  // D-13: ui, globalSettings, security are referentially preserved.
  return {
    ...existing,
    core: {
      ...existing.core,
      regions: mergedRegions,
      infrastructure: {
        ...existing.core.infrastructure,
        niosx: mergedNiosx,
      },
    },
  };
}
