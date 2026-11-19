// Runtime setup for the hidden page, before importing any view modules.

import { enterFixtureStorage } from "../lib/storage";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(String(key)) ?? null,
    setItem: (key: string, value: string) => { values.set(String(key), String(value)); },
    removeItem: (key: string) => { values.delete(String(key)); },
    clear: () => values.clear(),
  };
}

export function installFixtureStorage(): void {
  enterFixtureStorage();
  for (const name of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(window, name, { configurable: true, value: memoryStorage() });
  }
}

/** A hidden webview may skip native animation callbacks. Keep the app's layout work moving. */
export function installLayoutFrames(): void {
  window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 16);
  window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
}
