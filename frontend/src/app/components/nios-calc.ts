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
  maxConnections?: number; // XaaS tiers only
}

export interface NiosServerMetrics {
  memberId: string;
  memberName: string;
  role: 'GM' | 'GMC' | 'DNS' | 'DHCP' | 'DNS/DHCP' | 'IPAM' | 'Reporting' | string;
  qps: number;
  lps: number;
  objectCount: number;
}

export interface ConsolidatedXaasInstance {
  tier: ServerTokenTier;          // the XaaS tier used for this instance
  members: NiosServerMetrics[];
  connectionsUsed: number;
  extraConnections: number;       // connections beyond tier.maxConnections
  extraTokens: number;            // extraConnections * XAAS_EXTRA_CONNECTION_COST
  totalServerTokens: number;      // tier.serverTokens + extraTokens
}

// ─── Tier Tables ───────────────────────────────────────────────────────────────
// Values verified against performance-specs.csv (NIOS-X) and performance-metrics.csv (XaaS).
// DO NOT alter these numbers.

export const SERVER_TOKEN_TIERS: ServerTokenTier[] = [
  { name: '2XS', maxQps: 5_000,   maxLps: 75,  maxObjects: 3_000,   serverTokens: 130,   cpu: '3 Core',  ram: '4 GB',   storage: '64 GB' },
  { name: 'XS',  maxQps: 10_000,  maxLps: 150, maxObjects: 7_500,   serverTokens: 250,   cpu: '3 Core',  ram: '4 GB',   storage: '64 GB' },
  { name: 'S',   maxQps: 20_000,  maxLps: 200, maxObjects: 29_000,  serverTokens: 470,   cpu: '4 Core',  ram: '4 GB',   storage: '128 GB' },
  { name: 'M',   maxQps: 40_000,  maxLps: 300, maxObjects: 110_000, serverTokens: 880,   cpu: '4 Core',  ram: '32 GB',  storage: '1 TB' },
  { name: 'L',   maxQps: 70_000,  maxLps: 400, maxObjects: 440_000, serverTokens: 1_900, cpu: '16 Core', ram: '32 GB',  storage: '1 TB' },
  { name: 'XL',  maxQps: 115_000, maxLps: 675, maxObjects: 880_000, serverTokens: 2_700, cpu: '24 Core', ram: '32 GB',  storage: '1 TB' },
];

export const XAAS_TOKEN_TIERS: ServerTokenTier[] = [
  { name: 'S',  maxQps: 20_000,  maxLps: 200, maxObjects: 29_000,  serverTokens: 2_400, cpu: '-', ram: '-', storage: '-', maxConnections: 10 },
  { name: 'M',  maxQps: 40_000,  maxLps: 300, maxObjects: 110_000, serverTokens: 4_100, cpu: '-', ram: '-', storage: '-', maxConnections: 20 },
  { name: 'L',  maxQps: 70_000,  maxLps: 400, maxObjects: 440_000, serverTokens: 6_100, cpu: '-', ram: '-', storage: '-', maxConnections: 35 },
  { name: 'XL', maxQps: 115_000, maxLps: 675, maxObjects: 880_000, serverTokens: 8_500, cpu: '-', ram: '-', storage: '-', maxConnections: 85 },
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
 * Bin-packing algorithm to consolidate NiosServerMetrics members into XaaS instances.
 *
 * Algorithm (source: Figma mock-data.ts lines 630–701):
 * 1. Sort members by QPS descending.
 * 2. Accumulate members into a running "current instance".
 * 3. After adding each member, compute aggregate metrics using MAX across members
 *    (server sizing is dominated by peak, not sum — one heavy member can force a larger tier).
 * 4. If adding the next member would push aggregate beyond XL maxQps/maxLps/maxObjects
 *    OR connectionsUsed would exceed XL.maxConnections + XAAS_MAX_EXTRA_CONNECTIONS,
 *    flush the current group as a completed instance and start fresh.
 * 5. For each completed instance: find smallest XaaS tier fitting the aggregate,
 *    compute extraConnections = max(0, connectionsUsed - tier.maxConnections),
 *    extraTokens = extraConnections * XAAS_EXTRA_CONNECTION_COST.
 */
export function consolidateXaasInstances(members: NiosServerMetrics[]): ConsolidatedXaasInstance[] {
  if (members.length === 0) return [];

  const xlTier = XAAS_TOKEN_TIERS[XAAS_TOKEN_TIERS.length - 1];
  const maxConnCap = (xlTier.maxConnections ?? 85) + XAAS_MAX_EXTRA_CONNECTIONS;

  // Sort by QPS descending so high-load members are grouped first
  const sorted = [...members].sort((a, b) => b.qps - a.qps);

  const instances: ConsolidatedXaasInstance[] = [];
  let currentGroup: NiosServerMetrics[] = [];
  let aggQps = 0;
  let aggLps = 0;
  let aggObjects = 0;

  const flushGroup = () => {
    if (currentGroup.length === 0) return;
    const tier = calcServerTokenTier(aggQps, aggLps, aggObjects, 'nios-xaas');
    const connectionsUsed = currentGroup.length;
    const extraConnections = Math.max(0, connectionsUsed - (tier.maxConnections ?? 0));
    const extraTokens = extraConnections * XAAS_EXTRA_CONNECTION_COST;
    instances.push({
      tier,
      members: [...currentGroup],
      connectionsUsed,
      extraConnections,
      extraTokens,
      totalServerTokens: tier.serverTokens + extraTokens,
    });
    currentGroup = [];
    aggQps = 0;
    aggLps = 0;
    aggObjects = 0;
  };

  for (const member of sorted) {
    // Compute what the aggregate would become if we add this member
    const nextQps = Math.max(aggQps, member.qps);
    const nextLps = Math.max(aggLps, member.lps);
    const nextObjects = Math.max(aggObjects, member.objectCount);
    const nextConnections = currentGroup.length + 1;

    // Check whether this addition exceeds XL capacity or connection cap
    const exceedsMetrics =
      nextQps > xlTier.maxQps ||
      nextLps > xlTier.maxLps ||
      nextObjects > xlTier.maxObjects;
    const exceedsConnections = nextConnections > maxConnCap;

    if (currentGroup.length > 0 && (exceedsMetrics || exceedsConnections)) {
      // Flush current group before adding this member
      flushGroup();
    }

    // Add member to current group
    currentGroup.push(member);
    aggQps = Math.max(aggQps, member.qps);
    aggLps = Math.max(aggLps, member.lps);
    aggObjects = Math.max(aggObjects, member.objectCount);
  }

  // Flush remaining group
  flushGroup();

  return instances;
}

// ─── Mock Data (demo mode only) ────────────────────────────────────────────────
// Used when backend.isDemo === true. Live mode uses scanResults.niosServerMetrics.
// Ported from Figma mock-data.ts lines 735–800.

export const MOCK_NIOS_SERVER_METRICS: NiosServerMetrics[] = [
  {
    memberId: 'gm-01',
    memberName: 'infoblox-gm.corp.example.com',
    role: 'GM',
    qps: 35000,
    lps: 280,
    objectCount: 95000,
  },
  {
    memberId: 'gmc-01',
    memberName: 'infoblox-gmc1.corp.example.com',
    role: 'GMC',
    qps: 12000,
    lps: 120,
    objectCount: 8000,
  },
  {
    memberId: 'dns-01',
    memberName: 'infoblox-dns1.corp.example.com',
    role: 'DNS',
    qps: 48000,
    lps: 0,
    objectCount: 52000,
  },
  {
    memberId: 'dns-02',
    memberName: 'infoblox-dns2.corp.example.com',
    role: 'DNS',
    qps: 22000,
    lps: 0,
    objectCount: 31000,
  },
  {
    memberId: 'dhcp-01',
    memberName: 'infoblox-dhcp1.corp.example.com',
    role: 'DHCP',
    qps: 0,
    lps: 310,
    objectCount: 74000,
  },
  {
    memberId: 'dns-dhcp-01',
    memberName: 'infoblox-dnsd1.corp.example.com',
    role: 'DNS/DHCP',
    qps: 18000,
    lps: 195,
    objectCount: 27000,
  },
  {
    memberId: 'ipam-01',
    memberName: 'infoblox-ipam1.corp.example.com',
    role: 'IPAM',
    qps: 0,
    lps: 0,
    objectCount: 110000,
  },
  {
    memberId: 'rpt-01',
    memberName: 'infoblox-rpt1.corp.example.com',
    role: 'Reporting',
    qps: 0,
    lps: 0,
    objectCount: 0,
  },
];
