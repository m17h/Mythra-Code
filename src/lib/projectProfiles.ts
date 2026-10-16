import type { ChildAgentTarget, Project, ProjectOverrides, ProjectSubagentSettings } from "../types";
import { CHILD_AGENT_REASONING_EFFORTS, sanitizeProjectSubagentOverrides, sanitizeProjectSubagentSettings } from "./childAgents";
import { sanitizeProjectCheckOverrides } from "./projectChecks";
import { sanitizeProjectDefaultOverrides } from "./projectDefaults";
import { MAX_PROJECT_PROFILE_PROMPT } from "./projectPromptProfiles";
import { sanitizeProjectRunOverrides } from "./projectRun";
import { autoCompactTokensError } from "./threadSubagentSettings";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Imported policies must be complete; storage migration must not invent a crew. */
function importedSubagentPolicy(value: unknown): ProjectSubagentSettings | null {
  if (!isRecord(value) || typeof value.enabled !== "boolean"
    || typeof value.maxConcurrent !== "number" || !Number.isInteger(value.maxConcurrent) || value.maxConcurrent < 1
    || !isRecord(value.childAgents) || typeof value.childAgents.enabled !== "boolean"
    || !Array.isArray(value.childAgents.targets)) return null;
  const targets = value.childAgents.targets;
  for (const target of targets) {
    if (!isRecord(target) || typeof target.id !== "string" || typeof target.provider !== "string"
      || typeof target.model !== "string" || typeof target.label !== "string" || typeof target.description !== "string"
      || typeof target.enabled !== "boolean"
      || !["inherit", "fixed", "agent"].includes(target.reasoningMode as string)
      || !CHILD_AGENT_REASONING_EFFORTS.includes(target.reasoningEffort as ChildAgentTarget["reasoningEffort"])
      || !CHILD_AGENT_REASONING_EFFORTS.includes(target.reasoningMaxEffort as ChildAgentTarget["reasoningMaxEffort"])
      || autoCompactTokensError(target.autoCompactTokens) !== null) return null;
  }
  const policy = sanitizeProjectSubagentSettings(value);
  // Preserve benign normalization and concurrency limits, but never accept a
  // partial roster after invalid ids/providers, duplicates or excess entries
  // were discarded. An explicitly empty roster is a valid authored choice.
  if (!policy || policy.childAgents.targets.length !== targets.length) return null;
  // A model identity must not become a different destination through truncation.
  if (policy.childAgents.targets.some((target, index) => target.model !==
    (targets[index] as Record<string, string>).model.replace(/\s+/g, " ").trim())) return null;
  return policy;
}

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
  if (!isRecord(value)) return {};
  const raw = value;
  const candidate: Record<string, unknown> = {};
  for (const keys of Object.values(PART_KEYS)) {
    for (const key of keys) if (raw[key] !== undefined) candidate[key] = raw[key];
  }
  if (typeof candidate.systemPrompt !== "string" || candidate.systemPrompt.length > MAX_PROJECT_PROFILE_PROMPT) delete candidate.systemPrompt;
  if (candidate.systemPromptMode !== "append" && candidate.systemPromptMode !== "replace") delete candidate.systemPromptMode;
  const subagents = importedSubagentPolicy(candidate.subagents);
  if (subagents) candidate.subagents = subagents;
  else delete candidate.subagents;
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
  if (!isRecord(parsed)) throw new Error("This file is not a valid project profile.");
  const value = parsed;
  if (value.format !== FORMAT || value.version !== VERSION) throw new Error("Unsupported project profile format or version.");
  const raw = isRecord(value.settings) ? value.settings : {};
  const settings = sanitizeProjectProfile(raw);
  const kept = new Set(projectProfileParts(settings));
  // Raw file values are not ProjectOverrides yet: count the supplied keys
  // without calling typed methods such as systemPrompt.trim() on them.
  const dropped = PROJECT_PROFILE_PARTS.map((part) => part.id).filter((part) =>
    PART_KEYS[part].some((key) => Object.prototype.hasOwnProperty.call(raw, key)) && !kept.has(part));
  if (!kept.size) throw new Error(dropped.length ? "None of the settings in this profile could be used." : "This project profile has no settings.");
  const name = typeof value.name === "string" ? value.name.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  return { name: name || "Imported profile", settings, dropped };
}
