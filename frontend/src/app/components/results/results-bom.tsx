// ResultsBom — section-bom. Extracted from wizard.tsx Step 5 in Phase 33 (D-01).
//
// Pure presentation. Caller pre-aggregates totalManagementTokens, totalServerTokens,
// reportingTokens, securityTokens (D-12 — never per-row ceildiv). BOM derives
// only pack counts via Math.ceil(total / packSize).
//
// Sizer mode (D-11): Reporting / Security totals fold into BOM as additional
// rows — never new hero tiles.

import { useState } from 'react';
import { Check, Download, HelpCircle } from 'lucide-react';
import type { ResultsMode, ResultsSurfaceProps } from './results-types';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';

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

export type ResultsBomProps = Pick<
  ResultsSurfaceProps,
  | 'mode'
  | 'totalManagementTokens'
  | 'totalServerTokens'
  | 'reportingTokens'
  | 'securityTokens'
  | 'hasServerMetrics'
  | 'growthBufferPct'
  | 'serverGrowthBufferPct'
> & {
  setGrowthBufferPct: (next: number) => void;
  setServerGrowthBufferPct: (next: number) => void;
};

export function ResultsBom(props: ResultsBomProps) {
  const {
    mode,
    totalManagementTokens,
    totalServerTokens,
    reportingTokens,
    securityTokens,
    hasServerMetrics,
    growthBufferPct,
    serverGrowthBufferPct,
    setGrowthBufferPct,
    setServerGrowthBufferPct,
  } = props;

  const totalTokens = totalManagementTokens; // parity alias from wizard.tsx
  const [bomCopied, setBomCopied] = useState(false);

  // Sizer-only branch (D-11) — render security row when mode='sizer' and value>0.
  const showSecurityRow: boolean = mode === 'sizer' && securityTokens > 0;

  return (
    <div
      id="section-bom"
      className="scroll-mt-6 bg-white rounded-xl border border-[var(--border)] p-5 mb-6"
    >
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-[15px]" style={{ fontWeight: 600 }}>
            Token Breakdown
          </h3>
          <p className="text-[12px] text-[var(--muted-foreground)] mt-0.5">
            Bill of Materials — copy-paste ready SKU list for quoting
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-[13px]">
            <span
              className="text-[var(--muted-foreground)]"
              style={{ fontWeight: 500 }}
            >
              Mgmt Buffer
            </span>
            <FieldTooltip
              text="Growth buffer applied to management and reporting tokens. Default 20% is typical for a 1-year planning horizon."
              side="left"
            />
            <div className="flex items-center border border-[var(--border)] rounded-lg overflow-hidden">
              <input
                type="number"
                min={0}
                max={100}
                step={5}
                className="w-16 px-2 py-1.5 text-[13px] text-right focus:outline-none focus:ring-1 focus:ring-[var(--infoblox-orange)]"
                value={Math.round(growthBufferPct * 100)}
                onChange={(e) =>
                  setGrowthBufferPct(
                    Math.min(1, Math.max(0, (parseInt(e.target.value) || 0) / 100)),
                  )
                }
              />
              <span className="px-2 py-1.5 bg-gray-50 text-[13px] text-[var(--muted-foreground)] border-l border-[var(--border)]">
                %
              </span>
            </div>
          </label>
          {hasServerMetrics && (
            <label className="flex items-center gap-2 text-[13px]">
              <span
                className="text-[var(--muted-foreground)]"
                style={{ fontWeight: 500 }}
              >
                Server Buffer
              </span>
              <FieldTooltip
                text="Growth buffer applied to server tokens (NIOS-X appliances, XaaS instances, AD domain controllers). Accounts for workload growth in QPS, LPS, and object counts. Default 20%."
                side="left"
              />
              <div className="flex items-center border border-[var(--border)] rounded-lg overflow-hidden">
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={5}
                  className="w-16 px-2 py-1.5 text-[13px] text-right focus:outline-none focus:ring-1 focus:ring-blue-500"
                  value={Math.round(serverGrowthBufferPct * 100)}
                  onChange={(e) =>
                    setServerGrowthBufferPct(
                      Math.min(1, Math.max(0, (parseInt(e.target.value) || 0) / 100)),
                    )
                  }
                />
                <span className="px-2 py-1.5 bg-gray-50 text-[13px] text-[var(--muted-foreground)] border-l border-[var(--border)]">
                  %
                </span>
              </div>
            </label>
          )}
          <button
            type="button"
            onClick={() => {
              const mgmtPacks = Math.ceil(totalTokens / 1000);
              const servPacks = hasServerMetrics ? Math.ceil(totalServerTokens / 500) : 0;
              const rptPacks = reportingTokens > 0 ? Math.ceil(reportingTokens / 40) : 0;
              const secPacks = showSecurityRow ? Math.ceil(securityTokens / 100) : 0;
              const lines = [
                `SKU Code\tDescription\tPack Count`,
                `IB-TOKENS-UDDI-MGMT-1000\tManagement Token Pack (1000 tokens)\t${mgmtPacks}`,
                ...(servPacks > 0
                  ? [`IB-TOKENS-UDDI-SERV-500\tServer Token Pack (500 tokens)\t${servPacks}`]
                  : []),
                ...(rptPacks > 0
                  ? [`IB-TOKENS-REPORTING-40\tReporting Token Pack (40 tokens)\t${rptPacks}`]
                  : []),
                ...(secPacks > 0
                  ? [`IB-TOKENS-SECURITY-100\tSecurity Token Pack (100 tokens)\t${secPacks}`]
                  : []),
              ];
              navigator.clipboard.writeText(lines.join('\n')).then(() => {
                setBomCopied(true);
                setTimeout(() => setBomCopied(false), 2000);
              });
            }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] border transition-colors ${
              bomCopied
                ? 'bg-green-50 border-green-300 text-green-700'
                : 'bg-white border-[var(--border)] hover:bg-gray-50'
            }`}
            style={{ fontWeight: 500 }}
          >
            {bomCopied ? (
              <>
                <Check className="w-3.5 h-3.5" /> Copied!
              </>
            ) : (
              <>
                <Download className="w-3.5 h-3.5" /> Copy BOM
              </>
            )}
          </button>
        </div>
      </div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-[var(--border)]">
            <th
              className="text-left py-2 text-[var(--muted-foreground)] text-[12px]"
              style={{ fontWeight: 500 }}
            >
              SKU Code
            </th>
            <th
              className="text-left py-2 text-[var(--muted-foreground)] text-[12px]"
              style={{ fontWeight: 500 }}
            >
              Description
            </th>
            <th
              className="text-right py-2 text-[var(--muted-foreground)] text-[12px]"
              style={{ fontWeight: 500 }}
            >
              Pack Count
            </th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-[var(--border)]/50">
            <td className="py-2.5 font-mono text-[12px] text-orange-800">
              IB-TOKENS-UDDI-MGMT-1000
            </td>
            <td className="py-2.5 text-[var(--muted-foreground)]">
              <span className="flex items-center gap-1">
                Management Token Pack (1000 tokens)
                <FieldTooltip
                  text="Covers DDI Objects, Active IPs, and Managed Assets. Pack size: 1000 tokens. Count = ceil(total management tokens / 1000). Growth buffer already included."
                  side="top"
                />
              </span>
            </td>
            <td className="py-2.5 text-right tabular-nums" style={{ fontWeight: 600 }}>
              {Math.ceil(totalTokens / 1000).toLocaleString()}
            </td>
          </tr>
          {hasServerMetrics && (
            <tr className="border-b border-[var(--border)]/50">
              <td className="py-2.5 font-mono text-[12px] text-blue-800">
                IB-TOKENS-UDDI-SERV-500
              </td>
              <td className="py-2.5 text-[var(--muted-foreground)]">
                <span className="flex items-center gap-1">
                  Server Token Pack (500 tokens)
                  <FieldTooltip
                    text="Server tokens (IB-TOKENS-UDDI-SERV-500) cover NIOS-X appliances and XaaS instances sized by QPS, LPS, and object count. Tier capacities range from 2XS (130 tokens) to XL (2,700 tokens) for NIOS-X. Separate from management tokens. No growth buffer applied. Source: NOTES tab rows 21-30."
                    side="top"
                  />
                </span>
              </td>
              <td className="py-2.5 text-right tabular-nums" style={{ fontWeight: 600 }}>
                {Math.ceil(totalServerTokens / 500).toLocaleString()}
              </td>
            </tr>
          )}
          {reportingTokens > 0 && (
            <tr className={showSecurityRow ? 'border-b border-[var(--border)]/50' : ''}>
              <td className="py-2.5 font-mono text-[12px] text-purple-800">
                IB-TOKENS-REPORTING-40
              </td>
              <td className="py-2.5 text-[var(--muted-foreground)]">
                <span className="flex items-center gap-1">
                  Reporting Token Pack (40 tokens)
                  <FieldTooltip
                    text="Reporting tokens (IB-TOKENS-REPORTING-40) cover DNS protocol and DHCP lease log forwarding. Rate: CSP=80 tokens per 10M events, S3 Bucket=40, Ecosystem (CDC)=40. Local Syslog is display-only and contributes 0 tokens. Ecosystem receives 40% of total log volume by default. Growth buffer is applied. Source: NOTES tab rows 31-44."
                    side="top"
                  />
                </span>
              </td>
              <td className="py-2.5 text-right tabular-nums" style={{ fontWeight: 600 }}>
                {Math.ceil(reportingTokens / 40).toLocaleString()}
              </td>
            </tr>
          )}
          {showSecurityRow && (
            <tr>
              <td className="py-2.5 font-mono text-[12px] text-emerald-800">
                IB-TOKENS-SECURITY-100
              </td>
              <td className="py-2.5 text-[var(--muted-foreground)]">
                <span className="flex items-center gap-1">
                  Security Token Pack (100 tokens)
                  <FieldTooltip
                    text="Security tokens cover Threat Defense, DNS Firewall, and related security services. Sizer-mode only — surfaced when sizer state produces a non-zero security total. Pack size: 100 tokens."
                    side="top"
                  />
                </span>
              </td>
              <td className="py-2.5 text-right tabular-nums" style={{ fontWeight: 600 }}>
                {Math.ceil(securityTokens / 100).toLocaleString()}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {growthBufferPct > 0 && (
        <p className="text-[11px] text-[var(--muted-foreground)] mt-3">
          Includes {Math.round(growthBufferPct * 100)}% growth buffer on management
          {reportingTokens > 0 ? '/reporting' : ''} tokens
          {hasServerMetrics ? `, ${Math.round(serverGrowthBufferPct * 100)}% on server tokens` : ''}.
        </p>
      )}
      {/* Mode prop is consumed for Sizer-branch row; reference for type-narrowing parity. */}
      <span data-mode={mode} className="hidden" />
    </div>
  );
}

export type { ResultsMode };
