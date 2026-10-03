import { render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { ThreadInboxCard } from "./ThreadInboxCard";
import "../styles.css";
import "../styles/lumen/index.css";

beforeEach(async () => { await commands.setStreamTestReducedMotion(true); });
afterEach(async () => { await commands.setStreamTestReducedMotion(false); });

it.each([
  ["mythra", "dark"], ["light-mythra", "light"],
  ["atari", "light"], ["synthwave", "dark"],
])("uses quiet selection without left-edge bars in %s", (theme, scheme) => {
  const view = render(<div className="app-shell" data-theme={theme} data-color-scheme={scheme} style={{ display: "block" }}>
    <div className="workspace-row-wrap active"><button className="workspace-row">Selected project</button></div>
    <button className="workspace-row chat active">Chats</button>
    <div className="thread-row-wrap active" style={{ width: 280 }}>
      <ThreadInboxCard threadId="selected-preview" title="Selected thread" workspaceName="Project" directory="/project" provider="claude" providerName="Claude" pinned={false} onOpen={() => {}} />
    </div>
    <div className="thread-row-wrap" style={{ width: 280 }}>
      <ThreadInboxCard threadId="other-preview" title="Other thread" workspaceName="Project" directory="/project" provider="claude" providerName="Claude" pinned={false} onOpen={() => {}} />
    </div>
  </div>);
  for (const row of view.container.querySelectorAll(".workspace-row-wrap.active, .workspace-row.chat.active, .thread-row-wrap.active")) {
    expect(getComputedStyle(row, "::before").content).toBe("none");
  }
  const cards = view.container.querySelectorAll(".thread-card");
  const selected = getComputedStyle(cards[0]);
  const resting = getComputedStyle(cards[1]);
  expect(selected.backgroundColor).not.toBe(resting.backgroundColor);
  expect(selected.borderTopColor).not.toBe(resting.borderTopColor);
  expect(selected.backgroundImage).toBe("none");
  expect(selected.boxShadow).toBe("none");
  view.unmount();
});
