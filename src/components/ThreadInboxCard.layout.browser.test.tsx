import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { ThreadInboxCard } from "./ThreadInboxCard";
import { ActivityStatus } from "./ActivityStatus";
import { resetTaskStore, useTaskStore } from "../lib/taskStore";
import "../styles.css";

beforeEach(async () => { resetTaskStore(); await commands.setStreamTestReducedMotion(true); });
afterEach(async () => { await commands.setStreamTestReducedMotion(false); });

describe("inbox PR badge layout", () => {
  it.each(["dark", "light"])("keeps metadata, title, and live status separate in %s mode", (scheme) => {
    useTaskStore.getState().setTaskStatus("preview", "running");
    for (const width of [210, 240, 280, 320]) {
      for (const number of [103, 123456789012345]) {
        const view = render(<div className="app-shell" data-color-scheme={scheme} style={{ display: "block" }}>
          <div className="thread-row-wrap active" style={{ width }}>
            <ThreadInboxCard threadId="preview" title="A very long descriptive thread title which must keep its own full row"
              workspaceName="An unusually long project name" directory="/work/projects/a-long-project-folder-name"
              provider="claude" providerName="Claude" pinned onOpen={() => {}}
              scheduledPromptCount={128}
              pullRequest={{ number, repository: "organisation/a-long-repository-name", state: "OPEN", isDraft: false }} />
          </div>
        </div>);
        const card = view.container.querySelector<HTMLElement>(".thread-card")!;
        const title = card.querySelector<HTMLElement>(".thread-card-title")!;
        const meta = card.querySelector<HTMLElement>(".thread-card-meta")!;
        const badge = card.querySelector<HTMLElement>(".thread-card-pr")!;
        const provider = card.querySelector<HTMLElement>(".thread-card-provider")!;
        const status = card.querySelector<HTMLElement>(".thread-card-status")!;
        expect(card.scrollWidth, JSON.stringify({width, number, card: card.clientWidth, children: [...card.children].map((e) => ({ c: e.className, width: e.clientWidth, scroll: e.scrollWidth }))})).toBeLessThanOrEqual(card.clientWidth);
        expect(title.getBoundingClientRect().bottom).toBeLessThanOrEqual(meta.getBoundingClientRect().top);
        expect(status.getBoundingClientRect().bottom).toBeLessThanOrEqual(title.getBoundingClientRect().top);
        expect(title.clientWidth).toBeGreaterThan(badge.clientWidth);
        const children = [...meta.children] as HTMLElement[];
        for (let i = 1; i < children.length; i += 1) {
          expect(children[i - 1].getBoundingClientRect().right).toBeLessThanOrEqual(children[i].getBoundingClientRect().left);
        }
        expect(provider.getBoundingClientRect().right).toBeLessThanOrEqual(card.getBoundingClientRect().right - 29);
        expect(meta.scrollWidth).toBeLessThanOrEqual(meta.clientWidth);
        expect(badge.clientWidth).toBeGreaterThan(24);
        view.unmount();
      }
    }
  });
});

function WorkingCard({ scheme = "dark", width = 210 }: { scheme?: string; width?: number }) {
  return <div className="app-shell" data-theme="mythra" data-color-scheme={scheme} style={{ display: "block" }}>
    <div className="thread-row-wrap" style={{ width }}>
      <ThreadInboxCard threadId="working-preview" title="Review changes" workspaceName="An unusually long project name"
        directory="/projects/app" provider="openai" providerName="OpenAI" pinned={false} onOpen={() => {}} />
    </div>
    <ActivityStatus state="running" label="Working" onOpen={() => {}} />
  </div>;
}

describe("inbox working mark", () => {
  it.each(["dark", "light"])("matches ActivityStatus's actual dots, color and cycle at narrow and wide card widths in %s", async (scheme) => {
    await commands.setStreamTestReducedMotion(false);
    for (const status of ["starting", "running"] as const) {
      useTaskStore.getState().setTaskStatus("working-preview", status);
      for (const width of [210, 320]) {
        const view = render(<WorkingCard scheme={scheme} width={width} />);
        const card = view.container.querySelector<HTMLElement>(".thread-card")!;
        const label = card.querySelector<HTMLElement>(".thread-card-status")!;
        // Lumen scales the entire status during its finite entrance animation.
        // Measure the settled card without stopping the dots' live CSS cycle.
        await Promise.all(label.getAnimations().map((animation) => animation.finished));
        const mark = card.querySelector<HTMLElement>(".thread-card-status .pixel-working-mark.live")!;
        expect(mark).not.toBeNull();
        expect(mark).toHaveAttribute("aria-hidden", "true");
        expect(card.querySelector(".thread-card-status svg")).toBeNull();
        const cells = [...mark.children] as HTMLElement[];
        const reference = [...view.container.querySelectorAll<HTMLElement>(".activity-status .pixel-working-mark > i")];
        expect(cells).toHaveLength(9);
        for (let index = 0; index < cells.length; index += 1) {
          const cell = cells[index];
          const actual = getComputedStyle(cell);
          const expected = getComputedStyle(reference[index]);
          for (const property of ["width", "height", "border-radius", "background-color", "box-shadow", "transform", "animation-name", "animation-duration", "animation-delay", "animation-timing-function"]) {
            expect(actual.getPropertyValue(property), `${status} ${width}px dot ${index} ${property}`).toBe(expected.getPropertyValue(property));
          }
          const rect = cell.getBoundingClientRect();
          const origin = cells[0].getBoundingClientRect();
          expect([rect.width, rect.height, rect.left - origin.left, rect.top - origin.top]).toEqual([2, 2, (index % 3) * 3, Math.floor(index / 3) * 3]);
        }
        expect(getComputedStyle(cells[0]).animationName).toBe("pixel-working-ring");
        expect(getComputedStyle(cells[0]).animationDuration).toBe("0.96s");
        expect(getComputedStyle(cells[4]).animationName).toBe("pixel-working-core");
        expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
        expect(label).toHaveTextContent(status === "starting" ? "Starting" : "Working");
        expect(mark.getBoundingClientRect().right).toBeLessThanOrEqual(label.getBoundingClientRect().right);
        view.unmount();
      }
    }
  });

  it("removes the animation as running work becomes approval, idle, failed or done", async () => {
    await commands.setStreamTestReducedMotion(false);
    const store = useTaskStore.getState();
    store.setTaskStatus("working-preview", "running");
    const view = render(<WorkingCard />);
    const card = view.container.querySelector<HTMLElement>(".thread-card")!;
    expect(card.querySelectorAll(".pixel-working-mark.live > i")).toHaveLength(9);
    act(() => store.enqueueApproval({ id: 1, method: "item/commandExecution/requestApproval", params: {}, threadId: "working-preview", receivedAt: 1 }));
    expect(card.querySelector(".thread-card-status")).toHaveTextContent("Needs approval");
    expect(card.querySelector(".pixel-working-mark")).toBeNull();
    act(() => store.resolveApproval("working-preview", 1));
    expect(card.querySelectorAll(".pixel-working-mark.live > i")).toHaveLength(9);
    act(() => { store.setTaskStatus("working-preview", "idle"); store.clearUnread("working-preview"); });
    expect(card.querySelector(".thread-card-status")).toBeNull();
    for (const [status, label] of [["error", "Failed"], ["completed", "Done"]] as const) {
      act(() => store.setTaskStatus("working-preview", status));
      expect(card.querySelector(".thread-card-status")).toHaveTextContent(label);
      expect(card.querySelector(".pixel-working-mark")).toBeNull();
    }
  });

  it("holds the same static frame under reduced motion and forced colors", async () => {
    useTaskStore.getState().setTaskStatus("working-preview", "running");
    try {
      for (const forced of [false, true]) {
        await commands.setStreamTestReducedMotion(!forced);
        await commands.setForcedColors(forced);
        const view = render(<WorkingCard />);
        const cells = [...view.container.querySelectorAll<HTMLElement>(".thread-card-status .pixel-working-mark > i")];
        const reference = [...view.container.querySelectorAll<HTMLElement>(".activity-status .pixel-working-mark > i")];
        expect(cells).toHaveLength(9);
        for (let index = 0; index < cells.length; index += 1) {
          const actual = getComputedStyle(cells[index]);
          expect(actual.animationName).toBe("none");
          expect(actual.opacity).toBe(getComputedStyle(reference[index]).opacity);
          expect(actual.backgroundColor).toBe(getComputedStyle(reference[index]).backgroundColor);
        }
        expect(cells.map((cell) => Number(getComputedStyle(cell).opacity))).toEqual([1, 0, 0, 0.75, 0.75, 0, 0.5, 0.25, 0]);
        view.unmount();
      }
    } finally {
      await commands.setForcedColors(false);
    }
  });
});
