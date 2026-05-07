/**
 * sizer-step-results.tsx — Step 5 page (Phase 33 Plan 05).
 *
 * Renders <ResultsSurface mode="sizer" /> exclusively. The legacy bespoke
 * hero-cards + per-Region breakdown table were retired in Plan 05 in favor
 * of the shared sub-component composition (ResultsHero + ResultsBom +
 * ResultsExportBar).
 *
 * Wizard navigation lives in `sizer-footer.tsx`; this file does NOT render
 * a previous-step button.
 */
import { useCallback, useMemo } from 'react';

import { useSizer, STORAGE_KEY } from './sizer-state';
import { deriveSizerResultsProps, deriveMembersFromNiosx } from './sizer-derive';
import { resolveOverheads } from './sizer-calc';
import { downloadWorkbook } from './sizer-xlsx-export';
import type { Site } from './sizer-types';
import { buildSizerSessionJson, buildSizerCsv } from './sizer-session-export';

import { ResultsSurface } from '../results/results-surface';
import type { ResultsOverrides } from '../results/results-types';
import type { ServerFormFactor } from '../mock-data';
import { Card, CardContent } from '../ui/card';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * No-op overrides bundle — Sizer mode never edits findings / member tier
 * picks / variant choices, so every setter is a noop and every map is empty.
 * Plumbed into ResultsSurface to satisfy the prop contract.
 */
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

function triggerDownload(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Sizer-mode Start Over copy (matches UI-SPEC; D-15). */
const SIZER_RESET_COPY = {
  title: 'Start Over?',
  description:
    'This clears Sizer state stored in this browser. Your inputs cannot be recovered.',
  cancel: 'Cancel',
  confirm: 'Reset',
};

// ── Component ────────────────────────────────────────────────────────────────

interface SizerStepResultsProps {
  /**
   * Optional navigation callback fired after the local Sizer reset. Used by
   * the outer wizard to send the user back to the Adapter Selection (Step 1
   * "Select Providers") instead of leaving them stranded on the now-empty
   * Sizer report.
   */
  onResetNavigate?: () => void;
}

export function SizerStepResults({ onResetNavigate }: SizerStepResultsProps = {}) {
  const { state, dispatch } = useSizer();

  const derived = useMemo(
    () => deriveSizerResultsProps(state.core),
    [state.core],
  );

  const onExport = useCallback(() => {
    void downloadWorkbook(state);
  }, [state]);

  const onSaveSession = useCallback(() => {
    const date = new Date().toISOString().slice(0, 10);
    const json = buildSizerSessionJson(state);
    triggerDownload(json, `sizer-session-${date}.json`, 'application/json');
  }, [state]);

  const onDownloadCSV = useCallback(() => {
    const date = new Date().toISOString().slice(0, 10);
    const csv = buildSizerCsv(state);
    triggerDownload(csv, `sizer-report-${date}.csv`, 'text/csv;charset=utf-8');
  }, [state]);

  const onReset = useCallback(() => {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    dispatch({ type: 'RESET_STATE' });
    dispatch({ type: 'SET_ACTIVE_STEP', step: 1 });
    onResetNavigate?.();
  }, [dispatch, onResetNavigate]);

  // ─── Phase 34 Plan 06 (Wave 4) — Sizer adapter wiring ───────────────────────
  // deriveMembersFromNiosx (D-01/D-02) projects Sizer NIOS-X systems into the
  // canonical scan-side NiosServerMetrics shape so the lifted shared
  // <ResultsMigrationPlanner/> + <ResultsMemberDetails/> + <ResultsResourceSavings/>
  // can mount in Sizer mode with zero conditional logic.
  const niosxMembers = useMemo(
    () =>
      deriveMembersFromNiosx(
        state.core.infrastructure.niosx,
        state.core.regions,
        resolveOverheads(state.core).mgmt,
      ),
    [state.core],
  );

  // Issue #6 — slim NIOS-X system records (id/name/siteId) drive the migration
  // planner's mgmt-token scenarios in Sizer mode. Plus the resolved
  // `mgmtOverhead` so scenario math matches the hero card formula.
  const niosxSystems = useMemo(
    () =>
      state.core.infrastructure.niosx.map((n) => ({
        id: n.id,
        name: n.name,
        siteId: n.siteId,
      })),
    [state.core.infrastructure.niosx],
  );
  const mgmtOverhead = useMemo(() => resolveOverheads(state.core).mgmt, [state.core]);

  // D-07: reuse existing UPDATE_SITE reducer action — no new action introduced.
  // Site-edit dispatches from <ResultsBreakdown/> click-to-edit cells flow here.
  const onSiteEdit = useCallback(
    (siteId: string, patch: Partial<Site>) => {
      dispatch({ type: 'UPDATE_SITE', siteId, patch });
    },
    [dispatch],
  );

  // Member tier-change dispatches the existing UPDATE_NIOSX action
  // (sizer-state.ts:94). Maps the scan-side ServerFormFactor ('nios-x' /
  // 'nios-xaas') back to the Sizer NIOS-X tierName the reducer expects. Sizer
  // form-factor is recorded on `formFactor` (independent of tier) — the v1
  // mapping is conservative: keep the existing tierName, mirror the form
  // factor change into the system. The shared planner currently emits
  // `(memberId, ServerFormFactor)`; for Sizer we mirror form-factor only
  // through this callback (tier remains user-controlled in Step 3 Infrastructure).
  const onMemberTierChange = useCallback(
    (memberId: string, ff: ServerFormFactor) => {
      dispatch({
        type: 'UPDATE_NIOSX',
        id: memberId,
        patch: { formFactor: ff === 'nios-xaas' ? 'nios-xaas' : 'nios-x' },
      });
    },
    [dispatch],
  );

  // Empty-state short-circuit: no Regions yet → nothing to size.
  if (state.core.regions.length === 0) {
    return (
      <Card data-testid="sizer-step-results">
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          Add at least one Region in Step 1 before viewing results.
        </CardContent>
      </Card>
    );
  }

  return (
    <div data-testid="sizer-step-results">
      <ResultsSurface
        mode="sizer"
        {...derived}
        overrides={NO_OP_OVERRIDES}
        onExport={onExport}
        onDownloadCSV={onDownloadCSV}
        onSaveSession={onSaveSession}
        onReset={onReset}
        resetCopy={SIZER_RESET_COPY}
        regions={state.core.regions}
        niosxMembers={niosxMembers}
        niosxSystems={niosxSystems}
        mgmtOverhead={mgmtOverhead}
        onSiteEdit={onSiteEdit}
        onMemberTierChange={onMemberTierChange}
      />
    </div>
  );
}
