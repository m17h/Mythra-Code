import { render } from "@testing-library/react";
import { commands } from "vitest/browser";
import { afterEach, expect, it } from "vitest";
import { SubAgentRelayCard } from "./ChatTimeline";
import "../styles.css";

afterEach(async () => { await commands.setStreamTestReducedMotion(false); });

it.each([48, 104])("keeps the relay light inside a %ipx card without changing layout", async (height) => {
  await commands.setStreamTestReducedMotion(false);
  const view = render(<div className="app-shell" data-theme="kiwi">
    <SubAgentRelayCard activity={{ id: "relay", kind: "agent", title: "Review", status: "inProgress",
      agent: { action: "spawn", provider: "claude", task: "Review the changes" } }} />
  </div>);
  const card = view.container.querySelector<HTMLElement>(".subagent-relay-card")!;
  card.style.height = `${height}px`;
  const animations = card.getAnimations({ subtree: true });
  for (const animation of animations) {
    animation.pause();
    if ((animation as CSSAnimation).animationName === "sa-pop") animation.finish();
  }
  const comet = animations.find((animation) => (animation as CSSAnimation).animationName === "relay-comet")!;
  expect(comet).toBeDefined();
  const geometry = card.getBoundingClientRect().toJSON();
  for (const [phase, progress] of [[0.1, 0.07], [0.48, 0.84], [0.58, 1]]) {
    comet.currentTime = phase * 2600;
    const style = getComputedStyle(card, "::after");
    const travel = parseFloat(style.height) - 24;
    expect(new DOMMatrixReadOnly(style.transform).m42).toBeCloseTo(travel * progress, 1);
    expect(card.getBoundingClientRect().toJSON()).toEqual(geometry);
  }
  await commands.setStreamTestReducedMotion(true);
  expect(getComputedStyle(card, "::after").display).toBe("none");
  expect(card.getBoundingClientRect().toJSON()).toEqual(geometry);
});
