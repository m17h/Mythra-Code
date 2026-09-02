import { StrictMode } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatTimeline } from "./ChatTimeline";
import type { ChatMessage, Provider } from "../types";
import "../styles.css";

const highlights = () => [...CSS.highlights.entries()].filter(([name]) => name.startsWith("mythra-stream-"));
const fadedText = () => highlights().flatMap(([, highlight]) => [...highlight].map((range) => (range as Range).toString())).join("");
function Shell({ text, streaming = true, provider = "claude", history = [] }: {
  text: string; streaming?: boolean; provider?: Provider; history?: ChatMessage[];
}) {
  return <StrictMode><div className="app-shell" data-theme="kiwi" style={{ height: 600 }}>
    <ChatTimeline provider={provider} activities={[]} running={streaming} thinkingLabel="Working"
      messages={[...history, { id: "live", role: "assistant", text, streaming, timelineOrder: 999, turnId: "turn", turnStatus: streaming ? "inProgress" : "completed" }]} />
  </div></StrictMode>;
}

afterEach(() => {
  cleanup();
  expect(highlights()).toHaveLength(0);
  expect(document.querySelectorAll("style[data-mythra-stream-fade]")).toHaveLength(0);
});

describe("live Markdown paint integration", () => {
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
    const view = render(<Shell history={history} text="Live " />);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const scroller = view.container.querySelector<HTMLElement>(".flow-timeline")!;
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
    fireEvent.wheel(scroller, { deltaY: -300 });
    scroller.scrollTop = 150;
    fireEvent.scroll(scroller);
    view.rerender(<Shell history={history} text={`Live ${"new words ".repeat(80)}`} />);
    await vi.waitFor(() => expect(highlights().length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(view.container.querySelector(".message.assistant .rich-markdown")?.textContent).toBe(`Live ${"new words ".repeat(80)}`.trimEnd()));
    await vi.waitFor(() => expect(highlights()).toHaveLength(0));
    expect(scroller.scrollTop).toBe(150);
    const rows = [...scroller.querySelectorAll<HTMLElement>(".timeline-entry")].map((row) => row.getBoundingClientRect());
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

  it("keeps the final answer mounted when completed-turn compaction hides progress updates", async () => {
    const history: ChatMessage[] = [
      { id: "prompt", role: "user", text: "Build it", timelineOrder: 1, turnId: "turn" },
      { id: "progress", role: "assistant", text: "Preparing the changes", timelineOrder: 2, turnId: "turn" },
    ];
    const view = render(<Shell history={history} text="The result" />);
    view.rerender(<Shell history={history} text="The result is ready" />);
    await vi.waitFor(() => expect(highlights().length).toBeGreaterThan(0));
    const body = view.container.querySelectorAll(".message.assistant .rich-markdown")[1];
    expect(body).toBeDefined();
    view.rerender(<Shell history={history} text="The result is ready now." streaming={false} />);
    expect(view.container.querySelectorAll(".message.assistant .rich-markdown")).toHaveLength(1);
    expect(view.container.querySelector(".message.assistant .rich-markdown")).toBe(body);
    expect(highlights().length).toBeGreaterThan(0);
  });
});
