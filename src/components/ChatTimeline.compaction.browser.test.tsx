import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { ContextCompactionMarker } from "./ChatTimeline";
import { routeClaudeEvent, type ClaudeEventContext } from "../lib/claudeEvents";
import { resetTaskStore, useTaskStore } from "../lib/taskStore";
import "../styles.css";

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    setStreamTestReducedMotion(reduced: boolean): Promise<void>;
  }
}

afterEach(async () => {
  await commands.setStreamTestReducedMotion(false);
});

function marker(status: string) {
  const view = render(
    <div className="app-shell">
      <ContextCompactionMarker activity={{ id: "compaction", kind: "compaction", title: "Compacting context", status }} />
    </div>,
  );
  const root = view.container.querySelector<HTMLElement>(".context-compaction")!;
  return {
    root,
    glyph: root.querySelector<HTMLElement>(".context-compaction-glyph")!,
    seam: root.querySelector<HTMLElement>(".context-compaction-seam")!,
  };
}

describe("context compaction seam", () => {
  it("renders the real Claude 2.1.259 lifecycle without flashing an error or replacing the row", () => {
    resetTaskStore();
    const context: ClaudeEventContext = {
      bindingFor: () => "/tmp/compaction-test",
      onStatus: vi.fn(), onError: vi.fn(), onTurnCompleted: vi.fn(),
      onApprovalRequested: vi.fn(), onTranscriptChanged: vi.fn(), onUnsupportedControlRequest: vi.fn(),
    };
    const send = (message: Record<string, unknown>) => act(() => routeClaudeEvent({ threadId: "claude", turnId: "turn", message }, context));
    // The turn runner knows the turn before events arrive; /compact itself
    // emits init only after the status reset in this captured CLI version.
    useTaskStore.getState().ensureTask("claude", "/tmp/compaction-test");
    useTaskStore.getState().setActiveTurn("claude", "turn");
    function ClaudeMarkers() {
      const activities = useTaskStore((state) => state.tasks.claude.activities);
      return <div className="app-shell">{activities.filter((entry) => entry.kind === "compaction").map((entry) => <ContextCompactionMarker key={entry.id} activity={entry} />)}</div>;
    }
    const view = render(<ClaudeMarkers />);
    // Captured from a genuine, disposable manual compaction. Each message has
    // its own UUID, and the success status reset precedes the history boundary.
    send({ type: "system", subtype: "status", status: "compacting", uuid: "start" });
    const row = view.container.querySelector<HTMLElement>(".context-compaction")!;
    expect(row.textContent).toContain("Compacting context");
    expect(getComputedStyle(row.querySelector(".context-compaction-glyph")!).animationName).toBe("compaction-fold");
    send({ type: "system", subtype: "status", status: null, compact_result: "success", uuid: "end" });
    expect(view.container.textContent).not.toContain("did not finish");
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "compact_boundary", uuid: "boundary", compact_metadata: { trigger: "manual", pre_tokens: 12320, post_tokens: 694, duration_ms: 11710 } });
    expect(view.container.querySelectorAll(".context-compaction")).toHaveLength(1);
    expect(view.container.querySelector(".context-compaction")).toBe(row);
    expect(row.textContent).toContain("Context compacted");
    expect(row.textContent).toContain("Claude Code · Manual · 12K tokens before");
    expect(getComputedStyle(row.querySelector(".context-compaction-glyph")!).animationName).toBe("none");
    view.unmount();
    resetTaskStore();
  });

  it.each(["inProgress", "completed", "interrupted", "unconfirmed"])("keeps %s markers inside a narrow enlarged timeline", (status) => {
    const view = render(
      <div style={{ width: 280, fontSize: 18, "--fs-meta": "18px", "--fs-micro": "16px" } as React.CSSProperties}>
        <ContextCompactionMarker activity={{ id: "compact", kind: "compaction", title: "", status, detail: "Claude Code · Automatic · 154K tokens before" }} />
      </div>,
    );
    const root = view.container.querySelector<HTMLElement>(".context-compaction")!;
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
    const pill = root.querySelector<HTMLElement>(".context-compaction-pill")!;
    expect(pill.scrollWidth).toBeLessThanOrEqual(pill.clientWidth + 1);
  });

  it("animates the seam and glyph only while the provider is still compacting", () => {
    const live = marker("inProgress");
    expect(getComputedStyle(live.glyph).animationName).toBe("compaction-fold");
    expect(getComputedStyle(live.seam, "::after").animationName).toBe("compaction-sweep");

    const settled = marker("completed");
    expect(getComputedStyle(settled.glyph).animationName).toBe("none");
    expect(getComputedStyle(settled.seam, "::after").content).toBe("none");
  });

  it("holds the live marker still and fully legible under reduced motion", async () => {
    await commands.setStreamTestReducedMotion(true);
    const live = marker("inProgress");

    expect(getComputedStyle(live.glyph).animationName).toBe("none");
    expect(getComputedStyle(live.glyph).opacity).toBe("1");
    expect(getComputedStyle(live.seam, "::after").animationName).toBe("none");
    // The seam still reads as live rather than vanishing with the animation.
    expect(Number(getComputedStyle(live.seam, "::after").opacity)).toBeCloseTo(0.5, 2);
  });

  it("keeps an unconfirmed outcome neutral and static", () => {
    const ended = marker("unconfirmed");
    expect(ended.root.textContent).toContain("Compaction ended");
    expect(ended.root.classList.contains("complete")).toBe(false);
    expect(ended.root.classList.contains("incomplete")).toBe(false);
    expect(getComputedStyle(ended.glyph).animationName).toBe("none");
  });
});
