import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, PromptProfile } from "../types";

export interface InstructionFileDescriptor {
  provider: "codex" | "claude";
  path: string;
  name: string;
  content: string | null;
  status: "ready" | "missing" | "empty" | "unreadable" | "tooLarge" | "invalidUtf8" | "invalidPath" | "outsideProject" | "notRegularFile";
  error: string | null;
  /** Opaque revision of the source file, including identity and metadata. */
  revision: string | null;
}

export function discoverGlobalInstructionFiles(): Promise<InstructionFileDescriptor[]> {
  return invoke<InstructionFileDescriptor[]>("instruction_files_discover_globals");
}

export function globalInstructionFileIsEditable(file: InstructionFileDescriptor): boolean {
  return (file.status === "ready" || file.status === "empty") && file.content !== null && Boolean(file.revision);
}

/** Reread this authorized global target even if an empty override is no longer selected. */
export function readGlobalInstructionFile(file: InstructionFileDescriptor): Promise<InstructionFileDescriptor> {
  return invoke<InstructionFileDescriptor>("instruction_files_read_global", {
    provider: file.provider,
    path: file.path,
  });
}

export function saveGlobalInstructionFile(file: InstructionFileDescriptor, content: string): Promise<InstructionFileDescriptor> {
  return invoke<InstructionFileDescriptor>("instruction_files_save_global", {
    provider: file.provider,
    path: file.path,
    content,
    expectedRevision: file.revision,
  });
}

const globalInstructionFlushers = new Set<() => Promise<void>>();

export function registerGlobalInstructionFileFlusher(flush: () => Promise<void>): () => void {
  let mounted = true;
  const registered = async () => {
    await flush();
    // An unmounted owner remains accountable until its final draft is resolved.
    if (!mounted) globalInstructionFlushers.delete(registered);
  };
  globalInstructionFlushers.add(registered);
  return () => {
    mounted = false;
    void registered().catch(() => {});
  };
}

/** Normal app close uses the existing close-flush lifecycle to finish the final edit. */
export async function flushPendingGlobalInstructionFileEdits(): Promise<void> {
  const results = await Promise.allSettled([...globalInstructionFlushers].map((flush) => flush()));
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("A global instruction file needs attention. Reopen Settings → Prompts to resolve its save or recovery state.");
  }
}

// A local change marker, not a cryptographic integrity or security check.
function contentFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length.toString(16)}-${(hash >>> 0).toString(16)}`;
}

/** Available local presets only; never merge these into persisted user profiles. */
export function globalInstructionProfiles(files: InstructionFileDescriptor[], includeEmpty = false): PromptProfile[] {
  return files.flatMap<PromptProfile>((file) => {
    if (file.status !== "ready" || file.content === null || (!includeEmpty && !file.content.trim())) return [];
    const provider = file.provider === "codex" ? "openai" : "claude";
    const contentHash = contentFingerprint(file.content);
    const filename = file.path.split(/[\\/]/).pop() || (file.provider === "codex" ? "AGENTS.md" : "CLAUDE.md");
    return [{
      id: `global-instruction:${provider}:${encodeURIComponent(file.path)}:${contentHash}`,
      name: `Global ${file.provider === "codex" ? "Codex" : "Claude"} ${filename}`,
      prompt: "",
      ...(provider === "openai" ? { codexPrompt: file.content } : { claudePrompt: file.content }),
      source: { kind: "global-instruction-file" as const, provider, path: file.path, contentHash },
    }];
  });
}

export function instructionFileStatusLabel(file: InstructionFileDescriptor): string {
  switch (file.status) {
    case "ready": return file.content?.trim() ? "Available as a local preset" : "The file is empty; add instructions in its file editor.";
    case "missing": return "No file found at this path. Create it, then refresh.";
    case "empty": return globalInstructionFileIsEditable(file) ? "The file is empty; add instructions in its file editor." : "The file is empty; add instructions, then refresh.";
    case "tooLarge": return "This file exceeds the 32 KB limit. Shorten it, then refresh.";
    case "invalidUtf8": return "This file is not valid UTF-8 text. Save it as UTF-8, then refresh.";
    case "notRegularFile": return "This path is not a regular file.";
    case "invalidPath": return "The configured instruction path is invalid.";
    case "outsideProject": return "This instruction path is outside the allowed folder.";
    case "unreadable": return "Could not read this file. Check file access, then refresh.";
  }
}

/** A file preset replaces only its provider layer; ordinary profiles replace the full set. */
export function applyPromptProfile(settings: AppSettings, profile: PromptProfile): AppSettings {
  if (profile.source?.kind === "global-instruction-file") {
    return {
      ...settings,
      promptProfileId: profile.id,
      ...(profile.source.provider === "openai"
        ? { codexSystemPrompt: profile.codexPrompt ?? "" }
        : { claudeSystemPrompt: profile.claudePrompt ?? "" }),
    };
  }
  return {
    ...settings,
    promptProfileId: profile.id,
    systemPrompt: profile.prompt,
    codexSystemPrompt: profile.codexPrompt ?? "",
    claudeSystemPrompt: profile.claudePrompt ?? "",
  };
}

/** The selected label describes the applied snapshot, not just its remembered id. */
export function promptProfileIsSelected(settings: AppSettings, profile: PromptProfile): boolean {
  if (settings.promptProfileId !== profile.id) return false;
  if (profile.source?.kind === "global-instruction-file") {
    return profile.source.provider === "openai"
      ? settings.codexSystemPrompt === (profile.codexPrompt ?? "")
      : settings.claudeSystemPrompt === (profile.claudePrompt ?? "");
  }
  return settings.systemPrompt === profile.prompt
    && settings.codexSystemPrompt === (profile.codexPrompt ?? "")
    && settings.claudeSystemPrompt === (profile.claudePrompt ?? "");
}

/** Keep external profile changes unless this modal edited or removed that same id. */
export function mergePromptProfileDrafts(baseline: PromptProfile[], drafts: PromptProfile[], incoming: PromptProfile[]): PromptProfile[] {
  const baselineById = new Map(baseline.map((profile) => [profile.id, profile]));
  const draftsById = new Map(drafts.map((profile) => [profile.id, profile]));
  const incomingIds = new Set(incoming.map((profile) => profile.id));
  const merged = incoming.flatMap<PromptProfile>((profile) => {
    const base = baselineById.get(profile.id);
    const draft = draftsById.get(profile.id);
    if (base && !draft) return [];
    return [base && draft && JSON.stringify(draft) !== JSON.stringify(base) ? draft : profile];
  });
  return [...merged, ...drafts.filter((profile) => !incomingIds.has(profile.id)
    && (!baselineById.has(profile.id) || JSON.stringify(profile) !== JSON.stringify(baselineById.get(profile.id))))];
}

/** An explicit snapshot: rediscovery cannot change or recreate a saved copy. */
export function copyGlobalInstructionProfile(profile: PromptProfile): PromptProfile {
  return {
    ...profile,
    id: crypto.randomUUID(),
    name: `Copy of ${profile.name}`,
    ...(profile.source ? { source: { ...profile.source } } : {}),
  };
}
