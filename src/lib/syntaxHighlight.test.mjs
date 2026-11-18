import test from "node:test";
import assert from "node:assert/strict";
import { highlightDiffLines, highlightLines, languageForFence, languageForPath, tokenizeLine, MAX_HIGHLIGHT_LINE } from "./syntaxHighlight.ts";

const kinds = (tokens) => tokens.filter((token) => token.kind).map((token) => [token.kind, token.text]);
const text = (tokens) => tokens.map((token) => token.text).join("");

test("languages come from extensions, well-known names and fence names", () => {
  assert.equal(languageForPath("src/components/DiffView.tsx"), "jsx");
  assert.equal(languageForPath("src/lib/a.ts"), "js");
  assert.equal(languageForPath("C:\\repo\\main.rs"), "rust");
  assert.equal(languageForPath("deploy/Dockerfile"), "shell");
  assert.equal(languageForPath(".env.local"), "shell");
  assert.equal(languageForPath("README"), null);
  assert.equal(languageForPath("image.png"), null);
  assert.equal(languageForFence("TypeScript"), "js");
  assert.equal(languageForFence("console"), "shell");
  assert.equal(languageForFence("brainfuck"), null);
});

test("tokens always reproduce the line exactly", () => {
  const samples = [
    ["js", "const total = items.reduce((sum, item) => sum + item.price * 1.08, 0); // tax"],
    ["jsx", "  return <Button variant=\"primary\" onClick={() => go(1)}>Save</Button>;"],
    ["python", "def area(r: float) -> float: return 3.14 * r ** 2  # \"π\""],
    ["rust", "let s: &'static str = \"x\"; println!(\"{}\", 'c');"],
    ["css", ".diff-row { color: #fff; margin: 0 2px !important; }"],
    ["shell", "FOO=bar npm run build -- --watch && echo \"$HOME\" # done"],
    ["yaml", "- name: \"build\" # step"],
    ["toml", "[package]"],
    ["markdown", "## Heading with `code`"],
    ["html", "<a href=\"/x\" class='y'>link &amp; text</a>"],
    ["json", "{\"key\": [1, true, null]}"],
    ["go", "func main() { fmt.Println(`raw`) }"],
  ];
  for (const [language, line] of samples) {
    const { tokens } = tokenizeLine(line, language);
    assert.equal(text(tokens), line, language);
  }
});

test("JavaScript: keywords, strings, numbers, calls, types and comments", () => {
  const { tokens } = tokenizeLine("export const value: Total = compute('a', 42); // note", "js");
  const found = kinds(tokens);
  assert.deepEqual(found.find(([kind]) => kind === "keyword"), ["keyword", "export"]);
  assert.ok(found.some(([kind, value]) => kind === "type" && value === "Total"));
  assert.ok(found.some(([kind, value]) => kind === "function" && value === "compute"));
  assert.ok(found.some(([kind, value]) => kind === "string" && value === "'a'"));
  assert.ok(found.some(([kind, value]) => kind === "number" && value === "42"));
  assert.deepEqual(found.at(-1), ["comment", "// note"]);
});

test("JSX tags and attributes are recognised but generics are not tags", () => {
  const jsx = kinds(tokenizeLine("return <div className=\"x\">", "jsx").tokens);
  assert.ok(jsx.some(([kind, value]) => kind === "tag" && value === "div"));
  assert.ok(jsx.some(([kind, value]) => kind === "attr" && value === "className"));
  const generic = kinds(tokenizeLine("const list = useState<string>(\"\");", "jsx").tokens);
  assert.ok(!generic.some(([kind]) => kind === "tag"));
  assert.ok(generic.some(([kind, value]) => kind === "function" && value === "useState"));
});

test("block comments and template strings carry across lines", () => {
  const lines = highlightLines(["const a = 1; /* start", "still comment", "end */ const b = `x", "y`;"], "js");
  assert.deepEqual(lines[1], [{ text: "still comment", kind: "comment" }]);
  assert.equal(lines[2][0].kind, "comment");
  assert.ok(lines[2].some((token) => token.kind === "keyword" && token.text === "const"));
  assert.equal(lines[3][0].kind, "string");
  assert.equal(lines[3][0].text, "y`");
});

test("Python triple-quoted strings span lines", () => {
  const lines = highlightLines(["doc = \"\"\"First", "second", "end\"\"\" + x"], "python");
  assert.equal(lines[1][0].kind, "string");
  assert.equal(lines[2][0].text, "end\"\"\"");
});

test("JSON keys are properties and values are strings", () => {
  const found = kinds(tokenizeLine("  \"name\": \"mythra\",", "json").tokens);
  assert.deepEqual(found[0], ["property", "\"name\""]);
  assert.ok(found.some(([kind, value]) => kind === "string" && value === "\"mythra\""));
});

test("YAML keys, constants and comments", () => {
  const found = kinds(tokenizeLine("enabled: true # on", "yaml").tokens);
  assert.deepEqual(found[0], ["property", "enabled"]);
  assert.ok(found.some(([kind, value]) => kind === "constant" && value === "true"));
  assert.deepEqual(found.at(-1), ["comment", "# on"]);
});

test("shell: the command, its flags, variables and strings", () => {
  const found = kinds(tokenizeLine("npm run test -- --watch \"$DIR\"", "shell").tokens);
  assert.deepEqual(found[0], ["function", "npm"]);
  assert.ok(found.some(([kind, value]) => kind === "attr" && value === "--watch"));
  assert.ok(found.some(([kind]) => kind === "string"));
});

test("diff sides are tokenized separately so a removed comment does not colour added code", () => {
  const lines = ["@@ -1,2 +1,2 @@", "-/* old comment", "+const x = 1;", " end */"];
  const result = highlightDiffLines(lines, "js");
  assert.equal(result[0], null);
  assert.equal(result[1][0].kind, "comment");
  assert.ok(result[2].some((token) => token.kind === "keyword" && token.text === "const"));
});

test("lines before the first hunk and very long lines are left alone", () => {
  const result = highlightDiffLines(["diff --git a/x.js b/x.js", "@@ -1 +1 @@", "+let a"], "js", 0);
  assert.equal(result[0], null);
  const long = "x".repeat(MAX_HIGHLIGHT_LINE + 1);
  assert.deepEqual(tokenizeLine(long, "js").tokens, [{ text: long }]);
  assert.deepEqual(tokenizeLine("plain", null).tokens, [{ text: "plain" }]);
});
