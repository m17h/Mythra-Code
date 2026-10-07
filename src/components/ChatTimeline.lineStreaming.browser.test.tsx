import { StrictMode } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, page, server } from "vitest/browser";
import { ChatTimeline } from "./ChatTimeline";
import type { ChatMessage } from "../types";
import "../styles.css";

const highlights = () => [...CSS.highlights.entries()].filter(([name]) => name.startsWith("mythra-stream-"));

function frameClock() {
  let now = 1200;
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.set(++id, callback); return id; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((key) => { frames.delete(key); });
  return {
    async advance(ms: number) {
      now += ms;
      await act(async () => {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((callback) => callback(now));
      });
    },
  };
}

function Shell({ text, streaming = true, completed = false, searchQuery, history = [] }: {
  text: string; streaming?: boolean; completed?: boolean; searchQuery?: string; history?: ChatMessage[];
}) {
  return <StrictMode><div className="app-shell" data-theme="kiwi" style={{ height: 650, width: 800 }}>
    <ChatTimeline provider="claude" activities={[]} running={!completed} activeTurnId={completed ? undefined : "turn"}
      thinkingLabel="Working" searchQuery={searchQuery} messages={[
        { id: "prompt", role: "user", text: "Explain the result", timelineOrder: 1, turnId: "turn" },
        ...history,
        { id: "live", role: "assistant", phase: "final", text, streaming, timelineOrder: 100,
          turnId: "turn", turnStatus: completed ? "completed" : "inProgress" },
      ]} />
  </div></StrictMode>;
}

function openHistory(container: HTMLElement) {
  fireEvent.click(container.querySelector<HTMLButtonElement>(".activity-status-pill")!);
  expect(container.querySelector<HTMLDialogElement>("dialog")?.open).toBe(true);
  return container.querySelector<HTMLElement>('[data-step-id="live"] .rich-markdown')!;
}

afterEach(async () => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  await commands.setStreamTestReducedMotion(false);
  expect(highlights()).toHaveLength(0);
  expect(document.querySelectorAll("style[data-mythra-stream-fade]")).toHaveLength(0);
});

describe("Work history line streaming through the production timeline", () => {
  it("reveals authored lines intact only in Work history and keeps completed chat answers complete", async () => {
    const clock = frameClock();
    const view = render(<Shell text={"Ready\n\n"} />);
    const main = view.container.querySelector(".flow-timeline")!;
    const body = openHistory(view.container);
    const final = "Ready\n\nAlpha complete\nBeta complete\nGamma complete\n";
    view.rerender(<Shell text={final} />);
    const snapshots: string[] = [];
    for (let index = 0; index < 20; index++) {
      await clock.advance(40);
      snapshots.push(body.textContent!);
      for (const line of ["Alpha complete", "Beta complete", "Gamma complete"]) {
        if (body.textContent!.includes(line.split(" ")[0])) expect(body.textContent).toContain(line);
      }
      expect(main.querySelectorAll(".message.assistant")).toHaveLength(0);
    }
    expect(new Set(snapshots).size).toBeGreaterThan(1);
    expect(body.textContent).toContain("Gamma complete");
    view.rerender(<Shell text={final} streaming={false} />);
    expect(main.querySelectorAll(".message.assistant")).toHaveLength(0);
    view.rerender(<Shell text={final} streaming={false} completed />);
    expect(main.querySelector(".message.assistant .rich-markdown")?.textContent).toContain("Gamma complete");
    expect(view.container.querySelector('[data-step-id="live"] .rich-markdown')).toBe(body);
    await clock.advance(1000);
    expect(highlights()).toHaveLength(0);
  });

  it("withholds incomplete GFM headers and rows, preserving links and nested marks when the row arrives", async () => {
    const clock = frameClock();
    const view = render(<Shell text={"Ready\n\n"} />);
    const body = openHistory(view.container);
    const header = "Ready\n\n| Name | Detail |\n";
    view.rerender(<Shell text={`${header}| --- | --`} />);
    await clock.advance(240);
    expect(body.querySelector("table")).toBeNull();
    expect(body.textContent).not.toContain("Name");
    const table = `${header}| --- | --- |\n`;
    view.rerender(<Shell text={`${table}| one | **bold** and [link](https://example.com)`} />);
    await clock.advance(240);
    expect(body.querySelector("table th")?.textContent).toBe("Name");
    expect(body.querySelectorAll("tbody tr")).toHaveLength(0);
    view.rerender(<Shell text={`${table}| one | **bold** and [link](https://example.com) |\n`} />);
    await clock.advance(240);
    expect(body.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(body.querySelector("tbody strong")?.textContent).toBe("bold");
    expect(body.querySelector("tbody a")?.getAttribute("href")).toBe("https://example.com");
    const html = body.innerHTML;
    // The dialog's entrance transform can still change its painted bounds;
    // offsetHeight measures layout, which the paint-only fade must preserve.
    const height = body.offsetHeight;
    await clock.advance(1000);
    expect(body.innerHTML).toBe(html);
    expect(body.offsetHeight).toBe(height);
    if (import.meta.env.VITE_LINE_STREAM_REVIEW_SCREENSHOT === "1") {
      await page.screenshot({ path: `../../test-results/line-streaming/work-history-${server.browser}.png` });
    }
  });

  it("copies received code from a held live tail, never rewinds, and finishes an unterminated fence", async () => {
    const clock = frameClock();
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const initial = "```ts\nconst a = 1;\n";
    const view = render(<Shell text={initial} />);
    const body = openHistory(view.container);
    const received = `${initial}const b = 2;`;
    view.rerender(<Shell text={received} />);
    await clock.advance(80);
    expect(body.querySelector("code")?.textContent).not.toContain("const b");
    await act(async () => { fireEvent.click(body.querySelector(".code-copy")!); });
    expect(write).toHaveBeenCalledWith("const a = 1;\nconst b = 2;");
    expect(body.querySelector("code")?.textContent).toContain("const b = 2;");
    const final = `${received}\nconst c = 3;`;
    view.rerender(<Shell text={final} />);
    expect(body.querySelector("code")?.textContent).toContain("const b = 2;");
    view.rerender(<Shell text={final} streaming={false} completed />);
    await clock.advance(1200);
    await clock.advance(240);
    expect(body.querySelector("code")?.textContent).toContain("const c = 3;");
    expect(highlights()).toHaveLength(0);
  });

  it("materializes a search match in a withheld tail immediately", async () => {
    const clock = frameClock();
    const view = render(<Shell text={"Ready\n\n"} />);
    const body = openHistory(view.container);
    const received = "Ready\n\nThe **needle** is inside an unfinished marked paragraph";
    view.rerender(<Shell text={received} />);
    await clock.advance(80);
    expect(body.textContent).not.toContain("needle");
    view.rerender(<Shell text={received} searchQuery="needle" />);
    expect(body.textContent).toContain("needle");
    expect(view.container.querySelector('[data-step-id="live"].is-match')).not.toBeNull();
    expect(view.container.querySelector(".activity-details-search")?.textContent).toContain("1 of 1");
    view.rerender(<Shell text={`${received} continues`} searchQuery="needle" />);
    expect(body.textContent).toContain("paragraph continues");
    view.rerender(<Shell text={`${received} continues`} />);
    expect(body.textContent).toContain("paragraph continues");
    view.rerender(<Shell text={`${received} continues with another unfinished addition`} />);
    expect(body.textContent).toContain("paragraph continues");
  });

  it("shows an authoritative correction immediately and drains the last Unicode tail without remounting", async () => {
    const clock = frameClock();
    const view = render(<Shell text={"Ready\n\n"} />);
    const body = openHistory(view.container);
    view.rerender(<Shell text={"Ready\n\nAn incomplete **draft"} />);
    await clock.advance(80);
    view.rerender(<Shell text={"Corrected answer 👩‍💻 e\u0301 🇨🇦"} />);
    expect(body.textContent).toBe("Corrected answer 👩‍💻 e\u0301 🇨🇦");
    view.rerender(<Shell text={"Corrected answer 👩‍💻 e\u0301 🇨🇦 — done"} streaming={false} completed />);
    await clock.advance(1200);
    await clock.advance(240);
    expect(body.textContent).toBe("Corrected answer 👩‍💻 e\u0301 🇨🇦 — done");
    expect(view.container.querySelector('[data-step-id="live"] .rich-markdown')).toBe(body);
    expect(highlights()).toHaveLength(0);
  });

  it("renders all received modal text immediately under reduced motion", async () => {
    await commands.setStreamTestReducedMotion(true);
    const view = render(<Shell text={"Ready\n\n"} />);
    const body = openHistory(view.container);
    view.rerender(<Shell text={"Ready\n\nA **marked** paragraph with no final newline"} />);
    expect(body.textContent).toContain("A marked paragraph with no final newline");
    expect(highlights()).toHaveLength(0);
  });

  it("preserves the reader's scroll position as lines arrive and resumes following with Latest", async () => {
    const history: ChatMessage[] = Array.from({ length: 14 }, (_, index) => ({
      id: `update-${index}`, role: "assistant", phase: "commentary", text: `Update ${index}: ${"words ".repeat(80)}`,
      timelineOrder: index + 2, turnId: "turn", turnStatus: "inProgress",
    }));
    const view = render(<Shell history={history} text={"Ready\n\n"} />);
    const body = openHistory(view.container);
    const scroller = view.container.querySelector<HTMLElement>(".activity-details-scroll")!;
    await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight));
    fireEvent.wheel(scroller, { deltaY: -300 });
    scroller.scrollTop = 150;
    fireEvent.scroll(scroller);
    view.rerender(<Shell history={history} text={`Ready\n\n${"A complete authored line.\n".repeat(16)}`} />);
    await vi.waitFor(() => expect(body.textContent).toContain("A complete authored line."), { timeout: 2000 });
    expect(scroller.scrollTop).toBe(150);
    const latest = [...view.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Latest"));
    expect(latest).toBeDefined();
    fireEvent.click(latest!);
    await vi.waitFor(() => expect(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight).toBeLessThanOrEqual(32));
  });
});
