import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GitHistoryView } from "./GitHistoryView";
import type { useProjectGitHistory } from "../hooks/useProjectGitHistory";

const history = (overrides: Partial<ReturnType<typeof useProjectGitHistory>> = {}) => ({
  entries: [], headOid: null, hasMore: false, nextOffset: 0, loaded: true,
  loading: false, error: null, failedRequest: null, truncated: false, loadedAt: Date.now(), available: true,
  reload: vi.fn(), loadMore: vi.fn(), retry: vi.fn(), ...overrides,
});

describe("GitHistoryView stale snapshots", () => {
  it.each([[null, "a".repeat(40)], ["a".repeat(40), null]])("notices known HEAD movement from %s to %s", (cached, current) => {
    const extra = { currentHeadKnown: true };
    render(<GitHistoryView history={history({ headOid: cached })} branch="main" currentHeadOid={current} absent={false} {...extra} />);
    expect(screen.getByText(/branch has moved/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show latest" })).toBeEnabled();
    expect(screen.queryByText(/No commits yet/)).not.toBeInTheDocument();
  });

  it("does not report movement while the checkout summary is unknown", () => {
    const extra = { currentHeadKnown: false };
    render(<GitHistoryView history={history({ headOid: "a".repeat(40) })} branch="main" currentHeadOid={null} absent={false} {...extra} />);
    expect(screen.queryByText(/branch has moved/)).not.toBeInTheDocument();
  });

  it("does not label a pinned old history page as commits on the newly selected branch", () => {
    const state = history({ headOid: "a".repeat(40), entries: [{ oid: "a".repeat(40), shortOid: "aaaaaaa", subject: "Previous branch commit", authorName: "A", authoredAt: "2026-09-28T10:00:00Z" }] });
    render(<GitHistoryView history={state} branch="new-branch" currentHeadOid={"b".repeat(40)} currentHeadKnown absent={false} />);
    expect(screen.queryByLabelText("Commits on new-branch")).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Commits at aaaaaaa" })).toBeInTheDocument();
  });

  it("uses the failed request's retry rather than inferring it from cached entries", () => {
    const state = history({ error: "reload failed", entries: [{ oid: "a".repeat(40), shortOid: "aaaaaaa", subject: "old", authorName: "A", authoredAt: "2026-09-28T10:00:00Z" }] });
    render(<GitHistoryView history={state} branch="main" currentHeadOid={state.headOid} absent={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(state.retry).toHaveBeenCalledOnce();
    expect(state.loadMore).not.toHaveBeenCalled();
  });

  it("shows an anchored read timestamp that remains truthful after idle time", () => {
    const at = Date.parse("2026-09-28T12:00:00Z");
    const state = history({ loadedAt: at });
    const view = render(<GitHistoryView history={state} branch="main" currentHeadOid={null} currentHeadKnown={true} absent={false} />);
    const label = `read at ${new Date(at).toLocaleString()}`;
    expect(screen.getByText(label)).toBeInTheDocument();
    vi.spyOn(Date, "now").mockReturnValue(at + 60 * 60_000);
    view.rerender(<GitHistoryView history={state} branch="main" currentHeadOid={null} currentHeadKnown={true} absent={false} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByText(/read just now/)).not.toBeInTheDocument();
  });
});
