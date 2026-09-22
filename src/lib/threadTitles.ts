import type { Provider } from "../types";
import type { RunDiscoveryCatalogs } from "./runDiscovery";

/** The automatic option follows the Luna tier only; it never upgrades to a costly tier. */
export function resolveThreadTitleModel(provider: Provider, model: string, catalogs: RunDiscoveryCatalogs): string | null {
  const catalog = catalogs[provider] ?? [];
  // Explicit IDs may be aliases or missing from a partial catalog. Honor the chosen ID exactly.
  if (model.trim()) return model.trim();
  if (provider !== "openai") return null;
  const lunas = catalog.flatMap((entry) => {
    const version = /^gpt-(\d+(?:\.\d+)*)-luna$/.exec(entry.id)?.[1];
    return version ? [{ id: entry.id, version: version.split(".").map(Number) }] : [];
  });
  lunas.sort((a, b) => {
    for (let i = 0; i < Math.max(a.version.length, b.version.length); i += 1) {
      const order = (b.version[i] ?? 0) - (a.version[i] ?? 0);
      if (order) return order;
    }
    return 0;
  });
  return lunas[0]?.id ?? (catalog.length ? null : "gpt-5.6-luna");
}

export function cleanThreadTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.replace(/\s+/g, " ").trim();
  return title.length >= 3 && [...title].length <= 80 && !/[\u0000-\u001f]/.test(title) ? title : null;
}
