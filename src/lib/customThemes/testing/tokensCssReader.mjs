// Test helper: compute each built-in theme's custom properties straight from
// src/styles/lumen/tokens.css (source-order cascade of the shell-scope blocks
// that match a theme, with var() references resolved), so node tests use the
// real palette without a browser. Platform rules and @supports/@media blocks
// are skipped, like a mac probe without color-mix().

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKENS = path.resolve(here, "../../../styles/lumen/tokens.css");

function topLevelBlocks(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const selector = text.slice(i, open).trim();
    let depth = 1, j = open + 1;
    for (; j < text.length && depth > 0; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
    }
    blocks.push({ selector, body: text.slice(open + 1, j - 1) });
    i = j;
  }
  return blocks;
}

function matches(selectorList, theme, scheme) {
  return selectorList.split(",").map((s) => s.trim()).some((sel) => {
    if (sel === ".app-shell[data-theme][data-color-scheme]") return true;
    if (sel === `.app-shell[data-theme="${theme}"][data-color-scheme]`) return true;
    if (sel === `.app-shell[data-theme][data-color-scheme="${scheme}"]`) return true;
    return false;
  });
}

function declarations(body) {
  const out = [];
  for (const part of body.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim();
    if (name.startsWith("--")) out.push([name, part.slice(colon + 1).trim()]);
  }
  return out;
}

function resolveVars(values) {
  const out = {};
  const resolve = (name, depth = 0) => {
    if (depth > 12 || !(name in values)) return undefined;
    return values[name].replace(/var\((--[\w-]+)(?:,\s*([^()]*))?\)/g, (_, ref, fallback) => resolve(ref, depth + 1) ?? fallback ?? "");
  };
  for (const name of Object.keys(values)) out[name] = resolve(name);
  return out;
}

const LIGHT = new Set(["light-mythra", "daylight", "atari"]);

/** BaseTokenReader for setBaseTokenReader(). */
export function tokensCssReader(base) {
  const css = readFileSync(TOKENS, "utf8");
  const scheme = LIGHT.has(base) ? "light" : "dark";
  const values = {};
  for (const block of topLevelBlocks(css)) {
    if (block.selector.startsWith("@") || block.selector.startsWith("html")) continue;
    if (!matches(block.selector, base, scheme)) continue;
    for (const [name, value] of declarations(block.body)) values[name] = value;
  }
  return resolveVars(values);
}
