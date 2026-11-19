import type { DiffSection, ReviewDiff } from "./gitDiff";

/**
 * What Tools → Changes compares against.
 *
 * `working` is the default and the only scope the commit acts on: every
 * uncommitted change, staged or not, including new files — the same set as the
 * Files list. `pushed` is the alternate comparison with the tracked remote
 * branch, which also holds commits that are saved but not pushed yet. It only
 * exists where the runtime can produce that diff.
 */
export type ChangesScope = "working" | "pushed";

const CHANGES_SCOPE_KEY = "kiwi.changesScope";

export const CHANGES_SCOPE_LABELS: Record<ChangesScope, { label: string; detail: string }> = {
  working: { label: "Uncommitted", detail: "Net changes against the last commit, staged or not, new files included. The same files as Files." },
  pushed: { label: "Since last push", detail: "Read only: compares with the tracked remote branch, so it also shows commits not pushed yet." },
};

/** The staged view inside Uncommitted: a view of the index, not a saved scope. */
export const STAGED_VIEW_LABEL = { label: "Staged", menuLabel: "Staged only", detail: "Exactly what Commit records when files are staged: the index against the last commit." };

export function readChangesScope(): ChangesScope {
  try { return window.localStorage.getItem(CHANGES_SCOPE_KEY) === "pushed" ? "pushed" : "working"; } catch { return "working"; }
}

export function writeChangesScope(scope: ChangesScope): void {
  try { window.localStorage.setItem(CHANGES_SCOPE_KEY, scope); } catch { /* private mode: keep it for this session */ }
}

/** The repository-relative form of a provider path, leaving unrelated absolute paths intact. */
export function projectRelativePath(path: string, roots: Array<string | null | undefined>): string {
  const normalize = (value: string) => value.replace(/\\/g, "/")
    .replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\/(?=[a-z]:\/)/i, "");
  const normalized = normalize(path);
  for (const root of roots) {
    if (!root) continue;
    const base = normalize(root).replace(/\/+$/, "");
    const windows = /^[a-z]:\/|^\/\//i.test(`${base}/`);
    const comparablePath = windows ? normalized.toLowerCase() : normalized;
    const comparableBase = windows ? base.toLowerCase() : base;
    if (comparablePath.startsWith(`${comparableBase}/`)) return normalized.slice(base.length + 1);
  }
  return normalized.replace(/^\.\//, "");
}


/** The uncommitted diff before its first read: against HEAD, nothing loaded yet. */
export const EMPTY_WORKING_REVIEW_DIFF: ReviewDiff = {
  text: "",
  source: "repository",
  baseline: "HEAD",
  untrackedPaths: [],
};

/** The native reader's own marker when it capped the diff text (git_inspection.rs). */
const TRUNCATION_NOTE = /\n*\[Diff preview truncated at [^\]\n]*\]\s*$/;

export interface DiffReadState {
  /** `error`: the read failed and nothing is known. `partial`: some of the diff is missing. */
  kind: "ok" | "partial" | "error";
  /** The diff text to parse: empty on error, without the reader's truncation marker. */
  text: string;
  error?: string;
}

/**
 * What a Changes diff read can honestly claim. A failed read is never "No
 * differences", and a capped one is never presented as the whole change.
 */
export function diffReadState(diff: Pick<ReviewDiff, "text" | "truncated" | "error">): DiffReadState {
  if (diff.error) return { kind: "error", text: "", error: diff.error };
  const marked = TRUNCATION_NOTE.test(diff.text);
  const text = marked ? diff.text.replace(TRUNCATION_NOTE, "\n") : diff.text;
  return { kind: diff.truncated || marked ? "partial" : "ok", text };
}

/* ---------------------------------------------------------------------------
 * Staged view (Sol R5 B01). The Uncommitted diff is the working tree against
 * the last commit: every change, staged or not. Commit, once anything is
 * staged, records only the index. Those two patches differ whenever a file is
 * partly staged, and a staged edit that was undone on disk makes the combined
 * diff empty while Commit still records it. The staged view is built from the
 * same per-file `git diff --cached` reads Files uses, so it is exactly what
 * "Commit N staged" records.
 * ------------------------------------------------------------------------- */

/** One file's staged (index vs last commit) diff, as the native per-area read returns it. */
export interface StagedDiffPart {
  path: string;
  text: string;
  binary: boolean;
  truncated: boolean;
}

/** More staged files than this are read on request from Files, one at a time. */
export const STAGED_DIFF_FILE_LIMIT = 60;

/** The per-file reader's own marker when it capped a file (git_inspection.rs). */
const FILE_TRUNCATION_NOTE = /\n*\[File preview truncated at [^\]\n]*\]\s*$/;

export interface StagedDiffResult {
  sections: DiffSection[];
  /** Some files or lines are missing: more files than the limit, a capped file, or a failed read. */
  partial: boolean;
  /** Paths whose read failed (they are named, never silently dropped). */
  failed: string[];
}

/**
 * Turns per-file staged reads into diff sections. The path always comes from
 * the Files row that asked for it, never from a header, so per-file actions
 * act on the right file even when Git quotes the name.
 */
export function stagedDiffSections(
  parts: Array<StagedDiffPart | { path: string; error: string }>,
  requested: number,
  parse: (text: string) => DiffSection[],
): StagedDiffResult {
  const sections: DiffSection[] = [];
  const failed: string[] = [];
  let partial = requested > parts.length;
  for (const part of parts) {
    if ("error" in part) { failed.push(part.path); partial = true; continue; }
    if (part.truncated || FILE_TRUNCATION_NOTE.test(part.text)) partial = true;
    const text = part.text.replace(FILE_TRUNCATION_NOTE, "\n");
    if (part.binary) {
      sections.push({ path: part.path, displayPath: part.path, text: `@@ binary file @@\n Binary file: no text preview. Commit records the staged version.`, additions: 0, deletions: 0 });
      continue;
    }
    const parsed = parse(text);
    if (!parsed.length) continue;
    // One file's read is one section; a rename can print two headers.
    const merged = parsed.reduce((total, section) => ({
      text: total.text ? `${total.text}\n${section.text}` : section.text,
      additions: total.additions + section.additions,
      deletions: total.deletions + section.deletions,
    }), { text: "", additions: 0, deletions: 0 });
    sections.push({ path: part.path, displayPath: part.path, ...merged });
  }
  return { sections, partial, failed };
}

export interface DiffEmptyCopy {
  title: string;
  text: string;
  /** The one next step: open the staged view, or the Files list. */
  action?: "staged" | "files";
}

const files = (count: number) => `${count} file${count === 1 ? "" : "s"}`;

/**
 * What an empty, successfully read diff may honestly say. "No differences" is
 * only true when Files lists nothing either: an index that is not empty, or a
 * file whose only change is its mode, is still something to commit.
 */
export function diffEmptyCopy(input: { scope: ChangesScope; stagedView: boolean; staged: number; changed: number; commitAll?: boolean }): DiffEmptyCopy {
  if (input.scope === "pushed") return { title: "No differences", text: "Nothing differs from the tracked remote branch." };
  if (input.stagedView) return { title: "Nothing staged", text: "Stage files under Files, or commit all changes at once." };
  if (input.staged > 0) {
    return {
      title: "No net change",
      // Sol R6 B01: what Commit would record depends on its target.
      text: input.commitAll
        ? `${files(input.staged)} staged, but the files on disk undo those edits, so nothing differs from the last commit. Committing all changes records the files on disk; choose Staged to record the staged version.`
        : `${files(input.staged)} staged, but the files on disk undo those edits, so nothing differs from the last commit. Commit records the staged version.`,
      action: "staged",
    };
  }
  if (input.changed > 0) {
    return {
      title: "No line changes",
      text: `Files lists ${files(input.changed)}, but no line differs from the last commit (only a file mode changed, for example).`,
      action: "files",
    };
  }
  return { title: "No differences", text: "Nothing differs from the last commit." };
}

/** What Commit records, said beside a partial diff: derived from the commit target, never assumed. */
export function partialCommitNote(target: { stagedOnly: boolean; staged: number }): string {
  return target.stagedOnly
    ? `Commit records only the ${files(target.staged)} staged.`
    : "Commit still includes every uncommitted file.";
}
