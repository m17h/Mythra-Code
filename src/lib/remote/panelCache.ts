/** The last answer each open panel got from a machine, so going back to one shows
 * it at once while the fresh read runs. Memory only, and never for a device that
 * has gone from the paired list. Keys start with the device. */
const MAX_PANELS = 64;
const panels = new Map<string, unknown>();
export const panelKey = (device: string, read: string, target: unknown) => `${device}:${read}:${JSON.stringify(target)}`;
export const cachedPanel = (key: string) => panels.get(key);
export function rememberPanel(key: string, value: unknown): void {
  panels.delete(key);
  panels.set(key, value);
  while (panels.size > MAX_PANELS) panels.delete(panels.keys().next().value!);
}
export function forgetPanels(keep: readonly string[]): void {
  for (const key of panels.keys()) if (!keep.includes(key.slice(0, key.indexOf(":")))) panels.delete(key);
}
