/**
 * import-confirm-dialog.tsx — Phase 32 D-02 pre-merge confirmation dialog.
 *
 * Pure presentational component. Wraps the Phase 31 Radix `AlertDialog`
 * primitive (analog: sizer-step-results.tsx §Start Over) and surfaces a count
 * summary of the entities that would be added by `importFromScan(...)` versus
 * those that already exist in the live Sizer state.
 *
 * Per CONTEXT decisions:
 *   - D-02: Body lists "Will add: N Regions, M Sites, K NIOS-X. Existing
 *           Sizer data (X Regions, Y Sites, Z NIOS-X) will be preserved."
 *           Confirm = "Import & open Sizer". Cancel = "Cancel".
 *   - D-12: Will-add counts are computed via the SAME merge engine used at
 *           dispatch time, so dedup-skipped entities don't inflate the user's
 *           expectations.
 *   - D-13: The dialog NEVER mutates `existing`. `onConfirm` is the caller's
 *           responsibility — Phase 32 plan 32-05 wires it to the
 *           session-storage handoff in wizard.tsx.
 *
 * Reusable testid hooks (Phase 31 convention):
 *   - sizer-import-dialog
 *   - sizer-import-summary
 *   - sizer-import-confirm
 *   - sizer-import-cancel
 *
 * This component holds no local state and performs no storage I/O — it is a
 * pure render of its props (only useMemo for the cached count summary).
 */
import { useMemo, type ReactNode } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../ui/alert-dialog';

import type { FindingRow } from '../mock-data';
import type { NiosServerMetricAPI, ADServerMetricAPI } from '../api-client';
import type { SizerFullState } from './sizer-state';
import { importFromScan, mergeFullState } from './sizer-import';

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface TreeCounts {
  regions: number;
  sites: number;
  niosx: number;
}

/**
 * Walk a SizerFullState and tally Regions / Sites / NIOS-X. Used both for the
 * existing-state summary and (after running mergeFullState) for the
 * dedup-aware will-add summary.
 */
function countTree(state: SizerFullState): TreeCounts {
  let sites = 0;
  for (const r of state.core.regions) {
    for (const c of r.countries) {
      for (const ct of c.cities) {
        sites += ct.sites.length;
      }
    }
  }
  return {
    regions: state.core.regions.length,
    sites,
    niosx: state.core.infrastructure.niosx.length,
  };
}

// ─── Component ───────────────────────────────────────────────────────────────

export interface ImportConfirmDialogProps {
  findings: FindingRow[];
  niosServerMetrics?: NiosServerMetricAPI[];
  adServerMetrics?: ADServerMetricAPI[];
  /** Live Sizer state — used for "preserved" counts and dedup awareness. */
  existing: SizerFullState;
  /** Caller-owned: called once when the user confirms the import. */
  onConfirm: () => void;
  /** Trigger element (passed via Radix `asChild`). Caller supplies the Button. */
  children: ReactNode;
}

export function ImportConfirmDialog({
  findings,
  niosServerMetrics,
  adServerMetrics,
  existing,
  onConfirm,
  children,
}: ImportConfirmDialogProps) {
  const { willAdd, preserved } = useMemo(() => {
    // Build the incoming tree once (D-17: pure function, no live-state reads).
    const incoming = importFromScan(
      findings,
      niosServerMetrics,
      adServerMetrics,
    );
    // Merge against the existing state so dedup-skipped entities are excluded
    // from the will-add tally (D-12).
    const merged = mergeFullState(existing, incoming);
    const before = countTree(existing);
    const after = countTree(merged);
    return {
      willAdd: {
        regions: Math.max(0, after.regions - before.regions),
        sites: Math.max(0, after.sites - before.sites),
        niosx: Math.max(0, after.niosx - before.niosx),
      },
      preserved: before,
    };
  }, [findings, niosServerMetrics, adServerMetrics, existing]);

  const summaryText =
    `Will add: ${willAdd.regions} Regions, ${willAdd.sites} Sites, ` +
    `${willAdd.niosx} NIOS-X systems. ` +
    `Existing Sizer data (${preserved.regions} Regions, ${preserved.sites} Sites, ` +
    `${preserved.niosx} NIOS-X) will be preserved.`;

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent data-testid="sizer-import-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Import scan results into Sizer?</AlertDialogTitle>
          <AlertDialogDescription data-testid="sizer-import-summary">
            {summaryText}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="sizer-import-cancel">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="sizer-import-confirm"
            onClick={onConfirm}
          >
            Import &amp; open Sizer
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
