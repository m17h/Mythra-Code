import { invoke } from "@tauri-apps/api/core";
import type { SkillDependencyReport, SkillReference } from "../types";
import { emptySkillDependencyReport, hasBlockedSkillDependencies, SkillDependencyError, validSkillDependencyReport } from "./skillDependencies";
import { displayedUserMessage } from "./userMessageEcho";

export { SkillDependencyError } from "./skillDependencies";

export interface LocalSkillFile {
  path: string;
  relativePath: string;
  fileName: string;
  defaultName: string;
  description: string;
  supportingMarkdownCount: number;
  contentFingerprint?: string;
}

export interface LocalSkill extends LocalSkillFile {
  name: string;
  enabled: boolean;
}

export interface SkillBridgeConfig {
  sourcePath: string;
  name: string;
  enabled: boolean;
}

/** Provider delivery text; authored user and system instructions keep their own channels. */
export interface ResolvedSkillPrompts {
  prompt: string;
  systemPrompt: string;
  skillReferences?: SkillReference[];
  skillsFolder?: string;
  skillDependencies?: SkillDependencyReport;
}

export interface SkillPromptAnalysisOverride {
  rootSkillPath?: string;
  rootSkillContent?: string;
}

export function normalizeSkillName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

export function resolveLocalSkills(
  files: LocalSkillFile[],
  aliases: Record<string, string>,
  disabledPaths: string[],
  removedPaths: string[] = [],
): LocalSkill[] {
  const used = new Set<string>();
  return files.filter((file) => !removedPaths.includes(file.path)).map((file) => {
    const requested = normalizeSkillName(aliases[file.path] || file.defaultName) || "skill";
    let name = requested;
    let suffix = 2;
    while (used.has(name)) {
      const ending = `-${suffix}`;
      name = `${requested.slice(0, 64 - ending.length)}${ending}`;
      suffix += 1;
    }
    used.add(name);
    return { ...file, name, enabled: !disabledPaths.includes(file.path) };
  });
}

export async function scanLocalSkills(folder: string): Promise<LocalSkillFile[]> {
  return invoke<LocalSkillFile[]>("local_skills_scan", { folder });
}

function skillBridges(skills: LocalSkill[]): SkillBridgeConfig[] {
  return skills.map((skill) => ({
    sourcePath: skill.path,
    name: skill.name,
    enabled: skill.enabled,
  }));
}

/** Stable identity for the native provider runtime prepared from this library. */
export function skillRuntimeSignature(folder: string, skills: LocalSkill[]): string {
  return JSON.stringify([
    folder,
    skills.map((skill) => [skill.path, skill.name, skill.enabled, skill.contentFingerprint ?? ""]),
  ]);
}

export async function syncLocalSkills(folder: string, skills: LocalSkill[]): Promise<string> {
  return invoke<string>("local_skills_sync", { folder, skills: skillBridges(skills) });
}

/**
 * Names the native parser reads as @ mentions, using the same boundary rules
 * prompt resolution uses. It touches no folder, so a skills library that failed
 * to load can still tell a skill-shaped mention from an e-mail address or a
 * file path without a second parser drifting away from the Rust one.
 */
export async function skillMentionNames(message: string): Promise<string[]> {
  if (!message.includes("@")) return [];
  return invoke<string[]>("local_skills_mention_names", { message });
}

/** Resolve exact enabled @skill mentions from authored text while preserving the full message. */
export async function resolveSkillPrompt(message: string, folder: string, skills: LocalSkill[], mentionSource?: string): Promise<string> {
  if (!(mentionSource ?? message).includes("@") && !message.includes("mythra_code_invoked_skills")) return message;
  return invoke<string>("local_skills_resolve_prompt", { folder, message, skills: skillBridges(skills), mentionSource });
}

const INVALID_DEPENDENCY_REPORT = "The skill dependency report was invalid. Skills were not loaded and the model was not started.";

/** Compatibility receipts must fail closed during sending. History display
 * deliberately remains lenient so a damaged old record can still be read. */
function deliveryEnvelopeReport(text: string): SkillDependencyReport | undefined {
  if (!text.startsWith("<mythra_code_invoked_skills>\n")) return undefined;
  const start = text.indexOf("\n{");
  const end = text.indexOf("\n</mythra_code_invoked_skills>");
  if (start < 0 || end < start || end - start > 2_000_000) throw new Error(INVALID_DEPENDENCY_REPORT);
  let payload;
  try { payload = JSON.parse(text.slice(start + 1, end)); }
  catch { throw new Error(INVALID_DEPENDENCY_REPORT); }
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.skills)
    || (typeof payload.userMessage !== "string" && typeof payload.systemPrompt !== "string")) throw new Error(INVALID_DEPENDENCY_REPORT);
  if (!Object.hasOwn(payload, "dependencyReport") && !Object.hasOwn(payload, "skillDependencies")) return undefined;
  const report = validSkillDependencyReport(payload.dependencyReport ?? payload.skillDependencies);
  if (!report) throw new Error(INVALID_DEPENDENCY_REPORT);
  return report;
}

/** Resolve both authored channels with one selected-library validation and one turn budget. */
export async function resolveSkillPrompts(message: string, systemPrompt: string, folder: string, skills: LocalSkill[], mentionSource?: string): Promise<ResolvedSkillPrompts> {
  if (!(mentionSource ?? message).includes("@") && !systemPrompt.includes("@")
    && !message.includes("mythra_code_invoked_skills") && !systemPrompt.includes("mythra_code_invoked_skills")) {
    return { prompt: message, systemPrompt };
  }
  const resolved = await invoke<ResolvedSkillPrompts>("local_skills_resolve_prompts", {
    folder, message, systemPrompt, skills: skillBridges(skills), mentionSource,
  });
  const restored = displayedUserMessage(resolved.prompt);
  // Modern bridges supply one authoritative, complete device report. Older
  // bridges can carry it in either authored channel; validate every recovered
  // report rather than silently dropping invalid or blocked system metadata.
  const reports = resolved.skillDependencies === undefined
    ? [deliveryEnvelopeReport(resolved.prompt), deliveryEnvelopeReport(resolved.systemPrompt)]
    : [validSkillDependencyReport(resolved.skillDependencies)];
  if (resolved.skillDependencies !== undefined && !reports[0]) throw new Error(INVALID_DEPENDENCY_REPORT);
  for (const report of reports) if (report && hasBlockedSkillDependencies(report)) throw new SkillDependencyError(report);
  const report = reports.find((entry) => entry !== undefined);
  return { ...resolved,
    ...(resolved.skillReferences === undefined && restored.skillReferences !== undefined ? { skillReferences: restored.skillReferences } : {}),
    ...(resolved.skillsFolder === undefined && restored.skillsFolder !== undefined ? { skillsFolder: restored.skillsFolder } : {}),
    ...(report ? { skillDependencies: report } : restored.skillDependencies ? { skillDependencies: restored.skillDependencies } : {}) };
}

/** Preview uses the native parser and filesystem rules, including unsaved root
 * content. Reported dependency issues are data; ordinary read/bridge errors reject. */
export async function analyzeSkillPrompts(message: string, systemPrompt: string, folder: string, skills: LocalSkill[], mentionSource?: string, override?: SkillPromptAnalysisOverride): Promise<SkillDependencyReport> {
  if (!override && !(mentionSource ?? message).includes("@") && !systemPrompt.includes("@")) return emptySkillDependencyReport();
  const result = await invoke<SkillDependencyReport>("local_skills_analyze_prompts", {
    folder, message, systemPrompt, skills: skillBridges(skills), mentionSource,
    ...(override?.rootSkillPath !== undefined ? { rootSkillPath: override.rootSkillPath } : {}),
    ...(override?.rootSkillContent !== undefined ? { rootSkillContent: override.rootSkillContent } : {}),
  });
  const report = validSkillDependencyReport(result);
  if (!report) throw new Error("The skill dependency preview report was invalid.");
  return report;
}

export async function importLocalSkills(folder: string, paths: string[]): Promise<string[]> {
  return invoke<string[]>("local_skills_import", { folder, paths });
}

export async function createLocalSkill(folder: string, name: string, instructions: string): Promise<string> {
  return invoke<string>("local_skills_create", { folder, name, instructions });
}

export async function readLocalSkill(folder: string, path: string): Promise<string> {
  return invoke<string>("local_skills_read", { folder, path });
}

export async function updateLocalSkill(folder: string, path: string, content: string, original: string): Promise<void> {
  return invoke<void>("local_skills_update", { folder, path, content, original });
}

export async function deleteLocalSkill(folder: string, path: string): Promise<void> {
  return invoke<void>("local_skills_delete", { folder, path });
}
