import test from "node:test";
import assert from "node:assert/strict";
import { openRouterVendor } from "./openRouterCatalog.ts";

test("known vendors get proper names and monograms", () => {
  assert.deepEqual(openRouterVendor("x-ai/grok-5"), { name: "xAI", mark: "xA" });
  assert.deepEqual(openRouterVendor("google/gemini-3-pro"), { name: "Google", mark: "G" });
  assert.equal(openRouterVendor("openai/gpt-5.6").name, "OpenAI");
  assert.equal(openRouterVendor("meta-llama/llama-5").name, "Meta");
});

test("unknown vendors never produce punctuation in the monogram", () => {
  for (const id of ["some-lab/model", "a.b_c/model", "lab2/model", "-x/model", "/model"]) {
    const { mark, name } = openRouterVendor(id);
    assert.match(mark, /^[A-Za-z0-9]{1,2}$/, `${id} → ${mark}`);
    assert.ok(name.length > 0);
  }
  assert.deepEqual(openRouterVendor("some-lab/model"), { name: "Some Lab", mark: "SL" });
  assert.deepEqual(openRouterVendor("liquid/lfm"), { name: "Liquid", mark: "Li" });
});
