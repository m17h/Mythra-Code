import { highlightDiffLines, languageForPath, type SyntaxLanguage, type SyntaxToken } from "./syntaxHighlight";

/**
 * What one line of a unified diff is, and which old/new line numbers it
 * carries. The gutter shows these numbers; nothing is relocated or guessed —
 * a line outside a hunk simply has none.
 */
export interface DiffRowInfo {
  kind: "add" | "del" | "context" | "hunk" | "header" | "note";
  oldLine?: number;
  newLine?: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Numbers every line of a unified diff (one file or several). */
export function numberDiffLines(lines: string[]): DiffRowInfo[] {
  let inHunk = false;
  let oldNext = 0;
  let newNext = 0;
  return lines.map((line): DiffRowInfo => {
    if (line.startsWith("diff --git ")) { inHunk = false; return { kind: "header" }; }
    if (line.startsWith("@@")) {
      const match = HUNK.exec(line);
      // A synthetic header ("@@ new file · 3 lines @@") starts a new file at line 1.
      oldNext = match ? Number(match[1]) : 0;
      newNext = match ? Number(match[2]) : 1;
      inHunk = true;
      return { kind: "hunk" };
    }
    if (!inHunk) return { kind: "header" };
    if (line.startsWith("\\")) return { kind: "note" };
    if (line.startsWith("+")) return { kind: "add", newLine: newNext++ };
    if (line.startsWith("-")) return { kind: "del", oldLine: oldNext++ };
    return { kind: "context", oldLine: oldNext++, newLine: newNext++ };
  });
}

/** Widest line number in the gutter, so both columns keep one width. */
export function gutterDigits(rows: DiffRowInfo[]): number {
  let widest = 1;
  for (const row of rows) widest = Math.max(widest, row.oldLine ?? 0, row.newLine ?? 0);
  return Math.max(2, String(widest).length);
}

/** The file a `diff --git` / `+++` header names, if any. */
function headerPath(line: string): string | null {
  const plus = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
  if (plus && plus[1] !== "/dev/null") return plus[1];
  const git = /^diff --git a\/.+ b\/(.+)$/.exec(line);
  return git ? git[1] : null;
}

/**
 * Syntax tokens for the code of each diff line, `null` for lines that are not
 * code. A diff holding several files switches language at each file header;
 * `path` names the file when the text has no header of its own.
 */
export function highlightDiff(lines: string[], path?: string | null): Array<SyntaxToken[] | null> {
  const result: Array<SyntaxToken[] | null> = new Array(lines.length).fill(null);
  let start = 0;
  let language: SyntaxLanguage | null = languageForPath(path);
  const flush = (end: number) => {
    if (end <= start) return;
    const segment = highlightDiffLines(lines.slice(start, end), language);
    for (let index = 0; index < segment.length; index += 1) result[start + index] = segment[index];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("diff --git ")) {
      flush(index);
      start = index;
      language = languageForPath(headerPath(line)) ?? languageForPath(path);
    } else if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) {
      language = languageForPath(headerPath(line)) ?? language;
    }
  }
  flush(lines.length);
  return result;
}
