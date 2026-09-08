import type { Provider, ThreadHandoff } from "../types";

const PROVIDERS = new Set<Provider>(["openai", "openrouter", "lmstudio", "claude", "cursor"]);

export function sanitizePendingHandoff(value: unknown): ThreadHandoff | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.sourceThreadId !== "string" || !record.sourceThreadId.trim()) return null;
  if (typeof record.sourceTitle !== "string" || !record.sourceTitle.trim()) return null;
  if (typeof record.sourceProvider !== "string" || !PROVIDERS.has(record.sourceProvider as Provider)) return null;
  if (typeof record.sourceModel !== "string") return null;
  if (typeof record.workspacePath !== "string" || !record.workspacePath.trim()) return null;
  if (typeof record.targetProvider !== "string" || !PROVIDERS.has(record.targetProvider as Provider)) return null;
  return {
    sourceThreadId: record.sourceThreadId,
    sourceTitle: record.sourceTitle,
    sourceProvider: record.sourceProvider as Provider,
    sourceModel: record.sourceModel,
    workspacePath: record.workspacePath,
    targetProvider: record.targetProvider as Provider,
    createdAt: typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
  };
}
