import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { PANE_BOUNDS, usePaneResize, type PaneKey, type PaneResizeApi } from "./usePaneResize";

let api: PaneResizeApi;
let renders = 0;

function Harness({ scale }: { scale: number }) {
  api = usePaneResize(scale);
  renders += 1;
  return (
    <div ref={api.shellRef} data-testid="shell">
      {(["sidebar", "dock"] as PaneKey[]).map((pane) => (
        <div
          key={pane}
          data-testid={`${pane}-handle`}
          role="separator"
          onPointerDown={api.startPaneResize(pane)}
          onKeyDown={api.resizePaneWithKeyboard(pane)}
          aria-valuemin={PANE_BOUNDS[pane].min}
          aria-valuemax={PANE_BOUNDS[pane].max}
          aria-valuenow={Math.round(api.paneSizes[pane])}
          tabIndex={0}
        />
      ))}
    </div>
  );
}

function mount(scale = 1) {
  renders = 0;
  const view = render(<Harness scale={scale} />);
  return {
    view,
    shell: screen.getByTestId("shell"),
    handle: (pane: PaneKey) => screen.getByTestId(`${pane}-handle`),
  };
}

const widthVar = (shell: HTMLElement, pane: PaneKey) =>
  shell.style.getPropertyValue(pane === "sidebar" ? "--sidebar-width" : "--dock-width");

const storedSizes = () => JSON.parse(localStorage.getItem("kiwi.paneSizes") ?? "null");

describe("usePaneResize", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("kiwi.paneSizes", JSON.stringify({ sidebar: 300, dock: 500 }));
    document.body.removeAttribute("data-pane-resizing");
  });

  it("publishes the committed sizes as shell custom properties on mount", () => {
    const { shell } = mount();
    expect(widthVar(shell, "sidebar")).toBe("300px");
    expect(widthVar(shell, "dock")).toBe("500px");
  });

  it("tracks the pointer live without rendering or writing storage", () => {
    const { shell, handle } = mount();
    const rendersBeforeDrag = renders;

    fireEvent.pointerDown(handle("sidebar"), { clientX: 400, button: 0 });
    expect(document.body).toHaveAttribute("data-pane-resizing", "sidebar");

    for (const [clientX, expected] of [[404, "304px"], [418, "318px"], [411, "311px"]] as const) {
      fireEvent.pointerMove(window, { clientX });
      // The edge is where the pointer is, on the very event that moved it.
      expect(widthVar(shell, "sidebar")).toBe(expected);
      expect(handle("sidebar")).toHaveAttribute("aria-valuenow", expected.replace("px", ""));
    }

    // Nothing above touched React or storage: the app tree is untouched for
    // the whole gesture.
    expect(renders).toBe(rendersBeforeDrag);
    expect(api.paneSizes.sidebar).toBe(300);
    expect(storedSizes()).toEqual({ sidebar: 300, dock: 500 });
  });

  it("commits the released position to state and storage exactly once", () => {
    const { shell, handle } = mount();
    const setItem = vi.spyOn(localStorage, "setItem");

    fireEvent.pointerDown(handle("sidebar"), { clientX: 400, button: 0 });
    fireEvent.pointerMove(window, { clientX: 430 });
    fireEvent.pointerUp(window, { clientX: 430 });

    expect(api.paneSizes).toEqual({ sidebar: 330, dock: 500 });
    expect(widthVar(shell, "sidebar")).toBe("330px");
    expect(storedSizes()).toEqual({ sidebar: 330, dock: 500 });
    expect(setItem.mock.calls.filter(([key]) => key === "kiwi.paneSizes")).toHaveLength(1);
    expect(document.body).not.toHaveAttribute("data-pane-resizing");
  });

  it("moves the dock edge opposite the sidebar edge", () => {
    const { shell, handle } = mount();

    fireEvent.pointerDown(handle("dock"), { clientX: 900, button: 0 });
    fireEvent.pointerMove(window, { clientX: 860 });
    expect(widthVar(shell, "dock")).toBe("540px");
    fireEvent.pointerUp(window);

    expect(api.paneSizes.dock).toBe(540);
  });

  it("unscales the drag delta by the UI scale", () => {
    const { shell, handle } = mount(2);

    fireEvent.pointerDown(handle("sidebar"), { clientX: 100, button: 0 });
    fireEvent.pointerMove(window, { clientX: 200 });
    // 100 viewport pixels at 200% zoom is 50 layout pixels.
    expect(widthVar(shell, "sidebar")).toBe("350px");
    fireEvent.pointerUp(window);

    expect(api.paneSizes).toEqual({ sidebar: 350, dock: 500 });
    expect(storedSizes()).toEqual({ sidebar: 350, dock: 500 });
  });

  it("clamps live and commits the clamped size", () => {
    const { shell, handle } = mount();

    fireEvent.pointerDown(handle("sidebar"), { clientX: 0, button: 0 });
    fireEvent.pointerMove(window, { clientX: 5000 });
    expect(widthVar(shell, "sidebar")).toBe(`${PANE_BOUNDS.sidebar.max}px`);
    fireEvent.pointerMove(window, { clientX: -5000 });
    expect(widthVar(shell, "sidebar")).toBe(`${PANE_BOUNDS.sidebar.min}px`);
    fireEvent.pointerUp(window);

    expect(api.paneSizes.sidebar).toBe(PANE_BOUNDS.sidebar.min);
    expect(storedSizes().sidebar).toBe(PANE_BOUNDS.sidebar.min);
  });

  it("restores clamped sizes from corrupted storage", () => {
    localStorage.setItem("kiwi.paneSizes", JSON.stringify({ sidebar: 4000, dock: "nonsense" }));
    const { shell } = mount();

    expect(api.paneSizes).toEqual({ sidebar: PANE_BOUNDS.sidebar.max, dock: 430 });
    expect(widthVar(shell, "sidebar")).toBe(`${PANE_BOUNDS.sidebar.max}px`);
  });

  it("reverts to the press position when the gesture is cancelled", () => {
    const { shell, handle } = mount();

    fireEvent.pointerDown(handle("sidebar"), { clientX: 400, button: 0 });
    fireEvent.pointerMove(window, { clientX: 460 });
    expect(widthVar(shell, "sidebar")).toBe("360px");
    fireEvent.pointerCancel(window);

    expect(widthVar(shell, "sidebar")).toBe("300px");
    expect(api.paneSizes.sidebar).toBe(300);
    expect(storedSizes()).toEqual({ sidebar: 300, dock: 500 });
    expect(document.body).not.toHaveAttribute("data-pane-resizing");

    // The cancelled gesture is fully detached: later moves are inert.
    fireEvent.pointerMove(window, { clientX: 700 });
    expect(widthVar(shell, "sidebar")).toBe("300px");
  });

  it("abandons the drag on Escape", () => {
    const { shell, handle } = mount();

    fireEvent.pointerDown(handle("sidebar"), { clientX: 400, button: 0 });
    fireEvent.pointerMove(window, { clientX: 500 });
    fireEvent.keyDown(window, { key: "Escape" });

    expect(widthVar(shell, "sidebar")).toBe("300px");
    fireEvent.pointerUp(window);
    expect(api.paneSizes.sidebar).toBe(300);
    expect(storedSizes()).toEqual({ sidebar: 300, dock: 500 });
  });

  it("ignores a press with no movement", () => {
    const { handle } = mount();
    const setItem = vi.spyOn(localStorage, "setItem");

    fireEvent.pointerDown(handle("dock"), { clientX: 900, button: 0 });
    fireEvent.pointerUp(window);

    expect(api.paneSizes).toEqual({ sidebar: 300, dock: 500 });
    expect(setItem.mock.calls.filter(([key]) => key === "kiwi.paneSizes")).toHaveLength(0);
  });

  it("ignores non-primary buttons", () => {
    const { handle } = mount();

    fireEvent.pointerDown(handle("sidebar"), { clientX: 400, button: 2 });
    fireEvent.pointerMove(window, { clientX: 500 });

    expect(document.body).not.toHaveAttribute("data-pane-resizing");
    expect(api.paneSizes.sidebar).toBe(300);
  });

  it("captures the active pointer and ignores events from other pointers", () => {
    const { shell, handle } = mount();
    const sidebarHandle = handle("sidebar");
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperties(sidebarHandle, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
    });

    fireEvent.pointerDown(sidebarHandle, { clientX: 400, button: 0, pointerId: 7 });
    expect(setPointerCapture).toHaveBeenCalledWith(7);

    fireEvent.pointerMove(window, { clientX: 500, pointerId: 8 });
    expect(widthVar(shell, "sidebar")).toBe("300px");
    fireEvent.pointerMove(window, { clientX: 430, pointerId: 7 });
    expect(widthVar(shell, "sidebar")).toBe("330px");

    fireEvent.pointerUp(window, { pointerId: 8 });
    expect(document.body).toHaveAttribute("data-pane-resizing", "sidebar");
    fireEvent.pointerUp(window, { pointerId: 7 });

    expect(api.paneSizes.sidebar).toBe(330);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(document.body).not.toHaveAttribute("data-pane-resizing");
  });

  it("lets a new gesture supersede one that never ended", () => {
    const { shell, handle } = mount();

    fireEvent.pointerDown(handle("sidebar"), { clientX: 400, button: 0 });
    fireEvent.pointerMove(window, { clientX: 450 });
    // No pointerup: a second press starts anyway (lost pointerup, second
    // finger). The stale gesture must not keep writing alongside the new one.
    fireEvent.pointerDown(handle("dock"), { clientX: 900, button: 0 });
    // Superseding the first drag restores its committed width before the new
    // divider starts moving.
    expect(widthVar(shell, "sidebar")).toBe("300px");
    fireEvent.pointerMove(window, { clientX: 880 });

    expect(widthVar(shell, "sidebar")).toBe("300px");
    expect(widthVar(shell, "dock")).toBe("520px");
    fireEvent.pointerUp(window);

    // Only the live gesture committed; the abandoned one left no second write.
    expect(api.paneSizes).toEqual({ sidebar: 300, dock: 520 });
    expect(storedSizes()).toEqual({ sidebar: 300, dock: 520 });
    expect(document.body).not.toHaveAttribute("data-pane-resizing");
  });

  it("detaches an in-flight drag when the component unmounts", () => {
    const { view, shell, handle } = mount();

    fireEvent.pointerDown(handle("sidebar"), { clientX: 400, button: 0 });
    fireEvent.pointerMove(window, { clientX: 450 });
    act(() => view.unmount());

    expect(document.body).not.toHaveAttribute("data-pane-resizing");
    fireEvent.pointerMove(window, { clientX: 600 });
    fireEvent.pointerUp(window);
    // Unmount cancels rather than leaving an uncommitted visual value behind.
    expect(widthVar(shell, "sidebar")).toBe("300px");
    expect(storedSizes()).toEqual({ sidebar: 300, dock: 500 });
  });

  it("resizes with the keyboard and keeps the custom property in step", () => {
    const { shell, handle } = mount();
    const preventDefault = vi.fn();

    fireEvent.keyDown(handle("sidebar"), { key: "ArrowRight" });
    expect(api.paneSizes.sidebar).toBe(316);
    expect(widthVar(shell, "sidebar")).toBe("316px");
    fireEvent.keyDown(handle("sidebar"), { key: "ArrowLeft" });
    expect(api.paneSizes.sidebar).toBe(300);

    // The dock's edge faces the other way, so its arrows do too.
    fireEvent.keyDown(handle("dock"), { key: "ArrowLeft" });
    expect(api.paneSizes.dock).toBe(516);
    expect(widthVar(shell, "dock")).toBe("516px");

    fireEvent.keyDown(handle("sidebar"), { key: "Home" });
    expect(api.paneSizes.sidebar).toBe(PANE_BOUNDS.sidebar.min);
    fireEvent.keyDown(handle("sidebar"), { key: "End" });
    expect(api.paneSizes.sidebar).toBe(PANE_BOUNDS.sidebar.max);
    expect(storedSizes()).toEqual({ sidebar: PANE_BOUNDS.sidebar.max, dock: 516 });

    act(() => {
      api.resizePaneWithKeyboard("sidebar")({ key: "ArrowLeft", preventDefault } as never);
    });
    expect(preventDefault).toHaveBeenCalled();
  });

  it("stands down on the keyboard while a drag is in flight", () => {
    const { shell, handle } = mount();

    fireEvent.pointerDown(handle("sidebar"), { clientX: 400, button: 0 });
    fireEvent.pointerMove(window, { clientX: 450 });
    // Committing here would re-run the layout effect and fight the pointer for
    // the same property.
    fireEvent.keyDown(handle("sidebar"), { key: "End" });
    expect(widthVar(shell, "sidebar")).toBe("350px");
    expect(api.paneSizes.sidebar).toBe(300);

    fireEvent.pointerUp(window);
    expect(api.paneSizes.sidebar).toBe(350);
    fireEvent.keyDown(handle("sidebar"), { key: "End" });
    expect(api.paneSizes.sidebar).toBe(PANE_BOUNDS.sidebar.max);
  });

  it("leaves unrelated keys alone", () => {
    const { handle } = mount();

    fireEvent.keyDown(handle("sidebar"), { key: "Tab" });
    fireEvent.keyDown(handle("sidebar"), { key: "a" });

    expect(api.paneSizes.sidebar).toBe(300);
  });
});
