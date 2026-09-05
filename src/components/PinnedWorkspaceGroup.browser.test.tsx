import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { PinnedWorkspaceGroup } from "./PinnedWorkspaceGroup";
import "../styles.css";

beforeEach(() => localStorage.removeItem("kiwi.pinnedWorkspacesCollapsed"));

function Fixture() {
  return <div className="app-shell" style={{ width: 900, height: 700 }}>
    <aside className="sidebar open">
      <div className="sidebar-sections">
        <div className="sidebar-section workspaces-section" style={{ flexBasis: 400 }}>
          <div className="workspace-list">
            <PinnedWorkspaceGroup count={4} containsActiveWorkspace={false}>
              {[1, 2, 3, 4].map((id) => <div className="workspace-row-wrap" key={id}><button className="workspace-row">Workspace {id}</button></div>)}
            </PinnedWorkspaceGroup>
            <div data-testid="following" className="workspace-row-wrap"><button className="workspace-row">Unpinned workspace</button></div>
          </div>
        </div>
      </div>
    </aside>
  </div>;
}

it("lands exactly where the next workspace stays after the close unmount", async () => {
  const view = render(<Fixture />);
  const panel = view.container.querySelector<HTMLElement>(".workspace-group-body")!;
  const following = view.getByTestId("following");
  fireEvent.click(view.getByRole("button", { name: /Pinned/ }));
  const animation = panel.getAnimations()[0];
  animation.pause();
  animation.currentTime = Number(animation.effect!.getTiming().duration);
  const endTop = following.getBoundingClientRect().top;
  const endHeight = panel.getBoundingClientRect().height;
  act(() => animation.finish());
  await waitFor(() => expect(panel.isConnected).toBe(false));
  const settledTop = following.getBoundingClientRect().top;
  expect(endHeight).toBeLessThan(0.5);
  expect(Math.abs(endTop - settledTop)).toBeLessThan(0.5);
});


it("keeps toggle renders inside the group and preserves its saved state", async () => {
  const parentRender = vi.fn();
  function Parent() {
    parentRender();
    return <Fixture />;
  }
  const view = render(<Parent />);
  parentRender.mockClear();
  const toggle = view.getByRole("button", { name: /Pinned/ });
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  const panel = view.container.querySelector<HTMLElement>(".workspace-group-body")!;
  expect(panel.inert).toBe(true);
  act(() => panel.getAnimations()[0].finish());
  await waitFor(() => expect(panel.isConnected).toBe(false));
  expect(parentRender).not.toHaveBeenCalled();
  view.unmount();
  const restored = render(<Fixture />);
  expect(restored.getByRole("button", { name: /Pinned/ }).getAttribute("aria-expanded")).toBe("false");
  expect(restored.container.querySelector(".workspace-group-body")).toBeNull();
  fireEvent.click(restored.getByRole("button", { name: /Pinned/ }));
  const opened = restored.container.querySelector<HTMLElement>(".workspace-group-body")!;
  const animation = opened.getAnimations()[0];
  animation.pause();
  animation.currentTime = 0;
  expect(opened.getBoundingClientRect().height).toBe(0);
  animation.currentTime = Number(animation.effect!.getTiming().duration);
  const before = restored.getByTestId("following").getBoundingClientRect().top;
  act(() => animation.finish());
  await waitFor(() => expect(opened.style.overflow).toBe(""));
  expect(restored.getByTestId("following").getBoundingClientRect().top).toBeCloseTo(before, 1);
});
