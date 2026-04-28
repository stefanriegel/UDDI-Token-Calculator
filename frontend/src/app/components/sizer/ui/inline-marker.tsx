/**
 * inline-marker.tsx — Inline warning/error marker for tree nodes and form fields.
 *
 * Per UI-SPEC §8.3 and CONTEXT D-26:
 *   - 14px Lucide `AlertTriangle` (warning) or `AlertOctagon` (error).
 *   - Tooltip (hover/focus) shows `issue.message`.
 *   - Click scrolls to the matching banner row (`sizer-validation-row-{code}`)
 *     and focuses its `[Go to]` button.
 *   - `data-testid="sizer-inline-marker-{path}"` — the path is URL-unsafe but
 *     good enough for a DOM testid (React doesn't sanitize test IDs).
 *
 * Plan 30-07.
 */
import { AlertOctagon, AlertTriangle } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip';
import { cn } from '../../ui/utils';
import type { Issue } from '../sizer-types';

export interface InlineMarkerProps {
  issue: Issue;
  className?: string;
}

export function InlineMarker({ issue, className }: InlineMarkerProps) {
  const Icon = issue.severity === 'error' ? AlertOctagon : AlertTriangle;
  const colorCls =
    issue.severity === 'error' ? 'text-destructive' : 'text-amber-700';

  const handleClick = () => {
    if (typeof document === 'undefined') return;
    const row = document.querySelector<HTMLElement>(
      `[data-testid="sizer-validation-row-${cssEscape(issue.code)}"]`,
    );
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const gotoBtn = row.querySelector<HTMLElement>(
      `[data-testid="sizer-validation-goto-${cssEscape(issue.code)}"]`,
    );
    gotoBtn?.focus();
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${issue.severity === 'error' ? 'Error' : 'Warning'}: ${issue.message}`}
          data-testid={`sizer-inline-marker-${issue.path}`}
          onClick={(e) => {
            e.stopPropagation();
            handleClick();
          }}
          className={cn(
            // 44px touch target per a11y exception — marker icon is 14px centred.
            'inline-flex items-center justify-center min-w-11 min-h-11 -m-3',
            'rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className,
          )}
        >
          <Icon
            className={cn('size-3.5 shrink-0', colorCls)}
            aria-hidden="true"
          />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        {issue.message}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Escape a value for use inside a CSS attribute selector `[attr="…"]`.
 * Covers the characters issue codes and paths may contain (/, [, ], .).
 */
function cssEscape(v: string): string {
  // Use native CSS.escape when available; fallback to a conservative regex for
  // the JSDOM test environment where CSS.escape may be polyfilled.
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(v);
  }
  return v.replace(/["\\]/g, '\\$&');
}
