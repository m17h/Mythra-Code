import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { ContextCompactionMarker } from "./ChatTimeline";
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
  it.each(["inProgress", "completed", "interrupted"])("keeps %s markers inside a narrow enlarged timeline", (status) => {
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
});
