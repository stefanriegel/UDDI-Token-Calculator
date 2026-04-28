/**
 * derived-badge.tsx — Accent-tinted chip marking an auto-derived Site field.
 *
 * Per UI-SPEC §2.1 (accent reservation list, item 2) and §5.4:
 *   - Renders a Sparkles icon + "Derived" label.
 *   - Background / text / border use the reserved Infoblox accent orange
 *     via `bg-accent/10 text-accent border-accent/30`.
 *   - Hover / focus tooltip reads: "Auto-derived from Users. Edit to override."
 *
 * Consumer contract (Plan 30-04, §5.2): render this badge next to the label
 * of every derived field; unmount (don't hide) when the user overrides the
 * field. The parent decides whether the badge is present — this component
 * has no internal toggle.
 */
import { Sparkles } from 'lucide-react';

import { Badge } from '../../ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '../../ui/tooltip';
import { cn } from '../../ui/utils';

export interface DerivedBadgeProps {
  /** Optional test id suffix (e.g. the field key). */
  testId?: string;
  /** Optional extra className, merged after the accent tint. */
  className?: string;
}

export function DerivedBadge({ testId, className }: DerivedBadgeProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          aria-label="Auto-derived from users"
          data-testid={testId}
          className={cn(
            'bg-accent/10 text-accent border-accent/30 rounded-sm gap-1',
            className,
          )}
        >
          <Sparkles className="size-3" aria-hidden="true" />
          <span>Derived</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top">
        Auto-derived from Users. Edit to override.
      </TooltipContent>
    </Tooltip>
  );
}
