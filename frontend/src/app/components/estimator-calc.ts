/**
 * estimator-calc.ts - Pure computation module for the Manual Sizing Estimator.
 *
 * No React imports. No side effects. All functions are deterministic and stateless.
 * Implements the full ESTIMATOR derivation chain from the official Infoblox UDDI
 * Estimator spreadsheet. Used by wizard.tsx and consumed by S03 (Reporting Tokens).
 */

import { calcServerTokenTier, consolidateXaasInstances, SERVER_TOKEN_TIERS, XAAS_TOKEN_TIERS, type ServerFormFactor } from './nios-calc';

// ── Types ──────────────────────────────────────────────────────────────────────

/** A single server entry for granular per-server sizing in the Manual Estimator. */
export interface ServerEntry {
  /** Display name (e.g. "DNS Primary", "Branch Office 1") */
  name: string;
  /** Form factor: on-prem NIOS-X or cloud-hosted XaaS */
  formFactor: ServerFormFactor;
  /** Average DNS queries per second */
  qps: number;
  /** Average DHCP leases per second */
  lps: number;
  /** DNS + DHCP objects managed */
  objects: number;
  /** When set to a tier name (e.g. 'S', 'M', 'XL'), uses that tier's max values instead of manual qps/lps/objects. Empty string or undefined = Custom (manual entry). */
  tierOverride?: string;
}

export interface EstimatorInputs {
  /** Total active IP addresses in the environment */
  activeIPs: number;
  /** Fraction of IPs served by DHCP (0.0-1.0, e.g. 0.80 = 80%) */
  dhcpPct: number;
  /** Enable IPAM module (required for activeIPsOut + discoveredAssets) */
  enableIPAM: boolean;
  /** Enable DNS management */
  enableDNS: boolean;
  /** Enable DNS protocol logging (contributes to monthlyLogVolume) */
  enableDNSProtocol: boolean;
  /** Enable DHCP management */
  enableDHCP: boolean;
  /** Enable DHCP lease logging (contributes to monthlyLogVolume) */
  enableDHCPLog: boolean;
  /** Number of physical sites / branches */
  sites: number;
  /** Number of IP networks per site */
  networksPerSite: number;
  /** Optional override for discovered assets (defaults to activeIPs when IPAM enabled) */
  assets?: number;

  // ── Server sizing ─────────────────────────────────────────────────────────
  /** Granular per-server entries with individual form factor and metrics. */
  serverEntries: ServerEntry[];
}

/** Per-server token breakdown returned alongside totals. */
export interface ServerTokenDetail {
  /** Server name from the entry */
  name: string;
  /** Form factor */
  formFactor: ServerFormFactor;
  /** Tier name (e.g. "M", "XL") */
  tierName: string;
  /** Tokens for this individual server (before XaaS consolidation) */
  serverTokens: number;
  /** Input QPS */
  qps: number;
  /** Input LPS */
  lps: number;
  /** Input objects */
  objects: number;
}

export interface EstimatorOutputs {
  /** Total estimated DDI objects (DNS records + DHCP ranges, with buffer) */
  ddiObjects: number;
  /** Total active IPs visible in IPAM (0 when IPAM disabled) */
  activeIPs: number;
  /** Discovered assets (0 when IPAM disabled) */
  discoveredAssets: number;
  /** Monthly log volume in events (0 when no protocol logging enabled) */
  monthlyLogVolume: number;
  /** Total server tokens across all entries (0 when no entries) */
  serverTokens: number;
  /** Per-server token breakdown for UI display */
  serverTokenDetails: ServerTokenDetail[];
  /**
   * Per-destination reporting token breakdown. Populated by the wizard which owns
   * destination toggle state; NOT populated by calcEstimator (always []).
   */
  reportingTokenBreakdown: ReportingDestinationResult[];
  /**
   * Total reporting tokens across enabled destinations with growth buffer applied.
   * Populated by the wizard; NOT populated by calcEstimator (always 0).
   */
  totalReportingTokens: number;
}

// ── Reporting Token Types ──────────────────────────────────────────────────────

/** Metadata for a single reporting destination (CSP, S3, Ecosystem, Local Syslog). */
export interface ReportingDestination {
  /** Stable identifier used in inputs/outputs (e.g. "csp", "s3", "ecosystem", "local-syslog") */
  id: string;
  /** Human-readable label shown in the UI */
  label: string;
  /** Reporting tokens per 10M events (0 for display-only destinations) */
  rate: number;
  /** When true the destination always contributes 0 tokens regardless of event count */
  isDisplayOnly: boolean;
}

/** Input for a single destination in a calcReportingTokens call. */
export interface ReportingDestinationInput {
  /** Must match a ReportingDestination.id in REPORTING_DESTINATIONS */
  destinationId: string;
  /** Event count for this destination (e.g. monthlyLogVolume or monthlyLogVolume * 0.4) */
  events: number;
  /** When false, this destination contributes 0 tokens even if rate > 0 */
  enabled: boolean;
}

/** Per-destination result returned by calcReportingTokens. */
export interface ReportingDestinationResult {
  /** Echoes the input destinationId */
  destinationId: string;
  /** Human-readable label from REPORTING_DESTINATIONS */
  label: string;
  /** Event count used in this calculation */
  events: number;
  /** Tokens contributed by this destination (0 when disabled or isDisplayOnly) */
  tokens: number;
  /** Echoes the input enabled flag */
  enabled: boolean;
}

// ── Reporting Destinations Constant ────────────────────────────────────────────

/**
 * PM-approved destination list from CALCULATOR sheet.
 * Rates are tokens per 10M events (ROUNDUP semantics via Math.ceil).
 */
export const REPORTING_DESTINATIONS: ReportingDestination[] = [
  { id: 'csp',          label: 'CSP Active Search', rate: 80, isDisplayOnly: false },
  { id: 's3',           label: 'S3 Bucket',         rate: 40, isDisplayOnly: false },
  { id: 'ecosystem',    label: 'Ecosystem (CDC)',    rate: 40, isDisplayOnly: false },
  { id: 'local-syslog', label: 'Local Syslog',       rate: 0,  isDisplayOnly: true  },
];

// ── Constants (spreadsheet defaults) ───────────────────────────────────────────

export const EstimatorDefaults: EstimatorInputs = {
  activeIPs: 1000,
  dhcpPct: 0.80,
  enableIPAM: true,
  enableDNS: true,
  enableDNSProtocol: false,
  enableDHCP: true,
  enableDHCPLog: false,
  sites: 1,
  networksPerSite: 4,
  serverEntries: [],
};

// Spreadsheet constants - do not alter
const QPD_PER_IP = 3500;           // queries per day per IP (DNS protocol logging)
const DNS_RECS_PER_IP = 2;         // static DNS records per static client
const DNS_RECS_PER_LEASE = 4;      // DNS records per dynamic/DHCP client
const BUFFER_OVERHEAD = 0.15;      // 15% object buffer
const ASSETS_PER_SITE = 2;         // discovered asset density multiplier
const DHCP_OBJ_MODIFIER = 2;       // HA/FO DHCP range multiplier
const DHCP_LEASE_HOURS = 1;        // average DHCP lease duration (hours)
const DAYS_PER_MONTH = 31;
const WORKDAYS_PER_MONTH = 22;
const HOURS_PER_WORKDAY = 9;

// ── Reporting Token Calc ───────────────────────────────────────────────────────

/**
 * Compute per-destination reporting token breakdown and total.
 *
 * Formula per enabled, non-display-only destination:
 *   tokens = ROUNDUP(events / 10_000_000) * rate
 *          = Math.ceil(events / 10_000_000) * rate
 *
 * Growth buffer is applied to the sum:
 *   total = Math.ceil(sum * (1 + growthBufferPct))
 *
 * Local Syslog (isDisplayOnly) always contributes 0 regardless of enabled state
 * or event count -- its rate is 0 by definition.
 *
 * The caller is responsible for deriving each destination's event count.
 * Ecosystem (CDC) defaults to 40% of monthlyLogVolume (wizard responsibility).
 *
 * Failure visibility: if an unknown destinationId is passed, that input is skipped
 * and does NOT appear in the breakdown. Callers can detect this by comparing
 * breakdown.length to inputs.length.
 *
 * @param inputs       Per-destination event counts and enabled flags
 * @param growthBufferPct  Fractional growth buffer (e.g. 0.15 for 15%)
 */
export function calcReportingTokens(
  inputs: ReportingDestinationInput[],
  growthBufferPct: number,
): { breakdown: ReportingDestinationResult[]; total: number } {
  const breakdown: ReportingDestinationResult[] = [];
  let sum = 0;

  for (const input of inputs) {
    const dest = REPORTING_DESTINATIONS.find(d => d.id === input.destinationId);
    if (!dest) continue; // unknown id -- skip silently; caller can detect via breakdown.length

    const tokens =
      input.enabled && !dest.isDisplayOnly
        ? Math.ceil(input.events / 10_000_000) * dest.rate
        : 0;

    sum += tokens;
    breakdown.push({
      destinationId: input.destinationId,
      label: dest.label,
      events: input.events,
      tokens,
      enabled: input.enabled,
    });
  }

  const total = breakdown.length === 0 ? 0 : Math.ceil(sum * (1 + growthBufferPct));

  return { breakdown, total };
}

// ── Tier Override Resolution ────────────────────────────────────────────────────

/**
 * Resolve effective QPS/LPS/Objects for a server entry.
 * When tierOverride is set, returns the tier's max values; otherwise returns the entry's manual values.
 */
export function resolveServerEntryValues(entry: ServerEntry): { qps: number; lps: number; objects: number } {
  if (entry.tierOverride) {
    const tiers = entry.formFactor === 'nios-xaas' ? XAAS_TOKEN_TIERS : SERVER_TOKEN_TIERS;
    const tier = tiers.find(t => t.name === entry.tierOverride);
    if (tier) {
      return { qps: tier.maxQps, lps: tier.maxLps, objects: tier.maxObjects };
    }
  }
  return { qps: entry.qps, lps: entry.lps, objects: entry.objects };
}

// ── Main Calc ──────────────────────────────────────────────────────────────────

/**
 * Derive all estimator outputs from questionnaire inputs.
 * Implements the full formula chain from the ESTIMATOR spreadsheet.
 */
export function calcEstimator(inputs: EstimatorInputs): EstimatorOutputs {
  const {
    activeIPs,
    dhcpPct,
    enableIPAM,
    enableDNS,
    enableDNSProtocol,
    enableDHCP,
    enableDHCPLog,
    sites,
    networksPerSite,
    assets,
    serverEntries,
  } = inputs;

  // ── Client split ──────────────────────────────────────────────────────────
  // Derive dynamic first (ROUNDUP), then static = total - dynamic.
  // This avoids the (1 - dhcpPct) float-complement error (e.g. 1-0.80 = 0.1999...).
  const dynamicClients = Math.ceil(activeIPs * dhcpPct);          // ROUNDUP
  const staticClients = activeIPs - dynamicClients;               // remainder = ROUNDDOWN equivalent

  // ── DNS records ───────────────────────────────────────────────────────────
  const dnsRecords = enableDNS
    ? dynamicClients * DNS_RECS_PER_LEASE + staticClients * DNS_RECS_PER_IP
    : 0;

  // ── DHCP range multiplier (HA/FO requires 2x objects per scope/range) ────
  const dhcpRangeMult = enableDHCP && enableIPAM ? DHCP_OBJ_MODIFIER : 0;

  // ── DDI objects (DNS records + DHCP networks/ranges + 15% buffer) ─────────
  const rawDdiObjects = dnsRecords + networksPerSite * sites * dhcpRangeMult;
  const ddiObjects = Math.round(rawDdiObjects * (1 + BUFFER_OVERHEAD));

  // ── Active IPs visible in IPAM ────────────────────────────────────────────
  // Asset density adds discovered endpoints per site/network on top of IPs
  const activeIPsOut = enableIPAM
    ? activeIPs + ASSETS_PER_SITE * sites * networksPerSite
    : 0;

  // ── Discovered assets ─────────────────────────────────────────────────────
  const discoveredAssets = enableIPAM ? (assets ?? activeIPs) : 0;

  // ── Monthly log volume (events/month) ─────────────────────────────────────
  let monthlyLogVolume = 0;

  if (enableDNSProtocol || enableDHCPLog) {
    // DNS protocol logs - static clients generate queries every calendar day;
    // dynamic clients only on workdays (lease churn pattern)
    const dnsLogsStatic = enableDNSProtocol
      ? DAYS_PER_MONTH * QPD_PER_IP * staticClients
      : 0;
    const dnsLogsDynamic = enableDNSProtocol
      ? WORKDAYS_PER_MONTH * QPD_PER_IP * dynamicClients
      : 0;

    // DHCP logs - lease events per workday; lease event rate = renewals per hour x hours
    const dhcpClients = enableIPAM ? activeIPs * dhcpPct : 0;
    const dhcpLogs = enableDHCPLog
      ? (HOURS_PER_WORKDAY / (DHCP_LEASE_HOURS / 2) + 1) * WORKDAYS_PER_MONTH * dhcpClients
      : 0;

    monthlyLogVolume = dnsLogsStatic + dnsLogsDynamic + dhcpLogs;
  }

  // ── Server tokens (per-entry granular sizing) ─────────────────────────────
  let serverTokens = 0;
  const serverTokenDetails: ServerTokenDetail[] = [];

  if (serverEntries.length > 0) {
    // NIOS-X entries: each gets its own tier independently
    const niosXEntries = serverEntries.filter(e => e.formFactor === 'nios-x');
    for (const entry of niosXEntries) {
      const { qps, lps, objects } = resolveServerEntryValues(entry);
      const tier = calcServerTokenTier(qps, lps, objects, 'nios-x');
      serverTokens += tier.serverTokens;
      serverTokenDetails.push({
        name: entry.name,
        formFactor: 'nios-x',
        tierName: tier.name,
        serverTokens: tier.serverTokens,
        qps,
        lps,
        objects,
      });
    }

    // XaaS entries: consolidate into instances using the same algorithm
    // as the NIOS migration planner
    const xaasEntries = serverEntries.filter(e => e.formFactor === 'nios-xaas');
    if (xaasEntries.length > 0) {
      const xaasMetrics = xaasEntries.map(e => {
        const { qps, lps, objects } = resolveServerEntryValues(e);
        return {
        memberId: e.name,
        memberName: e.name,
        role: 'Manual' as const,
        qps,
        lps,
        objectCount: objects,
        activeIPCount: 0,
        managedIPCount: 0,
        staticHosts: 0,
        dynamicHosts: 0,
        dhcpUtilization: 0,
        licenses: {} as Record<string, boolean>,
      };
      });
      const instances = consolidateXaasInstances(xaasMetrics);
      // For details, attribute the instance tokens back to individual entries
      // proportionally. For single-entry instances, it's exact.
      for (const inst of instances) {
        serverTokens += inst.totalTokens;
        // Each member in the instance gets a detail line showing the instance tier
        for (const member of inst.members) {
          const entry = xaasEntries.find(e => e.name === member.memberName);
          serverTokenDetails.push({
            name: entry?.name ?? member.memberName,
            formFactor: 'nios-xaas',
            tierName: inst.tier.name,
            serverTokens: inst.members.length === 1
              ? inst.totalTokens
              : Math.round(inst.totalTokens / inst.members.length),
            qps: member.qps,
            lps: member.lps,
            objects: member.objectCount,
          });
        }
      }
    }
  }

  return {
    ddiObjects,
    activeIPs: activeIPsOut,
    discoveredAssets,
    monthlyLogVolume,
    serverTokens,
    serverTokenDetails,
    reportingTokenBreakdown: [],
    totalReportingTokens: 0,
  };
}

// ── Validation Warnings ────────────────────────────────────────────────────────

/**
 * Derive a list of non-blocking advisory warnings for the Manual Sizing Estimator.
 * Each warning is a plain string — no em-dashes, no HTML markup.
 *
 * Five rules (source: ESTIMATOR spreadsheet advisory notes):
 *   W1 — Discovered assets exceed active IPs (suggests a data entry error)
 *   W2 — Protocol logging enabled but no server entries (incomplete sizing)
 *   W3 — DDI-to-IP ratio is unusually low (modules may not be fully enabled)
 *   W4 — Server entries defined with IPAM disabled (asset counts excluded)
 *   W5 — Growth buffer is 0% (environment growth not accounted for)
 *
 * Observability: the returned array is rendered in the amber advisory banner in
 * wizard.tsx. An empty array means no banner is shown. Each element maps to one
 * list item. Future agents can inspect warnings by calling this function directly
 * with the current estimatorAnswers state object.
 *
 * @param answers        Current estimator questionnaire answers
 * @param growthBufferPct  Fractional growth buffer (e.g. 0.15 for 15%)
 * @returns Array of warning strings; empty when all checks pass
 */
export function computeEstimatorWarnings(
  answers: EstimatorInputs,
  growthBufferPct: number,
): string[] {
  const warnings: string[] = [];

  // W1: Assets exceed active IPs
  if (
    answers.enableIPAM &&
    answers.assets !== undefined &&
    answers.assets > answers.activeIPs
  ) {
    warnings.push(
      `Discovered assets (${answers.assets.toLocaleString()}) exceed active IPs (${answers.activeIPs.toLocaleString()}). Verify the asset count is correct.`,
    );
  }

  // W2: Protocol logging enabled but no server entries defined
  if (
    (answers.enableDNSProtocol || answers.enableDHCPLog) &&
    answers.serverEntries.length === 0
  ) {
    warnings.push(
      'Protocol logging is enabled but no server entries are defined. Add at least one server to complete the sizing.',
    );
  }

  // W3: Low DDI-to-IP ratio
  const out = calcEstimator(answers);
  if (out.activeIPs > 0 && out.ddiObjects / out.activeIPs < 2) {
    warnings.push(
      'DDI object count relative to active IPs is unusually low. Verify that DNS and DHCP modules are enabled and the object counts are correct.',
    );
  }

  // W4: Server entries defined but IPAM disabled
  if (answers.serverEntries.length > 0 && !answers.enableIPAM) {
    warnings.push(
      'Server entries are defined but IPAM is disabled. Enable IPAM to include discovered asset counts in the estimate.',
    );
  }

  // W5: Growth buffer is 0%
  if (growthBufferPct === 0) {
    warnings.push(
      'Growth buffer is 0%. Consider adding at least 10-20% to account for environment growth over the subscription period.',
    );
  }

  return warnings;
}
