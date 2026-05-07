/**
 * sizer-step-settings.tsx — Step 4: Settings + Security.
 *
 * Per UI-SPEC §7 and CONTEXT D-18..D-21:
 *   - Three Radix Collapsibles in fixed order: Modules → Growth → Security.
 *   - Open state bound to `ui.sectionsOpen.{modules|growth|security}` via
 *     TOGGLE_SECTION. All default open on first visit (initialSizerState
 *     from plan 30-02).
 *   - Sub-sections are implemented in `step-settings/section-*.tsx` (SIZER-11).
 */
import { ChevronDown } from 'lucide-react';

import { useSizer } from './sizer-state';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/collapsible';
import { Card, CardContent } from '../ui/card';
import { cn } from '../ui/utils';
import { SectionModules } from './step-settings/section-modules';
import { SectionGrowth } from './step-settings/section-growth';
import { SectionSecurity } from './step-settings/section-security';

type SectionKey = 'modules' | 'growth' | 'security';

interface SectionShellProps {
  sectionKey: SectionKey;
  title: string;
  testId: string;
  children: React.ReactNode;
}

function SectionShell({ sectionKey, title, testId, children }: SectionShellProps) {
  const { state, dispatch } = useSizer();
  const open = state.ui.sectionsOpen[sectionKey];
  return (
    <Card data-testid={testId} data-open={open ? 'true' : 'false'}>
      <Collapsible
        open={open}
        onOpenChange={() =>
          dispatch({ type: 'TOGGLE_SECTION', section: sectionKey })
        }
      >
        <CollapsibleTrigger
          data-testid={`${testId}-trigger`}
          aria-expanded={open}
          className="w-full flex items-center justify-between px-5 py-4 hover:bg-secondary/40 transition-colors rounded-t-md"
        >
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          <ChevronDown
            className={cn(
              'size-4 text-muted-foreground transition-transform',
              open ? 'rotate-180' : 'rotate-0',
            )}
            aria-hidden="true"
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0 pb-5 px-5">{children}</CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

export function SizerStepSettings() {
  return (
    <div data-testid="sizer-step-settings" className="space-y-4">
      <SectionShell
        sectionKey="modules"
        title="Modules & Logging"
        testId="sizer-step4-section-modules"
      >
        <SectionModules />
      </SectionShell>

      <SectionShell
        sectionKey="growth"
        title="Growth Buffer"
        testId="sizer-step4-section-growth"
      >
        <SectionGrowth />
      </SectionShell>

      <SectionShell
        sectionKey="security"
        title="Security"
        testId="sizer-step4-section-security"
      >
        <SectionSecurity />
      </SectionShell>
    </div>
  );
}
