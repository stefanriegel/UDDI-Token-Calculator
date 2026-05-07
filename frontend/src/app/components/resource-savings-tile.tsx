import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import type { FleetSavings } from './resource-savings';

export interface ResourceSavingsTileProps {
  fleet: FleetSavings;
}

function formatRam(gb: number): string {
  const abs = Math.abs(gb);
  const sign = gb < 0 ? '−' : '';
  if (abs >= 1024) return `${sign}${(abs / 1024).toFixed(1)} TB RAM`;
  return `${sign}${Math.round(abs).toLocaleString()} GB RAM`;
}

function formatVcpu(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  return `${sign}${abs.toLocaleString()} vCPU`;
}

export function ResourceSavingsTile({ fleet }: ResourceSavingsTileProps) {
  const excluded = fleet.unknownModels.length + fleet.invalidCombinations.length;
  const validCount = fleet.memberCount - excluded;
  const isEmpty = validCount <= 0;

  return (
    <Card className="border-emerald-200 bg-emerald-50/40">
      <CardHeader className="pb-2">
        <CardTitle className="text-[13px] flex items-center gap-1.5" style={{ fontWeight: 600 }}>
          🌱 Resource Footprint Reduction
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-[12px]">
        {isEmpty ? (
          <div className="text-amber-700" role="status">
            No data — verify member configuration
          </div>
        ) : (
          <>
            <div className="flex gap-4 text-[15px] tabular-nums text-emerald-700" style={{ fontWeight: 600 }}>
              <span>{formatVcpu(fleet.totalDeltaVCPU)}</span>
              <span>{formatRam(fleet.totalDeltaRamGB)}</span>
            </div>
            {fleet.niosXSavings.memberCount > 0 && (
              <div className="border-t border-slate-200 pt-2">
                <div className="text-slate-600 text-[10px] uppercase tracking-wide" style={{ fontWeight: 600 }}>
                  Self-managed (NIOS-X):
                </div>
                <div className="text-slate-700 tabular-nums">
                  {formatVcpu(-fleet.niosXSavings.vCPU)}, {formatRam(-fleet.niosXSavings.ramGB)} · {fleet.niosXSavings.memberCount} member{fleet.niosXSavings.memberCount !== 1 ? 's' : ''}
                </div>
              </div>
            )}
            {fleet.xaasSavings.memberCount > 0 && (
              <div className="border-t border-emerald-200 pt-2">
                <div className="text-emerald-700 text-[10px] uppercase tracking-wide" style={{ fontWeight: 600 }}>
                  Fully eliminated (NIOS-XaaS):
                </div>
                <div className="text-emerald-700 tabular-nums">
                  {formatVcpu(-fleet.xaasSavings.vCPU)}, {formatRam(-fleet.xaasSavings.ramGB)} · {fleet.xaasSavings.memberCount} member{fleet.xaasSavings.memberCount !== 1 ? 's' : ''}
                </div>
              </div>
            )}
            {fleet.physicalUnitsRetired > 0 && (
              <div className="border-t border-blue-200 pt-2 text-blue-700" style={{ fontWeight: 500 }}>
                🏢 {fleet.physicalUnitsRetired} physical unit{fleet.physicalUnitsRetired !== 1 ? 's' : ''} retired
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
