/**
 * clone-popover.tsx — "+ Clone ×N" popover for Site cloning.
 *
 * Per UI-SPEC §5.3 and CONTEXT D-15:
 *   - Anchor / trigger is supplied by the caller via `children` so the button
 *     can live in either the Site tree row or the detail-pane header.
 *   - Content: number input (min 1, max 50, default 1) + Clone button +
 *     helper "New sites named '{orig} (2)', '{orig} (3)' …".
 *   - On submit: dispatches `CLONE_SITE` and closes the popover. Focus moves
 *     back to the trigger via Radix default behaviour — the reducer appends
 *     clones to the parent City so the tree picks them up naturally.
 *   - Out-of-range values clamp to [1, 50]; non-numeric input clamps to 1.
 *
 * Test IDs:
 *   - sizer-site-clone-popover        — the trigger
 *   - sizer-site-clone-count          — the number input
 *   - sizer-site-clone-submit         — the submit button
 */
import { useState, type ReactNode } from 'react';

import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../../ui/popover';
import { useSizer } from '../sizer-state';

export interface ClonePopoverProps {
  siteId: string;
  siteName: string;
  /** The popover trigger (typically a `<Button>` "+ Clone ×N"). */
  children: ReactNode;
}

const MIN = 1;
const MAX = 50;

export function ClonePopover({ siteId, siteName, children }: ClonePopoverProps) {
  const { dispatch } = useSizer();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState<number>(1);

  const clamp = (n: number): number => {
    if (!Number.isFinite(n)) return MIN;
    return Math.max(MIN, Math.min(MAX, Math.floor(n)));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = clamp(count);
    dispatch({ type: 'CLONE_SITE', siteId, count: n });
    setOpen(false);
    setCount(1);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild data-testid="sizer-site-clone-popover">
        {children}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`clone-count-${siteId}`}>Number of clones</Label>
            <Input
              id={`clone-count-${siteId}`}
              data-testid="sizer-site-clone-count"
              type="number"
              min={MIN}
              max={MAX}
              value={count}
              aria-label="Number of clones"
              onChange={(e) => setCount(Number(e.target.value))}
            />
            <p className="text-xs text-muted-foreground">
              {`New sites named '${siteName} (2)', '${siteName} (3)' …`}
            </p>
          </div>
          <div className="flex justify-end">
            <Button
              type="submit"
              size="sm"
              data-testid="sizer-site-clone-submit"
            >
              Clone
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
