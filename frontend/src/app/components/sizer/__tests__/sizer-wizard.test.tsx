/**
 * sizer-wizard.test.tsx — Shell (Stepper + Footer + ValidationBanner skeleton)
 * component tests + Phase 31 Step 5 wiring.
 *
 * Covers plan 30-03 Task 1 done criteria + plan 31-07 Task 3:
 *   - SizerWizard mounts without a pre-wrapped provider (supplies its own).
 *   - Stepper click-to-jump dispatches SET_ACTIVE_STEP.
 *   - Step 5 chip is enabled (Phase 31) — not aria-disabled.
 *   - Clicking Step 5 mounts <SizerStepResults/> composite (hero cards,
 *     breakdown table, export bar, mocked Excalidraw viewer).
 *   - Footer "Next →" label switches to "Review →" on Step 4.
 *   - Keyboard ArrowRight on stepper moves active step.
 *   - Validation banner hidden when no issues, rendered when issues present.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../sizer-xlsx-export', () => ({
  downloadWorkbook: vi.fn().mockResolvedValue(undefined),
}));

// jsdom shim — Phase 34 Plan 06 mounts <OutlineNav/> inside SizerResultsSurface
// which requires IntersectionObserver + scrollIntoView (not provided by jsdom).
class MockIntersectionObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
  takeRecords = vi.fn().mockReturnValue([]);
  constructor(_cb: IntersectionObserverCallback) {}
}
// @ts-expect-error -- jsdom has no IntersectionObserver.
globalThis.IntersectionObserver = MockIntersectionObserver;
Element.prototype.scrollIntoView = vi.fn();

import { SizerWizard } from '../sizer-wizard';
import {
  STORAGE_KEY,
  initialSizerState,
  type SizerFullState,
} from '../sizer-state';

function clearStorage() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem('ddi_sizer_sections_v1');
    sessionStorage.removeItem('ddi_sizer_dismissed_codes_v1');
  } catch {
    /* ignore */
  }
}

describe('<SizerWizard/>', () => {
  beforeEach(() => clearStorage());

  it('mounts without requiring an external provider and shows Step 1', () => {
    render(<SizerWizard />);
    expect(screen.getByTestId('sizer-wizard')).toBeInTheDocument();
    expect(screen.getByTestId('sizer-stepper')).toBeInTheDocument();
    expect(screen.getByTestId('sizer-footer-back')).toBeInTheDocument();
    expect(screen.getByTestId('sizer-footer-next')).toBeInTheDocument();
    // Step 1 body renders (empty state when no regions).
    expect(screen.getByTestId('sizer-step-regions')).toBeInTheDocument();
  });

  it('stepper click on step 3 dispatches SET_ACTIVE_STEP and renders its body', async () => {
    const user = userEvent.setup();
    render(<SizerWizard />);
    await user.click(screen.getByTestId('sizer-stepper-step-3'));
    expect(screen.getByTestId('sizer-stepper-step-3')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('sizer-step-infra')).toBeInTheDocument();
  });

  it('footer Next label switches to "View Report" on Step 4', async () => {
    const user = userEvent.setup();
    render(<SizerWizard onAdvance={() => {}} />);
    expect(screen.getByTestId('sizer-footer-next')).toHaveTextContent('Next');
    await user.click(screen.getByTestId('sizer-stepper-step-4'));
    expect(screen.getByTestId('sizer-footer-next')).toHaveTextContent('View Report');
  });

  it('only steps 1–4 render — step 5 retired 2026-04-26', () => {
    render(<SizerWizard />);
    expect(screen.getByTestId('sizer-stepper-step-4')).toBeInTheDocument();
    expect(screen.queryByTestId('sizer-stepper-step-5')).not.toBeInTheDocument();
  });

  it('Step 4 Next invokes onAdvance (hands off to outer wizard)', async () => {
    const user = userEvent.setup();
    const onAdvance = vi.fn();
    render(<SizerWizard onAdvance={onAdvance} />);
    await user.click(screen.getByTestId('sizer-stepper-step-4'));
    await user.click(screen.getByTestId('sizer-footer-next'));
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it('Step 1 Back invokes onRetreat when provided', async () => {
    const user = userEvent.setup();
    const onRetreat = vi.fn();
    render(<SizerWizard onRetreat={onRetreat} />);
    await user.click(screen.getByTestId('sizer-footer-back'));
    expect(onRetreat).toHaveBeenCalledTimes(1);
  });

  it('keyboard ArrowRight on the stepper moves active step', async () => {
    const user = userEvent.setup();
    render(<SizerWizard />);
    const step1 = screen.getByTestId('sizer-stepper-step-1');
    step1.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByTestId('sizer-stepper-step-2')).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('footer Back is disabled on Step 1 and enabled after moving forward', async () => {
    const user = userEvent.setup();
    render(<SizerWizard />);
    const back = screen.getByTestId('sizer-footer-back');
    expect(back).toBeDisabled();
    await user.click(screen.getByTestId('sizer-footer-next'));
    expect(screen.getByTestId('sizer-footer-back')).not.toBeDisabled();
  });

  it('validation banner is hidden on an empty state (STATE_EMPTY suppressed)', () => {
    render(<SizerWizard />);
    expect(screen.queryByTestId('sizer-validation-banner')).not.toBeInTheDocument();
  });

  it('validation banner renders rows when validate() returns multiple issues', async () => {
    const user = userEvent.setup();
    render(<SizerWizard />);
    // Add a region — creates REGION_EMPTY_OTHERWISE warning (no sites yet).
    await user.click(screen.getByTestId('sizer-tree-add-region'));
    // Find validation banner
    const banner = await screen.findByTestId('sizer-validation-banner');
    expect(banner).toBeInTheDocument();
    // REGION_EMPTY_OTHERWISE is the stable code.
    expect(
      within(banner).getByTestId('sizer-validation-row-region/empty'),
    ).toBeInTheDocument();
  });

  it('dismissing a banner issue hides its row', async () => {
    const user = userEvent.setup();
    render(<SizerWizard />);
    await user.click(screen.getByTestId('sizer-tree-add-region'));
    const banner = await screen.findByTestId('sizer-validation-banner');
    const dismiss = within(banner).getByTestId(
      'sizer-validation-dismiss-region/empty',
    );
    await user.click(dismiss);
    expect(
      screen.queryByTestId('sizer-validation-row-region/empty'),
    ).not.toBeInTheDocument();
  });
});

// ─── Step 5 wiring (Phase 31 Plan 31-07) ─────────────────────────────────────

function seedOneRegion() {
  const base = initialSizerState();
  const state: SizerFullState = {
    ...base,
    core: {
      ...base.core,
      regions: [
        {
          id: 'region-1',
          name: 'EMEA',
          type: 'on-premises',
          cloudNativeDns: false,
          countries: [
            {
              id: 'country-1',
              name: 'Germany',
              cities: [
                {
                  id: 'city-1',
                  name: 'Berlin',
                  sites: [
                    {
                      id: 'site-1',
                      name: 'HQ',
                      multiplier: 1,
                      users: 500,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ─── SizerResultsView wiring (Step 5 retired — outer wizard hosts report) ────

import { SizerResultsView } from '../sizer-results-view';

describe('<SizerResultsView/>', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('hydrates from sessionStorage and renders ResultsSurface sizer composition', () => {
    seedOneRegion();
    const { container } = render(<SizerResultsView />);

    expect(screen.getByTestId('sizer-step-results')).toBeInTheDocument();

    // Three universal section anchors from <ResultsSurface mode="sizer"/>.
    expect(container.querySelector('#section-overview')).not.toBeNull();
    expect(container.querySelector('#section-bom')).not.toBeNull();
    expect(container.querySelector('#section-export')).not.toBeNull();

    // Export CTA is wired through.
    expect(
      screen.getByRole('button', { name: /download xlsx/i }),
    ).toBeInTheDocument();
  });
});
