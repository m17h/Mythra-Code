import { describe, expect, it } from "vitest";
import { decodeHtmlEntities } from "./text";

describe("decodeHtmlEntities", () => {
  it("turns entity-escaped model labels back into plain text", () => {
    expect(decodeHtmlEntities("Story &amp; content audit")).toBe("Story & content audit");
    expect(decodeHtmlEntities("Review &#38; verify &#x26; ship")).toBe("Review & verify & ship");
  });

  it("leaves unknown or malformed entities untouched", () => {
    expect(decodeHtmlEntities("A &future; label &amp")).toBe("A &future; label &amp");
  });
});
