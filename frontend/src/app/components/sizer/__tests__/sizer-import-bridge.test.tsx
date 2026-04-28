/**
 * sizer-import-bridge.test.tsx — Regression for sizer-import-empty.
 *
 * Reproduces the symptom that "Use as Sizer Input" yielded an empty Sizer
 * after commit c54da81 hoisted <SizerProvider/> to the wizard root: writing
 * the merged tree to sessionStorage was no longer observed by the live
 * provider because it never re-mounted on route changes.
 *
 * The fix dispatches `IMPORT_SCAN` against the live provider via
 * <SizerDispatchBridge/>. This test asserts the bridge wires `dispatch`
 * correctly and that an IMPORT_SCAN dispatched from outside the provider
 * subtree updates the live state.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import type { Dispatch } from 'react';

import {
  SizerProvider,
  SizerDispatchBridge,
  useSizer,
  initialSizerState,
  type SizerAction,
} from '../sizer-state';

function RegionCount() {
  const { state } = useSizer();
  return <div data-testid="region-count">{state.core.regions.length}</div>;
}

describe('SizerDispatchBridge — IMPORT_SCAN against live provider', () => {
  it('dispatches IMPORT_SCAN from outside the provider subtree', async () => {
    const user = userEvent.setup();

    function Outer() {
      const dispatchRef = useRef<Dispatch<SizerAction> | null>(null);

      const fakeImport = () => {
        const payload = initialSizerState();
        payload.core.regions = [
          {
            id: 'r1',
            name: 'Imported NIOS Grid',
            type: 'on-premises',
            cloudNativeDns: false,
            countries: [],
          },
        ];
        dispatchRef.current?.({ type: 'IMPORT_SCAN', payload });
      };

      return (
        <>
          <button type="button" data-testid="import" onClick={fakeImport}>
            import
          </button>
          <SizerProvider>
            <SizerDispatchBridge dispatchRef={dispatchRef} />
            <RegionCount />
          </SizerProvider>
        </>
      );
    }

    render(<Outer />);
    expect(screen.getByTestId('region-count').textContent).toBe('0');
    await user.click(screen.getByTestId('import'));
    expect(screen.getByTestId('region-count').textContent).toBe('1');
  });
});
