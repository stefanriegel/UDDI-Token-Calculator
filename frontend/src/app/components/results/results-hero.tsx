// ResultsHero — section-overview. Extracted from wizard.tsx Step 5 in Phase 33 (D-01).
//
// Pure presentation: caller computes totalManagementTokens / totalServerTokens
// via aggregate-then-divide upstream (D-12). Hero performs zero per-row
// ceildiv — only `Math.ceil(total / packSize)` for pack counts.

import { useState } from 'react';
import { ChevronDown, HelpCircle, Pencil } from 'lucide-react';
import type {
  ADServerMetrics,
  FindingRow,
  NiosServerMetrics,
  ResultsOverrides,
  ResultsSurfaceProps,
  ServerFormFactor,
} from './results-types';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';
import { PROVIDERS, calcServerTokenTier, type ProviderType } from '../mock-data';

// ── Inline helpers (lifted from wizard.tsx so hero is self-contained) ─────────

function FieldTooltip({
  text,
  side = 'top',
}: {
  text: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
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

function applyServerOverrides(
  m: NiosServerMetrics,
  overrides: ResultsOverrides['serverMetricOverrides'],
): { qps: number; lps: number; objects: number } {
  const ov = overrides[m.memberId] ?? {};
  return {
    qps: ov.qps ?? ov.dnsQps ?? m.qps,
    lps: ov.lps ?? ov.dhcpLps ?? m.lps,
    objects: ov.objects ?? m.objectCount + (m.activeIPCount ?? 0),
  };
}

function applyADServerOverrides(
  m: ADServerMetrics,
  overrides: ResultsOverrides['serverMetricOverrides'],
): { qps: number; lps: number; objects: number } {
  const ov = overrides[m.hostname] ?? {};
  return {
    qps: ov.qps ?? ov.dnsQps ?? m.qps,
    lps: ov.lps ?? ov.dhcpLps ?? m.lps,
    objects: ov.objects ?? m.dnsObjects + m.dhcpObjectsWithOverhead,
  };
}

function isInfraOnlyMember(m: NiosServerMetrics): boolean {
  return (
    (m.role === 'GM' || m.role === 'GMC') &&
    m.qps === 0 &&
    m.lps === 0 &&
    m.objectCount === 0 &&
    (m.activeIPCount ?? 0) === 0
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

/**
 * Strict subset of `ResultsSurfaceProps` that ResultsHero actually consumes.
 * `heroCollapsed` / `setHeroCollapsed` come in from the surface (D-04 decision
 * documented in results-types.ts) so the wizard can drive expand-on-arrival.
 */
export type ResultsHeroProps = Pick<
  ResultsSurfaceProps,
  | 'totalManagementTokens'
  | 'totalServerTokens'
  | 'hasServerMetrics'
  | 'hybridScenario'
  | 'growthBufferPct'
  | 'serverGrowthBufferPct'
  | 'effectiveFindings'
  | 'selectedProviders'
  | 'effectiveNiosMetrics'
  | 'effectiveADMetrics'
  | 'heroCollapsed'
  | 'setHeroCollapsed'
> & {
  countOverrides: ResultsOverrides['countOverrides'];
  serverMetricOverrides: ResultsOverrides['serverMetricOverrides'];
  adMigrationMap: ResultsOverrides['adMigrationMap'];
};

export function ResultsHero(props: ResultsHeroProps) {
  const {
    totalManagementTokens,
    totalServerTokens,
    hasServerMetrics,
    hybridScenario,
    countOverrides,
    effectiveFindings,
    selectedProviders,
    effectiveNiosMetrics = [],
    effectiveADMetrics = [],
    serverMetricOverrides,
    adMigrationMap,
    heroCollapsed,
    setHeroCollapsed,
  } = props;

  // Local-only UI state — never crosses the hero boundary.
  const [showAllHeroSources, setShowAllHeroSources] = useState(false);

  // Alias for parity with original wizard JSX (variable named `totalTokens` there).
  const totalTokens = totalManagementTokens;

  return (
    <div
      id="section-overview"
      className="scroll-mt-6 bg-white rounded-xl border-2 border-[var(--infoblox-orange)]/30 p-5 mb-6"
    >
      {/* Always-visible header: both totals + single toggle */}
      <button
        type="button"
        onClick={() => setHeroCollapsed(!heroCollapsed)}
        className="w-full text-left"
      >
        <div className={`grid gap-6 ${hasServerMetrics ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {/* Management total */}
          <div>
            <div className="flex items-center gap-1.5 text-[13px] text-[var(--muted-foreground)] mb-1">
              Total Management Tokens
              <FieldTooltip
                text="Management tokens cover DDI Objects (1 token per 25 objects), Active IPs (1 token per 13 IPs), and Managed Assets (1 token per 3 assets). Pack size: 1,000 tokens. Growth buffer is included. Source: NOTES tab rows 12-20."
                side="right"
              />
            </div>
            <div className="text-[32px] text-[var(--infoblox-orange)]" style={{ fontWeight: 700 }}>
              {totalTokens.toLocaleString()}
              {Object.keys(countOverrides).length > 0 && (
                <span className="ml-2 text-[11px] font-medium text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200 align-middle">
                  <Pencil className="w-3 h-3 inline -mt-0.5 mr-0.5" />
                  adjusted
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className="font-mono text-[11px] bg-orange-50 text-orange-800 px-2 py-0.5 rounded border border-orange-200">
                IB-TOKENS-UDDI-MGMT-1000
              </span>
              <span className="text-[12px] font-semibold text-[var(--infoblox-orange)]">
                × {Math.ceil(totalTokens / 1000).toLocaleString()} pack
                {Math.ceil(totalTokens / 1000) !== 1 ? 's' : ''}
              </span>
            </div>
            {hybridScenario && (
              <div className="mt-2 pt-2 border-t border-orange-100">
                <div className="text-[11px] text-[var(--muted-foreground)] mb-0.5">
                  Hybrid scenario{' '}
                  <span className="text-orange-600">({hybridScenario.selectionCount} selected)</span>
                </div>
                <div
                  className="text-[22px] text-orange-400"
                  style={{ fontWeight: 700, lineHeight: 1.1 }}
                >
                  {hybridScenario.mgmt.toLocaleString()}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="font-mono text-[10px] bg-orange-50 text-orange-700 px-1.5 py-0.5 rounded border border-orange-200">
                    IB-TOKENS-UDDI-MGMT-1000
                  </span>
                  <span className="text-[11px] font-semibold text-orange-400">
                    × {Math.ceil(hybridScenario.mgmt / 1000).toLocaleString()} pack
                    {Math.ceil(hybridScenario.mgmt / 1000) !== 1 ? 's' : ''}
                  </span>
                </div>
              </div>
            )}
          </div>
          {/* Server total */}
          {hasServerMetrics && (
            <div className="border-l border-[var(--border)] pl-6">
              <div className="flex items-center gap-1.5 text-[13px] text-[var(--muted-foreground)] mb-1">
                Total Server Tokens
                <FieldTooltip
                  text="Server tokens (IB-TOKENS-UDDI-SERV-500) cover NIOS-X appliances and XaaS instances sized by QPS, LPS, and object count. Tier capacities range from 2XS (130 tokens) to XL (2,700 tokens) for NIOS-X. Separate from management tokens. No growth buffer applied. Source: NOTES tab rows 21-30."
                  side="right"
                />
              </div>
              <div className="text-[32px] text-blue-700" style={{ fontWeight: 700 }}>
                {totalServerTokens.toLocaleString()}
              </div>
              <div className="flex items-center gap-2 mt-1">
                <span className="font-mono text-[11px] bg-blue-50 text-blue-800 px-2 py-0.5 rounded border border-blue-200">
                  IB-TOKENS-UDDI-SERV-500
                </span>
                <span className="text-[12px] font-semibold text-blue-700">
                  × {Math.ceil(totalServerTokens / 500).toLocaleString()} pack
                  {Math.ceil(totalServerTokens / 500) !== 1 ? 's' : ''}
                </span>
              </div>
              {hybridScenario && (
                <div className="mt-2 pt-2 border-t border-blue-100">
                  <div className="text-[11px] text-[var(--muted-foreground)] mb-0.5">
                    Hybrid scenario{' '}
                    <span className="text-blue-500">({hybridScenario.selectionCount} selected)</span>
                  </div>
                  <div
                    className="text-[22px] text-blue-400"
                    style={{ fontWeight: 700, lineHeight: 1.1 }}
                  >
                    {hybridScenario.srv.toLocaleString()}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="font-mono text-[10px] bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded border border-blue-200">
                      IB-TOKENS-UDDI-SERV-500
                    </span>
                    <span className="text-[11px] font-semibold text-blue-400">
                      × {Math.ceil(hybridScenario.srv / 500).toLocaleString()} pack
                      {Math.ceil(hybridScenario.srv / 500) !== 1 ? 's' : ''}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        {/* Expand/collapse hint */}
        <div className="flex items-center gap-1 mt-3 text-[11px] text-[var(--muted-foreground)]">
          <ChevronDown
            className={`w-3.5 h-3.5 transition-transform ${heroCollapsed ? '' : 'rotate-180'}`}
          />
          {heroCollapsed ? 'Show breakdown by source' : 'Hide breakdown'}
        </div>
      </button>

      {/* Expandable: per-source bars for both columns */}
      {!heroCollapsed && (
        <div
          className={`mt-4 pt-4 border-t border-[var(--border)] grid gap-6 ${hasServerMetrics ? 'grid-cols-2' : 'grid-cols-1'}`}
        >
          {/* Management breakdown */}
          <div>
            <div className="text-[11px] font-semibold text-[var(--muted-foreground)] mb-3 uppercase tracking-wider">
              By Source — Management
            </div>
            <div className="space-y-2.5">
              {(() => {
                const sourceMap = new Map<
                  string,
                  { source: string; provider: ProviderType; tokens: number }
                >();
                effectiveFindings.forEach((f: FindingRow) => {
                  const key = `${f.provider}::${f.source}`;
                  if (!sourceMap.has(key))
                    sourceMap.set(key, { source: f.source, provider: f.provider, tokens: 0 });
                  sourceMap.get(key)!.tokens += f.managementTokens;
                });
                const sources = Array.from(sourceMap.values()).sort(
                  (a, b) => b.tokens - a.tokens,
                );
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
                              <span
                                className="text-[12px] flex items-center gap-1.5"
                                style={{ fontWeight: 500 }}
                              >
                                <span
                                  className="inline-block w-2 h-2 rounded-full shrink-0"
                                  style={{ backgroundColor: provider.color }}
                                />
                                {entry.source}
                                <span
                                  className="text-[11px] text-[var(--muted-foreground)]"
                                  style={{ fontWeight: 400 }}
                                >
                                  {provider.name}
                                </span>
                              </span>
                              <span className="text-[12px] tabular-nums text-[var(--muted-foreground)]">
                                {entry.tokens.toLocaleString()}{' '}
                                <span className="text-[11px]">({Math.round(pct)}%)</span>
                              </span>
                            </div>
                            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                              <div
                                className="h-full rounded-full transition-all"
                                style={{ width: `${pct}%`, backgroundColor: provider.color }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {hidden > 0 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowAllHeroSources((v) => !v);
                        }}
                        className="text-[12px] text-[var(--infoblox-blue)] hover:underline mt-1"
                        style={{ fontWeight: 500 }}
                      >
                        {showAllHeroSources ? 'Show less' : `Show ${hidden} more sources...`}
                      </button>
                    )}
                  </>
                );
              })()}
            </div>
          </div>

          {/* Server breakdown */}
          {hasServerMetrics &&
            (() => {
              const srvSources: { label: string; color: string; tokens: number }[] = [];
              // Issue #9 — Sizer mode passes effectiveNiosMetrics without a
              // 'nios' entry in selectedProviders (which is [] for Sizer). Gate
              // strictly on metric presence so the "By Source — Server" block
              // doesn't render the contradictory "No server metrics available."
              // when the same page renders the planner + member-detail cards.
              // Behavior is unchanged for scan mode: effectiveNiosMetrics only
              // populates when the user picked the NIOS provider.
              if (effectiveNiosMetrics.length > 0) {
                effectiveNiosMetrics
                  .filter((m) => !isInfraOnlyMember(m))
                  .forEach((m) => {
                    const eff = applyServerOverrides(m, serverMetricOverrides);
                    const t = calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x')
                      .serverTokens;
                    if (t > 0) srvSources.push({ label: m.memberName, color: '#00a5e5', tokens: t });
                  });
              }
              if (selectedProviders.includes('microsoft') && effectiveADMetrics.length > 0) {
                const dcs =
                  adMigrationMap.size > 0
                    ? effectiveADMetrics.filter((m) => adMigrationMap.has(m.hostname))
                    : effectiveADMetrics;
                dcs.forEach((m) => {
                  const eff = applyADServerOverrides(m, serverMetricOverrides);
                  const t = calcServerTokenTier(eff.qps, eff.lps, eff.objects, 'nios-x')
                    .serverTokens;
                  if (t > 0) srvSources.push({ label: m.hostname, color: '#0078d4', tokens: t });
                });
              }
              srvSources.sort((a, b) => b.tokens - a.tokens);
              const LIMIT = 10;
              const visible = srvSources.slice(0, LIMIT);
              const hidden = srvSources.length - LIMIT;
              return (
                <div className="border-l border-[var(--border)] pl-6">
                  <div className="text-[11px] font-semibold text-[var(--muted-foreground)] mb-3 uppercase tracking-wider">
                    By Source — Server
                  </div>
                  <div className="space-y-2.5">
                    {srvSources.length === 0 ? (
                      <div className="text-[12px] text-[var(--muted-foreground)]">
                        No server metrics available.
                      </div>
                    ) : (
                      <>
                        {visible.map((entry) => {
                          const pct =
                            totalServerTokens > 0 ? (entry.tokens / totalServerTokens) * 100 : 0;
                          return (
                            <div key={entry.label} className="mb-2.5">
                              <div className="flex items-center justify-between mb-1">
                                <span
                                  className="text-[12px] flex items-center gap-1.5"
                                  style={{ fontWeight: 500 }}
                                >
                                  <span
                                    className="inline-block w-2 h-2 rounded-full shrink-0"
                                    style={{ backgroundColor: entry.color }}
                                  />
                                  {entry.label}
                                </span>
                                <span className="text-[12px] tabular-nums text-[var(--muted-foreground)]">
                                  {entry.tokens.toLocaleString()}{' '}
                                  <span className="text-[11px]">({Math.round(pct)}%)</span>
                                </span>
                              </div>
                              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                                <div
                                  className="h-full rounded-full transition-all"
                                  style={{ width: `${pct}%`, backgroundColor: entry.color }}
                                />
                              </div>
                            </div>
                          );
                        })}
                        {hidden > 0 && (
                          <div className="text-[12px] text-[var(--muted-foreground)] mt-1">
                            +{hidden} more sources
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })()}
        </div>
      )}
    </div>
  );
}
