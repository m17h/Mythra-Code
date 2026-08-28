import { describe, expect, it } from "vitest";
import {
  collectFlipElements,
  flipKeyframes,
  planFlipMoves,
  readFlipSnapshot,
  type FlipSnapshot,
} from "./flipRoster";

function box(left: number, top: number, width = 100, height = 40) {
  return { left, top, width, height };
}

function snapshot(entries: Record<string, ReturnType<typeof box>>): FlipSnapshot {
  return new Map(Object.entries(entries));
}

describe("collectFlipElements", () => {
  it("indexes keyed children and ignores everything else", () => {
    const container = document.createElement("div");
    container.innerHTML = `<i data-flip-key="a"></i><i></i><i data-flip-key="b"></i>`;
    expect([...collectFlipElements(container).keys()]).toEqual(["a", "b"]);
    expect(collectFlipElements(null).size).toBe(0);
  });

  it("measures layout offsets, not the transformed client rect", () => {
    const element = document.createElement("div");
    element.dataset.flipKey = "a";
    for (const [property, value] of [["offsetTop", 4], ["offsetLeft", 8], ["offsetWidth", 20], ["offsetHeight", 10]] as const) {
      Object.defineProperty(element, property, { configurable: true, value });
    }
    // A transform on the element or an ancestor must not read as movement.
    element.getBoundingClientRect = () => ({ top: 99, left: 99, width: 99, height: 99 }) as DOMRect;
    const container = document.createElement("div");
    container.append(element);

    expect(readFlipSnapshot(collectFlipElements(container)).get("a")).toEqual({ top: 4, left: 8, width: 20, height: 10 });
  });
});

describe("planFlipMoves", () => {
  it("inverts a sibling that was pushed to another row", () => {
    const moves = planFlipMoves(
      snapshot({ tile: box(200, 0) }),
      snapshot({ tile: box(0, 60) }),
    );

    expect(moves).toEqual([expect.objectContaining({ key: "tile", dx: 200, dy: -60, resized: false })]);
  });

  it("flags the tile whose own box changed size", () => {
    const moves = planFlipMoves(
      snapshot({ tile: box(0, 0, 178, 44) }),
      snapshot({ tile: box(0, 0, 420, 220) }),
    );

    expect(moves).toEqual([expect.objectContaining({ key: "tile", dx: 0, dy: 0, resized: true })]);
  });

  it("ignores sub-pixel drift from fractional grid tracks", () => {
    expect(planFlipMoves(
      snapshot({ tile: box(0.2, 0.1, 100.3, 40) }),
      snapshot({ tile: box(0, 0, 100, 40) }),
    )).toEqual([]);
  });

  it("skips items that only exist in one of the two layouts", () => {
    const moves = planFlipMoves(
      snapshot({ gone: box(0, 0), stays: box(0, 60) }),
      snapshot({ stays: box(0, 0), added: box(0, 60) }),
    );

    expect(moves.map((move) => move.key)).toEqual(["stays"]);
  });
});

describe("flipKeyframes", () => {
  it("animates transform alone when only the position moved", () => {
    const [from, to] = flipKeyframes({ key: "a", dx: 12, dy: -8, from: box(0, 0), to: box(0, 0), resized: false });
    expect(from).toEqual({ transform: "translate(12px, -8px)" });
    expect(to).toEqual({ transform: "translate(0px, 0px)" });
  });

  it("scales a resized tile without animating layout-affecting dimensions", () => {
    const [from, to] = flipKeyframes({
      key: "a",
      dx: 0,
      dy: 0,
      from: box(0, 0, 178, 44),
      to: box(0, 0, 420, 220),
      resized: true,
    });
    expect(from).toEqual({
      transform: `translate(0px, 0px) scale(${178 / 420}, ${44 / 220})`,
      transformOrigin: "top left",
    });
    expect(to).toEqual({ transform: "translate(0px, 0px) scale(1, 1)", transformOrigin: "top left" });
    expect(from).not.toHaveProperty("width");
    expect(from).not.toHaveProperty("height");
  });
});
