import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { ThreadTitle, THREAD_TITLE_REVEAL_MS } from "./ThreadTitle";
import { ThreadInboxCard } from "./ThreadInboxCard";
import "../styles.css";

describe("generated title fog", () => {
  it.each([[false, "dark"], [true, "dark"], [false, "light"], [true, "light"]] as const)("obscures the prompt and settles without layout shift (reduced motion %s, %s)", async (reduced, scheme) => {
    await commands.setStreamTestReducedMotion(reduced);
    const card = (pending: boolean) => <div className="app-shell" data-color-scheme={scheme} style={{ display: "block", width: 230 }}><ThreadInboxCard
      threadId="fog" title={pending ? "Private raw prompt must not flash" : "Fix sidebar scrolling"} titlePending={pending}
      workspaceName="Project" directory="/projects/sample" provider="openai" providerName="OpenAI" pinned onOpen={() => {}} /></div>;
    const view = render(card(true));
    const button = view.getByRole("button", { name: "Open Generating title" });
    expect(button.textContent).not.toContain("Private raw prompt");
    const start = button.getBoundingClientRect();
    const text = view.container.querySelector<HTMLElement>(".thread-title")!;
    expect(text.dataset.state).toBe("pending");
    view.rerender(card(false));
    expect(text.dataset.state).toBe("revealing");
    await act(() => new Promise((resolve) => setTimeout(resolve, THREAD_TITLE_REVEAL_MS + 60)));
    expect(text.dataset.state).toBe("settled");
    expect(text.textContent).toBe("Fix sidebar scrolling");
    expect(view.container.querySelector(".thread-title-fog")).toBeNull();
    expect(button.getBoundingClientRect().height).toBe(start.height);
    expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth);
    expect(getComputedStyle(text.querySelector(".thread-title-text")!).opacity).toBe("1");
    await commands.setStreamTestReducedMotion(false);
  });
  it("shows existing titles immediately without replaying fog", () => {
    const view = render(<ThreadTitle title="Already named" pending={false} />);
    expect(view.container.firstElementChild).toHaveAttribute("data-state", "settled");
    expect(view.container.querySelector(".thread-title-fog")).toBeNull();
  });
});
