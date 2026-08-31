import { describe, expect, it } from "vitest";
import { isPaginatedHistoryUnsupported, mergeOlderTurns, normalizeThreadTurnsPage, turnsFromDescendingPage } from "./threadHistory";

function turn(id: string) {
  return { id, items: [{ id: `${id}-user`, type: "userMessage" as const, content: [{ type: "text", text: id }] }] };
}

describe("thread history pagination", () => {
  it("converts a descending page to the renderer's chronological order without mutating it", () => {
    const page = { data: [turn("newest"), turn("middle"), turn("oldest")], nextCursor: "older", backwardsCursor: "newer" };
    expect(turnsFromDescendingPage(page).map((entry) => entry.id)).toEqual(["oldest", "middle", "newest"]);
    expect(page.data.map((entry) => entry.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("prepends older turns and removes an overlapping cursor anchor", () => {
    expect(mergeOlderTurns([turn("old"), turn("anchor")], [turn("anchor"), turn("new")]).map((entry) => entry.id))
      .toEqual(["old", "anchor", "new"]);
  });

  it("normalizes only complete pages and identifies unsupported runtimes", () => {
    expect(normalizeThreadTurnsPage({ data: [turn("ok"), { id: "missing-items" }], nextCursor: "cursor" }))
      .toMatchObject({ data: [turn("ok")], nextCursor: "cursor", backwardsCursor: null });
    expect(normalizeThreadTurnsPage({ data: "not-a-page" })).toBeNull();
    expect(isPaginatedHistoryUnsupported("unknown method: thread/turns/list")).toBe(true);
    expect(isPaginatedHistoryUnsupported("network disconnected")).toBe(false);
  });
});
