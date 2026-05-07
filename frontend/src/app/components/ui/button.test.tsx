import { createRef } from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { Button } from './button';
import { Popover, PopoverTrigger, PopoverContent } from './popover';

describe('Button', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards ref to the underlying <button> element', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Click</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it('does not log a ref-forwarding warning when used as Radix Popover asChild', () => {
    // Regression test for Phase 30 UAT I-3 (site combobox popover rendered at
    // y=-304 because Button was a plain function component and React 18
    // dropped the Slot-propagated ref with:
    //   "Function components cannot be given refs. ... at Button"
    // Without the anchor ref, Floating UI never positioned the popover.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <Popover open>
        <PopoverTrigger asChild>
          <Button>Trigger</Button>
        </PopoverTrigger>
        <PopoverContent>Body</PopoverContent>
      </Popover>,
    );

    const refWarningCalls = errorSpy.mock.calls.filter((call) => {
      const first = call[0];
      return typeof first === 'string' && first.includes('Function components cannot be given refs');
    });
    expect(refWarningCalls).toEqual([]);
  });
});
