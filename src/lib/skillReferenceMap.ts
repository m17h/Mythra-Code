import type { SkillDependencyReport } from "../types";
import { hasBlockedSkillDependencies } from "./skillDependencies";

type Report = SkillDependencyReport;
type Issue = Report["issues"][number];
type Edge = Report["edges"][number];
type GraphNode = Report["nodes"][number];

/** `loads`: resolved and sent. `held`: resolved, but another blocker stops the
 * whole turn. `repeat`: already mapped earlier in this tree (shared file). */
export type SkillMapItemStatus = "loads" | "held" | "blocked" | "cycle" | "repeat";

export interface SkillMapItem {
  key: string;
  kind: "skill" | "document";
  label: string;
  /** Authored text in the parent that introduced this item. */
  reference?: string;
  path?: string;
  /** Folder relative to the skills folder (absolute when outside it), shown
   * so same-named files stay distinguishable without hovering. */
  location?: string;
  status: SkillMapItemStatus;
  /** The repeated node's own status, for `repeat` rows. */
  repeatOf?: "loads" | "held" | "blocked";
  reasonLabel?: string;
  reason?: string;
  /** This item, or something below it, stops the turn. */
  failurePath: boolean;
  children: SkillMapItem[];
}

export type SkillMapState =
  | "ready" | "held" | "blocked" | "incomplete" | "checking" | "unavailable" | "unknown";

export interface SkillReferenceMap {
  name: string;
  state: SkillMapState;
  /** Red token: this reference cannot be sent as written. */
  flagged: boolean;
  root?: SkillMapItem;
  /** Problems reported for this reference that no mapped item owns. */
  rootIssues: Issue[];
  /** Problems with no owning reference; they stop every reference. */
  turnIssues: Issue[];
  /** Other authored references whose failures hold this turn. */
  blockedElsewhere: string[];
  counts: { loads: number; held: number; blocked: number; skills: number; documents: number; characters: number };
  /** Labels from the root to the first failure, when there is one. */
  failure: string[];
  firstFailure?: SkillMapItem;
  truncated: boolean;
  error?: string;
}

const MAX_ITEMS = 400;

const REASON_LABELS: Record<string, string> = {
  "missing-file": "Missing file",
  "unsupported-document": "Unsupported type",
  cycle: "Cycle",
  "depth-limit": "Too deep",
  "skill-limit": "Over skill limit",
  "file-limit": "Over file limit",
  "character-limit": "Over size budget",
  "file-size-limit": "Over 1 MB",
  "reference-limit": "Too many references",
  "root-limit": "Too many skills",
  "report-limit": "Report too large",
  "unknown-skill": "Unknown skill",
  "disabled-skill": "Disabled",
  "ambiguous-skill": "Ambiguous name",
  "unavailable-skill": "Not in library",
  "outside-folder": "Outside skills folder",
  "malformed-link": "Invalid link",
  "invalid-utf8": "Not UTF-8",
  "invalid-path": "Invalid path",
  "read-error": "Unreadable",
  "changed-file": "Changed while read",
  "folder-error": "Skills folder error",
  "configuration-limit": "Too many aliases",
  "invalid-preview": "Invalid preview",
};

export function skillReasonLabel(code: string): string {
  return REASON_LABELS[code] ?? (code.charAt(0).toUpperCase() + code.slice(1).replace(/-/g, " "));
}

function issueOwner(issue: Issue): string | undefined {
  const owner = issue.rootName ?? issue.chain[0];
  return owner?.replace(/^@/, "").toLowerCase() || undefined;
}

function sameChain(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function nodeLabel(node: GraphNode): string {
  return node.kind === "skill" ? `@${node.name}` : node.name;
}

const segments = (path: string) => path.split(/[\\/]+/);

/** Skill files sit at <skills folder>/<…skill folder>/SKILL.md, so the
 * skills folder is the common parent of every skill folder in the report. */
function skillsFolder(nodes: readonly GraphNode[]): string[] | undefined {
  let common: string[] | undefined;
  for (const node of nodes) {
    if (node.kind !== "skill" || !node.path) continue;
    const parent = segments(node.path).slice(0, -2);
    if (!common) { common = parent; continue; }
    let length = 0;
    while (length < common.length && length < parent.length && common[length] === parent[length]) length += 1;
    common = common.slice(0, length);
  }
  return common;
}

function nodeLocation(node: GraphNode, folder: string[] | undefined): string | undefined {
  if (!node.path) return undefined;
  const separator = node.path.includes("\\") && !node.path.includes("/") ? "\\" : "/";
  const parts = segments(node.path).slice(0, -1);
  const inside = Boolean(folder?.length) && folder!.every((part, index) => parts[index] === part);
  const location = (inside ? parts.slice(folder!.length) : parts).join(separator);
  // A skill in its own same-named folder needs no location to be unambiguous.
  if (node.kind === "skill" && inside && location.toLowerCase() === node.name.toLowerCase()) return undefined;
  return location || undefined;
}

function emptyMap(name: string, state: SkillMapState, extra: Partial<SkillReferenceMap> = {}): SkillReferenceMap {
  return {
    name, state, flagged: state === "blocked" || state === "incomplete", rootIssues: [], turnIssues: [],
    blockedElsewhere: [], counts: { loads: 0, held: 0, blocked: 0, skills: 0, documents: 0, characters: 0 },
    failure: [], truncated: false, ...extra,
  };
}

export interface SkillReferenceMapInput {
  /** A validated report for the current text, or null while none applies. */
  report: Report | null;
  /** A report was supplied but failed contract validation. */
  invalid?: boolean;
  pending?: boolean;
  error?: string;
  /** Prefer roots from this prompt channel when a name is authored in both. */
  channel?: "system" | "user";
}

/** One authored @reference's own dependency tree. Shared graph nodes are
 * attributed per path, so a failure below one root never paints another. */
export function buildSkillReferenceMap(rawName: string, input: SkillReferenceMapInput): SkillReferenceMap {
  const name = rawName.replace(/^@/, "").toLowerCase();
  const { report } = input;
  if (input.error) return emptyMap(name, "unavailable", { error: input.error });
  if (input.invalid) return emptyMap(name, "incomplete");
  if (!report) return emptyMap(name, input.pending ? "checking" : "unknown");

  const turnBlocked = hasBlockedSkillDependencies(report);
  const turnIssues = report.issues.filter((issue) => !issue.rootName && !issue.chain.length);
  const owned = report.issues.filter((issue) => issueOwner(issue) === name);
  const roots = report.roots.filter((root) => root.name.toLowerCase() === name);
  const root = roots.find((candidate) => candidate.channel === input.channel) ?? roots[0];
  const blockedElsewhere = [...new Set(report.issues.map(issueOwner).filter((owner): owner is string => Boolean(owner) && owner !== name))]
    .map((owner) => `@${owner}`);

  // The resolver drops the whole graph when its diagnostics are too large.
  // No reference can claim anything loaded from such a report.
  const limit = report.issues.find((issue) => issue.code === "report-limit");
  if (limit) return emptyMap(name, "incomplete", { rootIssues: [limit], turnIssues, blockedElsewhere: [] });
  if (!root && owned.length) return emptyMap(name, "blocked", { rootIssues: owned, turnIssues, blockedElsewhere });
  // A skill's own source authors nested references: there the token is an
  // edge from the previewed root, and its map is the subtree under that edge.
  const nested = root ? undefined : report.edges.find((edge) => edge.reference.toLowerCase() === `@${name}`
    && report.roots.some((candidate) => candidate.nodeId === edge.from));
  const parentRoot = nested && report.roots.find((candidate) => candidate.nodeId === nested.from);
  if (!root && !(nested && parentRoot)) {
    return emptyMap(name, "unknown", { turnIssues, flagged: turnIssues.length > 0, blockedElsewhere });
  }

  const nodes = new Map(report.nodes.map((node) => [node.id, node]));
  const folder = skillsFolder(report.nodes);
  const outgoing = new Map<string, Edge[]>();
  for (const edge of report.edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  const used = new Set<Issue>();
  const expanded = new Set<string>();
  const counts = { loads: 0, held: 0, blocked: 0, skills: 0, documents: 0, characters: 0 };
  let items = 0;
  let truncated = false;

  // An issue that names its target node belongs to exactly one edge: that
  // target reached from its source node (none for a root). It never moves
  // to another parent that happens to reach the same target. Issues without
  // a target keep the older matching — this root's exact chain, then, for
  // blocked nodes only, the authored reference — but one that names its
  // source node stays under that parent.
  const findIssue = (chain: string[], { target, edge, parent, code, loose, exactOnly = false }: {
    target: string; edge?: Edge; parent?: GraphNode; code?: string; loose: boolean; exactOnly?: boolean;
  }) => {
    const candidates = report.issues.filter((issue) => !used.has(issue) && (code ? issue.code === code : issue.code !== "cycle"));
    const exact = candidates.find((issue) => issue.targetNodeId === target && issue.sourceNodeId === parent?.id);
    if (exact || exactOnly) return exact;
    const legacy = candidates.filter((issue) => issue.targetNodeId === undefined
      && (issue.sourceNodeId === undefined || issue.sourceNodeId === parent?.id));
    const byChain = legacy.find((issue) => sameChain(issue.chain, chain));
    if (byChain || !loose) return byChain;
    if (!edge) return legacy.find((issue) => issueOwner(issue) === name && issue.chain.length <= 1);
    return legacy.find((issue) => issue.reference === edge.reference && (!parent || issue.sourcePath === parent.path || issue.sourceNodeId === parent.id))
      ?? legacy.find((issue) => issue.sourceNodeId === undefined && issue.reference === edge.reference);
  };

  const visit = (id: string, chain: string[], ancestors: ReadonlySet<string>, edge?: Edge, parent?: GraphNode): SkillMapItem | null => {
    if (items >= MAX_ITEMS) { truncated = true; return null; }
    items += 1;
    const key = `${chain.length}:${items}:${id}`;
    const node = nodes.get(id);
    if (!node) {
      return { key, kind: "document", label: edge?.reference ?? id, reference: edge?.reference, status: "blocked",
        reasonLabel: "Not in report", reason: "The dependency report references an item it does not describe.", failurePath: true, children: [] };
    }
    const base = { key, kind: node.kind, label: nodeLabel(node), reference: edge?.reference, path: node.path || undefined, location: nodeLocation(node, folder) };
    if (ancestors.has(id)) {
      const issue = findIssue(chain, { target: id, edge, parent, code: "cycle", loose: true })
        ?? report.issues.find((candidate) => candidate.code === "cycle" && candidate.targetNodeId === undefined && !used.has(candidate) && issueOwner(candidate) === name);
      if (issue) used.add(issue);
      return { ...base, status: "cycle", reasonLabel: "Cycle", reason: issue?.message ?? "This reference leads back to an item above it.", failurePath: true, children: [] };
    }
    if (expanded.has(id)) {
      const repeatOf = node.status === "blocked" ? "blocked" : turnBlocked ? "held" : "loads";
      // A second authored link to a shared target can fail on its own edge
      // (the resolver reports each one); keep that reason on this row.
      const issue = findIssue(chain, { target: id, edge, parent, loose: false, exactOnly: true });
      if (!issue) return { ...base, status: "repeat", repeatOf, failurePath: false, children: [] };
      used.add(issue);
      return { ...base, status: "repeat", repeatOf: "blocked", reasonLabel: skillReasonLabel(issue.code), reason: issue.message, failurePath: true, children: [] };
    }
    expanded.add(id);
    const issue = findIssue(chain, { target: id, edge, parent, loose: node.status === "blocked" });
    if (issue) used.add(issue);
    const blocked = node.status === "blocked" || Boolean(issue);
    const status: SkillMapItemStatus = blocked ? "blocked" : turnBlocked ? "held" : "loads";
    counts[status] += 1;
    counts[node.kind === "skill" ? "skills" : "documents"] += 1;
    if (!blocked) counts.characters += node.characterCount;
    const nextAncestors = new Set(ancestors).add(id);
    const children = (outgoing.get(id) ?? [])
      .map((child) => visit(child.to, [...chain, child.reference], nextAncestors, child, node))
      .filter((child): child is SkillMapItem => Boolean(child));
    return {
      ...base, status, failurePath: blocked || children.some((child) => child.failurePath), children,
      ...(blocked ? {
        reasonLabel: issue ? skillReasonLabel(issue.code) : "Blocked",
        reason: issue?.message ?? "The resolver blocked this item without attaching a reason to this path.",
      } : {}),
    };
  };

  const tree = root
    ? visit(root.nodeId, [`@${root.name}`], new Set())
    : visit(nested!.to, [`@${parentRoot!.name}`, nested!.reference], new Set([parentRoot!.nodeId]), nested, nodes.get(parentRoot!.nodeId));
  const rootIssues = owned.filter((issue) => !used.has(issue));
  const failure: string[] = [];
  for (let item = tree; item; item = item.children.find((child) => child.failurePath) ?? null) {
    if (!item.failurePath) break;
    failure.push(item.label);
    if (isFailure(item)) break;
  }
  const firstFailure = findFirstFailure(tree ?? undefined);
  const own = Boolean(tree?.failurePath) || rootIssues.length > 0;
  const state: SkillMapState = own || turnIssues.length ? "blocked" : turnBlocked ? "held" : "ready";
  return {
    name, state, flagged: state === "blocked", root: tree ?? undefined, rootIssues, turnIssues,
    blockedElsewhere, counts, failure, firstFailure, truncated,
  };
}

/** One sentence for assistive technology and compact summaries. */
export function describeSkillReferenceMap(map: SkillReferenceMap): string {
  const label = `@${map.name}`;
  const loaded = map.counts.loads + map.counts.held;
  const items = `${loaded} item${loaded === 1 ? "" : "s"}`;
  switch (map.state) {
    case "checking": return `${label}: checking dependencies.`;
    case "unavailable": return `${label}: dependency check unavailable. ${map.error ?? ""}`.trim();
    case "unknown": return map.flagged
      ? `${label}: not in the dependency report, and the turn is blocked.`
      : `${label}: not in the latest dependency report.`;
    case "incomplete": return `${label}: dependency report incomplete; nothing is shown as loaded.`;
    case "ready": return `${label}: ready, ${items} will load.`;
    case "held": return `${label}: resolves, but the turn is blocked by ${map.blockedElsewhere.join(", ") || "another reference"}.`;
    case "blocked": {
      const where = map.failure.length ? ` at ${map.failure.join(" → ")}` : "";
      const firstIssue = map.rootIssues[0] ?? map.turnIssues[0];
      const reason = map.firstFailure?.reason ?? firstIssue?.message ?? "";
      return `${label}: blocked${where}. ${reason}`.trim();
    }
  }
}

/** The item itself fails, rather than only something below it. */
export function isFailure(item: SkillMapItem): boolean {
  return item.status === "blocked" || item.status === "cycle" || (item.status === "repeat" && item.failurePath);
}

function findFirstFailure(item?: SkillMapItem): SkillMapItem | undefined {
  if (!item?.failurePath) return undefined;
  if (isFailure(item)) return item;
  for (const child of item.children) {
    const found = findFirstFailure(child);
    if (found) return found;
  }
  return undefined;
}
