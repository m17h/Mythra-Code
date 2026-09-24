import { useRunCommandDiscovery } from "./useRunCommandDiscovery";

/** Explicit Find checks action; keeps its worker and result separate from Run discovery. */
export function useCheckCommandDiscovery(cwd?: string, lmStudioBaseUrl?: string) {
  return useRunCommandDiscovery(cwd, lmStudioBaseUrl, "checks");
}
