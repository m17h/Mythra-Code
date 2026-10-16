import { useSyncExternalStore } from "react";
import type { Provider } from "../types";
import { loadStored, storeValue } from "./storage";

/**
 * Instruction context for the latest provider-confirmed turn: exact assembled
 * system text and separately displayed user-channel skill content, with the
 * ordinary message and attachments omitted. Kept on this device only.
 */
export interface TurnContextReceipt {
  delivery: "accepted";
  at: number;
  provider: Provider;
  model: string;
  effort?: string;
  permission?: string;
  layers: Array<{ label: string; chars: number }>;
  instructions: string;
  totalInstructionChars: number;
  truncated: boolean;
  skills: string[];
  attachments: number;
}

const KEY = "kiwi.turnContextReceipts";
const MAX_THREADS = 24;
const MAX_INSTRUCTION_CHARS = 32_000;

function sanitize(value: unknown): Record<string, TurnContextReceipt> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, TurnContextReceipt> = {};
  for (const [threadId, receipt] of Object.entries(value as Record<string, unknown>)) {
    const candidate = receipt as Partial<TurnContextReceipt> | null;
    // Older snapshots were written before dispatch and cannot prove delivery.
    if (!candidate || typeof candidate !== "object" || candidate.delivery !== "accepted"
      || typeof candidate.at !== "number" || !Number.isFinite(candidate.at)
      || !["openai", "openrouter", "lmstudio", "claude", "cursor"].includes(candidate.provider ?? "")
      || typeof candidate.model !== "string" || typeof candidate.instructions !== "string"
      || !Array.isArray(candidate.layers) || !Array.isArray(candidate.skills)) continue;
    const totalInstructionChars = typeof candidate.totalInstructionChars === "number" && Number.isFinite(candidate.totalInstructionChars)
      ? Math.max(candidate.instructions.length, candidate.totalInstructionChars) : candidate.instructions.length;
    result[threadId] = {
      delivery: "accepted", at: candidate.at, provider: candidate.provider!, model: candidate.model.slice(0, 256),
      effort: typeof candidate.effort === "string" ? candidate.effort.slice(0, 32) : undefined,
      permission: typeof candidate.permission === "string" ? candidate.permission.slice(0, 32) : undefined,
      instructions: candidate.instructions.slice(0, MAX_INSTRUCTION_CHARS), totalInstructionChars,
      truncated: candidate.truncated === true || totalInstructionChars > MAX_INSTRUCTION_CHARS,
      layers: candidate.layers.filter((layer) => layer && typeof layer.label === "string"
        && typeof layer.chars === "number" && Number.isFinite(layer.chars) && layer.chars >= 0)
        .slice(0, 16).map((layer) => ({ label: layer.label.slice(0, 80), chars: layer.chars })),
      skills: candidate.skills.filter((name): name is string => typeof name === "string").slice(0, 128).map((name) => name.slice(0, 128)),
      attachments: typeof candidate.attachments === "number" && Number.isFinite(candidate.attachments) ? Math.max(0, candidate.attachments) : 0,
    };
  }
  return Object.fromEntries(Object.entries(result).sort(([, left], [, right]) => right.at - left.at).slice(0, MAX_THREADS));
}

let receipts = sanitize(loadStored<unknown>(KEY, {}));
const listeners = new Set<() => void>();
interface PendingReceipt { revoked: boolean }
const pendingReceipts = new Map<string, Set<PendingReceipt>>();

/** Hold only in-flight attempts, so archive/delete can revoke late responses
 * without retaining a tombstone for every thread ever forgotten. */
export function beginTurnContextReceipt(threadId: string): { confirm: (receipt: TurnContextReceipt) => void; finish: () => void } {
  const pending: PendingReceipt = { revoked: false };
  const attempts = pendingReceipts.get(threadId) ?? new Set<PendingReceipt>();
  attempts.add(pending);
  pendingReceipts.set(threadId, attempts);
  const finish = () => {
    pending.revoked = true;
    attempts.delete(pending);
    if (!attempts.size && pendingReceipts.get(threadId) === attempts) pendingReceipts.delete(threadId);
  };
  return {
    confirm(receipt) {
      if (!pending.revoked) recordTurnContext(threadId, receipt);
      finish();
    },
    finish,
  };
}

/** Extract only resolved skill/reference content, never the authored message or
 * attachment suffix. System-channel content remains in the exact system text. */
function skillContext(prompt: string): { text: string; names: string[] } {
  const open = "<mythra_code_invoked_skills>\n";
  if (!prompt.startsWith(open)) return { text: "", names: [] };
  const start = prompt.indexOf("\n{");
  const end = prompt.indexOf("\n</mythra_code_invoked_skills>");
  if (start < 0 || end < start || end - start > 2_000_000) return { text: "", names: [] };
  try {
    const payload = JSON.parse(prompt.slice(start + 1, end));
    if (!payload || !Array.isArray(payload.skills)) return { text: "", names: [] };
    const candidates: unknown[] = payload.skills;
    const skills = candidates.filter((skill): skill is { kind: string; name: string; sourcePath: string; instructions: string; aliases?: string[] } =>
      Boolean(skill && typeof skill === "object" && "kind" in skill && (skill.kind === "skill" || skill.kind === "document")
        && "name" in skill && typeof skill.name === "string" && "sourcePath" in skill && typeof skill.sourcePath === "string"
        && "instructions" in skill && typeof skill.instructions === "string"))
      .map((skill: { kind: string; name: string; sourcePath: string; instructions: string; aliases?: unknown }) => ({
        kind: skill.kind, name: skill.name, sourcePath: skill.sourcePath, instructions: skill.instructions,
        ...(Array.isArray(skill.aliases) ? { aliases: skill.aliases.filter((alias): alias is string => typeof alias === "string") } : {}),
      }));
    return {
      text: skills.length ? `${open}${prompt.slice(open.length, start)}\n${JSON.stringify({ skills }, null, 2)}\n</mythra_code_invoked_skills>` : "",
      names: skills.filter((skill: { kind: string }) => skill.kind === "skill").map((skill: { name: string }) => skill.name),
    };
  } catch { return { text: "", names: [] }; }
}

/** Stage texts in the order they were built; each layer is what its stage added. */
export function createTurnContextReceipt(input: {
  provider: Provider;
  model: string;
  effort?: string;
  permission?: string;
  stages: Array<{ label: string; text: string }>;
  userSkillPrompt?: string;
  skills?: string[];
  attachments?: number;
}): TurnContextReceipt {
  const layers: TurnContextReceipt["layers"] = [];
  let previous = 0;
  for (const stage of input.stages) {
    const added = Math.max(0, stage.text.length - previous);
    if (added > 0 || layers.length === 0) layers.push({ label: stage.label, chars: added });
    previous = Math.max(previous, stage.text.length);
  }
  let instructions = input.stages.at(-1)?.text ?? "";
  const userSkills = skillContext(input.userSkillPrompt ?? "");
  if (userSkills.text) {
    const added = `\n\nUser-channel skill context (message omitted):\n${userSkills.text}`;
    layers.push({ label: "Skills in your message", chars: added.length });
    instructions += added;
  }
  const systemSkills = skillContext(input.stages.find((stage) => stage.label === "Skills")?.text ?? "");
  return {
    delivery: "accepted",
    at: Date.now(),
    provider: input.provider,
    model: input.model,
    effort: input.effort,
    permission: input.permission,
    layers,
    instructions: instructions.slice(0, MAX_INSTRUCTION_CHARS),
    totalInstructionChars: instructions.length,
    truncated: instructions.length > MAX_INSTRUCTION_CHARS,
    skills: [...new Set([...(input.skills ?? []), ...systemSkills.names, ...userSkills.names])],
    attachments: input.attachments ?? 0,
  };
}

function recordTurnContext(threadId: string, receipt: TurnContextReceipt): void {
  receipts = sanitize({ ...receipts, [threadId]: { ...receipt, at: Date.now() } });
  try { storeValue(KEY, receipts); } catch { /* The receipt stays available for this session. */ }
  for (const listener of listeners) listener();
}

export function forgetTurnContext(threadId: string): void {
  for (const pending of pendingReceipts.get(threadId) ?? []) pending.revoked = true;
  pendingReceipts.delete(threadId);
  if (!(threadId in receipts)) return;
  const next = { ...receipts };
  delete next[threadId];
  receipts = next;
  try { storeValue(KEY, receipts); } catch { /* Best effort. */ }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useTurnContextReceipt(threadId: string | null | undefined): TurnContextReceipt | undefined {
  return useSyncExternalStore(subscribe, () => (threadId ? receipts[threadId] : undefined), () => undefined);
}
