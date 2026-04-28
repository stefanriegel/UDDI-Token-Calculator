// results-member-details.tsx — shared "Grid Member Details" sub-component.
//
// Phase 34 Plan 02 — D-03/D-04/D-05 lift-first contract:
//   * pure presentation, props in / callbacks out
//   * NO useSizer, NO scan-store hooks
//   * `mode` is a passive label only — no visual branching inside this file
//
// Lifted verbatim from the inline JSX in `results-migration-planner.tsx`
// (the block under the comment "Grid Member Details — collapsible
// 2-column card grid"). The original plan referenced
// `results-surface.tsx:2091`, but Phase 34 Plan 01 already lifted that
// block into the migration-planner module — so this lift carves
// `ResultsMemberDetails` out of the migration-planner instead. The
// scan-mode rendering of the section remains byte-identical because the
// migration-planner caller now mounts `<ResultsMemberDetails mode="scan" />`
// in place of the inline JSX, with the same data flowing through props.
import { type ReactElement } from 'react';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';

import { calcServerTokenTier } from '../mock-data';
import type {
  FindingRow,
  FleetSavings,
  MemberSavings,
  NiosServerMetrics,
  ResultsMode,
  ServerFormFactor,
  ServerMetricOverride,
} from './results-types';
import { PlatformBadge } from '../ui/platform-badge';
import { MemberResourceSavings } from '../member-resource-savings';
import { FleetSavingsTotals } from '../fleet-savings-totals';

// ─── Local helpers (duplicated from results-migration-planner.tsx so this
// file is self-contained — D-05 pure-presentation rule). Tiny enough that
// duplication is cheaper than threading a shared utils module right now.

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

const ROLE_COLORS: Record<string, string> = {
  GM: '#002B49',
  GMC: '#1a4a6e',
  DNS: '#0078d4',
  DHCP: '#00a5e5',
  'DNS/DHCP': '#005a9e',
  IPAM: '#7fba00',
  Reporting: '#8b8b8b',
};

function tierColorClass(name: string): string {
  return name === 'XL'
    ? 'bg-red-100 text-red-700'
    : name === 'L'
      ? 'bg-orange-100 text-orange-700'
      : name === 'M'
        ? 'bg-yellow-100 text-yellow-700'
        : name === 'S'
          ? 'bg-green-100 text-green-700'
          : name === 'XS'
            ? 'bg-sky-100 text-sky-700'
            : 'bg-gray-100 text-gray-700';
}

// ─── Public prop contract ───────────────────────────────────────────────────
//
// D-05: passive `mode` label, props in, callbacks out. The surface mirrors
// the closure variables the lifted JSX previously read from the
// migration-planner's IIFE scope.

export interface ResultsMemberDetailsProps {
  /** Passive label — used by analytics / parent data-testid scopes. */
  mode: ResultsMode;
  /**
   * Members to render — already filtered upstream (e.g. infra-only members
   * removed, migrating-vs-all selection applied). One card is rendered per
   * entry (further filtered by `gridMemberDetailSearch`).
   */
  members: NiosServerMetrics[];
  /** Findings used to compute per-member management-token totals. */
  effectiveFindings: FindingRow[];
  /** Per-member migration tier assignments (drives Server Tier calculation). */
  niosMigrationMap: Map<string, ServerFormFactor>;
  /** Per-member QPS/LPS/objects overrides. Keyed by `memberId`. */
  serverMetricOverrides: Record<string, ServerMetricOverride>;
  /**
   * Optional override-change callback (Plan 02 prop signature). Not wired
   * to inline editors today — the migration planner owns the editing UI
   * and emits server-metric changes through `setServerMetricOverrides`.
   */
  onOverrideChange?: (memberId: string, patch: ServerMetricOverride) => void;

  // Resource-savings (RES-07..RES-11) — wired into per-member tile + fleet totals.
  memberSavings: MemberSavings[];
  setVariantOverrides: (
    next:
      | Map<string, number>
      | ((prev: Map<string, number>) => Map<string, number>),
  ) => void;
  fleetSavings: FleetSavings;

  // Collapsible chrome (controlled).
  showGridMemberDetails: boolean;
  setShowGridMemberDetails: (v: boolean) => void;
  gridMemberDetailSearch: string;
  setGridMemberDetailSearch: (v: string) => void;
}

export function ResultsMemberDetails(
  props: ResultsMemberDetailsProps,
): ReactElement | null {
  const {
    mode,
    members: displayMembers,
    effectiveFindings,
    niosMigrationMap,
    serverMetricOverrides,
    memberSavings,
    setVariantOverrides,
    fleetSavings,
    showGridMemberDetails,
    setShowGridMemberDetails,
    gridMemberDetailSearch,
    setGridMemberDetailSearch,
  } = props;

  const getMemberFF = (memberName: string): ServerFormFactor =>
    niosMigrationMap.get(memberName) || 'nios-x';

  // Issue #19: NIOS backups don't carry QPS/LPS unless a Splunk QPS XML was
  // also uploaded. Hiding empty-fleet columns prevents 4/8 metric tiles from
  // showing "—" across every member card on every backup.
  const hasAnyQps = displayMembers.some((m) => (m.qps ?? 0) > 0);
  const hasAnyLps = displayMembers.some((m) => (m.lps ?? 0) > 0);

  return (
    <div
      data-testid="results-member-details"
      id="section-member-details"
      className="scroll-mt-6 border-t border-emerald-200"
    >
      <button
        onClick={() => setShowGridMemberDetails(!showGridMemberDetails)}
        className="w-full px-4 py-3 flex items-center gap-2 text-left hover:bg-emerald-50/50 transition-colors"
      >
        {showGridMemberDetails ? (
          <ChevronUp className="w-4 h-4 text-emerald-600" />
        ) : (
          <ChevronDown className="w-4 h-4 text-emerald-600" />
        )}
        <span className="text-[13px] text-emerald-800" style={{ fontWeight: 600 }}>
          {mode === 'sizer' ? 'NIOS-X Details' : 'Grid Member Details'}
        </span>
        <span className="text-[11px] text-[var(--muted-foreground)]">
          {displayMembers.length} member{displayMembers.length !== 1 ? 's' : ''}
        </span>
      </button>
      {showGridMemberDetails && (
        <div className="px-4 pb-4">
          {/* Search filter */}
          {displayMembers.length > 4 && (
            <div className="relative mb-3">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
              <input
                type="text"
                placeholder="Filter members..."
                value={gridMemberDetailSearch}
                onChange={(e) => setGridMemberDetailSearch(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 rounded-md border border-[var(--border)] text-[12px] bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400"
              />
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {displayMembers
              .filter(
                (m) =>
                  !gridMemberDetailSearch ||
                  m.memberName
                    .toLowerCase()
                    .includes(gridMemberDetailSearch.toLowerCase()),
              )
              .map((m) => {
                const mEff = applyServerOverrides(m, serverMetricOverrides);
                const tier = calcServerTokenTier(
                  mEff.qps,
                  mEff.lps,
                  mEff.objects,
                  getMemberFF(m.memberName),
                );
                const activeLicenses = Object.entries(m.licenses || {})
                  .filter(([, v]) => v)
                  .map(([k]) => k);
                // Issue #8 — Sizer-mode adapters precompute per-member mgmt
                // tokens on `m.managementTokens`; prefer that. Fall back to
                // findings filtering for scan mode.
                const memberMgmtTokens =
                  m.managementTokens ??
                  effectiveFindings
                    .filter(
                      (f) => f.provider === 'nios' && f.source === m.memberName,
                    )
                    .reduce((s, f) => s + f.managementTokens, 0);
                // Issue #19: passive/replicant members surface as cards full
                // of "—" because NIOS backups report 0 across every workload
                // metric. Detect that case and render a single "no metrics
                // reported" line in place of the empty grid so the imported
                // report no longer looks half-built.
                const isPassiveMember =
                  (m.objectCount ?? 0) === 0 &&
                  (m.activeIPCount ?? 0) === 0 &&
                  (m.managedIPCount ?? 0) === 0 &&
                  (m.staticHosts ?? 0) === 0 &&
                  (m.dynamicHosts ?? 0) === 0 &&
                  (m.dhcpUtilization ?? 0) === 0 &&
                  (m.qps ?? 0) === 0 &&
                  (m.lps ?? 0) === 0 &&
                  memberMgmtTokens === 0;
                return (
                  <div
                    key={m.memberId}
                    className="rounded-lg border border-[var(--border)] bg-white p-3 hover:shadow-sm transition-shadow"
                  >
                    {/* Header: name + model + platform + role badge */}
                    <div className="flex items-center gap-2 mb-1">
                      <div className="truncate text-[12px]" style={{ fontWeight: 600 }}>
                        {m.memberName}
                      </div>
                      <span
                        className="inline-block px-2 py-0.5 rounded text-[9px] text-white shrink-0"
                        style={{ fontWeight: 600, backgroundColor: ROLE_COLORS[m.role] || '#666' }}
                      >
                        {m.role}
                      </span>
                    </div>
                    {/* Sub-header: model + platform + migration target */}
                    <div className="flex items-center gap-2 mb-2.5 text-[10px] text-[var(--muted-foreground)]">
                      {m.model && <span style={{ fontWeight: 500 }}>{m.model}</span>}
                      {m.platform && (
                        <PlatformBadge platform={m.platform as any}>{m.platform}</PlatformBadge>
                      )}
                      {niosMigrationMap.has(m.memberName) && (
                        <span
                          className={`inline-block px-1.5 py-0 rounded text-[9px] text-white ${
                            niosMigrationMap.get(m.memberName) === 'nios-xaas'
                              ? 'bg-purple-500'
                              : 'bg-[var(--infoblox-blue)]'
                          }`}
                          style={{ fontWeight: 600 }}
                        >
                          {niosMigrationMap.get(m.memberName) === 'nios-xaas' ? 'XaaS' : 'NIOS-X'}
                        </span>
                      )}
                    </div>
                    {/* Metrics grid — Issue #19: collapse to a single
                        explanatory line for passive/replicant members so the
                        imported report doesn't render rows of empty tiles. */}
                    {isPassiveMember ? (
                      <div className="text-[11px] text-[var(--muted-foreground)] italic flex items-center justify-between gap-2">
                        <span>No workload metrics reported in NIOS backup (passive / replicant member).</span>
                        <span
                          title={`No QPS/LPS/object metrics observed; size defaults to the smallest tier (${tier.name}, ${tier.serverTokens} tokens). Adjust workload metrics in the migration planner to override.`}
                        >
                          <span
                            className={`inline-block px-1.5 py-0 rounded text-[10px] ${tierColorClass(tier.name)}`}
                            style={{ fontWeight: 600 }}
                          >
                            {tier.name}
                          </span>
                          {/* Issue #22: passive members get the smallest tier
                              by default; flag it as fallback so it does not
                              read as observed sizing. */}
                          <span
                            className="ml-1 text-amber-700 text-[9px] italic"
                            style={{ fontWeight: 500 }}
                          >
                            fallback
                          </span>
                          <span
                            className="ml-1 text-emerald-600 text-[10px]"
                            style={{ fontWeight: 600 }}
                          >
                            {tier.serverTokens.toLocaleString()} token{tier.serverTokens === 1 ? '' : 's'}
                          </span>
                        </span>
                      </div>
                    ) : (
                    <div className="grid grid-cols-4 gap-x-3 gap-y-1.5 text-[11px]">
                      <div>
                        <div className="text-[var(--muted-foreground)] text-[10px]">DDI Objects</div>
                        <div className="tabular-nums" style={{ fontWeight: 500 }}>
                          {m.objectCount > 0 ? m.objectCount.toLocaleString() : '—'}
                        </div>
                      </div>
                      <div>
                        <div className="text-[var(--muted-foreground)] text-[10px]">UDDI Active IPs</div>
                        <div className="tabular-nums" style={{ fontWeight: 500 }}>
                          {m.activeIPCount > 0 ? m.activeIPCount.toLocaleString() : '—'}
                        </div>
                      </div>
                      <div>
                        <div className="text-[var(--muted-foreground)] text-[10px]">Managed IPs</div>
                        <div className="tabular-nums" style={{ fontWeight: 500 }}>
                          {m.managedIPCount > 0 ? m.managedIPCount.toLocaleString() : '—'}
                        </div>
                      </div>
                      <div>
                        <div className="text-[var(--muted-foreground)] text-[10px]">Mgmt Tokens</div>
                        <div
                          className="tabular-nums text-[var(--infoblox-orange)]"
                          style={{ fontWeight: 600 }}
                        >
                          {memberMgmtTokens > 0 ? memberMgmtTokens.toLocaleString() : '—'}
                        </div>
                      </div>
                      <div>
                        <div className="text-[var(--muted-foreground)] text-[10px]">Static Hosts</div>
                        <div className="tabular-nums" style={{ fontWeight: 500 }}>
                          {m.staticHosts > 0 ? m.staticHosts.toLocaleString() : '—'}
                        </div>
                      </div>
                      <div>
                        <div className="text-[var(--muted-foreground)] text-[10px]">Dynamic Hosts</div>
                        <div className="tabular-nums" style={{ fontWeight: 500 }}>
                          {m.dynamicHosts > 0 ? m.dynamicHosts.toLocaleString() : '—'}
                        </div>
                      </div>
                      <div>
                        <div className="text-[var(--muted-foreground)] text-[10px]">DHCP Util</div>
                        <div className="tabular-nums" style={{ fontWeight: 500 }}>
                          {m.dhcpUtilization > 0
                            ? `${(m.dhcpUtilization / 10).toFixed(1)}%`
                            : '—'}
                        </div>
                      </div>
                      {hasAnyQps && (
                      <div>
                        <div className="text-[var(--muted-foreground)] text-[10px]">QPS</div>
                        <div className="tabular-nums" style={{ fontWeight: 500 }}>
                          {m.qps > 0 ? m.qps.toLocaleString() : '—'}
                        </div>
                      </div>
                      )}
                      {hasAnyLps && (
                      <div>
                        <div className="text-[var(--muted-foreground)] text-[10px]">LPS</div>
                        <div className="tabular-nums" style={{ fontWeight: 500 }}>
                          {m.lps > 0 ? m.lps.toLocaleString() : '—'}
                        </div>
                      </div>
                      )}
                      <div>
                        <div className="text-[var(--muted-foreground)] text-[10px]">Server Tier</div>
                        <div>
                          <span
                            className={`inline-block px-1.5 py-0 rounded text-[10px] ${tierColorClass(tier.name)}`}
                            style={{ fontWeight: 600 }}
                          >
                            {tier.name}
                          </span>
                          {/* Issue #22: zero QPS/LPS/object members get the
                              smallest tier by default; mark it as fallback so
                              SEs do not misread it as observed sizing. */}
                          {mEff.qps === 0 && mEff.lps === 0 && mEff.objects === 0 && (
                            <span
                              className="ml-1 text-amber-700 text-[9px] italic"
                              style={{ fontWeight: 500 }}
                              title={`No QPS/LPS/object metrics observed; size defaults to the smallest tier (${tier.name}, ${tier.serverTokens} tokens). Adjust workload metrics in the migration planner to override.`}
                            >
                              fallback
                            </span>
                          )}
                          <span
                            className="ml-1 text-emerald-600 text-[10px]"
                            style={{ fontWeight: 600 }}
                          >
                            {tier.serverTokens.toLocaleString()} token{tier.serverTokens === 1 ? '' : 's'}
                          </span>
                        </div>
                      </div>
                    </div>
                    )}
                    {/* License pills */}
                    {activeLicenses.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2 pt-2 border-t border-gray-100">
                        {activeLicenses.map((lic) => (
                          <span
                            key={lic}
                            className="inline-block px-1.5 py-0 rounded-full bg-gray-100 text-gray-600 text-[9px]"
                            style={{ fontWeight: 500 }}
                          >
                            {lic}
                          </span>
                        ))}
                      </div>
                    )}
                    {/* Resource Savings sub-section — RES-07, RES-08, RES-09, RES-10, RES-11 */}
                    {(() => {
                      const savings = memberSavings.find(
                        (ms) => ms.memberId === m.memberId,
                      );
                      if (!savings) return null;
                      return (
                        <MemberResourceSavings
                          savings={savings}
                          onVariantChange={(idx) => {
                            setVariantOverrides((prev) => {
                              const next = new Map(prev);
                              const spec = savings.oldSpec;
                              if (spec && idx === spec.defaultVariantIndex) {
                                next.delete(m.memberId);
                              } else {
                                next.set(m.memberId, idx);
                              }
                              return next;
                            });
                          }}
                        />
                      );
                    })()}
                  </div>
                );
              })}
          </div>
          {/* Fleet savings totals — RES-06 continuation. Hidden in Sizer mode
              (greenfield, no "old" appliance baseline — see issue #13). */}
          {mode !== 'sizer' && <FleetSavingsTotals fleet={fleetSavings} />}
        </div>
      )}
    </div>
  );
}
