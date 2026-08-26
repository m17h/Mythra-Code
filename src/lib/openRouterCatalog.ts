import { fetchOpenRouterModel, listOpenRouterModels } from "./codex";

export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  supported_parameters?: string[];
  pricing?: { prompt?: string; completion?: string };
}

/**
 * A model the user reached by typing its slug rather than by finding it in the
 * catalog response. It is merged into the catalog so it stays selectable and
 * starrable for the rest of the session.
 */
export interface OpenRouterSlugLookup {
  model: OpenRouterModel;
  /** OpenRouter confirmed the slug; false means it is being taken on trust. */
  verified: boolean;
}

/** `author/slug`, optionally with a `:variant` suffix such as `:free`. */
export function looksLikeModelSlug(value: string): boolean {
  return /^[^\s/]+\/[^\s/]+(:[^\s/]+)?$/.test(value.trim());
}

function haystack(model: OpenRouterModel): string {
  return `${model.name} ${model.id} ${model.description ?? ""}`.toLowerCase();
}

/**
 * Every token must appear somewhere in the model's name, id, or description.
 * Token matching rather than whole-string matching is what lets "anthropic
 * sonnet" find `anthropic/claude-sonnet-5`.
 */
export function matchesOpenRouterQuery(model: OpenRouterModel, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const value = haystack(model);
  return tokens.every((token) => value.includes(token));
}

/**
 * Filters the catalog for a query. Deliberately uncapped: a truncated result
 * list is indistinguishable from a missing model, which is the one failure
 * this picker must not have.
 */
export function filterOpenRouterModels(models: OpenRouterModel[], query: string): OpenRouterModel[] {
  const trimmed = query.trim();
  if (!trimmed) return models;
  const exact = trimmed.toLowerCase();
  const matches = models.filter((model) => matchesOpenRouterQuery(model, trimmed));
  // An exact slug always leads, however the rest of the list is ordered.
  const index = matches.findIndex((model) => model.id.toLowerCase() === exact);
  if (index > 0) return [matches[index], ...matches.slice(0, index), ...matches.slice(index + 1)];
  return matches;
}

/** Adds models the catalog response did not carry, keeping existing entries. */
export function mergeOpenRouterModels(
  base: OpenRouterModel[],
  extra: OpenRouterModel[],
): OpenRouterModel[] {
  const known = new Set(base.map((model) => model.id));
  const additions = extra.filter((model) => model.id && !known.has(model.id));
  if (!additions.length) return base;
  return [...base, ...additions].sort((left, right) => (left.name || left.id).localeCompare(right.name || right.id));
}

function normalizeModel(entry: unknown): OpenRouterModel | null {
  if (!entry || typeof entry !== "object") return null;
  const model = entry as Record<string, unknown>;
  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (!id) return null;
  const contextLength = typeof model.context_length === "number" ? model.context_length : undefined;
  return {
    id,
    name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : id,
    ...(typeof model.description === "string" ? { description: model.description } : {}),
    ...(contextLength ? { context_length: contextLength } : {}),
    ...(Array.isArray(model.supported_parameters)
      ? { supported_parameters: model.supported_parameters.filter((value): value is string => typeof value === "string") }
      : {}),
    ...(model.pricing && typeof model.pricing === "object"
      ? { pricing: model.pricing as OpenRouterModel["pricing"] }
      : {}),
  };
}

export function parseOpenRouterCatalog(payload: unknown): OpenRouterModel[] {
  const data = (payload as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data)) return [];
  const models: OpenRouterModel[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    const model = normalizeModel(entry);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models.sort((left, right) => (left.name || left.id).localeCompare(right.name || right.id));
}

/**
 * The `/models/{slug}/endpoints` response nests the model under `data` and
 * carries the context length on the endpoints rather than the model.
 */
export function parseOpenRouterSlugResponse(payload: unknown): OpenRouterModel | null {
  const data = (payload as { data?: unknown } | null | undefined)?.data;
  const model = normalizeModel(data);
  if (!model) return null;
  const endpoints = (data as { endpoints?: unknown }).endpoints;
  if (!model.context_length && Array.isArray(endpoints)) {
    const lengths = endpoints
      .map((endpoint) => (endpoint as { context_length?: unknown })?.context_length)
      .filter((value): value is number => typeof value === "number" && value > 0);
    if (lengths.length) model.context_length = Math.max(...lengths);
  }
  if (!model.supported_parameters && Array.isArray(endpoints)) {
    const parameters = new Set<string>();
    for (const endpoint of endpoints) {
      for (const value of (endpoint as { supported_parameters?: unknown[] })?.supported_parameters ?? []) {
        if (typeof value === "string") parameters.add(value);
      }
    }
    if (parameters.size) model.supported_parameters = [...parameters];
  }
  return model;
}

export async function fetchOpenRouterCatalog(): Promise<OpenRouterModel[]> {
  return parseOpenRouterCatalog(await listOpenRouterModels<unknown>());
}

/**
 * Last-resort resolution for a typed slug. A failed lookup still yields an
 * unverified entry so the existing direct-slug flow can remain available.
 */
export async function resolveOpenRouterSlug(slug: string): Promise<OpenRouterSlugLookup | null> {
  const trimmed = slug.trim();
  if (!looksLikeModelSlug(trimmed)) return null;
  try {
    const model = parseOpenRouterSlugResponse(await fetchOpenRouterModel<unknown>(trimmed));
    if (model) return { model, verified: true };
  } catch {
    // Fall through to the unverified entry below.
  }
  return { model: { id: trimmed, name: trimmed }, verified: false };
}
