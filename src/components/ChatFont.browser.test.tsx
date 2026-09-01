import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatFont } from "../types";
import "../styles.css";

/**
 * The chat typeface is delivered entirely by CSS: the shell carries
 * `data-chat-font`, and a single custom property reaches chat prose and the
 * composer. jsdom resolves no cascade and no custom properties, so the scoping
 * promise — chat text changes, the surrounding interface does not, and code
 * stays monospaced — can only be checked in a real engine.
 *
 * The markup below is a stand-in for the shell rather than the components
 * themselves: what is under test is which selectors the stylesheet applies to.
 */
function Shell({ font }: { font: ChatFont }) {
  return (
    <div className="app-shell" data-chat-font={font}>
      <nav className="settings-nav"><button data-testid="nav-button">Settings</button></nav>
      <div className="message">
        <div className="message-body" data-testid="prose">
          <div className="message-actions"><button data-testid="message-action">Copy</button></div>
          <div className="message-text rich-markdown">
            <p data-testid="paragraph">A sentence of chat prose.</p>
            <p><code data-testid="inline-code">npm run dev</code></p>
            <div className="code-block">
              <button className="code-copy" data-testid="code-copy">Copy</button>
              <pre data-testid="code-block"><code>const answer = 42;</code></pre>
            </div>
          </div>
        </div>
      </div>
      <div className="composer-zone">
        <div className="composer">
          <div className="composer-input-wrap">
            <div className="composer-input-highlight" data-testid="highlight" />
            <textarea data-testid="composer" defaultValue="A drafted message." />
          </div>
        </div>
      </div>
    </div>
  );
}

function fontOf(testId: string) {
  const node = document.querySelector(`[data-testid="${testId}"]`);
  return getComputedStyle(node as Element).fontFamily;
}

describe("chat typeface scoping", () => {
  it("leaves every surface on the interface stack by default", () => {
    render(<Shell font="system" />);

    expect(fontOf("prose")).toContain("Inter");
    expect(fontOf("composer")).toContain("Inter");
    expect(fontOf("highlight")).toContain("Inter");
    expect(fontOf("nav-button")).toContain("Inter");
    expect(fontOf("message-action")).toContain("Inter");
    expect(fontOf("code-copy")).toContain("Inter");
  });

  it.each([
    ["humanist" as const, "Seravek"],
    ["serif" as const, "Charter"],
  ])("restyles chat prose and the composer for %s without touching the interface", (font, family) => {
    render(<Shell font={font} />);

    expect(fontOf("prose")).toContain(family);
    expect(fontOf("paragraph")).toContain(family);
    expect(fontOf("composer")).toContain(family);
    // The overlay must track the textarea exactly or the highlight drifts.
    expect(fontOf("highlight")).toBe(fontOf("composer"));
    // Navigation, settings, and controls keep the interface typeface.
    expect(fontOf("nav-button")).not.toContain(family);
    expect(fontOf("nav-button")).toContain("Inter");
    expect(fontOf("message-action")).not.toContain(family);
    expect(fontOf("message-action")).toContain("Inter");
    expect(fontOf("code-copy")).not.toContain(family);
  });

  it.each(["system", "humanist", "serif", "mono"] as const)("keeps code monospaced under %s", (font) => {
    render(<Shell font={font} />);

    expect(fontOf("inline-code")).toContain("monospace");
    expect(fontOf("code-block")).toContain("monospace");
  });

  it("puts prose on the monospace stack only when that is the choice", () => {
    render(<Shell font="mono" />);

    expect(fontOf("prose")).toContain("monospace");
    expect(fontOf("composer")).toContain("monospace");
    expect(fontOf("nav-button")).not.toContain("monospace");
    expect(fontOf("message-action")).not.toContain("monospace");
    expect(fontOf("code-copy")).not.toContain("monospace");
  });
});
