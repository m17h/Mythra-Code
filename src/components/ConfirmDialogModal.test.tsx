import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confirmDialog, useConfirmStore } from "../lib/confirmDialog";
import { ConfirmDialogModal } from "./ConfirmDialogModal";

describe("ConfirmDialogModal", () => {
  beforeEach(() => {
    useConfirmStore.setState({ queue: [] });
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  });

  afterEach(() => {
    useConfirmStore.setState({ queue: [] });
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("supports action-specific button labels", async () => {
    const result = confirmDialog(
      "Fable 5.1 needs a Claude Code update\n\nOpen Updates to continue.",
      { confirmLabel: "Go to Updates", cancelLabel: "Not now" },
    );
    render(<ConfirmDialogModal />);

    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to Updates" }));
    await expect(result).resolves.toBe(true);
  });
});
