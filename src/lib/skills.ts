import { invoke } from "@tauri-apps/api/core";

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

/** Resolve exact enabled @skill mentions inside the native selected-folder boundary. */
export async function resolveSkillPrompt(message: string, folder: string, skills: LocalSkill[]): Promise<string> {
  if (!message.includes("@") && !message.includes("mythra_code_invoked_skills")) return message;
  return invoke<string>("local_skills_resolve_prompt", { folder, message, skills: skillBridges(skills) });
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
