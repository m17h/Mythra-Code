import { visibleClaudeModels, type ClaudeModel } from "../claude";
import type { CursorModel } from "../cursor";
import type { LMStudioModel } from "../lmStudio";
import type { OpenRouterModel } from "../openRouterCatalog";
import { OPENAI_MODELS, type RuntimeModel } from "../../components/ModelPowerControl";
import type { Thread } from "../../types";
import type { WireEffort, WireHostProvider } from "./wire";

const EFFORTS: readonly WireEffort[] = ["low", "medium", "high", "xhigh", "max"];
const wireEfforts = (values: readonly unknown[] | undefined): WireEffort[] => (values ?? []).filter((value): value is WireEffort => EFFORTS.includes(value as WireEffort));

export interface HostCatalogInputs {
  runtimeModels: RuntimeModel[]; claudeModels: ClaudeModel[]; cursorModels: CursorModel[];
  openRouterModels: OpenRouterModel[]; lmStudioModels: LMStudioModel[];
  ready: { openai: boolean; claude: boolean; cursor: boolean; openrouter: boolean; lmstudio: boolean };
}
/** The same catalogs the local pickers read. Names and choices only: no endpoint,
 * key or account record ever enters this list. */
export function hostProviderCatalog(inputs: HostCatalogInputs): WireHostProvider[] {
  const openai = inputs.runtimeModels.length
    ? inputs.runtimeModels.map((model) => {
      const efforts = wireEfforts(model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort));
      const [defaultEffort] = wireEfforts([model.defaultReasoningEffort]);
      return { id: model.model, name: model.displayName, efforts, ...(defaultEffort ? { defaultEffort } : {}) };
    })
    : OPENAI_MODELS.map((model) => ({ id: model.id, name: model.name, efforts: [...EFFORTS] }));
  return [
    { id: "openai", name: "OpenAI", ready: inputs.ready.openai, models: openai },
    { id: "claude", name: "Claude", ready: inputs.ready.claude, models: visibleClaudeModels(inputs.claudeModels).filter((model) => !model.disabled).map((model) => ({
      id: model.id, name: model.displayName, efforts: wireEfforts(model.supportedEfforts),
    })) },
    { id: "cursor", name: "Cursor", ready: inputs.ready.cursor, models: inputs.cursorModels.map((model) => ({ id: model.id, name: model.name, efforts: [...EFFORTS] })) },
    { id: "openrouter", name: "OpenRouter", ready: inputs.ready.openrouter, models: inputs.openRouterModels.map((model) => ({ id: model.id, name: model.name, efforts: [...EFFORTS] })) },
    { id: "lmstudio", name: "LM Studio", ready: inputs.ready.lmstudio, models: inputs.lmStudioModels.map((model) => {
      const [defaultEffort] = wireEfforts([model.defaultReasoningEffort]);
      return { id: model.id, name: model.displayName, efforts: wireEfforts(model.reasoningEfforts), ...(defaultEffort ? { defaultEffort } : {}) };
    }) },
  ];
}

/** Read access to an archived conversation, without unarchiving or selecting it. */
export function synthesizedArchivedThread(record: { id: string; label: string; path: string; archivedAt: number; provider?: string }): Thread {
  return { id: record.id, name: record.label, preview: record.label, cwd: record.path,
    updatedAt: Math.floor(record.archivedAt / 1000), modelProvider: record.provider ?? "openai" };
}

/** Project Git facts for a workspace that may not be the one on screen. The first
 * read of another workspace returns unknown and fills in for the next request. */
export function hostWorkspaceGit<T>(cache: Map<string, T | null>, key: string, read: () => Promise<T>): T | null {
  if (!cache.has(key)) {
    cache.set(key, null);
    void read().then((info) => cache.set(key, info), () => cache.delete(key));
  }
  return cache.get(key) ?? null;
}
