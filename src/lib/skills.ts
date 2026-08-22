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

export async function syncLocalSkills(folder: string, skills: LocalSkill[]): Promise<string> {
  const bridges: SkillBridgeConfig[] = skills.map((skill) => ({
    sourcePath: skill.path,
    name: skill.name,
    enabled: skill.enabled,
  }));
  return invoke<string>("local_skills_sync", { folder, skills: bridges });
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
