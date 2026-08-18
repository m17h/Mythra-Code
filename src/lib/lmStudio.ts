import { invoke } from "@tauri-apps/api/core";

export const LM_STUDIO_SERVER_URL = "http://localhost:1234";

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

const REASONING_EFFORTS = new Set<LMStudioReasoningEffort>(["low", "medium", "high", "xhigh", "max"]);

function reasoningEffort(value: unknown): LMStudioReasoningEffort | undefined {
  return typeof value === "string" && REASONING_EFFORTS.has(value as LMStudioReasoningEffort)
    ? value as LMStudioReasoningEffort
    : undefined;
}

export async function listLMStudioModels(): Promise<LMStudioModel[]> {
  const result = await invoke<{ models?: LMStudioCatalogModel[] }>("list_lm_studio_models");
  return (result.models ?? [])
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
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}
