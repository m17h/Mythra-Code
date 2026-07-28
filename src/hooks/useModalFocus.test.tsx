import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { useModalFocus } from "./useModalFocus";

function Harness({ open }: { open: boolean }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, open);
  return (
    <div>
      <button data-testid="outside">outside</button>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Test dialog">
        <button data-testid="first">first</button>
        <button data-testid="middle">middle</button>
        <button data-testid="last">last</button>
      </div>
    </div>
  );
}

describe("useModalFocus", () => {
  it("moves focus into the dialog when it opens", () => {
    const { getByTestId, rerender } = render(<Harness open={false} />);
    getByTestId("outside").focus();
    rerender(<Harness open />);
    expect(getByTestId("first")).toHaveFocus();
  });

  it("wraps Tab from the last control back to the first", async () => {
    const user = userEvent.setup();
    const { getByTestId } = render(<Harness open />);
    getByTestId("last").focus();
    await user.tab();
    expect(getByTestId("first")).toHaveFocus();
  });

  it("wraps Shift+Tab from the first control to the last", async () => {
    const user = userEvent.setup();
    const { getByTestId } = render(<Harness open />);
    getByTestId("first").focus();
    await user.tab({ shift: true });
    expect(getByTestId("last")).toHaveFocus();
  });

  it("restores focus to the invoking control when the dialog closes", () => {
    const { getByTestId, rerender } = render(<Harness open={false} />);
    getByTestId("outside").focus();
    rerender(<Harness open />);
    expect(getByTestId("first")).toHaveFocus();
    rerender(<Harness open={false} />);
    expect(getByTestId("outside")).toHaveFocus();
  });

  it("prefers an explicit [data-autofocus] target", () => {
    function AutofocusHarness({ open }: { open: boolean }) {
      const dialogRef = useRef<HTMLDivElement>(null);
      useModalFocus(dialogRef, open);
      return (
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Test dialog">
          <button>first</button>
          <div data-testid="stage" data-autofocus tabIndex={-1}>
            stage
          </div>
        </div>
      );
    }
    const { getByTestId, rerender } = render(<AutofocusHarness open={false} />);
    rerender(<AutofocusHarness open />);
    expect(getByTestId("stage")).toHaveFocus();
  });

  it("does not steal focus the user moved outside before closing", () => {
    const { getByTestId, rerender } = render(<Harness open={false} />);
    getByTestId("outside").focus();
    rerender(<Harness open />);
    getByTestId("middle").focus();
    // Simulate the user clicking into another surface before the dialog
    // closes: restore must not yank focus back.
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    rerender(<Harness open={false} />);
    expect(elsewhere).toHaveFocus();
    elsewhere.remove();
  });
});
