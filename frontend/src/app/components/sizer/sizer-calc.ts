/**
 * sizer-calc.ts — Token calc engine for the Sizer core.
 *
 * All formulas transcribed verbatim from the v2 spec §Token Calculation
 * (`docs/superpowers/specs/2026-04-23-enhanced-manual-sizer-v2-design.md`).
 * Per Phase 29 CONTEXT D-01/D-02, spec is the source of truth — NOT the
 * tokens.infoblox.com bundle and NOT `research-tokens-infoblox-dist.js`.
 *
 * Key Phase 29 decisions honoured:
 *   - D-07: `resolveOverheads(state)` returns a frozen per-category record.
 *   - D-08: Calc functions accept the MINIMAL data they need (Sites, niosx,
 *           xaas, primitive overhead) — not the full `SizerState`.
 *   - D-10: Tier tables imported from `shared/token-tiers.ts`.
 *   - D-11: This module has its own tier picker (linear `.find`); it does
 *           NOT call `calcServerTokenTier` from `nios-calc.ts`.
 *
 * Module dependency direction is ONE-WAY:
 *   sizer-calc.ts → shared/token-tiers.ts
 *   sizer-calc.ts → sizer-types.ts
 * It does NOT import from `sizer-derive.ts` (to keep the graph acyclic). The
 * `dhcpPct` default of 0.8 is duplicated here intentionally — mirrored from
 * `CALC_HEURISTICS.dhcpPct`. Keep the two in sync.
 */

import type {
  SizerState,
  Site,
  NiosXSystem,
  XaasServicePoint,
  SecurityInputs,
} from './sizer-types';
import {
  SERVER_TOKEN_TIERS,
  XAAS_TOKEN_TIERS,
  XAAS_EXTRA_CONNECTION_COST,
  type ServerTokenTier,
} from '../shared/token-tiers';

// ─── Constants — spec §Token Calculation, verbatim ─────────────────────────────

/**
 * Frozen CALC block — every Infoblox-sourced magic number in one place.
 * Source: spec §Token Calculation.
 */
export const CALC = Object.freeze({
  workDayPerMonth: 22,
  dayPermonth: 31, // sic — spec uses lowercase 'm'; preserve to match source
  hoursPerWorkday: 9,
  dnsRecPerIp: 2,
  dnsRecPerLease: 3.5,
  dnsMultiplier: 3.2,
  assetMultiplier: 3,
  socInsightMultiplier: 1.35,
  dossierListPrice: 4500,
  lookalikesListPrice: 12000,
  tokenPrice: 10,
  tdEstimatedQueriesPerDay: 2200,
  tdDaysPerMonth: 30,
  CSPQTYEvents: 1e7,
  S3BucketQTYEvents: 1e7,
  EcosystemQTYEvents: 1e7,
} as const);

/** Management divisors — spec §Management. */
export const MGMT_RATES = Object.freeze({ ddi: 25, activeIP: 13, asset: 3 } as const);

/** Reporting per-10M-event rates — spec §Reporting (CSP 80, S3 40, CDC 40). */
export const REPORTING_RATES = Object.freeze({ search: 80, log: 40, cdc: 40 } as const);

// ─── resolveOverheads — D-07 ───────────────────────────────────────────────────

function pick(advanced: boolean, category: number | undefined, fallback: number): number {
  if (!advanced) return fallback;
  return category ?? fallback;
}

/**
 * Resolve per-category overhead fractions from `state.globalSettings`, applying
 * the D-07 fallback chain: when `growthBufferAdvanced === false` OR a per-category
 * override is `undefined`, the category falls back to `growthBuffer`.
 *
 * Returns a frozen object — attempts to mutate throw in strict mode.
 */
export function resolveOverheads(state: SizerState): Readonly<{
  mgmt: number;
  server: number;
  reporting: number;
  security: number;
}> {
  const g = state.globalSettings;
  const adv = g.growthBufferAdvanced;
  const fb = g.growthBuffer;
  return Object.freeze({
    mgmt: pick(adv, g.mgmtOverhead, fb),
    server: pick(adv, g.serverOverhead, fb),
    reporting: pick(adv, g.reportingOverhead, fb),
    security: pick(adv, g.securityOverhead, fb),
  });
}

// ─── Management — spec §Management Tokens (verbatim) ───────────────────────────

/**
 * `ceil( max(ddiObjects/25, activeIPs/13, assets/3) × (1 + mgmtOverhead) )`
 * aggregated across `sites` where each Site contributes
 *   ddiObjects += (dnsRecords + dhcpScopes × 2) × multiplier
 *   activeIPs  += activeIPs × multiplier
 *   assets     += assets × multiplier
 *
 * Missing optional fields (`?? 0`) contribute 0; validation (plan 05) catches
 * truly-invalid states upstream. Per D-08, takes `Site[]` not `SizerState`.
 */
export function calculateManagementTokens(sites: Site[], mgmtOverhead: number): number {
  let ddiObjects = 0;
  let activeIPsTotal = 0;
  let assetsTotal = 0;

  for (const s of sites) {
    const m = s.multiplier;
    const dnsRecords = s.dnsRecords ?? 0;
    const dhcpScopes = s.dhcpScopes ?? 0;
    const activeIPs = s.activeIPs ?? 0;
    const assets = s.assets ?? 0;

    ddiObjects += (dnsRecords + dhcpScopes * 2) * m;
    activeIPsTotal += activeIPs * m;
    assetsTotal += assets * m;
  }

  const mgmtMax = Math.max(
    Math.ceil(ddiObjects / MGMT_RATES.ddi),
    Math.ceil(activeIPsTotal / MGMT_RATES.activeIP),
    Math.ceil(assetsTotal / MGMT_RATES.asset),
  );
  return Math.ceil(mgmtMax * (1 + mgmtOverhead));
}

// ─── Server — spec §Server Tokens ──────────────────────────────────────────────

/**
 * Per D-11: Sizer's own linear tier picker, decoupled from `calcServerTokenTier`
 * in `nios-calc.ts`. Returns `undefined` for unknown names — validator flags.
 */
function pickTier(tiers: readonly ServerTokenTier[], name: string): ServerTokenTier | undefined {
  return tiers.find((t) => t.name === name);
}

/**
 * Total = ceil( (Σ nios tier.serverTokens + Σ xaas (tier.serverTokens + extra)) × (1 + serverOverhead) )
 * where `extra = max(0, xaas.connections − tier.maxConnections) × XAAS_EXTRA_CONNECTION_COST`.
 *
 * Unknown `tierName` → system silently skipped (validator reports separately).
 * Per D-08, takes the two infrastructure arrays directly.
 */
export function calculateServerTokens(
  niosx: NiosXSystem[],
  xaas: XaasServicePoint[],
  serverOverhead: number,
): number {
  let niosSum = 0;
  for (const n of niosx) {
    const tier = pickTier(SERVER_TOKEN_TIERS, n.tierName);
    if (!tier) continue;
    niosSum += tier.serverTokens;
  }

  let xaasSum = 0;
  for (const x of xaas) {
    const tier = pickTier(XAAS_TOKEN_TIERS, x.tierName);
    if (!tier) continue;
    const maxConn = tier.maxConnections ?? 0;
    const extra = Math.max(0, x.connections - maxConn) * XAAS_EXTRA_CONNECTION_COST;
    xaasSum += tier.serverTokens + extra;
  }

  return Math.ceil((niosSum + xaasSum) * (1 + serverOverhead));
}

// ─── Reporting — spec §Reporting Tokens (verbatim lines 246-253) ───────────────

/**
 * Static/Dynamic split from `research-tokens-infoblox-dist.js` function `l`:
 *   Dynamic = (dnsRecords − dhcpIPs × dnsRecPerIp) / (dnsRecPerLease − dnsRecPerIp)
 *   Static  = dhcpIPs − Dynamic
 * Fallback when either is negative: `{ Static: 0.2 × dhcpIPs, Dynamic: 0.8 × dhcpIPs }`.
 */
function splitIPs(dhcpIPs: number, dnsRecords: number): { Static: number; Dynamic: number } {
  const Dynamic =
    (dnsRecords - dhcpIPs * CALC.dnsRecPerIp) / (CALC.dnsRecPerLease - CALC.dnsRecPerIp);
  const Static = dhcpIPs - Dynamic;
  if (Dynamic < 0 || Static < 0) {
    return { Static: 0.2 * dhcpIPs, Dynamic: 0.8 * dhcpIPs };
  }
  return { Static, Dynamic };
}

const SECONDS_PER_DAY = 86400;
/**
 * Default DHCP percentage when `Site.dhcpPct` is undefined. Mirrors
 * `CALC_HEURISTICS.dhcpPct` from `sizer-derive.ts` — duplicated here intentionally
 * to keep this module's dep graph one-way (calc does not import derive).
 */
const DEFAULT_DHCP_PCT = 0.8;

/**
 * Reporting tokens across all sites, applied per-destination (CSP/S3/CDC).
 *
 * Per RESEARCH Q3 resolution: per-Site Static/Dynamic split first, aggregate
 * `totalLogs` across multipliers, then apply per-destination rate math.
 *
 * Per-Site log math (spec lines 247-248 VERBATIM):
 *   dnsLogs/month  = dnsQPD × (31 × StaticIPs + 22 × DynamicIPs)
 *   dhcpLogs/month = (1 + 9 / (leaseDuration / 2)) × 22 × DynamicIPs
 *
 * Per-destination token math (spec lines 250-252 VERBATIM):
 *   searchTk = ceil( ceil(totalLogs / 1e7) × (1 + ovh) × 80 )   // CSP
 *   s3Tk     = ceil( ceil(totalLogs / 1e7) × (1 + ovh) × 40 )   // S3
 *   cdcTk    = ceil( ceil(totalLogs / 1e7) × (1 + ovh) × 40 )   // CDC
 *
 * Note the 31 / 9 / 22 magic numbers are CALC.dayPermonth / CALC.hoursPerWorkday /
 * CALC.workDayPerMonth — used by name below.
 */
export function calculateReportingTokens(
  sites: Site[],
  reportingOverhead: number,
  toggles: { csp: boolean; s3: boolean; cdc: boolean; dnsEnabled: boolean; dhcpEnabled: boolean },
): number {
  let totalLogs = 0;

  for (const s of sites) {
    const m = s.multiplier;
    const activeIPs = s.activeIPs ?? 0;
    const dhcpPct = s.dhcpPct ?? DEFAULT_DHCP_PCT;
    const dnsRecords = s.dnsRecords ?? 0;
    const qps = s.qps ?? 0;
    const leaseDuration = s.avgLeaseDuration ?? 1;

    const dhcpIPs = activeIPs * dhcpPct;
    const { Static: StaticIPs, Dynamic: DynamicIPs } = splitIPs(dhcpIPs, dnsRecords);

    const dnsQPD = qps * SECONDS_PER_DAY;

    // spec line 247 verbatim: 31 = CALC.dayPermonth, 22 = CALC.workDayPerMonth
    const dnsLogsPerMonth = toggles.dnsEnabled
      ? dnsQPD * (CALC.dayPermonth * StaticIPs + CALC.workDayPerMonth * DynamicIPs) * m
      : 0;

    // spec line 248 verbatim: 9 = CALC.hoursPerWorkday, 22 = CALC.workDayPerMonth
    const dhcpLogsPerMonth = toggles.dhcpEnabled
      ? (1 + CALC.hoursPerWorkday / (leaseDuration / 2)) * CALC.workDayPerMonth * DynamicIPs * m
      : 0;

    totalLogs += dnsLogsPerMonth + dhcpLogsPerMonth;
  }

  const applyDest = (qtyEvents: number, rate: number): number =>
    Math.ceil(Math.ceil(totalLogs / qtyEvents) * (1 + reportingOverhead) * rate);

  let tokens = 0;
  if (toggles.csp) tokens += applyDest(CALC.CSPQTYEvents, REPORTING_RATES.search); // 80 — searchTk
  if (toggles.s3) tokens += applyDest(CALC.S3BucketQTYEvents, REPORTING_RATES.log); // 40 — s3Tk
  if (toggles.cdc) tokens += applyDest(CALC.EcosystemQTYEvents, REPORTING_RATES.cdc); // 40 — cdcTk
  return tokens;
}

// ─── Security — spec §Security Tokens (verbatim lines 261-270) ─────────────────

/**
 * Security tokens:
 *   - `securityEnabled === false` → 0
 *   - `tdCloud  = ceil( (verified + unverified) × 3 × [socMult if SOC] × (1 + ovh) )`
 *   - `dossier    = ceil(queriesPerDay / 25) × 450  × (1 + ovh)`
 *   - `lookalikes = ceil(domains / 25)       × 1200 × (1 + ovh)`
 *   - Return `tdCloud + ceil(dossier) + round(lookalikes)`
 *
 * Asymmetric `Math.ceil(dossier)` + `Math.round(lookalikes)` preserved
 * deliberately (RESEARCH A4 / Q1 resolution) — matches tokens.infoblox.com
 * bundle behaviour, spec is silent on the final rounding.
 *
 * 450  = CALC.dossierListPrice    / CALC.tokenPrice = 4500  / 10
 * 1200 = CALC.lookalikesListPrice / CALC.tokenPrice = 12000 / 10
 */
export function calculateSecurityTokens(
  inputs: SecurityInputs,
  securityOverhead: number,
): number {
  if (!inputs.securityEnabled) return 0;

  let tdCloud = (inputs.tdVerifiedAssets + inputs.tdUnverifiedAssets) * CALC.assetMultiplier;
  if (inputs.socInsightsEnabled) tdCloud *= CALC.socInsightMultiplier;
  tdCloud = Math.ceil(tdCloud * (1 + securityOverhead));

  const dossierPerUnit = CALC.dossierListPrice / CALC.tokenPrice; // 450
  const lookalikesPerUnit = CALC.lookalikesListPrice / CALC.tokenPrice; // 1200

  const dossier =
    Math.ceil(inputs.dossierQueriesPerDay / 25) * dossierPerUnit * (1 + securityOverhead);
  const lookalikes =
    Math.ceil(inputs.lookalikeDomainsMentioned / 25) * lookalikesPerUnit * (1 + securityOverhead);

  return tdCloud + Math.ceil(dossier) + Math.round(lookalikes);
}
