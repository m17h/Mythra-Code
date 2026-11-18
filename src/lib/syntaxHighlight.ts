/**
 * A small, dependency-free syntax highlighter for diffs and code blocks.
 *
 * It is deliberately a tokenizer, not a parser: one pass over each line that
 * recognises comments, strings, numbers, keywords, calls, types, markup tags
 * and punctuation for the languages people most often see in Mythra Code.
 * Anything it does not recognise stays plain text, which is always a safe
 * answer. State that spans lines (block comments, template and triple-quoted
 * strings, open markup tags, fenced Markdown) is carried in `SyntaxState`, so
 * a caller can tokenize line by line — a diff tokenizes its two sides with two
 * states.
 *
 * Colours are not decided here. Each token has a `kind`; the stylesheet maps
 * `syn-<kind>` classes to the theme's `--syntax-*` tokens.
 */

export type SyntaxKind =
  | "keyword" | "string" | "comment" | "number" | "constant" | "function" | "type"
  | "tag" | "attr" | "property" | "punct" | "operator" | "heading" | "inserted" | "deleted" | "meta";

export interface SyntaxToken { text: string; kind?: SyntaxKind }

export type SyntaxLanguage =
  | "js" | "jsx" | "json" | "css" | "html" | "markdown" | "python" | "rust" | "go" | "shell" | "yaml" | "toml" | "diff";

export interface SyntaxState {
  /** An unfinished construct carried to the next line. */
  block?: "comment" | "template" | "raw" | "triple-double" | "triple-single" | "html-comment" | "fence";
  /** Inside an open markup tag (`<div class=…` over several lines). */
  tag?: boolean;
}

/** Lines longer than this stay plain: minified files would cost more than they show. */
export const MAX_HIGHLIGHT_LINE = 1_000;

const words = (list: string) => new Set(list.split(/\s+/).filter(Boolean));

const JS_KEYWORDS = words(`
  abstract as async await break case catch class const continue debugger declare default delete do else enum export
  extends finally for from function get if implements import in infer instanceof interface is keyof let namespace new
  of package private protected public readonly return satisfies set static super switch throw try type typeof var void
  while with yield`);
const JS_CONSTANTS = words("true false null undefined NaN Infinity this");
const PY_KEYWORDS = words(`and as assert async await break case class continue def del elif else except finally for from
  global if import in is lambda match nonlocal not or pass raise return try while with yield`);
const PY_CONSTANTS = words("True False None self cls");
const RS_KEYWORDS = words(`as async await break const continue crate dyn else enum extern fn for if impl in let loop match
  mod move mut pub ref return static struct super trait type unsafe use where while`);
const RS_CONSTANTS = words("true false self Self None Some Ok Err");
const GO_KEYWORDS = words(`break case chan const continue default defer else fallthrough for func go goto if import
  interface map package range return select struct switch type var`);
const GO_CONSTANTS = words("true false nil iota");
const SH_KEYWORDS = words(`if then else elif fi for while until do done case esac in function return export local readonly
  unset source alias exit break continue select time`);
const SH_CONSTANTS = words("true false");
const YAML_CONSTANTS = words("true false null yes no on off True False Null Yes No On Off TRUE FALSE NULL ~");
const CSS_KEYWORDS = words("!important inherit initial unset revert auto none");

interface CodeSpec {
  lineComments: string[];
  blockComment?: [string, string];
  /** Single-line string delimiters. */
  quotes: string;
  /** Backtick strings that may continue on the next line (JS templates, Go raw strings). */
  multilineBacktick?: "template" | "raw";
  tripleQuotes?: boolean;
  keywords: Set<string>;
  constants: Set<string>;
  /** Capitalised identifiers read as types (JS/TS, Rust, Go, Python classes). */
  capitalTypes?: boolean;
  /** `<Tag attr=…>` markup inside code (JSX/TSX). */
  jsx?: boolean;
  /** `name!(` reads as a call (Rust macros). */
  macros?: boolean;
  /** `"key":` reads as a property (JSON). */
  stringKeys?: boolean;
  /** `@decorator`. */
  decorators?: boolean;
  /** Identifier characters beyond `\w$` (CSS and shell allow `-`). */
  identDash?: boolean;
}

const SPECS: Partial<Record<SyntaxLanguage, CodeSpec>> = {
  js: { lineComments: ["//"], blockComment: ["/*", "*/"], quotes: "'\"", multilineBacktick: "template", keywords: JS_KEYWORDS, constants: JS_CONSTANTS, capitalTypes: true, decorators: true },
  jsx: { lineComments: ["//"], blockComment: ["/*", "*/"], quotes: "'\"", multilineBacktick: "template", keywords: JS_KEYWORDS, constants: JS_CONSTANTS, capitalTypes: true, jsx: true, decorators: true },
  json: { lineComments: ["//"], blockComment: ["/*", "*/"], quotes: "\"", keywords: new Set(), constants: words("true false null"), stringKeys: true },
  python: { lineComments: ["#"], quotes: "'\"", tripleQuotes: true, keywords: PY_KEYWORDS, constants: PY_CONSTANTS, capitalTypes: true, decorators: true },
  rust: { lineComments: ["//"], blockComment: ["/*", "*/"], quotes: "\"", keywords: RS_KEYWORDS, constants: RS_CONSTANTS, capitalTypes: true, macros: true },
  go: { lineComments: ["//"], blockComment: ["/*", "*/"], quotes: "\"'", multilineBacktick: "raw", keywords: GO_KEYWORDS, constants: GO_CONSTANTS, capitalTypes: true },
  css: { lineComments: [], blockComment: ["/*", "*/"], quotes: "'\"", keywords: CSS_KEYWORDS, constants: new Set(), identDash: true },
};

const EXTENSIONS: Record<string, SyntaxLanguage> = {
  ts: "js", mts: "js", cts: "js", js: "js", mjs: "js", cjs: "js", tsx: "jsx", jsx: "jsx",
  json: "json", jsonc: "json", json5: "json", webmanifest: "json",
  css: "css", scss: "css", less: "css", pcss: "css",
  html: "html", htm: "html", xml: "html", svg: "html", vue: "html", svelte: "html", astro: "html", plist: "html",
  md: "markdown", mdx: "markdown", markdown: "markdown",
  py: "python", pyi: "python", rs: "rust", go: "go",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ps1: "shell", env: "shell",
  yml: "yaml", yaml: "yaml", toml: "toml", lock: "toml", diff: "diff", patch: "diff",
};
const FILE_NAMES: Record<string, SyntaxLanguage> = {
  dockerfile: "shell", makefile: "shell", ".bashrc": "shell", ".zshrc": "shell", ".profile": "shell", ".env": "shell",
  "cargo.lock": "toml", ".gitignore": "shell", ".npmrc": "shell",
};
const FENCES: Record<string, SyntaxLanguage> = {
  ts: "js", typescript: "js", js: "js", javascript: "js", mjs: "js", cjs: "js", node: "js",
  tsx: "jsx", jsx: "jsx", json: "json", jsonc: "json", json5: "json",
  css: "css", scss: "css", less: "css", html: "html", xml: "html", svg: "html", vue: "html",
  md: "markdown", markdown: "markdown", mdx: "markdown", py: "python", python: "python", python3: "python",
  rs: "rust", rust: "rust", go: "go", golang: "go",
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", console: "shell", shellscript: "shell", dockerfile: "shell", docker: "shell", make: "shell", makefile: "shell",
  yaml: "yaml", yml: "yaml", toml: "toml", diff: "diff", patch: "diff",
};

/** The language for a file path, from its extension or well-known name. */
export function languageForPath(path: string | null | undefined): SyntaxLanguage | null {
  if (!path) return null;
  const name = path.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (FILE_NAMES[name]) return FILE_NAMES[name];
  if (name.startsWith(".env")) return "shell";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return EXTENSIONS[name.slice(dot + 1)] ?? null;
}

/** The language for a Markdown fence name ("```ts"). */
export function languageForFence(name: string | null | undefined): SyntaxLanguage | null {
  if (!name) return null;
  return FENCES[name.trim().toLowerCase()] ?? null;
}

class Out {
  tokens: SyntaxToken[] = [];
  push(text: string, kind?: SyntaxKind) {
    if (!text) return;
    const last = this.tokens[this.tokens.length - 1];
    if (last && last.kind === kind) last.text += text;
    else this.tokens.push(kind ? { text, kind } : { text });
  }
}

const NUMBER = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.\d[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)(?:n|[a-zA-Z%]{1,4})?/;
const OPERATOR = /^(?:=>|[=!<>]=?=?|&&|\|\||\?\?|\?\.|\.\.\.|[-+*/%&|^~?:]=?|::)/;
const PUNCT = /^[{}()[\];,.]/;

function identAt(line: string, i: number, dash: boolean): string {
  const match = (dash ? /^-*[A-Za-z_$][\w$-]*/ : /^[A-Za-z_$][\w$]*/).exec(line.slice(i));
  return match ? match[0] : "";
}

/** Reads a quoted string starting at `i`; returns its end (exclusive) and whether it closed. */
function readQuoted(line: string, i: number, quote: string): { end: number; closed: boolean } {
  let j = i + quote.length;
  while (j < line.length) {
    if (line[j] === "\\") { j += 2; continue; }
    if (line.startsWith(quote, j)) return { end: j + quote.length, closed: true };
    j += 1;
  }
  return { end: line.length, closed: false };
}

/** Index of the next unescaped backtick at or after `from`, or -1. */
function closingBacktick(line: string, from: number): number {
  for (let j = from; j < line.length; j += 1) {
    if (line[j] === "\\") { j += 1; continue; }
    if (line[j] === "`") return j;
  }
  return -1;
}

function previousSignificant(out: Out): string {
  for (let index = out.tokens.length - 1; index >= 0; index -= 1) {
    const text = out.tokens[index].text.trimEnd();
    if (text) return text;
  }
  return "";
}

/** Code-like languages: JS/TS(X), JSON, Python, Rust, Go, CSS. */
function tokenizeCode(line: string, spec: CodeSpec, state: SyntaxState, lang: SyntaxLanguage): { tokens: SyntaxToken[]; state: SyntaxState } {
  const out = new Out();
  let next: SyntaxState = { ...state };
  let i = 0;
  // An unfinished construct from an earlier line comes first.
  if (next.block === "comment" && spec.blockComment) {
    const end = line.indexOf(spec.blockComment[1]);
    if (end < 0) return { tokens: [{ text: line, kind: "comment" }], state: next };
    i = end + spec.blockComment[1].length;
    out.push(line.slice(0, i), "comment");
    next.block = undefined;
  } else if (next.block === "template" || next.block === "raw") {
    const end = next.block === "raw" ? line.indexOf("`") : closingBacktick(line, 0);
    if (end < 0) return { tokens: [{ text: line, kind: "string" }], state: next };
    i = end + 1;
    out.push(line.slice(0, i), "string");
    next.block = undefined;
  } else if (next.block === "triple-double" || next.block === "triple-single") {
    const quote = next.block === "triple-double" ? "\"\"\"" : "'''";
    const end = line.indexOf(quote);
    if (end < 0) return { tokens: [{ text: line, kind: "string" }], state: next };
    i = end + 3;
    out.push(line.slice(0, i), "string");
    next.block = undefined;
  }
  const cssValue = lang === "css" && !line.includes("{") && /:/.test(line);
  while (i < line.length) {
    const rest = line.slice(i);
    const ch = line[i];
    // Inside an open JSX tag: attribute names, strings, and the closing bracket.
    if (next.tag) {
      if (rest.startsWith("/>") || ch === ">") {
        const text = rest.startsWith("/>") ? "/>" : ">";
        out.push(text, "punct");
        i += text.length;
        next.tag = false;
        continue;
      }
      if (/\s/.test(ch)) { out.push(ch); i += 1; continue; }
      if (ch === "\"" || ch === "'") { const read = readQuoted(line, i, ch); out.push(line.slice(i, read.end), "string"); i = read.end; continue; }
      if (ch === "{" || ch === "}") { out.push(ch, "punct"); i += 1; continue; }
      const attr = /^[A-Za-z_:][\w:.-]*/.exec(rest);
      if (attr) { out.push(attr[0], "attr"); i += attr[0].length; continue; }
      if (ch === "=") { out.push(ch, "operator"); i += 1; continue; }
    }
    if (/\s/.test(ch)) {
      const space = /^\s+/.exec(rest)![0];
      out.push(space);
      i += space.length;
      continue;
    }
    const lineComment = spec.lineComments.find((marker) => rest.startsWith(marker));
    if (lineComment && !(lang === "json" && rest.startsWith("//") && i > 0 && line[i - 1] === ":")) {
      out.push(rest, "comment");
      break;
    }
    if (spec.blockComment && rest.startsWith(spec.blockComment[0])) {
      const end = line.indexOf(spec.blockComment[1], i + spec.blockComment[0].length);
      if (end < 0) { out.push(rest, "comment"); next.block = "comment"; break; }
      out.push(line.slice(i, end + spec.blockComment[1].length), "comment");
      i = end + spec.blockComment[1].length;
      continue;
    }
    if (spec.tripleQuotes && (rest.startsWith("\"\"\"") || rest.startsWith("'''"))) {
      const quote = rest.slice(0, 3);
      const end = line.indexOf(quote, i + 3);
      if (end < 0) { out.push(rest, "string"); next.block = quote === "\"\"\"" ? "triple-double" : "triple-single"; break; }
      out.push(line.slice(i, end + 3), "string");
      i = end + 3;
      continue;
    }
    if (ch === "`" && spec.multilineBacktick) {
      const read = spec.multilineBacktick === "raw"
        ? (() => { const end = line.indexOf("`", i + 1); return end < 0 ? { end: line.length, closed: false } : { end: end + 1, closed: true }; })()
        : readQuoted(line, i, "`");
      out.push(line.slice(i, read.end), "string");
      if (!read.closed) { next.block = spec.multilineBacktick; break; }
      i = read.end;
      continue;
    }
    if (lang === "rust" && ch === "'") {
      const char = /^'(?:\\.[^']*|[^\\'])'/.exec(rest);
      if (char) { out.push(char[0], "string"); i += char[0].length; continue; }
      const lifetime = /^'[A-Za-z_]\w*/.exec(rest);
      if (lifetime) { out.push(lifetime[0], "type"); i += lifetime[0].length; continue; }
    }
    if (spec.quotes.includes(ch)) {
      const read = readQuoted(line, i, ch);
      const text = line.slice(i, read.end);
      i = read.end;
      out.push(text, spec.stringKeys && /^\s*:/.test(line.slice(i)) ? "property" : "string");
      continue;
    }
    if (lang === "rust" && (rest.startsWith("#[") || rest.startsWith("#!["))) {
      const end = line.indexOf("]", i);
      const stop = end < 0 ? line.length : end + 1;
      out.push(line.slice(i, stop), "meta");
      i = stop;
      continue;
    }
    if (spec.decorators && ch === "@" && /^@[A-Za-z_][\w.]*/.test(rest)) {
      const name = /^@[A-Za-z_][\w.]*/.exec(rest)![0];
      out.push(name, "function");
      i += name.length;
      continue;
    }
    if (lang === "css") {
      if (ch === "@") {
        const rule = /^@[\w-]+/.exec(rest);
        if (rule) { out.push(rule[0], "keyword"); i += rule[0].length; continue; }
      }
      if (ch === "#") {
        const hex = /^#[\da-fA-F]{3,8}\b/.exec(rest);
        if (hex && cssValue) { out.push(hex[0], "number"); i += hex[0].length; continue; }
        const id = /^#[\w-]+/.exec(rest);
        if (id) { out.push(id[0], "type"); i += id[0].length; continue; }
      }
      if (ch === "." && !cssValue && /^\.[A-Za-z_-][\w-]*/.test(rest)) {
        const cls = /^\.[A-Za-z_-][\w-]*/.exec(rest)![0];
        out.push(cls, "type");
        i += cls.length;
        continue;
      }
      if (ch === "!" && rest.startsWith("!important")) { out.push("!important", "keyword"); i += 10; continue; }
    }
    if (spec.jsx && ch === "<") {
      const tag = /^<\/?([A-Za-z][\w.:-]*)/.exec(rest);
      const before = previousSignificant(out);
      const opensMarkup = tag && (before === "" || /(?:[(,=:?{}>[]|&&|\|\||return|=>)$/.test(before));
      if (tag && opensMarkup) {
        const open = rest.startsWith("</") ? "</" : "<";
        out.push(open, "punct");
        out.push(tag[1], /^[A-Z]/.test(tag[1]) ? "type" : "tag");
        i += open.length + tag[1].length;
        next.tag = true;
        continue;
      }
      if (rest.startsWith("<>") || rest.startsWith("</>")) {
        const frag = rest.startsWith("<>") ? "<>" : "</>";
        out.push(frag, "punct");
        i += frag.length;
        continue;
      }
    }
    const previous = i > 0 ? line[i - 1] : "";
    if (/[\d.]/.test(ch) && !/[\w$]/.test(previous)) {
      const number = NUMBER.exec(rest);
      if (number && /\d/.test(number[0])) {
        out.push(number[0], "number");
        i += number[0].length;
        continue;
      }
    }
    const ident = identAt(line, i, Boolean(spec.identDash));
    if (ident) {
      const after = line.slice(i + ident.length);
      let kind: SyntaxKind | undefined;
      if (lang === "css") {
        if (ident.startsWith("--")) kind = "property";
        else if (/^\s*\(/.test(after)) kind = "function";
        else if (cssValue && /^\s*:/.test(after) && !line.slice(0, i).includes(":")) kind = "property";
        else if (spec.keywords.has(ident)) kind = "keyword";
        else if (!cssValue && !line.slice(0, i).trim()) kind = "tag";
      } else if (spec.keywords.has(ident)) kind = "keyword";
      else if (spec.constants.has(ident)) kind = "constant";
      else if (spec.macros && after.startsWith("!")) kind = "function";
      else if (/^\s*\(/.test(after) || (lang === "js" || lang === "jsx") && /^<[\w\s,[\]|.]*>\(/.test(after)) kind = "function";
      else if (spec.capitalTypes && /^[A-Z]/.test(ident) && /[a-z]/.test(ident)) kind = "type";
      out.push(spec.macros && kind === "function" && after.startsWith("!") ? `${ident}!` : ident, kind);
      i += ident.length + (spec.macros && kind === "function" && after.startsWith("!") ? 1 : 0);
      continue;
    }
    const operator = OPERATOR.exec(rest);
    if (operator) { out.push(operator[0], "operator"); i += operator[0].length; continue; }
    if (PUNCT.test(ch)) { out.push(ch, "punct"); i += 1; continue; }
    out.push(ch);
    i += 1;
  }
  return { tokens: out.tokens, state: next };
}

/** HTML, XML and SVG: tags, attributes, comments and entities. */
function tokenizeMarkup(line: string, state: SyntaxState): { tokens: SyntaxToken[]; state: SyntaxState } {
  const out = new Out();
  const next: SyntaxState = { ...state };
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    if (next.block === "html-comment") {
      const end = line.indexOf("-->", i);
      if (end < 0) { out.push(rest, "comment"); break; }
      out.push(line.slice(i, end + 3), "comment");
      i = end + 3;
      next.block = undefined;
      continue;
    }
    if (next.tag) {
      const ch = line[i];
      if (rest.startsWith("/>") || rest.startsWith("?>") || ch === ">") {
        const text = ch === ">" ? ">" : rest.slice(0, 2);
        out.push(text, "punct");
        i += text.length;
        next.tag = false;
        continue;
      }
      if (/\s/.test(ch)) { out.push(ch); i += 1; continue; }
      if (ch === "\"" || ch === "'") { const read = readQuoted(line, i, ch); out.push(line.slice(i, read.end), "string"); i = read.end; continue; }
      if (ch === "=") { out.push(ch, "operator"); i += 1; continue; }
      const attr = /^[^\s=>/"']+/.exec(rest);
      if (attr) { out.push(attr[0], "attr"); i += attr[0].length; continue; }
      out.push(ch);
      i += 1;
      continue;
    }
    if (rest.startsWith("<!--")) { next.block = "html-comment"; out.push("<!--", "comment"); i += 4; continue; }
    const tag = /^<[/!?]?([A-Za-z][\w.:-]*)/.exec(rest);
    if (tag) {
      const open = tag[0].slice(0, tag[0].length - tag[1].length);
      out.push(open, "punct");
      out.push(tag[1], "tag");
      i += tag[0].length;
      next.tag = true;
      continue;
    }
    const entity = /^&(?:#\d+|#x[\da-fA-F]+|[A-Za-z]+);/.exec(rest);
    if (entity) { out.push(entity[0], "constant"); i += entity[0].length; continue; }
    const text = /^[^<&]+/.exec(rest);
    if (text) { out.push(text[0]); i += text[0].length; continue; }
    out.push(line[i]);
    i += 1;
  }
  return { tokens: out.tokens, state: next };
}

/** Inline Markdown: code spans and link targets. */
function markdownInline(text: string, out: Out) {
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const code = /^(`+)(.+?)\1/.exec(rest);
    if (code) { out.push(code[0], "string"); i += code[0].length; continue; }
    const link = /^\[([^\]]*)\]\(([^)\s]*)\)/.exec(rest);
    if (link) {
      out.push("[", "punct");
      out.push(link[1]);
      out.push("](", "punct");
      out.push(link[2], "string");
      out.push(")", "punct");
      i += link[0].length;
      continue;
    }
    const emphasis = /^(\*\*|__)(?=\S)(.+?)\1/.exec(rest);
    if (emphasis) { out.push(emphasis[0], "keyword"); i += emphasis[0].length; continue; }
    const plain = /^[^`[*_]+/.exec(rest);
    const take = plain ? plain[0] : text[i];
    out.push(take);
    i += take.length;
  }
}

function tokenizeMarkdown(line: string, state: SyntaxState): { tokens: SyntaxToken[]; state: SyntaxState } {
  const out = new Out();
  const fence = /^\s*(`{3,}|~{3,})/.test(line);
  if (state.block === "fence") {
    out.push(line, fence ? "meta" : "string");
    return { tokens: out.tokens, state: fence ? {} : state };
  }
  if (fence) { out.push(line, "meta"); return { tokens: out.tokens, state: { block: "fence" } }; }
  const heading = /^\s{0,3}#{1,6}(?:\s|$)/.exec(line);
  if (heading) { out.push(line, "heading"); return { tokens: out.tokens, state }; }
  const quote = /^\s*>/.exec(line);
  if (quote) { out.push(line, "comment"); return { tokens: out.tokens, state }; }
  const marker = /^(\s*)([-*+]|\d+[.)])(\s+)/.exec(line);
  if (marker) {
    out.push(marker[1]);
    out.push(marker[2], "punct");
    out.push(marker[3]);
    markdownInline(line.slice(marker[0].length), out);
  } else if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
    out.push(line, "punct");
  } else {
    markdownInline(line, out);
  }
  return { tokens: out.tokens, state };
}

/** Shell, Dockerfiles, Makefiles and .env: comments, strings, variables, commands. */
function tokenizeShell(line: string, state: SyntaxState): { tokens: SyntaxToken[]; state: SyntaxState } {
  const out = new Out();
  let commandPosition = true;
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    const ch = line[i];
    if (/\s/.test(ch)) { const space = /^\s+/.exec(rest)![0]; out.push(space); i += space.length; continue; }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) { out.push(rest, "comment"); break; }
    if (ch === "\"" || ch === "'") {
      const read = readQuoted(line, i, ch);
      out.push(line.slice(i, read.end), "string");
      i = read.end;
      commandPosition = false;
      continue;
    }
    if (ch === "$") {
      const variable = /^\$(?:\{[^}]*\}|\(|[A-Za-z_]\w*|[@*#?$!\d-])/.exec(rest);
      if (variable) { out.push(variable[0], "property"); i += variable[0].length; commandPosition = variable[0] === "$("; continue; }
    }
    if (/^(?:&&|\|\||[|;&()])/.test(rest)) {
      const op = /^(?:&&|\|\||[|;&()])/.exec(rest)![0];
      out.push(op, "operator");
      i += op.length;
      commandPosition = true;
      continue;
    }
    if (/^[<>]+/.test(rest)) { const op = /^[<>]+&?\d?/.exec(rest)![0]; out.push(op, "operator"); i += op.length; continue; }
    const word = /^[^\s"'$|;&()<>#=]+/.exec(rest);
    if (word) {
      const text = word[0];
      const assignment = line[i + text.length] === "=";
      let kind: SyntaxKind | undefined;
      if (assignment && /^[A-Za-z_]\w*$/.test(text)) kind = "property";
      else if (SH_KEYWORDS.has(text)) kind = "keyword";
      else if (SH_CONSTANTS.has(text)) kind = "constant";
      else if (/^-{1,2}[\w-]/.test(text)) kind = "attr";
      else if (/^\d+(?:\.\d+)?$/.test(text)) kind = "number";
      else if (commandPosition && /^[\w./~-]+$/.test(text)) kind = "function";
      out.push(text, kind);
      i += text.length;
      if (!SH_KEYWORDS.has(text)) commandPosition = false;
      continue;
    }
    if (ch === "=") { out.push(ch, "operator"); i += 1; continue; }
    out.push(ch);
    i += 1;
  }
  return { tokens: out.tokens, state };
}

/** A scalar value in YAML or TOML. */
function scalar(text: string, out: Out, constants: Set<string>) {
  const trimmed = text.trim();
  const lead = text.slice(0, text.length - text.trimStart().length);
  const trail = text.slice(text.trimEnd().length);
  if (!trimmed) { out.push(text); return; }
  out.push(lead);
  if (constants.has(trimmed)) out.push(trimmed, "constant");
  else if (/^[-+]?(?:\d[\d_]*(?:\.\d+)?(?:[eE][-+]?\d+)?|0x[\da-fA-F]+|\.inf|\.nan)$/.test(trimmed)) out.push(trimmed, "number");
  else if (/^(["']).*\1$/.test(trimmed)) out.push(trimmed, "string");
  else if (/^[&*][\w-]+$/.test(trimmed)) out.push(trimmed, "type");
  else if (/^[[{]/.test(trimmed)) tokenizeInlineCollection(trimmed, out, constants);
  else out.push(trimmed, "string");
  out.push(trail);
}

function tokenizeInlineCollection(text: string, out: Out, constants: Set<string>) {
  for (const part of text.split(/([[\]{},:])/)) {
    if (!part) continue;
    if (/^[[\]{},:]$/.test(part)) out.push(part, "punct");
    else scalar(part, out, constants);
  }
}

/** Splits `value  # comment` at a comment that is not inside quotes. */
function splitComment(text: string): [string, string] {
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) { if (ch === "\\") i += 1; else if (ch === quote) quote = ""; continue; }
    if (ch === "\"" || ch === "'") quote = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) return [text.slice(0, i), text.slice(i)];
  }
  return [text, ""];
}

function tokenizeYaml(line: string): SyntaxToken[] {
  const out = new Out();
  if (/^\s*#/.test(line)) { out.push(line, "comment"); return out.tokens; }
  if (/^(?:---|\.\.\.)\s*$/.test(line)) { out.push(line, "meta"); return out.tokens; }
  const [body, comment] = splitComment(line);
  const match = /^(\s*)(-\s+)?((?:"[^"]*"|'[^']*'|[^\s:#][^:#]*?))(\s*:)(?=\s|$)(.*)$/.exec(body);
  if (match) {
    out.push(match[1]);
    if (match[2]) out.push(match[2], "punct");
    out.push(match[3], "property");
    out.push(match[4], "punct");
    scalar(match[5], out, YAML_CONSTANTS);
  } else {
    const item = /^(\s*)(-\s+)(.*)$/.exec(body);
    if (item) { out.push(item[1]); out.push(item[2], "punct"); scalar(item[3], out, YAML_CONSTANTS); }
    else scalar(body, out, YAML_CONSTANTS);
  }
  out.push(comment, "comment");
  return out.tokens;
}

function tokenizeToml(line: string, state: SyntaxState): { tokens: SyntaxToken[]; state: SyntaxState } {
  const out = new Out();
  if (state.block === "triple-double" || state.block === "triple-single") {
    const quote = state.block === "triple-double" ? "\"\"\"" : "'''";
    const end = line.indexOf(quote);
    if (end < 0) return { tokens: [{ text: line, kind: "string" }], state };
    out.push(line.slice(0, end + 3), "string");
    const rest = tokenizeToml(line.slice(end + 3), {});
    rest.tokens.forEach((token) => out.push(token.text, token.kind));
    return { tokens: out.tokens, state: rest.state };
  }
  if (/^\s*#/.test(line)) { out.push(line, "comment"); return { tokens: out.tokens, state }; }
  const section = /^(\s*)(\[\[?[^\]]+\]\]?)(.*)$/.exec(line);
  if (section) {
    out.push(section[1]);
    out.push(section[2], "type");
    out.push(section[3], /\S/.test(section[3]) ? "comment" : undefined);
    return { tokens: out.tokens, state };
  }
  const [body, comment] = splitComment(line);
  const pair = /^(\s*)([\w."'-]+)(\s*=\s*)(.*)$/.exec(body);
  let next = state;
  if (pair) {
    out.push(pair[1]);
    out.push(pair[2], "property");
    out.push(pair[3], "operator");
    const value = pair[4];
    const triple = /^\s*("""|''')/.exec(value);
    if (triple && value.indexOf(triple[1], value.indexOf(triple[1]) + 3) < 0) {
      out.push(value, "string");
      next = { block: triple[1] === "\"\"\"" ? "triple-double" : "triple-single" };
    } else scalar(value, out, words("true false"));
  } else scalar(body, out, words("true false"));
  out.push(comment, "comment");
  return { tokens: out.tokens, state: next };
}

/**
 * Tokenize one line. `state` is what the previous line left open; the returned
 * state is what this line leaves open for the next.
 */
export function tokenizeLine(line: string, language: SyntaxLanguage | null, state: SyntaxState = {}): { tokens: SyntaxToken[]; state: SyntaxState } {
  if (!language || line.length > MAX_HIGHLIGHT_LINE) return { tokens: line ? [{ text: line }] : [], state };
  switch (language) {
    case "html": return tokenizeMarkup(line, state);
    case "markdown": return tokenizeMarkdown(line, state);
    case "shell": return tokenizeShell(line, state);
    case "yaml": return { tokens: tokenizeYaml(line), state };
    case "toml": return tokenizeToml(line, state);
    case "diff": {
      const kind: SyntaxKind | undefined = line.startsWith("@@") ? "meta"
        : line.startsWith("+") && !line.startsWith("+++") ? "inserted"
          : line.startsWith("-") && !line.startsWith("---") ? "deleted"
            : /^(?:diff |index |\+\+\+|---)/.test(line) ? "meta" : undefined;
      return { tokens: line ? [kind ? { text: line, kind } : { text: line }] : [], state };
    }
    default: {
      const spec = SPECS[language];
      return spec ? tokenizeCode(line, spec, state, language) : { tokens: line ? [{ text: line }] : [], state };
    }
  }
}

/** Tokenize consecutive lines of one file or code block. */
export function highlightLines(lines: string[], language: SyntaxLanguage | null): SyntaxToken[][] {
  let state: SyntaxState = {};
  return lines.map((line) => {
    const result = tokenizeLine(line, language, state);
    state = result.state;
    return result.tokens;
  });
}

const sameState = (a: SyntaxState, b: SyntaxState) => a.block === b.block && Boolean(a.tag) === Boolean(b.tag);

/**
 * Tokenize the code of unified-diff lines (without their +/-/space marker).
 * Removed and added lines are read as two separate files, so a comment opened
 * on one side never colours the other; a hunk header resets both.
 * Returns `null` for lines that are not code (file headers, hunk headers,
 * "\ No newline at end of file").
 */
export function highlightDiffLines(lines: string[], language: SyntaxLanguage | null, firstCodeLine = 0): Array<SyntaxToken[] | null> {
  let before: SyntaxState = {};
  let after: SyntaxState = {};
  let inHunk = false;
  return lines.map((line, index) => {
    if (index < firstCodeLine) return null;
    if (line.startsWith("@@")) { before = {}; after = {}; inHunk = true; return null; }
    if (!inHunk || line.startsWith("\\")) return null;
    const marker = line[0];
    const code = line.slice(1);
    if (marker === "+") {
      const result = tokenizeLine(code, language, after);
      after = result.state;
      return result.tokens;
    }
    if (marker === "-") {
      const result = tokenizeLine(code, language, before);
      before = result.state;
      return result.tokens;
    }
    const result = tokenizeLine(code, language, after);
    before = sameState(before, after) ? result.state : tokenizeLine(code, language, before).state;
    after = result.state;
    return result.tokens;
  });
}
