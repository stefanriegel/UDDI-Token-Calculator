/**
 * sizer-wizard.tsx — Shell: SizerProvider + Stepper + ValidationBanner + step
 * body switch + Footer.
 *
 * Per UI-SPEC §3 and CONTEXT D-05 / D-22 / D-23 / D-24:
 *   - Renders its own SizerProvider so the component is consumable by either
 *     the scan wizard route (plan 30-08) or a scratch route for smoke testing.
 *   - Layout: sticky stepper (z-40), sticky banner (z-30), step body,
 *     sticky footer (z-20). Step body is a tabpanel per ARIA Tabs pattern.
 *   - Steps 2-4 render `coming soon` placeholders — filled in by plans 30-04,
 *     30-05, 30-06. Step 5 renders the Phase 31 SizerStepResults composite.
 *
 * NOTE: This file does NOT modify `wizard.tsx` — that is plan 30-08 exclusively.
 */
import { SizerProvider, useSizer } from './sizer-state';
import {
  SizerStepper,
  STEPPER_PANEL_ID,
  STEPPER_BUTTON_ID,
} from './sizer-stepper';
import { SizerFooter } from './sizer-footer';
import { SizerValidationBanner } from './sizer-validation-banner';
import { SizerStepRegions } from './sizer-step-regions';
import { SizerStepSites } from './sizer-step-sites';
import { SizerStepInfra } from './sizer-step-infra';
import { SizerStepSettings } from './sizer-step-settings';

interface SizerWizardProps {
  onAdvance?: () => void;
  onRetreat?: () => void;
}

function SizerWizardInner({ onAdvance, onRetreat }: SizerWizardProps) {
  const { state } = useSizer();
  const step = state.ui.activeStep;

  let body: React.ReactNode;
  switch (step) {
    case 1:
      body = <SizerStepRegions />;
      break;
    case 2:
      body = <SizerStepSites />;
      break;
    case 3:
      body = <SizerStepInfra />;
      break;
    case 4:
      body = <SizerStepSettings />;
      break;
  }

  return (
    <div
      data-testid="sizer-wizard"
      className="min-h-screen flex flex-col bg-background"
    >
      <SizerStepper />
      <SizerValidationBanner />
      <main
        id={STEPPER_PANEL_ID}
        role="tabpanel"
        aria-labelledby={STEPPER_BUTTON_ID(step)}
        tabIndex={0}
        className="flex-1 px-6 pt-6 pb-24 max-w-[1280px] mx-auto w-full"
      >
        {body}
      </main>
      <SizerFooter onAdvance={onAdvance} onRetreat={onRetreat} />
    </div>
  );
}

export function SizerWizard(props: SizerWizardProps = {}) {
  return (
    <SizerProvider>
      <SizerWizardInner {...props} />
    </SizerProvider>
  );
}
