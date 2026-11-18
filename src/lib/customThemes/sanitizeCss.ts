// customCss sanitizer (DESIGN §4.3): parse, allowlist, re-serialize. Never
// filters raw text. A CSS Syntax Level 3 tokenizer decodes escapes first, so
// `u\72 l(` is seen as `url(` before any check runs, and the output is
// rebuilt from tokens, so nothing the parser did not understand can pass.
// Works the same in the browser and in node (tests).
//
// Two entry points:
//   cleanCustomCss(css)            canonical, unscoped CSS stored in the spec
//   sanitizeCustomCss(css, { id }) scoped to the theme, keyframes renamed,
//                                  animations split behind the motion gates

import { parseColor, oklchLightness } from "./color";
import { knownTokenVars } from "./spec";

// ---- Tokenizer ---------------------------------------------------------------------

type Tok =
  | { t: "ws" }
  | { t: "ident"; v: string }
  | { t: "function"; v: string }
  | { t: "at"; v: string }
  | { t: "hash"; v: string; id: boolean }
  | { t: "string"; v: string }
  | { t: "url"; v: string }
  | { t: "bad" }
  | { t: "delim"; v: string }
  | { t: "number"; v: number; repr: string }
  | { t: "percentage"; v: number; repr: string }
  | { t: "dimension"; v: number; repr: string; unit: string }
  | { t: "cdo" } | { t: "cdc" }
  | { t: ":" } | { t: ";" } | { t: "," } | { t: "[" } | { t: "]" } | { t: "(" } | { t: ")" } | { t: "{" } | { t: "}" };

const REPLACEMENT = String.fromCharCode(0xfffd);
const isDigit = (c: string) => c >= "0" && c <= "9";
const isHex = (c: string) => isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
const isNameStart = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || (c !== "" && c.charCodeAt(0) >= 0x80);
const isName = (c: string) => isNameStart(c) || isDigit(c) || c === "-";
const isWs = (c: string) => c === " " || c === "\t" || c === "\n";

export function tokenize(source: string): Tok[] {
  const s = source.replace(/\r\n?|\f/g, "\n").split(String.fromCharCode(0)).join(REPLACEMENT);
  const out: Tok[] = [];
  let i = 0;
  const at = (k = 0) => s[i + k] ?? "";
  const validEscape = (k = 0) => at(k) === "\\" && at(k + 1) !== "\n" && at(k + 1) !== "";
  const startsIdent = (k = 0) => {
    const c = at(k);
    if (c === "-") return isNameStart(at(k + 1)) || at(k + 1) === "-" || validEscape(k + 1);
    if (isNameStart(c)) return true;
    return validEscape(k);
  };
  const startsNumber = (k = 0) => {
    const c = at(k);
    if (c === "+" || c === "-") return isDigit(at(k + 1)) || (at(k + 1) === "." && isDigit(at(k + 2)));
    if (c === ".") return isDigit(at(k + 1));
    return isDigit(c);
  };
  const escape = (): string => {
    i++; // backslash
    const c = at();
    if (c === "") return REPLACEMENT;
    if (isHex(c)) {
      let hex = "";
      while (hex.length < 6 && isHex(at())) { hex += at(); i++; }
      if (isWs(at())) i++;
      const code = parseInt(hex, 16);
      if (code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) return REPLACEMENT;
      return String.fromCodePoint(code);
    }
    i++;
    return c;
  };
  const name = (): string => {
    let v = "";
    for (;;) {
      if (isName(at())) { v += at(); i++; }
      else if (validEscape()) v += escape();
      else return v;
    }
  };
  const number = (): { v: number; repr: string } => {
    let repr = "";
    if (at() === "+" || at() === "-") { repr += at(); i++; }
    while (isDigit(at())) { repr += at(); i++; }
    if (at() === "." && isDigit(at(1))) { repr += at(); i++; while (isDigit(at())) { repr += at(); i++; } }
    if ((at() === "e" || at() === "E") && (isDigit(at(1)) || ((at(1) === "+" || at(1) === "-") && isDigit(at(2))))) {
      repr += at(); i++;
      if (at() === "+" || at() === "-") { repr += at(); i++; }
      while (isDigit(at())) { repr += at(); i++; }
    }
    return { v: Number(repr), repr };
  };
  const consumeString = (quote: string): Tok => {
    i++;
    let v = "";
    for (;;) {
      const c = at();
      if (c === "" || c === quote) { i++; return { t: "string", v }; }
      if (c === "\n") return { t: "bad" };
      if (c === "\\") {
        if (at(1) === "") { i++; continue; }
        if (at(1) === "\n") { i += 2; continue; }
        v += escape();
        continue;
      }
      v += c; i++;
    }
  };
  const consumeUrl = (): Tok => {
    while (isWs(at())) i++;
    let v = "";
    for (;;) {
      const c = at();
      if (c === ")" || c === "") { i++; return { t: "url", v }; }
      if (isWs(c)) { while (isWs(at())) i++; if (at() === ")" || at() === "") { i++; return { t: "url", v }; } break; }
      if (c === '"' || c === "'" || c === "(") break;
      if (c === "\\") { if (validEscape()) { v += escape(); continue; } break; }
      v += c; i++;
    }
    // bad url: consume the remnants
    while (at() !== "" && at() !== ")") { if (validEscape()) escape(); else i++; }
    i++;
    return { t: "bad" };
  };
  while (i < s.length) {
    const c = at();
    if (c === "/" && at(1) === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? s.length : end + 2;
      continue;
    }
    if (isWs(c)) { while (isWs(at())) i++; out.push({ t: "ws" }); continue; }
    if (c === '"' || c === "'") { out.push(consumeString(c)); continue; }
    if (c === "#") {
      if (isName(at(1)) || validEscape(1)) {
        i++;
        const id = startsIdent();
        out.push({ t: "hash", v: name(), id });
      } else { out.push({ t: "delim", v: c }); i++; }
      continue;
    }
    if (c === "(" || c === ")" || c === "[" || c === "]" || c === "{" || c === "}" || c === "," || c === ":" || c === ";") {
      out.push({ t: c } as Tok); i++; continue;
    }
    if (startsNumber()) {
      const n = number();
      if (startsIdent()) out.push({ t: "dimension", v: n.v, repr: n.repr, unit: name() });
      else if (at() === "%") { i++; out.push({ t: "percentage", v: n.v, repr: n.repr }); }
      else out.push({ t: "number", v: n.v, repr: n.repr });
      continue;
    }
    if (c === "<" && s.startsWith("<!--", i)) { i += 4; out.push({ t: "cdo" }); continue; }
    if (c === "-" && s.startsWith("-->", i)) { i += 3; out.push({ t: "cdc" }); continue; }
    if (startsIdent()) {
      const v = name();
      if (v.toLowerCase() === "url" && at() === "(") {
        i++;
        let k = 0;
        while (isWs(at(k))) k++;
        if (at(k) === '"' || at(k) === "'") out.push({ t: "function", v });
        else out.push(consumeUrl());
      } else if (at() === "(") { i++; out.push({ t: "function", v }); }
      else out.push({ t: "ident", v });
      continue;
    }
    if (c === "@") {
      i++;
      if (startsIdent()) out.push({ t: "at", v: name() });
      else out.push({ t: "delim", v: "@" });
      continue;
    }
    if (c === "\\") { out.push({ t: "delim", v: "\\" }); i++; continue; }
    out.push({ t: "delim", v: c });
    i++;
  }
  return out;
}

// ---- Serializer ---------------------------------------------------------------------

function escapeIdent(value: string): string {
  let out = "";
  for (let k = 0; k < value.length; k++) {
    const ch = value[k];
    const code = ch.charCodeAt(0);
    const leadingDigit = isDigit(ch) && (k === 0 || (k === 1 && value[0] === "-"));
    const lone = k === 0 && ch === "-" && value.length === 1;
    if (!leadingDigit && !lone && (isName(ch) && code !== 0x2028 && code !== 0x2029 && code >= 0x20)) out += ch;
    else out += "\\" + code.toString(16) + " ";
  }
  return out;
}

function serializeString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === '"' || ch === "\\") out += "\\" + ch;
    else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) out += "\\" + code.toString(16) + " ";
    else out += ch;
  }
  return out + '"';
}

function tokText(tok: Tok): string {
  switch (tok.t) {
    case "ws": return " ";
    case "ident": return escapeIdent(tok.v);
    case "function": return escapeIdent(tok.v) + "(";
    case "at": return "@" + escapeIdent(tok.v);
    case "hash": return "#" + (/^[a-zA-Z0-9_-]+$/.test(tok.v) ? tok.v : escapeIdent(tok.v));
    case "string": return serializeString(tok.v);
    case "number": return tok.repr;
    case "percentage": return tok.repr + "%";
    case "dimension": return tok.repr + (/^e[+-]?\d/i.test(tok.unit) ? "\\65 " + escapeIdent(tok.unit.slice(1)) : escapeIdent(tok.unit));
    case "delim": return tok.v;
    case "url": case "bad": case "cdo": case "cdc": return "";
    default: return tok.t;
  }
}

const WORDY = new Set(["ident", "function", "number", "percentage", "dimension", "hash", "at"]);

/** Serialize tokens; whitespace runs collapse to one space; adjacent words get a space so they cannot merge. */
export function serializeTokens(tokens: Tok[]): string {
  let out = "";
  let prev: Tok | null = null;
  for (const tok of tokens) {
    if (tok.t === "url" || tok.t === "bad" || tok.t === "cdo" || tok.t === "cdc") continue;
    if (tok.t === "ws") { if (out && !out.endsWith(" ")) out += " "; prev = tok; continue; }
    if (prev && prev.t !== "ws") {
      const glue = (WORDY.has(prev.t) && prev.t !== "function" && WORDY.has(tok.t)) ||
        (prev.t === "ident" && tok.t === "(") ||
        (WORDY.has(prev.t) && prev.t !== "function" && tok.t === "delim" && (tok.v === "-" || tok.v === "+")) ||
        ((prev.t === "number" || prev.t === "dimension") && tok.t === "delim" && tok.v === "%") ||
        (prev.t === "delim" && (prev.v === "-" || prev.v === "+" || prev.v === "@" || prev.v === "#" || prev.v === "\\") && (WORDY.has(tok.t) || tok.t === "delim")) ||
        (prev.t === "delim" && prev.v === "/" && tok.t === "delim" && tok.v === "*") ||
        (prev.t === "delim" && prev.v === "<" && tok.t === "delim" && tok.v === "!");
      if (glue) out += " ";
    }
    out += tokText(tok);
    prev = tok;
  }
  return out.trim();
}

// ---- Parser -----------------------------------------------------------------------------

interface RawRule { kind: "at"; name: string; prelude: Tok[]; block: Tok[] | null }
interface RawQualified { kind: "qualified"; prelude: Tok[]; block: Tok[] }
type RawItem = RawRule | RawQualified;

const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}", function: ")" };

/** Read a balanced block starting after `{` at index i; returns contents and the index after `}`. */
function readBlock(tokens: Tok[], start: number): { body: Tok[]; end: number } {
  const stack: string[] = ["}"];
  const body: Tok[] = [];
  let i = start;
  for (; i < tokens.length; i++) {
    const tok = tokens[i];
    const close = tok.t === "function" ? ")" : OPEN[tok.t];
    if (close) stack.push(close);
    else if (tok.t === ")" || tok.t === "]" || tok.t === "}") {
      if (stack[stack.length - 1] === tok.t) {
        stack.pop();
        if (stack.length === 0) return { body, end: i + 1 };
      }
    }
    body.push(tok);
  }
  return { body, end: i };
}

function parseRules(tokens: Tok[]): RawItem[] {
  const out: RawItem[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.t === "ws" || tok.t === "cdo" || tok.t === "cdc" || tok.t === ";") { i++; continue; }
    if (tok.t === "at") {
      const prelude: Tok[] = [];
      i++;
      let depth = 0;
      let block: Tok[] | null = null;
      for (; i < tokens.length; i++) {
        const cur = tokens[i];
        if (depth === 0 && cur.t === ";") { i++; break; }
        if (depth === 0 && cur.t === "{") { const read = readBlock(tokens, i + 1); block = read.body; i = read.end; break; }
        if (cur.t === "(" || cur.t === "[" || cur.t === "function") depth++;
        else if ((cur.t === ")" || cur.t === "]") && depth > 0) depth--;
        prelude.push(cur);
      }
      out.push({ kind: "at", name: tok.v.toLowerCase(), prelude, block });
      continue;
    }
    const prelude: Tok[] = [];
    let depth = 0;
    let done = false;
    for (; i < tokens.length; i++) {
      const cur = tokens[i];
      if (depth === 0 && cur.t === "{") {
        const read = readBlock(tokens, i + 1);
        out.push({ kind: "qualified", prelude, block: read.body });
        i = read.end;
        done = true;
        break;
      }
      if (cur.t === "(" || cur.t === "[" || cur.t === "function") depth++;
      else if ((cur.t === ")" || cur.t === "]") && depth > 0) depth--;
      prelude.push(cur);
    }
    if (!done) break; // trailing junk without a block is dropped, like the browser does
  }
  return out;
}

interface RawDecl { name: string; value: Tok[]; important: boolean }

function trimWs(tokens: Tok[]): Tok[] {
  let a = 0, b = tokens.length;
  while (a < b && tokens[a].t === "ws") a++;
  while (b > a && tokens[b - 1].t === "ws") b--;
  return tokens.slice(a, b);
}

/** Declarations of a style block; nested rules are returned separately (and dropped by the caller). */
function parseDeclarations(block: Tok[]): { decls: RawDecl[]; nested: number; bad: number } {
  const decls: RawDecl[] = [];
  let nested = 0, bad = 0;
  let i = 0;
  while (i < block.length) {
    const tok = block[i];
    if (tok.t === "ws" || tok.t === ";") { i++; continue; }
    // read one item up to a top-level ';' (or a nested block)
    const item: Tok[] = [];
    let depth = 0;
    let sawBlock = false;
    for (; i < block.length; i++) {
      const cur = block[i];
      if (depth === 0 && cur.t === ";") { i++; break; }
      if (depth === 0 && cur.t === "{") { const read = readBlock(block, i + 1); i = read.end; sawBlock = true; break; }
      if (cur.t === "(" || cur.t === "[" || cur.t === "function") depth++;
      else if ((cur.t === ")" || cur.t === "]") && depth > 0) depth--;
      item.push(cur);
    }
    if (sawBlock) { nested++; continue; }
    const trimmed = trimWs(item);
    if (trimmed.length === 0) continue;
    const first = trimmed[0];
    let k = 1;
    while (k < trimmed.length && trimmed[k].t === "ws") k++;
    if (first.t !== "ident" || trimmed[k]?.t !== ":") { bad++; continue; }
    let value = trimWs(trimmed.slice(k + 1));
    let important = false;
    const n = value.length;
    const last = value[n - 1];
    if (last?.t === "ident" && last.v.toLowerCase() === "important") {
      let j = n - 2;
      while (j >= 0 && value[j].t === "ws") j--;
      if (j >= 0 && value[j].t === "delim" && (value[j] as { v: string }).v === "!") { important = true; value = trimWs(value.slice(0, j)); }
    }
    decls.push({ name: first.v.startsWith("--") ? first.v : first.v.toLowerCase(), value, important });
  }
  return { decls, nested, bad };
}

// ---- Policy tables --------------------------------------------------------------------------

/** Surfaces customCss may only recolour (cosmetic subset, no opacity/transform/filter/pseudo content). */
export const PROTECTED_CLASSES: readonly string[] = [
  "composer", "composer-input-wrap", "composer-toolbar", "composer-actions", "composer-controls", "composer-zone",
  "send-button", "stop-button",
  "confirm-dialog", "command-palette", "command-palette-trigger", "app-toast",
  "ct-safe-notice", "topbar-right", "topbar-usage-chip", "topbar-usage-slot", "settings-close",
];
/** Any class starting with one of these is protected too (settings sheet and rail, approvals, palette, dialogs, the Custom themes section). */
export const PROTECTED_PREFIXES: readonly string[] = ["settings-", "set-", "approval-", "confirm-dialog", "palette-", "app-toast", "ct-settings", "ct-safe", "modal-", "dialog-"];

const FORM_TYPES = new Set(["textarea", "input", "select", "button"]);

const COSMETIC = new Set([
  "color", "background-color", "background-image", "background", "background-size", "background-position", "background-position-x", "background-position-y", "background-repeat", "background-blend-mode",
  "border-color", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "border-style", "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
  "border-width", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border", "border-top", "border-right", "border-bottom", "border-left",
  "border-radius", "border-top-left-radius", "border-top-right-radius", "border-bottom-left-radius", "border-bottom-right-radius",
  "outline-color", "outline-offset", "box-shadow", "text-shadow", "caret-color", "accent-color", "fill", "stroke",
  "font-weight", "font-style", "letter-spacing", "text-decoration-color", "text-decoration-style", "text-decoration-thickness",
  "transition-property", "transition-duration", "transition-timing-function", "transition-delay", "transition", "scrollbar-color",
]);
const DECORATIVE = new Set([
  "content", "position", "inset", "top", "right", "bottom", "left", "width", "height", "transform", "transform-origin", "opacity", "mix-blend-mode",
  "pointer-events", "z-index", "filter", "mask-image", "-webkit-mask-image", "mask-size", "-webkit-mask-size", "mask-position", "-webkit-mask-position", "mask-repeat", "-webkit-mask-repeat",
]);
const ANIMATION = new Set(["animation", "animation-name", "animation-duration", "animation-timing-function", "animation-iteration-count", "animation-direction", "animation-delay", "animation-fill-mode"]);
const KEYFRAME_PROPS = new Set(["transform", "opacity", "background-position", "background-color", "color", "border-color", "box-shadow"]);
const KEYFRAME_PSEUDO_ONLY = new Set(["background-color", "color", "border-color", "box-shadow"]);

const DENIED: Record<string, string> = {
  display: "customCss can't hide or re-lay-out parts of the app",
  visibility: "customCss can't hide parts of the app",
  cursor: "the pointer stays the app's",
  "user-select": "text selection stays the app's",
  "-webkit-user-select": "text selection stays the app's",
  "font-size": "the type scale is fixed for readability",
  "line-height": "the type scale is fixed for readability",
  "font-family": "fonts come from typography (ui, display, mono, chat)",
  font: "fonts come from typography; use font-weight or font-style",
  margin: "layout properties can't change", padding: "layout properties can't change",
  "margin-top": "layout properties can't change", "margin-right": "layout properties can't change", "margin-bottom": "layout properties can't change", "margin-left": "layout properties can't change",
  "padding-top": "layout properties can't change", "padding-right": "layout properties can't change", "padding-bottom": "layout properties can't change", "padding-left": "layout properties can't change",
  overflow: "clipping can hide controls", "overflow-x": "clipping can hide controls", "overflow-y": "clipping can hide controls",
  clip: "clipping can hide controls", "clip-path": "clipping can hide controls",
  "backdrop-filter": "backdrop filters are expensive on large areas", "-webkit-backdrop-filter": "backdrop filters are expensive on large areas",
  "-webkit-text-fill-color": "text colour must stay checkable; use color with a token",
  "background-clip": "background-clip can make text unreadable", "-webkit-background-clip": "background-clip can make text unreadable",
  zoom: "layout properties can't change", resize: "layout properties can't change",
  appearance: "native controls keep their look", "-webkit-appearance": "native controls keep their look",
  "will-change": "the engine sets will-change itself",
  behavior: "not allowed", "-moz-binding": "not allowed",
  "max-width": "layout properties can't change", "min-width": "layout properties can't change", "max-height": "layout properties can't change", "min-height": "layout properties can't change",
  "font-variation-settings": "fonts come from typography", "text-transform": "status words and labels keep their case",
  "content-visibility": "customCss can't hide parts of the app", float: "layout properties can't change", flex: "layout properties can't change",
  "grid-template-columns": "layout properties can't change", gap: "layout properties can't change",
};
const REAL_ONLY_DENIED: Record<string, string> = {
  content: "content is only allowed on ::before/::after",
  position: "positioning real elements would move controls",
  inset: "layout properties can't change on real elements", top: "layout properties can't change on real elements", right: "layout properties can't change on real elements",
  bottom: "layout properties can't change on real elements", left: "layout properties can't change on real elements",
  width: "layout properties can't change on real elements", height: "layout properties can't change on real elements",
  "z-index": "stacking real elements can cover controls",
  transform: "transforms on real elements can move or hide controls",
  filter: "filters on real elements can make text unreadable",
  opacity: "opacity on real elements can make text unreadable",
  "pointer-events": "real elements must stay clickable",
  "mix-blend-mode": "blend modes on real elements can make text unreadable",
};

const ALLOWED_FUNCTIONS = new Set([
  "var", "calc", "min", "max", "clamp", "color-mix", "rgb", "rgba", "hsl", "hsla", "oklch", "oklab", "hwb",
  "linear-gradient", "radial-gradient", "conic-gradient", "repeating-linear-gradient", "repeating-radial-gradient", "repeating-conic-gradient",
  "cubic-bezier", "steps", "translate", "translatex", "translatey", "translatez", "translate3d", "scale", "scalex", "scaley", "scale3d",
  "rotate", "rotatex", "rotatey", "rotatez", "rotate3d", "skew", "skewx", "skewy", "perspective", "blur", "hue-rotate", "saturate",
]);
const FORBIDDEN_FUNCTIONS = new Set(["url", "image", "image-set", "-webkit-image-set", "element", "-moz-element", "cross-fade", "-webkit-cross-fade", "paint", "expression", "attr", "src", "-webkit-gradient", "env"]);

const ALLOWED_PSEUDO_CLASSES = new Set([
  "hover", "focus", "focus-visible", "focus-within", "active", "disabled", "enabled", "checked", "empty", "placeholder-shown", "read-only", "read-write",
  "first-child", "last-child", "only-child", "first-of-type", "last-of-type", "only-of-type", "indeterminate", "default", "required", "invalid", "valid",
]);
const ALLOWED_PSEUDO_FUNCTIONS = new Set(["not", "is", "where", "nth-child", "nth-last-child", "nth-of-type", "nth-last-of-type"]);
const ALLOWED_PSEUDO_ELEMENTS = new Set(["before", "after", "placeholder", "selection", "marker", "-webkit-scrollbar", "-webkit-scrollbar-thumb", "-webkit-scrollbar-track", "-webkit-scrollbar-corner"]);
const DECORATIVE_PSEUDO = new Set(["before", "after"]);

export const CSS_LIMITS = { selectorChars: 300, compounds: 6, rules: 200, declsPerRule: 40, keyframes: 12, keyframeStops: 20, infiniteAnimations: 6 } as const;

// ---- Selectors ----------------------------------------------------------------------------------

interface SelectorInfo {
  /** Tokens of the selector with a leading `.app-shell` compound part removed. */
  tokens: Tok[];
  /** The leading compound was `.app-shell…`: rest of that compound attaches to the scope. */
  mergedShell: boolean;
  pseudoElement: string | null;
  protectedTarget: boolean;
}

function splitTopLevel(tokens: Tok[], sep: Tok["t"] = ","): Tok[][] {
  const parts: Tok[][] = [[]];
  let depth = 0;
  for (const tok of tokens) {
    if (tok.t === "(" || tok.t === "[" || tok.t === "function") depth++;
    else if ((tok.t === ")" || tok.t === "]") && depth > 0) depth--;
    if (depth === 0 && tok.t === sep) { parts.push([]); continue; }
    parts[parts.length - 1].push(tok);
  }
  return parts;
}

function isProtectedClass(name: string): boolean {
  return PROTECTED_CLASSES.includes(name) || PROTECTED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Validate one selector; returns info or a drop reason. */
function checkSelector(raw: Tok[], nestedInFunction = false): SelectorInfo | { drop: string } {
  const tokens = trimWs(raw);
  if (!tokens.length) return { drop: "empty selector" };
  const text = serializeTokens(tokens);
  if (text.length > CSS_LIMITS.selectorChars) return { drop: `selector longer than ${CSS_LIMITS.selectorChars} characters` };
  const compounds: Array<{ classes: string[]; type: string | null; start: number }> = [{ classes: [], type: null, start: 0 }];
  let pseudoElement: string | null = null;
  let i = 0;
  const newCompound = (start: number) => { if (compounds[compounds.length - 1].start !== start) compounds.push({ classes: [], type: null, start }); };
  while (i < tokens.length) {
    const tok = tokens[i];
    if (pseudoElement && tok.t !== "ws" && !(tok.t === ":" )) {
      // nothing may follow a pseudo-element except a user-action pseudo-class
    }
    switch (tok.t) {
      case "ws": {
        let j = i;
        while (tokens[j]?.t === "ws") j++;
        const next = tokens[j];
        if (next && !(next.t === "delim" && (next.v === ">" || next.v === "+" || next.v === "~"))) { if (pseudoElement) return { drop: "a pseudo-element must be last" }; newCompound(j); }
        i = j;
        continue;
      }
      case "delim":
        if (tok.v === ">" || tok.v === "+" || tok.v === "~") { if (pseudoElement) return { drop: "a pseudo-element must be last" }; let j = i + 1; while (tokens[j]?.t === "ws") j++; newCompound(j); i = j; continue; }
        if (tok.v === ".") {
          const next = tokens[i + 1];
          if (next?.t !== "ident") return { drop: "malformed class selector" };
          compounds[compounds.length - 1].classes.push(next.v);
          i += 2; continue;
        }
        if (tok.v === "*") return { drop: "the universal selector `*` is not allowed (performance and override hazard)" };
        if (tok.v === "&") return { drop: "nesting selectors are not allowed" };
        if (tok.v === "|") return { drop: "namespaces are not allowed" };
        return { drop: `unexpected \`${tok.v}\` in selector` };
      case "hash":
        return { drop: "ID selectors are not allowed (IDs are unstable); use classes" };
      case "ident": {
        const name = tok.v.toLowerCase();
        if (name === "html" || name === "body") return { drop: "customCss can only style inside the app window" };
        compounds[compounds.length - 1].type = name;
        i++; continue;
      }
      case "[": {
        let j = i + 1;
        let depth = 1;
        for (; j < tokens.length && depth > 0; j++) {
          const cur = tokens[j];
          if (cur.t === "[") depth++;
          else if (cur.t === "]") depth--;
          else if (cur.t !== "ws" && cur.t !== "ident" && cur.t !== "string" && cur.t !== "delim" && cur.t !== "number") return { drop: "unsupported attribute selector" };
          else if (cur.t === "delim" && !["=", "~", "|", "^", "$", "*"].includes(cur.v)) return { drop: "unsupported attribute selector" };
        }
        if (depth !== 0) return { drop: "unclosed attribute selector" };
        i = j; continue;
      }
      case ":": {
        const isElement = tokens[i + 1]?.t === ":";
        const next = tokens[i + (isElement ? 2 : 1)];
        if (!next) return { drop: "malformed pseudo selector" };
        if (next.t === "ident") {
          const name = next.v.toLowerCase();
          if (isElement || name === "before" || name === "after") {
            if (name.startsWith("view-transition") || name === "backdrop") return { drop: `::${name} is outside the app window` };
            if (!ALLOWED_PSEUDO_ELEMENTS.has(name)) return { drop: `::${name} is not supported` };
            if (name.startsWith("-webkit-scrollbar") && compounds.length === 1 && !compounds[0].classes.length && !compounds[0].type) return { drop: "root scrollbars are app chrome" };
            if (nestedInFunction) return { drop: "pseudo-elements can't appear inside :not()/:is()" };
            if (pseudoElement) return { drop: "only one pseudo-element per selector" };
            pseudoElement = name;
          } else {
            if (name === "root" || name === "host" || name === "scope") return { drop: `:${name} is outside the app window` };
            if (!ALLOWED_PSEUDO_CLASSES.has(name)) return { drop: `:${name} is not supported` };
            if (pseudoElement && !["hover", "focus", "active"].includes(name)) return { drop: "a pseudo-element must be last" };
          }
          i += isElement ? 3 : 2; continue;
        }
        if (next.t === "function") {
          const name = next.v.toLowerCase();
          if (isElement) return { drop: `::${name}() is not supported` };
          if (name === "has") return { drop: ":has() is not allowed (invalidation cost)" };
          if (name === "host" || name === "host-context") return { drop: `:${name}() is outside the app window` };
          if (!ALLOWED_PSEUDO_FUNCTIONS.has(name)) return { drop: `:${name}() is not supported` };
          // read the argument
          let j = i + 2;
          let depth = 1;
          const arg: Tok[] = [];
          for (; j < tokens.length; j++) {
            const cur = tokens[j];
            if (cur.t === "(" || cur.t === "function" || cur.t === "[") depth++;
            else if (cur.t === ")" || cur.t === "]") { depth--; if (depth === 0) break; }
            arg.push(cur);
          }
          if (depth !== 0) return { drop: "unclosed pseudo-class" };
          if (name === "not" || name === "is" || name === "where") {
            for (const part of splitTopLevel(arg)) {
              const inner = checkSelector(part, true);
              if ("drop" in inner) return inner;
            }
          } else {
            const ok = arg.every((cur) => cur.t === "ws" || cur.t === "number" || cur.t === "dimension" || cur.t === "ident" || (cur.t === "delim" && (cur.v === "+" || cur.v === "-")));
            if (!ok) return { drop: `unsupported :${name}() argument` };
          }
          i = j + 1; continue;
        }
        return { drop: "malformed pseudo selector" };
      }
      default:
        return { drop: "unsupported selector syntax" };
    }
  }
  if (compounds.length > CSS_LIMITS.compounds) return { drop: `more than ${CSS_LIMITS.compounds} compound parts` };
  // Merge a leading `.app-shell` into the scope.
  let out = tokens;
  let mergedShell = false;
  if (!nestedInFunction && tokens[0]?.t === "delim" && tokens[0].v === "." && tokens[1]?.t === "ident" && tokens[1].v === "app-shell") {
    out = tokens.slice(2);
    mergedShell = true;
  } else if (!nestedInFunction && compounds[0].classes.includes("app-shell")) {
    return { drop: "`.app-shell` must come first in its compound" };
  }
  const right = compounds[compounds.length - 1];
  const protectedTarget = right.classes.some(isProtectedClass) || (right.type !== null && FORM_TYPES.has(right.type) && compounds.some((c) => c.classes.some(isProtectedClass)));
  return { tokens: out, mergedShell, pseudoElement, protectedTarget };
}

// ---- Values ---------------------------------------------------------------------------------------

interface ValueContext { declaredVars: Set<string>; known: Set<string> }

/** Generic value check: functions, var() references, strings, idents. Returns a reason when the value is not allowed. */
function checkValue(tokens: Tok[], ctx: ValueContext, allowStrings = false): { error?: string; drop?: string } {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t === "url" || tok.t === "bad") return { error: "url() is not allowed: themes can't load images or files (use gradients)" };
    if (tok.t === "function") {
      const name = tok.v.toLowerCase();
      if (FORBIDDEN_FUNCTIONS.has(name)) return { error: `${name}() is not allowed${name === "url" ? ": themes can't load images or files (use gradients)" : ""}` };
      if (!ALLOWED_FUNCTIONS.has(name)) return { drop: `${name}() is not supported` };
      if (name === "var") {
        let j = i + 1;
        while (tokens[j]?.t === "ws") j++;
        const ref = tokens[j];
        if (ref?.t !== "ident" || !ref.v.startsWith("--")) return { drop: "malformed var()" };
        if (!ref.v.startsWith("--ct-") && !ctx.known.has(ref.v)) return { drop: `var(${ref.v}) is not a theme token` };
      }
    }
    if (tok.t === "string" && !allowStrings) return { drop: "strings are not allowed here" };
    if (tok.t === "ident") {
      const lower = tok.v.toLowerCase();
      if (lower.includes(":") || lower.includes("javascript") || lower.includes("vbscript") || lower.includes("expression")) return { error: "script-like values are not allowed" };
    }
    if (tok.t === "delim" && (tok.v === "\\" || tok.v === "{" || tok.v === "@")) return { drop: "unexpected character in value" };
    if (tok.t === "{" || tok.t === "}" || tok.t === ";" || tok.t === "[" || tok.t === "]") return { drop: "unexpected character in value" };
  }
  return {};
}

function px(tok: Tok | undefined): number | null {
  if (!tok) return null;
  if (tok.t === "number" && tok.v === 0) return 0;
  if (tok.t === "dimension" && tok.unit.toLowerCase() === "px") return tok.v;
  return null;
}

function nonWs(tokens: Tok[]): Tok[] {
  return tokens.filter((tok) => tok.t !== "ws");
}

/** Colour-literal pieces of a value (hex hashes and rgb()/hsl()/oklch() calls), as strings. */
function literalColours(tokens: Tok[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t === "hash") out.push("#" + tok.v);
    else if (tok.t === "function" && ["rgb", "rgba", "hsl", "hsla", "oklch"].includes(tok.v.toLowerCase())) {
      let depth = 1, j = i + 1;
      const inner: Tok[] = [];
      for (; j < tokens.length && depth > 0; j++) {
        if (tokens[j].t === "function" || tokens[j].t === "(") depth++;
        else if (tokens[j].t === ")") depth--;
        if (depth > 0) inner.push(tokens[j]);
      }
      out.push(tok.v + "(" + serializeTokens(inner) + ")");
      i = j - 1;
    } else if (tok.t === "ident" && !["transparent", "currentcolor", "inherit", "none", "initial", "unset"].includes(tok.v.toLowerCase()) && parseColor(tok.v)) out.push(tok.v);
  }
  return out;
}

const TINT_MAX = 0.14;

function realColourError(prop: string, tokens: Tok[]): string | null {
  if (prop === "color") {
    // Text colour must stay a token (or currentColor): no literals, no transparent text.
    const words = nonWs(tokens);
    const usesVar = words.some((tok) => tok.t === "function" && tok.v.toLowerCase() === "var");
    const isCurrent = words.length === 1 && words[0].t === "ident" && words[0].v.toLowerCase() === "currentcolor";
    if (!usesVar && !isCurrent) return "Set text colours through tokens so contrast can be checked; use var(--text), var(--muted) or another token in color";
    if (words.some((tok) => tok.t === "ident" && tok.v.toLowerCase() === "transparent")) return "text can't be made transparent";
  }
  for (const literal of literalColours(tokens)) {
    const color = parseColor(literal);
    if (!color) return `\`${literal}\` in ${prop} is not a colour this engine can check; use var(--token)`;
    if (color.a > TINT_MAX) return `Set colours for text and surfaces through tokens so contrast can be checked; use var(--…) in ${prop} (a literal is only allowed as a faint tint, alpha ≤ ${TINT_MAX})`;
  }
  // Named colours other than transparent/currentColor fall through to literalColours via parseColor (black/white).
  return null;
}

function seconds(tok: Tok | undefined): number | null {
  if (!tok || tok.t !== "dimension") return tok?.t === "number" && tok.v === 0 ? 0 : null;
  const unit = tok.unit.toLowerCase();
  if (unit === "s") return tok.v;
  if (unit === "ms") return tok.v / 1000;
  return null;
}

function checkShadow(prop: "box-shadow" | "text-shadow", tokens: Tok[]): string | null {
  const layers = splitTopLevel(tokens).map(nonWs).filter((layer) => layer.length);
  const max = prop === "box-shadow" ? 4 : 2;
  if (layers.length === 1 && layers[0].length === 1 && layers[0][0].t === "ident" && layers[0][0].v.toLowerCase() === "none") return null;
  if (layers.length > max) return `${prop}: at most ${max} layers`;
  for (const layer of layers) {
    const inset = layer.some((tok) => tok.t === "ident" && tok.v.toLowerCase() === "inset");
    if (inset && prop === "text-shadow") return "text-shadow can't be inset";
    const lengths: number[] = [];
    for (let i = 0; i < layer.length; i++) {
      const tok = layer[i];
      if (tok.t === "function" && ["rgb", "rgba", "hsl", "hsla", "oklch", "var", "color-mix"].includes(tok.v.toLowerCase())) {
        let depth = 1;
        while (++i < layer.length && depth > 0) { if (layer[i].t === "function" || layer[i].t === "(") depth++; else if (layer[i].t === ")") depth--; }
        i--;
        continue;
      }
      if (tok.t === "dimension" || tok.t === "number") {
        const value = px(tok);
        if (value === null) return `${prop}: use px lengths`;
        lengths.push(value);
      } else if (tok.t === "function") return `${prop}: use px lengths (no ${tok.v}())`;
    }
    if (lengths.length < 2 || lengths.length > (prop === "box-shadow" ? 4 : 3)) return `${prop}: malformed shadow`;
    const [x, y, blur = 0, spread = 0] = lengths;
    if (blur > (prop === "box-shadow" ? 48 : 6)) return `${prop}: blur at most ${prop === "box-shadow" ? 48 : 6}px`;
    if (prop === "box-shadow" && Math.abs(spread) > 10) return "box-shadow: spread at most 10px";
    if (inset && (Math.abs(x) > 8 || Math.abs(y) > 8 || blur > 8 || Math.abs(spread) > 8)) return "box-shadow: inset shadows at most 8px";
    if (Math.abs(x) > 40 || Math.abs(y) > 40) return `${prop}: offsets at most 40px`;
  }
  return null;
}

// ---- Animations --------------------------------------------------------------------------------

interface AnimationUse { name: string; duration: number | null; iterations: number | "infinite"; steps: number | null }

const TIMING_IDENTS = new Set(["ease", "linear", "ease-in", "ease-out", "ease-in-out", "step-start", "step-end"]);
const DIRECTION_IDENTS = new Set(["normal", "reverse", "alternate", "alternate-reverse"]);
const FILL_IDENTS = new Set(["none", "forwards", "backwards", "both"]);

interface AnimationLonghands { name: Tok[]; duration: Tok[]; timing: Tok[]; iterations: Tok[]; direction: Tok[]; delay: Tok[]; fill: Tok[] }

/** Expand an `animation` shorthand into longhand token lists (one entry per comma layer). */
function expandAnimation(tokens: Tok[]): AnimationLonghands | { error: string } {
  const layers = splitTopLevel(tokens);
  const out: AnimationLonghands = { name: [], duration: [], timing: [], iterations: [], direction: [], delay: [], fill: [] };
  const comma: Tok = { t: "," };
  layers.forEach((layerRaw, index) => {
    const layer = nonWs(layerRaw);
    let name: Tok | null = null, duration: Tok | null = null, delay: Tok | null = null, iterations: Tok | null = null, direction: Tok | null = null, fill: Tok | null = null;
    let timing: Tok[] | null = null;
    for (let i = 0; i < layer.length; i++) {
      const tok = layer[i];
      if (tok.t === "dimension" && seconds(tok) !== null) { if (!duration) duration = tok; else delay = tok; continue; }
      if (tok.t === "number") { iterations = tok; continue; }
      if (tok.t === "function" && (tok.v.toLowerCase() === "cubic-bezier" || tok.v.toLowerCase() === "steps")) {
        const fn: Tok[] = [tok];
        let depth = 1;
        while (++i < layer.length && depth > 0) { fn.push(layer[i]); if (layer[i].t === ")") depth--; else if (layer[i].t === "function" || layer[i].t === "(") depth++; }
        i--;
        timing = fn;
        continue;
      }
      if (tok.t === "ident") {
        const v = tok.v.toLowerCase();
        if (TIMING_IDENTS.has(v) && !timing) { timing = [tok]; continue; }
        if (v === "infinite") { iterations = tok; continue; }
        if (DIRECTION_IDENTS.has(v) && !direction && v !== "normal") { direction = tok; continue; }
        if (FILL_IDENTS.has(v) && v !== "none" && !fill) { fill = tok; continue; }
        if (v === "running" || v === "paused") continue;
        name = tok; continue;
      }
    }
    if (index > 0) for (const list of Object.values(out)) list.push(comma);
    out.name.push(name ?? { t: "ident", v: "none" });
    out.duration.push(duration ?? { t: "number", v: 0, repr: "0" });
    out.timing.push(...(timing ?? [{ t: "ident", v: "ease" } as Tok]));
    out.iterations.push(iterations ?? { t: "number", v: 1, repr: "1" });
    out.direction.push(direction ?? { t: "ident", v: "normal" });
    out.delay.push(delay ?? { t: "number", v: 0, repr: "0" });
    out.fill.push(fill ?? { t: "ident", v: "none" });
  });
  return out;
}

interface Keyframes { name: string; stops: Array<{ at: number[]; decls: Array<{ name: string; value: Tok[] }> }> }

function stepsCount(timing: Tok[]): number | null {
  const first = timing.find((tok) => tok.t !== "ws");
  if (!first) return null;
  if (first.t === "ident" && (first.v.toLowerCase() === "step-start" || first.v.toLowerCase() === "step-end")) return 1;
  if (first.t === "function" && first.v.toLowerCase() === "steps") {
    const n = timing.find((tok) => tok.t === "number");
    return n && n.t === "number" ? Math.max(1, Math.round(n.v)) : 1;
  }
  return null;
}

/** Flash check: a large opacity or lightness change faster than 333ms (more than 3 flashes a second). */
function flashError(frames: Keyframes, use: AnimationUse): string | null {
  if (use.duration === null || use.duration <= 0) return null;
  const points: Array<{ at: number; opacity?: number; lightness?: number }> = [];
  for (const stop of frames.stops) {
    for (const at of stop.at) {
      const point: { at: number; opacity?: number; lightness?: number } = { at };
      for (const decl of stop.decls) {
        const value = nonWs(decl.value);
        if (decl.name === "opacity" && value.length === 1 && (value[0].t === "number" || value[0].t === "percentage")) point.opacity = value[0].t === "percentage" ? value[0].v / 100 : value[0].v;
        if (decl.name === "color" || decl.name === "background-color" || decl.name === "border-color") {
          const literal = literalColours(decl.value)[0];
          const color = literal ? parseColor(literal) : null;
          if (color) point.lightness = oklchLightness(color);
        }
      }
      points.push(point);
    }
  }
  points.sort((a, b) => a.at - b.at);
  const stepTime = use.steps ? use.duration / use.steps : Infinity;
  for (const key of ["opacity", "lightness"] as const) {
    const series = points.filter((point) => point[key] !== undefined);
    for (let k = 1; k < series.length; k++) {
      const delta = Math.abs((series[k][key] as number) - (series[k - 1][key] as number));
      const time = Math.min(((series[k].at - series[k - 1].at) / 100) * use.duration, stepTime);
      const limit = key === "opacity" ? 0.4 : 0.25;
      if (delta > limit && time < 0.333) return `@keyframes ${frames.name} changes ${key} by ${delta.toFixed(2)} in ${Math.round(time * 1000)}ms; flashing faster than 3 times a second is not allowed`;
    }
  }
  return null;
}

// ---- Sanitized model ------------------------------------------------------------------------

interface CleanDecl { name: string; value: Tok[]; animation: boolean }
interface CleanStyle { kind: "style"; selectors: SelectorInfo[]; decls: CleanDecl[] }
interface CleanMedia { kind: "media"; query: string; rules: CleanRule[] }
interface CleanSupports { kind: "supports"; condition: string; rules: CleanRule[] }
interface CleanKeyframes { kind: "keyframes"; name: string; stops: Array<{ at: string; decls: CleanDecl[] }> }
type CleanRule = CleanStyle | CleanMedia | CleanSupports | CleanKeyframes;

export interface SanitizeOutput { css: string; dropped: Array<{ where: string; reason: string }>; errors: string[] }

const MEDIA_FEATURES: Record<string, (value: Tok[]) => boolean> = {
  "prefers-reduced-motion": (v) => v.length === 1 && v[0].t === "ident" && ["reduce", "no-preference"].includes(v[0].v.toLowerCase()),
  "prefers-color-scheme": (v) => v.length === 1 && v[0].t === "ident" && ["light", "dark"].includes(v[0].v.toLowerCase()),
  "min-width": (v) => v.length === 1 && px(v[0]) !== null,
  "max-width": (v) => v.length === 1 && px(v[0]) !== null,
};

function checkMedia(prelude: Tok[]): string | null {
  for (const part of splitTopLevel(trimWs(prelude))) {
    const tokens = nonWs(part);
    if (!tokens.length) return null;
    let i = 0;
    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok.t === "ident" && ["and", "not", "only", "screen", "all"].includes(tok.v.toLowerCase())) { i++; continue; }
      if (tok.t === "(") {
        const feature = tokens[i + 1];
        const colon = tokens[i + 2];
        let j = i + 3;
        const value: Tok[] = [];
        while (j < tokens.length && tokens[j].t !== ")") value.push(tokens[j++]);
        if (feature?.t !== "ident" || colon?.t !== ":" || tokens[j]?.t !== ")") return null;
        const check = MEDIA_FEATURES[feature.v.toLowerCase()];
        if (!check || !check(value)) return null;
        i = j + 1; continue;
      }
      return null;
    }
  }
  return serializeTokens(trimWs(prelude));
}

class Sanitizer {
  dropped: Array<{ where: string; reason: string }> = [];
  errors: string[] = [];
  ruleCount = 0;
  keyframes = new Map<string, Keyframes>();
  declaredVars = new Set<string>();
  known = knownTokenVars();
  infinite = 0;

  drop(where: string, reason: string) { if (this.dropped.length < 80) this.dropped.push({ where, reason }); }
  error(message: string) { if (!this.errors.includes(message) && this.errors.length < 40) this.errors.push(message); }

  /** First pass: keyframe names and --ct-* declarations, so later rules can reference them. */
  collect(items: RawItem[]): void {
    for (const item of items) {
      if (item.kind === "at") {
        if ((item.name === "media" || item.name === "supports") && item.block) this.collect(parseRules(item.block));
        if ((item.name === "keyframes" || item.name === "-webkit-keyframes") && item.block) {
          const name = nonWs(item.prelude)[0];
          if (name?.t !== "ident") continue;
          const stops: Keyframes["stops"] = [];
          for (const frame of parseRules(item.block)) {
            if (frame.kind !== "qualified") continue;
            const at = splitTopLevel(frame.prelude).map((sel) => {
              const tok = nonWs(sel)[0];
              if (tok?.t === "percentage") return tok.v;
              if (tok?.t === "ident" && tok.v.toLowerCase() === "from") return 0;
              if (tok?.t === "ident" && tok.v.toLowerCase() === "to") return 100;
              return NaN;
            }).filter((n) => Number.isFinite(n) && n >= 0 && n <= 100);
            stops.push({ at, decls: parseDeclarations(frame.block).decls });
          }
          this.keyframes.set(name.v, { name: name.v, stops });
        }
      } else {
        for (const decl of parseDeclarations(item.block).decls) if (decl.name.startsWith("--ct-")) this.declaredVars.add(decl.name);
      }
    }
  }

  rules(items: RawItem[], depth = 0): CleanRule[] {
    const out: CleanRule[] = [];
    for (const item of items) {
      if (this.ruleCount >= CSS_LIMITS.rules) { this.drop("the rest of the stylesheet", `more than ${CSS_LIMITS.rules} rules`); break; }
      if (item.kind === "qualified") { const rule = this.style(item); if (rule) out.push(rule); continue; }
      const where = `@${item.name}`;
      if (item.name === "media") {
        if (!item.block) continue;
        const query = checkMedia(item.prelude);
        if (!query) { this.drop(`@media ${serializeTokens(trimWs(item.prelude)).slice(0, 60)}`, "only prefers-reduced-motion, prefers-color-scheme, min-width and max-width queries are allowed"); continue; }
        if (depth > 2) { this.drop(where, "nested too deeply"); continue; }
        const rules = this.rules(parseRules(item.block), depth + 1);
        if (rules.length) out.push({ kind: "media", query, rules });
        continue;
      }
      if (item.name === "supports") {
        if (!item.block) continue;
        const check = checkValue(item.prelude, { declaredVars: this.declaredVars, known: this.known });
        if (check.error) { this.error(`@supports: ${check.error}`); continue; }
        const condition = serializeTokens(trimWs(item.prelude));
        if (check.drop || !condition || condition.length > 200) { this.drop(where, check.drop ?? "condition not supported"); continue; }
        if (depth > 2) { this.drop(where, "nested too deeply"); continue; }
        const rules = this.rules(parseRules(item.block), depth + 1);
        if (rules.length) out.push({ kind: "supports", condition, rules });
        continue;
      }
      if (item.name === "keyframes" || item.name === "-webkit-keyframes") {
        const rule = this.keyframesRule(item);
        if (rule) out.push(rule);
        continue;
      }
      if (item.name === "import") { this.drop("@import", "themes can't load other stylesheets"); continue; }
      if (item.name === "font-face") { this.drop("@font-face", "themes can't load fonts; use typography"); continue; }
      this.drop(where, "this at-rule is not allowed in customCss");
    }
    return out;
  }

  keyframesRule(item: RawRule): CleanKeyframes | null {
    const nameTok = nonWs(item.prelude)[0];
    if (!item.block || nameTok?.t !== "ident" || nonWs(item.prelude).length !== 1) { this.drop("@keyframes", "needs a plain name"); return null; }
    const count = Array.from(this.keyframesSeen ??= new Set<string>()).length;
    if (count >= CSS_LIMITS.keyframes) { this.drop(`@keyframes ${nameTok.v}`, `more than ${CSS_LIMITS.keyframes} keyframes rules`); return null; }
    this.keyframesSeen.add(nameTok.v);
    const stops: CleanKeyframes["stops"] = [];
    for (const frame of parseRules(item.block)) {
      if (frame.kind !== "qualified") continue;
      if (stops.length >= CSS_LIMITS.keyframeStops) { this.drop(`@keyframes ${nameTok.v}`, "too many stops"); break; }
      const ats: string[] = [];
      for (const sel of splitTopLevel(frame.prelude)) {
        const tok = nonWs(sel);
        if (tok.length !== 1) continue;
        const t = tok[0];
        if (t.t === "percentage" && t.v >= 0 && t.v <= 100) ats.push(`${t.repr}%`);
        else if (t.t === "ident" && (t.v.toLowerCase() === "from" || t.v.toLowerCase() === "to")) ats.push(t.v.toLowerCase());
      }
      if (!ats.length) continue;
      const decls: CleanDecl[] = [];
      for (const decl of parseDeclarations(frame.block).decls) {
        const where = `@keyframes ${nameTok.v} ${decl.name}`;
        if (!KEYFRAME_PROPS.has(decl.name)) { this.drop(where, "keyframes may only animate transform, opacity, background-position and (on pseudo-elements) colours and box-shadow"); continue; }
        const check = checkValue(decl.value, { declaredVars: this.declaredVars, known: this.known });
        if (check.error) { this.error(`${where}: ${check.error}`); continue; }
        if (check.drop) { this.drop(where, check.drop); continue; }
        if (decl.name === "box-shadow") { const shadow = checkShadow("box-shadow", decl.value); if (shadow) { this.drop(where, shadow); continue; } }
        decls.push({ name: decl.name, value: decl.value, animation: false });
      }
      if (decls.length) stops.push({ at: ats.join(", "), decls });
    }
    if (!stops.length) return null;
    this.ruleCount++;
    return { kind: "keyframes", name: nameTok.v, stops };
  }
  keyframesSeen?: Set<string>;

  style(item: RawQualified): CleanStyle | null {
    const selectorText = serializeTokens(trimWs(item.prelude)).slice(0, 80) || "(empty)";
    const selectors: SelectorInfo[] = [];
    for (const part of splitTopLevel(item.prelude)) {
      const info = checkSelector(part);
      if ("drop" in info) { this.drop(`\`${serializeTokens(trimWs(part)).slice(0, 80)}\``, info.drop); continue; }
      selectors.push(info);
    }
    if (!selectors.length) return null;
    const parsed = parseDeclarations(item.block);
    if (parsed.nested) this.drop(`\`${selectorText}\``, "nested rules are not supported");
    if (parsed.bad) this.drop(`\`${selectorText}\``, `${parsed.bad} malformed declaration(s)`);
    const pseudo = selectors.every((sel) => sel.pseudoElement !== null && DECORATIVE_PSEUDO.has(sel.pseudoElement));
    const anyPseudoDecorative = selectors.some((sel) => sel.pseudoElement !== null && DECORATIVE_PSEUDO.has(sel.pseudoElement));
    if (anyPseudoDecorative && !pseudo) {
      this.drop(`\`${selectorText}\``, "mixes ::before/::after with real elements; split it into two rules");
      return null;
    }
    const isProtected = selectors.some((sel) => sel.protectedTarget);
    const decls: CleanDecl[] = [];
    let hasContent = false;
    const ctx: ValueContext = { declaredVars: this.declaredVars, known: this.known };
    for (const decl of parsed.decls.slice(0, CSS_LIMITS.declsPerRule)) {
      const where = `\`${decl.name}\` in \`${selectorText}\``;
      if (decl.important) this.drop(where, "!important was removed");
      const result = this.declaration(decl, { pseudo, isProtected, where, ctx });
      if (result === null) continue;
      if (decl.name === "content") hasContent = true;
      decls.push(...result);
    }
    if (parsed.decls.length > CSS_LIMITS.declsPerRule) this.drop(`\`${selectorText}\``, `more than ${CSS_LIMITS.declsPerRule} declarations`);
    if (pseudo && hasContent && !decls.some((d) => d.name === "pointer-events")) {
      // Decorations never take pointer events.
      decls.push({ name: "pointer-events", value: [{ t: "ident", v: "none" }], animation: false });
    }
    if (!decls.length) return null;
    this.ruleCount++;
    return { kind: "style", selectors, decls };
  }

  declaration(decl: RawDecl, opts: { pseudo: boolean; isProtected: boolean; where: string; ctx: ValueContext }): CleanDecl[] | null {
    const { name } = decl;
    const value = decl.value;
    const { where, pseudo, isProtected, ctx } = opts;
    if (!value.length) { this.drop(where, "empty value"); return null; }
    // Custom properties
    if (name.startsWith("--")) {
      if (!name.startsWith("--ct-")) { this.error(`Set \`${name}\` in tokens, not customCss, so contrast can be checked (customCss may only declare --ct-* variables).`); return null; }
      const check = checkValue(value, ctx);
      if (check.error) { this.error(`${where}: ${check.error}`); return null; }
      if (check.drop) { this.drop(where, check.drop); return null; }
      return [{ name, value, animation: false }];
    }
    if (DENIED[name]) { this.error(`${where}: \`${name}\` is not allowed (${DENIED[name]}).`); return null; }
    if (!pseudo && REAL_ONLY_DENIED[name]) { this.error(`${where}: \`${name}\` is not allowed on real elements (${REAL_ONLY_DENIED[name]}); use ::before/::after for decoration.`); return null; }
    if (isProtected && (name === "opacity" || name === "transform" || name === "filter" || name === "content" || ANIMATION.has(name))) {
      this.error(`${where}: this is a protected control (composer, send/stop, approvals, settings, dialogs, palette, toasts); only cosmetic properties are allowed there.`);
      return null;
    }
    const allowed = COSMETIC.has(name) || (pseudo && DECORATIVE.has(name)) || ANIMATION.has(name);
    if (!allowed) { this.drop(where, `\`${name}\` is not in the customCss allowlist`); return null; }
    const check = checkValue(value, ctx, name === "content");
    if (check.error) { this.error(`${where}: ${check.error}`); return null; }
    if (check.drop) { this.drop(where, check.drop); return null; }
    const flat = nonWs(value);
    const first = flat[0];
    const ident = (tok: Tok | undefined) => (tok?.t === "ident" ? tok.v.toLowerCase() : "");

    switch (name) {
      case "content":
        if (!(flat.length === 1 && first.t === "string" && first.v === "")) { this.error(`${where}: content may only be "" (decorations can't add text).`); return null; }
        break;
      case "position":
        if (ident(first) !== "absolute" || flat.length !== 1) { this.error(`${where}: decorations may only use position: absolute (no fixed or sticky overlays).`); return null; }
        break;
      case "pointer-events":
        if (ident(first) !== "none") { this.error(`${where}: decorations must use pointer-events: none.`); return null; }
        break;
      case "z-index":
        if (!(flat.length === 1 && first.t === "number" && Number.isInteger(first.v) && first.v >= -1 && first.v <= 1)) { this.error(`${where}: z-index on decorations must be -1, 0 or 1.`); return null; }
        break;
      case "inset": case "top": case "right": case "bottom": case "left":
        for (const tok of flat) {
          if (tok.t === "percentage" || (tok.t === "ident" && tok.v === "auto")) continue;
          const v = px(tok);
          if (v === null || Math.abs(v) > 40) { this.drop(where, "offsets must be % or at most 40px"); return null; }
        }
        break;
      case "width": case "height":
        if (!(flat.length === 1 && ((first.t === "percentage" && first.v <= 300 && first.v >= 0) || (px(first) !== null && (px(first) as number) <= 40 && (px(first) as number) >= 0)))) { this.drop(where, "decoration size must be a % up to 300% (or up to 40px)"); return null; }
        break;
      case "filter":
        for (let k = 0; k < flat.length; k++) {
          const tok = flat[k];
          if (tok.t === "function") {
            const fn = tok.v.toLowerCase();
            if (!["blur", "hue-rotate", "saturate"].includes(fn)) { this.drop(where, "only blur(), hue-rotate() and saturate() filters"); return null; }
            if (fn === "blur") { const v = px(flat[k + 1]); if (v === null || v > 24) { this.drop(where, "blur() at most 24px"); return null; } }
          } else if (tok.t === "ident" && tok.v.toLowerCase() === "none") continue;
        }
        break;
      case "mask-image": case "-webkit-mask-image": case "background-image":
        for (const tok of flat) if (tok.t === "function" && !/gradient$/.test(tok.v.toLowerCase()) && !["var", "rgb", "rgba", "hsl", "hsla", "oklch", "color-mix", "calc"].includes(tok.v.toLowerCase())) { this.drop(where, "only gradients are allowed"); return null; }
        break;
      case "border-width": case "border-top-width": case "border-right-width": case "border-bottom-width": case "border-left-width":
      case "border": case "border-top": case "border-right": case "border-bottom": case "border-left":
        for (const tok of flat) {
          if (tok.t === "dimension" || tok.t === "number") {
            const v = px(tok);
            if (v === null || v > 3 || v < 0) { this.drop(where, "border width at most 3px (px only)"); return null; }
          }
          if (tok.t === "ident" && tok.v.toLowerCase() === "thick") { this.drop(where, "border width at most 3px"); return null; }
        }
        break;
      case "border-radius": case "border-top-left-radius": case "border-top-right-radius": case "border-bottom-left-radius": case "border-bottom-right-radius":
        for (const tok of flat) {
          if (tok.t === "delim" && tok.v === "/") continue;
          if (tok.t === "percentage" && !pseudo) { this.drop(where, "use px radii (at most 20px) on real elements"); return null; }
          if (tok.t === "percentage") continue;
          if (tok.t === "function") continue;
          if (tok.t === "ident" && ["inherit", "initial", "unset"].includes(tok.v.toLowerCase())) continue;
          const v = px(tok);
          if (v === null || v > 20) { this.drop(where, "border-radius at most 20px (Mythra uses rounded squares, not ovals)"); return null; }
        }
        break;
      case "outline-offset": {
        const v = px(first);
        if (flat.length !== 1 || v === null || v < 0 || v > 4) { this.drop(where, "outline-offset 0–4px"); return null; }
        break;
      }
      case "box-shadow": case "text-shadow": {
        const shadow = checkShadow(name, value);
        if (shadow) { this.drop(where, shadow); return null; }
        break;
      }
      case "font-weight": {
        const v = first.t === "number" ? first.v : ({ normal: 400, bold: 700 } as Record<string, number>)[ident(first)];
        if (flat.length !== 1 || v === undefined || v < 400 || v > 700) { this.drop(where, "font-weight 400–700"); return null; }
        break;
      }
      case "letter-spacing": {
        const v = first.t === "dimension" && first.unit.toLowerCase() === "em" ? first.v : first.t === "number" && first.v === 0 ? 0 : ident(first) === "normal" ? 0 : null;
        if (flat.length !== 1 || v === null || v < -0.02 || v > 0.06) { this.drop(where, "letter-spacing −0.02em to 0.06em"); return null; }
        break;
      }
      case "transition-duration": case "transition-delay": case "transition": {
        const out: Tok[] = [];
        for (const tok of value) {
          const s = seconds(tok);
          if (s !== null && s > 0.4) { out.push({ t: "dimension", v: 400, repr: "400", unit: "ms" }); this.drop(where, "transitions are capped at 400ms"); }
          else out.push(tok);
        }
        if (name === "transition") {
          for (const layer of splitTopLevel(value)) {
            const prop = nonWs(layer).find((tok) => tok.t === "ident" && !TIMING_IDENTS.has(tok.v.toLowerCase()));
            if (prop && prop.t === "ident" && ["all", "width", "height", "top", "left", "right", "bottom", "margin", "padding", "font-size", "line-height"].includes(prop.v.toLowerCase())) { this.drop(where, "transition only cosmetic properties (colour, background, border, box-shadow, opacity, transform)"); return null; }
          }
        }
        return [{ name, value: out, animation: false }];
      }
      case "transition-property":
        for (const tok of flat) if (tok.t === "ident" && ["all", "width", "height", "top", "left", "right", "bottom", "margin", "padding", "font-size", "line-height"].includes(tok.v.toLowerCase())) { this.drop(where, "transition only cosmetic properties"); return null; }
        break;
      default:
        break;
    }

    if (!pseudo && (name === "color" || name === "background-color" || name === "background" || name === "background-image")) {
      const problem = realColourError(name, value);
      if (problem) { this.error(`${where}: ${problem}.`); return null; }
    }

    if (ANIMATION.has(name)) return this.animation(decl, { pseudo, where });
    return [{ name, value, animation: false }];
  }

  animation(decl: RawDecl, opts: { pseudo: boolean; where: string }): CleanDecl[] | null {
    const { where, pseudo } = opts;
    let longhands: AnimationLonghands;
    if (decl.name === "animation") {
      const expanded = expandAnimation(decl.value);
      if ("error" in expanded) { this.drop(where, expanded.error); return null; }
      longhands = expanded;
    } else {
      const map: Record<string, keyof AnimationLonghands> = {
        "animation-name": "name", "animation-duration": "duration", "animation-timing-function": "timing", "animation-iteration-count": "iterations",
        "animation-direction": "direction", "animation-delay": "delay", "animation-fill-mode": "fill",
      };
      const key = map[decl.name];
      // Longhands are checked together when the rule has a name and duration; single longhands are kept as-is after value checks.
      if (key === "name") {
        for (const tok of nonWs(decl.value)) {
          if (tok.t === ",") continue;
          if (tok.t !== "ident" || (tok.v.toLowerCase() !== "none" && !this.keyframes.has(tok.v))) { this.error(`${where}: animation-name must name a @keyframes rule in this stylesheet.`); return null; }
        }
      }
      if (key === "duration") {
        for (const tok of nonWs(decl.value)) {
          if (tok.t === ",") continue;
          const s = seconds(tok);
          if (s === null || s < 1.2) { this.error(`${where}: animations must last at least 1.2s (2s when infinite); calm motion reads better.`); return null; }
        }
      }
      return [{ name: decl.name, value: decl.value, animation: true }];
    }
    // Check each layer of the shorthand.
    const names = splitTopLevel(longhands.name).map((l) => nonWs(l)[0]);
    const durations = splitTopLevel(longhands.duration).map((l) => seconds(nonWs(l)[0]));
    const iterations = splitTopLevel(longhands.iterations).map((l) => nonWs(l)[0]);
    const timings = splitTopLevel(longhands.timing);
    for (let k = 0; k < names.length; k++) {
      const nameTok = names[k];
      if (!nameTok || nameTok.t !== "ident" || nameTok.v.toLowerCase() === "none") continue;
      const frames = this.keyframes.get(nameTok.v);
      if (!frames) { this.error(`${where}: \`${nameTok.v}\` is not a @keyframes rule in this stylesheet.`); return null; }
      const infinite = iterations[k]?.t === "ident" && (iterations[k] as { v: string }).v.toLowerCase() === "infinite";
      const duration = durations[k] ?? 0;
      if (duration < (infinite ? 2 : 1.2)) { this.error(`${where}: \`${nameTok.v}\` lasts ${duration}s; animations must last at least 1.2s (2s when infinite).`); return null; }
      if (infinite && ++this.infinite > CSS_LIMITS.infiniteAnimations) { this.error(`${where}: at most ${CSS_LIMITS.infiniteAnimations} infinite animations.`); return null; }
      const use: AnimationUse = { name: nameTok.v, duration, iterations: infinite ? "infinite" : 1, steps: stepsCount(timings[k] ?? []) };
      const flash = flashError(frames, use);
      if (flash) { this.error(flash + "."); return null; }
      if (!pseudo && frames.stops.some((stop) => stop.decls.some((d) => KEYFRAME_PSEUDO_ONLY.has(d.name)))) {
        this.error(`${where}: \`${nameTok.v}\` animates colours or shadows, which is only allowed on ::before/::after.`);
        return null;
      }
    }
    return [
      { name: "animation-name", value: longhands.name, animation: true },
      { name: "animation-duration", value: longhands.duration, animation: true },
      { name: "animation-timing-function", value: longhands.timing, animation: true },
      { name: "animation-iteration-count", value: longhands.iterations, animation: true },
      { name: "animation-direction", value: longhands.direction, animation: true },
      { name: "animation-delay", value: longhands.delay, animation: true },
      { name: "animation-fill-mode", value: longhands.fill, animation: true },
    ];
  }
}

function runPipeline(css: string): { rules: CleanRule[]; dropped: SanitizeOutput["dropped"]; errors: string[] } {
  const sanitizer = new Sanitizer();
  const items = parseRules(tokenize(css));
  sanitizer.collect(items);
  const rules = sanitizer.rules(items);
  return { rules, dropped: sanitizer.dropped, errors: sanitizer.errors };
}

// ---- Output -----------------------------------------------------------------------------------

function declText(decl: CleanDecl, renameKeyframes?: (name: string) => string): string {
  let tokens = decl.value;
  if (renameKeyframes && decl.name === "animation-name") tokens = tokens.map((tok) => (tok.t === "ident" && tok.v.toLowerCase() !== "none" ? { t: "ident", v: renameKeyframes(tok.v) } : tok));
  return `${decl.name}: ${serializeTokens(tokens)};`;
}

function selectorText(sel: SelectorInfo, scope: string | null): string {
  let body = serializeTokens(sel.tokens);
  // `.app-shell .x` keeps its descendant combinator; `.app-shell[attr]` stays on the shell itself.
  const first = sel.tokens[0];
  if (sel.mergedShell && first && (first.t === "ws" || (first.t === "delim" && (first.v === ">" || first.v === "+" || first.v === "~")))) body = " " + body;
  if (scope === null) return (sel.mergedShell ? ".app-shell" : "") + body;
  if (sel.mergedShell) return scope + body;
  return `${scope} ${body}`;
}

function serializeUnscoped(rules: CleanRule[]): string {
  return rules.map((rule) => {
    switch (rule.kind) {
      case "style": return `${rule.selectors.map((sel) => selectorText(sel, null)).join(", ")} { ${rule.decls.map((d) => declText(d)).join(" ")} }`;
      case "media": return `@media ${rule.query} {\n${serializeUnscoped(rule.rules)}\n}`;
      case "supports": return `@supports ${rule.condition} {\n${serializeUnscoped(rule.rules)}\n}`;
      case "keyframes": return `@keyframes ${escapeIdent(rule.name)} { ${rule.stops.map((stop) => `${stop.at} { ${stop.decls.map((d) => declText(d)).join(" ")} }`).join(" ")} }`;
    }
  }).join("\n");
}

/** Scope prefix for a theme's customCss (0,5,0, beats the Windows ink rule and Lumen's shell scope). */
export function customCssScope(id: string, motion = false): string {
  return `:root .app-shell[data-theme][data-color-scheme][data-custom-theme="${id}"]${motion ? '[data-theme-motion="on"]' : ""}`;
}

export function keyframeName(id: string, name: string): string {
  return `ct-${id}-${name}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function serializeScoped(rules: CleanRule[], id: string): string {
  const scope = customCssScope(id);
  const motionScope = customCssScope(id, true);
  const rename = (name: string) => keyframeName(id, name);
  return rules.map((rule) => {
    switch (rule.kind) {
      case "style": {
        const statics = rule.decls.filter((d) => !d.animation);
        const motion = rule.decls.filter((d) => d.animation);
        const parts: string[] = [];
        if (statics.length) parts.push(`${rule.selectors.map((sel) => selectorText(sel, scope)).join(", ")} { ${statics.map((d) => declText(d)).join(" ")} }`);
        if (motion.length) parts.push(`@media (prefers-reduced-motion: no-preference) { ${rule.selectors.map((sel) => selectorText(sel, motionScope)).join(", ")} { ${motion.map((d) => declText(d, rename)).join(" ")} } }`);
        return parts.join("\n");
      }
      case "media": return `@media ${rule.query} {\n${serializeScoped(rule.rules, id)}\n}`;
      case "supports": return `@supports ${rule.condition} {\n${serializeScoped(rule.rules, id)}\n}`;
      case "keyframes": return `@keyframes ${rename(rule.name)} { ${rule.stops.map((stop) => `${stop.at} { ${stop.decls.map((d) => declText(d)).join(" ")} }`).join(" ")} }`;
    }
  }).join("\n");
}

/** Canonical, unscoped CSS for storage in the spec. Idempotent. */
export function cleanCustomCss(css: string): SanitizeOutput {
  if (!css.trim()) return { css: "", dropped: [], errors: [] };
  const { rules, dropped, errors } = runPipeline(css);
  // Every declaration behind an error was already left out of `rules`, so
  // the safe remainder is kept; callers report the errors as removals.
  return { css: serializeUnscoped(rules), dropped, errors };
}

/** Scoped CSS ready to inject for theme `id`. */
export function sanitizeCustomCss(css: string, opts: { id: string }): SanitizeOutput {
  if (!/^ct_[a-z0-9]{10}$/.test(opts.id)) return { css: "", dropped: [], errors: ["invalid theme id"] };
  if (!css.trim()) return { css: "", dropped: [], errors: [] };
  const { rules, dropped, errors } = runPipeline(css);
  return { css: serializeScoped(rules, opts.id), dropped, errors };
}
