/**
 * sizer-stepper.tsx — Custom WAI-ARIA tablist stepper for the Sizer wizard.
 *
 * Per UI-SPEC §3.1 and CONTEXT D-22 / D-23 / D-24:
 *   - Five labels: "1 Regions", "2 Sites", "3 Infrastructure", "4 Settings",
 *     "5 Results". All five enabled as of Phase 31 (Plan 31-07).
 *   - Click-to-jump — no linear gating, validation is advisory only (D-23).
 *   - Active-step state lives in reducer (`ui.activeStep`) (D-24).
 *   - ARIA Tabs keyboard pattern: ArrowLeft/Right cycles enabled steps, Home→1,
 *     End→last enabled. Enter/Space activates.
 */
import { useCallback, useMemo } from 'react';
import { CheckCircle2 } from 'lucide-react';

import { cn } from '../ui/utils';
import { useSizer, type SizerFullState } from './sizer-state';

export const STEPPER_PANEL_ID = 'sizer-step-panel';
export const STEPPER_BUTTON_ID = (n: number) => `sizer-stepper-button-${n}`;

interface StepDef {
  n: 1 | 2 | 3 | 4;
  label: string;
  disabled?: boolean;
}

const STEPS: StepDef[] = [
  { n: 1, label: '1 Regions' },
  { n: 2, label: '2 Sites' },
  { n: 3, label: '3 Infrastructure' },
  { n: 4, label: '4 Settings' },
];

export function SizerStepper() {
  const { state, dispatch } = useSizer();
  const active = state.ui.activeStep;

  const enabledSteps = useMemo(() => STEPS.filter((s) => !s.disabled), []);

  const jumpTo = useCallback(
    (n: 1 | 2 | 3 | 4) => {
      dispatch({ type: 'SET_ACTIVE_STEP', step: n });
    },
    [dispatch],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const idx = enabledSteps.findIndex((s) => s.n === active);
      let nextIdx = idx;
      if (e.key === 'ArrowRight') {
        nextIdx = Math.min(enabledSteps.length - 1, idx + 1);
      } else if (e.key === 'ArrowLeft') {
        nextIdx = Math.max(0, idx - 1);
      } else if (e.key === 'Home') {
        nextIdx = 0;
      } else if (e.key === 'End') {
        nextIdx = enabledSteps.length - 1;
      } else {
        return;
      }
      e.preventDefault();
      const target = enabledSteps[nextIdx];
      if (target && target.n !== active) {
        jumpTo(target.n);
      }
      // Move DOM focus to the newly active tab.
      requestAnimationFrame(() => {
        const el = document.getElementById(STEPPER_BUTTON_ID(target.n));
        el?.focus();
      });
    },
    [active, enabledSteps, jumpTo],
  );

  return (
    <div className="sticky top-0 z-40 bg-white border-b border-[var(--border)]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center">
        <div
          role="tablist"
          aria-label="Sizer wizard steps"
          data-testid="sizer-stepper"
          onKeyDown={onKeyDown}
          className="flex items-center justify-between w-full"
        >
          {STEPS.map((step, i) => {
            const isActive = active === step.n;
            const isCompleted = !step.disabled && active > step.n;
            const isDisabled = !!step.disabled;
            return (
              <div key={step.n} className="flex items-center flex-1 last:flex-none">
                <button
                  id={STEPPER_BUTTON_ID(step.n)}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={STEPPER_PANEL_ID}
                  aria-disabled={isDisabled || undefined}
                  tabIndex={isActive ? 0 : -1}
                  data-testid={`sizer-stepper-step-${step.n}`}
                  title={isDisabled ? 'Available after Phase 31' : undefined}
                  onClick={() => {
                    if (isDisabled) return;
                    jumpTo(step.n);
                  }}
                  className={cn(
                    'flex items-center gap-2 transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded',
                    isDisabled && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  <span
                    className={cn(
                      'w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-colors',
                      isCompleted
                        ? 'bg-[var(--infoblox-green)] text-white'
                        : isActive
                          ? 'bg-[var(--infoblox-orange)] text-white'
                          : 'bg-gray-200 text-gray-400',
                    )}
                    aria-hidden="true"
                  >
                    {isCompleted ? (
                      <CheckCircle2 className="w-4 h-4" />
                    ) : (
                      <span className="text-[12px] font-semibold">{step.n}</span>
                    )}
                  </span>
                  <span
                    className={cn(
                      'text-[13px] truncate',
                      isActive ? 'block' : 'hidden sm:block',
                      isActive
                        ? 'text-[var(--foreground)] font-semibold'
                        : isCompleted
                          ? 'text-emerald-700'
                          : 'text-gray-600',
                    )}
                    data-testid={`sizer-stepper-label-${step.n}`}
                  >
                    {step.label.replace(/^\d+\s/, '')}
                  </span>
                </button>
                {i < STEPS.length - 1 && (
                  <div
                    className={cn(
                      'flex-1 h-[2px] mx-3 rounded',
                      isCompleted ? 'bg-[var(--infoblox-green)]' : 'bg-gray-200',
                    )}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Exposed for Step 4 "Review" label computation. */
export function isLastContentStep(s: SizerFullState): boolean {
  return s.ui.activeStep === 4;
}
