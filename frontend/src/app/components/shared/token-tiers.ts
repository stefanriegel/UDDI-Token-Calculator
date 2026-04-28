/**
 * shared/token-tiers.ts — Single source of truth for server/XaaS token tier tables.
 *
 * Relocated from nios-calc.ts per Phase 29 decision D-10 so that both nios-calc.ts
 * (NIOS migration planner) and sizer-calc.ts (Sizer core) can consume the same
 * tables without Sizer having to import from NIOS. Values unchanged — this module
 * is pure data + types.
 *
 * Downstream consumers currently import these symbols via nios-calc.ts re-exports,
 * so no call-site changes are required.
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

/**
 * Pick the smallest tier whose capacity envelope covers the given load.
 * Returns the largest tier if the load exceeds every option.
 *
 * Used by the Sizer Step 3 NIOS-X auto-tier feature: when a NIOS-X system is
 * assigned to a Site, its tier is derived from the Site's QPS/LPS/Object load
 * unless the user has manually overridden it.
 */
export function pickServerTier(
  qps: number,
  lps: number,
  objects: number,
  table: ServerTokenTier[] = SERVER_TOKEN_TIERS,
): ServerTokenTier {
  return (
    table.find(
      (t) => t.maxQps >= qps && t.maxLps >= lps && t.maxObjects >= objects,
    ) ?? table[table.length - 1]
  );
}
