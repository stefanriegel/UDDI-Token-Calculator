/**
 * sizer-derive.ts — 5-tier heuristics table and User → Site derive engine.
 *
 * Transcribed verbatim from the v2 spec §User → Site Derive in
 * `docs/superpowers/specs/2026-04-23-enhanced-manual-sizer-v2-design.md`
 * (as reproduced in `.planning/phases/29-.../29-RESEARCH.md` §Code Examples).
 *
 * Per Phase 29 CONTEXT decisions:
 *   - D-09: `deriveFromUsers(users, overrides?)` — per-field overrides always
 *           win over computed values. `DeriveOverrides` is a dedicated type
 *           (not `Partial<Site>`); `verifiedAssets` is intentionally NOT
 *           overridable — it is always recomputed from the (possibly
 *           overridden) `assets × tier.verifiedPct` per plan-check W-3.
 *   - D-01/D-02: spec formulas are the source of truth; no call into the
 *           infoblox research bundle.
 *
 * This module has a single runtime dependency on `./sizer-types` for the
 * `DeriveOverrides` type. It does NOT import `./sizer-calc` (would be a cycle;
 * calc consumes derive output through stored Site fields, not the other way).
 */

import type {
  DeriveOverrides,
  NiosXSystem,
  Region,
  Site,
  SizerState,
} from './sizer-types';
import {
  calculateManagementTokens,
  calculateServerTokens,
  calculateReportingTokens,
  calculateSecurityTokens,
  resolveOverheads,
} from './sizer-calc';
import type { ResultsSurfaceProps } from '../results/results-types';
import type { NiosServerMetrics } from '../nios-calc';
import type { FindingRow } from '../mock-data';

// ─── CALC_HEURISTICS — 5-tier table + global factors (spec verbatim) ──────────

/**
 * Upper-bound tier semantics: `users <= tier.maxUsers`. The final tier uses
 * `Infinity` so any positive user count resolves. The table values are
 * transcribed verbatim from the v2 spec §User → Site Derive and MUST NOT be
 * edited without a corresponding spec change.
 *
 * Frozen to prevent accidental mutation by consumers; structural typing keeps
 * the constants discoverable in tooling.
 */
export const CALC_HEURISTICS = Object.freeze({
  tiers: [
    { maxUsers: 1249,     assetsPerUser: 2,   verifiedPct: 0.22 },
    { maxUsers: 2499,     assetsPerUser: 2,   verifiedPct: 0.11 },
    { maxUsers: 4999,     assetsPerUser: 2,   verifiedPct: 0.38 },
    { maxUsers: 9999,     assetsPerUser: 1.5, verifiedPct: 0.19 },
    { maxUsers: Infinity, assetsPerUser: 1,   verifiedPct: 0.18 },
  ],
  activeIPsPerUser: 1.5,
  qpsPerUser: 3.2,
  usersPerNetwork: 250,
  usersPerZone: 500,
  dhcpPct: 0.8,
  avgLeaseDurationHours: 1,
  lpsMin: 1,
} as const);

// ─── deriveFromUsers ──────────────────────────────────────────────────────────

/** Return shape of {@link deriveFromUsers}. Flat object for easy destructuring. */
export interface DeriveResult {
  activeIPs: number;
  qps: number;
  lps: number;
  assets: number;
  verifiedAssets: number;
  unverifiedAssets: number;
  networksPerSite: number;
  dnsZones: number;
  dhcpScopes: number;
  dhcpPct: number;
  avgLeaseDuration: number;
}

/**
 * Derive a Site's sizing fields from a single `users` input.
 *
 * Per D-09, each field in {@link DeriveOverrides} wins over the computed
 * value (`overrides.X ?? computed`). `verifiedAssets` is NOT in
 * `DeriveOverrides` — it is always recomputed from the post-override
 * `assets × tier.verifiedPct` so the verified/unverified split stays
 * internally consistent.
 *
 * Caller contract: `users` must be a positive finite number. Validation of
 * missing/invalid inputs lives in `sizer-validate.ts` (D-13) — this function
 * trusts the incoming value and does not clamp.
 */
export function deriveFromUsers(
  users: number,
  overrides: DeriveOverrides = {},
): DeriveResult {
  const tier = CALC_HEURISTICS.tiers.find((t) => users <= t.maxUsers)!;
  const { assetsPerUser, verifiedPct } = tier;

  const activeIPs = overrides.activeIPs ?? Math.ceil(users * CALC_HEURISTICS.activeIPsPerUser);
  const qps       = overrides.qps       ?? Math.ceil(users * CALC_HEURISTICS.qpsPerUser);
  const assets    = overrides.assets    ?? Math.round(users * assetsPerUser);

  // verifiedAssets is derived from (possibly overridden) `assets`, never
  // directly overridable per D-09.
  const verifiedAssets   = Math.round(assets * verifiedPct);
  const unverifiedAssets = assets - verifiedAssets;

  const networksPerSite  = overrides.networksPerSite  ?? Math.max(1, Math.ceil(users / CALC_HEURISTICS.usersPerNetwork));
  const dnsZones         = overrides.dnsZones         ?? Math.max(1, Math.ceil(users / CALC_HEURISTICS.usersPerZone));
  const dhcpScopes       = overrides.dhcpScopes       ?? networksPerSite;
  const dhcpPct          = overrides.dhcpPct          ?? CALC_HEURISTICS.dhcpPct;
  const avgLeaseDuration = overrides.avgLeaseDuration ?? CALC_HEURISTICS.avgLeaseDurationHours;

  // Use post-override activeIPs and dhcpPct so that overriding either changes
  // the computed lps.
  const dhcpIPs = activeIPs * dhcpPct;
  const lps = overrides.lps ?? Math.max(
    CALC_HEURISTICS.lpsMin,
    Math.ceil(dhcpIPs / (avgLeaseDuration * 3600)),
  );

  return {
    activeIPs,
    qps,
    lps,
    assets,
    verifiedAssets,
    unverifiedAssets,
    networksPerSite,
    dnsZones,
    dhcpScopes,
    dhcpPct,
    avgLeaseDuration,
  };
}

// ─── Sizer → ResultsSurface adapter (Phase 33 Plan 05) ────────────────────────

/**
 * Strict subset of {@link ResultsSurfaceProps} that Sizer state can produce.
 * NIOS migration / AD migration props intentionally omitted (D-07): a pure
 * Sizer flow has no scan-side migration data. The surface's sizer-mode branch
 * (results-surface.tsx) only consumes these fields.
 */
export type SizerDerivedResultsProps = Pick<
  ResultsSurfaceProps,
  | 'findings'
  | 'effectiveFindings'
  | 'growthBufferPct'
  | 'serverGrowthBufferPct'
  | 'selectedProviders'
  | 'totalManagementTokens'
  | 'totalServerTokens'
  | 'reportingTokens'
  | 'securityTokens'
  | 'hasServerMetrics'
  | 'hybridScenario'
  | 'breakdownBySource'
  | 'outlineSections'
>;

/** Flatten every Site under a Region's countries → cities → sites tree. */
function flattenRegionSites(r: Region): Site[] {
  const out: Site[] = [];
  for (const c of r.countries) {
    for (const ci of c.cities) {
      for (const s of ci.sites) out.push(s);
    }
  }
  return out;
}

/** Reporting destination/logging toggles consumed by `calculateReportingTokens`. */
function reportingTogglesFromState(state: SizerState) {
  const g = state.globalSettings;
  return {
    csp: !!g.reportingCsp,
    s3: !!g.reportingS3,
    cdc: !!g.reportingCdc,
    dnsEnabled: !!g.dnsLoggingEnabled,
    dhcpEnabled: !!g.dhcpLoggingEnabled,
  };
}

// deriveSizerResultsProps — projects Sizer state into ResultsSurfaceProps subset.
// NIOS migration / AD migration props intentionally omitted (D-07).
// Phase 33 D-05 / D-10 / D-11.
export function deriveSizerResultsProps(state: SizerState): SizerDerivedResultsProps {
  const ovh = resolveOverheads(state);
  const allSites = state.regions.flatMap(flattenRegionSites);
  const reportingToggles = reportingTogglesFromState(state);

  const totalManagementTokens = calculateManagementTokens(allSites, ovh.mgmt);
  const sizerFindings = buildSizerSiteFindings(state.regions, ovh.mgmt);
  const totalServerTokens = calculateServerTokens(
    state.infrastructure.niosx,
    state.infrastructure.xaas,
    ovh.server,
  );
  const reportingTokens = calculateReportingTokens(allSites, ovh.reporting, reportingToggles);
  const securityTokens = calculateSecurityTokens(state.security, ovh.security);

  // Sizer state stores `growthBuffer` as a fraction (0..1). The surface's
  // contract uses the same `growthBufferPct` semantic (fraction, despite the
  // "Pct" suffix — see results-bom.tsx which formats it via × 100). There is
  // no separate server-side growth knob in Sizer state; reuse the same value.
  const growthBufferPct = state.globalSettings.growthBuffer ?? 0;
  const serverGrowthBufferPct = state.globalSettings.growthBuffer ?? 0;

  return {
    findings: sizerFindings,
    effectiveFindings: sizerFindings,
    growthBufferPct,
    serverGrowthBufferPct,
    selectedProviders: [],
    totalManagementTokens,
    totalServerTokens,
    reportingTokens,
    securityTokens,
    hasServerMetrics: totalServerTokens > 0,
    hybridScenario: null,
    breakdownBySource: [],
    outlineSections: [
      { id: 'section-overview', label: 'Overview' },
      { id: 'section-bom', label: 'Token Breakdown' },
      { id: 'section-export', label: 'Export' },
    ],
  };
}

// ─── Sizer per-Site findings (Issue #11) ─────────────────────────────────────

/**
 * Issue #11: hero's "By Source — Management" iterates `effectiveFindings` to
 * paint the per-source breakdown bars. Sizer mode shipped with `[]`, so the
 * section rendered empty even when total mgmt tokens were non-zero.
 *
 * Synthesize one FindingRow per Site so each Site shows up as a source row.
 * `managementTokens` is the per-Site mgmt total under the same formula and
 * overhead used for the aggregate hero number — sites with the same name
 * coalesce in the hero's Map keyed by `${provider}::${source}`, which is the
 * intended behaviour for cloned/multi-instance sites.
 *
 * Provider is fixed to `'nios'` because the Sizer flow is NIOS-X focused and
 * `PROVIDERS` carries an `id: 'nios'` entry the hero looks up for the bar
 * colour. `category`/`item`/`count`/`tokensPerUnit` are filler — only
 * `provider` / `source` / `managementTokens` are read by the hero.
 */
function buildSizerSiteFindings(regions: Region[], mgmtOverhead: number): FindingRow[] {
  const out: FindingRow[] = [];
  for (const r of regions) {
    for (const c of r.countries) {
      for (const ci of c.cities) {
        for (const s of ci.sites) {
          const mgmt = calculateManagementTokens([s], mgmtOverhead);
          if (mgmt <= 0) continue;
          const label = s.name?.trim() || ci.name || `Site ${s.id.slice(0, 6)}`;
          out.push({
            provider: 'nios',
            source: label,
            region: r.name,
            category: 'DDI Object',
            item: 'site',
            count: 0,
            tokensPerUnit: 0,
            managementTokens: mgmt,
          });
        }
      }
    }
  }
  return out;
}

// ─── Sizer → scan-shape member adapter (Phase 34 Plan 04, D-01/D-02) ─────────

// ─── Sizer migration-planner mgmt-token scenarios (Issue #6) ─────────────────

/**
 * Sizer-mode management-token scenarios for `<ResultsMigrationPlanner/>`.
 *
 * Scan-mode planner derives scenarios from `effectiveFindings` (per-source
 * UDDI sums + cloud baseline). Sizer has no findings stream — scenarios
 * collapse to 0. This helper bridges the gap by computing the same three
 * scenarios from Sizer state + the user's per-member migration map:
 *
 *   • current → 0 (no UDDI mgmt tokens when nothing is migrated)
 *   • hybrid  → calculateManagementTokens(sites of migrated NIOS-X members)
 *   • full    → calculateManagementTokens(all sites)  (== hero total)
 *
 * Uses Sizer's max-of-three formula (matches hero) so the planner stays
 * internally consistent with the report's Manual Sizer totals.
 */
export function computeSizerMgmtScenarios(
  niosx: ReadonlyArray<Pick<NiosXSystem, 'name' | 'siteId'>>,
  regions: Region[],
  mgmtOverhead: number,
  migratingMemberNames: Set<string>,
): { current: number; hybrid: number; full: number } {
  const sitesById = indexSitesById(regions);
  const allSites = regions.flatMap(flattenRegionSites);

  const migratingSiteIds = new Set(
    niosx.filter((m) => migratingMemberNames.has(m.name)).map((m) => m.siteId),
  );
  const migratingSites: Site[] = [];
  for (const siteId of migratingSiteIds) {
    const s = sitesById.get(siteId);
    if (s) migratingSites.push(s);
  }

  return {
    current: 0,
    hybrid: calculateManagementTokens(migratingSites, mgmtOverhead),
    full: calculateManagementTokens(allSites, mgmtOverhead),
  };
}

/** Build a fast `siteId → Site` lookup over the entire region tree. */
function indexSitesById(regions: Region[]): Map<string, Site> {
  const idx = new Map<string, Site>();
  for (const r of regions) {
    for (const c of r.countries) {
      for (const ci of c.cities) {
        for (const s of ci.sites) idx.set(s.id, s);
      }
    }
  }
  return idx;
}

/**
 * Adapter (D-02): projects Sizer `state.core.infrastructure.niosx` into the
 * canonical scan-side `NiosServerMetrics` shape (D-01) so the lifted shared
 * sub-components (`ResultsMigrationPlanner` / `ResultsMemberDetails` /
 * `ResultsResourceSavings`) can be mounted in Sizer mode with zero
 * conditional logic.
 *
 * Pure: no React, no useSizer, no input mutation. Output array order matches
 * input `niosx` order. Every required field of `NiosServerMetrics` is
 * populated — fields with no Sizer source default to `0` / `''` so downstream
 * presenters never receive `undefined` for a required field.
 */
export function deriveMembersFromNiosx(
  niosx: NiosXSystem[],
  regions: Region[],
  mgmtOverhead?: number,
): NiosServerMetrics[] {
  if (niosx.length === 0) return [];
  const sitesById = indexSitesById(regions);

  // Issue #8 — distribute per-Site mgmt tokens evenly across the NIOS-X
  // members assigned to that Site so per-member cards render a non-zero
  // mgmt-token figure in Sizer mode. Counts members per siteId once.
  const membersPerSite = new Map<string, number>();
  for (const m of niosx) {
    membersPerSite.set(m.siteId, (membersPerSite.get(m.siteId) ?? 0) + 1);
  }

  // Issue #12 — Migration Planner / Member Details key off `memberName`
  // (Map<string, ServerFormFactor>, dedupe Sets). Two NIOS-X systems sharing
  // the same default name ("New NIOS-X") collapse to one entry in those
  // structures while the calculator iterates the underlying array, producing
  // contradictory counts ("1 of 1 marked" vs "2 members selected"). Pre-pass
  // appends " #N" to duplicate names so every emitted member is uniquely
  // addressable downstream.
  const nameCounts = new Map<string, number>();
  for (const m of niosx) {
    nameCounts.set(m.name, (nameCounts.get(m.name) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const uniqueNames = niosx.map((m) => {
    if ((nameCounts.get(m.name) ?? 0) <= 1) return m.name;
    const idx = (seen.get(m.name) ?? 0) + 1;
    seen.set(m.name, idx);
    return `${m.name} #${idx}`;
  });

  return niosx.map((m, i) => {
    const site = sitesById.get(m.siteId);
    // Issue #10: prefer NIOS-import workload metrics when present so the
    // Sizer-mode report mirrors what the scan-side report rendered. Falls
    // back to Sizer-synthesized defaults for green-field flows.
    const im = m.importedMetrics;
    const role: NiosServerMetrics['role'] = im?.role ?? 'DNS/DHCP';
    const model = im?.model ?? `NIOS-X ${m.tierName}`;
    const platform =
      im?.platform ?? (m.formFactor === 'nios-xaas' ? 'XaaS' : 'NIOS-X');

    // Issue #5: project the Sizer DDI-object derivation into the shared
     // member-metrics shape so the Migration Planner / Member Details cards
     // surface non-zero DDI counts. Same formula calculateManagementTokens()
     // uses per Site: (dnsRecords + dhcpScopes × 2) × multiplier.
    const dnsRecords = site?.dnsRecords ?? 0;
    const dhcpScopes = site?.dhcpScopes ?? 0;
    const multiplier = site?.multiplier ?? 1;
    const objectCount = (dnsRecords + dhcpScopes * 2) * multiplier;

    // Per-member mgmt tokens: site-level mgmt tokens divided across the
    // NIOS-X members at the Site (ceil so totals never under-report).
    let managementTokens: number | undefined;
    if (mgmtOverhead !== undefined && site) {
      const siteMgmt = calculateManagementTokens([site], mgmtOverhead);
      const share = membersPerSite.get(m.siteId) ?? 1;
      managementTokens = Math.ceil(siteMgmt / share);
    }

    return {
      memberId: m.id,
      memberName: uniqueNames[i],
      role,
      qps: site?.qps ?? 0,
      lps: site?.lps ?? 0,
      objectCount,
      activeIPCount: site?.activeIPs ?? 0,
      model,
      platform,
      managedIPCount: im?.managedIPCount ?? 0,
      staticHosts: im?.staticHosts ?? 0,
      dynamicHosts: im?.dynamicHosts ?? 0,
      dhcpUtilization: im?.dhcpUtilization ?? 0,
      licenses: im?.licenses,
      managementTokens,
    };
  });
}
