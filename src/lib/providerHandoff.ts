import type { ChatMessage, Provider, ThreadHandoff } from "../types";

const HANDOFF_TRANSCRIPT_BUDGET = 18_000;
const INITIAL_GOAL_BUDGET = 4_000;

function providerName(provider: Provider): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "lmstudio") return "LM Studio";
  if (provider === "claude") return "Claude";
  return "Cursor";
}

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

function shortenedStart(text: string, budget: number): string {
  const value = text.trim();
  if (value.length <= budget) return value;
  const suffix = "\n\n[Initial message truncated]";
  return `${value.slice(0, Math.max(0, budget - suffix.length))}${suffix}`;
}

function shortenedEnd(text: string, budget: number): string {
  const value = text.trim();
  if (value.length <= budget) return value;
  const prefix = "[Earlier content truncated]\n\n";
  return `${prefix}${value.slice(-Math.max(0, budget - prefix.length))}`;
}

function renderMessage(message: ChatMessage, text = message.text.trim()): string {
  return `### ${message.role === "user" ? "User" : "Assistant"}\n${text}`;
}

function transcriptExcerpt(messages: ChatMessage[], budget = HANDOFF_TRANSCRIPT_BUDGET): string {
  const usable = messages.filter((message) => message.text.trim());
  if (!usable.length) return "No conversation messages were available.";
  const firstUser = usable.find((message) => message.role === "user");
  const sections: string[] = [];
  let remaining = budget;
  if (firstUser) {
    const headerLength = renderMessage(firstUser, "").length;
    const bodyBudget = Math.max(0, Math.min(INITIAL_GOAL_BUDGET, remaining - headerLength));
    const rendered = renderMessage(firstUser, shortenedStart(firstUser.text, bodyBudget));
    sections.push(rendered);
    remaining -= rendered.length;
  }

  const recent: string[] = [];
  for (let index = usable.length - 1; index >= 0; index -= 1) {
    const message = usable[index];
    if (message === firstUser) continue;
    const separatorLength = sections.length || recent.length ? 2 : 0;
    const rendered = renderMessage(message);
    if (rendered.length + separatorLength <= remaining) {
      recent.unshift(rendered);
      remaining -= rendered.length + separatorLength;
      continue;
    }
    // Always keep at least the tail of the newest message so the destination
    // provider sees the most recent decision or failure, even when it is huge.
    if (!recent.length) {
      const headerLength = renderMessage(message, "").length + separatorLength;
      const bodyBudget = Math.max(0, remaining - headerLength);
      if (bodyBudget > 0) recent.unshift(renderMessage(message, shortenedEnd(message.text, bodyBudget)));
    }
    break;
  }
  return [...sections, ...recent].join("\n\n");
}

export function buildProviderHandoffPrompt(input: {
  title: string;
  sourceProvider: Provider;
  sourceModel: string;
  workspaceName: string;
  workspacePath: string;
  messages: ChatMessage[];
}): string {
  const title = input.title.trim() || "Untitled task";
  return [
    `Continue “${title}” from a provider handoff.`,
    "",
    "The previous conversation is copied below as bounded context. Continue the work in the current workspace; inspect the actual files and Git state before assuming earlier claims are still current.",
    "",
    "## Handoff details",
    `- Source provider: ${providerName(input.sourceProvider)}${input.sourceModel ? ` (${input.sourceModel})` : ""}`,
    `- Workspace: ${input.workspaceName}`,
    `- Local path: ${input.workspacePath}`,
    "",
    "## Previous conversation",
    transcriptExcerpt(input.messages),
  ].join("\n");
}
