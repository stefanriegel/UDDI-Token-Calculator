/**
 * results-surface.test.tsx — unit tests for `<ResultsSurface/>` (Phase 33 Plan 06).
 *
 * Locks the discriminated-union dispatch (mode='scan' vs mode='sizer'), the
 * sizer-mode composition (ResultsHero + ResultsBom + ResultsExportBar = three
 * universal sections only — D-07/D-09), conditional gating in sizer mode (no
 * NIOS migration / no AD migration / no member details — D-06/D-09), and the
 * "adjusted" pill behavior driven by countOverrides.
 *
 * Scan-mode rendering with the full wizardBag is exercised by the
 * Playwright e2e in `tests-e2e/results-surface.spec.ts` — building a
 * 90-field wizardBag fixture in jsdom would be both fragile and noisy.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ResultsSurface, type ResultsSurfaceProps } from '../results-surface';
import type { ResultsOverrides } from '../results-types';
import { OutlineNav } from '../../ui/outline-nav';

// ─── jsdom shims ──────────────────────────────────────────────────────────────
// OutlineNav uses IntersectionObserver + scrollIntoView; the surface mounts a
// transitive consumer in some tests. Stub both before importing the surface
// (Vitest hoists vi.* but defensive stubbing here is safer).
class MockIntersectionObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
  takeRecords = vi.fn().mockReturnValue([]);
  constructor(_cb: IntersectionObserverCallback) {}
}
// @ts-expect-error -- jsdom has no IntersectionObserver.
globalThis.IntersectionObserver = MockIntersectionObserver;
Element.prototype.scrollIntoView = vi.fn();

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NO_OP_OVERRIDES: ResultsOverrides = {
  countOverrides: {},
  setCountOverrides: () => {},
  serverMetricOverrides: {},
  setServerMetricOverrides: () => {},
  variantOverrides: new Map(),
  setVariantOverrides: () => {},
  adMigrationMap: new Map(),
  setAdMigrationMap: () => {},
};

const SIZER_OUTLINE = [
  { id: 'section-overview', label: 'Overview' },
  { id: 'section-bom', label: 'Token Breakdown' },
  { id: 'section-export', label: 'Export' },
];

/** Pure-Sizer base props — D-07 (no NIOS, no AD, no member savings). */
const sizerBaseProps: Extract<ResultsSurfaceProps, { mode: 'sizer' }> = {
  mode: 'sizer',
  findings: [],
  effectiveFindings: [],
  growthBufferPct: 0.2,
  serverGrowthBufferPct: 0.2,
  selectedProviders: [],
  totalManagementTokens: 1234,
  totalServerTokens: 567,
  reportingTokens: 89,
  securityTokens: 42,
  hasServerMetrics: true,
  hybridScenario: null,
  breakdownBySource: [],
  outlineSections: SIZER_OUTLINE,
  overrides: NO_OP_OVERRIDES,
  onExport: () => {},
  // Phase 34 Plan 06 — Wave 4 wiring (no NIOS-X members → migration sections gated out).
  regions: [],
  niosxMembers: [],
  niosxSystems: [],
  mgmtOverhead: 0,
  onSiteEdit: () => {},
  onMemberTierChange: () => {},
};

const makeSizer = (
  over: Partial<Extract<ResultsSurfaceProps, { mode: 'sizer' }>> = {},
): Extract<ResultsSurfaceProps, { mode: 'sizer' }> => ({
  ...sizerBaseProps,
  ...over,
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('<ResultsSurface mode="sizer"/>', () => {
  it('renders only the three universal sections (D-07): overview, bom, export', () => {
    const { container } = render(<ResultsSurface {...makeSizer()} />);

    expect(container.querySelector('#section-overview')).not.toBeNull();
    expect(container.querySelector('#section-bom')).not.toBeNull();
    expect(container.querySelector('#section-export')).not.toBeNull();

    // Scan-only / NIOS-only / AD-only sections are gated out (D-06 / D-09).
    expect(container.querySelector('#section-migration-planner')).toBeNull();
    expect(container.querySelector('#section-member-details')).toBeNull();
    expect(container.querySelector('#section-ad-migration')).toBeNull();
    expect(container.querySelector('#section-ad-server-tokens')).toBeNull();
    expect(container.querySelector('#section-findings')).toBeNull();
  });

  it('hero renders the management + server token totals from props', () => {
    render(
      <ResultsSurface
        {...makeSizer({
          totalManagementTokens: 2500,
          totalServerTokens: 800,
          hasServerMetrics: true,
        })}
      />,
    );
    // ResultsHero renders both totals; the labels are stable (UI-SPEC).
    expect(screen.getByText('Total Management Tokens')).toBeInTheDocument();
    expect(screen.getByText('Total Server Tokens')).toBeInTheDocument();
    // Totals appear with formatted commas; the mgmt total shares its node with
    // the IB-TOKENS pack badge so use a substring match against textContent.
    // toLocaleString may use comma or dot grouping depending on test env locale.
    expect(document.body.textContent).toMatch(/2[.,]500/);
    // 800 is adjacent to "IB-TOKENS-..." so \b doesn't match; assert no-leading-digit instead.
    expect(document.body.textContent).toMatch(/(?<!\d)800(?!\d)/);
  });

  it('countOverrides non-empty causes the "adjusted" pill to render in the hero', () => {
    const overrides: ResultsOverrides = {
      ...NO_OP_OVERRIDES,
      countOverrides: { 'aws/dns/zone-1': 99 },
    };
    render(<ResultsSurface {...makeSizer({ overrides })} />);
    // UI-SPEC interaction contract: pill text is "adjusted".
    expect(screen.getAllByText(/adjusted/i).length).toBeGreaterThan(0);
  });

  it('countOverrides empty does NOT render the "adjusted" pill', () => {
    render(<ResultsSurface {...makeSizer({ overrides: NO_OP_OVERRIDES })} />);
    expect(screen.queryByText(/adjusted/i)).toBeNull();
  });

  it('export bar uses sizer-mode reset copy verbatim when onReset provided (D-15)', async () => {
    const user = userEvent.setup();
    render(<ResultsSurface {...makeSizer({ onReset: () => {} })} />);

    await user.click(screen.getByRole('button', { name: /start over/i }));

    expect(
      screen.getByText(
        'This clears Sizer state stored in this browser. Your inputs cannot be recovered.',
      ),
    ).toBeInTheDocument();
  });

  it('export bar omits Start Over when onReset is absent', () => {
    render(<ResultsSurface {...makeSizer({ onReset: undefined })} />);
    expect(screen.queryByRole('button', { name: /start over/i })).toBeNull();
  });

  it('clicking Download XLSX wires through to the caller-supplied onExport (D-13)', async () => {
    const onExport = vi.fn();
    const user = userEvent.setup();
    render(<ResultsSurface {...makeSizer({ onExport })} />);

    await user.click(screen.getByRole('button', { name: /download xlsx/i }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });
});

// ─── OutlineNav prop pass-through (locked by surface contract) ───────────────
// The surface lifts outlineSections from upstream; OutlineNav itself is unit-
// tested in `frontend/src/app/components/ui/outline-nav.test.tsx`. This block
// asserts the contract: passing N sections to OutlineNav renders N anchors —
// which is exactly what the surface relies on.

describe('OutlineNav (used by ResultsSurface for section nav)', () => {
  it('renders one anchor per outlineSections entry (3 = sizer baseline)', () => {
    render(<OutlineNav sections={SIZER_OUTLINE} />);
    expect(screen.getByRole('button', { name: /overview/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /token breakdown/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^export$/i })).toBeInTheDocument();
  });
});
