// results-types.ts — shared prop contract for <ResultsSurface/>.
// Established in Phase 33 (D-03 / D-04). Sub-component files in this directory
// (results-hero.tsx, results-bom.tsx, …) consume types from this module so
// every result-* file imports a single contract.

import type { FindingRow, NiosServerMetrics, ServerFormFactor } from '../mock-data';
import type { ADServerMetricAPI } from '../api-client';
import type { FleetSavings, MemberSavings, AppliancePlatform } from '../resource-savings';

// ── Re-exports (single import surface for siblings) ───────────────────────────
export type { FindingRow } from '../mock-data';
export type { NiosServerMetrics } from '../mock-data';
export type { ServerFormFactor } from '../mock-data';
export type { FleetSavings } from '../resource-savings';
export type { MemberSavings } from '../resource-savings';
export type { AppliancePlatform } from '../resource-savings';
// Surface contract refers to AD member metrics as `ADServerMetrics`. The
// canonical wire type lives in api-client.ts as `ADServerMetricAPI`; alias
// here so result-* files don't reach into api-client directly.
export type ADServerMetrics = ADServerMetricAPI;

// ── ResultsMode ───────────────────────────────────────────────────────────────
export type ResultsMode = 'scan' | 'sizer';

// ── Override-state plumbing ───────────────────────────────────────────────────
/** Per-server overrides for QPS/LPS/object-count/CPU/Mem/Storage tier-sizing. */
export type ServerMetricOverride = Partial<{
  cpuCores: number;
  memGB: number;
  storageGB: number;
  dnsQps: number;
  dhcpLps: number;
  // Legacy keys still consumed by applyServerOverrides(): qps/lps/objects.
  qps: number;
  lps: number;
  objects: number;
}>;

/**
 * Bundled override-state setters that the surface plumbs into editing
 * widgets (Findings table cell editors, Migration Planner per-member tier
 * pickers, etc.). Wizard / Sizer caller owns the React state — surface is
 * still pure presentation.
 */
export interface ResultsOverrides {
  countOverrides: Record<string, number>;
  setCountOverrides: (next: Record<string, number>) => void;

  serverMetricOverrides: Record<string, ServerMetricOverride>;
  setServerMetricOverrides: (
    next: Record<string, ServerMetricOverride>,
  ) => void;

  variantOverrides: Map<string, number>;
  setVariantOverrides: (next: Map<string, number>) => void;

  adMigrationMap: Map<string, ServerFormFactor>;
  setAdMigrationMap: (next: Map<string, ServerFormFactor>) => void;
}

// ── ResultsSurface prop contract ──────────────────────────────────────────────
/**
 * Public prop contract for `<ResultsSurface/>` — Phase 33 D-03 (pure
 * presentation) and D-04 (props-only data flow).
 *
 * All NIOS-only / AD-only fields are optional (D-06 / D-07 / D-09): the surface
 * conditionally renders sections based on presence. Pure-Sizer flows that
 * don't have NIOS data simply omit those props.
 *
 * Sizer-mode-only fields (`reportingTokens`, `securityTokens`) fold into the
 * BOM section as additional rows (D-11). They never re-introduce hero tiles.
 *
 * Token math is aggregate-then-divide (D-12). Sub-components MUST NOT perform
 * per-row ceildiv; pre-aggregated totals come in as props.
 */
export interface ResultsSurfaceProps {
  // Mode + base data
  mode: ResultsMode;
  findings: FindingRow[];
  /** Findings after `countOverrides` have been applied upstream. */
  effectiveFindings: FindingRow[];
  growthBufferPct: number;
  serverGrowthBufferPct: number;
  selectedProviders: string[];

  // ── Hero math (already aggregated upstream — D-12) ──────────────────────────
  totalManagementTokens: number;
  totalServerTokens: number;
  /** Sizer mode only — folds into BOM as IB-TOKENS-REPORTING-40 row. */
  reportingTokens: number;
  /** Sizer mode only — folds into BOM as security row. */
  securityTokens: number;
  hasServerMetrics: boolean;

  /** Hybrid scenario sub-display under each hero total (when selectionCount > 0). */
  hybridScenario?: {
    selectionCount: number;
    mgmt: number;
    srv: number;
    stayingMgmt: number;
    stayingSrv: number;
  } | null;

  /** Pre-computed source-level breakdown (drives "Show breakdown by source"). */
  breakdownBySource: Array<{ source: string; mgmt: number; srv: number }>;

  // ── NIOS-only optional ──────────────────────────────────────────────────────
  niosServerMetrics?: NiosServerMetrics[];
  effectiveNiosMetrics?: NiosServerMetrics[];
  niosMigrationMap?: Map<string, ServerFormFactor>;
  setNiosMigrationMap?: (next: Map<string, ServerFormFactor>) => void;
  fleetSavings?: FleetSavings;
  memberSavings?: MemberSavings[];

  // ── AD-only optional ────────────────────────────────────────────────────────
  effectiveADMetrics?: ADServerMetrics[];

  // ── Override plumbing ───────────────────────────────────────────────────────
  overrides: ResultsOverrides;

  // ── Outline + Export bar ────────────────────────────────────────────────────
  outlineSections: Array<{ id: string; label: string }>;
  onExport: () => void | Promise<void>;
  exportLabel?: string; // default "Download XLSX"
  onReset?: () => void;
  resetCopy?: {
    title: string;
    description: string;
    cancel: string;
    confirm: string;
  };

  /**
   * Hero collapsed-state. DECISION: surfaced as a prop pair (rather than lifted
   * into ResultsHero) so the Wizard's "expand-all on first arrival to Step 5"
   * effect can drive it from the outside without prop drilling a ref. Sizer
   * mode can pass `useState(true)` and ignore — same shape, no special-casing.
   */
  heroCollapsed: boolean;
  setHeroCollapsed: (v: boolean) => void;
}
