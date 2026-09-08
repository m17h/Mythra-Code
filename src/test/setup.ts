import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: ResizeObserverStub,
});

/**
 * jsdom ships no `window.matchMedia`. Real components reach it through
 * libraries too (xterm's renderer queries the device pixel ratio on open),
 * so without it the terminal panel throws into its error boundary while the
 * surrounding page still renders and assertions elsewhere keep passing.
 *
 * This is the standards shape: a `MediaQueryList` that never matches and
 * accepts `change` listeners through both the modern and legacy APIs. Tests
 * that need a specific media result replace it per test.
 */
class MediaQueryListStub extends EventTarget implements MediaQueryList {
  readonly matches = false;
  onchange: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null = null;

  constructor(readonly media: string) {
    super();
  }

  addListener(listener: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null): void {
    if (listener) this.addEventListener("change", listener as EventListener);
  }

  removeListener(listener: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null): void {
    if (listener) this.removeEventListener("change", listener as EventListener);
  }
}

if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => new MediaQueryListStub(String(query)),
  });
}

const values = new Map<string, string>();
const memoryStorage: Storage = {
  get length() { return values.size; },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => { values.delete(key); },
  setItem: (key, value) => { values.set(key, String(value)); },
};

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: memoryStorage,
});

// Reset the backing store between tests so one file's storage writes can
// never leak into another test.
afterEach(() => values.clear());
