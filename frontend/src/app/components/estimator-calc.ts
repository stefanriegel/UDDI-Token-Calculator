/**
 * estimator-calc.ts — Pure computation module for the Manual Sizing Estimator.
 *
 * No React imports. No side effects. All functions are deterministic and stateless.
 * Implements the full ESTIMATOR derivation chain from the official Infoblox UDDI
 * Estimator spreadsheet. Used by wizard.tsx and consumed by S03 (Reporting Tokens).
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface EstimatorInputs {
  /** Total active IP addresses in the environment */
  activeIPs: number;
  /** Fraction of IPs served by DHCP (0.0–1.0, e.g. 0.80 = 80%) */
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
}

// ─── Constants (spreadsheet defaults) ──────────────────────────────────────────

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
};

// Spreadsheet constants — do not alter
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

// ─── Main Calc ─────────────────────────────────────────────────────────────────

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

  // ── DHCP range multiplier (HA/FO requires 2× objects per scope/range) ────
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
    // DNS protocol logs — static clients generate queries every calendar day;
    // dynamic clients only on workdays (lease churn pattern)
    const dnsLogsStatic = enableDNSProtocol
      ? DAYS_PER_MONTH * QPD_PER_IP * staticClients
      : 0;
    const dnsLogsDynamic = enableDNSProtocol
      ? WORKDAYS_PER_MONTH * QPD_PER_IP * dynamicClients
      : 0;

    // DHCP logs — lease events per workday; lease event rate = renewals per hour × hours
    const dhcpClients = enableIPAM ? activeIPs * dhcpPct : 0;
    const dhcpLogs = enableDHCPLog
      ? (HOURS_PER_WORKDAY / (DHCP_LEASE_HOURS / 2) + 1) * WORKDAYS_PER_MONTH * dhcpClients
      : 0;

    monthlyLogVolume = dnsLogsStatic + dnsLogsDynamic + dhcpLogs;
  }

  return {
    ddiObjects,
    activeIPs: activeIPsOut,
    discoveredAssets,
    monthlyLogVolume,
  };
}
