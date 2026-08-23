import { describe, expect, it } from "vitest";
import type { ArchivedThread } from "../types";
import { archivedThreadsForInbox, providerForArchivedThread } from "./threadArchive";

function archived(id: string, path: string): ArchivedThread {
  return { id, label: id, path, archivedAt: 10 };
}

describe("archived thread provider resolution", () => {
  it("uses provider metadata stored with new archives", () => {
    expect(providerForArchivedThread({ provider: "claude" }, false)).toBe("claude");
    expect(providerForArchivedThread({ provider: "openrouter" }, false)).toBe("openrouter");
  });

  it("recognizes legacy Claude archives from their persisted transcript", () => {
    expect(providerForArchivedThread({}, true)).toBe("claude");
    expect(providerForArchivedThread({}, false)).toBe("openai");
  });

  it("scopes archived bulk actions to the visible workspace and inbox", () => {
    const main = archived("main", "/projects/kiwi/");
    const child = archived("child", "/projects/kiwi");
    const otherProject = archived("other", "/projects/other");
    const records = [main, child, otherProject];
    const links = { child: { rootThreadId: "main" } };

    expect(archivedThreadsForInbox(records, "/projects/kiwi", links, "main")).toEqual([main]);
    expect(archivedThreadsForInbox(records, "/projects/kiwi/", links, "subagents")).toEqual([child]);
  });
});
