import "@testing-library/jest-dom/vitest";

// jsdom does not implement matchMedia; default to "no reduced-motion preference"
// so components that read it render their full (animated) branch unless a test
// overrides window.matchMedia explicitly.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
