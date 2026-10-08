/**
 * Link detection for the workspace terminal.
 *
 * Terminal output is untrusted text: any program can print anything. A link
 * is only ever produced for an http(s) URL or a bare loopback server address
 * (`localhost:5173`, `127.0.0.1:8080`, `[::1]:3000`), and every candidate is
 * re-validated in full before it can reach the browser opener. Nothing here
 * executes terminal text or opens anything by itself.
 */

/** A detected link: `[start, end)` offsets into the scanned text. */
export interface TerminalLinkMatch {
  start: number;
  end: number;
  /** End of the whole token, including stripped sentence punctuation. */
  candidateEnd: number;
  /** The text as printed. */
  text: string;
  /** What the browser is asked to open. Always http: or https:. */
  url: string;
}

/** Where a link can begin. */
const START = /https?:\/\/|localhost:|127\.0\.0\.1:|\[::1\]:/giu;
/**
 * What ends a printed URL: whitespace, control characters, the quotes and
 * angle brackets RFC 3986 (appendix C) names as delimiters, and box-drawing
 * borders. Everything else up to there is the candidate, and it is validated
 * whole: a character a link may not contain rejects the candidate rather
 * than cutting the link short in front of it, so a truncated address is never
 * opened in place of the printed one.
 */
const DELIMITER = /[\s\p{Cc}"<>`\u{2500}-\u{257f}]/u;
/**
 * Characters a link may contain: RFC 3986's ASCII set, plus Unicode letters,
 * digits and combining marks for international paths, queries and hosts. No
 * spaces, controls or invisible format characters (bidi overrides, zero-width
 * joiners), and no symbols that could pass for punctuation.
 */
const LINK_TEXT = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%\p{L}\p{N}\p{M}]+$/u;
const UNICODE_LABEL = "[\\p{L}\\p{N}\\p{M}](?:[\\p{L}\\p{N}\\p{M}-]*[\\p{L}\\p{N}\\p{M}])?";
// No userinfo: `http://localhost:3000@example.com` must not open example.com
// while reading as localhost, so `@` is never allowed in the authority.
const AUTHORITY = new RegExp(`^(\\[[0-9A-Fa-f:.]+\\]|${UNICODE_LABEL}(?:\\.${UNICODE_LABEL})*)(?::(\\d{1,5}))?$`, "u");
const SCHEME = /^(https?):\/\//i;
const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\]):/i;
/** A parsed host is plain ASCII: a DNS name (IDNs arrive as punycode) or an IP. */
const PARSED_HOST = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?|\[[0-9a-f:.]+\])$/;
/** Characters that end a sentence rather than a URL, Latin and CJK. */
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "*", "'", ")", "]", "。", "、", "，", "．", "！", "？", "：", "；", "）", "」", "』", "】", "》", "〉"]);
const PAIRS: Record<string, string> = { ")": "(", "]": "[", "）": "（", "」": "「", "』": "『", "】": "【", "》": "《", "〉": "〈" };
/**
 * A word that runs straight into the start means it is not a link start, in
 * any script: `mylocalhost:1`, `élocalhost:1` and `xhttps://` are not links.
 */
const EXPLICIT_PREFIX = /[\p{L}\p{N}\p{M}+.-]$/u;
const BARE_PREFIX = /[\p{L}\p{N}\p{M}_.\-@/:[\]]$/u;

function validPort(port: string | undefined): boolean {
  if (port === undefined) return true;
  const value = Number(port);
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** Drops sentence punctuation after a URL, keeping balanced `(...)`/`[...]`. */
function trimTrailing(token: string): string {
  // Count once, then decrement as punctuation is removed. Recounting the
  // entire prefix for each closing bracket made hover-time work quadratic
  // on noisy output (thousands of trailing brackets can stall a UI frame).
  const counts = new Map<string, number>();
  for (const character of token) counts.set(character, (counts.get(character) ?? 0) + 1);
  let end = token.length;
  while (end > 0) {
    const last = token[end - 1];
    if (!TRAILING.has(last)) break;
    const opener = PAIRS[last];
    if (opener) {
      if ((counts.get(opener) ?? 0) >= (counts.get(last) ?? 0)) break;
    }
    counts.set(last, (counts.get(last) ?? 0) - 1);
    end -= 1;
  }
  return token.slice(0, end);
}

/**
 * The URL to open for `text`, or null when it is not an allowed link. Bare
 * loopback addresses become `http://`; an explicit `https://` is kept.
 */
export function normalizeTerminalLink(text: string): string | null {
  if (!LINK_TEXT.test(text)) return null;
  const scheme = SCHEME.exec(text);
  if (!scheme && !LOOPBACK.test(text)) return null;
  const rest = scheme ? text.slice(scheme[0].length) : text;
  const pathStart = rest.search(/[/?#]/);
  const authority = pathStart < 0 ? rest : rest.slice(0, pathStart);
  const parts = AUTHORITY.exec(authority);
  if (!parts || !validPort(parts[2])) return null;
  // A bare address is only a link with its port: `localhost` alone is a word.
  if (!scheme && parts[2] === undefined) return null;
  let url: URL;
  try {
    url = new URL(scheme ? text : `http://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || !PARSED_HOST.test(url.hostname)) return null;
  // The parser percent-encodes international paths and converts hosts to
  // punycode, so the href names exactly what the browser will load.
  return url.href;
}

/** The code point (not UTF-16 unit) that ends just before `index`. */
function characterBefore(text: string, index: number): string {
  return Array.from(text.slice(Math.max(0, index - 2), index)).pop() ?? "";
}

/** Every allowed link in `text`, in order and without overlaps. */
export function findTerminalLinks(text: string): TerminalLinkMatch[] {
  const links: TerminalLinkMatch[] = [];
  START.lastIndex = 0;
  for (let match = START.exec(text); match; match = START.exec(text)) {
    const start = match.index;
    let end = start + match[0].length;
    while (end < text.length && !DELIMITER.test(text[end])) end += 1;
    // Resume after the whole candidate, valid or not, so a rejected one can
    // never yield a shorter link from inside itself.
    START.lastIndex = end;
    const before = characterBefore(text, start);
    const explicit = /^https?:/i.test(match[0]);
    if (before && (explicit ? EXPLICIT_PREFIX : BARE_PREFIX).test(before)) continue;
    const token = trimTrailing(text.slice(start, end));
    const url = normalizeTerminalLink(token);
    if (!url) continue;
    links.push({ start, end: start + token.length, candidateEnd: end, text: token, url });
  }
  return links;
}

/** Minimal view of xterm's buffer, so the mapping is testable without a DOM. */
export interface TerminalBufferCell {
  getChars(): string;
  getWidth(): number;
}
export interface TerminalBufferLine {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(x: number): TerminalBufferCell | undefined;
}
export interface TerminalBufferReader {
  getLine(y: number): TerminalBufferLine | undefined;
}

/** 1-based, inclusive cell coordinates, as xterm's `IBufferRange` uses. */
export interface TerminalCellRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface TerminalBufferLink {
  range: TerminalCellRange;
  text: string;
  url: string;
}

/**
 * Bounds the rows joined around the hovered one. A soft-wrapped line can be
 * thousands of rows long (minified output). Overlong targets are deliberately
 * not linked when this bounded scan cannot establish the complete address.
 */
const MAX_WRAPPED_ROWS = 24;

/**
 * Links that touch buffer row `row` (0-based). Soft-wrapped rows are joined
 * first, so a URL the terminal wrapped across rows is still one link, and the
 * text is read from rendered cells, so ANSI styling never shows up in it.
 */
export function linksAtBufferRow(buffer: TerminalBufferReader, row: number): TerminalBufferLink[] {
  if (!buffer.getLine(row)) return [];
  let first = row;
  while (first > 0 && row - first < MAX_WRAPPED_ROWS && buffer.getLine(first)?.isWrapped) first -= 1;
  let last = row;
  while (last - row < MAX_WRAPPED_ROWS && buffer.getLine(last + 1)?.isWrapped) last += 1;
  const missingPrefix = Boolean(buffer.getLine(first)?.isWrapped);
  const missingSuffix = Boolean(buffer.getLine(last + 1)?.isWrapped);

  let text = "";
  // Cell position of each UTF-16 unit in `text`.
  const cells: Array<{ x: number; y: number; width: number }> = [];
  for (let y = first; y <= last; y += 1) {
    const line = buffer.getLine(y);
    if (!line) break;
    let used = 0;
    for (let x = 0; x < line.length; x += 1) {
      if (line.getCell(x)?.getChars()) used = x + 1;
    }
    // Never-written cells at the end of a row that wraps (a wide character
    // that did not fit) are not a gap in the text; elsewhere they are spaces.
    for (let x = 0; x < used; x += 1) {
      const cell = line.getCell(x);
      if (!cell) continue;
      const width = cell.getWidth();
      if (width === 0) continue;
      const chars = cell.getChars() || " ";
      for (let index = 0; index < chars.length; index += 1) cells.push({ x, y, width });
      text += chars;
    }
  }

  const links: TerminalBufferLink[] = [];
  for (const match of findTerminalLinks(text)) {
    // The retained/bounded window can begin or end mid-token. A candidate at
    // either incomplete edge might be a suffix of another address or lack
    // the rest of its path/query. Never open a different, truncated URL.
    if ((missingPrefix && match.start === 0) || (missingSuffix && match.candidateEnd === text.length)) continue;
    const head = cells[match.start];
    const tail = cells[match.end - 1];
    if (!head || !tail || tail.y < row || head.y > row) continue;
    links.push({
      range: { start: { x: head.x + 1, y: head.y + 1 }, end: { x: tail.x + tail.width, y: tail.y + 1 } },
      text: match.text,
      url: match.url,
    });
  }
  return links;
}
