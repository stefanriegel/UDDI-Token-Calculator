/**
 * sizer-results-view.tsx — Standalone wrapper that renders the Sizer report
 * outside the Sizer wizard route.
 *
 * Mounts its own SizerProvider so the unified <ResultsSurface mode="sizer">
 * has a context to read from. Hydrates from sessionStorage (STORAGE_KEY), so
 * the data shown matches whatever the user just configured in Steps 1–4.
 *
 * Used by the outer wizard's "Results & Export" step in estimator-only mode
 * (Sizer Step 5 was retired 2026-04-26).
 */
import { SizerProvider } from './sizer-state';
import { SizerStepResults } from './sizer-step-results';

interface SizerResultsViewProps {
  /** Fired after Start Over clears Sizer state — typically the outer
   * wizard's `restart()` so the user lands on Adapter Selection. */
  onResetNavigate?: () => void;
}

export function SizerResultsView({ onResetNavigate }: SizerResultsViewProps = {}) {
  return (
    <SizerProvider>
      <SizerStepResults onResetNavigate={onResetNavigate} />
    </SizerProvider>
  );
}
