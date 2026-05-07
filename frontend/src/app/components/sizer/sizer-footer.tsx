/**
 * sizer-footer.tsx — Sticky bottom Back/Next buttons.
 *
 * Per UI-SPEC §3.2 and D-23:
 *   - Back at Step 1 calls `onRetreat` (returns to outer wizard) when provided.
 *   - Next at Step 4 calls `onAdvance` (jumps to outer Results & Export) when
 *     provided; legacy bespoke Sizer Step 5 retired 2026-04-26.
 *   - Validation is advisory, never blocking.
 */
import { Button } from '../ui/button';
import { useSizer } from './sizer-state';

interface SizerFooterProps {
  onAdvance?: () => void;
  onRetreat?: () => void;
}

export function SizerFooter({ onAdvance, onRetreat }: SizerFooterProps = {}) {
  const { state, dispatch } = useSizer();
  const active = state.ui.activeStep;

  const goBack = () => {
    if (active <= 1) {
      onRetreat?.();
      return;
    }
    dispatch({ type: 'SET_ACTIVE_STEP', step: (active - 1) as 1 | 2 | 3 | 4 });
  };
  const goNext = () => {
    if (active >= 4) {
      onAdvance?.();
      return;
    }
    dispatch({ type: 'SET_ACTIVE_STEP', step: (active + 1) as 1 | 2 | 3 | 4 });
  };

  const nextLabel = active === 4 ? 'View Report →' : 'Next →';
  const backDisabled = active === 1 && !onRetreat;
  const nextDisabled = active === 4 && !onAdvance;

  return (
    <div className="sticky bottom-0 z-20 flex items-center justify-between bg-card border-t px-6 h-16">
      <Button
        type="button"
        variant="outline"
        disabled={backDisabled}
        onClick={goBack}
        data-testid="sizer-footer-back"
      >
        ← Back
      </Button>
      <Button
        type="button"
        onClick={goNext}
        disabled={nextDisabled}
        data-testid="sizer-footer-next"
      >
        {nextLabel}
      </Button>
    </div>
  );
}
