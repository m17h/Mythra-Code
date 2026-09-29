import type { ProjectPromptMode, Provider, SkillDependencyReport } from "../types";
import { skillMentionRanges } from "./skillMentions";
import { buildSkillReferenceMap } from "./skillReferenceMap";

export type SkillPromptRepairLayer = "project" | "codex" | "claude" | "global";

export interface SkillPromptRepairTarget {
  layer: SkillPromptRepairLayer;
  name: string;
}

/** Only offer editors whose authored text contributed to this blocked turn.
 * A replacing project prompt suppresses the global and subscription layers. */
export function blockedSystemPromptTargets(report: SkillDependencyReport, prompts: {
  global: string;
  codex: string;
  claude: string;
  project?: string;
  projectMode?: ProjectPromptMode;
  provider: Provider;
}): SkillPromptRepairTarget[] {
  const candidates = new Set(report.roots.filter((root) => root.channel === "system").map((root) => root.name.toLowerCase()));
  // A report-limit failure can retain its named system reference after the
  // graph is dropped. Do not turn a user-only failure into a prompt link.
  if (!report.roots.length && report.issues.some((issue) => issue.code === "report-limit")) {
    for (const issue of report.issues) {
      const name = issue.rootName?.replace(/^@/, "").toLowerCase();
      if (name) candidates.add(name);
    }
  }
  const blocked = [...candidates].filter((name) => buildSkillReferenceMap(name, { report, channel: "system" }).flagged);
  if (!blocked.length) return [];
  const activeProject = prompts.project?.trim() ?? "";
  const inherited = !activeProject || prompts.projectMode === "append";
  const layers: Array<[SkillPromptRepairLayer, string]> = [];
  if (activeProject) layers.push(["project", activeProject]);
  if (inherited) {
    if (prompts.provider === "openai") layers.push(["codex", prompts.codex]);
    if (prompts.provider === "claude") layers.push(["claude", prompts.claude]);
    layers.push(["global", prompts.global]);
  }
  return layers.flatMap(([layer, text]) => {
    const match = skillMentionRanges(text, blocked.map((name) => ({ name })))[0];
    return match ? [{ layer, name: match.skill.name }] : [];
  });
}
