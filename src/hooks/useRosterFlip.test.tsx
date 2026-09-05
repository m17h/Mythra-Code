import { useCallback, useLayoutEffect, useRef } from "react";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRosterFlip } from "./useRosterFlip";

interface FakeAnimation {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  element: HTMLElement;
  cancel: () => void;
  onfinish: (() => void) | null;
  oncancel: (() => void) | null;
}

const animations: FakeAnimation[] = [];

/**
 * Stands in for a layout engine: one column, so changing one item's height
 * moves every item below it. jsdom reports every offset as zero.
 */
function layout(container: HTMLElement, heights: Record<string, number>) {
  let top = 0;
  for (const element of container.querySelectorAll<HTMLElement>("[data-flip-key]")) {
    const key = element.dataset.flipKey ?? "";
    const height = heights[key] ?? 40;
    for (const [property, value] of [["offsetTop", top], ["offsetLeft", 0], ["offsetWidth", 200], ["offsetHeight", height]] as const) {
      Object.defineProperty(element, property, { configurable: true, value });
    }
    top += height;
  }
}

function stubAnimate() {
  Element.prototype.animate = function stub(this: HTMLElement, keyframes, options) {
    const animation: FakeAnimation = {
      element: this,
      keyframes: keyframes as Keyframe[],
      options: options as KeyframeAnimationOptions,
      cancel: vi.fn(function cancel(this: void) { animation.oncancel?.(); }),
      onfinish: null,
      oncancel: null,
    };
    animations.push(animation);
    return animation as unknown as Animation;
  } as typeof Element.prototype.animate;
}

function Roster({ heights }: { heights: Record<string, number> }) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Registered before the hook's own layout effect, so the stand-in geometry
  // lands the way a browser's does: after render, before anything measures the
  // result. The hook reads the *previous* layout during render.
  useLayoutEffect(() => { if (ref.current) layout(ref.current, heights); });
  const flip = useRosterFlip(JSON.stringify(heights));
  const attach = useCallback((node: HTMLDivElement | null) => {
    ref.current = node;
    flip.gridRef(node);
  }, [flip]);
  return (
    <div ref={attach} data-testid="grid">
      <i data-flip-key="one" />
      <i data-flip-key="two" />
    </div>
  );
}

afterEach(() => {
  animations.length = 0;
  Reflect.deleteProperty(window, "matchMedia");
  // @ts-expect-error — restore the host's own (absent) implementation.
  delete Element.prototype.animate;
});

describe("useRosterFlip", () => {
  it("does not animate the first layout it ever sees", () => {
    stubAnimate();
    render(<Roster heights={{ one: 40, two: 40 }} />);
    expect(animations).toHaveLength(0);
  });

  it("animates a sibling pushed down by a tile that grew", () => {
    stubAnimate();
    const { rerender } = render(<Roster heights={{ one: 40, two: 40 }} />);
    rerender(<Roster heights={{ one: 200, two: 40 }} />);

    // The tile that grew scales its committed box; the one below only travels.
    const grew = animations.find((entry) => entry.element.dataset.flipKey === "one");
    const pushed = animations.find((entry) => entry.element.dataset.flipKey === "two");
    expect(grew?.keyframes[0]).toMatchObject({ transform: "translate(0px, 0px) scale(1, 0.2)" });
    expect(grew?.keyframes[0]).not.toHaveProperty("height");
    expect(grew?.keyframes[1]).toMatchObject({ transform: "translate(0px, 0px) scale(1, 1)" });
    expect(pushed?.keyframes).toEqual([
      { transform: "translate(0px, -160px)" },
      { transform: "translate(0px, 0px)" },
    ]);
  });

  it("animates the collapse as the exact reverse of the expansion", () => {
    stubAnimate();
    const { rerender } = render(<Roster heights={{ one: 40, two: 40 }} />);
    rerender(<Roster heights={{ one: 200, two: 40 }} />);
    animations.length = 0;
    rerender(<Roster heights={{ one: 40, two: 40 }} />);

    const pushed = animations.find((entry) => entry.element.dataset.flipKey === "two");
    expect(pushed?.keyframes[0]).toEqual({ transform: "translate(0px, 160px)" });
  });

  it("clips only the resizing tile, and releases it when the animation ends", () => {
    stubAnimate();
    const { rerender, getByTestId } = render(<Roster heights={{ one: 40, two: 40 }} />);
    rerender(<Roster heights={{ one: 200, two: 40 }} />);

    const grid = getByTestId("grid");
    const grew = grid.querySelector<HTMLElement>('[data-flip-key="one"]')!;
    const pushed = grid.querySelector<HTMLElement>('[data-flip-key="two"]')!;
    expect(grew.dataset.flipResizing).toBe("true");
    expect(pushed.dataset.flipResizing).toBeUndefined();

    animations.find((entry) => entry.element === grew)?.onfinish?.();
    expect(grew.dataset.flipResizing).toBeUndefined();
  });

  it("cancels an in-flight run before planning the next one", () => {
    stubAnimate();
    const { rerender } = render(<Roster heights={{ one: 40, two: 40 }} />);
    rerender(<Roster heights={{ one: 200, two: 40 }} />);
    const first = [...animations];
    rerender(<Roster heights={{ one: 40, two: 40 }} />);

    for (const animation of first) expect(animation.cancel).toHaveBeenCalled();
  });

  it("stays still when the user asked for reduced motion", () => {
    stubAnimate();
    // jsdom ships no matchMedia at all, which the hook already treats as
    // "no stated preference"; this test states one.
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: true }) as MediaQueryList,
    });
    const { rerender } = render(<Roster heights={{ one: 40, two: 40 }} />);
    rerender(<Roster heights={{ one: 200, two: 40 }} />);

    expect(animations).toHaveLength(0);
  });

  it("leaves the layout alone on hosts with no Web Animations API", () => {
    const { rerender } = render(<Roster heights={{ one: 40, two: 40 }} />);
    expect(() => rerender(<Roster heights={{ one: 200, two: 40 }} />)).not.toThrow();
  });
});

it("ignores late cancellation events from the animation a new resize replaced", () => {
  stubAnimate();
  const { rerender, getByTestId } = render(<Roster heights={{ one: 40, two: 40 }} />);
  rerender(<Roster heights={{ one: 200, two: 40 }} />);
  const tile = getByTestId("grid").querySelector<HTMLElement>('[data-flip-key="one"]')!;
  const old = animations.find((animation) => animation.element === tile)!;
  const lateCancel = old.oncancel;
  rerender(<Roster heights={{ one: 100, two: 40 }} />);
  lateCancel?.();
  expect(tile.dataset.flipResizing).toBe("true");
  animations.filter((animation) => animation.element === tile).at(-1)?.onfinish?.();
  expect(tile.dataset.flipResizing).toBeUndefined();
});
