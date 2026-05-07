// ResultsExportBar — section-export. Extracted from wizard.tsx Step 5 in Phase 33 (D-13/D-15).
//
// Renders the Download XLSX primary CTA and an optional Start Over destructive
// AlertDialog. Mode-specific copy (per UI-SPEC Copywriting) defaults differ
// between scan vs sizer; callers can override with `resetCopy`.

import { useState } from 'react';
import { Download, FileSpreadsheet, RotateCcw, Save } from 'lucide-react';
import type { ResultsMode } from './results-types';
import { Button } from '../ui/button';
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

// ── Default copy per UI-SPEC Copywriting ──────────────────────────────────────

const DEFAULT_RESET_COPY: Record<ResultsMode, ResetCopy> = {
  scan: {
    title: 'Start Over?',
    description:
      'This clears scan results from this session. Credentials remain server-side.',
    cancel: 'Cancel',
    confirm: 'Reset',
  },
  sizer: {
    title: 'Start Over?',
    description:
      'This clears Sizer state stored in this browser. Your inputs cannot be recovered.',
    cancel: 'Cancel',
    confirm: 'Reset',
  },
};

interface ResetCopy {
  title: string;
  description: string;
  cancel: string;
  confirm: string;
}

// ── Props ────────────────────────────────────────────────────────────────────

export interface ResultsExportBarProps {
  mode: ResultsMode;
  onExport: () => void | Promise<void>;
  exportLabel?: string;
  /** When provided, the Start Over AlertDialog button is rendered. */
  onReset?: () => void;
  /** Override the default mode-specific reset copy. */
  resetCopy?: ResetCopy;
  /** When provided, renders a Download CSV button next to Download XLSX. */
  onDownloadCSV?: () => void | Promise<void>;
  /** When provided, renders a Save Session button (downloads JSON snapshot). */
  onSaveSession?: () => void | Promise<void>;
}

// ── Component ────────────────────────────────────────────────────────────────

export function ResultsExportBar(props: ResultsExportBarProps) {
  const {
    mode,
    onExport,
    exportLabel = 'Download XLSX',
    onReset,
    resetCopy,
    onDownloadCSV,
    onSaveSession,
  } = props;

  const [exporting, setExporting] = useState(false);
  const copy = resetCopy ?? DEFAULT_RESET_COPY[mode];

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await onExport();
    } catch (err) {
      // Surface error inline — wizard / sizer callers wire their own toast layer
      // around `onExport`, so we only need to ensure the button re-enables.
      // eslint-disable-next-line no-console
      console.error('ResultsExportBar onExport failed', err);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div
      id="section-export"
      className="scroll-mt-6 flex flex-col sm:flex-row items-stretch sm:items-center gap-3"
    >
      {onDownloadCSV && (
        <Button
          onClick={() => void onDownloadCSV()}
          className="flex items-center justify-center gap-2 px-5 py-3 bg-[var(--infoblox-navy)] text-white rounded-xl hover:bg-[var(--infoblox-navy)]/90 transition-colors"
          style={{ fontWeight: 500 }}
        >
          <Download className="w-4 h-4" />
          Download CSV
        </Button>
      )}

      <Button
        onClick={handleExport}
        disabled={exporting}
        className="flex items-center justify-center gap-2 px-5 py-3 bg-[var(--infoblox-green)] text-white rounded-xl hover:bg-[var(--infoblox-green)]/90 transition-colors disabled:opacity-60"
        style={{ fontWeight: 500 }}
      >
        <FileSpreadsheet className="w-4 h-4" />
        {exporting ? 'Preparing…' : exportLabel}
      </Button>

      {onSaveSession && (
        <Button
          onClick={() => void onSaveSession()}
          className="flex items-center justify-center gap-2 px-5 py-3 bg-[var(--infoblox-navy)] text-white rounded-xl hover:bg-[var(--infoblox-navy)]/90 transition-colors opacity-80"
          style={{ fontWeight: 500 }}
        >
          <Save className="w-4 h-4" />
          Save Session
        </Button>
      )}

      {onReset && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              className="flex items-center justify-center gap-2 px-5 py-3 bg-white border border-[var(--border)] text-[var(--foreground)] rounded-xl hover:bg-gray-50 transition-colors"
              style={{ fontWeight: 500 }}
            >
              <RotateCcw className="w-4 h-4" />
              Start Over
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{copy.title}</AlertDialogTitle>
              <AlertDialogDescription>{copy.description}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{copy.cancel}</AlertDialogCancel>
              <AlertDialogAction
                onClick={onReset}
                className="bg-red-600 text-white hover:bg-red-700"
              >
                {copy.confirm}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
