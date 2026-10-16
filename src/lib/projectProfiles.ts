import type { Project, ProjectOverrides } from "../types";
import { sanitizeProjectSubagentOverrides } from "./childAgents";
import { sanitizeProjectCheckOverrides } from "./projectChecks";
import { sanitizeProjectDefaultOverrides } from "./projectDefaults";
import { MAX_PROJECT_PROFILE_PROMPT } from "./projectPromptProfiles";
import { sanitizeProjectRunOverrides } from "./projectRun";

/**
 * A project profile is everything a project changes from the app defaults:
 * the same overrides Settings, Project instructions, Run, Check and the
 * sub-agent controls already store per project, grouped so they can be seen
 * together, copied to another project, or shared as a file.
 */
export type ProjectProfilePart = "defaults" | "instructions" | "run" | "check" | "subagents";

export const PROJECT_PROFILE_PARTS: ReadonlyArray<{ id: ProjectProfilePart; label: string }> = [
  { id: "defaults", label: "Provider, model and look" },
  { id: "instructions", label: "Project instructions" },
  { id: "run", label: "Run button" },
  { id: "check", label: "Check button" },
  { id: "subagents", label: "Sub-agent settings" },
];

/** Parts that hold shell commands, which run from the project folder when clicked. */
export const PROJECT_PROFILE_COMMAND_PARTS: ReadonlySet<ProjectProfilePart> = new Set(["run", "check"]);

const PART_KEYS: Record<ProjectProfilePart, ReadonlyArray<keyof ProjectOverrides>> = {
  defaults: ["defaults"],
  instructions: ["systemPrompt", "systemPromptMode", "systemPromptProfiles", "systemPromptProfileId"],
  run: ["run"],
  check: ["check"],
  subagents: ["subagents"],
};

const FORMAT = "mythra-project-profile";
const VERSION = 1;
export const MAX_PROJECT_PROFILE_BYTES = 4 * 1024 * 1024;

export function projectProfileParts(overrides: ProjectOverrides | undefined): ProjectProfilePart[] {
  if (!overrides) return [];
  return PROJECT_PROFILE_PARTS
    .map((part) => part.id)
    .filter((part) => part === "instructions"
      ? Boolean(overrides.systemPrompt?.trim() || overrides.systemPromptProfiles?.length)
      : PART_KEYS[part].some((key) => overrides[key] !== undefined));
}

/** The selected parts of a profile, and nothing else. */
export function pickProjectProfile(overrides: ProjectOverrides | undefined, parts: Iterable<ProjectProfilePart>): ProjectOverrides {
  const result: Record<string, unknown> = {};
  if (!overrides) return result;
  for (const part of parts) {
    for (const key of PART_KEYS[part]) {
      if (overrides[key] !== undefined) result[key] = structuredClone(overrides[key]);
    }
  }
  return result as ProjectOverrides;
}

/**
 * Replace the chosen parts of a project's settings with the profile's. A part
 * the profile does not have is cleared on the target, so the result matches
 * the source for every chosen part; unchosen parts are left as they were.
 */
export function applyProjectProfile(project: Project, profile: ProjectOverrides, parts: Iterable<ProjectProfilePart>): Project {
  const overrides: Record<string, unknown> = { ...(project.overrides ?? {}) };
  for (const part of parts) {
    for (const key of PART_KEYS[part]) {
      if (profile[key] !== undefined) overrides[key] = structuredClone(profile[key]);
      else delete overrides[key];
    }
  }
  return { ...project, overrides: Object.keys(overrides).length ? overrides as ProjectOverrides : undefined };
}

/** The same validation saved projects get at launch, applied to untrusted input. */
export function sanitizeProjectProfile(value: unknown): ProjectOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const candidate: Record<string, unknown> = {};
  for (const keys of Object.values(PART_KEYS)) {
    for (const key of keys) if (raw[key] !== undefined) candidate[key] = raw[key];
  }
  if (typeof candidate.systemPrompt !== "string" || candidate.systemPrompt.length > MAX_PROJECT_PROFILE_PROMPT) delete candidate.systemPrompt;
  if (candidate.systemPromptMode !== "append" && candidate.systemPromptMode !== "replace") delete candidate.systemPromptMode;
  // The stored-settings sanitizer fills gaps with defaults. A file must carry
  // a complete policy instead, so a malformed one is left out, not turned on or off.
  const subagents = candidate.subagents as Record<string, unknown> | undefined;
  if (subagents !== undefined && (!subagents || typeof subagents !== "object" || typeof subagents.enabled !== "boolean"
    || typeof subagents.maxConcurrent !== "number" || !subagents.childAgents || typeof subagents.childAgents !== "object")) delete candidate.subagents;
  const [project] = sanitizeProjectCheckOverrides(sanitizeProjectRunOverrides(sanitizeProjectDefaultOverrides(
    sanitizeProjectSubagentOverrides([{ id: "profile", name: "profile", path: "", overrides: candidate as ProjectOverrides }]),
  )));
  return { ...(project?.overrides ?? {}) };
}

export function exportProjectProfile(project: Project, parts: Iterable<ProjectProfilePart>): string {
  const settings = pickProjectProfile(project.overrides, parts);
  const contents = JSON.stringify({ format: FORMAT, version: VERSION, name: project.name, settings }, null, 2) + "\n";
  if (new TextEncoder().encode(contents).byteLength > MAX_PROJECT_PROFILE_BYTES) throw new Error("Project profiles must be smaller than 4 MB.");
  return contents;
}

export interface ImportedProjectProfile {
  name: string;
  settings: ProjectOverrides;
  /** Parts the file contained that did not pass validation. */
  dropped: ProjectProfilePart[];
}

export function importProjectProfile(contents: string): ImportedProjectProfile {
  if (new TextEncoder().encode(contents).byteLength > MAX_PROJECT_PROFILE_BYTES) throw new Error("Project profiles must be smaller than 4 MB.");
  let parsed: unknown;
  try { parsed = JSON.parse(contents); } catch { throw new Error("This file is not a valid project profile."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("This file is not a valid project profile.");
  const value = parsed as Record<string, unknown>;
  if (value.format !== FORMAT || value.version !== VERSION) throw new Error("Unsupported project profile format or version.");
  const raw = value.settings && typeof value.settings === "object" && !Array.isArray(value.settings)
    ? value.settings as ProjectOverrides : {};
  const settings = sanitizeProjectProfile(raw);
  const kept = new Set(projectProfileParts(settings));
  const dropped = projectProfileParts(raw).filter((part) => !kept.has(part));
  if (!kept.size) throw new Error(dropped.length ? "None of the settings in this profile could be used." : "This project profile has no settings.");
  const name = typeof value.name === "string" ? value.name.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  return { name: name || "Imported profile", settings, dropped };
}
