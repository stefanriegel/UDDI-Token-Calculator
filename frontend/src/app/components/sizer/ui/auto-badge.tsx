/**
 * AutoBadge — accent-tinted chip shown next to auto-filled inputs. Per
 * UI-SPEC §7.3 (Step 4 Security) and D-20: rendered while the underlying
 * field is still flagged `ui.securityAutoFilled.*`; disappears on manual edit.
 *
 * Wraps shadcn `<Badge>` with an Infoblox accent tint and a tooltip explaining
 * the source of the value.
 */
import { Badge } from '../../ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '../../ui/tooltip';
import { cn } from '../../ui/utils';

export interface AutoBadgeProps {
  /** Optional testid suffix, e.g. `"verified"` → `sizer-security-auto-badge-verified`. */
  field?: string;
  className?: string;
  /** Override default tooltip copy. */
  tooltip?: string;
}

export function AutoBadge({
  field,
  className,
  tooltip = 'Auto-filled from site assets. Edit to lock.',
}: AutoBadgeProps) {
  const testId = field
    ? `sizer-security-auto-badge-${field}`
    : 'sizer-auto-badge';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          data-testid={testId}
          variant="outline"
          className={cn(
            'border-accent/40 bg-accent/10 text-accent-foreground text-[10px] leading-none px-1.5 py-0.5',
            className,
          )}
        >
          Auto
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
