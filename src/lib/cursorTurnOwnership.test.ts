import { beforeEach, describe, expect, it } from "vitest";
import { acceptCursorTurnStart as accept, beginCursorTurnStart as begin, cursorTurnOwner, finishCursorTurnOwner as finish, isCurrentCursorTurnStart, observeCursorTurnOwner as observe, rejectCursorTurnStart as reject, resetCursorTurnOwnershipForTests as reset, retireCursorTurnOwner } from "./cursorTurnOwnership";

describe("Cursor local start generations", () => {
  beforeEach(reset);

  it("retains the latest stopped identity without permitting output reactivation", () => {
    const latest = begin("thread");
    observe("thread", "stopped", latest.owner.startRequestId);
    retireCursorTurnOwner("thread", latest.owner);
    expect(accept("thread", latest, "stopped")).toBe(false);
    expect(isCurrentCursorTurnStart("thread", latest)).toBe(true);
    expect(observe("thread", "stopped", latest.owner.startRequestId).mayActivate).toBe(false);
    begin("thread");
    expect(isCurrentCursorTurnStart("thread", latest)).toBe(false);
  });

  it("remembers a superseded acknowledgment without replacing the pending successor", () => {
    const first = begin("thread");
    const second = begin("thread");
    accept("thread", first, "first");
    expect(observe("thread", "first")).toEqual({ mayActivate: false, newerOwner: true });
    reject("thread", second);
    expect(observe("thread", "first").mayActivate).toBe(true);
  });

  it("skips a failed pending predecessor when the successor also fails", () => {
    const live = begin("thread");
    accept("thread", live, "live");
    const first = begin("thread");
    const second = begin("thread");
    reject("thread", first);
    reject("thread", second);
    expect(observe("thread", "live")).toEqual({ mayActivate: true, newerOwner: false });
  });

  it("does not restore a closed predecessor through failed overlapping starts", () => {
    const live = begin("thread");
    accept("thread", live, "live");
    const first = begin("thread");
    const second = begin("thread");
    finish("thread", "live");
    reject("thread", first);
    reject("thread", second);
    expect(cursorTurnOwner("thread")).toBeUndefined();
  });

  it("pins an accepted predecessor while unrelated settled identities leave the cache", () => {
    const live = begin("thread");
    accept("thread", live, "live");
    for (let index = 0; index < 205; index += 1) {
      const other = `other-${index}`;
      const attempt = begin(other);
      accept(other, attempt, other);
      finish(other, other);
    }
    begin("thread");
    expect(observe("thread", "live")).toEqual({ mayActivate: false, newerOwner: true });
  });

  it("rejects an evicted settled identity by its request token and admits only the pending token", () => {
    const old = begin("thread");
    accept("thread", old, "old");
    finish("thread", "old");
    const next = begin("thread");
    accept("thread", next, "next");
    finish("thread", "next");
    for (let index = 0; index < 205; index += 1) {
      const id = `elsewhere-${index}`;
      const attempt = begin(id);
      accept(id, attempt, id);
      finish(id, id);
    }
    const pending = begin("thread");
    expect(observe("thread", "old", old.owner.startRequestId).mayActivate).toBe(false);
    expect(observe("thread", "unknown-legacy").mayActivate).toBe(false);
    expect(observe("thread", "new", pending.owner.startRequestId).mayActivate).toBe(true);
  });
});
