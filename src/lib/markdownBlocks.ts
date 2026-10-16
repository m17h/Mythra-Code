/**
 * Split Markdown into top-level blocks that parse to exactly the same tree
 * independently as they do together, so a streaming reply can keep its
 * finished blocks memoized and re-parse only the block still arriving.
 *
 * The split is deliberately conservative. A boundary is a blank-line run,
 * outside any fenced code block, followed by a line that starts at column 0
 * and cannot continue the previous block (not indented, not a list marker).
 * Constructs whose meaning crosses blocks disable splitting entirely: link
 * reference definitions, footnotes, and raw HTML blocks (some of which may
 * contain blank lines). Short text is never split; one parse is cheap.
 */
const MIN_SPLIT_LENGTH = 1_500;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LIST_MARKER = /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:/;
const HTML_BLOCK = /^ {0,3}</;

export function splitMarkdownBlocks(text: string): string[] {
  if (text.length < MIN_SPLIT_LENGTH) return [text];
  const lines = text.split("\n");
  const blocks: string[] = [];
  let start = 0;
  let fence: { marker: string; length: number } | null = null;
  let afterBlank = false;
  let lastContent = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1]![0] === fence.marker && close[1]!.length >= fence.length) fence = null;
      lastContent = index;
      continue;
    }
    if (!line.trim()) {
      afterBlank = true;
      continue;
    }
    if (REFERENCE_DEFINITION.test(line) || HTML_BLOCK.test(line) || line.includes("[^")) return [text];
    if (afterBlank && index > start && /^\S/.test(line) && !LIST_MARKER.test(line)) {
      // Trailing blank lines stay out of the finished block: at the end of
      // a document they could change how its last list is parsed.
      blocks.push(lines.slice(start, lastContent + 1).join("\n"));
      start = index;
    }
    afterBlank = false;
    lastContent = index;
    const open = FENCE_OPEN.exec(line);
    // A backtick fence's info string cannot contain a backtick; such a line
    // is inline code, not a fence.
    if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) fence = { marker: open[1]![0]!, length: open[1]!.length };
  }
  blocks.push(lines.slice(start).join("\n"));
  return blocks;
}
