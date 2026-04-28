/**
 * nios-calc.ts — Pure computation functions and types for NIOS Phase 11 panels.
 *
 * No React imports. No side effects. All functions are deterministic and stateless.
 * Used by wizard.tsx for Migration Planner, Server Token Calculator, and XaaS Consolidation.
 */

// ─── Re-exports (relocated to shared/token-tiers.ts per Phase 29 D-10) ────────
// Tier tables and their types now live in a shared module so Sizer and NIOS calc
// can both consume them. These re-exports keep existing downstream imports working.

export {
  SERVER_TOKEN_TIERS,
  XAAS_TOKEN_TIERS,
  XAAS_EXTRA_CONNECTION_COST,
  XAAS_MAX_EXTRA_CONNECTIONS,
} from './shared/token-tiers';
export type { ServerTokenTier, ServerFormFactor } from './shared/token-tiers';

import {
  SERVER_TOKEN_TIERS,
  XAAS_TOKEN_TIERS,
  XAAS_EXTRA_CONNECTION_COST,
  XAAS_MAX_EXTRA_CONNECTIONS,
  type ServerTokenTier,
  type ServerFormFactor,
} from './shared/token-tiers';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface NiosServerMetrics {
  memberId: string;
  memberName: string;
  role: 'GM' | 'GMC' | 'DNS' | 'DHCP' | 'DNS/DHCP' | 'IPAM' | 'Reporting' | string;
  qps: number;
  lps: number;
  objectCount: number;
  activeIPCount: number;
  model: string;
  platform: string;
  managedIPCount: number;
  staticHosts: number;
  dynamicHosts: number;
  dhcpUtilization: number;
  licenses?: Record<string, boolean>;
  /**
   * Optional precomputed management-token total for this member. Sizer-mode
   * adapters populate this (per-Site mgmt tokens distributed across members
   * at the Site) so per-member cards can render a non-zero value without
   * relying on `FindingRow` filtering. When absent, presenters fall back to
   * computing from `effectiveFindings` (scan mode).
   */
  managementTokens?: number;
}

export interface ConsolidatedXaasInstance {
  /** 0-based instance index */
  index: number;
  /** Member names consolidated into this instance */
  members: NiosServerMetrics[];
  /** Aggregate QPS */
  totalQps: number;
  /** Aggregate LPS */
  totalLps: number;
  /** Aggregate object count */
  totalObjects: number;
  /** Number of connections used = member count */
  connectionsUsed: number;
  /** Calculated XaaS tier based on aggregate metrics + connection count */
  tier: ServerTokenTier;
  /** Extra connections purchased (if connectionsUsed > tier.maxConnections) */
  extraConnections: number;
  /** Extra connection token cost */
  extraConnectionTokens: number;
  /** Total tokens (tier tokens + extra connection tokens) */
  totalTokens: number;
}

// ─── Calc Functions ────────────────────────────────────────────────────────────

/**
 * Determine the smallest tier that fits all three metrics.
 * Linear scan — first tier where ALL three values are within limits wins.
 * If no tier fits (exceeds even XL), returns the last tier (XL cap).
 *
 * Source: Figma mock-data.ts lines 585–591
 */
export function calcServerTokenTier(
  qps: number,
  lps: number,
  objectCount: number = 0,
  formFactor: ServerFormFactor = 'nios-x',
): ServerTokenTier {
  const tiers = formFactor === 'nios-xaas' ? XAAS_TOKEN_TIERS : SERVER_TOKEN_TIERS;
  for (const tier of tiers) {
    if (qps <= tier.maxQps && lps <= tier.maxLps && objectCount <= tier.maxObjects) return tier;
  }
  return tiers[tiers.length - 1]; // cap at XL
}

/**
 * Consolidate XaaS-mapped members into the fewest possible XaaS instances.
 * Each instance is sized by the aggregate QPS/LPS/Objects of its members,
 * then bumped up if the member count exceeds the tier's maxConnections.
 * Members that exceed the XL tier capacity spill into additional instances.
 *
 * Algorithm (source: Figma mock-data.ts lines 630-701):
 * 1. Sort members by QPS descending (largest first for better bin-packing).
 * 2. Accumulate members into a running "current instance" using SUM aggregation.
 * 3. If adding the next member would push aggregate beyond XL capacity
 *    OR connectionsUsed would exceed XL.maxConnections + 400 extra, flush.
 * 4. For each completed instance: find smallest XaaS tier fitting the aggregate,
 *    bump tier if connections exceed tier's maxConnections.
 */
export function consolidateXaasInstances(members: NiosServerMetrics[]): ConsolidatedXaasInstance[] {
  if (members.length === 0) return [];

  // Sort members by QPS descending (largest first for better bin-packing)
  const sorted = [...members].sort((a, b) => (b.qps + b.lps * 100) - (a.qps + a.lps * 100));
  const instances: ConsolidatedXaasInstance[] = [];
  const xlTier = XAAS_TOKEN_TIERS[XAAS_TOKEN_TIERS.length - 1];
  const maxExtraConnections = XAAS_MAX_EXTRA_CONNECTIONS;

  let currentMembers: NiosServerMetrics[] = [];
  let runningQps = 0;
  let runningLps = 0;
  let runningObjects = 0;

  const flushInstance = () => {
    if (currentMembers.length === 0) return;
    const connectionsUsed = currentMembers.length;
    // Find smallest tier that fits BOTH metrics AND connection count.
    // Walk tiers from smallest to largest; pick the first where metrics fit
    // and connections fit within the tier's maxConnections.
    let metricsTier: ServerTokenTier | null = null;
    for (const tier of XAAS_TOKEN_TIERS) {
      if (runningQps <= tier.maxQps && runningLps <= tier.maxLps && runningObjects <= tier.maxObjects
          && connectionsUsed <= (tier.maxConnections || 0)) {
        metricsTier = tier;
        break;
      }
    }
    // If no tier fits connections within base limit, use XL + extra connections.
    // Extra connections are ONLY allowed at XL (the biggest tier).
    if (!metricsTier) {
      metricsTier = XAAS_TOKEN_TIERS[XAAS_TOKEN_TIERS.length - 1]; // XL
    }
    const baseConnections = metricsTier.maxConnections || 0;
    const extraConnections = Math.max(0, connectionsUsed - baseConnections);
    const extraConnectionTokens = extraConnections * XAAS_EXTRA_CONNECTION_COST;
    instances.push({
      index: instances.length,
      members: [...currentMembers],
      totalQps: runningQps,
      totalLps: runningLps,
      totalObjects: runningObjects,
      connectionsUsed,
      tier: metricsTier,
      extraConnections,
      extraConnectionTokens,
      totalTokens: metricsTier.serverTokens + extraConnectionTokens,
    });
    currentMembers = [];
    runningQps = 0;
    runningLps = 0;
    runningObjects = 0;
  };

  for (const member of sorted) {
    const nextQps = runningQps + member.qps;
    const nextLps = runningLps + member.lps;
    const nextObjects = runningObjects + member.objectCount;
    const nextCount = currentMembers.length + 1;

    // Would adding this member exceed XL capacity (metrics or max connections + 400 extra)?
    if (currentMembers.length > 0 && (
      nextQps > xlTier.maxQps ||
      nextLps > xlTier.maxLps ||
      nextObjects > xlTier.maxObjects ||
      nextCount > (xlTier.maxConnections || 0) + maxExtraConnections
    )) {
      flushInstance();
    }

    currentMembers.push(member);
    runningQps += member.qps;
    runningLps += member.lps;
    runningObjects += member.objectCount;
  }

  flushInstance();
  return instances;
}

// ─── Mock Data (demo mode only) ────────────────────────────────────────────────
// Used when backend.isDemo === true. Live mode uses scanResults.niosServerMetrics.
// Ported from Figma mock-data.ts lines 735–800.

export const MOCK_NIOS_SERVER_METRICS: NiosServerMetrics[] = [
  // GM with DNS/DHCP workload — appears as normal migration candidate
  { memberId: 'gm-01', memberName: 'infoblox-gm.corp.example.com', role: 'GM', qps: 8420, lps: 145, objectCount: 21897, activeIPCount: 0, model: 'IB-4030', platform: 'Physical', managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: { enterprise: true, nios: true } },
  // GMC with DNS/DHCP workload — appears as normal migration candidate
  { memberId: 'gmc-01', memberName: 'infoblox-gmc.corp.example.com', role: 'GMC', qps: 3200, lps: 80, objectCount: 15400, activeIPCount: 0, model: 'IB-4030', platform: 'Physical', managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: { enterprise: true, nios: true } },
  // GM without DNS/DHCP (management only) — replaced by UDDI Portal, not selectable
  { memberId: 'gm-02', memberName: 'infoblox-gm-mgmt.corp.example.com', role: 'GM', qps: 0, lps: 0, objectCount: 0, activeIPCount: 0, model: 'IB-4030', platform: 'Physical', managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: { enterprise: true, nios: true } },
  // GMC without DNS/DHCP (management only) — replaced by UDDI Portal, not selectable
  { memberId: 'gmc-02', memberName: 'infoblox-gmc-standby.corp.example.com', role: 'GMC', qps: 0, lps: 0, objectCount: 0, activeIPCount: 0, model: 'IB-4030', platform: 'Physical', managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: { enterprise: true, nios: true } },
  // DNS (8 across 4 sites)
  { memberId: 'dns-01', memberName: 'dns-east-01.corp.example.com', role: 'DNS', qps: 24500, lps: 0, objectCount: 10122, activeIPCount: 0, model: 'IB-V2215', platform: 'VMware', managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: { dns: true } },
  { memberId: 'dns-02', memberName: 'dns-east-02.corp.example.com', role: 'DNS', qps: 19800, lps: 0, objectCount: 8540, activeIPCount: 0, model: 'IB-V2215', platform: 'VMware', managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: { dns: true } },
  { memberId: 'dns-03', memberName: 'dns-west-01.corp.example.com', role: 'DNS', qps: 18100, lps: 0, objectCount: 7378, activeIPCount: 0, model: 'IB-V2215', platform: 'VMware', managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: { dns: true } },
  { memberId: 'dns-04', memberName: 'dns-west-02.corp.example.com', role: 'DNS', qps: 15600, lps: 0, objectCount: 6210, activeIPCount: 0, model: 'IB-V2215', platform: 'VMware', managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: { dns: true } },
  { memberId: 'dns-05', memberName: 'dns-central-01.corp.example.com', role: 'DNS', qps: 31200, lps: 0, objectCount: 14300, activeIPCount: 0, model: 'IB-V4015', platform: 'AWS', managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: { dns: true, rpz: true } },
  { memberId: 'dns-06', memberName: 'dns-central-02.corp.example.com', role: 'DNS', qps: 22400, lps: 0, objectCount: 9870, activeIPCount: 0, model: 'IB-V2215', platform: 'VMware', managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: { dns: true } },
  { memberId: 'dns-07', memberName: 'dns-eu-01.corp.example.com', role: 'DNS', qps: 42100, lps: 0, objectCount: 18750, activeIPCount: 0, model: 'IB-V2215', platform: 'VMware', managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: { dns: true, rpz: true } },
  { memberId: 'dns-08', memberName: 'dns-eu-02.corp.example.com', role: 'DNS', qps: 28700, lps: 0, objectCount: 11430, activeIPCount: 0, model: 'IB-V2215', platform: 'Azure', managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: { dns: true } },
  // DHCP (6 across 3 sites)
  { memberId: 'dhcp-01', memberName: 'dhcp-east-01.corp.example.com', role: 'DHCP', qps: 0, lps: 185, objectCount: 1055, activeIPCount: 4200, model: 'IB-V1415', platform: 'VMware', managedIPCount: 5800, staticHosts: 1200, dynamicHosts: 3000, dhcpUtilization: 714, licenses: { dhcp: true } },
  { memberId: 'dhcp-02', memberName: 'dhcp-east-02.corp.example.com', role: 'DHCP', qps: 0, lps: 210, objectCount: 1320, activeIPCount: 5100, model: 'IB-V1415', platform: 'VMware', managedIPCount: 6900, staticHosts: 1500, dynamicHosts: 3600, dhcpUtilization: 739, licenses: { dhcp: true } },
  { memberId: 'dhcp-03', memberName: 'dhcp-west-01.corp.example.com', role: 'DHCP', qps: 0, lps: 145, objectCount: 810, activeIPCount: 3200, model: 'IB-V1415', platform: 'VMware', managedIPCount: 4100, staticHosts: 800, dynamicHosts: 2400, dhcpUtilization: 750, licenses: { dhcp: true } },
  { memberId: 'dhcp-04', memberName: 'dhcp-west-02.corp.example.com', role: 'DHCP', qps: 0, lps: 120, objectCount: 680, activeIPCount: 2400, model: 'IB-V1415', platform: 'VMware', managedIPCount: 3200, staticHosts: 600, dynamicHosts: 1800, dhcpUtilization: 750, licenses: { dhcp: true } },
  { memberId: 'dhcp-05', memberName: 'dhcp-central-01.corp.example.com', role: 'DHCP', qps: 0, lps: 275, objectCount: 1890, activeIPCount: 7500, model: 'IB-V1415', platform: 'VMware', managedIPCount: 9800, staticHosts: 2100, dynamicHosts: 5400, dhcpUtilization: 720, licenses: { dhcp: true } },
  { memberId: 'dhcp-06', memberName: 'dhcp-central-02.corp.example.com', role: 'DHCP', qps: 0, lps: 160, objectCount: 940, activeIPCount: 3800, model: 'IB-V1415', platform: 'VMware', managedIPCount: 5100, staticHosts: 1000, dynamicHosts: 2800, dhcpUtilization: 737, licenses: { dhcp: true } },
  // DNS/DHCP combo (6 across 6 sites)
  { memberId: 'combo-01', memberName: 'combo-east-01.corp.example.com', role: 'DNS/DHCP', qps: 12300, lps: 95, objectCount: 5420, activeIPCount: 2100, model: 'IB-V815', platform: 'VMware', managedIPCount: 2900, staticHosts: 500, dynamicHosts: 1600, dhcpUtilization: 762, licenses: { dns: true, dhcp: true } },
  { memberId: 'combo-02', memberName: 'combo-west-01.corp.example.com', role: 'DNS/DHCP', qps: 9800, lps: 110, objectCount: 4780, activeIPCount: 2800, model: 'IB-V815', platform: 'VMware', managedIPCount: 3600, staticHosts: 700, dynamicHosts: 2100, dhcpUtilization: 750, licenses: { dns: true, dhcp: true } },
  { memberId: 'combo-03', memberName: 'combo-central-01.corp.example.com', role: 'DNS/DHCP', qps: 14500, lps: 130, objectCount: 6890, activeIPCount: 3500, model: 'IB-V815', platform: 'VMware', managedIPCount: 4500, staticHosts: 900, dynamicHosts: 2600, dhcpUtilization: 743, licenses: { dns: true, dhcp: true } },
  { memberId: 'combo-04', memberName: 'combo-eu-01.corp.example.com', role: 'DNS/DHCP', qps: 11200, lps: 85, objectCount: 5100, activeIPCount: 1900, model: 'IB-V815', platform: 'VMware', managedIPCount: 2500, staticHosts: 400, dynamicHosts: 1500, dhcpUtilization: 789, licenses: { dns: true, dhcp: true } },
  { memberId: 'combo-05', memberName: 'combo-apac-01.corp.example.com', role: 'DNS/DHCP', qps: 7600, lps: 70, objectCount: 3420, activeIPCount: 1500, model: 'IB-V815', platform: 'VMware', managedIPCount: 2000, staticHosts: 350, dynamicHosts: 1150, dhcpUtilization: 767, licenses: { dns: true, dhcp: true } },
  // IPAM (3 — phase 27 trimmed to stay under 35-member cap)
  { memberId: 'ipam-01', memberName: 'ipam-01.corp.example.com', role: 'IPAM', qps: 0, lps: 0, objectCount: 122, activeIPCount: 0, model: 'IB-V815', platform: 'VMware', managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0 },
  { memberId: 'ipam-02', memberName: 'ipam-02.corp.example.com', role: 'IPAM', qps: 0, lps: 0, objectCount: 340, activeIPCount: 0, model: 'IB-V815', platform: 'VMware', managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0 },
  { memberId: 'ipam-03', memberName: 'ipam-03.corp.example.com', role: 'IPAM', qps: 0, lps: 0, objectCount: 215, activeIPCount: 0, model: 'IB-V815', platform: 'VMware', managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0 },
  // Reporting (2 — phase 27 trimmed to stay under 35-member cap)
  { memberId: 'rpt-01', memberName: 'reporting-east-01.corp.example.com', role: 'Reporting', qps: 0, lps: 0, objectCount: 450, activeIPCount: 0, model: 'IB-V815', platform: 'VMware', managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0 },
  { memberId: 'rpt-02', memberName: 'reporting-west-01.corp.example.com', role: 'Reporting', qps: 0, lps: 0, objectCount: 380, activeIPCount: 0, model: 'IB-V815', platform: 'VMware', managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0 },
  // Phase 27 RES-12: variant coverage members
  // X6 VMware (2 variants Small/Large) — DNS workload
  { memberId: 'dns-x6vmw-01', memberName: 'dns-x6-vmware-01.corp.example.com', role: 'DNS', qps: 18500, lps: 0, objectCount: 12400, activeIPCount: 0, model: 'IB-V1526', platform: 'VMware', managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: { dns: true } },
  // X6 VMware (2 variants) — larger box
  { memberId: 'dns-x6vmw-02', memberName: 'dns-x6-vmware-02.corp.example.com', role: 'DNS', qps: 34200, lps: 0, objectCount: 19800, activeIPCount: 0, model: 'IB-V2326', platform: 'VMware', managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: { dns: true, rpz: true } },
  // X6 Azure (single variant, v3/v5 sizing via instanceType label) — DNS
  { memberId: 'dns-x6az-01', memberName: 'dns-x6-azure-01.corp.example.com', role: 'DNS', qps: 48000, lps: 0, objectCount: 22100, activeIPCount: 0, model: 'IB-V4126', platform: 'Azure', managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: { dns: true, rpz: true } },
  // X5 AWS (3 variants r6i/m5/r4) — DNS/DHCP combo
  { memberId: 'combo-x5aws-01', memberName: 'combo-x5-aws-01.corp.example.com', role: 'DNS/DHCP', qps: 16400, lps: 165, objectCount: 7200, activeIPCount: 3100, model: 'IB-V2225', platform: 'AWS', managedIPCount: 4100, staticHosts: 800, dynamicHosts: 2300, dhcpUtilization: 756, licenses: { dns: true, dhcp: true } },
  // X6 GCP (3 variants Small/Medium/Large) — DNS
  { memberId: 'dns-x6gcp-01', memberName: 'dns-x6-gcp-01.corp.example.com', role: 'DNS', qps: 9800, lps: 0, objectCount: 4500, activeIPCount: 0, model: 'IB-V926', platform: 'GCP', managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: { dns: true } },
  // Additional physical chassis (keeps 2 physical units total alongside gm-01/gmc-01) — DNS/DHCP
  { memberId: 'combo-phys-01', memberName: 'combo-phys-dc2-01.corp.example.com', role: 'DNS/DHCP', qps: 13200, lps: 140, objectCount: 6800, activeIPCount: 2900, model: 'IB-4030', platform: 'Physical', managedIPCount: 3800, staticHosts: 720, dynamicHosts: 2180, dhcpUtilization: 763, licenses: { dns: true, dhcp: true } },
];
