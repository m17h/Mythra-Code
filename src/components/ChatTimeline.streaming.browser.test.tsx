import { StrictMode, useRef, useState } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantMessageMarkdown, ChatTimeline, MessageRow } from "./ChatTimeline";
import { ActivityDetailsModal } from "./ActivityDetailsModal";
import { commands } from "vitest/browser";
import type { ChatMessage, Provider } from "../types";
import "../styles.css";

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    setStreamTestReducedMotion(reduced: boolean): Promise<void>;
  }
}

const highlights = () => [...CSS.highlights.entries()].filter(([name]) => name.startsWith("mythra-stream-"));
const fadedText = () => highlights().flatMap(([, highlight]) => [...highlight].map((range) => (range as Range).toString())).join("");
// Pin frame time; Markdown, DOM ranges and the browser Highlight registry
// remain real, as in the cadence/fade suites.
function frameClock() {
  let now = 1200;
  let id = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callbacks.set(++id, callback); return id; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((key) => { callbacks.delete(key); });
  return {
    async advance(ms: number) {
      now += ms;
      await act(async () => {
        const pending = [...callbacks.values()];
        callbacks.clear();
        pending.forEach((callback) => callback(now));
      });
    },
  };
}
function Shell({ text, streaming = true, provider = "claude", history = [] }: {
  text: string; streaming?: boolean; provider?: Provider; history?: ChatMessage[];
}) {
  return <StrictMode><div className="app-shell" data-theme="kiwi" style={{ height: 600 }}>
    {/* Renderer-boundary fixture: main chat intentionally no longer mounts
        routine live prose. Keep its actual production row/copy controls under
        StrictMode rather than disabling streaming to recover old assertions. */}
    {history.map((message) => <MessageRow key={message.id} message={message} provider={provider} />)}
    <MessageRow message={{ id: "live", role: "assistant", text, streaming }} provider={provider} />
  </div></StrictMode>;
}

function ActivityShell({ text, streaming = true, history = [] }: {
  text: string; streaming?: boolean; history?: ChatMessage[];
}) {
  const sourceRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);
  return <StrictMode><div ref={sourceRef} className="app-shell" data-theme="kiwi">
    {open && <ActivityDetailsModal sourceRef={sourceRef} onClose={() => setOpen(false)}
      run={{ state: streaming ? "running" : "completed", entries: [...history,
        { id: "live", role: "assistant" as const, text, streaming, phase: "final" as const },
      ].map((value) => ({ kind: "message" as const, value })) }}
      renderMessage={(message) => message.role === "assistant"
        ? <AssistantMessageMarkdown text={message.text} streaming={Boolean(message.streaming)} />
        : <MessageRow message={message} provider="claude" />}
      renderSubAgents={() => null} />}
  </div></StrictMode>;
}

const liveBody = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-step-id="live"] .rich-markdown')!;

afterEach(async () => {
  cleanup();
  expect(highlights()).toHaveLength(0);
  expect(document.querySelectorAll("style[data-mythra-stream-fade]")).toHaveLength(0);
  await commands.setStreamTestReducedMotion(false);
});

describe("live Markdown paint integration", () => {
  it("hides routine and final-channel live text in chat while its real modal stays live through completion", async () => {
    const history: ChatMessage[] = [
      { id: "prompt", role: "user", text: "Build it", timelineOrder: 1, turnId: "turn" },
      { id: "progress", role: "assistant", text: "Preparing the changes", phase: "commentary", timelineOrder: 2, turnId: "turn" },
    ];
    function TimelineShell({ text, streaming, completed = false }: { text: string; streaming: boolean; completed?: boolean }) {
      return <StrictMode><div className="app-shell" data-theme="kiwi" style={{ height: 600 }}>
        <ChatTimeline provider="claude" activities={[]} running={!completed} thinkingLabel="Working"
          messages={[...history, { id: "live", role: "assistant", phase: "final", text, streaming,
            timelineOrder: 3, turnId: "turn", turnStatus: completed ? "completed" : "inProgress" }]} />
      </div></StrictMode>;
    }
    const view = render(<TimelineShell text="The result" streaming />);
    const main = view.container.querySelector<HTMLElement>(".flow-timeline")!;
    expect(main.querySelectorAll(".message.assistant")).toHaveLength(0);
    expect(main.textContent).not.toContain("Preparing the changes");
    expect(main.textContent).not.toContain("The result");
    expect(main.querySelectorAll(".activity-status.live")).toHaveLength(1);
    fireEvent.click(main.querySelector<HTMLButtonElement>(".activity-status-pill")!);
    const body = liveBody(view.container);
    expect(body.textContent).toBe("The result");
    const prefix = body.querySelector("p")!.firstChild;
    view.rerender(<TimelineShell text="The result is ready" streaming />);
    await vi.waitFor(() => expect(body.textContent).toBe("The result is ready"));
    expect(view.container.querySelector<HTMLDialogElement>("dialog")?.open).toBe(true);
    expect(main.querySelectorAll(".message.assistant")).toHaveLength(0);
    // Item-level streaming can end before the provider confirms the turn.
    view.rerender(<TimelineShell text="The result is ready now." streaming={false} />);
    expect(main.querySelectorAll(".message.assistant")).toHaveLength(0);
    view.rerender(<TimelineShell text="The result is ready now." streaming={false} completed />);
    expect(main.querySelectorAll(".message.assistant")).toHaveLength(1);
    expect(main.querySelector(".message.assistant .rich-markdown")?.textContent).toBe("The result is ready now.");
    expect(liveBody(view.container)).toBe(body);
    expect(body.querySelector("p")!.firstChild).toBe(prefix);
    expect(view.container.querySelector('[data-step-id="progress"]')).not.toBeNull();
    await vi.waitFor(() => expect(body.textContent).toBe("The result is ready now."));
  });

  it("presents the full live modal text immediately without decoration under reduced motion", async () => {
    await commands.setStreamTestReducedMotion(true);
    const view = render(<ActivityShell text="Existing" />);
    const body = liveBody(view.container);
    const appended = `Existing ${"new words ".repeat(80)}`;
    view.rerender(<ActivityShell text={appended} />);
    expect(liveBody(view.container)).toBe(body);
    expect(body.textContent).toBe(appended.trimEnd());
    expect(highlights()).toHaveLength(0);
    expect(document.querySelectorAll("style[data-mythra-stream-fade]")).toHaveLength(0);
    view.rerender(<ActivityShell text={`${appended}done.`} streaming={false} />);
    expect(body.textContent).toBe(`${appended}done.`);
    expect(highlights()).toHaveLength(0);
  });

  it.each(["claude", "openai"] as const)("lays out authored assistant lines separately with %s", (provider) => {
    const view = render(<Shell provider={provider} text={"A short first line\nA short second line"} streaming={false} />);
    const paragraph = view.container.querySelector(".message.assistant .rich-markdown p")!;
    const [firstLine, secondLine] = [...paragraph.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
    expect(paragraph.querySelectorAll("br")).toHaveLength(1);
    const firstRange = document.createRange();
    firstRange.selectNodeContents(firstLine);
    const secondRange = document.createRange();
    secondRange.selectNodeContents(secondLine);
    expect(secondRange.getBoundingClientRect().top).toBeGreaterThan(firstRange.getBoundingClientRect().top);
  });

  it("does not rewind live text after copying and receiving another burst", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const view = render(<Shell text={"```ts\nconst x = 1;"} />);
    const received = "```ts\nconst x = 1;\nconst y = 2;";
    view.rerender(<Shell text={received} />);
    await act(async () => { fireEvent.click(view.container.querySelector(".code-copy")!); });
    const copied = view.container.querySelector("code")!.textContent!;
    view.rerender(<Shell text={`${received}\nconst z = 3;\n\`\`\``} />);
    expect(view.container.querySelector("code")!.textContent).toBe(copied);
    await vi.waitFor(() => expect(view.container.querySelector("code")!.textContent).toContain("const z = 3;"));
  });
  it("copies complete code while a finished response still has a paced tail", async () => {
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const view = render(<Shell text={"```ts\nconst x = 1;"} />);
    const final = "```ts\nconst x = 1;\nconst y = 2;\n```";
    view.rerender(<Shell text={final} streaming={false} />);
    expect(view.container.querySelector("code")?.textContent).not.toContain("const y");
    await act(async () => { fireEvent.click(view.container.querySelector(".code-copy")!); });
    expect(write).toHaveBeenCalledWith("const x = 1;\nconst y = 2;");
    expect(view.container.querySelector("code")?.textContent).toContain("const y = 2;");
    await vi.waitFor(() => expect(document.querySelectorAll("style[data-mythra-stream-fade]")).toHaveLength(0));
  });
  it.each(["claude", "openai"] as const)("paces and fades an append but not hydrated history, with %s and StrictMode", async (provider) => {
    const view = render(<Shell provider={provider} text="Existing paragraph. " />);
    expect(highlights()).toHaveLength(0);
    view.rerender(<Shell provider={provider} text="Existing paragraph. New words" />);
    await vi.waitFor(() => expect(fadedText().length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(view.container.querySelector(".rich-markdown")?.textContent).toBe("Existing paragraph. New words"));
    expect(view.container.querySelector(".rich-markdown")?.textContent).toBe("Existing paragraph. New words");
    view.unmount();
    render(<Shell provider={provider} text="Existing paragraph. New words" streaming={false} />);
    expect(highlights()).toHaveLength(0);
  });

  it("keeps the DOM through the bounded completion tail and copies full authoritative text immediately", async () => {
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const view = render(<Shell text="First " />);
    view.rerender(<Shell text="First streaming" />);
    await vi.waitFor(() => expect(highlights().length).toBeGreaterThan(0));
    const body = view.container.querySelector(".rich-markdown");
    const textNode = body?.querySelector("p")?.firstChild;
    view.rerender(<Shell text="First streaming final." streaming={false} />);
    expect(highlights().length).toBeGreaterThan(0);
    expect(view.container.querySelector(".rich-markdown")).toBe(body);
    expect(body?.querySelector("p")?.firstChild).toBe(textNode);
    await act(async () => { fireEvent.click(view.container.querySelector('button[title="Copy message"]')!); });
    expect(write).toHaveBeenCalledWith("First streaming final.");
    await vi.waitFor(() => expect(view.container.querySelector(".rich-markdown")?.textContent).toBe("First streaming final."));
    await vi.waitFor(() => expect(document.querySelectorAll("style[data-mythra-stream-fade]")).toHaveLength(0), { timeout: 800 });
    view.rerender(<Shell key="other-thread" text="Another live thread" />);
    expect(highlights()).toHaveLength(0);
    view.rerender(<Shell key="other-thread" text="Another live thread continues" />);
    await vi.waitFor(() => expect(fadedText().length).toBeGreaterThan(0));
  });

  it("preserves Markdown structure, link targets, code-copy text and geometry", async () => {
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const view = render(<Shell text="Answer " />);
    const text = "Answer **bold** and [link](https://example.com)\n\n```ts\nconst x = 1;\n```\n\n| A | B |\n| --- | --- |\n| one | two |";
    view.rerender(<Shell text={text} />);
    const body = view.container.querySelector<HTMLElement>(".rich-markdown")!;
    await vi.waitFor(() => expect(body.textContent).toContain("two"));
    expect(body.querySelector("strong")?.textContent).toBe("bold");
    expect(body.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(body.querySelector("table")).not.toBeNull();
    expect(body.querySelector("code")?.textContent).toBe("const x = 1;\n");
    const height = body.getBoundingClientRect().height;
    await act(async () => { fireEvent.click(body.querySelector(".code-copy")!); });
    expect(write).toHaveBeenCalledWith("const x = 1;"); // Existing copy strips the fence's trailing newline.
    const html = body.innerHTML;
    await vi.waitFor(() => expect(highlights()).toHaveLength(0));
    expect(body.getBoundingClientRect().height).toBe(height);
    view.rerender(<Shell text={text} streaming={false} />);
    const finalBody = view.container.querySelector<HTMLElement>(".rich-markdown")!;
    expect(finalBody.innerHTML).toBe(html);
    expect(finalBody).toBe(body);
    expect(finalBody.getBoundingClientRect().height).toBe(height);
  });

  it("does not pull a reader away from history while new text fades", async () => {
    const history: ChatMessage[] = Array.from({ length: 20 }, (_, index) => ({
      id: `old-${index}`, role: "user", text: `History ${index}: ${"words ".repeat(80)}`, timelineOrder: index,
    }));
    const view = render(<ActivityShell history={history} text="Live " />);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const scroller = view.container.querySelector<HTMLElement>(".activity-details-scroll")!;
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
    fireEvent.wheel(scroller, { deltaY: -300 });
    scroller.scrollTop = 150;
    fireEvent.scroll(scroller);
    view.rerender(<ActivityShell history={history} text={`Live ${"new words ".repeat(80)}`} />);
    await vi.waitFor(() => expect(highlights().length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(liveBody(view.container)?.textContent).toBe(`Live ${"new words ".repeat(80)}`.trimEnd()));
    await vi.waitFor(() => expect(highlights()).toHaveLength(0));
    expect(scroller.scrollTop).toBe(150);
    const rows = [...scroller.querySelectorAll<HTMLElement>(".activity-step")].map((row) => row.getBoundingClientRect());
    for (let index = 1; index < rows.length; index++) expect(rows[index].top).toBeGreaterThanOrEqual(rows[index - 1].bottom - 1);
  });

  it("resets a same-instance rewrite and keeps simultaneous streaming rows independent", async () => {
    const other = (text: string): ChatMessage[] => [{ id: "other", role: "assistant", text, streaming: true, timelineOrder: 1 }];
    const view = render(<Shell history={other("Other")} text="Original" />);
    view.rerender(<Shell history={other("Other append")} text="Original append" />);
    await vi.waitFor(() => expect(highlights().length).toBeGreaterThanOrEqual(2));
    view.rerender(<Shell text="Unrelated replacement" />);
    expect(highlights()).toHaveLength(0);
    view.rerender(<Shell text="Unrelated replacement live" />);
    await vi.waitFor(() => expect(fadedText().length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(view.container.querySelector(".rich-markdown")?.textContent).toBe("Unrelated replacement live"));
  });

  it("cleans up a finishing fade on thread switch and an authoritative final-text edit", async () => {
    const view = render(<Shell text="Start" />);
    view.rerender(<Shell text="Start appended" streaming={false} />);
    await vi.waitFor(() => expect(highlights().length).toBeGreaterThan(0));
    view.rerender(<Shell text="Corrected final message" streaming={false} />);
    expect(highlights()).toHaveLength(0);
    expect(document.querySelectorAll("style[data-mythra-stream-fade]")).toHaveLength(0);
    view.rerender(<Shell text="Resume" />);
    view.rerender(<Shell text="Resume appended" streaming={false} />);
    await vi.waitFor(() => expect(highlights().length).toBeGreaterThan(0));
    view.rerender(<Shell key="different" text="Opened historical message" streaming={false} />);
    expect(highlights()).toHaveLength(0);
    expect(document.querySelectorAll("style[data-mythra-stream-fade]")).toHaveLength(0);
  });

  it("keeps the modal answer mounted through the completed turn's bounded tail", async () => {
    const clock = frameClock();
    const history: ChatMessage[] = [
      { id: "prompt", role: "user", text: "Build it", timelineOrder: 1, turnId: "turn" },
      { id: "progress", role: "assistant", text: "Preparing the changes", timelineOrder: 2, turnId: "turn" },
    ];
    const view = render(<ActivityShell history={history} text="The result" />);
    view.rerender(<ActivityShell history={history} text="The result is ready" />);
    await clock.advance(120);
    expect(highlights().length).toBeGreaterThan(0);
    const active = highlights();
    const activeText = fadedText();
    const body = liveBody(view.container);
    expect(body).toBeDefined();
    view.rerender(<ActivityShell history={history} text="The result is ready now." streaming={false} />);
    expect(view.container.querySelector('[data-step-id="progress"]')).not.toBeNull();
    expect(liveBody(view.container)).toBe(body);
    expect(highlights().length).toBeGreaterThan(0);
    for (const [name, highlight] of active) expect(CSS.highlights.get(name)).toBe(highlight);
    expect(fadedText()).toBe(activeText);
    await clock.advance(240);
    expect(body.textContent).toBe("The result is ready now.");
    expect(fadedText()).toContain("now.");
    await clock.advance(139);
    expect(fadedText()).toContain("now.");
    await clock.advance(1);
    expect(highlights()).toHaveLength(0);
    expect(document.querySelectorAll("style[data-mythra-stream-fade]")).toHaveLength(0);
  });

  it("keeps the completed answer and its new tail after an earlier fade naturally expires", async () => {
    let completed = false;
    const paints: Array<{ completed: boolean; text: string; connected: boolean }> = [];
    const register = CSS.highlights.set.bind(CSS.highlights);
    // Observe the real registry at registration rather than polling a 140ms
    // cohort that can legitimately expire between hosted-runner assertions.
    vi.spyOn(CSS.highlights, "set").mockImplementation((name, highlight) => {
      const registered = register(name, highlight);
      if (name.startsWith("mythra-stream-") && CSS.highlights.get(name) === highlight) {
        for (const range of highlight) paints.push({ completed, text: (range as Range).toString(),
          connected: (range as Range).startContainer.isConnected && (range as Range).endContainer.isConnected });
      }
      return registered;
    });
    const history: ChatMessage[] = [
      { id: "prompt", role: "user", text: "Build it", timelineOrder: 1, turnId: "turn" },
      { id: "progress", role: "assistant", text: "Preparing the changes", timelineOrder: 2, turnId: "turn" },
    ];
    const view = render(<ActivityShell history={history} text="The result" />);
    view.rerender(<ActivityShell history={history} text="The result is ready" />);
    await vi.waitFor(() => expect(paints.some((paint) => paint.connected && paint.text.length > 0)).toBe(true));
    const body = liveBody(view.container);
    const prefix = body.querySelector("p")!.firstChild;
    // The provider may finish after the previous 140ms decoration has ended.
    await vi.waitFor(() => {
      expect(body.textContent).toBe("The result is ready");
      expect(highlights()).toHaveLength(0);
    });
    completed = true;
    view.rerender(<ActivityShell history={history} text="The result is ready now." streaming={false} />);
    expect(view.container.querySelector('[data-step-id="progress"]')).not.toBeNull();
    expect(liveBody(view.container)).toBe(body);
    expect(body.querySelector("p")!.firstChild).toBe(prefix);
    expect(body.textContent).toBe("The result is ready");
    await vi.waitFor(() => expect(body.textContent).toBe("The result is ready now."));
    expect(paints.some((paint) => paint.completed && paint.connected && paint.text.length > 0)).toBe(true);
    expect(body.querySelector("p")!.firstChild).toBe(prefix);
    await vi.waitFor(() => {
      expect(highlights()).toHaveLength(0);
      expect(document.querySelectorAll("style[data-mythra-stream-fade]")).toHaveLength(0);
    });
  });
});
