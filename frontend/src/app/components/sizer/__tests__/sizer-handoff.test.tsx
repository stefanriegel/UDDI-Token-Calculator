/**
 * sizer-handoff.test.tsx — Regression for issue #30.
 *
 * Reproduces the credentials→results route flip in wizard.tsx where the old
 * <SizerProvider/> (mounted by <SizerWizard/>) unmounts and a new one
 * (mounted by <SizerResultsView/>) mounts. The new provider's useReducer init
 * runs during the render phase BEFORE the old provider's cleanup effect
 * flushes the latest state to sessionStorage, so without the fix the new
 * provider hydrates from a stale snapshot and the report lands on the empty
 * "Add at least one Region in Step 1 before viewing results." state.
 *
 * The fix nests both providers under a single root SizerProvider mounted by
 * wizard.tsx; the inner ones become pass-throughs so the underlying state
 * never tears down across the route flip.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import {
  SizerProvider,
  STORAGE_KEY,
  useSizer,
} from '../sizer-state';

function clearStorage() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function AddRegionButton() {
  const { dispatch } = useSizer();
  return (
    <button
      type="button"
      data-testid="add-region"
      onClick={() => dispatch({ type: 'ADD_REGION' })}
    >
      add region
    </button>
  );
}

function RegionCount() {
  const { state } = useSizer();
  return <div data-testid="region-count">{state.core.regions.length}</div>;
}

describe('issue #30 — Sizer state survives credentials→results route flip', () => {
  beforeEach(() => clearStorage());

  it('keeps regions when SizerProvider subtree swaps under a single root provider', async () => {
    const user = userEvent.setup();

    function Outer() {
      const [phase, setPhase] = useState<'a' | 'b'>('a');
      return (
        <SizerProvider>
          <button
            type="button"
            data-testid="advance"
            onClick={() => setPhase('b')}
          >
            advance
          </button>
          {phase === 'a' ? (
            <SizerProvider>
              <AddRegionButton />
            </SizerProvider>
          ) : (
            <SizerProvider>
              <RegionCount />
            </SizerProvider>
          )}
        </SizerProvider>
      );
    }

    render(<Outer />);
    await user.click(screen.getByTestId('add-region'));
    await user.click(screen.getByTestId('advance'));
    expect(screen.getByTestId('region-count')).toHaveTextContent('1');
  });
});
