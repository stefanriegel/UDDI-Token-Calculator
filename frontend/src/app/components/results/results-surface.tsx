// ResultsSurface — composed Step 5 surface. Phase 33 D-01/D-05/D-17.
// Pure presentation: caller computes all data; surface routes props to sub-components and OutlineNav.
//
// Plan 33-04 Option B: this file is a layout-and-composition component that
//   1. Contains the full Step 5 JSX subtree (lifted verbatim from wizard.tsx
//      so the deferred NIOS chrome — Server Token Calculator inline table,
//      Scenario comparison cards, Grid Features collapsible, Migration Flags
//      collapsible, rich Member Details cards, AD Server Token Calculator —
//      all live here adjacent to the section shells).
//   2. Receives every closure variable previously held by wizard.tsx via the
//      `ResultsSurfaceWizardBag` prop bag. The wizard owns the React state;
//      surface stays a pure renderer.
//   3. Owns all `id="section-*"` anchors (overview / bom / migration-planner /
//      server-tokens / member-details / ad-migration / ad-server-tokens /
//      findings / export) plus the OutlineNav mount.
//
// Sub-component shells extracted in Plans 01–03 (results-hero.tsx, results-bom.tsx,
// etc.) remain available for sizer-mode composition (see Plan 05); scan-mode uses
// the full lifted JSX here for visual + functional parity with the live app.

import { useMemo, useState, useCallback, Fragment, type Dispatch, type SetStateAction } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  FileSpreadsheet,
  Gauge,
  Globe,
  HelpCircle,
  Info,
  Minus,
  Pencil,
  RotateCcw,
  Search,
  Undo2,
  Workflow,
  X,
} from 'lucide-react';

import type {
  ADServerMetrics,
  FindingRow,
  FleetSavings,
  MemberSavings,
  NiosServerMetrics,
  ResultsMode,
  ServerFormFactor,
  ServerMetricOverride,
} from './results-types';
import {
  PROVIDERS,
  TOKEN_RATES,
  calcServerTokenTier,
  calcUddiTokensAggregated,
  calcNiosTokens,
  consolidateXaasInstances,
  XAAS_EXTRA_CONNECTION_COST,
  NIOS_GRID_LOGO,
  PROVIDER_LOGOS,
  type ProviderType,
  type TokenCategory,
  type ConsolidatedXaasInstance,
} from '../mock-data';
import type {
  NiosGridFeaturesAPI,
  NiosGridLicensesAPI,
  NiosMigrationFlagsAPI,
} from '../api-client';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';
import { PlatformBadge } from '../ui/platform-badge';
import { OutlineNav } from '../ui/outline-nav';
import { ResourceSavingsTile } from '../resource-savings-tile';
import { ResultsResourceSavings } from './results-resource-savings';
import { FleetSavingsTotals } from '../fleet-savings-totals';
import { ImportConfirmDialog } from '../sizer/import-confirm-dialog';
import { loadPersisted, initialSizerState } from '../sizer/sizer-state';
import { ResultsHero } from './results-hero';
import { ResultsBom } from './results-bom';
import { ResultsExportBar } from './results-export-bar';
import { ResultsMigrationPlanner } from './results-migration-planner';
import { ResultsMemberDetails } from './results-member-details';
import { ResultsBreakdown } from './results-breakdown';
import type { SizerDerivedResultsProps } from '../sizer/sizer-derive';
import { computeSizerMgmtScenarios } from '../sizer/sizer-derive';
import { MGMT_RATES } from '../sizer/sizer-calc';
import type { Region, Site } from '../sizer/sizer-types';

/** Slim subset of Sizer NIOS-X system carrying just the planner inputs (Issue #6). */
type NiosXSystemSlim = { id: string; name: string; siteId: string };
import type { ResultsOverrides } from './results-types';

// ─── Module-scope helpers (duplicated from wizard.tsx so this file is self-contained) ───

/** Effective object count for server token tier sizing: DDI objects + Active IPs (DHCP). */
function serverSizingObjects(m: NiosServerMetrics): number {
  return m.objectCount + (m.activeIPCount ?? 0);
}

/** Apply server metric overrides (QPS/LPS/Objects) to a member for tier calculation. */
function applyServerOverrides(
  m: NiosServerMetrics,
  overrides: Record<string, { qps?: number; lps?: number; objects?: number }>,
): { qps: number; lps: number; objects: number } {
  const ov = overrides[m.memberId];
  return {
    qps: ov?.qps ?? m.qps,
    lps: ov?.lps ?? m.lps,
    objects: ov?.objects ?? serverSizingObjects(m),
  };
}

/** Apply server metric overrides to an AD DC for tier calculation. */
function applyADServerOverrides(
  m: ADServerMetrics,
  overrides: Record<string, { qps?: number; lps?: number; objects?: number }>,
): { qps: number; lps: number; objects: number } {
  const ov = overrides[m.hostname];
  return {
    qps: ov?.qps ?? m.qps,
    lps: ov?.lps ?? m.lps,
    objects: ov?.objects ?? (m.dnsObjects + m.dhcpObjectsWithOverhead),
  };
}

/**
 * Detect infrastructure-only GM/GMC members that have no DNS/DHCP workload.
 * These members are replaced by the UDDI Portal and don't need NIOS-X licensing.
 */
function isInfraOnlyMember(m: NiosServerMetrics): boolean {
  return (m.role === 'GM' || m.role === 'GMC') &&
    m.qps === 0 && m.lps === 0 && m.objectCount === 0 && (m.activeIPCount ?? 0) === 0;
}

/** Format raw item identifiers for display. Converts `dns_record_a` → `DNS Record (A)`. */
function formatItemLabel(item: string): string {
  if (item.startsWith('dns_record_')) {
    const suffix = item.slice('dns_record_'.length);
    return `DNS Record (${suffix.toUpperCase()})`;
  }
  return item;
}

interface ScenarioCard {
  label: string;
  primaryValue: number;
  subLines?: { text: string; color: string }[];
  desc: string;
}

function ScenarioPlannerCards({
  title,
  unit,
  color,
  scenarios,
  isActive,
}: {
  title: string;
  unit: string;
  color: 'orange' | 'blue';
  scenarios: ScenarioCard[];
  isActive: (idx: number) => boolean;
}) {
  const activeBorder  = color === 'orange' ? 'border-[var(--infoblox-orange)]' : 'border-blue-500';
  const activeBg      = color === 'orange' ? 'bg-orange-50/30'                 : 'bg-blue-50/30';
  const activeDot     = color === 'orange' ? 'bg-[var(--infoblox-orange)]'     : 'bg-blue-500';
  const activeNumber  = color === 'orange' ? 'text-[var(--infoblox-orange)]'   : 'text-blue-700';

  return (
    <div className="px-4 py-4 border-t border-[var(--border)]">
      <h3 className="text-[14px] font-semibold text-[var(--foreground)] mb-3">{title}</h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {scenarios.map((scenario, idx) => {
          const active = isActive(idx);
          return (
            <div
              key={scenario.label}
              className={`rounded-xl border-2 p-4 transition-colors ${
                active ? `${activeBorder} ${activeBg} shadow-sm` : 'border-[var(--border)] bg-white'
              }`}
            >
              <div className="flex items-center gap-2 mb-2">
                {active && <span className={`w-2 h-2 rounded-full ${activeDot}`} />}
                <span className="text-[12px] uppercase tracking-wider text-[var(--muted-foreground)]" style={{ fontWeight: 600 }}>
                  {scenario.label}
                </span>
              </div>
              <div className={`text-[28px] ${activeNumber}`} style={{ fontWeight: 700 }}>
                {scenario.primaryValue.toLocaleString()}
              </div>
              <div className="text-[11px] text-[var(--muted-foreground)] mb-2">{unit}</div>
              {scenario.subLines && scenario.subLines.length > 0 && (
                <div className="text-[11px] space-y-0.5 mb-1">
                  {scenario.subLines.map((line, i) => (
                    <div key={i} style={{ color: line.color }}>{line.text}</div>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-[var(--muted-foreground)] border-t border-[var(--border)] pt-2 mt-2">
                {scenario.desc}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FieldTooltip({ text, side = 'top' }: { text: string; side?: 'top' | 'right' | 'bottom' | 'left' }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          tabIndex={-1}
          className="inline-flex items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors cursor-help focus:outline-none"
          aria-label={text}
        >
          <HelpCircle className="w-3.5 h-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-[260px] text-[12px] leading-relaxed">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

// ─── Sort columns + dirs (Detailed Findings table) ────────────────────────────
type SortColumn = 'provider' | 'source' | 'category' | 'item' | 'count' | 'managementTokens' | 'uddiTokens';
type SortDir = 'asc' | 'desc';

// ─── Wizard prop bag ──────────────────────────────────────────────────────────
// All closure variables previously held by wizard.tsx Step 5 JSX, threaded
// through a single prop so wizard.tsx can mount <ResultsSurface .../> in one
// invocation. Keeps the swap mechanically simple — every value the lifted JSX
// references comes through here.
export interface ResultsSurfaceWizardBag {
  // Mode
  mode: ResultsMode;

  // ── Findings + tokens ───────────────────────────────────────────────────────
  findings: FindingRow[];
  effectiveFindings: FindingRow[];
  filteredSortedFindings: FindingRow[];
  filteredTokenTotal: number;
  rawTotalTokens: number;
  uddiPerRowTotal: number;
  totalTokens: number;
  totalServerTokens: number;
  reportingTokens: number;
  hasServerMetrics: boolean;
  categoryTotals: Record<string, number>;
  hybridScenario: {
    selectionCount: number;
    mgmt: number;
    srv: number;
  } | null;

  // ── Inputs (growth, providers) ─────────────────────────────────────────────
  selectedProviders: ProviderType[];
  growthBufferPct: number;
  setGrowthBufferPct: (v: number) => void;
  serverGrowthBufferPct: number;
  setServerGrowthBufferPct: (v: number) => void;
  importedProviders: Set<ProviderType>;
  liveScannedProviders: Set<ProviderType>;
  isEstimatorOnly: boolean;

  // ── Hero collapsed + expand-all toggles ────────────────────────────────────
  heroCollapsed: boolean;
  setHeroCollapsed: (v: boolean | ((prev: boolean) => boolean)) => void;
  showAllHeroSources: boolean;
  setShowAllHeroSources: (v: boolean | ((prev: boolean) => boolean)) => void;
  showAllCategorySources: Record<string, boolean>;
  setShowAllCategorySources: (
    next: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>),
  ) => void;

  // ── BOM ────────────────────────────────────────────────────────────────────
  bomCopied: boolean;
  setBomCopied: (v: boolean) => void;

  // ── Top consumer cards (DNS/DHCP/IP) ───────────────────────────────────────
  topDnsExpanded: boolean;
  setTopDnsExpanded: (v: boolean | ((prev: boolean) => boolean)) => void;
  topDhcpExpanded: boolean;
  setTopDhcpExpanded: (v: boolean | ((prev: boolean) => boolean)) => void;
  topIpExpanded: boolean;
  setTopIpExpanded: (v: boolean | ((prev: boolean) => boolean)) => void;

  // ── NIOS server data ───────────────────────────────────────────────────────
  niosServerMetrics: NiosServerMetrics[];
  effectiveNiosMetrics: NiosServerMetrics[];
  niosMigrationMap: Map<string, ServerFormFactor>;
  setNiosMigrationMap: Dispatch<SetStateAction<Map<string, ServerFormFactor>>>;
  memberSearchFilter: string;
  setMemberSearchFilter: (v: string) => void;
  showGridMemberDetails: boolean;
  setShowGridMemberDetails: (v: boolean) => void;
  gridMemberDetailSearch: string;
  setGridMemberDetailSearch: (v: string) => void;
  niosGridFeatures: NiosGridFeaturesAPI | null;
  niosGridLicenses: NiosGridLicensesAPI | null;
  niosMigrationFlags: NiosMigrationFlagsAPI | null;
  gridFeaturesOpen: boolean;
  setGridFeaturesOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  migrationFlagsOpen: boolean;
  setMigrationFlagsOpen: (v: boolean | ((prev: boolean) => boolean)) => void;

  // ── Resource savings ───────────────────────────────────────────────────────
  memberSavings: MemberSavings[];
  fleetSavings: FleetSavings;
  variantOverrides: Map<string, number>;
  setVariantOverrides: Dispatch<SetStateAction<Map<string, number>>>;

  // ── AD ─────────────────────────────────────────────────────────────────────
  adServerMetrics: ADServerMetrics[];
  effectiveADMetrics: ADServerMetrics[];
  adMigrationMap: Map<string, ServerFormFactor>;
  setAdMigrationMap: Dispatch<SetStateAction<Map<string, ServerFormFactor>>>;
  adMemberSearchFilter: string;
  setAdMemberSearchFilter: (v: string) => void;

  // ── Override-cell editing ──────────────────────────────────────────────────
  countOverrides: Record<string, number>;
  setCountOverrides: (next: Record<string, number> | ((prev: Record<string, number>) => Record<string, number>)) => void;
  editingFindingKey: string | null;
  setEditingFindingKey: (v: string | null) => void;
  editingCountValue: string;
  setEditingCountValue: (v: string) => void;
  serverMetricOverrides: Record<string, ServerMetricOverride>;
  setServerMetricOverrides: (
    next: Record<string, ServerMetricOverride> | ((prev: Record<string, ServerMetricOverride>) => Record<string, ServerMetricOverride>),
  ) => void;
  editingServerMetric: { memberId: string; field: 'qps' | 'lps' | 'objects' } | null;
  setEditingServerMetric: (v: { memberId: string; field: 'qps' | 'lps' | 'objects' } | null) => void;
  editingServerValue: string;
  setEditingServerValue: (v: string) => void;

  // ── Findings table filters/sort ────────────────────────────────────────────
  findingsCollapsed: boolean;
  setFindingsCollapsed: (v: boolean | ((prev: boolean) => boolean)) => void;
  findingsProviderFilter: Set<ProviderType>;
  setFindingsProviderFilter: (next: Set<ProviderType>) => void;
  findingsCategoryFilter: Set<TokenCategory>;
  setFindingsCategoryFilter: (next: Set<TokenCategory>) => void;
  findingsSort: { col: SortColumn; dir: SortDir } | null;
  setFindingsSort: (v: { col: SortColumn; dir: SortDir } | null) => void;

  // ── Helpers, callbacks ─────────────────────────────────────────────────────
  findingKey: (f: FindingRow) => string;
  exportCSV: () => void;
  downloadXlsxFromBackend: () => void;
  saveSession: () => void;
  restart: () => void;
  setCurrentStep: (step: 'providers' | 'credentials' | 'sources' | 'scanning' | 'results') => void;
  handleSizerImportConfirm: () => void;
  credentials: Record<string, Record<string, string>>;

  // ── Outline ────────────────────────────────────────────────────────────────
  outlineSections: Array<{ id: string; label: string }>;
}

/**
 * Scan-mode props: full wizardBag prop drilling (Plan 04 Option B).
 * Sizer-mode props: thin subset derived via `deriveSizerResultsProps()` plus
 * caller-owned `onExport` / `onReset` (Plan 05 Option b — sub-component
 * composition over the lifted scan JSX).
 */
export type ResultsSurfaceProps =
  | { mode: 'scan'; wizardBag: ResultsSurfaceWizardBag }
  | ({
      mode: 'sizer';
      overrides: ResultsOverrides;
      onExport: () => void | Promise<void>;
      exportLabel?: string;
      onReset?: () => void;
      resetCopy?: {
        title: string;
        description: string;
        cancel: string;
        confirm: string;
      };
      /** Optional Download CSV handler for the Sizer report flow. */
      onDownloadCSV?: () => void | Promise<void>;
      /** Optional Save Session handler for the Sizer report flow. */
      onSaveSession?: () => void | Promise<void>;
      // ─── Phase 34 Plan 06: Wave 4 wiring (REQ-01..REQ-05) ──────────────
      /** Sizer Region tree — drives <ResultsBreakdown /> rows. */
      regions: Region[];
      /** Sizer NIOS-X members projected to scan-shape via deriveMembersFromNiosx (D-01/D-02). */
      niosxMembers: NiosServerMetrics[];
      /** Site-edit dispatch — caller wires UPDATE_SITE through useSizer().dispatch (D-07). */
      onSiteEdit: (siteId: string, patch: Partial<Site>) => void;
      /** Member tier-change dispatch — caller wires UPDATE_NIOSX through useSizer().dispatch. */
      onMemberTierChange: (memberId: string, tier: ServerFormFactor) => void;
      /** Sizer NIOS-X systems with `siteId` — drives migration-planner scenario math (Issue #6). */
      niosxSystems: NiosXSystemSlim[];
      /** Resolved Sizer mgmt overhead — applied inside scenario math (Issue #6). */
      mgmtOverhead: number;
    } & SizerDerivedResultsProps);

// ─── Component ────────────────────────────────────────────────────────────────

export function ResultsSurface(props: ResultsSurfaceProps) {
  // Plan 05 Option b: sizer mode short-circuits into a thin sub-component
  // tree composed of the Plan 01-03 result-* sub-components. Scan mode falls
  // through to the lifted Step 5 JSX below.
  if (props.mode === 'sizer') {
    return <SizerResultsSurface {...props} />;
  }
  return <ScanResultsSurface wizardBag={props.wizardBag} />;
}

function ScanResultsSurface({ wizardBag }: { wizardBag: ResultsSurfaceWizardBag }) {
  // Destructure the bag so the lifted JSX below can reference identifiers by
  // their original wizard.tsx names without further edits.
  const {
    findings,
    effectiveFindings,
    filteredSortedFindings,
    filteredTokenTotal,
    rawTotalTokens,
    uddiPerRowTotal,
    totalTokens,
    totalServerTokens,
    reportingTokens,
    hasServerMetrics,
    categoryTotals,
    hybridScenario,
    selectedProviders,
    growthBufferPct,
    setGrowthBufferPct,
    serverGrowthBufferPct,
    setServerGrowthBufferPct,
    importedProviders,
    liveScannedProviders,
    isEstimatorOnly,
    heroCollapsed,
    setHeroCollapsed,
    showAllHeroSources,
    setShowAllHeroSources,
    showAllCategorySources,
    setShowAllCategorySources,
    bomCopied,
    setBomCopied,
    topDnsExpanded,
    setTopDnsExpanded,
    topDhcpExpanded,
    setTopDhcpExpanded,
    topIpExpanded,
    setTopIpExpanded,
    niosServerMetrics,
    effectiveNiosMetrics,
    niosMigrationMap,
    setNiosMigrationMap,
    memberSearchFilter,
    setMemberSearchFilter,
    showGridMemberDetails,
    setShowGridMemberDetails,
    gridMemberDetailSearch,
    setGridMemberDetailSearch,
    niosGridFeatures,
    niosGridLicenses,
    niosMigrationFlags,
    gridFeaturesOpen,
    setGridFeaturesOpen,
    migrationFlagsOpen,
    setMigrationFlagsOpen,
    memberSavings,
    fleetSavings,
    variantOverrides,
    setVariantOverrides,
    adServerMetrics,
    effectiveADMetrics,
    adMigrationMap,
    setAdMigrationMap,
    adMemberSearchFilter,
    setAdMemberSearchFilter,
    countOverrides,
    setCountOverrides,
    editingFindingKey,
    setEditingFindingKey,
    editingCountValue,
    setEditingCountValue,
    serverMetricOverrides,
    setServerMetricOverrides,
    editingServerMetric,
    setEditingServerMetric,
    editingServerValue,
    setEditingServerValue,
    findingsCollapsed,
    setFindingsCollapsed,
    findingsProviderFilter,
    setFindingsProviderFilter,
    findingsCategoryFilter,
    setFindingsCategoryFilter,
    findingsSort,
    setFindingsSort,
    findingKey,
    exportCSV,
    downloadXlsxFromBackend,
    saveSession,
    restart,
    setCurrentStep,
    handleSizerImportConfirm,
    outlineSections,
  } = wizardBag;

  // Provider icon helper — declared inside the component so it closes over PROVIDER_LOGOS.
  const ProviderIconEl = ({ id, className }: { id: ProviderType; className?: string; color?: string }) => {
    return <img src={PROVIDER_LOGOS[id]} alt={PROVIDERS.find(p => p.id === id)?.name || id} className={`${className || 'w-5 h-5'} rounded object-contain`} />;
  };

  // Outline expand handlers — recomputed locally from setShowGridMemberDetails.
  const outlineExpandHandlers = useMemo(() => {
    const handlers: Record<string, () => void> = {};
    handlers['section-member-details'] = () => {
      if (!showGridMemberDetails) setShowGridMemberDetails(true);
    };
    return handlers;
  }, [showGridMemberDetails, setShowGridMemberDetails]);

  // Findings filter/sort toggle helpers — recomputed locally.
  const toggleFindingsSort = (col: SortColumn) => {
    if (findingsSort?.col === col) {
      if (findingsSort.dir === 'asc') setFindingsSort({ col, dir: 'desc' });
      else setFindingsSort(null);
    } else {
      setFindingsSort({ col, dir: 'asc' });
    }
  };
  const toggleProviderFilter = (provId: ProviderType) => {
    const next = new Set(findingsProviderFilter);
    if (next.has(provId)) next.delete(provId); else next.add(provId);
    setFindingsProviderFilter(next);
  };
  const toggleCategoryFilter = (cat: TokenCategory) => {
    const next = new Set(findingsCategoryFilter);
    if (next.has(cat)) next.delete(cat); else next.add(cat);
    setFindingsCategoryFilter(next);
  };

  return (
    <div className="flex justify-center py-6">
      <div className="max-w-6xl xl:max-w-[1380px] w-full px-4 sm:px-6">
        <div className="flex items-start">
          <div className="flex-1 min-w-0">
            {/* ── BEGIN LIFTED STEP 5 JSX (verbatim from wizard.tsx 3897..6810) ── */}
            {/* PLACEHOLDER — replaced by sed-merged content in subsequent edit */}
              {/* ── Hero summary card ───────────────────────────────────── */}
              <div id="section-overview" className="scroll-mt-6 bg-white rounded-xl border-2 border-[var(--infoblox-orange)]/30 p-5 mb-6">

                {/* Always-visible header: both totals + single toggle */}
                <button
                  type="button"
                  onClick={() => setHeroCollapsed(v => !v)}
                  className="w-full text-left"
                >
                  <div className={`grid gap-6 ${hasServerMetrics ? 'grid-cols-2' : 'grid-cols-1'}`}>
                    {/* Management total */}
                    <div>
                      <div className="flex items-center gap-1.5 text-[13px] text-[var(--muted-foreground)] mb-1">
                        Total Management Tokens
                        <FieldTooltip text="Management tokens cover DDI Objects (1 token per 25 objects), Active IPs (1 token per 13 IPs), and Managed Assets (1 token per 3 assets). Pack size: 1,000 tokens. Growth buffer is included. Source: NOTES tab rows 12-20." side="right" />
                      </div>
                      <div className="text-[32px] text-[var(--infoblox-orange)]" style={{ fontWeight: 700 }}>
                        {totalTokens.toLocaleString()}
                        {Object.keys(countOverrides).length > 0 && (
                          <span className="ml-2 text-[11px] font-medium text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200 align-middle">
                            <Pencil className="w-3 h-3 inline -mt-0.5 mr-0.5" />adjusted
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="font-mono text-[11px] bg-orange-50 text-orange-800 px-2 py-0.5 rounded border border-orange-200">IB-TOKENS-UDDI-MGMT-1000</span>
                        <span className="text-[12px] font-semibold text-[var(--infoblox-orange)]">× {Math.ceil(totalTokens / 1000).toLocaleString()} pack{Math.ceil(totalTokens / 1000) !== 1 ? 's' : ''}</span>
                      </div>
                      {hybridScenario && (
                        <div className="mt-2 pt-2 border-t border-orange-100">
                          <div className="text-[11px] text-[var(--muted-foreground)] mb-0.5">
                            Hybrid scenario <span className="text-orange-600">({hybridScenario.selectionCount} selected)</span>
                          </div>
                          <div className="text-[22px] text-orange-400" style={{ fontWeight: 700, lineHeight: 1.1 }}>
                            {hybridScenario.mgmt.toLocaleString()}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="font-mono text-[10px] bg-orange-50 text-orange-700 px-1.5 py-0.5 rounded border border-orange-200">IB-TOKENS-UDDI-MGMT-1000</span>
                            <span className="text-[11px] font-semibold text-orange-400">× {Math.ceil(hybridScenario.mgmt / 1000).toLocaleString()} pack{Math.ceil(hybridScenario.mgmt / 1000) !== 1 ? 's' : ''}</span>
                          </div>
                        </div>
                      )}
                    </div>
                    {/* Server total */}
                    {hasServerMetrics && (
                      <div className="border-l border-[var(--border)] pl-6">
                        <div className="flex items-center gap-1.5 text-[13px] text-[var(--muted-foreground)] mb-1">
                          Total Server Tokens
                          <FieldTooltip text="Server tokens (IB-TOKENS-UDDI-SERV-500) cover NIOS-X appliances and XaaS instances sized by QPS, LPS, and object count. Tier capacities range from 2XS (130 tokens) to XL (2,700 tokens) for NIOS-X. Separate from management tokens. No growth buffer applied. Source: NOTES tab rows 21-30." side="right" />
                        </div>
                        <div className="text-[32px] text-blue-700" style={{ fontWeight: 700 }}>
                          {totalServerTokens.toLocaleString()}
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="font-mono text-[11px] bg-blue-50 text-blue-800 px-2 py-0.5 rounded border border-blue-200">IB-TOKENS-UDDI-SERV-500</span>
                          <span className="text-[12px] font-semibold text-blue-700">× {Math.ceil(totalServerTokens / 500).toLocaleString()} pack{Math.ceil(totalServerTokens / 500) !== 1 ? 's' : ''}</span>
                        </div>
                        {hybridScenario && (
                          <div className="mt-2 pt-2 border-t border-blue-100">
                            <div className="text-[11px] text-[var(--muted-foreground)] mb-0.5">
                              Hybrid scenario <span className="text-blue-500">({hybridScenario.selectionCount} selected)</span>
                            </div>
                            <div className="text-[22px] text-blue-400" style={{ fontWeight: 700, lineHeight: 1.1 }}>
                              {hybridScenario.srv.toLocaleString()}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="font-mono text-[10px] bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded border border-blue-200">IB-TOKENS-UDDI-SERV-500</span>
                              <span className="text-[11px] font-semibold text-blue-400">× {Math.ceil(hybridScenario.srv / 500).toLocaleString()} pack{Math.ceil(hybridScenario.srv / 500) !== 1 ? 's' : ''}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  {/* Expand/collapse hint */}
                  <div className="flex items-center gap-1 mt-3 text-[11px] text-[var(--muted-foreground)]">
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${heroCollapsed ? '' : 'rotate-180'}`} />
                    {heroCollapsed ? 'Show breakdown by source' : 'Hide breakdown'}
                  </div>
                </button>

                {/* Expandable: per-source bars for both columns */}
                {!heroCollapsed && (
                  <div className={`mt-4 pt-4 border-t border-[var(--border)] grid gap-6 ${hasServerMetrics ? 'grid-cols-2' : 'grid-cols-1'}`}>

                    {/* Management breakdown */}
                    <div>
                      <div className="text-[11px] font-semibold text-[var(--muted-foreground)] mb-3 uppercase tracking-wider">By Source — Management</div>
                      <div className="space-y-2.5">
                        {(() => {
                          const sourceMap = new Map<string, { source: string; provider: ProviderType; tokens: number }>();
                          effectiveFindings.forEach((f) => {
                            const key = `${f.provider}::${f.source}`;
                            if (!sourceMap.has(key)) sourceMap.set(key, { source: f.source, provider: f.provider, tokens: 0 });
                            sourceMap.get(key)!.tokens += f.managementTokens;
                          });
                          const sources = Array.from(sourceMap.values()).sort((a, b) => b.tokens - a.tokens);
                          const LIMIT = 10;
                          const visible = showAllHeroSources ? sources : sources.slice(0, LIMIT);
                          const hidden = sources.length - LIMIT;
                          const needsScroll = showAllHeroSources && sources.length > 15;
                          return (
                            <>
                              <div className={needsScroll ? 'max-h-[400px] overflow-y-auto' : ''}>
                                {visible.map((entry) => {
                                  const provider = PROVIDERS.find((p) => p.id === entry.provider)!;
                                  const pct = totalTokens > 0 ? (entry.tokens / totalTokens) * 100 : 0;
                                  return (
                                    <div key={`${entry.provider}-${entry.source}`} className="mb-2.5">
                                      <div className="flex items-center justify-between mb-1">
                                        <span className="text-[12px] flex items-center gap-1.5" style={{ fontWeight: 500 }}>
                                          <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: provider.color }} />
                                          {entry.source}
                                          <span className="text-[11px] text-[var(--muted-foreground)]" style={{ fontWeight: 400 }}>{provider.name}</span>
                                        </span>
                                        <span className="text-[12px] tabular-nums text-[var(--muted-foreground)]">
                                          {entry.tokens.toLocaleString()} <span className="text-[11px]">({Math.round(pct)}%)</span>
                                        </span>
                                      </div>
                                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                                        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: provider.color }} />
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                              {hidden > 0 && (
                                <button type="button" onClick={(e) => { e.stopPropagation(); setShowAllHeroSources(v => !v); }}
                                  className="text-[12px] text-[var(--infoblox-blue)] hover:underline mt-1" style={{ fontWeight: 500 }}>
                                  {showAllHeroSources ? 'Show less' : `Show ${hidden} more sources...`}
                                </button>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    </div>

                    {/* Server breakdown */}
                    {hasServerMetrics && (() => {
                      const srvSources: { label: string; color: string; tokens: number }[] = [];
                      if (selectedProviders.includes('nios') && effectiveNiosMetrics.length > 0) {
                        effectiveNiosMetrics.filter(m => !isInfraOnlyMember(m)).forEach(m => {
                          const eff = applyServerOverrides(m, serverMetricOverrides);
                          const t = calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x').serverTokens;
                          if (t > 0) srvSources.push({ label: m.memberName, color: '#00a5e5', tokens: t });
                        });
                      }
                      if (selectedProviders.includes('microsoft') && effectiveADMetrics.length > 0) {
                        const dcs = adMigrationMap.size > 0
                          ? effectiveADMetrics.filter(m => adMigrationMap.has(m.hostname))
                          : effectiveADMetrics;
                        dcs.forEach(m => {
                          const eff = applyADServerOverrides(m, serverMetricOverrides);
                          const t = calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x').serverTokens;
                          if (t > 0) srvSources.push({ label: m.hostname, color: '#0078d4', tokens: t });
                        });
                      }
                      srvSources.sort((a, b) => b.tokens - a.tokens);
                      const LIMIT = 10;
                      const visible = srvSources.slice(0, LIMIT);
                      const hidden = srvSources.length - LIMIT;
                      return (
                        <div className="border-l border-[var(--border)] pl-6">
                          <div className="text-[11px] font-semibold text-[var(--muted-foreground)] mb-3 uppercase tracking-wider">By Source — Server</div>
                          <div className="space-y-2.5">
                            {srvSources.length === 0 ? (
                              <div className="text-[12px] text-[var(--muted-foreground)]">No server metrics available.</div>
                            ) : (
                              <>
                                {visible.map((entry) => {
                                  const pct = totalServerTokens > 0 ? (entry.tokens / totalServerTokens) * 100 : 0;
                                  return (
                                    <div key={entry.label} className="mb-2.5">
                                      <div className="flex items-center justify-between mb-1">
                                        <span className="text-[12px] flex items-center gap-1.5" style={{ fontWeight: 500 }}>
                                          <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
                                          {entry.label}
                                        </span>
                                        <span className="text-[12px] tabular-nums text-[var(--muted-foreground)]">
                                          {entry.tokens.toLocaleString()} <span className="text-[11px]">({Math.round(pct)}%)</span>
                                        </span>
                                      </div>
                                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                                        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: entry.color }} />
                                      </div>
                                    </div>
                                  );
                                })}
                                {hidden > 0 && (
                                  <div className="text-[12px] text-[var(--muted-foreground)] mt-1">+{hidden} more sources</div>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>{/* end hero card */}

              {/* ── Growth buffer + BOM panel (S03) ────────────────────── */}
              <div id="section-bom" className="scroll-mt-6 bg-white rounded-xl border border-[var(--border)] p-5 mb-6">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-[15px]" style={{ fontWeight: 600 }}>Bill of Materials</h3>
                    <p className="text-[12px] text-[var(--muted-foreground)] mt-0.5">Copy-paste ready SKU list for quoting</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 text-[13px]">
                      <span className="text-[var(--muted-foreground)]" style={{ fontWeight: 500 }}>Mgmt Buffer</span>
                      <FieldTooltip text="Growth buffer applied to management and reporting tokens. Default 20% is typical for a 1-year planning horizon." side="left" />
                      <div className="flex items-center border border-[var(--border)] rounded-lg overflow-hidden">
                        <input
                          type="number" min={0} max={100} step={5}
                          className="w-16 px-2 py-1.5 text-[13px] text-right focus:outline-none focus:ring-1 focus:ring-[var(--infoblox-orange)]"
                          value={Math.round(growthBufferPct * 100)}
                          onChange={e => setGrowthBufferPct(Math.min(1, Math.max(0, (parseInt(e.target.value) || 0) / 100)))}
                        />
                        <span className="px-2 py-1.5 bg-gray-50 text-[13px] text-[var(--muted-foreground)] border-l border-[var(--border)]">%</span>
                      </div>
                    </label>
                    {hasServerMetrics && (
                      <label className="flex items-center gap-2 text-[13px]">
                        <span className="text-[var(--muted-foreground)]" style={{ fontWeight: 500 }}>Server Buffer</span>
                        <FieldTooltip text="Growth buffer applied to server tokens (NIOS-X appliances, XaaS instances, AD domain controllers). Accounts for workload growth in QPS, LPS, and object counts. Default 20%." side="left" />
                        <div className="flex items-center border border-[var(--border)] rounded-lg overflow-hidden">
                          <input
                            type="number" min={0} max={100} step={5}
                            className="w-16 px-2 py-1.5 text-[13px] text-right focus:outline-none focus:ring-1 focus:ring-blue-500"
                            value={Math.round(serverGrowthBufferPct * 100)}
                            onChange={e => setServerGrowthBufferPct(Math.min(1, Math.max(0, (parseInt(e.target.value) || 0) / 100)))}
                          />
                          <span className="px-2 py-1.5 bg-gray-50 text-[13px] text-[var(--muted-foreground)] border-l border-[var(--border)]">%</span>
                        </div>
                      </label>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        const mgmtPacks = Math.ceil(totalTokens / 1000);
                        const servPacks = hasServerMetrics ? Math.ceil(totalServerTokens / 500) : 0;
                        const rptPacks = reportingTokens > 0 ? Math.ceil(reportingTokens / 40) : 0;
                        const lines = [
                          `SKU Code\tDescription\tPack Count`,
                          `IB-TOKENS-UDDI-MGMT-1000\tManagement Token Pack (1000 tokens)\t${mgmtPacks}`,
                          ...(servPacks > 0 ? [`IB-TOKENS-UDDI-SERV-500\tServer Token Pack (500 tokens)\t${servPacks}`] : []),
                          ...(rptPacks > 0 ? [`IB-TOKENS-REPORTING-40\tReporting Token Pack (40 tokens)\t${rptPacks}`] : []),
                        ];
                        navigator.clipboard.writeText(lines.join('\n')).then(() => {
                          setBomCopied(true);
                          setTimeout(() => setBomCopied(false), 2000);
                        });
                      }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] border transition-colors ${bomCopied ? 'bg-green-50 border-green-300 text-green-700' : 'bg-white border-[var(--border)] hover:bg-gray-50'}`}
                      style={{ fontWeight: 500 }}
                    >
                      {bomCopied ? <><Check className="w-3.5 h-3.5" /> Copied!</> : <><Download className="w-3.5 h-3.5" /> Copy BOM</>}
                    </button>
                  </div>
                </div>
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-[var(--border)]">
                      <th className="text-left py-2 text-[var(--muted-foreground)] text-[12px]" style={{ fontWeight: 500 }}>SKU Code</th>
                      <th className="text-left py-2 text-[var(--muted-foreground)] text-[12px]" style={{ fontWeight: 500 }}>Description</th>
                      <th className="text-right py-2 text-[var(--muted-foreground)] text-[12px]" style={{ fontWeight: 500 }}>Pack Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-[var(--border)]/50">
                      <td className="py-2.5 font-mono text-[12px] text-orange-800">IB-TOKENS-UDDI-MGMT-1000</td>
                      <td className="py-2.5 text-[var(--muted-foreground)]">
                        <span className="flex items-center gap-1">
                          Management Token Pack (1000 tokens)
                          <FieldTooltip text="Covers DDI Objects, Active IPs, and Managed Assets. Pack size: 1000 tokens. Count = ceil(total management tokens / 1000). Growth buffer already included." side="top" />
                        </span>
                      </td>
                      <td className="py-2.5 text-right tabular-nums" style={{ fontWeight: 600 }}>{Math.ceil(totalTokens / 1000).toLocaleString()}</td>
                    </tr>
                    {hasServerMetrics && (
                      <tr className="border-b border-[var(--border)]/50">
                        <td className="py-2.5 font-mono text-[12px] text-blue-800">IB-TOKENS-UDDI-SERV-500</td>
                        <td className="py-2.5 text-[var(--muted-foreground)]">
                          <span className="flex items-center gap-1">
                            Server Token Pack (500 tokens)
                            <FieldTooltip text="Server tokens (IB-TOKENS-UDDI-SERV-500) cover NIOS-X appliances and XaaS instances sized by QPS, LPS, and object count. Tier capacities range from 2XS (130 tokens) to XL (2,700 tokens) for NIOS-X. Separate from management tokens. No growth buffer applied. Source: NOTES tab rows 21-30." side="top" />
                          </span>
                        </td>
                        <td className="py-2.5 text-right tabular-nums" style={{ fontWeight: 600 }}>{Math.ceil(totalServerTokens / 500).toLocaleString()}</td>
                      </tr>
                    )}
                    {reportingTokens > 0 && (
                      <tr>
                        <td className="py-2.5 font-mono text-[12px] text-purple-800">IB-TOKENS-REPORTING-40</td>
                        <td className="py-2.5 text-[var(--muted-foreground)]">
                          <span className="flex items-center gap-1">
                            Reporting Token Pack (40 tokens)
                            <FieldTooltip text="Reporting tokens (IB-TOKENS-REPORTING-40) cover DNS protocol and DHCP lease log forwarding. Rate: CSP=80 tokens per 10M events, S3 Bucket=40, Ecosystem (CDC)=40. Local Syslog is display-only and contributes 0 tokens. Ecosystem receives 40% of total log volume by default. Growth buffer is applied. Source: NOTES tab rows 31-44." side="top" />
                          </span>
                        </td>
                        <td className="py-2.5 text-right tabular-nums" style={{ fontWeight: 600 }}>{Math.ceil(reportingTokens / 40).toLocaleString()}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
                {growthBufferPct > 0 && (
                  <p className="text-[11px] text-[var(--muted-foreground)] mt-3">
                    Includes {Math.round(growthBufferPct * 100)}% growth buffer on management{reportingTokens > 0 ? '/reporting' : ''} tokens{hasServerMetrics ? `, ${Math.round(serverGrowthBufferPct * 100)}% on server tokens` : ''}.
                  </p>
                )}
              </div>

              {/* Horizontal jump nav removed — replaced by OutlineNav sidebar (Phase 23) */}

              {/* Top Consumer Cards — DNS, DHCP, IP */}
              {(() => {
                const consumerCards: {
                  key: string;
                  label: string;
                  filter: (f: typeof findings[0]) => boolean;
                  expanded: boolean;
                  toggle: () => void;
                  icon: typeof Globe;
                  iconBg: string;
                  iconColor: string;
                  barColor: string;
                }[] = [
                  {
                    key: 'dns',
                    label: 'Top 5 DNS Consumers',
                    filter: (f) => /dns|zone/i.test(f.item) && !/unsupported/i.test(f.item),
                    expanded: topDnsExpanded,
                    toggle: () => setTopDnsExpanded((v) => !v),
                    icon: Globe,
                    iconBg: 'bg-blue-50',
                    iconColor: 'text-blue-600',
                    barColor: 'bg-blue-500',
                  },
                  {
                    key: 'dhcp',
                    label: 'Top 5 DHCP Consumers',
                    filter: (f) => /dhcp|scope|lease|range|reservation/i.test(f.item) && !/unsupported/i.test(f.item),
                    expanded: topDhcpExpanded,
                    toggle: () => setTopDhcpExpanded((v) => !v),
                    icon: Activity,
                    iconBg: 'bg-purple-50',
                    iconColor: 'text-purple-600',
                    barColor: 'bg-purple-500',
                  },
                  {
                    key: 'ip',
                    label: 'Top 5 IP / Network Consumers',
                    filter: (f) => /ip|subnet|network|cidr|address|vnet|vpc/i.test(f.item) && !/dhcp|dns|unsupported/i.test(f.item),
                    expanded: topIpExpanded,
                    toggle: () => setTopIpExpanded((v) => !v),
                    icon: Gauge,
                    iconBg: 'bg-green-50',
                    iconColor: 'text-green-600',
                    barColor: 'bg-green-500',
                  },
                ];

                const visibleCards = consumerCards.filter((card) => {
                  const items = effectiveFindings.filter(card.filter);
                  return items.length > 0;
                });

                if (visibleCards.length === 0) return null;

                const metricBySource = new Map(effectiveNiosMetrics.map(m => [m.memberName, m]));

                return (
                  <div className="grid grid-cols-1 gap-4 mb-6">
                    {visibleCards.map((card) => {
                      const topItems = findings
                        .filter(card.filter)
                        .sort((a, b) => b.managementTokens - a.managementTokens)
                        .slice(0, 5);
                      const totalCardTokens = topItems.reduce((s, f) => s + f.managementTokens, 0);
                      const IconComp = card.icon;
                      return (
                        <div key={card.key} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                          <button
                            type="button"
                            className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 transition-colors text-left"
                            onClick={card.toggle}
                          >
                            <div className="flex items-center gap-2.5">
                              <div className={`w-8 h-8 rounded-lg ${card.iconBg} flex items-center justify-center`}>
                                <IconComp className={`w-4 h-4 ${card.iconColor}`} />
                              </div>
                              <div>
                                <div className="text-[13px]" style={{ fontWeight: 600 }}>{card.label}</div>
                                <div className="text-[11px] text-[var(--muted-foreground)]">
                                  {totalCardTokens.toLocaleString()} tokens across {topItems.length} items
                                </div>
                              </div>
                            </div>
                            {card.expanded
                              ? <ChevronUp className="w-4 h-4 text-gray-400" />
                              : <ChevronDown className="w-4 h-4 text-gray-400" />
                            }
                          </button>
                          {card.expanded && (
                            <div className="px-5 pb-4 border-t border-gray-100">
                              <table className="w-full text-[12px] mt-3">
                                <thead>
                                  <tr className="text-[11px] text-[var(--muted-foreground)]">
                                    <th className="text-left pb-2 pr-3" style={{ fontWeight: 500 }}>Source</th>
                                    <th className="text-left pb-2 pr-3" style={{ fontWeight: 500 }}>Item</th>
                                    <th className="text-right pb-2 pr-3" style={{ fontWeight: 500 }}>Count</th>
                                    <th className="text-right pb-2" style={{ fontWeight: 500 }}>Tokens</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {topItems.map((f, idx) => {
                                    const provider = PROVIDERS.find((p) => p.id === f.provider)!;
                                    const pct = totalCardTokens > 0 ? (f.managementTokens / totalCardTokens) * 100 : 0;
                                    return (
                                      <tr key={`${card.key}-top-${idx}`} className="border-t border-gray-50">
                                        <td className="py-2 pr-3">
                                          <div className="flex items-center gap-1.5">
                                            <span
                                              className="inline-block w-2 h-2 rounded-full shrink-0"
                                              style={{ backgroundColor: provider.color }}
                                            />
                                            <span className="truncate max-w-[220px]">{f.source}</span>
                                            {(() => {
                                              const metric = metricBySource.get(f.source);
                                              if (!metric) return null;
                                              return (
                                                <>
                                                  {metric.model && (
                                                    <span className="ml-1 text-[10px] text-gray-400">({metric.model})</span>
                                                  )}
                                                  {metric.platform && (
                                                    <PlatformBadge platform={metric.platform as any} className="ml-1">
                                                      {metric.platform}
                                                    </PlatformBadge>
                                                  )}
                                                </>
                                              );
                                            })()}
                                          </div>
                                        </td>
                                        <td className="py-2 pr-3">{formatItemLabel(f.item)}</td>
                                        <td className="py-2 pr-3 text-right tabular-nums">{f.count.toLocaleString()}</td>
                                        <td className="py-2 text-right">
                                          <div className="flex items-center justify-end gap-2">
                                            <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                              <div
                                                className={`h-full rounded-full ${card.barColor}`}
                                                style={{ width: `${pct}%` }}
                                              />
                                            </div>
                                            <span className="tabular-nums" style={{ fontWeight: 500 }}>{f.managementTokens.toLocaleString()}</span>
                                          </div>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              {/* 3 category columns with per-source breakdown */}
              {(() => {
                // Build per-source data for each category
                const sourceLabel = selectedProviders.map((p) => PROVIDERS.find((pr) => pr.id === p)!.subscriptionLabel).filter((v, i, a) => a.indexOf(v) === i).join(' / ');

                type SourceEntry = { source: string; provider: ProviderType; tokens: number; count: number };
                const buildSourceList = (category: TokenCategory): SourceEntry[] => {
                  const map = new Map<string, SourceEntry>();
                  effectiveFindings.filter(f => f.category === category).forEach((f) => {
                    const key = `${f.provider}::${f.source}`;
                    if (!map.has(key)) map.set(key, { source: f.source, provider: f.provider, tokens: 0, count: 0 });
                    const e = map.get(key)!;
                    e.tokens += f.managementTokens;
                    e.count += f.count;
                  });
                  return Array.from(map.values()).sort((a, b) => b.tokens - a.tokens);
                };

                const categories: { key: TokenCategory; label: string; color: string; bgLight: string; barColor: string; textColor: string; unitLabel: string; tooltip: string }[] = [
                  { key: 'DDI Object', label: 'DDI Objects', color: 'text-blue-600', bgLight: 'bg-blue-50', barColor: 'bg-blue-500', textColor: 'text-blue-700', unitLabel: 'objects', tooltip: 'DNS zones, DNS records, DHCP scopes, and IPAM networks — each counts as one DDI object. Rate: 1 management token per 25 DDI objects.' },
                  { key: 'Active IP', label: 'Active IPs', color: 'text-purple-600', bgLight: 'bg-purple-50', barColor: 'bg-purple-500', textColor: 'text-purple-700', unitLabel: 'IPs', tooltip: 'Active DHCP leases and statically-assigned IP addresses. Rate: 1 management token per 13 active IPs.' },
                  { key: 'Asset', label: 'Managed Assets', color: 'text-green-600', bgLight: 'bg-green-50', barColor: 'bg-green-500', textColor: 'text-green-700', unitLabel: 'assets', tooltip: 'VMs, EC2 instances, container nodes, AD computers, and other managed endpoints. Rate: 1 management token per 3 managed assets.' },
                ];

                return (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                    {categories.map((cat) => {
                      const catTokens = categoryTotals[cat.key];
                      const catCount = effectiveFindings.filter(f => f.category === cat.key).reduce((s, f) => s + f.count, 0);
                      const sources = buildSourceList(cat.key);
                      const maxSourceTokens = Math.max(...sources.map(s => s.tokens), 1);

                      return (
                        <div key={cat.key} className="bg-white rounded-xl border border-[var(--border)] overflow-hidden flex flex-col">
                          {/* Category header */}
                          <div className={`px-4 py-4 border-b border-[var(--border)] ${cat.bgLight}`}>
                            <div className="flex items-center gap-1 text-[12px] text-[var(--muted-foreground)] mb-1">
                              {cat.label}
                              <FieldTooltip text={cat.tooltip} side="top" />
                            </div>
                            <div className={`text-[24px] ${cat.color}`} style={{ fontWeight: 700 }}>
                              {catTokens.toLocaleString()}
                              <span className="text-[12px] text-[var(--muted-foreground)] ml-1.5" style={{ fontWeight: 400 }}>tokens</span>
                            </div>
                            <div className="text-[11px] text-[var(--muted-foreground)]">
                              {catCount.toLocaleString()} {cat.unitLabel} (1 token per {TOKEN_RATES[cat.key]})
                            </div>
                          </div>

                          {/* Per-source breakdown */}
                          <div className="px-4 py-3 flex-1">
                            <div className="text-[11px] text-[var(--muted-foreground)] mb-2 uppercase tracking-wider" style={{ fontWeight: 500 }}>
                              By {sourceLabel}
                            </div>
                            <div className="space-y-3">
                              {(() => {
                                const CAT_LIMIT = 5;
                                const showAll = showAllCategorySources[cat.key] || false;
                                const visible = showAll ? sources : sources.slice(0, CAT_LIMIT);
                                const catHidden = sources.length - CAT_LIMIT;
                                const needsScroll = showAll && sources.length > 10;
                                return (
                                  <div className={needsScroll ? 'max-h-[300px] overflow-y-auto' : ''}>
                                    {visible.map((entry) => {
                                      const provider = PROVIDERS.find((p) => p.id === entry.provider)!;
                                      const pct = maxSourceTokens > 0 ? (entry.tokens / maxSourceTokens) * 100 : 0;
                                      return (
                                        <div key={`${entry.provider}-${entry.source}`}>
                                          <div className="flex items-center justify-between mb-1">
                                            <span className="text-[12px] flex items-center gap-1.5 min-w-0" style={{ fontWeight: 500 }}>
                                              <span
                                                className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                                                style={{ backgroundColor: provider.color }}
                                              />
                                              <span className="truncate">{entry.source}</span>
                                            </span>
                                            <span className="text-[12px] tabular-nums shrink-0 ml-2" style={{ fontWeight: 600 }}>
                                              {entry.tokens.toLocaleString()}
                                            </span>
                                          </div>
                                          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                                            <div
                                              className={`h-full rounded-full transition-all ${cat.barColor}`}
                                              style={{ width: `${pct}%` }}
                                            />
                                          </div>
                                          <div className="text-[10px] text-[var(--muted-foreground)] mt-0.5 tabular-nums">
                                            {entry.count.toLocaleString()} {cat.unitLabel}
                                          </div>
                                        </div>
                                      );
                                    })}
                                    {catHidden > 0 && (
                                      <button
                                        type="button"
                                        onClick={() => setShowAllCategorySources((prev) => ({ ...prev, [cat.key]: !showAll }))}
                                        className="text-[11px] text-[var(--infoblox-blue)] hover:underline"
                                        style={{ fontWeight: 500 }}
                                      >
                                        {showAll ? 'Show less' : `+${catHidden} more`}
                                      </button>
                                    )}
                                  </div>
                                );
                              })()}
                              {sources.length === 0 && (
                                <div className="text-[12px] text-[var(--muted-foreground)] italic py-2">
                                  No {cat.unitLabel} found
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              {/* NIOS-X Migration Planner — lifted to shared <ResultsMigrationPlanner /> in Phase 34 Plan 01 */}
              <ResultsMigrationPlanner
                mode="scan"
                selectedProviders={selectedProviders}
                members={effectiveNiosMetrics}
                findings={findings}
                effectiveFindings={effectiveFindings}
                fleetSavings={fleetSavings}
                memberSavings={memberSavings}
                growthBufferPct={growthBufferPct}
                niosMigrationMap={niosMigrationMap}
                setNiosMigrationMap={setNiosMigrationMap}
                setVariantOverrides={setVariantOverrides}
                serverMetricOverrides={serverMetricOverrides}
                setServerMetricOverrides={setServerMetricOverrides}
                editingServerMetric={editingServerMetric}
                setEditingServerMetric={setEditingServerMetric}
                editingServerValue={editingServerValue}
                setEditingServerValue={setEditingServerValue}
                memberSearchFilter={memberSearchFilter}
                setMemberSearchFilter={setMemberSearchFilter}
                showGridMemberDetails={showGridMemberDetails}
                setShowGridMemberDetails={setShowGridMemberDetails}
                gridMemberDetailSearch={gridMemberDetailSearch}
                setGridMemberDetailSearch={setGridMemberDetailSearch}
                niosGridFeatures={niosGridFeatures}
                niosGridLicenses={niosGridLicenses}
                niosMigrationFlags={niosMigrationFlags}
                gridFeaturesOpen={gridFeaturesOpen}
                setGridFeaturesOpen={setGridFeaturesOpen}
                migrationFlagsOpen={migrationFlagsOpen}
                setMigrationFlagsOpen={setMigrationFlagsOpen}
              />

              {/* Resource Savings — Phase 34 Plan 03 shim mount.
                  Scan mode keeps per-member savings inline inside ResultsMemberDetails
                  to preserve REQ-07 byte-identical DOM, so this mount intentionally
                  passes savings={[]} → renders null. The shim is in place so a
                  future scan-mode reorganization can flip the data feed without
                  touching the import surface. Sizer mode (Plan 34-04) will mount
                  the same shim with mode="sizer" and Sizer-derived savings. */}
              <ResultsResourceSavings
                mode="scan"
                savings={[]}
                onVariantChange={() => {}}
              />

              {/* AD Migration Planner — interactive, mirrors NIOS Grid Migration Planner */}
              {selectedProviders.includes('microsoft') && effectiveADMetrics.length > 0 && (() => {
                const adHostnames = effectiveADMetrics.map(m => m.hostname);

                const toggleAdMigration = (hostname: string) => {
                  setAdMigrationMap((prev) => {
                    const next = new Map(prev);
                    if (next.has(hostname)) next.delete(hostname); else next.set(hostname, 'nios-x');
                    return next;
                  });
                };

                const setAdFormFactor = (hostname: string, ff: ServerFormFactor) => {
                  setAdMigrationMap((prev) => {
                    const next = new Map(prev);
                    next.set(hostname, ff);
                    return next;
                  });
                };

                const filteredADHosts = adMemberSearchFilter
                  ? adHostnames.filter(h => h.toLowerCase().includes(adMemberSearchFilter.toLowerCase()))
                  : adHostnames;

                const toggleAllAdMigration = () => {
                  const targets = adMemberSearchFilter ? filteredADHosts : adHostnames;
                  const allTargetsMigrated = targets.every(h => adMigrationMap.has(h));
                  if (allTargetsMigrated) {
                    setAdMigrationMap(prev => {
                      const next = new Map(prev);
                      targets.forEach(h => next.delete(h));
                      return next;
                    });
                  } else {
                    setAdMigrationMap(prev => {
                      const next = new Map(prev);
                      targets.forEach(h => next.set(h, next.get(h) || 'nios-x'));
                      return next;
                    });
                  }
                };

                // Scenario token calculations — migration-map-aware, XaaS-consolidated.
                // Helper: compute tokens for a set of DCs respecting their form factor.
                const calcAdScenarioTokens = (dcs: typeof effectiveADMetrics) => {
                  if (dcs.length === 0) return 0;
                  const niosXDcs = dcs.filter(m => adMigrationMap.get(m.hostname) !== 'nios-xaas');
                  const xaasDcs  = dcs.filter(m => adMigrationMap.get(m.hostname) === 'nios-xaas');
                  const niosXTok = niosXDcs.reduce((s, m) => {
                    const eff = applyADServerOverrides(m, serverMetricOverrides);
                    return s + calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x').serverTokens;
                  }, 0);
                  const xaasInst = consolidateXaasInstances(xaasDcs.map(m => {
                    const eff = applyADServerOverrides(m, serverMetricOverrides);
                    return {
                      memberId: m.hostname, memberName: m.hostname, role: 'DC',
                      qps: eff.qps, lps: eff.lps, objectCount: eff.objects, activeIPCount: 0,
                      managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: {},
                    };
                  }));
                  return niosXTok + xaasInst.reduce((s, inst) => s + inst.totalTokens, 0);
                };

                // Full Migration: all DCs default to NIOS-X when no map entry exists.
                // We simulate "all migrated to NIOS-X" for the baseline full scenario.
                const fullMigrationTokens = effectiveADMetrics.reduce((s, m) => {
                  const eff = applyADServerOverrides(m, serverMetricOverrides);
                  return s + calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x').serverTokens;
                }, 0);

                // Hybrid: only selected DCs, using their actual form factor.
                const hybridServerTokens = calcAdScenarioTokens(
                  effectiveADMetrics.filter(m => adMigrationMap.has(m.hostname))
                );

                const adNiosXCount = Array.from(adMigrationMap.values()).filter(v => v === 'nios-x').length;
                const adXaasCount = Array.from(adMigrationMap.values()).filter(v => v === 'nios-xaas').length;

                const scenarioCurrent = { label: 'Current', tokens: 0, desc: 'All DCs remain on Windows DNS/DHCP licensing. No NIOS-X server tokens required.' };
                const scenarioHybrid = {
                  label: 'Hybrid',
                  tokens: hybridServerTokens,
                  desc: adMigrationMap.size > 0
                    ? `${adMigrationMap.size} of ${adHostnames.length} DCs migrated${adNiosXCount > 0 && adXaasCount > 0 ? ` (${adNiosXCount} NIOS-X, ${adXaasCount} XaaS)` : adNiosXCount > 0 ? ' to NIOS-X' : ' to XaaS'}. Remainder stay on Windows.`
                    : 'Select DCs to migrate. Remainder stay on Windows licensing.'
                };
                const scenarioFull = { label: 'Full Migration', tokens: fullMigrationTokens, desc: `All ${adHostnames.length} DCs migrated to NIOS-X for unified DDI management.` };

                const tierColors: Record<string, string> = {
                  '2XS': 'bg-gray-100 text-gray-700',
                  'XS': 'bg-sky-100 text-sky-700',
                  'S': 'bg-green-100 text-green-700',
                  'M': 'bg-yellow-100 text-yellow-700',
                  'L': 'bg-orange-100 text-orange-700',
                  'XL': 'bg-red-100 text-red-700',
                };

                return (
                  <div id="section-ad-migration" className="scroll-mt-6 bg-white rounded-xl border-2 border-[var(--infoblox-blue)]/30 mb-6 overflow-hidden">
                    <div className="px-4 py-3 border-b border-[var(--border)] bg-gradient-to-r from-blue-50 to-indigo-50 flex items-center gap-2">
                      <span className="text-[var(--infoblox-blue)] text-[16px]">📊</span>
                      <ArrowRightLeft className="w-4 h-4 text-[var(--infoblox-blue)]" />
                      <h3 className="text-[14px]" style={{ fontWeight: 600 }}>
                        AD Migration Planner
                      </h3>
                      <span className="ml-auto text-[11px] text-[var(--muted-foreground)]">
                        Select domain controllers &amp; target form factor
                      </span>
                    </div>

                    {/* DC selector */}
                    <div className="px-4 py-3 border-b border-[var(--border)]">
                      {/* Search filter */}
                      <div className="relative mb-2">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                        <input
                          type="text"
                          placeholder="Filter domain controllers..."
                          value={adMemberSearchFilter}
                          onChange={(e) => setAdMemberSearchFilter(e.target.value)}
                          className="w-full pl-8 pr-3 py-2 text-[12px] rounded-lg border border-[var(--border)] focus:outline-none focus:ring-1 focus:ring-[var(--infoblox-blue)] focus:border-[var(--infoblox-blue)]"
                        />
                      </div>
                      <div className="flex items-center gap-2 mb-3">
                        <button
                          onClick={toggleAllAdMigration}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] border border-[var(--border)] hover:bg-gray-50 transition-colors"
                          style={{ fontWeight: 500 }}
                        >
                          {(() => {
                            const targets = adMemberSearchFilter ? filteredADHosts : adHostnames;
                            const allTargetsMigrated = targets.length > 0 && targets.every(h => adMigrationMap.has(h));
                            const someTargetsMigrated = targets.some(h => adMigrationMap.has(h));
                            return (
                              <>
                                <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                                  allTargetsMigrated
                                    ? 'bg-[var(--infoblox-blue)] border-[var(--infoblox-blue)]'
                                    : someTargetsMigrated
                                      ? 'bg-[var(--infoblox-blue)]/60 border-[var(--infoblox-blue)]'
                                      : 'border-gray-300'
                                }`}>
                                  {allTargetsMigrated && <Check className="w-2.5 h-2.5 text-white" />}
                                  {someTargetsMigrated && !allTargetsMigrated && <Minus className="w-2.5 h-2.5 text-white" />}
                                </div>
                                {allTargetsMigrated ? 'Deselect All' : 'Migrate All'}
                              </>
                            );
                          })()}
                        </button>
                        <span className="text-[11px] text-[var(--muted-foreground)]">
                          {adMemberSearchFilter
                            ? `${filteredADHosts.length} of ${adHostnames.length} DCs`
                            : `${adMigrationMap.size} of ${adHostnames.length} DCs selected`}
                          {adMigrationMap.size > 0 && !adMemberSearchFilter && (() => {
                            if (adNiosXCount > 0 && adXaasCount > 0) return ` (${adNiosXCount} NIOS-X, ${adXaasCount} XaaS)`;
                            if (adXaasCount > 0) return ` (${adXaasCount} XaaS)`;
                            return ` (${adNiosXCount} NIOS-X)`;
                          })()}
                        </span>
                      </div>
                      <div className="max-h-[320px] overflow-y-auto border-t border-b border-gray-100">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 py-1">
                          {filteredADHosts.map((hostname) => {
                            const m = effectiveADMetrics.find(met => met.hostname === hostname)!;
                            const isMigrating = adMigrationMap.has(hostname);
                            const dcFF = adMigrationMap.get(hostname) || 'nios-x';
                            return (
                              <div
                                key={hostname}
                                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors ${
                                  isMigrating
                                    ? dcFF === 'nios-xaas'
                                      ? 'bg-purple-50 border border-purple-200'
                                      : 'bg-blue-50 border border-blue-200'
                                    : 'border border-[var(--border)] hover:bg-gray-50'
                                }`}
                              >
                                <button
                                  onClick={() => toggleAdMigration(hostname)}
                                  className="flex items-center gap-0 shrink-0"
                                >
                                  <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                                    isMigrating
                                      ? dcFF === 'nios-xaas'
                                        ? 'bg-purple-600 border-purple-600'
                                        : 'bg-[var(--infoblox-blue)] border-[var(--infoblox-blue)]'
                                      : 'border-gray-300'
                                  }`}>
                                    {isMigrating && <Check className="w-3 h-3 text-white" />}
                                  </div>
                                </button>
                                <div className="flex-1 min-w-0">
                                  <div className="text-[12px] truncate" style={{ fontWeight: 500 }}>{hostname}</div>
                                  <div className="text-[10px] text-[var(--muted-foreground)] flex items-center gap-2">
                                    <span>{m.qps > 0 ? m.qps.toLocaleString() : '\u2014'} QPS</span>
                                    <span>{m.lps > 0 ? m.lps.toLocaleString() : '\u2014'} LPS</span>
                                    <span className={`inline-block px-1.5 py-0 rounded-full text-[9px] ${tierColors[m.tier] || 'bg-gray-100 text-gray-700'}`} style={{ fontWeight: 600 }}>{m.tier}</span>
                                    <span>{m.serverTokens.toLocaleString()} tokens</span>
                                  </div>
                                </div>
                                {isMigrating && (
                                  <div className="flex items-center bg-white rounded-md border border-gray-200 p-0.5 shrink-0">
                                    <button
                                      onClick={() => setAdFormFactor(hostname, 'nios-x')}
                                      className={`px-2 py-0.5 rounded text-[9px] transition-all ${
                                        dcFF === 'nios-x'
                                          ? 'bg-[var(--infoblox-navy)] text-white shadow-sm'
                                          : 'text-gray-400 hover:text-gray-600'
                                      }`}
                                      style={{ fontWeight: 600 }}
                                    >
                                      NIOS-X
                                    </button>
                                    <button
                                      onClick={() => setAdFormFactor(hostname, 'nios-xaas')}
                                      className={`px-2 py-0.5 rounded text-[9px] transition-all ${
                                        dcFF === 'nios-xaas'
                                          ? 'bg-purple-600 text-white shadow-sm'
                                          : 'text-gray-400 hover:text-gray-600'
                                      }`}
                                      style={{ fontWeight: 600 }}
                                    >
                                      XaaS
                                    </button>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    {/* Scenario comparison cards */}
                    {(() => {
                      const adIsActive = (idx: number) =>
                        idx === 0 ? adMigrationMap.size === 0
                        : idx === 1 ? adMigrationMap.size > 0 && adMigrationMap.size < adHostnames.length
                        : adMigrationMap.size === adHostnames.length;

                      // Server Token scenarios — already computed above
                      const adSrvScenarios: ScenarioCard[] = [
                        { label: 'Current',        primaryValue: 0,                  desc: 'All DCs remain on Windows DNS/DHCP licensing. No NIOS-X server tokens required.' },
                        { label: 'Hybrid',         primaryValue: hybridServerTokens, desc: scenarioHybrid.desc },
                        { label: 'Full Migration', primaryValue: fullMigrationTokens, desc: `All ${adHostnames.length} DCs migrated to NIOS-X for unified DDI management.` },
                      ];

                      // Management token note — AD management tokens are constant across all migration scenarios
                      const adMgmtTotal = calcUddiTokensAggregated(effectiveFindings.filter(f => (f.provider as string) === 'ad'));
                      const nonAdTokens = calcUddiTokensAggregated(effectiveFindings.filter(f => (f.provider as string) !== 'ad'));

                      return (
                        <>
                          {/* Management token note — same value across all scenarios, no row needed */}
                          <div className="px-4 py-3 border-b border-[var(--border)] bg-orange-50/40 flex items-center gap-3">
                            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-orange-700" style={{ fontWeight: 700 }}>
                              <span className="w-2 h-2 rounded-full bg-orange-500 shrink-0" />
                              Management Tokens
                            </div>
                            <div className="text-[22px] text-orange-600" style={{ fontWeight: 700 }}>{(nonAdTokens + adMgmtTotal).toLocaleString()}</div>
                            <div className="text-[11px] text-[var(--muted-foreground)] leading-tight">
                              Management tokens count the same across all migration scenarios —
                              DDI objects (users, computers, IPs) exist regardless of whether DCs run on Windows or NIOS-X.
                            </div>
                          </div>
                          <ScenarioPlannerCards
                            title="Server Tokens"
                            unit="Server Tokens (IB-TOKENS-UDDI-SERV-500)"
                            color="blue"
                            scenarios={adSrvScenarios}
                            isActive={adIsActive}
                          />
                        </>
                      );
                    })()}

                    {/* Knowledge Worker / Computer / Static IP summary */}
                    <div className="px-4 pb-4">
                      <div className="grid grid-cols-3 gap-4">
                        {(() => {
                          const kwCount = effectiveFindings.filter(f => f.item === 'user_account' && (f.provider as string) === 'ad').reduce((s, f) => s + f.count, 0);
                          const compCount = effectiveFindings.filter(f => f.item === 'computer_count' && (f.provider as string) === 'ad').reduce((s, f) => s + f.count, 0);
                          const staticCount = effectiveFindings.filter(f => f.item === 'static_ip_count' && (f.provider as string) === 'ad').reduce((s, f) => s + f.count, 0);
                          return [
                            { label: 'Knowledge Workers', value: kwCount, icon: '👥', desc: 'AD User Accounts' },
                            { label: 'Computer Inventory', value: compCount, icon: '💻', desc: 'Managed Assets' },
                            { label: 'Static IPs', value: staticCount, icon: '🌐', desc: 'Active IPs' },
                          ].map((metric, i) => (
                            <div key={i} className="bg-gray-50 rounded-lg p-3 text-center">
                              <div className="text-[20px]">{metric.icon}</div>
                              <div className="text-[20px] mt-1" style={{ fontWeight: 700 }}>{metric.value.toLocaleString()}</div>
                              <div className="text-[12px]" style={{ fontWeight: 600 }}>{metric.label}</div>
                              <div className="text-[11px] text-[var(--muted-foreground)]">{metric.desc}</div>
                            </div>
                          ));
                        })()}
                      </div>
                    </div>

                    {/* AD Server Token Calculator — inline within AD Migration Planner */}
                    {effectiveADMetrics.length > 0 && (() => {
                      const toNiosMetrics = (m: ADServerMetrics): NiosServerMetrics => {
                        const eff = applyADServerOverrides(m, serverMetricOverrides);
                        return {
                          memberId: m.hostname,
                          memberName: m.hostname,
                          role: 'DC',
                          qps: eff.qps,
                          lps: eff.lps,
                          objectCount: eff.objects,
                          activeIPCount: 0,
                          managedIPCount: 0, staticHosts: 0, dynamicHosts: 0, dhcpUtilization: 0, licenses: {},
                        };
                      };

                      const displayMembers = adMigrationMap.size > 0
                        ? effectiveADMetrics.filter(m => adMigrationMap.has(m.hostname))
                        : effectiveADMetrics;

                      const getDcFF = (hostname: string): ServerFormFactor =>
                        adMigrationMap.get(hostname) || 'nios-x';

                      const hasAnyXaas = displayMembers.some(m => getDcFF(m.hostname) === 'nios-xaas');
                      const xaasDcs = displayMembers.filter(m => getDcFF(m.hostname) === 'nios-xaas');
                      const niosXDcs = displayMembers.filter(m => getDcFF(m.hostname) === 'nios-x');
                      const niosXDcCount = niosXDcs.length;
                      const xaasDcCount = xaasDcs.length;

                      const xaasInstances = consolidateXaasInstances(xaasDcs.map(toNiosMetrics));
                      const totalXaasTokens = xaasInstances.reduce((s, inst) => s + inst.totalTokens, 0);

                      const niosXTokens = niosXDcs.reduce((sum, m) => {
                        const eff = applyADServerOverrides(m, serverMetricOverrides);
                        return sum + calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x').serverTokens;
                      }, 0);

                      const totalServerTokens = niosXTokens + totalXaasTokens;
                      const totalDcsReplaced = xaasDcs.length;

                      const tierColorClass = (name: string) =>
                        name === 'XL' ? 'bg-red-100 text-red-700' :
                        name === 'L' ? 'bg-orange-100 text-orange-700' :
                        name === 'M' ? 'bg-yellow-100 text-yellow-700' :
                        name === 'S' ? 'bg-green-100 text-green-700' :
                        name === 'XS' ? 'bg-sky-100 text-sky-700' :
                        'bg-gray-100 text-gray-700';

                      return (
                        <div id="section-ad-server-tokens" className="scroll-mt-6 border-t border-blue-200 bg-blue-50/10">
                          <div className="px-4 py-3 border-b border-blue-200 bg-blue-50/50 flex items-center gap-2 flex-wrap">
                      <ProviderIconEl id="microsoft" className="w-5 h-5" />
                      <h3 className="text-[14px]" style={{ fontWeight: 600 }}>
                        AD Server Token Calculator
                      </h3>
                      <span className="ml-auto text-[11px] text-[var(--muted-foreground)]">
                        {adMigrationMap.size > 0
                          ? `${displayMembers.length} DC${displayMembers.length > 1 ? 's' : ''} selected${niosXDcCount > 0 && xaasDcCount > 0 ? ` (${niosXDcCount} NIOS-X, ${xaasDcCount} XaaS)` : niosXDcCount > 0 ? ' → NIOS-X' : ' → XaaS'}`
                          : `${effectiveADMetrics.length} DC${effectiveADMetrics.length > 1 ? 's' : ''} detected`}
                      </span>
                    </div>

                    {/* Summary hero */}
                    <div className="px-4 py-4 border-b border-[var(--border)] bg-gradient-to-r from-blue-50/80 to-white">
                      <div className={`grid ${hasAnyXaas ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-1 sm:grid-cols-2'} gap-4`}>
                        <div>
                          <div className="flex items-center gap-1 text-[11px] uppercase tracking-wider text-[var(--muted-foreground)] mb-1" style={{ fontWeight: 600 }}>
                            Allocated Server Tokens
                            <FieldTooltip text="Server tokens (IB-TOKENS-UDDI-SERV-500) are needed for each NIOS-X appliance or XaaS instance based on its performance tier. This is separate from management tokens." side="top" />
                          </div>
                          <div className="text-[28px] text-blue-700" style={{ fontWeight: 700 }}>
                            {totalServerTokens.toLocaleString()}
                          </div>
                          <div className="text-[10px] text-[var(--muted-foreground)]">
                            {niosXDcCount > 0 && `${niosXTokens.toLocaleString()} NIOS-X`}
                            {niosXDcCount > 0 && xaasDcCount > 0 && ' + '}
                            {xaasDcCount > 0 && `${totalXaasTokens.toLocaleString()} XaaS`}
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] uppercase tracking-wider text-[var(--muted-foreground)] mb-1" style={{ fontWeight: 600 }}>
                            Domain Controllers
                          </div>
                          <div className="text-[22px] text-[var(--foreground)]" style={{ fontWeight: 600 }}>
                            {displayMembers.length}
                          </div>
                          <div className="text-[10px] text-[var(--muted-foreground)]">
                            {niosXDcCount > 0 && `${niosXDcCount} → NIOS-X`}
                            {niosXDcCount > 0 && xaasDcs.length > 0 && ' · '}
                            {xaasDcs.length > 0 && `${xaasDcs.length} → XaaS`}
                          </div>
                        </div>
                        {hasAnyXaas && ([
                          <div key="xaas-inst-summary">
                            <div className="text-[11px] uppercase tracking-wider text-[var(--muted-foreground)] mb-1" style={{ fontWeight: 600 }}>
                              XaaS Instances
                            </div>
                            <div className="text-[22px] text-purple-700" style={{ fontWeight: 600 }}>
                              {xaasInstances.length}
                            </div>
                            <div className="text-[10px] text-[var(--muted-foreground)]">
                              replacing {totalDcsReplaced} DC{totalDcsReplaced > 1 ? 's' : ''}
                            </div>
                          </div>,
                          <div key="xaas-consol-ratio">
                            <div className="text-[11px] uppercase tracking-wider text-[var(--muted-foreground)] mb-1" style={{ fontWeight: 600 }}>
                              Consolidation Ratio
                            </div>
                            <div className="text-[22px] text-purple-700" style={{ fontWeight: 600 }}>
                              {totalDcsReplaced}:{xaasInstances.length}
                            </div>
                            <div className="text-[10px] text-[var(--muted-foreground)]">
                              {totalDcsReplaced} DC{totalDcsReplaced > 1 ? 's' : ''} → {xaasInstances.length} XaaS instance{xaasInstances.length > 1 ? 's' : ''}
                            </div>
                          </div>
                        ])}
                      </div>
                      {hasAnyXaas && (
                        <div className="mt-3 flex flex-col gap-1.5">
                          <div className="flex items-start gap-1.5 text-[10px] text-purple-700 bg-purple-50 rounded-lg px-3 py-1.5 border border-purple-200">
                            <Info className="w-3 h-3 mt-0.5 shrink-0" />
                            <span>
                              <b>{xaasDcs.length} DC{xaasDcs.length > 1 ? 's' : ''}</b> consolidated into <b>{xaasInstances.length} XaaS instance{xaasInstances.length > 1 ? 's' : ''}</b>.
                              {' '}Each XaaS instance uses aggregate QPS/LPS/Objects to determine the T-shirt size.
                              {' '}1 connection = 1 DC replaced.
                            </span>
                          </div>
                          {xaasInstances.some(inst => inst.extraConnections > 0) && (
                            <div className="flex items-start gap-1.5 text-[10px] text-amber-700 bg-amber-50 rounded-lg px-3 py-1.5 border border-amber-200">
                              <Info className="w-3 h-3 mt-0.5 shrink-0" />
                              <span>
                                Some instances need extra connections beyond the included tier limit (+{XAAS_EXTRA_CONNECTION_COST} tokens each, up to 400 extra per instance).
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Per-DC table */}
                    <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                      <table className="w-full text-[12px]">
                        <thead className="sticky top-0 z-10">
                          <tr className="border-b border-[var(--border)] bg-gray-50">
                            <th className="text-left px-4 py-2.5" style={{ fontWeight: 600 }}>Hostname</th>
                            <th className="text-center px-3 py-2.5" style={{ fontWeight: 600 }}>Role</th>
                            <th className="text-center px-3 py-2.5" style={{ fontWeight: 600 }}>Target</th>
                            <th className="text-right px-3 py-2.5" style={{ fontWeight: 600 }}>
                              <span className="flex items-center justify-end gap-1">
                                <Activity className="w-3 h-3" /> QPS
                                <Pencil className="w-2.5 h-2.5 text-[var(--muted-foreground)]/50" />
                                <FieldTooltip text="Queries per second — DNS query rate observed on this DC. Click any cell to adjust. Used with LPS and object count to size the NIOS-X appliance tier." side="top" />
                              </span>
                            </th>
                            <th className="text-right px-3 py-2.5" style={{ fontWeight: 600 }}>
                              <span className="flex items-center justify-end gap-1">
                                <Gauge className="w-3 h-3" /> LPS
                                <Pencil className="w-2.5 h-2.5 text-[var(--muted-foreground)]/50" />
                                <FieldTooltip text="Leases per second — DHCP lease rate on this DC. Click any cell to adjust. High LPS drives appliance tier up independently of QPS." side="top" />
                              </span>
                            </th>
                            <th className="text-right px-3 py-2.5" style={{ fontWeight: 600 }}>
                              <span className="flex items-center justify-end gap-1">
                                Objects
                                <Pencil className="w-2.5 h-2.5 text-[var(--muted-foreground)]/50" />
                              </span>
                            </th>
                            <th className="text-center px-3 py-2.5" style={{ fontWeight: 600 }}>
                              <span className="flex items-center justify-center gap-1">
                                Size
                                <FieldTooltip text="NIOS-X appliance T-shirt size (2XS → XL) determined by the highest of QPS, LPS, and object thresholds. Each tier has a fixed server token cost." side="top" />
                              </span>
                            </th>
                            <th className="text-center px-3 py-2.5" style={{ fontWeight: 600 }}>
                              <span className="text-blue-700">Allocated Tokens</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {/* NIOS-X DCs — individual rows */}
                          {niosXDcs.map((dc) => {
                            const origObjCount = dc.dnsObjects + dc.dhcpObjectsWithOverhead;
                            const eff = applyADServerOverrides(dc, serverMetricOverrides);
                            const tier = calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x');
                            const renderAdEditableCell = (fieldKey: 'qps' | 'lps' | 'objects') => {
                              const isEditing = editingServerMetric?.memberId === dc.hostname && editingServerMetric?.field === fieldKey;
                              const originalValue = fieldKey === 'objects' ? origObjCount : dc[fieldKey];
                              const hasOverride = serverMetricOverrides[dc.hostname]?.[fieldKey] !== undefined;
                              const currentValue = hasOverride ? serverMetricOverrides[dc.hostname]![fieldKey]! : originalValue;
                              if (isEditing) {
                                return (
                                  <input type="number" min="0" autoFocus
                                    value={editingServerValue}
                                    onChange={(e) => setEditingServerValue(e.target.value)}
                                    onBlur={() => {
                                      const parsed = parseInt(editingServerValue, 10);
                                      if (!isNaN(parsed) && parsed >= 0 && parsed !== originalValue) {
                                        setServerMetricOverrides(prev => ({ ...prev, [dc.hostname]: { ...prev[dc.hostname], [fieldKey]: parsed } }));
                                      } else if (parsed === originalValue) {
                                        setServerMetricOverrides(prev => {
                                          const next = { ...prev };
                                          if (next[dc.hostname]) { delete next[dc.hostname][fieldKey]; if (Object.keys(next[dc.hostname]).length === 0) delete next[dc.hostname]; }
                                          return next;
                                        });
                                      }
                                      setEditingServerMetric(null);
                                    }}
                                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditingServerMetric(null); }}
                                    className="w-[90px] px-2 py-0.5 text-right text-[13px] bg-[var(--input-background)] border border-blue-400 rounded focus:outline-none focus:ring-2 focus:ring-blue-400/30 tabular-nums"
                                  />
                                );
                              }
                              return (
                                <span className="inline-flex items-center gap-1 group">
                                  <button type="button"
                                    onClick={() => { setEditingServerMetric({ memberId: dc.hostname, field: fieldKey }); setEditingServerValue(String(currentValue)); }}
                                    className="hover:text-blue-700 transition-colors inline-flex items-center gap-1 border-b border-dashed border-[var(--muted-foreground)]/30 hover:border-blue-500 pb-px"
                                    title="Click to adjust"
                                  >
                                    {currentValue > 0 ? currentValue.toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                    <Pencil className="w-3 h-3 opacity-20 group-hover:opacity-70 transition-opacity" />
                                  </button>
                                  {hasOverride && (
                                    <span className="inline-flex items-center gap-0.5">
                                      <span className="text-[10px] text-[var(--muted-foreground)] line-through" title={`Original: ${originalValue.toLocaleString()}`}>{originalValue.toLocaleString()}</span>
                                      <button type="button"
                                        onClick={() => setServerMetricOverrides(prev => {
                                          const next = { ...prev };
                                          if (next[dc.hostname]) { delete next[dc.hostname][fieldKey]; if (Object.keys(next[dc.hostname]).length === 0) delete next[dc.hostname]; }
                                          return next;
                                        })}
                                        className="text-[var(--muted-foreground)] hover:text-[var(--infoblox-orange)] transition-colors" title="Reset to original value"
                                      ><Undo2 className="w-3 h-3" /></button>
                                    </span>
                                  )}
                                </span>
                              );
                            };
                            return (
                              <tr key={dc.hostname} className="border-b border-[var(--border)] hover:bg-gray-50/50 transition-colors">
                                <td className="px-4 py-2.5">
                                  <div className="truncate max-w-[260px]" style={{ fontWeight: 500 }}>{dc.hostname}</div>
                                </td>
                                <td className="text-center px-3 py-2.5">
                                  <span className="inline-block px-2 py-0.5 rounded text-[10px] bg-blue-100 text-blue-700" style={{ fontWeight: 600 }}>
                                    DC
                                  </span>
                                </td>
                                <td className="text-center px-3 py-2.5">
                                  <span className="inline-block px-2 py-0.5 rounded text-[10px] bg-blue-100 text-blue-700" style={{ fontWeight: 600 }}>
                                    NIOS-X
                                  </span>
                                </td>
                                <td className="text-right px-3 py-2.5 tabular-nums">{renderAdEditableCell('qps')}</td>
                                <td className="text-right px-3 py-2.5 tabular-nums">{renderAdEditableCell('lps')}</td>
                                <td className="text-right px-3 py-2.5 tabular-nums">{renderAdEditableCell('objects')}</td>
                                <td className="text-center px-3 py-2.5">
                                  <span className={`inline-block px-2 py-0.5 rounded text-[10px] ${tierColorClass(tier.name)}`} style={{ fontWeight: 600 }}>
                                    {tier.name}
                                  </span>
                                </td>
                                <td className="text-center px-3 py-2.5">
                                  <span className="inline-flex items-center justify-center min-w-[36px] h-7 px-1.5 rounded-full bg-blue-100 text-blue-700 text-[12px]" style={{ fontWeight: 700 }}>
                                    {tier.serverTokens.toLocaleString()}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                          {/* XaaS consolidated instances */}
                          {xaasInstances.map((inst) => (
                            <tbody key={`ad-xaas-inst-${inst.index}`}>
                              {/* Instance header row */}
                              <tr className="bg-purple-50 border-b border-purple-200">
                                <td className="px-4 py-2 text-[11px] text-purple-800" style={{ fontWeight: 700 }} colSpan={8}>
                                  <div className="flex items-center gap-2">
                                    <span className="inline-flex items-center gap-1.5">
                                      <span className="inline-block w-2.5 h-2.5 rounded-full bg-purple-500" />
                                      XaaS Instance {xaasInstances.length > 1 ? inst.index + 1 : ''}
                                    </span>
                                    <span className="text-purple-500" style={{ fontWeight: 400 }}>—</span>
                                    <span className="text-purple-600" style={{ fontWeight: 500 }}>
                                      replaces {inst.connectionsUsed} DC{inst.connectionsUsed > 1 ? 's' : ''}
                                    </span>
                                    <span className="ml-auto flex items-center gap-2">
                                      <span className={`inline-block px-2 py-0.5 rounded text-[10px] ${tierColorClass(inst.tier.name)}`} style={{ fontWeight: 600 }}>
                                        {inst.tier.name}
                                      </span>
                                      <span className="inline-flex items-center justify-center min-w-[36px] h-6 px-1.5 rounded-full bg-purple-200 text-purple-800 text-[11px]" style={{ fontWeight: 700 }}>
                                        {inst.totalTokens.toLocaleString()}
                                      </span>
                                    </span>
                                  </div>
                                </td>
                              </tr>
                              {/* Individual DC rows within this instance */}
                              {inst.members.map((member) => (
                                <tr key={member.memberId} className="border-b border-purple-100 hover:bg-purple-50/30 transition-colors">
                                  <td className="pl-8 pr-4 py-2">
                                    <div className="truncate max-w-[240px] text-[11px] text-purple-700" style={{ fontWeight: 500 }}>{member.memberName}</div>
                                  </td>
                                  <td className="text-center px-3 py-2">
                                    <span className="inline-block px-2 py-0.5 rounded text-[10px] bg-blue-100 text-blue-700" style={{ fontWeight: 600 }}>
                                      DC
                                    </span>
                                  </td>
                                  <td className="text-center px-3 py-2">
                                    <span className="inline-block px-2 py-0.5 rounded text-[9px] bg-purple-100 text-purple-600" style={{ fontWeight: 500 }}>
                                      1 conn
                                    </span>
                                  </td>
                                  <td className="text-right px-3 py-2 tabular-nums text-[11px] text-purple-600">
                                    {member.qps > 0 ? member.qps.toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                  </td>
                                  <td className="text-right px-3 py-2 tabular-nums text-[11px] text-purple-600">
                                    {member.lps > 0 ? member.lps.toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                  </td>
                                  <td className="text-right px-3 py-2 tabular-nums text-[11px] text-purple-600">
                                    {serverSizingObjects(member) > 0 ? serverSizingObjects(member).toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                  </td>
                                  <td className="text-center px-3 py-2" colSpan={2}>
                                    <span className="text-[10px] text-gray-400">(consolidated)</span>
                                  </td>
                                </tr>
                              ))}
                              {/* Consolidated aggregate row */}
                              <tr className="border-b border-purple-300 bg-purple-50/80">
                                <td className="pl-8 pr-4 py-2 text-[11px] text-purple-800" style={{ fontWeight: 600 }}>
                                  Aggregate ({inst.connectionsUsed} connection{inst.connectionsUsed > 1 ? 's' : ''} used / {inst.tier.maxConnections} included)
                                  {inst.extraConnections > 0 && (
                                    <span className="text-amber-600 ml-1">+{inst.extraConnections} extra</span>
                                  )}
                                </td>
                                <td className="text-center px-3 py-2">
                                  <span className="inline-block px-2 py-0.5 rounded text-[10px] bg-purple-100 text-purple-700" style={{ fontWeight: 600 }}>
                                    XaaS
                                  </span>
                                </td>
                                <td className="text-center px-3 py-2 text-[10px] text-purple-700" style={{ fontWeight: 600 }}>
                                  {inst.connectionsUsed} conn
                                </td>
                                <td className="text-right px-3 py-2 tabular-nums text-purple-800" style={{ fontWeight: 600 }}>
                                  {inst.totalQps > 0 ? inst.totalQps.toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                </td>
                                <td className="text-right px-3 py-2 tabular-nums text-purple-800" style={{ fontWeight: 600 }}>
                                  {inst.totalLps > 0 ? inst.totalLps.toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                </td>
                                <td className="text-right px-3 py-2 tabular-nums text-purple-800" style={{ fontWeight: 600 }}>
                                  {inst.totalObjects > 0 ? inst.totalObjects.toLocaleString() : <span className="text-gray-300">&mdash;</span>}
                                </td>
                                <td className="text-center px-3 py-2">
                                  <span className={`inline-block px-2 py-0.5 rounded text-[10px] ${tierColorClass(inst.tier.name)}`} style={{ fontWeight: 600 }}>
                                    {inst.tier.name}
                                  </span>
                                </td>
                                <td className="text-center px-3 py-2">
                                  <span className="inline-flex items-center justify-center min-w-[36px] h-7 px-1.5 rounded-full bg-purple-200 text-purple-800 text-[12px]" style={{ fontWeight: 700 }}>
                                    {inst.totalTokens.toLocaleString()}
                                  </span>
                                  {inst.extraConnectionTokens > 0 && (
                                    <div className="text-[9px] text-amber-600 mt-0.5">
                                      incl. {inst.extraConnectionTokens.toLocaleString()} extra conn
                                    </div>
                                  )}
                                </td>
                              </tr>
                            </tbody>
                          ))}
                        <tfoot className="sticky bottom-0 z-10">
                          <tr className="bg-blue-50">
                            <td className="px-4 py-2.5 text-[12px]" style={{ fontWeight: 700 }} colSpan={7}>
                              Total Allocated Server Tokens
                              {hasAnyXaas && (
                                <span className="text-[10px] text-[var(--muted-foreground)] ml-2" style={{ fontWeight: 400 }}>
                                  ({niosXDcCount > 0 ? `${niosXDcCount} NIOS-X` : ''}{niosXDcCount > 0 && xaasInstances.length > 0 ? ' + ' : ''}{xaasInstances.length > 0 ? `${xaasInstances.length} XaaS instance${xaasInstances.length > 1 ? 's' : ''} replacing ${totalDcsReplaced} DCs` : ''})
                                </span>
                              )}
                            </td>
                            <td className="text-center px-3 py-2.5">
                              <span className="inline-flex items-center justify-center min-w-[40px] h-8 px-2 rounded-full bg-blue-600 text-white text-[14px]" style={{ fontWeight: 700 }}>
                                {totalServerTokens.toLocaleString()}
                              </span>
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                );
              })()}

              {/* Findings table */}
              <div id="section-findings" className="scroll-mt-6 bg-white rounded-xl border border-[var(--border)] mb-6 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setFindingsCollapsed(v => !v)}
                  className="w-full px-4 py-3 border-b border-[var(--border)] bg-gray-50/50 flex items-center justify-between hover:bg-gray-100/50 transition-colors"
                >
                  <h3 className="text-[14px]" style={{ fontWeight: 600 }}>
                    Detailed Findings
                    <span className="ml-2 text-[12px] font-normal text-[var(--muted-foreground)]">
                      ({findings.length} rows)
                    </span>
                  </h3>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-[var(--muted-foreground)]">
                      {findingsCollapsed ? 'Show details' : 'Hide details'}
                    </span>
                    <ChevronDown className={`w-4 h-4 text-[var(--muted-foreground)] transition-transform ${findingsCollapsed ? '' : 'rotate-180'}`} />
                  </div>
                </button>
                {!findingsCollapsed && (<>
                <div className="px-4 py-3 border-b border-[var(--border)] bg-gray-50/50 flex items-center justify-end">
                  <div className="flex items-center gap-3">
                    {Object.keys(countOverrides).length > 0 && (
                      <button
                        onClick={() => setCountOverrides({})}
                        className="text-[12px] text-amber-600 hover:underline flex items-center gap-1"
                        style={{ fontWeight: 500 }}
                      >
                        <Undo2 className="w-3 h-3" />
                        Reset {Object.keys(countOverrides).length} manual adjustment{Object.keys(countOverrides).length !== 1 ? 's' : ''}
                      </button>
                    )}
                    {(findingsProviderFilter.size > 0 || findingsCategoryFilter.size > 0) && (
                      <button
                        onClick={() => { setFindingsProviderFilter(new Set()); setFindingsCategoryFilter(new Set()); }}
                        className="text-[12px] text-[var(--infoblox-orange)] hover:underline"
                        style={{ fontWeight: 500 }}
                      >
                        Clear all filters
                      </button>
                    )}
                  </div>
                </div>
                {/* Editable counts tip — shown until first override is made */}
                {Object.keys(countOverrides).length === 0 && findings.length > 0 && (
                  <div className="px-4 py-2 bg-blue-50/60 border-b border-blue-100 flex items-center gap-2 text-[12px] text-blue-700">
                    <Pencil className="w-3.5 h-3.5 shrink-0 opacity-70" />
                    <span>Click any value in the <span style={{ fontWeight: 600 }}>Count</span> column to adjust it. Token totals recalculate instantly.</span>
                  </div>
                )}

                {/* Quick filters */}
                <div className="px-4 py-3 border-b border-[var(--border)] flex flex-col gap-2.5">
                  {/* Provider filter */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] text-[var(--muted-foreground)] uppercase tracking-wider shrink-0 w-16" style={{ fontWeight: 600 }}>
                      Provider
                    </span>
                    {selectedProviders.map((provId) => {
                      const provider = PROVIDERS.find((p) => p.id === provId)!;
                      const isActive = findingsProviderFilter.size === 0 || findingsProviderFilter.has(provId);
                      const isExplicit = findingsProviderFilter.has(provId);
                      return (
                        <button
                          key={provId}
                          onClick={() => toggleProviderFilter(provId)}
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] border transition-colors ${
                            isExplicit
                              ? 'border-[var(--infoblox-navy)] bg-[var(--infoblox-navy)] text-white'
                              : findingsProviderFilter.size === 0
                                ? 'border-[var(--border)] bg-white text-[var(--foreground)] hover:border-gray-400'
                                : 'border-[var(--border)] bg-white text-[var(--muted-foreground)] hover:border-gray-400 opacity-50'
                          }`}
                          style={{ fontWeight: isExplicit ? 600 : 400 }}
                        >
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: provider.color }}
                          />
                          {provider.name}
                          {isExplicit && (
                            <span className="text-[10px] ml-0.5 opacity-80">
                              ({findings.filter(f => f.provider === provId).length})
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {/* Category filter */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] text-[var(--muted-foreground)] uppercase tracking-wider shrink-0 w-16" style={{ fontWeight: 600 }}>
                      Category
                    </span>
                    {([
                      { key: 'DDI Object' as TokenCategory, label: 'DDI Objects', color: 'blue' },
                      { key: 'Active IP' as TokenCategory, label: 'Active IPs', color: 'purple' },
                      { key: 'Asset' as TokenCategory, label: 'Assets', color: 'green' },
                    ]).map((cat) => {
                      const isExplicit = findingsCategoryFilter.has(cat.key);
                      const colorClasses = {
                        active: {
                          blue: 'border-blue-600 bg-blue-600 text-white',
                          purple: 'border-purple-600 bg-purple-600 text-white',
                          green: 'border-green-600 bg-green-600 text-white',
                        },
                        inactive: 'border-[var(--border)] bg-white hover:border-gray-400',
                      };
                      return (
                        <button
                          key={cat.key}
                          onClick={() => toggleCategoryFilter(cat.key)}
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] border transition-colors ${
                            isExplicit
                              ? colorClasses.active[cat.color as keyof typeof colorClasses.active]
                              : `${colorClasses.inactive} ${findingsCategoryFilter.size > 0 ? 'text-[var(--muted-foreground)] opacity-50' : 'text-[var(--foreground)]'}`
                          }`}
                          style={{ fontWeight: isExplicit ? 600 : 400 }}
                        >
                          {cat.label}
                          {isExplicit && (
                            <span className="text-[10px] ml-0.5 opacity-80">
                              ({findings.filter(f => f.category === cat.key).length})
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Filter summary */}
                {(findingsProviderFilter.size > 0 || findingsCategoryFilter.size > 0) && (
                  <div className="px-4 py-2 bg-blue-50/50 border-b border-[var(--border)] text-[12px] text-[var(--muted-foreground)]">
                    Showing {filteredSortedFindings.length} of {findings.length} rows · {filteredTokenTotal.toLocaleString()} of {rawTotalTokens.toLocaleString()} tokens
                  </div>
                )}

                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="border-b border-[var(--border)] text-left text-[var(--muted-foreground)]">
                        {([
                          { col: 'provider' as SortColumn, label: 'Provider', align: 'left' },
                          { col: 'source' as SortColumn, label: 'Source', align: 'left' },
                          { col: 'category' as SortColumn, label: 'Token Category', align: 'left' },
                          { col: 'item' as SortColumn, label: 'Item', align: 'left' },
                          { col: 'count' as SortColumn, label: 'Count', align: 'right', editHint: true },
                          { col: 'managementTokens' as SortColumn, label: selectedProviders.includes('nios') ? 'NIOS Tokens' : 'Mgmt Tokens', align: 'right',
                            ...(selectedProviders.includes('nios') ? { tooltip: 'Tokens at NIOS rates (50 DDI Obj / 25 Active IPs / 13 Assets per token). Objects managed from the Infoblox Portal through NIOS.' } : {}) },
                          ...(selectedProviders.includes('nios') ? [{ col: 'uddiTokens' as SortColumn, label: 'UDDI Tokens', align: 'right',
                            tooltip: 'Tokens at Universal DDI rates (25 DDI Obj / 13 Active IPs / 3 Assets per token). Objects managed directly from the Infoblox Portal.' }] : []),
                        ] as Array<{ col: SortColumn; label: string; align: string; editHint?: boolean; tooltip?: string }>).map((header) => {
                          const isSorted = findingsSort?.col === header.col;
                          const SortIcon = isSorted
                            ? (findingsSort!.dir === 'asc' ? ArrowUp : ArrowDown)
                            : ArrowUpDown;
                          return (
                            <th
                              key={header.col}
                              className={`px-4 py-2.5 ${header.align === 'right' ? 'text-right' : ''}`}
                              style={{ fontWeight: 500 }}
                            >
                              <button
                                onClick={() => toggleFindingsSort(header.col)}
                                className={`inline-flex items-center gap-1 hover:text-[var(--foreground)] transition-colors group ${
                                  isSorted ? 'text-[var(--foreground)]' : ''
                                }`}
                              >
                                {header.label}
                                {'tooltip' in header && header.tooltip && (
                                  <span title={header.tooltip} className="inline-flex items-center ml-0.5 text-[var(--muted-foreground)] cursor-help">
                                    <HelpCircle className="w-3 h-3" />
                                  </span>
                                )}
                                {'editHint' in header && header.editHint && (
                                  <span className="inline-flex items-center gap-0.5 text-[10px] font-normal normal-case ml-0.5 text-[var(--infoblox-blue)] opacity-75">
                                    <Pencil className="w-2.5 h-2.5" />editable
                                  </span>
                                )}
                                <SortIcon className={`w-3 h-3 shrink-0 transition-opacity ${
                                  isSorted ? 'opacity-100' : 'opacity-0 group-hover:opacity-50'
                                }`} />
                              </button>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredSortedFindings.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-4 py-8 text-center text-[var(--muted-foreground)]">
                            No findings match the current filters.
                          </td>
                        </tr>
                      ) : (
                        filteredSortedFindings.map((f, i) => (
                          <tr
                            key={`${f.provider}-${f.item}-${i}`}
                            className="border-b border-[var(--border)] last:border-0 hover:bg-gray-50/50"
                          >
                            <td className="px-4 py-2.5">
                              <span
                                className="inline-block w-2 h-2 rounded-full mr-2"
                                style={{
                                  backgroundColor: PROVIDERS.find((p) => p.id === f.provider)
                                    ?.color,
                                }}
                              />
                              {PROVIDERS.find((p) => p.id === f.provider)?.name}
                              {importedProviders.has(f.provider) && !liveScannedProviders.has(f.provider) && (
                                <span className="ml-1 px-1 py-0.5 text-[10px] rounded bg-blue-50 text-blue-600 border border-blue-200 align-middle">
                                  imported
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-[var(--muted-foreground)] max-w-[200px] truncate" title={f.source}>{f.source}</td>
                            <td className="px-4 py-2.5">
                              <span
                                className={`px-2 py-0.5 rounded-full text-[11px] ${
                                  f.category === 'DDI Object'
                                    ? 'bg-blue-100 text-blue-700'
                                    : f.category === 'Active IP'
                                      ? 'bg-purple-100 text-purple-700'
                                      : 'bg-green-100 text-green-700'
                                }`}
                                style={{ fontWeight: 500 }}
                              >
                                {f.category}
                              </span>
                            </td>
                            <td className="px-4 py-2.5">{formatItemLabel(f.item)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap min-w-[80px]">
                              {(() => {
                                const key = findingKey(f);
                                const isEditing = editingFindingKey === key;
                                const hasOverride = key in countOverrides;
                                const originalCount = findings.find(
                                  (orig) => findingKey(orig) === key
                                )?.count ?? f.count;

                                if (isEditing) {
                                  return (
                                    <input
                                      type="number"
                                      min="0"
                                      autoFocus
                                      value={editingCountValue}
                                      onChange={(e) => setEditingCountValue(e.target.value)}
                                      onBlur={() => {
                                        const parsed = parseInt(editingCountValue, 10);
                                        if (!isNaN(parsed) && parsed >= 0 && parsed !== originalCount) {
                                          setCountOverrides((prev) => ({ ...prev, [key]: parsed }));
                                        } else if (parsed === originalCount) {
                                          // Reset to original — remove override
                                          setCountOverrides((prev) => {
                                            const next = { ...prev };
                                            delete next[key];
                                            return next;
                                          });
                                        }
                                        setEditingFindingKey(null);
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                        if (e.key === 'Escape') { setEditingFindingKey(null); }
                                      }}
                                      className="w-[90px] px-2 py-0.5 text-right text-[13px] bg-[var(--input-background)] border border-[var(--infoblox-blue)] rounded focus:outline-none focus:ring-2 focus:ring-[var(--infoblox-blue)]/30 tabular-nums"
                                    />
                                  );
                                }

                                return (
                                  <span className="inline-flex items-center gap-1 group">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingFindingKey(key);
                                        setEditingCountValue(String(f.count));
                                      }}
                                      className="hover:text-[var(--infoblox-blue)] transition-colors inline-flex items-center gap-1 border-b border-dashed border-[var(--muted-foreground)]/30 hover:border-[var(--infoblox-blue)] pb-px"
                                      title="Click to adjust count"
                                    >
                                      {f.count.toLocaleString()}
                                      <Pencil className="w-3 h-3 opacity-20 group-hover:opacity-70 transition-opacity" />
                                    </button>
                                    {hasOverride && (
                                      <span className="inline-flex items-center gap-0.5">
                                        <span className="text-[10px] text-[var(--muted-foreground)] line-through" title={`Original: ${originalCount.toLocaleString()}`}>
                                          {originalCount.toLocaleString()}
                                        </span>
                                        <button
                                          type="button"
                                          onClick={() => setCountOverrides((prev) => {
                                            const next = { ...prev };
                                            delete next[key];
                                            return next;
                                          })}
                                          className="text-[var(--muted-foreground)] hover:text-[var(--infoblox-orange)] transition-colors"
                                          title="Reset to original value"
                                        >
                                          <Undo2 className="w-3 h-3" />
                                        </button>
                                      </span>
                                    )}
                                  </span>
                                );
                              })()}
                            </td>
                            <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap min-w-[100px]" style={{ fontWeight: 600 }}>
                              {f.managementTokens.toLocaleString()}
                            </td>
                            {selectedProviders.includes('nios') && (
                              <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap min-w-[100px] text-[var(--infoblox-orange)]" style={{ fontWeight: 600 }}>
                                {Math.ceil(f.count / TOKEN_RATES[f.category as TokenCategory]).toLocaleString()}
                              </td>
                            )}
                          </tr>
                        ))
                      )}
                      <tr className="bg-gray-50">
                        <td
                          colSpan={5}
                          className="px-4 py-3 text-right"
                          style={{ fontWeight: 600 }}
                        >
                          {(findingsProviderFilter.size > 0 || findingsCategoryFilter.size > 0)
                            ? 'Filtered Total'
                            : 'Total'
                          }
                        </td>
                        <td
                          className="px-4 py-3 text-right"
                          style={{ fontWeight: 700 }}
                        >
                          {(findingsProviderFilter.size > 0 || findingsCategoryFilter.size > 0)
                            ? filteredTokenTotal.toLocaleString()
                            : rawTotalTokens.toLocaleString()
                          }
                        </td>
                        {selectedProviders.includes('nios') && (
                          <td
                            className="px-4 py-3 text-right text-[var(--infoblox-orange)]"
                            style={{ fontWeight: 700 }}
                          >
                            {uddiPerRowTotal.toLocaleString()}
                          </td>
                        )}
                      </tr>
                    </tbody>
                  </table>
                </div>
                </>)}
              </div>

              {/* Export buttons */}
              <div id="section-export" className="scroll-mt-6 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                <button
                  onClick={exportCSV}
                  className="flex items-center justify-center gap-2 px-5 py-3 bg-[var(--infoblox-navy)] text-white rounded-xl hover:bg-[var(--infoblox-navy)]/90 transition-colors"
                  style={{ fontWeight: 500 }}
                >
                  <Download className="w-4 h-4" />
                  Download CSV
                </button>
                <button
                  onClick={downloadXlsxFromBackend}
                  className="flex items-center justify-center gap-2 px-5 py-3 bg-[var(--infoblox-green)] text-white rounded-xl hover:bg-[var(--infoblox-green)]/90 transition-colors"
                  style={{ fontWeight: 500 }}
                >
                  <FileSpreadsheet className="w-4 h-4" />
                  Download XLSX
                </button>
                <button
                  onClick={saveSession}
                  className="flex items-center justify-center gap-2 px-5 py-3 bg-[var(--infoblox-navy)] text-white rounded-xl hover:bg-[var(--infoblox-navy)]/90 transition-colors opacity-80"
                  style={{ fontWeight: 500 }}
                >
                  <Download className="w-4 h-4" />
                  Save Session
                </button>
                {isEstimatorOnly && (
                  <button
                    onClick={() => setCurrentStep('credentials')}
                    className="flex items-center justify-center gap-2 px-5 py-3 bg-white border border-[var(--border)] text-[var(--foreground)] rounded-xl hover:bg-gray-50 transition-colors"
                    style={{ fontWeight: 500 }}
                  >
                    <ChevronLeft className="w-4 h-4" />
                    Back to Estimator
                  </button>
                )}
                <ImportConfirmDialog
                  findings={findings}
                  niosServerMetrics={niosServerMetrics}
                  adServerMetrics={adServerMetrics}
                  existing={loadPersisted() ?? initialSizerState()}
                  onConfirm={handleSizerImportConfirm}
                >
                  <button
                    disabled={findings.length === 0}
                    data-testid="sizer-import-trigger"
                    className="flex items-center justify-center gap-2 px-5 py-3 bg-white border border-[var(--border)] text-[var(--foreground)] rounded-xl hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ fontWeight: 500 }}
                  >
                    <Workflow className="w-4 h-4" />
                    Use as Sizer Input
                  </button>
                </ImportConfirmDialog>
                <button
                  onClick={restart}
                  className="flex items-center justify-center gap-2 px-5 py-3 bg-white border border-[var(--border)] text-[var(--foreground)] rounded-xl hover:bg-gray-50 transition-colors"
                  style={{ fontWeight: 500 }}
                >
                  <RotateCcw className="w-4 h-4" />
                  Start Over
                </button>
              </div>

          </div>
          <OutlineNav
            sections={outlineSections}
            expandHandlers={outlineExpandHandlers}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Sizer-mode surface (Phase 33 Plan 05 — Option b) ─────────────────────────
//
// Pure-Sizer flow has no scan-side migration data and renders only the three
// universal sections — Overview / Token Breakdown / Export. Composes the
// Plan 01-03 sub-components (ResultsHero / ResultsBom / ResultsExportBar)
// rather than the lifted scan JSX above.
//
// D-07: NIOS migration / AD migration / member details / findings table all
//       intentionally absent in this branch.
// D-11: Sizer reporting + security totals fold into BOM rows (handled inside
//       ResultsBom via `mode='sizer'` + `securityTokens > 0`).
// D-15: Start Over wired through `onReset` — caller (sizer-step-results.tsx)
//       owns sessionStorage clearing + reducer dispatch.

type SizerSurfaceInternalProps = SizerDerivedResultsProps & {
  overrides: ResultsOverrides;
  onExport: () => void | Promise<void>;
  exportLabel?: string;
  onReset?: () => void;
  resetCopy?: {
    title: string;
    description: string;
    cancel: string;
    confirm: string;
  };
  onDownloadCSV?: () => void | Promise<void>;
  onSaveSession?: () => void | Promise<void>;
  // ─── Phase 34 Plan 06 — Wave 4 wiring (REQ-01..REQ-05) ────────────────────
  regions: Region[];
  niosxMembers: NiosServerMetrics[];
  onSiteEdit: (siteId: string, patch: Partial<Site>) => void;
  onMemberTierChange: (memberId: string, tier: ServerFormFactor) => void;
  niosxSystems: NiosXSystemSlim[];
  mgmtOverhead: number;
};

function SizerResultsSurface(props: SizerSurfaceInternalProps) {
  const {
    totalManagementTokens,
    totalServerTokens,
    reportingTokens,
    securityTokens,
    hasServerMetrics,
    hybridScenario,
    growthBufferPct,
    serverGrowthBufferPct,
    effectiveFindings,
    selectedProviders,
    overrides,
    onExport,
    exportLabel,
    onReset,
    resetCopy,
    onDownloadCSV,
    onSaveSession,
    regions,
    niosxMembers,
    onSiteEdit,
    onMemberTierChange,
    niosxSystems,
    mgmtOverhead,
  } = props;

  // Hero collapsed: Sizer has no expand-on-arrival lifecycle, so the surface
  // owns the toggle locally. Default expanded so the SE sees the totals.
  const [heroCollapsed, setHeroCollapsed] = useState(false);

  // Sizer growth-buffer setters are no-ops in this surface — the inputs in
  // the BOM card are read-only mirrors of state.globalSettings.growthBuffer
  // for v1. Editing flows through Sizer Step 4 settings.
  const noopSetGrowthBuffer = useCallback((_next: number) => {
    /* read-only in Sizer mode v1 */
  }, []);

  // ─── Phase 34 Plan 06 — Sizer-side migration-planner local UI state ────────
  // The shared <ResultsMigrationPlanner /> + <ResultsMemberDetails /> were
  // designed for the scan flow where wizard.tsx owns this state. In Sizer
  // mode the canonical tier assignment lives in `state.core.infrastructure.niosx`
  // (via UPDATE_NIOSX). The local map below is a presentation mirror that
  // is rebuilt from `niosxMembers` on every render so the planner UI stays
  // visually consistent with Sizer state.
  const niosMigrationMap = useMemo(() => {
    const m = new Map<string, ServerFormFactor>();
    for (const n of niosxMembers) {
      // Skip infra-only GM/GMC — replaced by UDDI Portal, not selectable for
      // NIOS-X migration. Planner's denominator (`niosSources`) excludes them
      // via isInfraOnlyMember(); keeping them here would yield "N+1 of N
      // marked for migration" (issue #20).
      if (isInfraOnlyMember(n)) continue;
      const ff: ServerFormFactor = n.platform === 'XaaS' ? 'nios-xaas' : 'nios-x';
      m.set(n.memberName, ff);
    }
    return m;
  }, [niosxMembers]);

  // setNiosMigrationMap is a write-through bridge: every change is forwarded
  // to the Sizer reducer via onMemberTierChange, then we re-derive on next
  // render. We still expose the React.SetStateAction signature so the planner
  // can call setNiosMigrationMap(prev => next) without modification.
  const setNiosMigrationMap = useCallback(
    (next:
      | Map<string, ServerFormFactor>
      | ((prev: Map<string, ServerFormFactor>) => Map<string, ServerFormFactor>),
    ) => {
      const resolved = typeof next === 'function' ? next(niosMigrationMap) : next;
      const idByName = new Map(niosxMembers.map((m) => [m.memberName, m.memberId] as const));
      // Diff resolved against current and dispatch only changes.
      for (const [name, ff] of resolved.entries()) {
        if (niosMigrationMap.get(name) !== ff) {
          const id = idByName.get(name);
          if (id) onMemberTierChange(id, ff);
        }
      }
    },
    [niosMigrationMap, niosxMembers, onMemberTierChange],
  );

  // Member-search / collapsible-chrome / server-metric-edit local state.
  // Sizer doesn't persist these (no equivalent in Sizer reducer); they're
  // ephemeral per-page UI state.
  const [memberSearchFilter, setMemberSearchFilter] = useState('');
  const [showGridMemberDetails, setShowGridMemberDetails] = useState(true);
  const [gridMemberDetailSearch, setGridMemberDetailSearch] = useState('');
  const [editingServerMetric, setEditingServerMetric] = useState<
    { memberId: string; field: 'qps' | 'lps' | 'objects' } | null
  >(null);
  const [editingServerValue, setEditingServerValue] = useState('');
  const [gridFeaturesOpen, setGridFeaturesOpen] = useState(false);
  const [migrationFlagsOpen, setMigrationFlagsOpen] = useState(false);

  // Token divisors for the breakdown roll-up. ActiveIP uses the canonical
  // MGMT_RATES.activeIP (= 13) — the only metric that maps 1:1 to mgmt tokens
  // in Sizer's calc model. Users / QPS / LPS aren't separately divisible at
  // the management level (users feed activeIPs via CALC_HEURISTICS upstream;
  // QPS/LPS feed reporting-rate math, not per-row token contribution). They
  // pass as 0 → contribute 0 to the per-row token column, keeping the row
  // total aligned with Sizer mgmt-token semantics.
  const tokensPerActiveIP = MGMT_RATES.activeIP;
  const tokensPerUser = 0;
  const tokensPerQps = 0;
  const tokensPerLps = 0;

  const hasNiosx = niosxMembers.length > 0;

  // Issue #6 — Sizer-mode mgmt-token scenarios for the migration planner.
  // Scan-mode planner derives scenarios from `effectiveFindings`; in Sizer
  // mode that array is empty, collapsing all three cards to 0. Compute the
  // scenarios from Sizer state instead so the planner reflects the same
  // mgmt totals shown in the hero card.
  const sizerMgmtScenarios = useMemo(
    () =>
      computeSizerMgmtScenarios(
        niosxSystems,
        regions,
        mgmtOverhead,
        new Set(niosMigrationMap.keys()),
      ),
    [niosxSystems, regions, mgmtOverhead, niosMigrationMap],
  );

  // OutlineNav order per D-12. Sections appear only when their data renders
  // (mirrors scan-mode dynamic-outline rule).
  const sizerOutlineSections = useMemo(() => {
    const out: Array<{ id: string; label: string }> = [
      { id: 'section-overview', label: 'Overview' },
      { id: 'section-breakdown', label: 'Breakdown by Region' },
      { id: 'section-bom', label: 'Bill of Materials' },
    ];
    if (hasNiosx) {
      // Sizer manual path: Migration Planner is omitted (no legacy NIOS to
      // migrate from — user-defined NIOS-X/XaaS systems ARE the target).
      out.push(
        { id: 'section-member-details', label: 'NIOS-X Details' },
        { id: 'section-resource-savings', label: 'Resource Savings' },
      );
    }
    out.push({ id: 'section-export', label: 'Export' });
    return out;
  }, [hasNiosx]);

  // Sizer mode does not pre-compute findings or fleet/member resource savings
  // (the v1 Sizer report does not surface savings — D-deferred); the lifted
  // shared components consume empty arrays gracefully.
  // selectedProviders is forced to ['nios'] inside the planner subtree so the
  // shared planner short-circuit (`!includes('nios') → null`) doesn't hide
  // the section in Sizer mode.
  const planExtraSelected = useMemo(
    () => (hasNiosx ? ['nios'] : selectedProviders),
    [hasNiosx, selectedProviders],
  );

  // Empty FleetSavings stand-in — Sizer v1 doesn't surface fleet-wide
  // resource-savings deltas. Shape mirrors `FleetSavings` from
  // `../resource-savings.ts` so the lifted shared components type-check.
  const emptyFleetSavings: FleetSavings = useMemo(
    () => ({
      memberCount: 0,
      totalOldVCPU: 0,
      totalOldRamGB: 0,
      totalNewVCPU: 0,
      totalNewRamGB: 0,
      totalDeltaVCPU: 0,
      totalDeltaRamGB: 0,
      niosXSavings: { vCPU: 0, ramGB: 0, memberCount: 0 },
      xaasSavings: { vCPU: 0, ramGB: 0, memberCount: 0 },
      physicalUnitsRetired: 0,
      unknownModels: [],
      invalidCombinations: [],
    }),
    [],
  );

  return (
    <div className="bg-[var(--background)] min-h-[600px] py-6">
      <div className="max-w-[1200px] xl:max-w-[1404px] mx-auto px-6 flex items-start">
        <div className="flex-1 min-w-0 flex flex-col gap-6">
        <ResultsHero
          totalManagementTokens={totalManagementTokens}
          totalServerTokens={totalServerTokens}
          hasServerMetrics={hasServerMetrics}
          hybridScenario={hybridScenario ?? null}
          growthBufferPct={growthBufferPct}
          serverGrowthBufferPct={serverGrowthBufferPct}
          effectiveFindings={effectiveFindings}
          selectedProviders={selectedProviders}
          // Issue #9 — feed Sizer NIOS-X members into the hero's "By Source —
          // Server" block so it renders real per-member rows instead of the
          // contradictory "No server metrics available." message.
          effectiveNiosMetrics={niosxMembers}
          countOverrides={overrides.countOverrides}
          serverMetricOverrides={overrides.serverMetricOverrides}
          adMigrationMap={overrides.adMigrationMap}
          heroCollapsed={heroCollapsed}
          setHeroCollapsed={setHeroCollapsed}
        />

        <ResultsBreakdown
          mode="sizer"
          regions={regions}
          tokensPerActiveIP={tokensPerActiveIP}
          tokensPerUser={tokensPerUser}
          tokensPerQps={tokensPerQps}
          tokensPerLps={tokensPerLps}
          onSiteEdit={onSiteEdit}
        />

        <ResultsBom
          mode="sizer"
          totalManagementTokens={totalManagementTokens}
          totalServerTokens={totalServerTokens}
          reportingTokens={reportingTokens}
          securityTokens={securityTokens}
          hasServerMetrics={hasServerMetrics}
          growthBufferPct={growthBufferPct}
          serverGrowthBufferPct={serverGrowthBufferPct}
          setGrowthBufferPct={noopSetGrowthBuffer}
          setServerGrowthBufferPct={noopSetGrowthBuffer}
        />

        {hasNiosx && (
          <>
            {/* Sizer manual path: NIOS-X/XaaS systems are user-defined and
                already represent the target configuration. The Migration
                Planner (Current/Hybrid/Full scenarios) does not apply — drop
                it and mount NIOS-X Details directly. */}
            <ResultsMemberDetails
              mode="sizer"
              members={niosxMembers}
              effectiveFindings={[]}
              niosMigrationMap={niosMigrationMap}
              serverMetricOverrides={{}}
              memberSavings={[]}
              setVariantOverrides={() => {}}
              fleetSavings={emptyFleetSavings}
              showGridMemberDetails={showGridMemberDetails}
              setShowGridMemberDetails={setShowGridMemberDetails}
              gridMemberDetailSearch={gridMemberDetailSearch}
              setGridMemberDetailSearch={setGridMemberDetailSearch}
            />

            <ResultsResourceSavings
              mode="sizer"
              savings={[]}
              onVariantChange={() => {}}
            />
          </>
        )}

        <ResultsExportBar
          mode="sizer"
          onExport={onExport}
          exportLabel={exportLabel}
          onReset={onReset}
          resetCopy={resetCopy}
          onDownloadCSV={onDownloadCSV}
          onSaveSession={onSaveSession}
        />
        </div>
        <OutlineNav sections={sizerOutlineSections} />
      </div>
    </div>
  );
}
