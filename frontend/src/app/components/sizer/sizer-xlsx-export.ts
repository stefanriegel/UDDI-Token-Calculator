/**
 * sizer-xlsx-export.ts — Phase 31 Plan 02.
 *
 * Pure XLSX builder + thin browser-download wrapper. Per Phase 31 CONTEXT
 * decisions:
 *   - D-24: library = `write-excel-file` (v4 browser entry).
 *   - D-25: workbook structure = Summary + per-Region + Security sheets.
 *   - D-26: filename = `uddi-sizer-${YYYY-MM-DD}.xlsx` (date in filename only).
 *   - D-27: header rows are bold + #E5E7EB filled + thin-bordered.
 *   - D-28: split into pure `buildWorkbook(state)` + thin `downloadWorkbook(state)`
 *           wrapper. Only `buildWorkbook` is unit-tested.
 *
 * Security invariant — T-31-01 (formula-injection):
 *   Excel interprets cells starting with `=`, `+`, `-`, `@` as formulas. Every
 *   user-authored string cell (region/country/city/site/NIOS-X/XaaS name) MUST
 *   route through `safeStringCell()` which (a) forces `type: 'String'` and
 *   (b) prefixes a literal apostrophe when the value starts with one of the
 *   four dangerous characters.
 *
 * Purity rule:
 *   `buildWorkbook(state)` is a pure function. No `new Date()`, no
 *   `Math.random()`, no DOM access. The download wrapper is the ONLY place
 *   side effects (current date for filename, library-driven file save) occur.
 */

import type { SizerFullState } from './sizer-state';
import type { NiosXSystem, Region, SecurityInputs, Site } from './sizer-types';
import {
  calculateManagementTokens,
  calculateServerTokens,
  calculateReportingTokens,
  calculateSecurityTokens,
  resolveOverheads,
} from './sizer-calc';
import { deriveMembersFromNiosx } from './sizer-derive';
import {
  SERVER_TOKEN_TIERS,
  XAAS_TOKEN_TIERS,
  type ServerFormFactor,
  type ServerTokenTier,
} from '../shared/token-tiers';
import {
  calcMemberSavings,
  calcFleetSavings,
  type AppliancePlatform,
} from '../resource-savings';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Cell {
  value: string | number | null;
  type?: 'String' | 'Number';
  fontWeight?: 'bold';
  backgroundColor?: string;
  align?: 'left' | 'right' | 'center';
  borderStyle?: 'thin';
}

export interface SheetConfig {
  name: string;
  rows: Cell[][];
}

// ─── Cell helpers ─────────────────────────────────────────────────────────────

/**
 * T-31-01 mitigation. Any user-authored string flowing into an Excel cell MUST
 * pass through this helper. Forces `type: 'String'` and prepends an apostrophe
 * when the value starts with `=`, `+`, `-`, or `@` so spreadsheet apps don't
 * interpret it as a formula.
 */
export function safeStringCell(value: string): Cell {
  const s = value === null || value === undefined ? '' : String(value);
  const needsPrefix = /^[=+\-@]/.test(s);
  return {
    value: needsPrefix ? `'${s}` : s,
    type: 'String',
  };
}

function numberCell(n: number): Cell {
  return { value: n, type: 'Number', align: 'right' };
}

/**
 * Sanitize a string for use as an Excel sheet name. Excel forbids
 * `\ / ? * : [ ]`, requires non-blank, and caps length at 31 characters.
 * Replaces forbidden chars with `-` and truncates. Falls back to "Sheet"
 * when the input collapses to empty.
 */
export function safeSheetName(name: string): string {
  const cleaned = String(name ?? '').replace(/[\\/?*:[\]]/g, '-').trim();
  const truncated = cleaned.slice(0, 31);
  return truncated.length > 0 ? truncated : 'Sheet';
}

function headerCell(label: string): Cell {
  return {
    value: label,
    type: 'String',
    fontWeight: 'bold',
    backgroundColor: '#E5E7EB',
    borderStyle: 'thin',
  };
}

function totalsStringCell(label: string): Cell {
  return { value: label, type: 'String', fontWeight: 'bold', borderStyle: 'thin' };
}

function totalsNumberCell(n: number): Cell {
  return { value: n, type: 'Number', fontWeight: 'bold', align: 'right', borderStyle: 'thin' };
}

// ─── Aggregation helpers ──────────────────────────────────────────────────────

interface RegionAggregate {
  region: Region;
  countries: number;
  cities: number;
  sites: number;
  sitesFlat: Site[];
}

function aggregateRegion(r: Region): RegionAggregate {
  let cities = 0;
  let sites = 0;
  const sitesFlat: Site[] = [];
  for (const c of r.countries) {
    cities += c.cities.length;
    for (const ci of c.cities) {
      sites += ci.sites.length;
      for (const s of ci.sites) sitesFlat.push(s);
    }
  }
  return {
    region: r,
    countries: r.countries.length,
    cities,
    sites,
    sitesFlat,
  };
}

function allSites(state: SizerFullState): Site[] {
  const out: Site[] = [];
  for (const r of state.core.regions) {
    for (const c of r.countries) {
      for (const ci of c.cities) {
        for (const s of ci.sites) out.push(s);
      }
    }
  }
  return out;
}

// ─── Token math wrappers (per-region + total) ─────────────────────────────────

interface RegionTokens {
  mgmt: number;
  server: number;
  reporting: number;
  security: number;
}

function tokensForSites(
  sites: Site[],
  state: SizerFullState,
): RegionTokens {
  const ovh = resolveOverheads(state.core);
  const g = state.core.globalSettings;
  const reportingToggles = {
    csp: !!g.reportingCsp,
    s3: !!g.reportingS3,
    cdc: !!g.reportingCdc,
    dnsEnabled: !!g.dnsLoggingEnabled,
    dhcpEnabled: !!g.dhcpLoggingEnabled,
  };
  return {
    mgmt: calculateManagementTokens(sites, ovh.mgmt),
    // Server/Security totals are infrastructure-/security-scoped (not per-site
    // attributable). For per-region rows we report 0 here; the totals row
    // shows the global server/security values from the state.
    server: 0,
    reporting: calculateReportingTokens(sites, ovh.reporting, reportingToggles),
    security: 0,
  };
}

// ─── Sheet builders ───────────────────────────────────────────────────────────

function buildSummarySheet(state: SizerFullState): SheetConfig {
  const ovh = resolveOverheads(state.core);
  const g = state.core.globalSettings;
  const sites = allSites(state);
  const reportingToggles = {
    csp: !!g.reportingCsp,
    s3: !!g.reportingS3,
    cdc: !!g.reportingCdc,
    dnsEnabled: !!g.dnsLoggingEnabled,
    dhcpEnabled: !!g.dhcpLoggingEnabled,
  };

  const mgmt = calculateManagementTokens(sites, ovh.mgmt);
  const server = calculateServerTokens(
    state.core.infrastructure.niosx,
    state.core.infrastructure.xaas,
    ovh.server,
  );
  const reporting = calculateReportingTokens(sites, ovh.reporting, reportingToggles);
  const security = calculateSecurityTokens(state.core.security, ovh.security);

  const rows: Cell[][] = [];

  // Header row
  rows.push([headerCell('Category'), headerCell('Tokens'), headerCell('Contribution')]);

  // 4 category rows
  rows.push([
    safeStringCell('Management'),
    numberCell(mgmt),
    safeStringCell(`${sites.length} site(s) — DDI/IP/Asset max × (1 + ${ovh.mgmt})`),
  ]);
  rows.push([
    safeStringCell('Server'),
    numberCell(server),
    safeStringCell(
      `${state.core.infrastructure.niosx.length} NIOS-X + ${state.core.infrastructure.xaas.length} XaaS`,
    ),
  ]);
  rows.push([
    safeStringCell('Reporting'),
    numberCell(reporting),
    safeStringCell(
      `CSP=${reportingToggles.csp ? 'on' : 'off'} S3=${reportingToggles.s3 ? 'on' : 'off'} CDC=${reportingToggles.cdc ? 'on' : 'off'}`,
    ),
  ]);
  rows.push([
    safeStringCell('Security'),
    numberCell(security),
    safeStringCell(state.core.security.securityEnabled ? 'enabled' : 'disabled'),
  ]);

  // Blank row
  rows.push([]);

  // Per-region breakdown header
  rows.push([
    headerCell('Region'),
    headerCell('Countries'),
    headerCell('Cities'),
    headerCell('Sites'),
    headerCell('Mgmt'),
    headerCell('Server'),
    headerCell('Reporting'),
    headerCell('Security'),
  ]);

  let totCountries = 0;
  let totCities = 0;
  let totSites = 0;
  let totMgmt = 0;
  let totServer = 0;
  let totReporting = 0;
  let totSecurity = 0;

  for (const r of state.core.regions) {
    const agg = aggregateRegion(r);
    const tk = tokensForSites(agg.sitesFlat, state);
    rows.push([
      safeStringCell(r.name),
      numberCell(agg.countries),
      numberCell(agg.cities),
      numberCell(agg.sites),
      numberCell(tk.mgmt),
      numberCell(tk.server),
      numberCell(tk.reporting),
      numberCell(tk.security),
    ]);
    totCountries += agg.countries;
    totCities += agg.cities;
    totSites += agg.sites;
    totMgmt += tk.mgmt;
    totServer += tk.server;
    totReporting += tk.reporting;
    totSecurity += tk.security;
  }

  // Totals row — note: server/security totals come from global calc, not per-region sum
  rows.push([
    totalsStringCell('Total'),
    totalsNumberCell(totCountries),
    totalsNumberCell(totCities),
    totalsNumberCell(totSites),
    totalsNumberCell(totMgmt),
    totalsNumberCell(server),
    totalsNumberCell(totReporting),
    totalsNumberCell(security),
  ]);
  // (totServer, totReporting are tracked for symmetry but server/security
  //  totals use the global calc to reflect overhead application.)
  void totServer;

  return { name: 'Summary', rows };
}

function buildRegionSheet(r: Region): SheetConfig {
  const rows: Cell[][] = [];

  rows.push([
    headerCell('Country'),
    headerCell('City'),
    headerCell('Site'),
    headerCell('Multiplier'),
    headerCell('Users'),
    headerCell('QPS'),
    headerCell('LPS'),
    headerCell('Active IPs'),
    headerCell('Assets'),
    headerCell('Verified'),
    headerCell('Unverified'),
    headerCell('DNS Records'),
    headerCell('DHCP Scopes'),
  ]);

  for (const c of r.countries) {
    for (const ci of c.cities) {
      for (const s of ci.sites) {
        rows.push([
          safeStringCell(c.name),
          safeStringCell(ci.name),
          safeStringCell(s.name),
          numberCell(s.multiplier),
          numberCell(s.users ?? 0),
          numberCell(s.qps ?? 0),
          numberCell(s.lps ?? 0),
          numberCell(s.activeIPs ?? 0),
          numberCell(s.assets ?? 0),
          numberCell(s.verifiedAssets ?? 0),
          numberCell(s.unverifiedAssets ?? 0),
          numberCell(s.dnsRecords ?? 0),
          numberCell(s.dhcpScopes ?? 0),
        ]);
      }
    }
  }

  // Sheet name guard — region name flows into sheet name.
  // Excel forbids `\ / ? * : [ ]` and caps at 31 chars; safeSheetName enforces both.
  return { name: safeSheetName(`Region ${r.name}`), rows };
}

function buildSecuritySheet(state: SizerFullState): SheetConfig {
  const ovh = resolveOverheads(state.core);
  const sec: SecurityInputs = state.core.security;
  const total = calculateSecurityTokens(sec, ovh.security);

  const rows: Cell[][] = [];

  rows.push([headerCell('Field'), headerCell('Value')]);
  rows.push([safeStringCell('Security Enabled'), safeStringCell(sec.securityEnabled ? 'true' : 'false')]);
  rows.push([safeStringCell('SOC Insights'), safeStringCell(sec.socInsightsEnabled ? 'true' : 'false')]);
  rows.push([safeStringCell('Verified Assets'), numberCell(sec.tdVerifiedAssets)]);
  rows.push([safeStringCell('Unverified Assets'), numberCell(sec.tdUnverifiedAssets)]);
  rows.push([safeStringCell('Dossier Queries / Day'), numberCell(sec.dossierQueriesPerDay)]);
  rows.push([safeStringCell('Lookalike Domains'), numberCell(sec.lookalikeDomainsMentioned)]);
  rows.push([safeStringCell('Security Overhead'), numberCell(ovh.security)]);
  rows.push([]);

  // Per-region verified/unverified breakdown (from site-derived defaults)
  rows.push([
    headerCell('Region'),
    headerCell('Verified (sum)'),
    headerCell('Unverified (sum)'),
  ]);
  for (const r of state.core.regions) {
    let v = 0;
    let u = 0;
    for (const c of r.countries) {
      for (const ci of c.cities) {
        for (const s of ci.sites) {
          v += s.verifiedAssets ?? 0;
          u += s.unverifiedAssets ?? 0;
        }
      }
    }
    rows.push([safeStringCell(r.name), numberCell(v), numberCell(u)]);
  }

  rows.push([]);
  rows.push([totalsStringCell('Total Security Tokens'), totalsNumberCell(total)]);

  return { name: 'Security', rows };
}

// ─── Phase 34 Plan 07 — Report parity sheets ──────────────────────────────────
//
// Sheet names are locked verbatim by 34-UI-SPEC.md "XLSX sheet names" copy
// block: "Site Breakdown", "NIOS Migration Plan", "Member Details",
// "Resource Savings". Mirror the scan-flow workbook shape so SEs see the same
// columns regardless of which path produced the workbook.
//
// Empty-data guard:
//   - Site Breakdown emitted whenever ≥ 1 region exists.
//   - The other three sheets are gated on `niosx.length > 0`.
//
// Shape choice for Site Breakdown:
//   FLAT — one row per leaf Site, with Region/Country/City repeated on each
//   row. Keeps the sheet sortable/filterable in Excel without needing
//   roll-up groupings; aggregates can be reconstructed via a pivot table.

/** Look up the smallest tier that fits all three load metrics. Mirrors
 * `calcServerTokenTier` in nios-calc.ts but kept local to avoid pulling React
 * deps into this pure module. */
function pickTier(qps: number, lps: number, objects: number, ff: ServerFormFactor): ServerTokenTier {
  const tiers = ff === 'nios-xaas' ? XAAS_TOKEN_TIERS : SERVER_TOKEN_TIERS;
  for (const t of tiers) {
    if (qps <= t.maxQps && lps <= t.maxLps && objects <= t.maxObjects) return t;
  }
  return tiers[tiers.length - 1];
}

/** Locate the tier object by name within the appropriate tier table. */
function tierByName(name: string, ff: ServerFormFactor): ServerTokenTier {
  const tiers = ff === 'nios-xaas' ? XAAS_TOKEN_TIERS : SERVER_TOKEN_TIERS;
  return tiers.find((t) => t.name === name) ?? tiers[0];
}

/** Walk the region tree and yield one entry per leaf Site with its hierarchy. */
function flatSiteRows(state: SizerFullState): Array<{
  region: Region;
  countryName: string;
  cityName: string;
  site: Site;
}> {
  const out: Array<{ region: Region; countryName: string; cityName: string; site: Site }> = [];
  for (const r of state.core.regions) {
    for (const c of r.countries) {
      for (const ci of c.cities) {
        for (const s of ci.sites) {
          out.push({ region: r, countryName: c.name, cityName: ci.name, site: s });
        }
      }
    }
  }
  return out;
}

function buildSiteBreakdownSheet(state: SizerFullState): SheetConfig {
  const ovh = resolveOverheads(state.core);
  const rows: Cell[][] = [];

  rows.push([
    headerCell('Region'),
    headerCell('Country'),
    headerCell('City'),
    headerCell('Site'),
    headerCell('Active IPs'),
    headerCell('Users'),
    headerCell('QPS'),
    headerCell('LPS'),
    headerCell('Tokens'),
  ]);

  for (const entry of flatSiteRows(state)) {
    // Per D-11 (aggregate-then-divide), per-Site mgmt token contribution is
    // computed by routing the single Site through `calculateManagementTokens`.
    const tokens = calculateManagementTokens([entry.site], ovh.mgmt);
    rows.push([
      safeStringCell(entry.region.name),
      safeStringCell(entry.countryName),
      safeStringCell(entry.cityName),
      safeStringCell(entry.site.name),
      numberCell(entry.site.activeIPs ?? 0),
      numberCell(entry.site.users ?? 0),
      numberCell(entry.site.qps ?? 0),
      numberCell(entry.site.lps ?? 0),
      numberCell(tokens),
    ]);
  }

  return { name: 'Site Breakdown', rows };
}

/** Build a `niosxId → {region,country,city,site}` lookup for sheets that need
 * to render hierarchy alongside member rows (Member Details). */
function indexNiosxLocation(state: SizerFullState): Map<string, { region: string; country: string; city: string; site: string }> {
  const idx = new Map<string, { region: string; country: string; city: string; site: string }>();
  for (const r of state.core.regions) {
    for (const c of r.countries) {
      for (const ci of c.cities) {
        for (const s of ci.sites) {
          for (const m of state.core.infrastructure.niosx) {
            if (m.siteId === s.id) {
              idx.set(m.id, { region: r.name, country: c.name, city: ci.name, site: s.name });
            }
          }
        }
      }
    }
  }
  return idx;
}

function buildNiosMigrationPlanSheet(state: SizerFullState): SheetConfig {
  const members = deriveMembersFromNiosx(state.core.infrastructure.niosx, state.core.regions);
  const niosxById = new Map<string, NiosXSystem>(
    state.core.infrastructure.niosx.map((m) => [m.id, m]),
  );

  const rows: Cell[][] = [];
  rows.push([
    headerCell('Hostname'),
    headerCell('Role'),
    headerCell('Model'),
    headerCell('Form Factor'),
    headerCell('Current Tier'),
    headerCell('Target Tier'),
    headerCell('Server Tokens'),
  ]);

  for (const m of members) {
    const sx = niosxById.get(m.memberId);
    const ff: ServerFormFactor = sx?.formFactor ?? 'nios-x';
    // Current tier comes from auto-derive on observed load; target tier from
    // the user's explicit Sizer pick (sx.tierName). For green-field Sizer
    // imports these match; we surface both so the SE can spot mismatches.
    const currentTier = pickTier(m.qps, m.lps, m.objectCount, ff);
    const targetTier = sx ? tierByName(sx.tierName, ff) : currentTier;
    rows.push([
      safeStringCell(m.memberName),
      safeStringCell(String(m.role)),
      safeStringCell(m.model),
      safeStringCell(ff === 'nios-xaas' ? 'XaaS' : 'NIOS-X'),
      safeStringCell(currentTier.name),
      safeStringCell(targetTier.name),
      numberCell(targetTier.serverTokens),
    ]);
  }

  return { name: 'NIOS Migration Plan', rows };
}

function buildMemberDetailsSheet(state: SizerFullState): SheetConfig {
  const members = deriveMembersFromNiosx(state.core.infrastructure.niosx, state.core.regions);
  const locIdx = indexNiosxLocation(state);

  const rows: Cell[][] = [];
  rows.push([
    headerCell('Hostname'),
    headerCell('Role'),
    headerCell('Model'),
    headerCell('Platform'),
    headerCell('QPS'),
    headerCell('LPS'),
    headerCell('Objects'),
    headerCell('Active IPs'),
    headerCell('Region'),
    headerCell('Country'),
    headerCell('City'),
    headerCell('Site'),
  ]);

  for (const m of members) {
    const loc = locIdx.get(m.memberId);
    rows.push([
      safeStringCell(m.memberName),
      safeStringCell(String(m.role)),
      safeStringCell(m.model),
      safeStringCell(m.platform),
      numberCell(m.qps),
      numberCell(m.lps),
      numberCell(m.objectCount),
      numberCell(m.activeIPCount),
      safeStringCell(loc?.region ?? ''),
      safeStringCell(loc?.country ?? ''),
      safeStringCell(loc?.city ?? ''),
      safeStringCell(loc?.site ?? ''),
    ]);
  }

  return { name: 'Member Details', rows };
}

function buildResourceSavingsSheet(state: SizerFullState): SheetConfig {
  const members = deriveMembersFromNiosx(state.core.infrastructure.niosx, state.core.regions);
  const niosxById = new Map<string, NiosXSystem>(
    state.core.infrastructure.niosx.map((m) => [m.id, m]),
  );

  const perMember = members.map((m) => {
    const sx = niosxById.get(m.memberId);
    const ff: ServerFormFactor = sx?.formFactor ?? 'nios-x';
    const tier = sx ? tierByName(sx.tierName, ff) : pickTier(m.qps, m.lps, m.objectCount, ff);
    // Sizer NIOS-X rows don't carry an old physical model — calcMemberSavings
    // falls through to lookupMissing semantics, returning zeros for old/delta.
    // That's expected for a green-field Sizer build; only Phase 32 imports
    // that preserved a `model` would surface non-zero deltas. We keep the row
    // present so the per-member structure is identical to the scan workbook.
    const platform = (m.platform === 'XaaS' ? 'AWS' : (m.platform || 'Physical')) as AppliancePlatform;
    return calcMemberSavings(
      { memberId: m.memberId, memberName: m.memberName, model: '', platform },
      tier,
      ff,
    );
  });

  const fleet = calcFleetSavings(perMember);

  const rows: Cell[][] = [];

  // Fleet totals section
  rows.push([headerCell('Fleet Totals'), headerCell('Value')]);
  rows.push([safeStringCell('Member Count'), numberCell(fleet.memberCount)]);
  rows.push([safeStringCell('Total Old vCPU'), numberCell(fleet.totalOldVCPU)]);
  rows.push([safeStringCell('Total Old RAM (GB)'), numberCell(fleet.totalOldRamGB)]);
  rows.push([safeStringCell('Total New vCPU'), numberCell(fleet.totalNewVCPU)]);
  rows.push([safeStringCell('Total New RAM (GB)'), numberCell(fleet.totalNewRamGB)]);
  rows.push([safeStringCell('Total Delta vCPU'), numberCell(fleet.totalDeltaVCPU)]);
  rows.push([safeStringCell('Total Delta RAM (GB)'), numberCell(fleet.totalDeltaRamGB)]);
  rows.push([safeStringCell('Physical Units Retired'), numberCell(fleet.physicalUnitsRetired)]);
  rows.push([]);

  // Per-member section
  rows.push([
    headerCell('Hostname'),
    headerCell('Old Model'),
    headerCell('Old Platform'),
    headerCell('Old vCPU'),
    headerCell('Old RAM (GB)'),
    headerCell('Target Form Factor'),
    headerCell('Target Tier'),
    headerCell('New vCPU'),
    headerCell('New RAM (GB)'),
    headerCell('Delta vCPU'),
    headerCell('Delta RAM (GB)'),
  ]);

  for (const ms of perMember) {
    rows.push([
      safeStringCell(ms.memberName),
      safeStringCell(ms.oldModel),
      safeStringCell(ms.oldPlatform),
      numberCell(ms.oldVCPU),
      numberCell(ms.oldRamGB),
      safeStringCell(ms.targetFormFactor === 'nios-xaas' ? 'XaaS' : 'NIOS-X'),
      safeStringCell(ms.newTierName),
      numberCell(ms.newVCPU),
      numberCell(ms.newRamGB),
      numberCell(ms.deltaVCPU),
      numberCell(ms.deltaRamGB),
    ]);
  }

  return { name: 'Resource Savings', rows };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Pure builder. Identical input → identical output. No Date/random/DOM.
 * Returns a `SheetConfig[]` consumable by `downloadWorkbook` (browser save) or
 * by tests / future server-side renderers.
 */
export function buildWorkbook(state: SizerFullState): SheetConfig[] {
  const sheets: SheetConfig[] = [];
  sheets.push(buildSummarySheet(state));
  for (const r of state.core.regions) {
    sheets.push(buildRegionSheet(r));
  }
  sheets.push(buildSecuritySheet(state));

  // Phase 34 Plan 07 — Sizer Report parity sheets.
  // Site Breakdown emits whenever the Sizer has at least one Region.
  if (state.core.regions.length > 0) {
    sheets.push(buildSiteBreakdownSheet(state));
  }
  // The remaining three sheets are gated on `niosx.length > 0` to mirror the
  // UI section visibility rules (REQ-02..REQ-04 / REQ-06).
  if (state.core.infrastructure.niosx.length > 0) {
    sheets.push(buildNiosMigrationPlanSheet(state));
    sheets.push(buildMemberDetailsSheet(state));
    sheets.push(buildResourceSavingsSheet(state));
  }
  return sheets;
}

/**
 * Thin browser-download wrapper. Loads the `write-excel-file/browser` entry
 * lazily so this module remains importable in node test contexts that mock
 * the library out, and so the heavy library is not pulled into the main
 * Vite chunk graph until the user clicks the export button.
 *
 * Per D-26 the date appears in the filename ONLY — never inside cells.
 */
export async function downloadWorkbook(state: SizerFullState): Promise<void> {
  const sheets = buildWorkbook(state);
  const date = new Date().toISOString().slice(0, 10);
  const fileName = `uddi-sizer-${date}.xlsx`;

  // write-excel-file v4 browser entry — multi-sheet uses one descriptor per sheet.
  // Use the explicit `/browser` subpath — the bare specifier has no default export.
  const writeXlsxFile = (await import('write-excel-file/browser')).default as unknown as (
    sheets: Array<{ data: unknown[][]; sheet: string }>,
  ) => { toFile: (name: string) => Promise<void>; toBlob: () => Promise<Blob> };

  // write-excel-file expects `type` as the JS constructor (String/Number/Date/Boolean),
  // not a string literal. Map at the boundary so internal Cell records stay
  // serializable and unit-test-friendly.
  const typeCtorMap: Record<string, unknown> = { String, Number };
  const sheetDescriptors = sheets.map((s) => ({
    sheet: s.name,
    data: s.rows.map((row) =>
      row.map((c) =>
        c.type ? { ...c, type: typeCtorMap[c.type] } : c,
      ),
    ),
  }));
  await writeXlsxFile(sheetDescriptors).toFile(fileName);
}
