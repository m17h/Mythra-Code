import type { Activity, ChatMessage, SkillUsage, ThreadItem } from "../types";
import type { CompactWorkEntry } from "./compactActivity";
import { hasBlockedSkillDependencies, isSkillDependencyPath, validSkillDependencyReport } from "./skillDependencies";
import { validSkillReferences } from "./skillReferences";

export interface UsedSkill {
  identity: string;
  name: string;
  path?: string;
}

function validName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && Boolean(value.trim())
    && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Bound provider and persisted metadata, retaining only the declared fields. */
export function validSkillUsage(value: unknown): SkillUsage[] {
  if (!Array.isArray(value) || value.length > 64) return [];
  return value.flatMap((entry): SkillUsage[] => {
    if (!entry || typeof entry !== "object" || !validName(entry.name)
      || (entry.path !== undefined && !isSkillDependencyPath(entry.path))) return [];
    const claude = entry.source === "claude-skill-tool"
      && ["pending", "loaded", "failed"].includes(entry.status);
    const codex = entry.source === "codex-skill-input" && entry.status === "selected" && entry.path !== undefined;
    if (!claude && !codex) return [];
    return [{ name: entry.name.trim(), source: entry.source, status: entry.status,
      ...(entry.path !== undefined ? { path: entry.path } : {}) }];
  });
}

export function sanitizeSkillUsage<T extends Activity | ChatMessage>(entry: T): T {
  if (entry.skillUsage === undefined) return entry;
  const { skillUsage: _metadata, ...rest } = entry;
  const skillUsage = validSkillUsage(entry.skillUsage);
  return { ...rest, ...(skillUsage.length ? { skillUsage } : {}) } as T;
}

export function estimateSkillUsageBytes(value: unknown): number {
  return validSkillUsage(value).reduce((total, entry) => total + 128
    + (entry.name.length + (entry.path?.length ?? 0) + entry.source.length + entry.status.length) * 2, 0);
}

/** A completed native Skill call supplies its skill identity in the input.
 * Successful tool_result is required before the collector counts it as loaded. */
export function claudeToolSkillUsage(tool: string, input: Record<string, unknown>): SkillUsage[] {
  if (tool !== "Skill" || !validName(input.skill)) return [];
  return [{ name: input.skill.trim(), source: "claude-skill-tool", status: "pending" }];
}

/** Native input proves which explicit skill the provider retained. Other input
 * types (including mentions and text) are not skill activation evidence. */
export function codexInputSkillUsage(item: ThreadItem): SkillUsage[] {
  if (item.type !== "userMessage") return [];
  return validSkillUsage((item.content ?? []).flatMap((content) => {
    if (typeof content === "string" || content.type !== "skill") return [];
    return [{ name: content.name, path: content.path, source: "codex-skill-input", status: "selected" }];
  }));
}

function pathIdentity(path: string, windowsUncPaths: ReadonlySet<string>): string {
  // Exactly two leading POSIX slashes have implementation-defined semantics.
  // Only reconcile a forward-slash UNC spelling when this run also records
  // its unambiguous Windows backslash counterpart.
  const windows = /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\")
    || (path.startsWith("//") && windowsUncPaths.has(path.toLowerCase().replace(/\/+$/, "")));
  const normalized = (windows ? path.replaceAll("\\", "/") : path).replace(/\/+$/, "");
  // Windows paths are case insensitive; POSIX paths are not.
  return `path:${windows ? normalized.toLowerCase() : normalized}`;
}

function nameIdentity(skill: { name: string; source?: SkillUsage["source"] }): string {
  // This exact namespace is emitted by Mythra's native Claude bridge, whose
  // Skill tool name corresponds to the explicitly loaded source's local name.
  // Never strip arbitrary third-party plugin prefixes.
  return (skill.source === "claude-skill-tool" ? skill.name.replace(/^openkiwi-skills:/, "") : skill.name).toLowerCase();
}

/** Collect only the run's recorded load/selection evidence. A dependency report
 * is authoritative even when empty or blocked, so references never override it.
 * This cannot observe automatic activations a provider does not report. */
export function usedSkillsForRun(entries: readonly CompactWorkEntry[]): UsedSkill[] {
  const candidates: Array<{ name: string; path?: string; source?: SkillUsage["source"] }> = [];
  for (const entry of entries) {
    if (entry.kind === "message") {
      const message = entry.value;
      if (message.role !== "user") continue;
      if (message.skillDependencies !== undefined) {
        const report = validSkillDependencyReport(message.skillDependencies);
        // A blocked prompt never reached the model, including partially read
        // dependencies. Do not claim those partial reads as run instructions.
        if (report && !hasBlockedSkillDependencies(report)) {
          candidates.push(...report.nodes.filter((node) => node.kind === "skill" && node.status === "loaded")
            .map(({ name, path }) => ({ name, path })));
          // Several authored invocation aliases can resolve to one source.
          // Retain their path mapping for native tool identity reconciliation.
          candidates.push(...report.roots.flatMap((root) => {
            const node = report.nodes.find((node) => node.id === root.nodeId);
            return node ? [{ name: root.name, path: node.path }] : [];
          }));
        }
      } else {
        candidates.push(...validSkillReferences(message.text, message.skillReferences).map(({ name, path }) => ({ name, path })));
      }
      candidates.push(...validSkillUsage(message.skillUsage).filter((usage) => usage.status === "selected"));
    } else {
      const activities = entry.kind === "activity" ? [entry.value] : entry.value;
      for (const activity of activities) {
        candidates.push(...validSkillUsage(activity.skillUsage).filter((usage) => usage.status === "loaded"));
      }
    }
  }
  const windowsUncPaths = new Set(candidates.flatMap((skill) => skill.path?.startsWith("\\\\")
    ? [skill.path.replaceAll("\\", "/").toLowerCase().replace(/\/+$/, "")] : []));
  const pathsByName = new Map<string, Set<string>>();
  for (const skill of candidates) {
    if (!skill.path) continue;
    const name = nameIdentity(skill);
    const paths = pathsByName.get(name) ?? new Set<string>();
    paths.add(pathIdentity(skill.path, windowsUncPaths));
    pathsByName.set(name, paths);
  }
  const used = new Map<string, UsedSkill>();
  for (const skill of candidates) {
    const name = nameIdentity(skill);
    const paths = pathsByName.get(name);
    // Only Mythra's own bridge namespace establishes correspondence with a
    // loaded local source. A bare Claude skill may be from the user's home
    // library; a matching display name alone cannot establish its path.
    const ownBridge = skill.source === "claude-skill-tool" && skill.name.startsWith("openkiwi-skills:");
    const identity = skill.path ? pathIdentity(skill.path, windowsUncPaths)
      : ownBridge && paths?.size === 1 ? [...paths][0] : `name:${skill.name.toLowerCase()}`;
    const previous = used.get(identity);
    if (!previous || (!previous.path && skill.path)) used.set(identity, { identity, name: skill.name,
      ...(skill.path ? { path: skill.path } : {}) });
  }
  return [...used.values()];
}
