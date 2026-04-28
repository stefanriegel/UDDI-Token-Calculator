import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// Mock IntersectionObserver for jsdom
let ioCallback: IntersectionObserverCallback | null = null;
const mockObserve = vi.fn();
const mockDisconnect = vi.fn();

class MockIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    ioCallback = callback;
  }
  observe = mockObserve;
  disconnect = mockDisconnect;
  unobserve = vi.fn();
}

// @ts-expect-error -- jsdom has no IntersectionObserver
globalThis.IntersectionObserver = MockIntersectionObserver;

// Mock scrollIntoView (jsdom does not implement it)
Element.prototype.scrollIntoView = vi.fn();

import { OutlineNav } from './outline-nav';

describe('OutlineNav', () => {
  const addedElements: HTMLElement[] = [];

  function addSectionElement(id: string): HTMLElement {
    const el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
    addedElements.push(el);
    return el;
  }

  afterEach(() => {
    addedElements.forEach(el => el.remove());
    addedElements.length = 0;
    vi.clearAllMocks();
    ioCallback = null;
  });

  it('renders section list from props', () => {
    render(
      <OutlineNav
        sections={[
          { id: 'section-overview', label: 'Overview' },
          { id: 'section-bom', label: 'Token Breakdown' },
        ]}
      />
    );

    const overview = screen.getByText('Overview');
    const breakdown = screen.getByText('Token Breakdown');

    expect(overview).toBeDefined();
    expect(breakdown).toBeDefined();
    expect(overview.tagName).toBe('BUTTON');
    expect(breakdown.tagName).toBe('BUTTON');
  });

  it('calls scrollIntoView on click', () => {
    const el = addSectionElement('section-overview');

    render(
      <OutlineNav sections={[{ id: 'section-overview', label: 'Overview' }]} />
    );

    fireEvent.click(screen.getByText('Overview'));

    expect(el.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'start',
    });
  });

  it('sets aria-current on active item', async () => {
    addSectionElement('section-overview');
    addSectionElement('section-bom');

    render(
      <OutlineNav
        sections={[
          { id: 'section-overview', label: 'Overview' },
          { id: 'section-bom', label: 'Token Breakdown' },
        ]}
      />
    );

    // Trigger IntersectionObserver callback
    ioCallback!([
      {
        isIntersecting: true,
        target: document.getElementById('section-overview')!,
        boundingClientRect: { top: 100 } as DOMRectReadOnly,
      } as unknown as IntersectionObserverEntry,
    ], {} as IntersectionObserver);

    await waitFor(() => {
      expect(screen.getByText('Overview').getAttribute('aria-current')).toBe('true');
    });

    expect(screen.getByText('Token Breakdown').getAttribute('aria-current')).not.toBe('true');
  });

  it('disconnects observer on unmount', () => {
    addSectionElement('section-overview');

    const { unmount } = render(
      <OutlineNav sections={[{ id: 'section-overview', label: 'Overview' }]} />
    );

    unmount();

    expect(mockDisconnect).toHaveBeenCalled();
  });

  it('calls expand handler before scrolling for collapsed sections', () => {
    addSectionElement('section-member-details');

    const expandHandler = vi.fn();

    render(
      <OutlineNav
        sections={[{ id: 'section-member-details', label: 'Member Details' }]}
        expandHandlers={{ 'section-member-details': expandHandler }}
      />
    );

    fireEvent.click(screen.getByText('Member Details'));

    expect(expandHandler).toHaveBeenCalled();
  });
});
