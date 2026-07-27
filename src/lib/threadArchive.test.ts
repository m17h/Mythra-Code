import { describe, expect, it } from "vitest";
import { providerForArchivedThread } from "./threadArchive";

describe("archived thread provider resolution", () => {
  it("uses provider metadata stored with new archives", () => {
    expect(providerForArchivedThread({ provider: "claude" }, false)).toBe("claude");
    expect(providerForArchivedThread({ provider: "openrouter" }, false)).toBe("openrouter");
  });

  it("recognizes legacy Claude archives from their persisted transcript", () => {
    expect(providerForArchivedThread({}, true)).toBe("claude");
    expect(providerForArchivedThread({}, false)).toBe("openai");
  });
});
