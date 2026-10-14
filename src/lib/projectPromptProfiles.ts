import type { ProjectOverrides, ProjectPromptMode, ProjectPromptProfile } from "../types";

export const MAX_PROJECT_PROMPT_PROFILES = 30;
export const MAX_PROJECT_PROMPT_PROFILE_NAME = 80;
export const MAX_PROJECT_PROFILE_PROMPT = 120000;
export const EMPTY_PROJECT_PROMPT_PROFILES: readonly ProjectPromptProfile[] = [];

export interface ProjectPromptProfileState {
  profiles: readonly ProjectPromptProfile[];
  selectedProfileId?: string;
}

/** Invalid snapshots are discarded whole, never repaired into different instructions. */
export function sanitizeProjectPromptProfiles(value: unknown): ProjectPromptProfile[] {
  if (!Array.isArray(value)) return [];
  const profiles: ProjectPromptProfile[] = [];
  const ids = new Set<string>();
  for (const entry of value.slice(0, MAX_PROJECT_PROMPT_PROFILES)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== "string" || !raw.id.trim() || raw.id.length > 100 || ids.has(raw.id)
      || typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > MAX_PROJECT_PROMPT_PROFILE_NAME
      || typeof raw.prompt !== "string" || !raw.prompt.trim() || raw.prompt.length > MAX_PROJECT_PROFILE_PROMPT
      || (raw.mode !== "append" && raw.mode !== "replace")) continue;
    profiles.push({ id: raw.id, name: raw.name.trim(), prompt: raw.prompt, mode: raw.mode });
    ids.add(raw.id);
  }
  return profiles;
}

/** Selection is metadata only. A corrupt/stale id never replaces the active text. */
export function sanitizeProjectPromptProfileOverrides(overrides: ProjectOverrides): ProjectOverrides {
  const result = { ...overrides };
  const profiles = sanitizeProjectPromptProfiles(overrides.systemPromptProfiles);
  if (profiles.length) result.systemPromptProfiles = profiles;
  else delete result.systemPromptProfiles;
  const selected = profiles.find((profile) => profile.id === overrides.systemPromptProfileId);
  if (!selected || selected.prompt.trim() !== overrides.systemPrompt?.trim() || selected.mode !== (overrides.systemPromptMode ?? "replace")) {
    delete result.systemPromptProfileId;
  }
  return result;
}

/** Preserve local profile edits while accepting unrelated incoming changes. */
export function mergeProjectPromptProfileDrafts(
  baseline: readonly ProjectPromptProfile[],
  drafts: readonly ProjectPromptProfile[],
  incoming: readonly ProjectPromptProfile[],
): ProjectPromptProfile[] {
  const baselineById = new Map(baseline.map((profile) => [profile.id, profile]));
  const draftsById = new Map(drafts.map((profile) => [profile.id, profile]));
  const incomingIds = new Set(incoming.map((profile) => profile.id));
  const changed = (profile: ProjectPromptProfile, base: ProjectPromptProfile) =>
    profile.name !== base.name || profile.prompt !== base.prompt || profile.mode !== base.mode;
  const merged = incoming.flatMap<ProjectPromptProfile>((profile) => {
    const base = baselineById.get(profile.id);
    const draft = draftsById.get(profile.id);
    if (base && !draft) return [];
    // A retained local edit can outlive an incoming deletion. If that id
    // reappears after the baseline advanced, it is still an authored draft.
    if (!base) return [draft ?? profile];
    if (!draft) return [profile];
    // Naming is independent of the authored instruction snapshot. Keep prompt
    // and mode together so a remote mode change cannot reinterpret local text.
    const instructionEdited = draft.prompt !== base.prompt || draft.mode !== base.mode;
    return [{
      ...profile,
      name: draft.name !== base.name ? draft.name : profile.name,
      ...(instructionEdited ? { prompt: draft.prompt, mode: draft.mode } : {}),
    }];
  });
  return [...merged, ...drafts.filter((profile) => {
    if (incomingIds.has(profile.id)) return false;
    const base = baselineById.get(profile.id);
    return !base || changed(profile, base);
  })];
}

/** The existing project state writer saves the active prompt and profile edits atomically. */
export function updateProjectPromptOverrides(
  previous: ProjectOverrides | undefined,
  prompt: string | undefined,
  mode: ProjectPromptMode,
  profileState?: ProjectPromptProfileState,
): ProjectOverrides | undefined {
  const overrides = { ...previous };
  if (prompt?.trim()) {
    overrides.systemPrompt = prompt.trim();
    if (mode === "append") overrides.systemPromptMode = "append";
    else delete overrides.systemPromptMode;
  } else {
    delete overrides.systemPrompt;
    delete overrides.systemPromptMode;
  }
  if (profileState) {
    overrides.systemPromptProfiles = [...profileState.profiles];
    overrides.systemPromptProfileId = profileState.selectedProfileId;
  }
  const sanitized = sanitizeProjectPromptProfileOverrides(overrides);
  return Object.keys(sanitized).length ? sanitized : undefined;
}
