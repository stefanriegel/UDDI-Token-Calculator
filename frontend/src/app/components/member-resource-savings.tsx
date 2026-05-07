import { Button } from './ui/button';
import { Badge } from './ui/badge';
import type { MemberSavings } from './resource-savings';

export interface MemberResourceSavingsProps {
  savings: MemberSavings;
  onVariantChange: (variantIdx: number) => void;
}

function formatVcpu(n: number): string {
  if (n === 0) return '0 vCPU';
  const sign = n < 0 ? '−' : '+';
  return `${sign}${Math.abs(n).toLocaleString()} vCPU`;
}

function formatRamDelta(n: number): string {
  if (n === 0) return '0 GB RAM';
  const sign = n < 0 ? '−' : '+';
  return `${sign}${Math.abs(n).toLocaleString()} GB RAM`;
}

export function MemberResourceSavings({ savings, onVariantChange }: MemberResourceSavingsProps) {
  // Invalid platform combo
  if (savings.invalidPlatformForModel) {
    return (
      <div className="mt-2 pt-2 border-t border-amber-200 bg-amber-50/60 rounded px-2 py-1.5">
        <div className="text-[10px] text-amber-700 uppercase tracking-wide" style={{ fontWeight: 600 }}>Resource Savings</div>
        <div className="text-[11px] text-amber-700" style={{ fontWeight: 500 }} role="alert">
          ⚠ Model "{savings.oldModel}" is not supported on {savings.oldPlatform} (VMware-only)
        </div>
        <div className="text-[10px] text-amber-600">Excluded from fleet totals</div>
      </div>
    );
  }
  // Physical hardware — no virtual compute to free up. Show the chassis info
  // and the decommission badge only; vCPU/RAM/delta lines would be misleading
  // (a physical IB-XXXX chassis is not "reclaimed vCPU"; it's a unit retired).
  if (savings.physicalDecommission) {
    return (
      <div className="mt-2 pt-2 border-t border-blue-200 bg-blue-50/40 rounded px-2 py-1.5">
        <div className="text-[10px] text-blue-700 uppercase tracking-wide" style={{ fontWeight: 600 }}>Resource Savings</div>
        <div className="text-[11px] text-slate-700">
          <span className="text-slate-500">Hardware:</span>{' '}
          {savings.oldModel} / {savings.oldPlatform}
        </div>
        <div className="mt-1 inline-block text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200" style={{ fontWeight: 500 }}>
          🏢 Physical decommission — frees rack space, power, and cooling
        </div>
      </div>
    );
  }
  // Unknown model / lookup miss
  if (savings.lookupMissing) {
    return (
      <div className="mt-2 pt-2 border-t border-amber-200 bg-amber-50/60 rounded px-2 py-1.5">
        <div className="text-[10px] text-amber-700 uppercase tracking-wide" style={{ fontWeight: 600 }}>Resource Savings</div>
        <div className="text-[11px] text-amber-700" style={{ fontWeight: 500 }} role="alert">
          ⚠ Unknown model — verify member configuration
        </div>
        <div className="text-[10px] text-amber-600">Excluded from fleet totals</div>
      </div>
    );
  }

  const spec = savings.oldSpec!;
  const variants = spec.variants;
  const showChips = variants.length > 1;
  const activeVariant = variants[savings.oldVariantIndex];
  const deltaIsRegression = savings.deltaVCPU > 0 || savings.deltaRamGB > 0;
  const deltaColor = deltaIsRegression ? 'text-red-600' : 'text-emerald-700';

  return (
    <div className="mt-2 pt-2 border-t border-slate-200">
      <div className="text-[10px] text-slate-500 uppercase tracking-wide mb-1" style={{ fontWeight: 600 }}>Resource Savings</div>

      {/* Before block */}
      <div className="text-[11px] text-slate-700">
        <span className="text-slate-500">Before:</span>{' '}
        {savings.oldModel} / {savings.oldPlatform} ({activeVariant.configName})
      </div>
      <div className="text-[11px] tabular-nums text-slate-700" style={{ fontWeight: 500 }}>
        {activeVariant.vCPU} vCPU · {activeVariant.ramGB} GB RAM
      </div>

      {/* Variant chips */}
      {showChips && (
        <div className="flex gap-1 mt-1 flex-wrap">
          {variants.map((v, idx) => (
            <Button
              key={idx}
              type="button"
              size="sm"
              variant={idx === savings.oldVariantIndex ? 'default' : 'outline'}
              className="h-6 px-2 text-[10px]"
              onClick={() => onVariantChange(idx)}
            >
              {v.configName}
            </Button>
          ))}
        </div>
      )}

      {/* After block */}
      <div className="text-[11px] text-slate-700 mt-1.5">
        <span className="text-slate-500">After:</span>{' '}
        {savings.fullyManaged ? 'NIOS-XaaS (Fully managed)' : `NIOS-X ${savings.newTierName}`}
      </div>
      <div className="text-[11px] tabular-nums text-slate-700" style={{ fontWeight: 500 }}>
        {savings.newVCPU} vCPU · {savings.newRamGB} GB RAM
      </div>

      {/* XaaS badge */}
      {savings.fullyManaged && (
        <Badge className="mt-1.5 bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-50" variant="outline">
          ✨ Fully managed by Infoblox — zero customer footprint
        </Badge>
      )}

      {/* Delta line */}
      <div className={`text-[11px] tabular-nums mt-1.5 ${deltaColor}`} style={{ fontWeight: 600 }}>
        Δ {formatVcpu(savings.deltaVCPU)} · {formatRamDelta(savings.deltaRamGB)}
        {savings.fullyManaged && savings.oldVCPU > 0 && ' (100%)'}
      </div>

      {/* Physical decommission pill */}
      {savings.physicalDecommission && (
        <div className="mt-1.5 inline-block text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200" style={{ fontWeight: 500 }}>
          🏢 Physical decommission — frees rack space, power, and cooling
        </div>
      )}
    </div>
  );
}
