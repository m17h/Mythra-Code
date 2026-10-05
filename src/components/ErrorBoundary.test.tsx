import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

const { recordErrorMock } = vi.hoisted(() => ({ recordErrorMock: vi.fn() }));
vi.mock("../lib/errorLog", () => ({ recordError: recordErrorMock }));

function Bomb({ defused }: { defused: boolean }) {
  if (!defused) throw new Error("kaboom");
  return <p>workspace restored</p>;
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    recordErrorMock.mockReset();
    // React reports every caught render error through console.error; that
    // noise is expected in these tests, not a failure signal.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows a labeled fallback and records the crash in the error log", () => {
    render(<ErrorBoundary label="application"><Bomb defused={false} /></ErrorBoundary>);

    expect(screen.getByRole("alert")).toHaveTextContent("The application view hit a problem");
    expect(screen.getByText("kaboom")).toBeInTheDocument();
    expect(recordErrorMock).toHaveBeenCalledWith("The application view crashed: kaboom");
  });

  it("re-renders its children after the retry affordance clears the error", () => {
    const { rerender } = render(<ErrorBoundary label="application"><Bomb defused={false} /></ErrorBoundary>);
    expect(screen.getByRole("alert")).toBeInTheDocument();

    rerender(<ErrorBoundary label="application"><Bomb defused /></ErrorBoundary>);
    fireEvent.click(screen.getByRole("button", { name: /Reload view/ }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("workspace restored")).toBeInTheDocument();
  });

  it("delegates retry when the parent must replace a failed lazy view", () => {
    const onRetry = vi.fn();
    render(<ErrorBoundary label="settings" onRetry={onRetry}><Bomb defused={false} /></ErrorBoundary>);

    fireEvent.click(screen.getByRole("button", { name: /Reload view/ }));

    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it.each([null, undefined])("contains a thrown %s value", (reason) => {
    function NullableBomb(): never { throw reason; }
    const onError = vi.fn();
    const committed = vi.fn();
    function Committed() {
      useEffect(() => { committed(); }, []);
      return null;
    }
    render(<ErrorBoundary label="conversation" onError={onError}><NullableBomb /><Committed /></ErrorBoundary>);

    expect(screen.getByRole("alert")).toHaveTextContent("Unknown error");
    expect(onError).toHaveBeenCalledWith(reason, expect.objectContaining({ componentStack: expect.any(String) }));
    expect(committed).not.toHaveBeenCalled();
  });

  it.each(["sync", "async"])("keeps the fallback visible when formatting, diagnostics, and %s reporting fail", async (mode) => {
    const reason = { toString() { throw new Error("coercion failed"); } };
    function PoisonBomb(): never { throw reason; }
    recordErrorMock.mockImplementation(() => { throw new Error("diagnostics failed"); });
    const onError = vi.fn(() => {
      if (mode === "async") return Promise.reject(new Error("reporter failed"));
      throw new Error("reporter failed");
    });
    render(<ErrorBoundary label="composer" onError={onError}><PoisonBomb /></ErrorBoundary>);
    await Promise.resolve();

    expect(screen.getByRole("alert")).toHaveTextContent("The composer view hit a problem");
    expect(screen.getByText("Unknown error")).toBeInTheDocument();
    expect(onError).toHaveBeenCalledWith(reason, expect.anything());
  });

  it("clears an errored view on identity change without remounting a healthy editor", () => {
    const mounted = vi.fn();
    function Editor() {
      useEffect(() => { mounted(); }, []);
      return <input aria-label="draft" defaultValue="" />;
    }
    const healthy = render(<ErrorBoundary label="composer" resetKey="a"><Editor /></ErrorBoundary>);
    fireEvent.change(screen.getByRole("textbox", { name: "draft" }), { target: { value: "unsent draft" } });
    healthy.rerender(<ErrorBoundary label="composer" resetKey="b"><Editor /></ErrorBoundary>);
    expect(mounted).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "draft" })).toHaveValue("unsent draft");
    healthy.unmount();

    const failed = render(<ErrorBoundary label="conversation" resetKey="a"><Bomb defused={false} /></ErrorBoundary>);
    failed.rerender(<ErrorBoundary label="conversation" resetKey="a"><Bomb defused /></ErrorBoundary>);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    failed.rerender(<ErrorBoundary label="conversation" resetKey="b"><Bomb defused /></ErrorBoundary>);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("workspace restored")).toBeInTheDocument();
  });

  it("contains keyboard focus in an owned error overlay and restores it after Escape dismissal", () => {
    const dismissed = vi.fn();
    function Host() {
      const [open, setOpen] = useState(false);
      return <>
        <button onClick={() => setOpen(true)}>Open workflow</button>
        {open && <ErrorBoundary label="workflow" overlay onDismiss={() => { dismissed(); setOpen(false); }}><Bomb defused={false} /></ErrorBoundary>}
      </>;
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Open workflow" });
    opener.focus();
    fireEvent.click(opener);
    const retry = screen.getByRole("button", { name: /Reload view/ });
    const close = screen.getByRole("button", { name: "Close workflow error" });
    expect(screen.getByRole("dialog", { name: "workflow error" })).toBeInTheDocument();
    expect(retry).toHaveFocus();
    fireEvent.keyDown(retry, { key: "Tab", shiftKey: true });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab" });
    expect(retry).toHaveFocus();
    fireEvent.keyDown(retry, { key: "Escape" });
    expect(dismissed).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
