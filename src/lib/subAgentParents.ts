import type { ArchivedThread, Provider, Thread } from "../types";
import { ownsChildren, type OwnershipLinks } from "./nativeAgentLinks";
import { threadBelongsToWorkspace } from "./threadList";

/**
 * Display-only parent lookup for the Sub-agents inbox.
 *
 * Everything here is derived from data the app already holds: the durable
 * ownership graph, the loaded thread list, the bounded remembered index and
 * the archive records. It never writes, never fetches, and never decides which
 * inbox a thread belongs in; `isSubAgentThread` still owns that.
 */

/** Untrusted provider-only ancestry gets a separate hop budget. Durable
 * native ownership can be deeper, so it is bounded by the graph/cycle set. */
const MAX_PARENT_DEPTH = 16;

export type SubAgentParentState =
  /** Openable from the current chat or project. */
  | "available"
  /** Known, but bound to a different chat or project. */
  | "elsewhere"
  | "archived"
  /** Only the ID survives: deleted, or pruned from the remembered index. */
  | "unavailable";

export interface SubAgentParent {
  id: string;
  /** Live title, or the archived label. Null when nothing names this ID. */
  title: string | null;
  provider?: Provider;
  state: SubAgentParentState;
  /** Where an archived or out-of-workspace parent lives, for messages. */
  path?: string;
}

export interface SubAgentParentInfo {
  /** The conversation that started this child, when any ID is recorded. */
  direct: SubAgentParent | null;
  /** End of the bounded ancestor walk; the sidebar groups by this. */
  top: SubAgentParent | null;
  /** `linked`: every hop is a Mythra Code ownership record. `reported`: at
   * least one hop relies on the provider's own parent field, which can be
   * wrong. `unknown`: the thread is a sub-agent with no parent ID at all. */
  provenance: "linked" | "reported" | "unknown";
}

export interface SubAgentParentSources {
  links: OwnershipLinks;
  rootIds: ReadonlySet<string>;
  /** The loaded workspace list. Not capped, and carries renames first. */
  threads: readonly Thread[];
  /** The bounded remembered index, for parents outside the loaded list. */
  remembered: Readonly<Record<string, Thread>>;
  archived: readonly ArchivedThread[];
  workspacePath: string;
  bindings: Record<string, string>;
  threadTitle: (thread: Thread) => string;
  threadProvider: (thread: Thread) => Provider;
}

export interface SubAgentParentResolver {
  /** Parent details for a thread already classified as a sub-agent. */
  info(threadId: string, thread?: Thread): SubAgentParentInfo;
  /** What the app currently knows about one parent ID. */
  parent(id: string): SubAgentParent;
}

/** One resolver per render of the inputs; results are cached inside it. */
export function createSubAgentParentResolver(sources: SubAgentParentSources): SubAgentParentResolver {
  let loaded: Map<string, Thread> | null = null;
  let archived: Map<string, ArchivedThread> | null = null;
  const parents = new Map<string, SubAgentParent>();
  const infos = new Map<string, SubAgentParentInfo>();
  const durableRoots = new Map<string, string | null>();

  const knownThread = (id: string): Thread | undefined => {
    loaded ??= new Map(sources.threads.map((thread) => [thread.id, thread]));
    return loaded.get(id) ?? sources.remembered[id];
  };

  const parent = (id: string): SubAgentParent => {
    const cached = parents.get(id);
    if (cached) return cached;
    archived ??= new Map(sources.archived.map((record) => [record.id, record]));
    // Archive wins over a stale live row, exactly as opening a thread does.
    const record = archived.get(id);
    const thread = record ? undefined : knownThread(id);
    const resolved: SubAgentParent = record
      ? { id, title: record.label, ...(record.provider ? { provider: record.provider } : {}), state: "archived", path: record.path }
      : thread
        ? {
            id,
            title: sources.threadTitle(thread),
            provider: sources.threadProvider(thread),
            state: threadBelongsToWorkspace(thread, sources.workspacePath, sources.bindings) ? "available" : "elsewhere",
            path: sources.bindings[thread.id] || thread.cwd,
          }
        : { id, title: null, state: "unavailable" };
    parents.set(id, resolved);
    return resolved;
  };

  /** Durable records first; the provider's field only for threads that the
   * durable graph does not already prove are roots. */
  const parentIdOf = (id: string, thread?: Thread): { id: string; linked: boolean } | null => {
    const link = sources.links[id];
    if (link?.rootThreadId && link.rootThreadId !== id) return { id: link.rootThreadId, linked: true };
    const reported = (thread ?? knownThread(id))?.parentThreadId;
    if (!reported || reported === id || ownsChildren(sources.links, id, sources.rootIds)) return null;
    return { id: reported, linked: false };
  };

  /** Compress only durable ancestry. Null marks a cyclic suffix, which must
   * use the ordinary cycle-aware walk instead of a cached root shortcut. */
  const durableRootOf = (id: string): string | null => {
    const path: string[] = [];
    const seen = new Set<string>();
    let current = id;
    let root: string | null;
    for (;;) {
      const cached = durableRoots.get(current);
      if (cached !== undefined) { root = cached; break; }
      if (seen.has(current)) { root = null; break; }
      seen.add(current);
      path.push(current);
      const next = sources.links[current]?.rootThreadId;
      if (!next || next === current) { root = current; break; }
      current = next;
    }
    for (const entry of path) durableRoots.set(entry, root);
    return root;
  };

  const info = (threadId: string, thread?: Thread): SubAgentParentInfo => {
    const first = parentIdOf(threadId, thread);
    // A runtime search result or the active thread can have newer parent
    // metadata than a loaded list row with the same ID.
    const cacheKey = JSON.stringify([threadId, first?.id ?? null, first?.linked ?? false]);
    const cached = infos.get(cacheKey);
    if (cached) return cached;
    if (!first) {
      const unknown: SubAgentParentInfo = { direct: null, top: null, provenance: "unknown" };
      infos.set(cacheKey, unknown);
      return unknown;
    }
    let linked = first.linked;
    let topId = first.id;
    const durableRoot = first.linked ? durableRootOf(threadId) : null;
    // Reuse whole durable suffixes, but only when their endpoint really ends
    // the walk. Provider ancestry retains its hop bound and cycle semantics.
    if (durableRoot !== null && !parentIdOf(durableRoot)) {
      topId = durableRoot;
    } else {
      const seen = new Set([threadId, first.id]);
      let reportedHops = first.linked ? 0 : 1;
      for (;;) {
        const next = parentIdOf(topId);
        if (!next || seen.has(next.id)) break;
        if (!next.linked && ++reportedHops > MAX_PARENT_DEPTH) break;
        seen.add(next.id);
        linked &&= next.linked;
        topId = next.id;
      }
    }
    const result: SubAgentParentInfo = {
      direct: parent(first.id),
      top: parent(topId),
      provenance: linked ? "linked" : "reported",
    };
    infos.set(cacheKey, result);
    return result;
  };

  return { info, parent };
}

export const UNAVAILABLE_PARENT_TITLE = "Parent unavailable";
export const UNKNOWN_PARENT_TITLE = "Parent unknown";

export interface SubAgentGroup {
  /** The top parent's ID, or "" for sub-agents with no parent ID at all. */
  key: string;
  parent: SubAgentParent | null;
  /** In the order given, so pinned/recent order inside a group is kept. */
  threads: Thread[];
  /** Every child in the group relies on provider-reported ancestry. */
  reported: boolean;
  /** Stable ID suffix, only when another visible group shows the same title. */
  shortId?: string;
}

export function subAgentGroupTitle(parent: SubAgentParent | null): string {
  if (!parent) return UNKNOWN_PARENT_TITLE;
  return parent.title ?? UNAVAILABLE_PARENT_TITLE;
}

/** Shortest trailing slice (at least six characters) that tells the IDs
 * apart. Trailing, because time-ordered IDs share their leading characters. */
function distinguishingSuffixes(ids: string[]): Map<string, string> {
  const longest = ids.reduce((length, id) => Math.max(length, id.length), 0);
  for (let length = Math.min(6, longest); ; length += 1) {
    const suffixes = ids.map((id) => id.slice(-length));
    if (new Set(suffixes).size === ids.length || length >= longest) {
      return new Map(ids.map((id, index) => [id, suffixes[index]]));
    }
  }
}

/**
 * Group sorted sub-agent threads under their top parent. Groups never merge
 * by title: two parents with the same name stay two groups, and get a short
 * ID so they can be told apart. Groups holding a pinned child come first,
 * then the most recently active; children without any parent ID come last.
 */
export function groupSubAgentThreads(
  threads: readonly Thread[],
  resolve: (thread: Thread) => SubAgentParentInfo,
  pinnedIds: ReadonlySet<string>,
): SubAgentGroup[] {
  const groups = new Map<string, SubAgentGroup & { pinned: boolean; newest: number }>();
  for (const thread of threads) {
    const parentInfo = resolve(thread);
    const key = parentInfo.top?.id ?? "";
    let group = groups.get(key);
    if (!group) {
      // The no-parent bucket is labelled unknown, not reported.
      group = { key, parent: parentInfo.top, threads: [], reported: Boolean(key), pinned: false, newest: 0 };
      groups.set(key, group);
    }
    group.threads.push(thread);
    if (parentInfo.provenance === "linked") group.reported = false;
    if (pinnedIds.has(thread.id)) group.pinned = true;
    group.newest = Math.max(group.newest, thread.updatedAt);
  }
  const ordered = [...groups.values()].sort((left, right) => (
    Number(!left.key) - Number(!right.key)
    || Number(right.pinned) - Number(left.pinned)
    || right.newest - left.newest
    || left.key.localeCompare(right.key)
  ));
  const idsByTitle = new Map<string, string[]>();
  for (const group of ordered) {
    if (!group.key) continue;
    const title = subAgentGroupTitle(group.parent);
    const ids = idsByTitle.get(title);
    if (ids) ids.push(group.key);
    else idsByTitle.set(title, [group.key]);
  }
  const shortIds = new Map<string, string>();
  for (const ids of idsByTitle.values()) {
    if (ids.length < 2) continue;
    for (const [id, suffix] of distinguishingSuffixes(ids)) shortIds.set(id, suffix);
  }
  return ordered.map(({ pinned: _pinned, newest: _newest, ...group }) => {
    const shortId = shortIds.get(group.key);
    return shortId ? { ...group, shortId } : group;
  });
}

/** Card-level wording: who started this child, for screen readers, plus the
 * direct parent when it differs from the group the card sits under. */
export function subAgentCardParent(parentInfo: SubAgentParentInfo): { label: string; via?: string } {
  const { direct, top, provenance } = parentInfo;
  if (!direct) return { label: "Sub-agent, parent unknown" };
  const title = direct.title ?? "an unavailable parent";
  const label = provenance === "reported"
    ? `Sub-agent of ${title}, as reported by the provider`
    : `Sub-agent of ${title}`;
  return top && top.id !== direct.id ? { label, via: direct.title ?? UNAVAILABLE_PARENT_TITLE } : { label };
}
