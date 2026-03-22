/**
 * nios-calc.ts — Pure computation functions and types for NIOS Phase 11 panels.
 *
 * No React imports. No side effects. All functions are deterministic and stateless.
 * Used by wizard.tsx for Migration Planner, Server Token Calculator, and XaaS Consolidation.
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

export type ServerFormFactor = 'nios-x' | 'nios-xaas';

export interface ServerTokenTier {
  name: string;
  maxQps: number;
  maxLps: number;
  maxObjects: number;
  serverTokens: number;
  cpu: string;
  ram: string;
  storage: string;
  /** Discovered asset capacity per tier. NIOS-X only; XaaS tiers use 0. Source: NOTES tab rows 21-30. */
  discAssets: number;
  maxConnections?: number; // XaaS tiers only
}

export interface NiosServerMetrics {
  memberId: string;
  memberName: string;
  role: 'GM' | 'GMC' | 'DNS' | 'DHCP' | 'DNS/DHCP' | 'IPAM' | 'Reporting' | string;
  qps: number;
  lps: number;
  objectCount: number;
  activeIPCount: number;
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

// ─── Tier Tables ───────────────────────────────────────────────────────────────
// Values verified against performance-specs.csv (NIOS-X) and performance-metrics.csv (XaaS).
// DO NOT alter these numbers.

export const SERVER_TOKEN_TIERS: ServerTokenTier[] = [
  { name: '2XS', maxQps: 5_000,   maxLps: 75,  maxObjects: 3_000,   serverTokens: 130,   cpu: '3 Core',  ram: '4 GB',   storage: '64 GB',  discAssets: 550 },
  { name: 'XS',  maxQps: 10_000,  maxLps: 150, maxObjects: 7_500,   serverTokens: 250,   cpu: '3 Core',  ram: '4 GB',   storage: '64 GB',  discAssets: 1_300 },
  { name: 'S',   maxQps: 20_000,  maxLps: 200, maxObjects: 29_000,  serverTokens: 470,   cpu: '4 Core',  ram: '4 GB',   storage: '128 GB', discAssets: 5_000 },
  { name: 'M',   maxQps: 40_000,  maxLps: 300, maxObjects: 110_000, serverTokens: 880,   cpu: '4 Core',  ram: '32 GB',  storage: '1 TB',   discAssets: 19_000 },
  { name: 'L',   maxQps: 70_000,  maxLps: 400, maxObjects: 440_000, serverTokens: 1_900, cpu: '16 Core', ram: '32 GB',  storage: '1 TB',   discAssets: 75_000 },
  { name: 'XL',  maxQps: 115_000, maxLps: 675, maxObjects: 880_000, serverTokens: 2_700, cpu: '24 Core', ram: '32 GB',  storage: '1 TB',   discAssets: 145_000 },
];

export const XAAS_TOKEN_TIERS: ServerTokenTier[] = [
  { name: 'S',  maxQps: 20_000,  maxLps: 200, maxObjects: 29_000,  serverTokens: 2_400, cpu: '-', ram: '-', storage: '-', discAssets: 0, maxConnections: 10 },
  { name: 'M',  maxQps: 40_000,  maxLps: 300, maxObjects: 110_000, serverTokens: 4_100, cpu: '-', ram: '-', storage: '-', discAssets: 0, maxConnections: 20 },
  { name: 'L',  maxQps: 70_000,  maxLps: 400, maxObjects: 440_000, serverTokens: 6_100, cpu: '-', ram: '-', storage: '-', discAssets: 0, maxConnections: 35 },
  { name: 'XL', maxQps: 115_000, maxLps: 675, maxObjects: 880_000, serverTokens: 8_500, cpu: '-', ram: '-', storage: '-', discAssets: 0, maxConnections: 85 },
];

export const XAAS_EXTRA_CONNECTION_COST = 100; // tokens per extra connection
export const XAAS_MAX_EXTRA_CONNECTIONS = 400; // max extra connections per instance (cap)

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
  // GM
  { memberId: 'gm-01', memberName: 'infoblox-gm.corp.example.com', role: 'GM', qps: 8420, lps: 145, objectCount: 21897, activeIPCount: 0 },
  // GMC
  { memberId: 'gmc-01', memberName: 'infoblox-gmc.corp.example.com', role: 'GMC', qps: 3200, lps: 80, objectCount: 15400, activeIPCount: 0 },
  // DNS (8 across 4 sites)
  { memberId: 'dns-01', memberName: 'dns-east-01.corp.example.com', role: 'DNS', qps: 24500, lps: 0, objectCount: 10122, activeIPCount: 0 },
  { memberId: 'dns-02', memberName: 'dns-east-02.corp.example.com', role: 'DNS', qps: 19800, lps: 0, objectCount: 8540, activeIPCount: 0 },
  { memberId: 'dns-03', memberName: 'dns-west-01.corp.example.com', role: 'DNS', qps: 18100, lps: 0, objectCount: 7378, activeIPCount: 0 },
  { memberId: 'dns-04', memberName: 'dns-west-02.corp.example.com', role: 'DNS', qps: 15600, lps: 0, objectCount: 6210, activeIPCount: 0 },
  { memberId: 'dns-05', memberName: 'dns-central-01.corp.example.com', role: 'DNS', qps: 31200, lps: 0, objectCount: 14300, activeIPCount: 0 },
  { memberId: 'dns-06', memberName: 'dns-central-02.corp.example.com', role: 'DNS', qps: 22400, lps: 0, objectCount: 9870, activeIPCount: 0 },
  { memberId: 'dns-07', memberName: 'dns-eu-01.corp.example.com', role: 'DNS', qps: 42100, lps: 0, objectCount: 18750, activeIPCount: 0 },
  { memberId: 'dns-08', memberName: 'dns-eu-02.corp.example.com', role: 'DNS', qps: 28700, lps: 0, objectCount: 11430, activeIPCount: 0 },
  // DHCP (6 across 3 sites)
  { memberId: 'dhcp-01', memberName: 'dhcp-east-01.corp.example.com', role: 'DHCP', qps: 0, lps: 185, objectCount: 1055, activeIPCount: 4200 },
  { memberId: 'dhcp-02', memberName: 'dhcp-east-02.corp.example.com', role: 'DHCP', qps: 0, lps: 210, objectCount: 1320, activeIPCount: 5100 },
  { memberId: 'dhcp-03', memberName: 'dhcp-west-01.corp.example.com', role: 'DHCP', qps: 0, lps: 145, objectCount: 810, activeIPCount: 3200 },
  { memberId: 'dhcp-04', memberName: 'dhcp-west-02.corp.example.com', role: 'DHCP', qps: 0, lps: 120, objectCount: 680, activeIPCount: 2400 },
  { memberId: 'dhcp-05', memberName: 'dhcp-central-01.corp.example.com', role: 'DHCP', qps: 0, lps: 275, objectCount: 1890, activeIPCount: 7500 },
  { memberId: 'dhcp-06', memberName: 'dhcp-central-02.corp.example.com', role: 'DHCP', qps: 0, lps: 160, objectCount: 940, activeIPCount: 3800 },
  // DNS/DHCP combo (6 across 6 sites)
  { memberId: 'combo-01', memberName: 'combo-east-01.corp.example.com', role: 'DNS/DHCP', qps: 12300, lps: 95, objectCount: 5420, activeIPCount: 2100 },
  { memberId: 'combo-02', memberName: 'combo-west-01.corp.example.com', role: 'DNS/DHCP', qps: 9800, lps: 110, objectCount: 4780, activeIPCount: 2800 },
  { memberId: 'combo-03', memberName: 'combo-central-01.corp.example.com', role: 'DNS/DHCP', qps: 14500, lps: 130, objectCount: 6890, activeIPCount: 3500 },
  { memberId: 'combo-04', memberName: 'combo-eu-01.corp.example.com', role: 'DNS/DHCP', qps: 11200, lps: 85, objectCount: 5100, activeIPCount: 1900 },
  { memberId: 'combo-05', memberName: 'combo-apac-01.corp.example.com', role: 'DNS/DHCP', qps: 7600, lps: 70, objectCount: 3420, activeIPCount: 1500 },
  { memberId: 'combo-06', memberName: 'combo-latam-01.corp.example.com', role: 'DNS/DHCP', qps: 5400, lps: 55, objectCount: 2150, activeIPCount: 1100 },
  // IPAM (4)
  { memberId: 'ipam-01', memberName: 'ipam-01.corp.example.com', role: 'IPAM', qps: 0, lps: 0, objectCount: 122, activeIPCount: 0 },
  { memberId: 'ipam-02', memberName: 'ipam-02.corp.example.com', role: 'IPAM', qps: 0, lps: 0, objectCount: 340, activeIPCount: 0 },
  { memberId: 'ipam-03', memberName: 'ipam-03.corp.example.com', role: 'IPAM', qps: 0, lps: 0, objectCount: 215, activeIPCount: 0 },
  { memberId: 'ipam-04', memberName: 'ipam-04.corp.example.com', role: 'IPAM', qps: 0, lps: 0, objectCount: 88, activeIPCount: 0 },
  // Reporting (4 across 4 sites)
  { memberId: 'rpt-01', memberName: 'reporting-east-01.corp.example.com', role: 'Reporting', qps: 0, lps: 0, objectCount: 450, activeIPCount: 0 },
  { memberId: 'rpt-02', memberName: 'reporting-west-01.corp.example.com', role: 'Reporting', qps: 0, lps: 0, objectCount: 380, activeIPCount: 0 },
  { memberId: 'rpt-03', memberName: 'reporting-central-01.corp.example.com', role: 'Reporting', qps: 0, lps: 0, objectCount: 520, activeIPCount: 0 },
  { memberId: 'rpt-04', memberName: 'reporting-eu-01.corp.example.com', role: 'Reporting', qps: 0, lps: 0, objectCount: 290, activeIPCount: 0 },
];
