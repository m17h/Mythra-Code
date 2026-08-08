import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { clampSidebarSplitRatio, splitPercentage, useSidebarSplitResize, type SidebarSplitResizeApi } from "./useSidebarSplitResize";

let api: SidebarSplitResizeApi;
let renders = 0;

function Harness({ scale }: { scale: number }) {
  api = useSidebarSplitResize(scale);
  renders += 1;
  return (
    <div ref={api.sidebarSectionsRef} data-testid="sections">
      <div data-testid="projects" />
      <div
        data-testid="handle"
        role="separator"
        onPointerDown={api.startSidebarSplitResize}
        onKeyDown={api.resizeSidebarSplitWithKeyboard}
        aria-valuenow={Math.round(api.splitRatio * 100)}
        tabIndex={0}
      />
      <div data-testid="threads" />
    </div>
  );
}

function mount(scale = 1, box: { top: number; height: number } = { top: 100, height: 500 }) {
  renders = 0;
  const view = render(<Harness scale={scale} />);
  const sections = screen.getByTestId("sections");
  const measure = vi.fn(() => box as DOMRect);
  vi.spyOn(sections, "getBoundingClientRect").mockImplementation(measure);
  return { view, sections, measure, handle: () => screen.getByTestId("handle") };
}

const splitVar = (sections: HTMLElement) => sections.style.getPropertyValue("--sidebar-split");
const storedRatio = () => JSON.parse(localStorage.getItem("kiwi.sidebarSplitRatio") ?? "null");

describe("useSidebarSplitResize", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.removeAttribute("data-split-resizing");
  });

  it("publishes the committed ratio as a container custom property on mount", () => {
    localStorage.setItem("kiwi.sidebarSplitRatio", JSON.stringify(0.4));
    const { sections } = mount();
    expect(splitVar(sections)).toBe("40%");
  });

  it("tracks the pointer live without rendering or writing storage", () => {
    localStorage.setItem("kiwi.sidebarSplitRatio", JSON.stringify(0.4));
    const { sections, handle } = mount();
    const rendersBeforeDrag = renders;

    fireEvent.pointerDown(handle(), { clientY: 300, button: 0 });
    expect(document.body).toHaveAttribute("data-split-resizing", "true");

    for (const [clientY, expected] of [[350, "50%"], [400, "60%"], [375, "55%"]] as const) {
      fireEvent.pointerMove(window, { clientY });
      expect(splitVar(sections)).toBe(expected);
      expect(handle()).toHaveAttribute("aria-valuenow", expected.replace("%", ""));
    }

    expect(renders).toBe(rendersBeforeDrag);
    expect(api.splitRatio).toBe(0.4);
    expect(storedRatio()).toBe(0.4);
  });

  it("commits the released ratio to state and storage exactly once", () => {
    const { sections, handle } = mount();
    const setItem = vi.spyOn(localStorage, "setItem");

    fireEvent.pointerDown(handle(), { clientY: 250, button: 0 });
    fireEvent.pointerMove(window, { clientY: 400 });
    fireEvent.pointerUp(window);

    expect(api.splitRatio).toBeCloseTo(0.6);
    expect(splitVar(sections)).toBe("60%");
    expect(storedRatio()).toBeCloseTo(0.6);
    expect(setItem.mock.calls.filter(([key]) => key === "kiwi.sidebarSplitRatio")).toHaveLength(1);
    expect(document.body).not.toHaveAttribute("data-split-resizing");
  });

  it("measures the container once for the whole gesture", () => {
    const { measure, handle } = mount();

    fireEvent.pointerDown(handle(), { clientY: 250, button: 0 });
    for (const clientY of [260, 280, 300, 320, 340]) fireEvent.pointerMove(window, { clientY });
    fireEvent.pointerUp(window);

    // Reading layout after each write would force a synchronous reflow per
    // pointer event.
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it("clamps to the section minimums", () => {
    const { sections, handle } = mount();

    fireEvent.pointerDown(handle(), { clientY: 250, button: 0 });
    fireEvent.pointerMove(window, { clientY: -900 });
    expect(splitVar(sections)).toBe(splitPercentage(clampSidebarSplitRatio(0, 500)));
    fireEvent.pointerMove(window, { clientY: 9000 });
    expect(splitVar(sections)).toBe(splitPercentage(clampSidebarSplitRatio(1, 500)));
    fireEvent.pointerUp(window);

    expect(api.splitRatio).toBeCloseTo(clampSidebarSplitRatio(1, 500));
  });

  it("derives the bounds from the unscaled container height", () => {
    // The section minimums are CSS pixels inside the zoomed shell, so a 500px
    // client box is only 333px of layout at 150% and the projects list bottoms
    // out sooner.
    const { sections, handle } = mount(1.5);

    fireEvent.pointerDown(handle(), { clientY: 250, button: 0 });
    fireEvent.pointerMove(window, { clientY: 150 });

    expect(splitVar(sections)).toBe(splitPercentage(clampSidebarSplitRatio(0.1, 500 / 1.5)));
    expect(clampSidebarSplitRatio(0.1, 500 / 1.5)).toBeGreaterThan(clampSidebarSplitRatio(0.1, 500));
  });

  it("leaves the ratio untouched when the separator is pressed without moving", () => {
    localStorage.setItem("kiwi.sidebarSplitRatio", JSON.stringify(0.42));
    const { sections, handle } = mount();
    const setItem = vi.spyOn(localStorage, "setItem");

    // The separator has height, so a press alone must not be read as a
    // position.
    fireEvent.pointerDown(handle(), { clientY: 260, button: 0 });
    fireEvent.pointerUp(window);

    expect(api.splitRatio).toBeCloseTo(0.42);
    expect(splitVar(sections)).toBe("42%");
    expect(setItem.mock.calls.filter(([key]) => key === "kiwi.sidebarSplitRatio")).toHaveLength(0);
  });

  it("reverts on cancel and on Escape", () => {
    localStorage.setItem("kiwi.sidebarSplitRatio", JSON.stringify(0.4));
    const { sections, handle } = mount();

    fireEvent.pointerDown(handle(), { clientY: 250, button: 0 });
    fireEvent.pointerMove(window, { clientY: 400 });
    fireEvent.pointerCancel(window);
    expect(splitVar(sections)).toBe("40%");
    expect(api.splitRatio).toBe(0.4);
    // Fully detached: a later move cannot move the divider.
    fireEvent.pointerMove(window, { clientY: 450 });
    expect(splitVar(sections)).toBe("40%");

    fireEvent.pointerDown(handle(), { clientY: 250, button: 0 });
    fireEvent.pointerMove(window, { clientY: 400 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(splitVar(sections)).toBe("40%");
    fireEvent.pointerUp(window);
    expect(api.splitRatio).toBe(0.4);
    expect(storedRatio()).toBe(0.4);
    expect(document.body).not.toHaveAttribute("data-split-resizing");
  });

  it("ignores non-primary buttons", () => {
    const { handle } = mount();

    fireEvent.pointerDown(handle(), { clientY: 250, button: 2 });
    fireEvent.pointerMove(window, { clientY: 400 });

    expect(document.body).not.toHaveAttribute("data-split-resizing");
    expect(api.splitRatio).toBe(0.3);
  });

  it("lets a new gesture supersede one that never ended", () => {
    const { sections, handle } = mount();

    fireEvent.pointerDown(handle(), { clientY: 250, button: 0 });
    fireEvent.pointerMove(window, { clientY: 350 });
    fireEvent.pointerDown(handle(), { clientY: 350, button: 0 });
    expect(splitVar(sections)).toBe("30%");
    fireEvent.pointerMove(window, { clientY: 400 });
    fireEvent.pointerUp(window);

    expect(splitVar(sections)).toBe("60%");
    expect(api.splitRatio).toBeCloseTo(0.6);
    expect(storedRatio()).toBeCloseTo(0.6);
  });

  it("detaches an in-flight drag when the component unmounts", () => {
    const { view, sections, handle } = mount();

    fireEvent.pointerDown(handle(), { clientY: 250, button: 0 });
    fireEvent.pointerMove(window, { clientY: 400 });
    act(() => view.unmount());

    expect(document.body).not.toHaveAttribute("data-split-resizing");
    fireEvent.pointerMove(window, { clientY: 200 });
    fireEvent.pointerUp(window);
    expect(splitVar(sections)).toBe("30%");
    expect(storedRatio()).toBeNull();
  });

  it("supports keyboard resizing", () => {
    const { sections, handle } = mount();
    const preventDefault = vi.fn();

    fireEvent.keyDown(handle(), { key: "ArrowDown" });
    expect(api.splitRatio).toBeCloseTo(0.335);
    expect(splitVar(sections)).toBe("33.5%");
    expect(storedRatio()).toBeCloseTo(0.335);

    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(api.splitRatio).toBeCloseTo(0.3);
    fireEvent.keyDown(handle(), { key: "Home" });
    expect(api.splitRatio).toBeCloseTo(clampSidebarSplitRatio(0, 500));
    fireEvent.keyDown(handle(), { key: "End" });
    expect(api.splitRatio).toBeCloseTo(clampSidebarSplitRatio(1, 500));

    act(() => {
      api.resizeSidebarSplitWithKeyboard({ key: "ArrowUp", preventDefault } as never);
    });
    expect(preventDefault).toHaveBeenCalled();
  });

  it("stands down on the keyboard while a drag is in flight", () => {
    const { sections, handle } = mount();

    fireEvent.pointerDown(handle(), { clientY: 250, button: 0 });
    fireEvent.pointerMove(window, { clientY: 400 });
    fireEvent.keyDown(handle(), { key: "Home" });
    expect(splitVar(sections)).toBe("60%");
    expect(api.splitRatio).toBe(0.3);

    fireEvent.pointerUp(window);
    expect(api.splitRatio).toBeCloseTo(0.6);
    fireEvent.keyDown(handle(), { key: "Home" });
    expect(api.splitRatio).toBeCloseTo(clampSidebarSplitRatio(0, 500));
  });

  it("leaves unrelated keys alone", () => {
    const { handle } = mount();

    fireEvent.keyDown(handle(), { key: "Tab" });
    expect(api.splitRatio).toBe(0.3);
  });
});
