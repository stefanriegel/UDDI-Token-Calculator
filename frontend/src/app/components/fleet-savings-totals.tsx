import type { FleetSavings } from './resource-savings';

export interface FleetSavingsTotalsProps {
  fleet: FleetSavings;
}

function fmtVcpu(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : n > 0 ? '+' : '';
  return `${sign}${abs.toLocaleString()} vCPU`;
}

function fmtRam(gb: number): string {
  const abs = Math.abs(gb);
  const sign = gb < 0 ? '−' : gb > 0 ? '+' : '';
  if (abs >= 1024) return `${sign}${(abs / 1024).toFixed(1)} TB RAM`;
  return `${sign}${Math.round(abs).toLocaleString()} GB RAM`;
}

export function FleetSavingsTotals({ fleet }: FleetSavingsTotalsProps) {
  const excluded = fleet.unknownModels.length + fleet.invalidCombinations.length;
  return (
    <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
      <div className="text-[12px] text-slate-700 mb-2" style={{ fontWeight: 600 }}>
        Fleet Totals ({fleet.memberCount} member{fleet.memberCount !== 1 ? 's' : ''})
        {excluded > 0 && <span className="text-amber-700 text-[11px] ml-2">· {excluded} excluded</span>}
      </div>
      <div className="grid grid-cols-[80px_1fr] gap-x-2 gap-y-1 text-[11px] tabular-nums text-slate-700">
        <div className="text-slate-500">Old:</div>
        <div>{fleet.totalOldVCPU.toLocaleString()} vCPU · {fmtRam(fleet.totalOldRamGB).replace(/^[+−]/, '')}</div>
        <div className="text-slate-500">New:</div>
        <div>{fleet.totalNewVCPU.toLocaleString()} vCPU · {fmtRam(fleet.totalNewRamGB).replace(/^[+−]/, '')}</div>
        <div className="text-slate-500">Δ:</div>
        <div className="text-emerald-700" style={{ fontWeight: 600 }}>
          {fmtVcpu(fleet.totalDeltaVCPU)} · {fmtRam(fleet.totalDeltaRamGB)}
        </div>
      </div>
      {fleet.xaasSavings.memberCount > 0 && (
        <div className="mt-2 text-[11px] text-emerald-700">
          <span className="text-slate-500">Of which fully managed (XaaS):</span>{' '}
          {fmtVcpu(-fleet.xaasSavings.vCPU)} · {fmtRam(-fleet.xaasSavings.ramGB)} · {fleet.xaasSavings.memberCount} member{fleet.xaasSavings.memberCount !== 1 ? 's' : ''}
        </div>
      )}
      {fleet.physicalUnitsRetired > 0 && (
        <div className="mt-1 text-[11px] text-blue-700">
          Physical retired: {fleet.physicalUnitsRetired} unit{fleet.physicalUnitsRetired !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
}
