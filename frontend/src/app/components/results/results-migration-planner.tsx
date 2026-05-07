// results-migration-planner.tsx — shared NIOS Migration Planner sub-component.
//
// Phase 34 Plan 01 — D-03/D-04/D-05 lift-first contract:
//   * pure presentation, props in / callbacks out
//   * NO useSizer, NO scan-store hooks
//   * `mode` is a passive label only (used downstream by data-testid scopes /
//     analytics) — no visual branching inside this file
//
// Lifted verbatim from `results-surface.tsx` (~line 1216, the section under
// `id="section-migration-planner"`). Future plans (Phase 34 Plan 02..04)
// will further carve `ResultsMemberDetails` / Server Token Calculator /
// Migration Flags out of this file. For Plan 01 the lift remains a single
// shared component so REQ-07 (scan-mode byte-identical) is provable in one
// step.
import { Fragment, useMemo, useState, type Dispatch, type ReactElement, type SetStateAction } from 'react';
import {
  Activity,
  ArrowRightLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Gauge,
  HelpCircle,
  Info,
  Minus,
  Pencil,
  Search,
  Undo2,
  X,
} from 'lucide-react';

import {
  calcServerTokenTier,
  calcUddiTokensAggregated,
  calcNiosTokens,
  consolidateXaasInstances,
  XAAS_EXTRA_CONNECTION_COST,
  NIOS_GRID_LOGO,
} from '../mock-data';
import type {
  FindingRow,
  FleetSavings,
  MemberSavings,
  NiosServerMetrics,
  ResultsMode,
  ServerFormFactor,
  ServerMetricOverride,
} from './results-types';
import type {
  NiosGridFeaturesAPI,
  NiosGridLicensesAPI,
  NiosMigrationFlagsAPI,
} from '../api-client';
import { Input } from '../ui/input';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';
import { PlatformBadge } from '../ui/platform-badge';
import { ResourceSavingsTile } from '../resource-savings-tile';
import { ResultsMemberDetails } from './results-member-details';

// ─── Local helpers (duplicated from results-surface.tsx so this file is
// self-contained — D-05 pure-presentation rule). Tiny enough that
// duplication is cheaper than threading a shared utils module right now;
// Plan 02 may collapse them once Member Details lifts too.

function serverSizingObjects(m: NiosServerMetrics): number {
  return m.objectCount + (m.activeIPCount ?? 0);
}

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

function isInfraOnlyMember(m: NiosServerMetrics): boolean {
  return (m.role === 'GM' || m.role === 'GMC') &&
    m.qps === 0 && m.lps === 0 && m.objectCount === 0 && (m.activeIPCount ?? 0) === 0;
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

// ─── Public prop contract ───────────────────────────────────────────────────
//
// D-05: passive `mode` label, props in, callbacks out. The public API is
// deliberately broad — it mirrors the closure variables the lifted JSX
// previously read from its enclosing scope. Phase 34 Plan 02..05 will narrow
// the surface as more sub-components carve out.

export interface ResultsMigrationPlannerProps {
  /** Passive label — used by analytics / parent data-testid scopes. */
  mode: ResultsMode;
  /** Selected provider ids — planner only renders when 'nios' is in the list. */
  selectedProviders: string[];

  // Source data
  members: NiosServerMetrics[];
  findings: FindingRow[];
  effectiveFindings: FindingRow[];
  fleetSavings: FleetSavings;
  memberSavings: MemberSavings[];

  // Growth + savings
  growthBufferPct: number;

  // Migration map (per-member tier assignment)
  niosMigrationMap: Map<string, ServerFormFactor>;
  setNiosMigrationMap: Dispatch<SetStateAction<Map<string, ServerFormFactor>>>;

  // Resource-savings variant overrides
  setVariantOverrides: Dispatch<SetStateAction<Map<string, number>>>;

  // Server-metric override editing (QPS/LPS/objects per member)
  serverMetricOverrides: Record<string, ServerMetricOverride>;
  setServerMetricOverrides: (
    next: Record<string, ServerMetricOverride> | ((prev: Record<string, ServerMetricOverride>) => Record<string, ServerMetricOverride>),
  ) => void;
  editingServerMetric: { memberId: string; field: 'qps' | 'lps' | 'objects' } | null;
  setEditingServerMetric: (v: { memberId: string; field: 'qps' | 'lps' | 'objects' } | null) => void;
  editingServerValue: string;
  setEditingServerValue: (v: string) => void;

  // Search filters
  memberSearchFilter: string;
  setMemberSearchFilter: (v: string) => void;
  showGridMemberDetails: boolean;
  setShowGridMemberDetails: (v: boolean) => void;
  gridMemberDetailSearch: string;
  setGridMemberDetailSearch: (v: string) => void;

  // Grid features / licenses / migration flags (NIOS Grid backup metadata)
  niosGridFeatures: NiosGridFeaturesAPI | null;
  niosGridLicenses: NiosGridLicensesAPI | null;
  niosMigrationFlags: NiosMigrationFlagsAPI | null;
  gridFeaturesOpen: boolean;
  setGridFeaturesOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  migrationFlagsOpen: boolean;
  setMigrationFlagsOpen: (v: boolean | ((prev: boolean) => boolean)) => void;

  /**
   * Tier-change observer. Fired alongside the underlying
   * `setNiosMigrationMap` dispatch so callers (Sizer adapter) can mirror
   * the change into Sizer state. Receives `(memberId, newTier)`.
   * The default behavior of mutating `niosMigrationMap` is preserved
   * regardless of whether this callback is supplied.
   */
  onTierChange?: (memberId: string, tier: ServerFormFactor) => void;

  /**
   * Issue #6 — caller-supplied management-token scenario primaries. When
   * provided, override the scan-mode formula (which sums per-source
   * `findings.managementTokens`). Used by Sizer mode where there is no
   * findings stream — values come from Sizer state via
   * `computeSizerMgmtScenarios()` so the planner stays consistent with
   * the hero `Total Management Tokens` card. Growth buffer is applied on
   * top, matching the scan-mode `applyGrowth(...)` step.
   */
  mgmtScenarioValues?: { current: number; hybrid: number; full: number };
}

export function ResultsMigrationPlanner(props: ResultsMigrationPlannerProps): ReactElement | null {
  const {
    mode,
    selectedProviders,
    members: effectiveNiosMetrics,
    findings,
    effectiveFindings,
    fleetSavings,
    memberSavings,
    growthBufferPct,
    niosMigrationMap,
    setNiosMigrationMap,
    setVariantOverrides,
    serverMetricOverrides,
    setServerMetricOverrides,
    editingServerMetric,
    setEditingServerMetric,
    editingServerValue,
    setEditingServerValue,
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
    onTierChange,
    mgmtScenarioValues,
  } = props;

  // Issue #23 — client-side filters for Migration Flags tables. Free-text
  // match across network, member, option number, option name, type, flag.
  const [dhcpFlagFilter, setDhcpFlagFilter] = useState('');
  const [hostRouteFilter, setHostRouteFilter] = useState('');

  const filteredDhcpOptions = useMemo(() => {
    const all = niosMigrationFlags?.dhcpOptions ?? [];
    const q = dhcpFlagFilter.trim().toLowerCase();
    if (!q) return all;
    return all.filter((o) => {
      const flagLabel = o.flag === 'VALIDATION_NEEDED' ? 'validation needed' : 'check guardrails';
      return (
        o.network.toLowerCase().includes(q) ||
        String(o.optionNumber).includes(q) ||
        o.optionName.toLowerCase().includes(q) ||
        o.optionType.toLowerCase().includes(q) ||
        o.member.toLowerCase().includes(q) ||
        flagLabel.includes(q)
      );
    });
  }, [niosMigrationFlags?.dhcpOptions, dhcpFlagFilter]);

  const filteredHostRoutes = useMemo(() => {
    const all = niosMigrationFlags?.hostRoutes ?? [];
    const q = hostRouteFilter.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) => r.network.toLowerCase().includes(q) || r.member.toLowerCase().includes(q));
  }, [niosMigrationFlags?.hostRoutes, hostRouteFilter]);

  // Don't render anything when NIOS isn't selected OR there are no members
  // and no NIOS findings. Empty state matches scan-mode behavior — section is
  // simply absent from the surface.
  if (!selectedProviders.includes('nios')) return null;
  const hasNiosFindings = findings.some((f) => f.provider === 'nios');
  if (effectiveNiosMetrics.length === 0 && !hasNiosFindings) return null;

  // ── Begin lifted IIFE body ─────────────────────────────────────────────
  // Collect unique NIOS sources (grid members).
  // Include all members from server metrics — members with zero DDI
  // objects still need migration targets (e.g., secondary DNS, reporting).
  const findingsSources = new Set(
    findings.filter((f) => f.provider === 'nios').map((f) => f.source)
  );
  const allNiosSources = Array.from(
    new Set([
      ...findingsSources,
      ...effectiveNiosMetrics.map((m) => m.memberName),
    ])
  );

  // Separate infrastructure-only GM/GMC (no DNS/DHCP workload) from migrateable members.
  // Infra-only members are replaced by UDDI Portal — not selectable for NIOS-X migration.
  const metricsByName = new Map(effectiveNiosMetrics.map(m => [m.memberName, m]));
  const infraOnlySources = allNiosSources.filter(s => {
    const m = metricsByName.get(s);
    return m ? isInfraOnlyMember(m) : false;
  });
  const niosSources = allNiosSources.filter(s => !infraOnlySources.includes(s));

  const toggleMigration = (source: string) => {
    setNiosMigrationMap((prev) => {
      const next = new Map(prev);
      if (next.has(source)) {
        next.delete(source);
      } else {
        next.set(source, 'nios-x');
        onTierChange?.(source, 'nios-x');
      }
      return next;
    });
  };

  const setMemberFormFactor = (source: string, ff: ServerFormFactor) => {
    setNiosMigrationMap((prev) => {
      const next = new Map(prev);
      next.set(source, ff);
      return next;
    });
    onTierChange?.(source, ff);
  };

  // Filter sources by search term
  const metricBySource = new Map(effectiveNiosMetrics.map(m => [m.memberName, m]));

  const filteredSources = memberSearchFilter
    ? niosSources.filter(s => s.toLowerCase().includes(memberSearchFilter.toLowerCase()))
    : niosSources;

  // Issue #19: Hide QPS / LPS spans on the planner row when no member in
  // the fleet reports them (e.g. NIOS backup uploaded without a companion
  // Splunk QPS XML). Avoids 4/8 metrics being "—" everywhere.
  const fleetHasAnyQps = effectiveNiosMetrics.some((m) => (m.qps ?? 0) > 0);
  const fleetHasAnyLps = effectiveNiosMetrics.some((m) => (m.lps ?? 0) > 0);

  const toggleAllMigration = () => {
    const targets = memberSearchFilter ? filteredSources : niosSources;
    const allTargetsMigrated = targets.every(s => niosMigrationMap.has(s));
    if (allTargetsMigrated) {
      setNiosMigrationMap(prev => {
        const next = new Map(prev);
        targets.forEach(s => next.delete(s));
        return next;
      });
    } else {
      setNiosMigrationMap(prev => {
        const next = new Map(prev);
        targets.forEach(s => next.set(s, next.get(s) || 'nios-x'));
        return next;
      });
    }
  };

  // Compute tokens by scenario
  const niosFindings = effectiveFindings.filter((f) => f.provider === 'nios');
  // Use aggregate-then-divide (sum counts per category, single ceiling division)
  // to match the hero card's methodology and avoid rounding inflation.
  const nonNiosFindings = effectiveFindings.filter((f) => f.provider !== 'nios');
  const nonNiosTokens = calcUddiTokensAggregated(nonNiosFindings);
  // NIOS Licensing column uses NIOS ratios (50/25/13), not UDDI ratios
  const allNiosTokens = calcNiosTokens(niosFindings);
  // UDDI tokens for all NIOS findings (used in Full Migration scenario) — native rates
  const allNiosUddiTokens = calcUddiTokensAggregated(niosFindings);

  const stayingFindings = niosFindings.filter((f) => !niosMigrationMap.has(f.source));
  const stayingTokens = calcNiosTokens(stayingFindings);
  // Migrating tokens use UDDI native rates (they move to UDDI licensing)
  const migratingFindings = niosFindings.filter((f) => niosMigrationMap.has(f.source));
  const migratingTokens = calcUddiTokensAggregated(migratingFindings);

  const niosXCount = Array.from(niosMigrationMap.values()).filter(v => v === 'nios-x').length;
  const xaasCount = Array.from(niosMigrationMap.values()).filter(v => v === 'nios-xaas').length;
  const hybridDesc = niosMigrationMap.size > 0
    ? `${niosMigrationMap.size} of ${niosSources.length} members migrated${niosXCount > 0 && xaasCount > 0 ? ` (${niosXCount} NIOS-X, ${xaasCount} XaaS)` : niosXCount > 0 ? ' to NIOS-X' : ' to XaaS'}. Remaining stay on NIOS licensing.`
    : `Select members to migrate. Remaining stay on NIOS licensing.`;
  // Suppress unused warnings for variables retained for parity with future
  // plan extractions (Server Token Calculator scenario visualizations).
  void allNiosTokens;

  return (
    <div data-testid="results-migration-planner" id="section-migration-planner" className="scroll-mt-6 bg-white rounded-xl border-2 border-[var(--infoblox-blue)]/30 mb-6 overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--border)] bg-blue-50/50 flex items-center gap-2">
        <img src={NIOS_GRID_LOGO} alt="NIOS Grid" className="w-5 h-5 rounded" />
        <ArrowRightLeft className="w-4 h-4 text-[var(--infoblox-blue)]" />
        <h3 className="text-[14px]" style={{ fontWeight: 600 }}>
          NIOS-X Migration Planner
        </h3>
        <span className="ml-auto text-[11px] text-[var(--muted-foreground)]">
          Select grid members &amp; target form factor
        </span>
      </div>

      {/* Member selector */}
      <div className="px-4 py-3 border-b border-[var(--border)]">
        {/* Search filter */}
        <div className="relative mb-2">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
          <input
            type="text"
            placeholder="Filter members..."
            value={memberSearchFilter}
            onChange={(e) => setMemberSearchFilter(e.target.value)}
            className="w-full pl-8 pr-3 py-2 text-[12px] rounded-lg border border-[var(--border)] focus:outline-none focus:ring-1 focus:ring-[var(--infoblox-blue)] focus:border-[var(--infoblox-blue)]"
          />
        </div>
        <div className="flex items-center gap-2 mb-3">
          <button
            onClick={toggleAllMigration}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] border border-[var(--border)] hover:bg-gray-50 transition-colors"
            style={{ fontWeight: 500 }}
          >
            {(() => {
              const targets = memberSearchFilter ? filteredSources : niosSources;
              const allTargetsMigrated = targets.length > 0 && targets.every(s => niosMigrationMap.has(s));
              const someTargetsMigrated = targets.some(s => niosMigrationMap.has(s));
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
            {memberSearchFilter
              ? `${filteredSources.length} of ${niosSources.length} members`
              : `${niosMigrationMap.size} of ${niosSources.length} members marked for migration`}
            {niosMigrationMap.size > 0 && !memberSearchFilter && (() => {
              const nx = Array.from(niosMigrationMap.values()).filter(v => v === 'nios-x').length;
              const xs = Array.from(niosMigrationMap.values()).filter(v => v === 'nios-xaas').length;
              if (nx > 0 && xs > 0) return ` (${nx} NIOS-X, ${xs} XaaS)`;
              if (xs > 0) return ` (${xs} XaaS)`;
              return ` (${nx} NIOS-X)`;
            })()}
          </span>
        </div>
        <div className="max-h-[320px] overflow-y-auto border-t border-b border-gray-100">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 py-1">
          {filteredSources.map((source) => {
            const isMigrating = niosMigrationMap.has(source);
            const memberFF = niosMigrationMap.get(source) || 'nios-x';
            const sourceTokens = niosFindings.filter((f) => f.source === source).reduce((s, f) => s + f.managementTokens, 0);
            const memberMetric = effectiveNiosMetrics.find(m => m.memberName === source);
            const memberMetrics = memberMetric; // alias for per-member metrics display
            const memberRole = memberMetric?.role || '';
            // Derive service capabilities from the role string
            const serviceBadges: { label: string; bg: string; text: string }[] = [];
            if (memberRole === 'GM' || memberRole === 'GMC') {
              serviceBadges.push({ label: memberRole, bg: 'bg-slate-700', text: 'text-white' });
            }
            if (memberRole === 'DNS' || memberRole === 'DNS/DHCP' || memberRole === 'GM' || memberRole === 'GMC') {
              serviceBadges.push({ label: 'DNS', bg: 'bg-blue-100', text: 'text-blue-700' });
            }
            if (memberRole === 'DHCP' || memberRole === 'DNS/DHCP' || memberRole === 'GM' || memberRole === 'GMC') {
              serviceBadges.push({ label: 'DHCP', bg: 'bg-cyan-100', text: 'text-cyan-700' });
            }
            if (memberRole === 'IPAM') {
              serviceBadges.push({ label: 'IPAM', bg: 'bg-lime-100', text: 'text-lime-700' });
            }
            if (memberRole === 'Reporting') {
              serviceBadges.push({ label: 'Reporting', bg: 'bg-gray-100', text: 'text-gray-600' });
            }
            void serviceBadges;
            return (
              <div
                key={source}
                className={`flex flex-col rounded-lg transition-colors ${
                  isMigrating
                    ? memberFF === 'nios-xaas'
                      ? 'bg-purple-50 border border-purple-200'
                      : 'bg-blue-50 border border-blue-200'
                    : 'border border-[var(--border)] hover:bg-gray-50'
                }`}
              >
              <div className="flex items-center gap-2.5 px-3 py-2">
                <button
                  onClick={() => toggleMigration(source)}
                  className="flex items-center gap-0 shrink-0"
                >
                  <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                    isMigrating
                      ? memberFF === 'nios-xaas'
                        ? 'bg-purple-600 border-purple-600'
                        : 'bg-[var(--infoblox-blue)] border-[var(--infoblox-blue)]'
                      : 'border-gray-300'
                  }`}>
                    {isMigrating && <Check className="w-3 h-3 text-white" />}
                  </div>
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 text-[12px] truncate" style={{ fontWeight: 500 }}>
                    {source}
                    {(() => {
                      const metric = metricBySource.get(source);
                      if (!metric) return null;
                      return (
                        <>
                          {(metric.role === 'GM' || metric.role === 'GMC') && (
                            <span
                              className="inline-block px-1.5 py-0.5 rounded text-[9px] text-white shrink-0"
                              style={{ fontWeight: 600, backgroundColor: metric.role === 'GM' ? '#002B49' : '#1a4a6e' }}
                            >
                              {metric.role}
                            </span>
                          )}
                          {metric.model && (
                            <span className="text-[10px] text-gray-400 font-normal">({metric.model})</span>
                          )}
                          {metric.platform && (
                            <PlatformBadge platform={metric.platform as any} className="ml-0.5">
                              {metric.platform}
                            </PlatformBadge>
                          )}
                        </>
                      );
                    })()}
                  </div>
                  <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                    <span className="text-[10px] text-[var(--muted-foreground)]">{sourceTokens.toLocaleString()} tokens</span>
                  </div>
                </div>
                {isMigrating && (
                  <div className="flex items-center bg-white rounded-md border border-gray-200 p-0.5 shrink-0">
                    <button
                      onClick={() => setMemberFormFactor(source, 'nios-x')}
                      className={`px-2 py-0.5 rounded text-[9px] transition-all ${
                        memberFF === 'nios-x'
                          ? 'bg-[var(--infoblox-navy)] text-white shadow-sm'
                          : 'text-gray-400 hover:text-gray-600'
                      }`}
                      style={{ fontWeight: 600 }}
                    >
                      NIOS-X
                    </button>
                    <button
                      onClick={() => setMemberFormFactor(source, 'nios-xaas')}
                      className={`px-2 py-0.5 rounded text-[9px] transition-all ${
                        memberFF === 'nios-xaas'
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
              {memberMetrics && (() => {
                // Issue #19: passive/replicant members report 0 across every
                // workload metric; render a single explanatory line instead
                // of four "—" placeholders.
                const rowIsPassive =
                  (memberMetrics.objectCount ?? 0) === 0 &&
                  (memberMetrics.activeIPCount ?? 0) === 0 &&
                  (memberMetrics.qps ?? 0) === 0 &&
                  (memberMetrics.lps ?? 0) === 0;
                return (
                <div className="flex items-center gap-3 px-3 pb-2 pt-0.5 text-[10px] text-[var(--muted-foreground)] flex-wrap">
                  {memberMetrics.role && (
                    <span className="inline-block px-1.5 py-0.5 rounded text-[9px] text-white" style={{ fontWeight: 600, backgroundColor: (({ GM: '#1e40af', GMC: '#6366f1', DNS: '#0ea5e9', DHCP: '#8b5cf6', 'DNS/DHCP': '#7c3aed', IPAM: '#059669', Reporting: '#d97706' }) as Record<string, string>)[memberMetrics.role] || '#666' }}>
                      {memberMetrics.role}
                    </span>
                  )}
                  {rowIsPassive ? (
                    <span className="italic">No workload metrics reported in NIOS backup (passive / replicant member).</span>
                  ) : (
                    <>
                      <span title="DDI Objects">DDI: {memberMetrics.objectCount > 0 ? memberMetrics.objectCount.toLocaleString() : '—'}</span>
                      <span className="text-gray-300">|</span>
                      <span title="Active IPs (DHCP leases)">Active IPs: {memberMetrics.activeIPCount > 0 ? memberMetrics.activeIPCount.toLocaleString() : '—'}</span>
                      {fleetHasAnyQps && (
                        <>
                          <span className="text-gray-300">|</span>
                          <span title="Queries per second">QPS: {memberMetrics.qps > 0 ? memberMetrics.qps.toLocaleString() : '—'}</span>
                        </>
                      )}
                      {fleetHasAnyLps && (
                        <>
                          <span className="text-gray-300">|</span>
                          <span title="Leases per second">LPS: {memberMetrics.lps > 0 ? memberMetrics.lps.toLocaleString() : '—'}</span>
                        </>
                      )}
                    </>
                  )}
                </div>
                );
              })()}
              </div>
            );
          })}
        </div>
        </div>

        {/* Infrastructure members — GM/GMC without DNS/DHCP workload */}
        {infraOnlySources.length > 0 && (
          <div className="mt-3 px-1">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-1 h-4 rounded-full bg-slate-400" />
              <span className="text-[11px] text-slate-600 uppercase tracking-wider" style={{ fontWeight: 600 }}>
                Infrastructure ({infraOnlySources.length})
              </span>
              <span className="text-[10px] text-slate-400">
                Replaced by UDDI Portal — no NIOS-X licensing needed
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {infraOnlySources.map((source) => {
                const m = metricsByName.get(source);
                return (
                  <div
                    key={source}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-slate-200 bg-slate-50/50"
                  >
                    <div className="w-5 h-5 rounded border-2 border-slate-300 flex items-center justify-center shrink-0 bg-slate-100">
                      <span className="text-[8px] text-slate-400">&mdash;</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[12px] truncate text-slate-500" style={{ fontWeight: 500 }}>{source}</span>
                        {m && (
                          <span
                            className="inline-block px-1.5 py-0.5 rounded text-[9px] text-white shrink-0"
                            style={{ fontWeight: 600, backgroundColor: m.role === 'GM' ? '#002B49' : '#1a4a6e' }}
                          >
                            {m.role}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-400 italic">
                        Replaced by UDDI Portal
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Scenario comparison cards */}
      {(() => {
        const niosIsActive = (idx: number) =>
          idx === 0 ? niosMigrationMap.size === 0
          : idx === 1 ? niosMigrationMap.size > 0 && niosMigrationMap.size < niosSources.length
          : niosMigrationMap.size === niosSources.length;

        // Management Token scenarios — apply growth buffer for consistency
        // with the hero Total Management Tokens card (which includes buffer).
        const applyGrowth = (v: number) => Math.ceil(v * (1 + growthBufferPct));
        // Issue #6 — Sizer override: caller pre-computes scenario primaries
        // from Sizer state (no findings stream available). The growth buffer
        // is already baked into Sizer's `mgmtOverhead` upstream, so we render
        // the supplied values verbatim and skip the additional applyGrowth.
        // Sizer manual path: drop "Current (NIOS Only)" and "Hybrid" — there
        // is no legacy NIOS baseline to compare against, the user-defined
        // NIOS-X/XaaS systems ARE the target. Only "Full Universal DDI" applies.
        const mgmtScenariosAll: ScenarioCard[] = mgmtScenarioValues
          ? [
              {
                label: 'Current (NIOS Only)',
                primaryValue: mgmtScenarioValues.current,
                desc: 'Only cloud/MS sources need UDDI tokens. NIOS stays on traditional licensing.',
              },
              {
                label: 'Hybrid',
                primaryValue: mgmtScenarioValues.hybrid,
                desc: hybridDesc,
              },
              {
                label: 'Full Universal DDI',
                primaryValue: mgmtScenarioValues.full,
                desc: 'All NIOS members migrated to Universal DDI. Everything on Universal DDI licensing.',
              },
            ]
          : [
          {
            label: 'Current (NIOS Only)',
            primaryValue: applyGrowth(nonNiosTokens),
            desc: 'Only cloud/MS sources need UDDI tokens. NIOS stays on traditional licensing.',
          },
          {
            label: 'Hybrid',
            primaryValue: applyGrowth(nonNiosTokens + migratingTokens) + stayingTokens,
            subLines: stayingTokens > 0 ? [
              { text: `${applyGrowth(nonNiosTokens + migratingTokens).toLocaleString()} on NIOS-X / Universal DDI`, color: '#0078d4' },
              { text: `${stayingTokens.toLocaleString()} on NIOS Licensing`, color: '#6b7280' },
            ] : [],
            desc: hybridDesc,
          },
          {
            label: 'Full Universal DDI',
            primaryValue: applyGrowth(nonNiosTokens + allNiosUddiTokens),
            desc: 'All NIOS members migrated to Universal DDI. Everything on Universal DDI licensing.',
          },
        ];
        const mgmtScenarios: ScenarioCard[] = mode === 'sizer'
          ? mgmtScenariosAll.filter((s) => s.label === 'Full Universal DDI')
          : mgmtScenariosAll;

        // Server Token scenarios — compute per-scenario using migration map
        const calcNiosServerScenario = (members: NiosServerMetrics[]) => {
          const niosXMems = members.filter(m => (niosMigrationMap.get(m.memberName) || 'nios-x') !== 'nios-xaas');
          const xaasMems  = members.filter(m => niosMigrationMap.get(m.memberName) === 'nios-xaas');
          const nxTok = niosXMems.reduce((s, m) => {
            const eff = applyServerOverrides(m, serverMetricOverrides);
            return s + calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x').serverTokens;
          }, 0);
          const xaasInst = consolidateXaasInstances(xaasMems.map(m => {
            const eff = applyServerOverrides(m, serverMetricOverrides);
            return eff.qps !== m.qps || eff.lps !== m.lps || eff.objects !== serverSizingObjects(m)
              ? { ...m, qps: eff.qps, lps: eff.lps, objectCount: eff.objects, activeIPCount: 0 }
              : m;
          }));
          return nxTok + xaasInst.reduce((s, inst) => s + inst.totalTokens, 0);
        };
        // Full: all members → NIOS-X baseline (exclude infra-only GM/GMC — replaced by UDDI Portal)
        const migrateableMetrics = effectiveNiosMetrics.filter(m => !isInfraOnlyMember(m));
        const fullSrvTokens = migrateableMetrics.reduce((s, m) => {
          const eff = applyServerOverrides(m, serverMetricOverrides);
          return s + calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x').serverTokens;
        }, 0);
        const hybridSrvTokens = migrateableMetrics.filter(m => niosMigrationMap.has(m.memberName)).length > 0
          ? calcNiosServerScenario(migrateableMetrics.filter(m => niosMigrationMap.has(m.memberName)))
          : 0;

        const srvScenariosAll: ScenarioCard[] = [
          { label: 'Current (NIOS Only)', primaryValue: 0,               desc: 'NIOS stays on traditional licensing. No NIOS-X server tokens required.' },
          { label: 'Hybrid',              primaryValue: hybridSrvTokens,  desc: hybridDesc },
          { label: 'Full Universal DDI',  primaryValue: fullSrvTokens,    desc: 'All members migrated. Server tokens cover every NIOS-X appliance or XaaS instance.' },
        ];
        const srvScenarios: ScenarioCard[] = mode === 'sizer'
          ? srvScenariosAll.filter((s) => s.label === 'Full Universal DDI')
          : srvScenariosAll;

        return (
          <>
            <ScenarioPlannerCards
              title="Management Tokens"
              unit="Universal DDI Tokens"
              color="orange"
              scenarios={mgmtScenarios}
              isActive={niosIsActive}
            />
            {effectiveNiosMetrics.length > 0 && (
              <ScenarioPlannerCards
                title="Server Tokens"
                unit="Server Tokens (IB-TOKENS-UDDI-SERV-500)"
                color="blue"
                scenarios={srvScenarios}
                isActive={niosIsActive}
              />
            )}
            {/* Resource Footprint Reduction tile — RES-06.
                Hidden in Sizer mode: greenfield sizing has no "old" appliance
                to compare against, so the tile would always render the
                misleading "No data — verify member configuration" copy
                (issue #13). Sizer v1 defers fleet-savings surfacing — see
                results-surface.tsx SizerResultsSurface comment. */}
            {mode !== 'sizer' && (
              <div className="px-4 pb-3">
                <ResourceSavingsTile fleet={fleetSavings} />
              </div>
            )}
          </>
        );
      })()}

      {/* Server Token Calculator — inline within Migration Planner */}
      {effectiveNiosMetrics.length > 0 && (() => {
        // Only show metrics for members selected for migration.
        // Exclude infrastructure-only GM/GMC (replaced by UDDI Portal, no NIOS-X licensing).
        const migratingMembers = effectiveNiosMetrics.filter((m) =>
          niosMigrationMap.has(m.memberName) && !isInfraOnlyMember(m)
        );
        // Show all grid members from server metrics — every member needs
        // a migration target even if it has zero DDI objects (e.g. secondary
        // DNS servers, reporting members). Exclude infra-only GM/GMC
        // (replaced by UDDI Portal, no NIOS-X licensing).
        const allMembers = effectiveNiosMetrics.filter((m) => !isInfraOnlyMember(m));

        const displayMembers = migratingMembers.length > 0 ? migratingMembers : allMembers;

        // Per-member form factor helper
        const getMemberFF = (memberName: string): ServerFormFactor =>
          niosMigrationMap.get(memberName) || 'nios-x';

        const hasAnyXaas = displayMembers.some((m) => getMemberFF(m.memberName) === 'nios-xaas');
        const xaasMembers = displayMembers.filter((m) => getMemberFF(m.memberName) === 'nios-xaas');
        const niosXMembers = displayMembers.filter((m) => getMemberFF(m.memberName) === 'nios-x');
        const niosXMemberCount = niosXMembers.length;
        const xaasMemberCount = xaasMembers.length;

        // Consolidate XaaS members into instances (1 instance can replace many NIOS members)
        const xaasInstances = consolidateXaasInstances(xaasMembers.map(m => {
          const eff = applyServerOverrides(m, serverMetricOverrides);
          return eff.qps !== m.qps || eff.lps !== m.lps || eff.objects !== serverSizingObjects(m)
            ? { ...m, qps: eff.qps, lps: eff.lps, objectCount: eff.objects, activeIPCount: 0 }
            : m;
        }));
        const totalXaasTokens = xaasInstances.reduce((s, inst) => s + inst.totalTokens, 0);

        // NIOS-X tokens (individual per member)
        const niosXTokens = niosXMembers.reduce((sum, m) => {
          const eff = applyServerOverrides(m, serverMetricOverrides);
          return sum + calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x').serverTokens;
        }, 0);

        const totalServerTokens = niosXTokens + totalXaasTokens;
        const totalNiosReplaced = xaasMembers.length; // 1 connection per NIOS member replaced

        const roleColors: Record<string, string> = {
          GM: '#002B49',
          GMC: '#1a4a6e',
          DNS: '#0078d4',
          DHCP: '#00a5e5',
          'DNS/DHCP': '#005a9e',
          IPAM: '#7fba00',
          Reporting: '#8b8b8b',
        };

        const tierColorClass = (name: string) =>
          name === 'XL' ? 'bg-red-100 text-red-700' :
          name === 'L' ? 'bg-orange-100 text-orange-700' :
          name === 'M' ? 'bg-yellow-100 text-yellow-700' :
          name === 'S' ? 'bg-green-100 text-green-700' :
          name === 'XS' ? 'bg-sky-100 text-sky-700' :
          'bg-gray-100 text-gray-700';

        return (
          <div id="section-server-tokens" className="scroll-mt-6 border-t border-emerald-200 bg-emerald-50/20">
            <div className="px-4 py-3 border-b border-emerald-200 bg-emerald-50/50 flex items-center gap-2 flex-wrap">
        <img src={NIOS_GRID_LOGO} alt="NIOS Grid" className="w-5 h-5 rounded" />
        <h3 className="text-[14px]" style={{ fontWeight: 600 }}>
          Server Token Calculator
        </h3>

        <span className="ml-auto text-[11px] text-[var(--muted-foreground)]">
          {migratingMembers.length > 0
            ? `${migratingMembers.length} member${migratingMembers.length > 1 ? 's' : ''} selected${niosXMemberCount > 0 && xaasMemberCount > 0 ? ` (${niosXMemberCount} NIOS-X, ${xaasMemberCount} XaaS)` : niosXMemberCount > 0 ? ' → NIOS-X' : ' → XaaS'}`
            : `${allMembers.length} grid member${allMembers.length > 1 ? 's' : ''} detected`}
        </span>
      </div>

      {/* Summary hero */}
      <div className="px-4 py-4 border-b border-[var(--border)] bg-gradient-to-r from-emerald-50/80 to-white">
        <div className={`grid ${hasAnyXaas ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-1 sm:grid-cols-2'} gap-4`}>
          <div>
            <div className="flex items-center gap-1 text-[11px] uppercase tracking-wider text-[var(--muted-foreground)] mb-1" style={{ fontWeight: 600 }}>
              Allocated Server Tokens
              <FieldTooltip text="Server tokens (IB-TOKENS-UDDI-SERV-500) are needed for each NIOS-X appliance or XaaS instance based on its performance tier. This is separate from management tokens." side="top" />
            </div>
            <div className="text-[28px] text-emerald-700" style={{ fontWeight: 700 }}>
              {totalServerTokens.toLocaleString()}
            </div>
            <div className="text-[10px] text-[var(--muted-foreground)]">
              {niosXMemberCount > 0 && `${niosXTokens.toLocaleString()} NIOS-X`}
              {niosXMemberCount > 0 && xaasMemberCount > 0 && ' + '}
              {xaasMemberCount > 0 && `${totalXaasTokens.toLocaleString()} XaaS`}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-[var(--muted-foreground)] mb-1" style={{ fontWeight: 600 }}>
              {mode === 'sizer' ? 'NIOS-X/XaaS' : 'NIOS Members'}
            </div>
            <div className="text-[22px] text-[var(--foreground)]" style={{ fontWeight: 600 }}>
              {displayMembers.length}
            </div>
            <div className="text-[10px] text-[var(--muted-foreground)]">
              {niosXMemberCount > 0 && `${niosXMemberCount} → NIOS-X`}
              {niosXMemberCount > 0 && xaasMembers.length > 0 && ' · '}
              {xaasMembers.length > 0 && `${xaasMembers.length} → XaaS`}
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
                  replacing {totalNiosReplaced} NIOS member{totalNiosReplaced > 1 ? 's' : ''}
                </div>
              </div>,
              <div key="xaas-consol-ratio">
                <div className="text-[11px] uppercase tracking-wider text-[var(--muted-foreground)] mb-1" style={{ fontWeight: 600 }}>
                  Consolidation Ratio
                </div>
                <div className="text-[22px] text-purple-700" style={{ fontWeight: 600 }}>
                  {totalNiosReplaced}:{xaasInstances.length}
                </div>
                <div className="text-[10px] text-[var(--muted-foreground)]">
                  {totalNiosReplaced} NIOS → {xaasInstances.length} XaaS instance{xaasInstances.length > 1 ? 's' : ''}
                </div>
              </div>
          ])}
        </div>
        {hasAnyXaas && (
          <div className="mt-3 flex flex-col gap-1.5">
            <div className="flex items-start gap-1.5 text-[10px] text-purple-700 bg-purple-50 rounded-lg px-3 py-1.5 border border-purple-200">
              <Info className="w-3 h-3 mt-0.5 shrink-0" />
              <span>
                <b>{xaasMembers.length} NIOS member{xaasMembers.length > 1 ? 's' : ''}</b> consolidated into <b>{xaasInstances.length} XaaS instance{xaasInstances.length > 1 ? 's' : ''}</b>.
                {' '}Each XaaS instance uses aggregate QPS/LPS/Objects to determine the T-shirt size.
                {' '}1 connection = 1 NIOS member replaced.
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

      {/* Per-member table */}
      <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
        <table className="w-full text-[12px]">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-[var(--border)] bg-gray-50">
              <th className="text-left px-4 py-2.5" style={{ fontWeight: 600 }}>Grid Member</th>
              <th className="text-center px-3 py-2.5" style={{ fontWeight: 600 }}>Role</th>
              <th className="text-center px-3 py-2.5" style={{ fontWeight: 600 }}>Target</th>
              <th className="text-right px-3 py-2.5" style={{ fontWeight: 600 }}>
                <span className="flex items-center justify-end gap-1">
                  <Activity className="w-3 h-3" /> QPS
                  <Pencil className="w-2.5 h-2.5 text-[var(--muted-foreground)]/50" />
                  <FieldTooltip text="Queries per second — DNS query rate observed on this member. Click any cell to adjust. Used with LPS and object count to size the NIOS-X appliance tier." side="top" />
                </span>
              </th>
              <th className="text-right px-3 py-2.5" style={{ fontWeight: 600 }}>
                <span className="flex items-center justify-end gap-1">
                  <Gauge className="w-3 h-3" /> LPS
                  <Pencil className="w-2.5 h-2.5 text-[var(--muted-foreground)]/50" />
                  <FieldTooltip text="Leases per second — DHCP lease rate. Click any cell to adjust. High LPS drives appliance tier up independently of QPS." side="top" />
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
                <span className="text-emerald-700">Allocated Tokens</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {/* NIOS-X members — individual rows */}
            {niosXMembers.map((member) => {
              const eff = applyServerOverrides(member, serverMetricOverrides);
              const tier = calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x');
              const renderEditableCell = (fieldKey: 'qps' | 'lps' | 'objects') => {
                const isEditing = editingServerMetric?.memberId === member.memberId && editingServerMetric?.field === fieldKey;
                const originalValue = fieldKey === 'objects' ? serverSizingObjects(member) : member[fieldKey];
                const hasOverride = serverMetricOverrides[member.memberId]?.[fieldKey] !== undefined;
                const currentValue = hasOverride ? serverMetricOverrides[member.memberId]![fieldKey]! : originalValue;
                if (isEditing) {
                  return (
                    <input type="number" min="0" autoFocus
                      value={editingServerValue}
                      onChange={(e) => setEditingServerValue(e.target.value)}
                      onBlur={() => {
                        const parsed = parseInt(editingServerValue, 10);
                        if (!isNaN(parsed) && parsed >= 0 && parsed !== originalValue) {
                          setServerMetricOverrides(prev => ({ ...prev, [member.memberId]: { ...prev[member.memberId], [fieldKey]: parsed } }));
                        } else if (parsed === originalValue) {
                          setServerMetricOverrides(prev => {
                            const next = { ...prev };
                            if (next[member.memberId]) { delete next[member.memberId][fieldKey]; if (Object.keys(next[member.memberId]).length === 0) delete next[member.memberId]; }
                            return next;
                          });
                        }
                        setEditingServerMetric(null);
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditingServerMetric(null); }}
                      className="w-[90px] px-2 py-0.5 text-right text-[13px] bg-[var(--input-background)] border border-[var(--infoblox-blue)] rounded focus:outline-none focus:ring-2 focus:ring-[var(--infoblox-blue)]/30 tabular-nums"
                    />
                  );
                }
                return (
                  <span className="inline-flex items-center gap-1 group">
                    <button type="button"
                      onClick={() => { setEditingServerMetric({ memberId: member.memberId, field: fieldKey }); setEditingServerValue(String(currentValue)); }}
                      className="hover:text-[var(--infoblox-blue)] transition-colors inline-flex items-center gap-1 border-b border-dashed border-[var(--muted-foreground)]/30 hover:border-[var(--infoblox-blue)] pb-px"
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
                            if (next[member.memberId]) { delete next[member.memberId][fieldKey]; if (Object.keys(next[member.memberId]).length === 0) delete next[member.memberId]; }
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
                <Fragment key={member.memberId}>
                <tr className="border-b border-[var(--border)] hover:bg-gray-50/50 transition-colors">
                  <td className="px-4 py-2.5">
                    <div className="truncate max-w-[260px]" style={{ fontWeight: 500 }}>
                      {member.memberName}
                    </div>
                  </td>
                  <td className="text-center px-3 py-2.5">
                    <span
                      className="inline-block px-2 py-0.5 rounded text-[10px] text-white"
                      style={{ fontWeight: 600, backgroundColor: roleColors[member.role] || '#666' }}
                    >
                      {member.role}
                    </span>
                  </td>
                  <td className="text-center px-3 py-2.5">
                    <span className="inline-block px-2 py-0.5 rounded text-[10px] bg-blue-100 text-blue-700" style={{ fontWeight: 600 }}>
                      NIOS-X
                    </span>
                  </td>
                  <td className="text-right px-3 py-2.5 tabular-nums">{renderEditableCell('qps')}</td>
                  <td className="text-right px-3 py-2.5 tabular-nums">{renderEditableCell('lps')}</td>
                  <td className="text-right px-3 py-2.5 tabular-nums">{renderEditableCell('objects')}</td>
                  <td className="text-center px-3 py-2.5">
                    <span className="inline-flex items-center gap-1 justify-center">
                      <span className={`inline-block px-2 py-0.5 rounded text-[10px] ${tierColorClass(tier.name)}`} style={{ fontWeight: 600 }}>
                        {tier.name}
                      </span>
                      {/* Issue #22: zero-workload members default to the
                          smallest tier; surface that explicitly so SEs do not
                          read the badge as observed sizing. */}
                      {eff.qps === 0 && eff.lps === 0 && eff.objects === 0 && (
                        <span
                          className="inline-flex items-center gap-0.5 italic text-[9px] text-amber-700"
                          style={{ fontWeight: 500 }}
                        >
                          fallback
                          <FieldTooltip
                            text={`No QPS / LPS / object metrics observed for this member; size defaults to the smallest tier (${tier.name}, ${tier.serverTokens} tokens). Common for passive, reporter, or otherwise low-signal members. Adjust QPS / LPS / Objects to override.`}
                            side="top"
                          />
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="text-center px-3 py-2.5">
                    <span className="inline-flex items-center justify-center min-w-[36px] h-7 px-1.5 rounded-full bg-emerald-100 text-emerald-700 text-[12px]" style={{ fontWeight: 700 }}>
                      {tier.serverTokens.toLocaleString()}
                    </span>
                  </td>
                </tr>
                </Fragment>
              );
            })}

          </tbody>
            {/* XaaS consolidated instances */}
            {xaasInstances.map((inst) => (
              <tbody key={`xaas-inst-${inst.index}`}>
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
                        replaces {inst.connectionsUsed} NIOS member{inst.connectionsUsed > 1 ? 's' : ''}
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
                {/* Individual member rows within this instance */}
                {inst.members.map((member) => {
                  // Find the original un-overridden member for edit UI
                  const origMember = xaasMembers.find(m => m.memberId === member.memberId) || member;
                  const renderXaasEditableCell = (fieldKey: 'qps' | 'lps' | 'objects') => {
                    const isEditing = editingServerMetric?.memberId === member.memberId && editingServerMetric?.field === fieldKey;
                    const originalValue = fieldKey === 'objects' ? serverSizingObjects(origMember) : origMember[fieldKey];
                    const hasOverride = serverMetricOverrides[member.memberId]?.[fieldKey] !== undefined;
                    const currentValue = hasOverride ? serverMetricOverrides[member.memberId]![fieldKey]! : originalValue;
                    if (isEditing) {
                      return (
                        <input type="number" min="0" autoFocus
                          value={editingServerValue}
                          onChange={(e) => setEditingServerValue(e.target.value)}
                          onBlur={() => {
                            const parsed = parseInt(editingServerValue, 10);
                            if (!isNaN(parsed) && parsed >= 0 && parsed !== originalValue) {
                              setServerMetricOverrides(prev => ({ ...prev, [member.memberId]: { ...prev[member.memberId], [fieldKey]: parsed } }));
                            } else if (parsed === originalValue) {
                              setServerMetricOverrides(prev => {
                                const next = { ...prev };
                                if (next[member.memberId]) { delete next[member.memberId][fieldKey]; if (Object.keys(next[member.memberId]).length === 0) delete next[member.memberId]; }
                                return next;
                              });
                            }
                            setEditingServerMetric(null);
                          }}
                          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditingServerMetric(null); }}
                          className="w-[90px] px-2 py-0.5 text-right text-[13px] bg-[var(--input-background)] border border-purple-400 rounded focus:outline-none focus:ring-2 focus:ring-purple-400/30 tabular-nums"
                        />
                      );
                    }
                    return (
                      <span className="inline-flex items-center gap-1 group">
                        <button type="button"
                          onClick={() => { setEditingServerMetric({ memberId: member.memberId, field: fieldKey }); setEditingServerValue(String(currentValue)); }}
                          className="hover:text-purple-700 transition-colors inline-flex items-center gap-1 border-b border-dashed border-purple-300/50 hover:border-purple-500 pb-px"
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
                                if (next[member.memberId]) { delete next[member.memberId][fieldKey]; if (Object.keys(next[member.memberId]).length === 0) delete next[member.memberId]; }
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
                  <tr key={member.memberId} className="border-b border-purple-100 hover:bg-purple-50/30 transition-colors">
                    <td className="pl-8 pr-4 py-2">
                      <div className="truncate max-w-[240px] text-[11px] text-purple-700" style={{ fontWeight: 500 }}>
                        {member.memberName}
                      </div>
                    </td>
                    <td className="text-center px-3 py-2">
                      <span
                        className="inline-block px-2 py-0.5 rounded text-[10px] text-white"
                        style={{ fontWeight: 600, backgroundColor: roleColors[member.role] || '#666' }}
                      >
                        {member.role}
                      </span>
                    </td>
                    <td className="text-center px-3 py-2">
                      <span className="inline-block px-2 py-0.5 rounded text-[9px] bg-purple-100 text-purple-600" style={{ fontWeight: 500 }}>
                        1 conn
                      </span>
                    </td>
                    <td className="text-right px-3 py-2 tabular-nums text-[11px] text-purple-600">{renderXaasEditableCell('qps')}</td>
                    <td className="text-right px-3 py-2 tabular-nums text-[11px] text-purple-600">{renderXaasEditableCell('lps')}</td>
                    <td className="text-right px-3 py-2 tabular-nums text-[11px] text-purple-600">{renderXaasEditableCell('objects')}</td>
                    <td className="text-center px-3 py-2" colSpan={2}>
                      <span className="text-[10px] text-gray-400">(consolidated)</span>
                    </td>
                  </tr>
                  );
                })}
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
            <tr className="bg-emerald-50">
              <td className="px-4 py-2.5 text-[12px]" style={{ fontWeight: 700 }} colSpan={7}>
                Total Allocated Server Tokens
                {hasAnyXaas && (
                  <span className="text-[10px] text-[var(--muted-foreground)] ml-2" style={{ fontWeight: 400 }}>
                    ({niosXMemberCount > 0 ? `${niosXMemberCount} NIOS-X` : ''}{niosXMemberCount > 0 && xaasInstances.length > 0 ? ' + ' : ''}{xaasInstances.length > 0 ? `${xaasInstances.length} XaaS instance${xaasInstances.length > 1 ? 's' : ''} replacing ${totalNiosReplaced} members` : ''})
                  </span>
                )}
              </td>
              <td className="text-center px-3 py-2.5">
                <span className="inline-flex items-center justify-center min-w-[40px] h-8 px-2 rounded-full bg-emerald-600 text-white text-[14px]" style={{ fontWeight: 700 }}>
                  {totalServerTokens.toLocaleString()}
                </span>
              </td>
            </tr>
          </tfoot>
        </table>
        {Object.keys(serverMetricOverrides).length > 0 && (
          <div className="px-4 py-2 border-t border-emerald-200 bg-emerald-50/30 flex items-center justify-between">
            <span className="text-[11px] text-[var(--muted-foreground)]">
              {Object.keys(serverMetricOverrides).length} member{Object.keys(serverMetricOverrides).length > 1 ? 's' : ''} with manual adjustments
            </span>
            <button
              type="button"
              onClick={() => { setServerMetricOverrides({}); setEditingServerMetric(null); }}
              className="text-[11px] text-[var(--infoblox-orange)] hover:text-orange-700 transition-colors flex items-center gap-1"
              style={{ fontWeight: 500 }}
            >
              <Undo2 className="w-3 h-3" /> Reset all server overrides
            </button>
          </div>
        )}
      </div>

      {/* Grid Features & Licenses checklist — collapsed by default */}
      {niosGridFeatures && (() => {
        const featuresOpen = gridFeaturesOpen;
        const setFeaturesOpen = setGridFeaturesOpen;
        const featureItems: { label: string; enabled: boolean }[] = [
          { label: 'DNAME Records', enabled: niosGridFeatures.dnameRecords },
          { label: 'DNS Anycast', enabled: niosGridFeatures.dnsAnycast },
          { label: 'Captive Portal', enabled: niosGridFeatures.captivePortal },
          { label: 'DHCPv6', enabled: niosGridFeatures.dhcpv6 },
          { label: 'NTP Server', enabled: niosGridFeatures.ntpServer },
          { label: 'Data Connector', enabled: niosGridFeatures.dataConnector },
        ];
        return (
          <div className="px-4 py-2 border-b border-[var(--border)] bg-blue-50/30">
            <button
              onClick={() => setFeaturesOpen(!featuresOpen)}
              className="flex items-center gap-1.5 text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              style={{ fontWeight: 600 }}
            >
              {featuresOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              Grid Features &amp; Licenses
            </button>
            {featuresOpen && (
              <div className="mt-2 space-y-2">
                <div className="flex flex-wrap gap-2">
                  {featureItems.map(f => (
                    <span
                      key={f.label}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] ${
                        f.enabled
                          ? 'bg-green-100 text-green-700'
                          : 'bg-gray-100 text-gray-400'
                      }`}
                      style={{ fontWeight: 500 }}
                    >
                      {f.enabled
                        ? <Check className="w-3 h-3" />
                        : <X className="w-3 h-3" />}
                      {f.label}
                    </span>
                  ))}
                </div>
                {niosGridLicenses && niosGridLicenses.types.length > 0 && (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] text-[var(--muted-foreground)]" style={{ fontWeight: 600 }}>Grid Licenses:</span>
                    {niosGridLicenses.types.map(lic => (
                      <span key={lic} className="inline-block px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 text-[10px]" style={{ fontWeight: 500 }}>
                        {lic}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Grid Member Details — lifted to shared <ResultsMemberDetails /> in
          Phase 34 Plan 02. Caller passes `displayMembers` (already filtered
          to migrating-or-all members, infra-only excluded) — preserves
          scan-mode rendering byte-for-byte (REQ-07). Forwards `mode` so
          Sizer mode mounts a single section (issue #14 dedup). */}
      <ResultsMemberDetails
        mode={mode}
        members={displayMembers}
        effectiveFindings={effectiveFindings}
        niosMigrationMap={niosMigrationMap}
        serverMetricOverrides={serverMetricOverrides}
        memberSavings={memberSavings}
        setVariantOverrides={setVariantOverrides}
        fleetSavings={fleetSavings}
        showGridMemberDetails={showGridMemberDetails}
        setShowGridMemberDetails={setShowGridMemberDetails}
        gridMemberDetailSearch={gridMemberDetailSearch}
        setGridMemberDetailSearch={setGridMemberDetailSearch}
      />


          </div>
        );
      })()}

      {/* Migration Flags — DHCP options and host routes requiring manual attention */}
      {niosMigrationFlags && ((niosMigrationFlags.dhcpOptions?.length ?? 0) > 0 || (niosMigrationFlags.hostRoutes?.length ?? 0) > 0) && (
        <div className="border-t border-amber-200 bg-amber-50/20">
          <button
            type="button"
            onClick={() => setMigrationFlagsOpen(!migrationFlagsOpen)}
            className="w-full px-4 py-3 flex items-center gap-2 hover:bg-amber-50/50 transition-colors text-left"
          >
            {migrationFlagsOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <h3 className="text-[14px]" style={{ fontWeight: 600 }}>
              Migration Flags
            </h3>
            <span className="text-[11px] text-[var(--muted-foreground)]">
              ({(niosMigrationFlags.dhcpOptions?.length ?? 0)} DHCP option{(niosMigrationFlags.dhcpOptions?.length ?? 0) !== 1 ? 's' : ''}, {(niosMigrationFlags.hostRoutes?.length ?? 0)} host route{(niosMigrationFlags.hostRoutes?.length ?? 0) !== 1 ? 's' : ''})
            </span>
          </button>

          {migrationFlagsOpen && (
            <div className="px-4 pb-4 space-y-4">
              {/* DHCP Options Table */}
              {(niosMigrationFlags.dhcpOptions?.length ?? 0) > 0 && (
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <h4 className="text-[12px] text-[var(--muted-foreground)]" style={{ fontWeight: 600 }}>
                      DHCP Options
                      <span className="ml-2 text-[11px]" style={{ fontWeight: 400 }}>
                        {dhcpFlagFilter.trim()
                          ? `${filteredDhcpOptions.length} of ${niosMigrationFlags.dhcpOptions!.length}`
                          : `${niosMigrationFlags.dhcpOptions!.length} total`}
                      </span>
                    </h4>
                    <div className="relative w-64">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--muted-foreground)]" />
                      <Input
                        type="text"
                        value={dhcpFlagFilter}
                        onChange={(e) => setDhcpFlagFilter(e.target.value)}
                        placeholder="Filter member, network, option…"
                        aria-label="Filter DHCP options"
                        className="h-7 pl-7 pr-7 text-[11px]"
                      />
                      {dhcpFlagFilter && (
                        <button
                          type="button"
                          onClick={() => setDhcpFlagFilter('')}
                          aria-label="Clear DHCP options filter"
                          className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-gray-200"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="overflow-x-auto max-h-[300px] overflow-y-auto rounded border border-[var(--border)]">
                    <table className="w-full text-[12px]">
                      <thead className="sticky top-0 z-10">
                        <tr className="border-b border-[var(--border)] bg-gray-50">
                          <th className="text-left px-3 py-2" style={{ fontWeight: 600 }}>Network</th>
                          <th className="text-right px-3 py-2" style={{ fontWeight: 600 }}>Option #</th>
                          <th className="text-left px-3 py-2" style={{ fontWeight: 600 }}>Option Name</th>
                          <th className="text-left px-3 py-2" style={{ fontWeight: 600 }}>Type</th>
                          <th className="text-center px-3 py-2" style={{ fontWeight: 600 }}>Flag</th>
                          <th className="text-left px-3 py-2" style={{ fontWeight: 600 }}>Member</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredDhcpOptions.length === 0 && (
                          <tr>
                            <td colSpan={6} className="px-3 py-3 text-center text-[11px] text-[var(--muted-foreground)]">
                              No DHCP options match "{dhcpFlagFilter}".
                            </td>
                          </tr>
                        )}
                        {filteredDhcpOptions.map((opt, idx) => (
                          <tr key={idx} className="border-b border-[var(--border)] hover:bg-gray-50/50">
                            <td className="px-3 py-1.5 font-mono text-[11px]">{opt.network}</td>
                            <td className="text-right px-3 py-1.5">{opt.optionNumber}</td>
                            <td className="px-3 py-1.5">{opt.optionName}</td>
                            <td className="px-3 py-1.5">{opt.optionType}</td>
                            <td className="text-center px-3 py-1.5">
                              <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] ${
                                opt.flag === 'VALIDATION_NEEDED'
                                  ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
                                  : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400'
                              }`} style={{ fontWeight: 600 }}>
                                {/* VALIDATION_NEEDED = red, CHECK_GUARDRAILS = yellow */}
                                {opt.flag === 'VALIDATION_NEEDED' ? 'Validation Needed' : 'Check Guardrails'}
                              </span>
                            </td>
                            <td className="px-3 py-1.5 truncate max-w-[200px]">{opt.member}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Host Routes Table */}
              {(niosMigrationFlags.hostRoutes?.length ?? 0) > 0 && (
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <h4 className="text-[12px] text-[var(--muted-foreground)]" style={{ fontWeight: 600 }}>
                      Host Routes (/32)
                      <span className="ml-2 text-[11px]" style={{ fontWeight: 400 }}>
                        {hostRouteFilter.trim()
                          ? `${filteredHostRoutes.length} of ${niosMigrationFlags.hostRoutes!.length}`
                          : `${niosMigrationFlags.hostRoutes!.length} total`}
                      </span>
                    </h4>
                    <div className="relative w-64">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--muted-foreground)]" />
                      <Input
                        type="text"
                        value={hostRouteFilter}
                        onChange={(e) => setHostRouteFilter(e.target.value)}
                        placeholder="Filter member or network…"
                        aria-label="Filter host routes"
                        className="h-7 pl-7 pr-7 text-[11px]"
                      />
                      {hostRouteFilter && (
                        <button
                          type="button"
                          onClick={() => setHostRouteFilter('')}
                          aria-label="Clear host routes filter"
                          className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-gray-200"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="overflow-x-auto max-h-[300px] overflow-y-auto rounded border border-[var(--border)]">
                    <table className="w-full text-[12px]">
                      <thead className="sticky top-0 z-10">
                        <tr className="border-b border-[var(--border)] bg-gray-50">
                          <th className="text-left px-3 py-2" style={{ fontWeight: 600 }}>Network (/32)</th>
                          <th className="text-left px-3 py-2" style={{ fontWeight: 600 }}>Member</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredHostRoutes.length === 0 && (
                          <tr>
                            <td colSpan={2} className="px-3 py-3 text-center text-[11px] text-[var(--muted-foreground)]">
                              No host routes match "{hostRouteFilter}".
                            </td>
                          </tr>
                        )}
                        {filteredHostRoutes.map((route, idx) => (
                          <tr key={idx} className="border-b border-[var(--border)] hover:bg-gray-50/50">
                            <td className="px-3 py-1.5 font-mono text-[11px]">{route.network}</td>
                            <td className="px-3 py-1.5 truncate max-w-[200px]">{route.member}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
