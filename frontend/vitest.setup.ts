import '@testing-library/jest-dom/vitest';

// jsdom lacks ResizeObserver, which cmdk (used inside SiteCombobox) needs on mount.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // @ts-expect-error — jsdom polyfill
  globalThis.ResizeObserver = ResizeObserverStub;
}

// jsdom HTMLElement lacks PointerEvent capture APIs that Radix Select uses.
if (typeof Element !== 'undefined') {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  // @ts-expect-error — jsdom missing scrollIntoView
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
}
