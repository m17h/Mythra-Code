import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../styles.css";

describe("Settings modal entrance", () => {
  it("animates the backdrop and dialog when they first mount open", () => {
    const view = render(
      <div className="modal-backdrop settings-backdrop open">
        <div className="settings-modal" />
      </div>,
    );
    const backdrop = view.container.querySelector<HTMLElement>(".settings-backdrop");
    const modal = view.container.querySelector<HTMLElement>(".settings-modal");

    expect(getComputedStyle(backdrop!).animationName).toBe("settings-backdrop-enter");
    expect(getComputedStyle(modal!).animationName).toBe("settings-modal-enter");
  });
});
