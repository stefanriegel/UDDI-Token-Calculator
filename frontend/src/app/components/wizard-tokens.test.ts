import { describe, it, expect } from 'vitest';

// ── Aggregate-then-divide helper functions ──────────────────────────────────
// These replicate the aggregate logic used in wizard.tsx for totalTokens and
// categoryTotals when count overrides are active. The correct approach is to
// sum counts per (category, tokensPerUnit) group first, then apply ceiling
// division once per group — NOT sum pre-divided per-row managementTokens.

interface FindingLike {
  category: string;
  count: number;
  tokensPerUnit: number;
}

/**
 * Aggregate-then-divide: groups findings by (category, tokensPerUnit), sums
 * counts within each group, applies ceiling division once per group, then sums
 * across all groups.
 */
export function aggregateTokens(findings: FindingLike[]): number {
  const groups: Record<string, Record<number, number>> = {};
  findings.forEach((f) => {
    if (!groups[f.category]) groups[f.category] = {};
    const rate = f.tokensPerUnit || 1;
    groups[f.category][rate] = (groups[f.category][rate] || 0) + f.count;
  });
  let total = 0;
  for (const cat of Object.values(groups)) {
    for (const [rate, count] of Object.entries(cat)) {
      total += Math.ceil(count / Number(rate));
    }
  }
  return total;
}

/**
 * Aggregate-then-divide per category: returns per-category token totals using
 * the same grouping logic as aggregateTokens.
 */
export function aggregateCategoryTotals(findings: FindingLike[]): Record<string, number> {
  const groups: Record<string, Record<number, number>> = {};
  findings.forEach((f) => {
    if (!groups[f.category]) groups[f.category] = {};
    const rate = f.tokensPerUnit || 1;
    groups[f.category][rate] = (groups[f.category][rate] || 0) + f.count;
  });
  const totals: Record<string, number> = {};
  for (const [cat, rates] of Object.entries(groups)) {
    totals[cat] = 0;
    for (const [rate, count] of Object.entries(rates)) {
      totals[cat] += Math.ceil(count / Number(rate));
    }
  }
  return totals;
}

/**
 * Per-row-sum: the BUGGY approach that sums ceil(count/rate) per row.
 * This inflates totals because ceil(a/n) + ceil(b/n) >= ceil((a+b)/n).
 */
function perRowSum(findings: FindingLike[]): number {
  return findings.reduce(
    (sum, f) => sum + Math.ceil(f.count / (f.tokensPerUnit || 1)),
    0,
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('aggregate-then-divide token math', () => {
  it('produces fewer tokens than per-row-sum for small counts (rounding inflation)', () => {
    // 3 NIOS DDI rows with count=1 at rate=50:
    // per-row-sum: ceil(1/50) + ceil(1/50) + ceil(1/50) = 1+1+1 = 3
    // aggregate:   ceil((1+1+1)/50) = ceil(3/50) = ceil(0.06) = 1
    const findings: FindingLike[] = [
      { category: 'DDI Object', count: 1, tokensPerUnit: 50 },
      { category: 'DDI Object', count: 1, tokensPerUnit: 50 },
      { category: 'DDI Object', count: 1, tokensPerUnit: 50 },
    ];
    const agg = aggregateTokens(findings);
    const prs = perRowSum(findings);
    expect(agg).toBe(1);
    expect(prs).toBe(3);
    expect(agg).toBeLessThan(prs);
  });

  it('produces same result as per-row-sum when counts are exact multiples of rate', () => {
    // Each row's count is a multiple of rate, so ceil is a no-op
    const findings: FindingLike[] = [
      { category: 'DDI Object', count: 50, tokensPerUnit: 50 },
      { category: 'DDI Object', count: 100, tokensPerUnit: 50 },
      { category: 'Active IP', count: 26, tokensPerUnit: 13 },
    ];
    const agg = aggregateTokens(findings);
    const prs = perRowSum(findings);
    expect(agg).toBe(prs);
    expect(agg).toBe(1 + 2 + 2); // 50/50 + 100/50 + 26/13
  });

  it('handles mixed provider rates (NIOS rate=50, cloud rate=25) by grouping by rate', () => {
    // NIOS DDI at rate=50 and cloud DDI at rate=25 should be separate groups
    const findings: FindingLike[] = [
      { category: 'DDI Object', count: 3, tokensPerUnit: 50 },  // NIOS
      { category: 'DDI Object', count: 3, tokensPerUnit: 25 },  // cloud
    ];
    const agg = aggregateTokens(findings);
    // ceil(3/50) + ceil(3/25) = 1 + 1 = 2
    expect(agg).toBe(2);
  });

  it('applies growth buffer AFTER aggregate ceiling division', () => {
    const findings: FindingLike[] = [
      { category: 'DDI Object', count: 3, tokensPerUnit: 50 },
    ];
    const raw = aggregateTokens(findings); // ceil(3/50) = 1
    const withBuffer = Math.ceil(raw * (1 + 0.20)); // ceil(1 * 1.2) = ceil(1.2) = 2
    expect(raw).toBe(1);
    expect(withBuffer).toBe(2);
  });

  it('categoryTotals returns correct per-category aggregate tokens', () => {
    const findings: FindingLike[] = [
      { category: 'DDI Object', count: 1, tokensPerUnit: 50 },
      { category: 'DDI Object', count: 1, tokensPerUnit: 50 },
      { category: 'DDI Object', count: 1, tokensPerUnit: 50 },
      { category: 'Active IP', count: 5, tokensPerUnit: 25 },
      { category: 'Active IP', count: 5, tokensPerUnit: 25 },
      { category: 'Asset', count: 2, tokensPerUnit: 13 },
    ];
    const totals = aggregateCategoryTotals(findings);
    // DDI Object: ceil(3/50) = 1
    expect(totals['DDI Object']).toBe(1);
    // Active IP: ceil(10/25) = 1
    expect(totals['Active IP']).toBe(1);
    // Asset: ceil(2/13) = 1
    expect(totals['Asset']).toBe(1);

    // per-row-sum would give: 3 + 2 + 1 = 6 (inflated)
    const prs = perRowSum(findings);
    expect(prs).toBe(6);

    const aggTotal = Object.values(totals).reduce((s, v) => s + v, 0);
    expect(aggTotal).toBe(3);
    expect(aggTotal).toBeLessThan(prs);
  });

  it('handles empty findings', () => {
    expect(aggregateTokens([])).toBe(0);
    expect(aggregateCategoryTotals([])).toEqual({});
  });

  it('handles single finding row correctly', () => {
    const findings: FindingLike[] = [
      { category: 'DDI Object', count: 30, tokensPerUnit: 25 },
    ];
    expect(aggregateTokens(findings)).toBe(2); // ceil(30/25) = 2
    expect(aggregateCategoryTotals(findings)).toEqual({ 'DDI Object': 2 });
  });
});
