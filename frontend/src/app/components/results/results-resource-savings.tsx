/**
 * results-resource-savings.tsx — Phase 34 Plan 03 shim
 *
 * Thin wrapper around `<MemberResourceSavings />` that exposes a uniform
 * section-level mount surface so both `ScanResultsSurface` and
 * `SizerResultsSurface` can render per-member resource-savings tiles
 * via the same import (D-04, D-05).
 *
 * Pure presentation: props in / callbacks out. `mode` is passive — only
 * surfaces as `data-testid` discriminator (`results-resource-savings`)
 * and section anchor `#section-resource-savings` (D-13).
 *
 * Empty-savings guard: when `savings` is empty the shim renders `null`
 * so scan-mode can mount it without adding DOM (REQ-07 byte-identical
 * scan rendering preserved — scan path keeps its existing inline
 * per-member render inside `ResultsMemberDetails`).
 */
import { MemberResourceSavings } from '../member-resource-savings';
import type { MemberSavings } from '../resource-savings';

export interface ResultsResourceSavingsProps {
  mode: 'scan' | 'sizer';
  savings: MemberSavings[];
  onVariantChange: (memberId: string, variantIdx: number) => void;
}

export function ResultsResourceSavings({
  mode,
  savings,
  onVariantChange,
}: ResultsResourceSavingsProps) {
  if (savings.length === 0) {
    return null;
  }

  return (
    <section
      id="section-resource-savings"
      data-testid="results-resource-savings"
      data-mode={mode}
      className="scroll-mt-6"
    >
      <h3 className="text-sm font-semibold text-slate-700 mb-2">
        Resource Savings
      </h3>
      <div className="space-y-2">
        {savings.map((s) => (
          <MemberResourceSavings
            key={s.memberId}
            savings={s}
            onVariantChange={(idx) => onVariantChange(s.memberId, idx)}
          />
        ))}
      </div>
    </section>
  );
}
