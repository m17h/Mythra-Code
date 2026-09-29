import type { ChatMessage, SkillDependencyReport } from "../types";

/** Display and persistence use the same limits as native resolution. Native
 * remains authoritative for filesystem reads and enforcing the turn budget. */
export const SKILL_DEPENDENCY_LIMITS = Object.freeze({
  maxDepth: 4,
  maxSkills: 8,
  maxFiles: 24,
  maxCharacters: 120000,
  maxFileBytes: 1048576,
} as const);

export function emptySkillDependencyReport(): SkillDependencyReport {
  return { version: 1, limits: { ...SKILL_DEPENDENCY_LIMITS }, roots: [], nodes: [], edges: [], issues: [] };
}

// Reports include blocked discoveries beyond the loading limits. Bound their
// metadata independently, so corrupt history cannot allocate an unbounded graph.
const MAX_REPORT_NODES = 256;
const MAX_REPORT_EDGES = 1024;
const MAX_REPORT_ROOTS = 64;
const MAX_REPORT_ISSUES = 256;
const MAX_METADATA_CHARACTERS = 512_000;
const MAX_PATH_CHARACTERS = 4096;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedText(value: unknown, max = MAX_PATH_CHARACTERS, nonempty = true): value is string {
  return typeof value === "string" && value.length <= max && (!nonempty || Boolean(value.trim()))
    && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Graph file links are local absolute paths only, never saved URLs or commands. */
export function isSkillDependencyPath(value: unknown): value is string {
  return boundedText(value) && (/^\//.test(value) || /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value));
}

/** Rebuild only the contract fields. Invalid metadata is discarded as a whole:
 * a partial graph could misrepresent which sources were actually loaded. */
export function validSkillDependencyReport(value: unknown): SkillDependencyReport | undefined {
  if (!record(value) || value.version !== 1 || !record(value.limits)
    || !Object.entries(SKILL_DEPENDENCY_LIMITS).every(([key, limit]) => value.limits && (value.limits as Record<string, unknown>)[key] === limit)
    || !Array.isArray(value.roots) || value.roots.length > MAX_REPORT_ROOTS
    || !Array.isArray(value.nodes) || value.nodes.length > MAX_REPORT_NODES
    || !Array.isArray(value.edges) || value.edges.length > MAX_REPORT_EDGES
    || !Array.isArray(value.issues) || value.issues.length > MAX_REPORT_ISSUES) return undefined;

  let characters = 0;
  const text = (candidate: unknown, max = MAX_PATH_CHARACTERS, nonempty = true): candidate is string => {
    if (!boundedText(candidate, max, nonempty)) return false;
    characters += candidate.length;
    return characters <= MAX_METADATA_CHARACTERS;
  };
  const nodes: SkillDependencyReport["nodes"] = [];
  const nodeIds = new Set<string>();
  let loadedSkills = 0;
  let loadedFiles = 0;
  let loadedCharacters = 0;
  for (const node of value.nodes) {
    if (!record(node) || !text(node.id, 256) || nodeIds.has(node.id)
      || (node.kind !== "skill" && node.kind !== "document") || !text(node.name)
      || !text(node.path, MAX_PATH_CHARACTERS, false) || (!isSkillDependencyPath(node.path) && !(node.status === "blocked" && node.path === ""))
      || (node.status !== "loaded" && node.status !== "blocked")
      || !Number.isSafeInteger(node.characterCount) || (node.characterCount as number) < 0 || (node.characterCount as number) > SKILL_DEPENDENCY_LIMITS.maxFileBytes
      || !Number.isSafeInteger(node.depth) || (node.depth as number) < 0 || (node.depth as number) > SKILL_DEPENDENCY_LIMITS.maxDepth + 1
      || (node.contentHash !== undefined && (!text(node.contentHash, 64) || !/^[a-f0-9]{64}$/i.test(node.contentHash)))) return undefined;
    if (node.status === "loaded") {
      loadedFiles += 1;
      loadedSkills += node.kind === "skill" ? 1 : 0;
      loadedCharacters += node.characterCount as number;
      if (loadedFiles > SKILL_DEPENDENCY_LIMITS.maxFiles || loadedSkills > SKILL_DEPENDENCY_LIMITS.maxSkills
        || loadedCharacters > SKILL_DEPENDENCY_LIMITS.maxCharacters || (node.depth as number) > SKILL_DEPENDENCY_LIMITS.maxDepth) return undefined;
    }
    nodeIds.add(node.id);
    nodes.push({ id: node.id, kind: node.kind, name: node.name, path: node.path, status: node.status,
      characterCount: node.characterCount as number, depth: node.depth as number,
      ...(node.contentHash !== undefined ? { contentHash: node.contentHash as string } : {}) });
  }
  const roots: SkillDependencyReport["roots"] = [];
  const rootKeys = new Set<string>();
  for (const root of value.roots) {
    if (!record(root) || !text(root.nodeId, 256) || !nodeIds.has(root.nodeId)
      || (root.channel !== "system" && root.channel !== "user") || !text(root.name, 256)) return undefined;
    const key = `${root.channel}:${root.nodeId}:${root.name}`;
    if (rootKeys.has(key) || nodes.find((node) => node.id === root.nodeId)?.kind !== "skill") return undefined;
    rootKeys.add(key);
    roots.push({ nodeId: root.nodeId, channel: root.channel, name: root.name });
  }
  const edges: SkillDependencyReport["edges"] = [];
  for (const edge of value.edges) {
    if (!record(edge) || !text(edge.from, 256) || !nodeIds.has(edge.from) || !text(edge.to, 256) || !nodeIds.has(edge.to)
      || !text(edge.reference)) return undefined;
    edges.push({ from: edge.from, to: edge.to, reference: edge.reference });
  }
  const issues: SkillDependencyReport["issues"] = [];
  for (const issue of value.issues) {
    if (!record(issue) || !text(issue.code, 128) || !text(issue.message, 8192)
      || !Array.isArray(issue.chain) || issue.chain.length > 66 || !issue.chain.every((entry) => text(entry))
      || (issue.rootName !== undefined && !text(issue.rootName, 256))
      || (issue.sourcePath !== undefined && (!text(issue.sourcePath) || !isSkillDependencyPath(issue.sourcePath)))
      || (issue.reference !== undefined && !text(issue.reference))) return undefined;
    issues.push({ code: issue.code, message: issue.message, chain: [...issue.chain] as string[],
      ...(issue.rootName !== undefined ? { rootName: issue.rootName as string } : {}),
      ...(issue.sourcePath !== undefined ? { sourcePath: issue.sourcePath as string } : {}),
      ...(issue.reference !== undefined ? { reference: issue.reference as string } : {}) });
  }
  return { version: 1, limits: { ...SKILL_DEPENDENCY_LIMITS }, roots, nodes, edges, issues };
}

/** Apply at history and event boundaries, including metadata from older writers. */
export function sanitizeMessageSkillDependencies(message: ChatMessage): ChatMessage {
  if (message.skillDependencies === undefined) return message;
  const { skillDependencies: _metadata, ...rest } = message;
  const skillDependencies = validSkillDependencyReport(message.skillDependencies);
  return skillDependencies ? { ...rest, skillDependencies } : rest;
}

export function hasBlockedSkillDependencies(report: SkillDependencyReport): boolean {
  return report.issues.length > 0 || report.nodes.some((node) => node.status === "blocked");
}

export class SkillDependencyError extends Error {
  readonly report: SkillDependencyReport;
  readonly skillDependencies: SkillDependencyReport;

  constructor(report: SkillDependencyReport) {
    const reasons = report.issues.slice(0, 8).map((issue) => {
      const chain = issue.chain.join(" → ") || issue.rootName || issue.reference || "Skill dependency";
      return `${chain}: ${issue.message}`;
    });
    if (!reasons.length) reasons.push("A skill dependency could not be loaded.");
    super(`${reasons.join("\n")}\nSkills were not loaded and the model was not started.`);
    this.name = "SkillDependencyError";
    this.report = report;
    this.skillDependencies = report;
  }
}

/** Conservative retained-memory accounting without serializing instruction text. */
export function estimateSkillDependencyBytes(value: unknown): number {
  const report = validSkillDependencyReport(value);
  if (!report) return 0;
  const bytes = (text: string | undefined) => (text?.length ?? 0) * 2;
  return 512
    + report.roots.reduce((total, root) => total + 128 + bytes(root.nodeId) + bytes(root.channel) + bytes(root.name), 0)
    + report.nodes.reduce((total, node) => total + 256 + bytes(node.id) + bytes(node.kind) + bytes(node.name) + bytes(node.path) + bytes(node.status) + bytes(node.contentHash), 0)
    + report.edges.reduce((total, edge) => total + 128 + bytes(edge.from) + bytes(edge.to) + bytes(edge.reference), 0)
    + report.issues.reduce((total, issue) => total + 256 + bytes(issue.code) + bytes(issue.message) + bytes(issue.rootName) + bytes(issue.sourcePath) + bytes(issue.reference)
      + issue.chain.reduce((sum, entry) => sum + 16 + bytes(entry), 0), 0);
}
