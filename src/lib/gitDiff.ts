/**
 * Parsing for unified `git diff` output shown in the Review and Git panels.
 *
 * Path recovery is the delicate part. `diff --git a/x b/x` is ambiguous when a
 * name contains a space, and Git quotes names containing control characters,
 * quotes, or non-ASCII bytes as C strings (`diff --git "a/caf\303\251" ...`).
 * A naive `a/(.+?) b/(.+)` match silently produces a wrong path, and running
 * `git add --` or `git restore --` on a wrong path is a destructive mistake.
 * So a section only advertises a path when it can be recovered unambiguously;
 * otherwise it carries `path: null` and the UI withholds its file actions.
 */

export type ReviewDiffSource = "runtime" | "repository";

export interface ReviewDiff {
  /** Unified diff text; empty when nothing has been loaded yet. */
  text: string;
  /** Which producer this text came from, so the UI can describe it. */
  source: ReviewDiffSource;
  /** What the diff is taken against, e.g. `HEAD` or the tracked remote. */
  baseline: string;
  /**
   * Paths that exist on disk but are absent from `text` because they are not
   * tracked yet. Surfaced explicitly instead of letting an empty diff imply
   * the working tree is clean.
   */
  untrackedPaths: string[];
  /** True when the untracked list was capped, so the count is a floor. */
  untrackedTruncated?: boolean;
}

export const EMPTY_REVIEW_DIFF: ReviewDiff = {
  text: "",
  source: "runtime",
  baseline: "the tracked remote branch",
  untrackedPaths: [],
};

export interface DiffSection {
  /**
   * Recovered repository-relative path, or `null` when the header could not be
   * decoded unambiguously. Only a non-null path may be passed to a Git command.
   */
  path: string | null;
  /** Always safe to render: the recovered path, else the raw header text. */
  displayPath: string;
  text: string;
  additions: number;
  deletions: number;
}

const NAMED_ESCAPES: Record<string, string> = {
  a: "\u0007",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  '"': '"',
};

/**
 * Decodes one Git-quoted path (the text between the surrounding quotes).
 * Octal escapes are UTF-8 bytes, so they are collected and decoded together.
 * Returns `null` for a malformed sequence rather than guessing.
 */
export function unquoteGitPath(quoted: string): string | null {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let index = 0; index < quoted.length; index += 1) {
    const character = quoted[index];
    if (character !== "\\") {
      if (character === '"') return null;
      bytes.push(...encoder.encode(character));
      continue;
    }
    const next = quoted[index + 1];
    if (next === undefined) return null;
    if (next >= "0" && next <= "7") {
      const octal = quoted.slice(index + 1, index + 4);
      if (!/^[0-7]{3}$/.test(octal)) return null;
      bytes.push(parseInt(octal, 8));
      index += 3;
      continue;
    }
    const mapped = NAMED_ESCAPES[next];
    if (mapped === undefined) return null;
    bytes.push(...encoder.encode(mapped));
    index += 1;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

/** Strips the `a/` or `b/` prefix Git puts in front of a diff-side path. */
function withoutSidePrefix(path: string, side: "a" | "b"): string | null {
  return path.startsWith(`${side}/`) ? path.slice(2) : null;
}

/** Decodes one whole path field, quoted or plain, from a header line. */
function decodePathField(value: string): string | null {
  if (!value) return null;
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"') || value.length < 2) return null;
  return unquoteGitPath(value.slice(1, -1));
}

/**
 * Recovers the path from a `--- a/…` / `+++ b/…` marker line, which names
 * exactly one file and is therefore never ambiguous.
 */
function pathFromMarker(line: string, side: "a" | "b"): string | null {
  // A tab introduces Git's optional trailing timestamp/context field.
  const value = line.slice(4).split("\t")[0];
  if (!value || value === "/dev/null") return null;
  const decoded = decodePathField(value);
  return decoded === null ? null : withoutSidePrefix(decoded, side);
}

/**
 * Last resort for sections without marker lines (mode-only or binary changes):
 * the `diff --git` header itself. Quoted headers decode exactly; unquoted ones
 * are only accepted when a single split makes both sides name the same file.
 */
function pathFromHeader(line: string): string | null {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const closing = /^"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/.exec(rest);
    if (!closing) return null;
    const left = unquoteGitPath(closing[1]);
    const right = unquoteGitPath(closing[2]);
    if (left === null || right === null) return null;
    const leftPath = withoutSidePrefix(left, "a");
    const rightPath = withoutSidePrefix(right, "b");
    if (leftPath === null || rightPath === null) return null;
    return leftPath === rightPath ? rightPath : null;
  }
  if (!rest.startsWith("a/")) return null;
  const candidates: string[] = [];
  for (let index = 0; ; index += 1) {
    const marker = rest.indexOf(" b/", index);
    if (marker < 0) break;
    const left = rest.slice(2, marker);
    const right = rest.slice(marker + 3);
    if (left === right) candidates.push(right);
    index = marker;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Splits unified diff text into per-file sections with recovered paths and
 * line counts. Sections whose path cannot be recovered keep their text and
 * their raw header for display.
 */
export function parseDiffSections(diff: string): DiffSection[] {
  if (!diff) return [];
  const sections: DiffSection[] = [];
  let header = "";
  let lines: string[] = [];
  let additions = 0;
  let deletions = 0;
  let fromMarker: string | null = null;
  let toMarker: string | null = null;
  let renameTo: string | null = null;

  const flush = () => {
    if (!header) return;
    // A pure rename carries no hunks, so its `rename to` line is the only
    // unambiguous statement of the path the file now has.
    const path = toMarker ?? renameTo ?? fromMarker ?? pathFromHeader(header);
    sections.push({
      path,
      displayPath: path ?? (header.slice("diff --git ".length) || header),
      text: lines.join("\n"),
      additions,
      deletions,
    });
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      header = line;
      lines = [line];
      additions = 0;
      deletions = 0;
      fromMarker = null;
      toMarker = null;
      renameTo = null;
      continue;
    }
    if (!header) continue;
    lines.push(line);
    if (line.startsWith("+++ ")) toMarker = pathFromMarker(line, "b");
    else if (line.startsWith("--- ")) fromMarker = pathFromMarker(line, "a");
    else if (line.startsWith("rename to ")) renameTo = decodePathField(line.slice("rename to ".length));
    else if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  flush();
  return sections;
}
