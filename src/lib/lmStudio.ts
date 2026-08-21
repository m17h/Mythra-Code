import { listLmStudioModels } from "./codex";

export type LMStudioReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LMStudioModel {
  id: string;
  displayName: string;
  publisher: string;
  maxContextLength?: number;
  trainedForToolUse: boolean;
  reasoningEfforts: LMStudioReasoningEffort[];
  defaultReasoningEffort?: LMStudioReasoningEffort;
}

interface LMStudioCatalogModel {
  type?: string;
  key?: string;
  display_name?: string;
  publisher?: string;
  max_context_length?: number;
  capabilities?: {
    trained_for_tool_use?: boolean;
    reasoning?: {
      allowed_options?: string[];
      default?: string;
    };
  };
}

interface LMStudioCompatibleModel {
  id?: string;
  name?: string;
  owned_by?: string;
  context_length?: number;
  trained_for_tool_use?: boolean;
  reasoning?: {
    allowed_options?: string[];
    default?: string;
  } | null;
}

const REASONING_EFFORTS = new Set<LMStudioReasoningEffort>(["low", "medium", "high", "xhigh", "max"]);

function reasoningEffort(value: unknown): LMStudioReasoningEffort | undefined {
  return typeof value === "string" && REASONING_EFFORTS.has(value as LMStudioReasoningEffort)
    ? value as LMStudioReasoningEffort
    : undefined;
}

export async function listLMStudioModels(baseUrl: string): Promise<LMStudioModel[]> {
  const result = await listLmStudioModels<{ data?: LMStudioCompatibleModel[]; models?: LMStudioCatalogModel[] }>(baseUrl);
  const compatible = (result.data ?? [])
    .filter((model) => typeof model.id === "string" && model.id.trim().length > 0)
    .map((model) => {
      const id = model.id!.trim();
      const reasoningEfforts = (model.reasoning?.allowed_options ?? [])
        .map(reasoningEffort)
        .filter((effort): effort is LMStudioReasoningEffort => Boolean(effort));
      const defaultReasoningEffort = reasoningEffort(model.reasoning?.default);
      return {
        id,
        displayName: model.name?.trim() || id,
        publisher: model.owned_by?.trim() || "LM Studio",
        ...(typeof model.context_length === "number" && model.context_length > 0 ? { maxContextLength: model.context_length } : {}),
        trainedForToolUse: Boolean(model.trained_for_tool_use),
        reasoningEfforts,
        ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      };
    });
  const native = (result.models ?? [])
    .filter((model) => model.type === "llm" && typeof model.key === "string" && model.key.trim().length > 0)
    .map((model) => {
      const id = model.key!.trim();
      const reasoningEfforts = (model.capabilities?.reasoning?.allowed_options ?? [])
        .map(reasoningEffort)
        .filter((effort): effort is LMStudioReasoningEffort => Boolean(effort));
      const defaultReasoningEffort = reasoningEffort(model.capabilities?.reasoning?.default);
      return {
        id,
        displayName: model.display_name?.trim() || id,
        publisher: model.publisher?.trim() || "Local model",
        ...(typeof model.max_context_length === "number" && model.max_context_length > 0
          ? { maxContextLength: model.max_context_length }
          : {}),
        trainedForToolUse: Boolean(model.capabilities?.trained_for_tool_use),
        reasoningEfforts,
        ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      };
    });
  return [...compatible, ...native].sort((left, right) => left.id.localeCompare(right.id));
}
