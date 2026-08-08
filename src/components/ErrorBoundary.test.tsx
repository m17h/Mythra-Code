import { fireEvent, render, screen } from "@testing-library/react";
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
});
