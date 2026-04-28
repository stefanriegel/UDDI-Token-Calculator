/**
 * section-growth.tsx — Step 4 Section B: Growth Buffer.
 *
 * Per UI-SPEC §7.2 and D-19:
 *   - Single Radix Slider 0-50%, step 1%, accent-filled track.
 *   - Big value readout right-aligned (e.g. "10 %").
 *   - "Advanced…" link toggles `ui.growthBufferAdvanced`.
 *   - When advanced: 4 per-category Sliders (mgmt / server / reporting / security)
 *     each with a `RotateCcw` reset icon that clears the per-category override.
 *
 * Dispatches SET_GROWTH_BUFFER / SET_OVERHEAD / TOGGLE_GROWTH_ADVANCED. The
 * outer `<Collapsible>` is owned by `sizer-step-settings.tsx`.
 */
import { RotateCcw } from 'lucide-react';

import { useSizer } from '../sizer-state';
import { Slider } from '../../ui/slider';
import { Button } from '../../ui/button';
import { Label } from '../../ui/label';
import { cn } from '../../ui/utils';

type Category = 'mgmt' | 'server' | 'reporting' | 'security';

const CATEGORY_LABELS: Record<Category, string> = {
  mgmt: 'Management',
  server: 'Server',
  reporting: 'Reporting',
  security: 'Security',
};

function pct(v: number): string {
  return `${Math.round(v * 100)} %`;
}

export function SectionGrowth() {
  const { state, dispatch } = useSizer();
  const g = state.core.globalSettings;
  const advanced = state.ui.growthBufferAdvanced;

  const setBuffer = (v: number) =>
    dispatch({ type: 'SET_GROWTH_BUFFER', value: v });

  const setOverhead = (cat: Category, v?: number) =>
    dispatch({ type: 'SET_OVERHEAD', category: cat, value: v });

  const categoryValue = (cat: Category): number | undefined => {
    switch (cat) {
      case 'mgmt':
        return g.mgmtOverhead;
      case 'server':
        return g.serverOverhead;
      case 'reporting':
        return g.reportingOverhead;
      case 'security':
        return g.securityOverhead;
    }
  };

  return (
    <div data-testid="sizer-step4-section-growth-body" className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="sizer-growth-slider" className="text-sm font-medium">
          Growth Buffer
        </Label>
        <span
          data-testid="sizer-growth-slider-value"
          className="text-lg font-semibold tabular-nums text-primary"
        >
          {pct(g.growthBuffer)}
        </span>
      </div>

      <Slider
        id="sizer-growth-slider"
        data-testid="sizer-growth-slider"
        min={0}
        max={50}
        step={1}
        value={[Math.round(g.growthBuffer * 100)]}
        onValueChange={(vals) => setBuffer((vals[0] ?? 0) / 100)}
        aria-label="Growth Buffer"
      />

      <div>
        <Button
          variant="link"
          size="sm"
          type="button"
          data-testid="sizer-growth-advanced-toggle"
          onClick={() => dispatch({ type: 'TOGGLE_GROWTH_ADVANCED' })}
          className="px-0"
        >
          {advanced ? 'Hide advanced' : 'Advanced…'}
        </Button>
        <p className="text-xs text-muted-foreground">
          Per-category overrides fall back to the global Growth Buffer when blank.
        </p>
      </div>

      {advanced ? (
        <div
          data-testid="sizer-growth-advanced"
          className="grid gap-4 pt-2 border-t border-border/50"
        >
          {(Object.keys(CATEGORY_LABELS) as Category[]).map((cat) => {
            const v = categoryValue(cat);
            const effective = v ?? g.growthBuffer;
            const isOverridden = v !== undefined;
            return (
              <div key={cat} className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label
                    htmlFor={`sizer-growth-advanced-${cat}`}
                    className="text-xs font-medium"
                  >
                    {CATEGORY_LABELS[cat]} overhead
                  </Label>
                  <div className="flex items-center gap-2">
                    <span
                      data-testid={`sizer-growth-advanced-${cat}-value`}
                      className={cn(
                        'text-sm tabular-nums',
                        isOverridden ? 'text-primary font-semibold' : 'text-muted-foreground',
                      )}
                    >
                      {pct(effective)}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      data-testid={`sizer-growth-advanced-${cat}-reset`}
                      aria-label={`Reset ${CATEGORY_LABELS[cat]} overhead`}
                      disabled={!isOverridden}
                      onClick={() => setOverhead(cat, undefined)}
                      className="size-7"
                    >
                      <RotateCcw className="size-3.5" />
                    </Button>
                  </div>
                </div>
                <Slider
                  id={`sizer-growth-advanced-${cat}`}
                  data-testid={`sizer-growth-advanced-${cat}`}
                  min={0}
                  max={50}
                  step={1}
                  value={[Math.round(effective * 100)]}
                  onValueChange={(vals) => setOverhead(cat, (vals[0] ?? 0) / 100)}
                  aria-label={`${CATEGORY_LABELS[cat]} overhead`}
                />
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
