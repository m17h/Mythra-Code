#!/usr/bin/env node
// Lists raw colour literals (#hex, rgb()/rgba(), hsl()/hsla()) in stylesheets
// outside src/styles/lumen/tokens.css, the one place colours are defined.
//
//   npm run check:css            report and fail on anything not allowlisted
//   npm run check:css -- --all   also list the allowlisted literals
//
// Allowed without listing:
//   - literals inside a var() fallback, e.g. var(--red, #e5766b): the token is
//     the source of truth, the fallback only covers a missing token;
//   - alpha masks (mask / mask-image values), which are not colours.
// Everything else must be a token, or match an entry in
// scripts/css-token-allowlist.json:
//   { "file": "src/x.css", "selector": "regex", "prop": "regex", "max": 12, "reason": "..." }
// "file" is required; "selector" and "prop" narrow the entry; "max" turns the
// entry into a budget that may only shrink (the legacy cascade uses this).
// Plain Node, no dependencies.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKENS = "src/styles/lumen/tokens.css";
const showAll = process.argv.includes("--all");
const allowlist = JSON.parse(fs.readFileSync(path.join(root, "scripts/css-token-allowlist.json"), "utf8")).entries;

function cssFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...cssFiles(full));
    else if (entry.name.endsWith(".css")) out.push(full);
  }
  return out;
}

const COLOUR = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b|\b(?:rgba?|hsla?)\(/g;

/** Blank out comments and strings but keep offsets, so line numbers stay right. */
function mask(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/url\((?:"[^"]*"|'[^']*'|[^)]*)\)/g, (m) => m.replace(/[^\n]/g, " "));
}

/** Remove var(--x, fallback) fallbacks (nested parentheses aware). */
function stripVarFallbacks(value) {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (value.startsWith("var(", i)) {
      let depth = 0, j = i, comma = -1;
      for (; j < value.length; j++) {
        if (value[j] === "(") depth++;
        else if (value[j] === ")") { depth--; if (depth === 0) break; }
        else if (value[j] === "," && depth === 1 && comma < 0) comma = j;
      }
      out += comma < 0 ? value.slice(i, j + 1) : value.slice(i, comma) + ")";
      i = j;
    } else out += value[i];
  }
  return out;
}

/** Walk declarations with their enclosing selector and line. */
function* declarations(text) {
  const masked = mask(text);
  const stack = [];
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "{") { stack.push(masked.slice(start, i).trim()); start = i + 1; }
    else if (ch === ";" || ch === "}") {
      const chunk = masked.slice(start, i);
      const colon = chunk.indexOf(":");
      if (colon > 0 && stack.length) {
        const prop = chunk.slice(0, colon).trim();
        if (/^[-\w]+$/.test(prop)) {
          const offset = start + chunk.search(/\S/);
          yield { prop, value: chunk.slice(colon + 1).trim(), selector: ([...stack].reverse().find((s) => !s.startsWith("@")) ?? stack.at(-1)).replace(/\s+/g, " "), line: masked.slice(0, offset).split("\n").length };
        }
      }
      if (ch === "}") stack.pop();
      start = i + 1;
    }
  }
}

const findings = [];
for (const file of cssFiles(path.join(root, "src"))) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  if (rel === TOKENS) continue;
  for (const decl of declarations(fs.readFileSync(file, "utf8"))) {
    if (/^(-webkit-)?mask(-image)?$/.test(decl.prop)) continue;
    const literals = stripVarFallbacks(decl.value).match(COLOUR);
    if (!literals) continue;
    for (const literal of literals) findings.push({ file: rel, ...decl, literal: literal.replace(/\($/, "()") });
  }
}

const used = new Map();
const violations = [];
const allowed = [];
for (const finding of findings) {
  const entry = allowlist.find((e) => e.file === finding.file
    && (!e.selector || new RegExp(e.selector).test(finding.selector))
    && (!e.prop || new RegExp(e.prop).test(finding.prop)));
  if (!entry) { violations.push(finding); continue; }
  used.set(entry, (used.get(entry) ?? 0) + 1);
  allowed.push({ ...finding, reason: entry.reason });
}
const overBudget = allowlist.filter((e) => typeof e.max === "number" && (used.get(e) ?? 0) > e.max);

const byFile = (list) => list.reduce((map, f) => map.set(f.file, (map.get(f.file) ?? 0) + 1), new Map());
if (showAll) {
  console.log("Allowlisted literals:");
  for (const f of allowed) console.log(`  ${f.file}:${f.line}  ${f.literal}  (${f.prop})  — ${f.reason}`);
}
console.log(`Raw colour literals outside ${TOKENS}: ${findings.length} (${allowed.length} allowlisted, ${violations.length} not allowed)`);
for (const [file, count] of byFile(allowed)) console.log(`  allowed  ${String(count).padStart(4)}  ${file}`);
for (const entry of allowlist.filter((e) => typeof e.max === "number")) console.log(`  budget   ${String(used.get(entry) ?? 0).padStart(4)}/${entry.max}  ${entry.file}`);
if (violations.length) {
  console.log("\nUse a token from tokens.css (or add one) for:");
  for (const f of violations) console.log(`  ${f.file}:${f.line}  ${f.literal}  in ${f.prop}  (${f.selector.slice(0, 80)})`);
}
for (const entry of overBudget) console.log(`\n${entry.file} has ${used.get(entry)} literals, over its budget of ${entry.max}. Use tokens instead of adding literals.`);
process.exit(violations.length || overBudget.length ? 1 : 0);
