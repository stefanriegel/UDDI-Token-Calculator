/**
 * sizer-validation-banner.tsx — Production validation banner (plan 30-07).
 *
 * Per UI-SPEC §8 and CONTEXT D-25 / D-26 / D-27 + RESEARCH P-10:
 *   - Memoized `validate(state.core)` output, filtered by `ui.dismissedCodes`.
 *   - Amber tint when only warnings, red when any error.
 *   - 160px max height, internal `<ScrollArea>`.
 *   - Row per issue: severity icon + message + `[Go to]` + `[×]`.
 *   - `[Go to]`:
 *       1. `stepForPath(issue.path)` → dispatch SET_ACTIVE_STEP.
 *       2. dispatch SET_SELECTED_PATH(issue.path).
 *       3. After rAF × 2, query `[data-sizer-path="…"]`, scrollIntoView,
 *          focus the element (P-10 — focus after scroll), add `.sizer-pulse`
 *          for 1.2s.
 *   - `[×]` dispatches DISMISS_ISSUE(code). Dismissal auto-clears in an
 *     effect: if a dismissed code re-appears with a different message (state
 *     changed re-triggered it), dispatch UNDISMISS_ISSUE (D-27).
 *   - `role="region"` with `aria-label="Validation issues"`.
 *   - STATE_EMPTY is suppressed (the Step-1 empty-state CTA already prompts
 *     the user to add a Region — don't double up).
 *   - Infrastructure-related warnings (SITE_UNASSIGNED, OBJECT_COUNT_MISMATCH)
 *     are step-aware (issue #27): suppressed while activeStep < 3 so the user
 *     isn't warned about missing infra before reaching the Infrastructure step.
 *     Errors and other warnings still surface immediately on every step.
 */
import { useEffect, useMemo, useRef } from 'react';
import { AlertOctagon, AlertTriangle, X } from 'lucide-react';

import { Button } from '../ui/button';
import { ScrollArea } from '../ui/scroll-area';
import { cn } from '../ui/utils';
import { useSizer } from './sizer-state';
import { validate, VALIDATION_CODES } from './sizer-validate';
import type { Issue } from './sizer-types';

/**
 * Pure helper mapping a validate()-emitted `issue.path` to the wizard step
 * that owns the offending node. Exported for unit testing.
 *
 * Examples:
 *   "regions[0]"                           → 1
 *   "regions[0].countries[0].cities[0].sites[0]" → 2
 *   "infrastructure.xaas[0]"               → 3
 *   "infrastructure"                       → 3
 *   "security"                             → 4
 */
/**
 * Codes that depend on the user having reached Step 3 (Infrastructure) — see
 * issue #27. Suppressed when activeStep < 3 so the banner doesn't warn about
 * missing infra before the user can plausibly have configured any.
 */
const INFRA_DEFERRED_CODES: readonly string[] = [
  VALIDATION_CODES.SITE_UNASSIGNED,
  VALIDATION_CODES.OBJECT_COUNT_MISMATCH,
];

function isSuppressedForStep(code: string, activeStep: 1 | 2 | 3 | 4): boolean {
  return activeStep < 3 && INFRA_DEFERRED_CODES.includes(code);
}

/**
 * Hook returning a `Map<path, Issue>` for the currently active (non-dismissed)
 * issues. Step-1..4 files use this to render `<InlineMarker>` next to the
 * offending DOM node without threading state through props.
 */
export function useActiveIssuesByPath(): Map<string, Issue> {
  const { state } = useSizer();
  const { errors, warnings } = useMemo(() => validate(state.core), [state.core]);
  const dismissed = state.ui.dismissedCodes;
  const activeStep = state.ui.activeStep;
  return useMemo(() => {
    const map = new Map<string, Issue>();
    for (const i of [...errors, ...warnings]) {
      if (dismissed.includes(i.code)) continue;
      if (isSuppressedForStep(i.code, activeStep)) continue;
      // First-wins: multiple issues may share a path; marker shows the first.
      if (!map.has(i.path)) map.set(i.path, i);
    }
    return map;
  }, [errors, warnings, dismissed, activeStep]);
}

export function stepForPath(path: string): 1 | 2 | 3 | 4 {
  if (!path) return 1;
  if (path.startsWith('infrastructure')) return 3;
  if (path.startsWith('security')) return 4;
  if (path.startsWith('regions')) {
    return path.includes('.sites[') ? 2 : 1;
  }
  return 1;
}

const PULSE_MS = 1200;

function cssEscape(v: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(v);
  }
  return v.replace(/["\\]/g, '\\$&');
}

export function SizerValidationBanner() {
  const { state, dispatch } = useSizer();

  const { errors, warnings } = useMemo(() => validate(state.core), [state.core]);

  const dismissed = state.ui.dismissedCodes;

  // All issues in a stable order — errors first, warnings second.
  const allIssues: Issue[] = useMemo(
    () => [...errors, ...warnings],
    [errors, warnings],
  );

  // Auto-clear dismissal when a dismissed code's message changed (re-triggered
  // by a new state). Tracks last-seen message per code; mismatch → UNDISMISS.
  const lastMessagesRef = useRef<Record<string, string>>({});
  useEffect(() => {
    const prev = lastMessagesRef.current;
    const next: Record<string, string> = {};
    for (const issue of allIssues) {
      next[issue.code] = issue.message;
    }
    for (const code of dismissed) {
      const curMessage = next[code];
      const prevMessage = prev[code];
      if (curMessage !== undefined && prevMessage !== undefined && curMessage !== prevMessage) {
        dispatch({ type: 'UNDISMISS_ISSUE', code });
      }
    }
    lastMessagesRef.current = next;
  }, [allIssues, dismissed, dispatch]);

  const activeStep = state.ui.activeStep;
  const visibleIssues: Issue[] = useMemo(
    () =>
      allIssues.filter(
        (i) => !dismissed.includes(i.code) && !isSuppressedForStep(i.code, activeStep),
      ),
    [allIssues, dismissed, activeStep],
  );

  // Suppress STATE_EMPTY single-issue case — the Step 1 empty-state CTA is
  // the primary affordance and a banner row would double up the prompt.
  const effective: Issue[] = useMemo(() => {
    if (
      visibleIssues.length === 1 &&
      visibleIssues[0].code === VALIDATION_CODES.STATE_EMPTY
    ) {
      return [];
    }
    return visibleIssues;
  }, [visibleIssues]);

  if (effective.length === 0) return null;

  const hasError = effective.some((i) => i.severity === 'error');

  const goTo = (issue: Issue) => {
    const step = stepForPath(issue.path);
    dispatch({ type: 'SET_ACTIVE_STEP', step });
    dispatch({ type: 'SET_SELECTED_PATH', path: issue.path });

    if (typeof window === 'undefined') return;

    // Double-rAF to wait for step switch to paint before querying target.
    const tryScroll = () => {
      if (typeof document === 'undefined') return;
      const target = document.querySelector<HTMLElement>(
        `[data-sizer-path="${cssEscape(issue.path)}"]`,
      );
      if (!target) return;
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // P-10: focus AFTER scroll so the browser doesn't re-scroll on focus.
      // Use focus({preventScroll:true}) to be safe when available.
      try {
        target.focus({ preventScroll: true } as FocusOptions);
      } catch {
        target.focus();
      }
      target.classList.add('sizer-pulse');
      window.setTimeout(() => {
        target.classList.remove('sizer-pulse');
      }, PULSE_MS);
    };

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(tryScroll);
    });
  };

  return (
    <div
      role="region"
      aria-label="Validation issues"
      data-testid="sizer-validation-banner"
      className={cn(
        'sticky top-14 z-30 border-b',
        hasError ? 'bg-red-50 border-red-300' : 'bg-amber-50 border-amber-300',
      )}
    >
      <ScrollArea className="max-h-40">
        <ul className="divide-y divide-black/5">
          {effective.map((issue) => (
            <li
              key={issue.code + '|' + issue.path}
              role="alert"
              data-testid={`sizer-validation-row-${issue.code}`}
              className="flex items-start gap-3 px-4 py-2 min-h-10 text-sm"
            >
              {issue.severity === 'error' ? (
                <AlertOctagon
                  className="size-4 text-destructive shrink-0 mt-0.5"
                  aria-hidden="true"
                />
              ) : (
                <AlertTriangle
                  className="size-4 text-amber-700 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
              )}
              <span className="flex-1 min-w-0 break-words">{issue.message}</span>
              <Button
                type="button"
                variant="link"
                size="sm"
                data-testid={`sizer-validation-goto-${issue.code}`}
                onClick={() => goTo(issue)}
              >
                Go to
              </Button>
              <button
                type="button"
                aria-label="Dismiss"
                data-testid={`sizer-validation-dismiss-${issue.code}`}
                className="rounded p-1 hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() =>
                  dispatch({ type: 'DISMISS_ISSUE', code: issue.code })
                }
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </div>
  );
}
