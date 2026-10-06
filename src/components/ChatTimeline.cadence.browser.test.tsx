import { StrictMode, useRef, useState } from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AssistantMessageMarkdown } from "./ChatTimeline";
import { ActivityDetailsModal } from "./ActivityDetailsModal";
import trace from "../test/fixtures/haiku45-stream-cadence.json";
import "../styles.css";

const chunks = trace.events;

function Shell({ text, streaming = true }: { text: string; streaming?: boolean }) {
  const sourceRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);
  return <StrictMode><div className="app-shell" data-theme="kiwi" style={{ height: 300, width: 720 }}>
    <div ref={sourceRef} />
    {open && <ActivityDetailsModal sourceRef={sourceRef} onClose={() => setOpen(false)}
      run={{ state: streaming ? "running" : "completed", entries: [{ kind: "message", value: {
        id: "live", role: "assistant", phase: "final", text, streaming,
      } }] }}
      renderMessage={(message) => <AssistantMessageMarkdown text={message.text} streaming={Boolean(message.streaming)} />}
      renderSubAgents={() => null} />}
  </div></StrictMode>;
}

describe("stream cadence replay", () => {
  it("measures frame-by-frame presentation of bursty text", async () => {
    let now = 1200;
    let nextId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.set(++nextId, callback); return nextId; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
    const view = render(<Shell text={chunks[0].text} />);
    const body = view.container.querySelector<HTMLElement>(".rich-markdown")!;
    const scroller = view.container.querySelector<HTMLElement>(".activity-details-scroll")!;
    let index = 1; let text = chunks[0].text; let previousLength = body.textContent!.length; let previousInk = previousLength; let previousScroll = scroller.scrollTop;
    const samples: Array<{ at: number; added: number; ink: number; scroll: number }> = [];
    for (let elapsed = 0; elapsed < chunks.at(-1)!.at + 700; elapsed += 1000 / 60) {
      now = 1200 + elapsed;
      await act(async () => {
        const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(now));
        while (index < chunks.length && chunks[index].at <= elapsed) text += chunks[index++].text;
        view.rerender(<Shell text={text} streaming={index < chunks.length} />);
      });
      const length = body.textContent!.length;
      let ink = length;
      for (const [name, highlight] of CSS.highlights) {
        if (!name.startsWith("mythra-stream-")) continue;
        for (const abstract of highlight) {
          const range = abstract as Range;
          const color = getComputedStyle(range.startContainer.parentElement!, `::highlight(${name})`).color;
          const alpha = Number(color.match(/\/ ([\d.]+)\)/)?.[1] ?? 1);
          ink -= range.toString().length * (1 - alpha);
        }
      }
      samples.push({ at: Math.round(elapsed), added: length - previousLength, ink: ink - previousInk, scroll: scroller.scrollTop - previousScroll });
      previousLength = length; previousInk = ink; previousScroll = scroller.scrollTop;
    }
    // Before pacing: 187 chars, ~161 opacity-equivalent chars, 81 px, 24 updates.
    // These are repeatable perceptual proxies, not a claim that software can
    // decide whether an animation feels pleasant. Include immediate completion
    // on the last delta so the final tail cannot evade the burst limit.
    expect(view.container.querySelector<HTMLDialogElement>("dialog")?.open).toBe(true);
    expect(view.container.querySelector(".rich-markdown")).toBe(body);
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
    expect(samples.some((sample) => sample.scroll > 0)).toBe(true);
    expect(Math.max(...samples.map(s => s.added))).toBeLessThanOrEqual(35);
    expect(Math.max(...samples.map(s => s.ink))).toBeLessThanOrEqual(45);
    expect(Math.max(...samples.map(s => Math.abs(s.scroll)))).toBeLessThanOrEqual(50);
    expect(samples.filter(s => s.added > 0).length).toBeGreaterThan(120);
    expect(samples.filter(s => s.added > 0).length).toBeLessThan(245);
    view.rerender(<Shell text={text} streaming={false} />);
    expect(body.textContent).toContain("resource independence");
    expect(frames.size).toBe(0);
    expect(document.querySelectorAll("style[data-mythra-stream-fade]")).toHaveLength(0);
  });
});
