import test from "node:test";
import assert from "node:assert/strict";
import { projectRelativePath } from "./TimelineProjectRoot.ts";

test("changed files read project-relative, like the Tools panel dock", () => {
  assert.equal(projectRelativePath("/Users/alex/code/atlas-web/tests/e2e/checkout.spec.ts", "/Users/alex/code/atlas-web"), "tests/e2e/checkout.spec.ts");
  assert.equal(projectRelativePath("/Users/alex/code/atlas-web/a.ts", "/Users/alex/code/atlas-web/"), "a.ts");
  assert.equal(projectRelativePath("C:\\code\\app\\src\\x.ts", "C:\\code\\app"), "src/x.ts");
  assert.equal(projectRelativePath("/Users/alex/code/atlas-webby/a.ts", "/Users/alex/code/atlas-web"), "/Users/alex/code/atlas-webby/a.ts", "a sibling folder is not inside");
  assert.equal(projectRelativePath("src/a.ts", "/Users/alex/code/atlas-web"), "src/a.ts", "already relative stays");
  assert.equal(projectRelativePath("/elsewhere/a.ts", ""), "/elsewhere/a.ts", "Chats: unchanged");
});
