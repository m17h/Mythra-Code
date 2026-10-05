import type { CSSProperties } from "react";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { Composer, resetDraftStoreForTests } from "./Composer";
import type { QueuedTurn } from "../lib/taskStore";
import { themeColorScheme } from "../lib/appConfig";
import "../styles.css";
import "../styles/lumen/index.css";

const cases = [
  { name: "queued only", queue: true, thread: false, newThread: false },
  { name: "thread schedule only", queue: false, thread: true, newThread: false },
  { name: "new-conversation schedule only", queue: false, thread: false, newThread: true },
  { name: "both scheduled scopes", queue: false, thread: true, newThread: true },
  { name: "queue and thread schedule", queue: true, thread: true, newThread: false },
  { name: "queue and new-conversation schedule", queue: true, thread: false, newThread: true },
  { name: "queue and both scheduled scopes", queue: true, thread: true, newThread: true },
];

function entry(id: string, scheduled = false): QueuedTurn {
  return { id, threadId: "section-stack", text: `Prompt ${id}`, attachments: [], createdAt: Date.now(), status: "queued",
    ...(scheduled ? { deliverAt: Date.now() + 3_600_000 } : {}) };
}

function expectCleanStack(composer: HTMLElement, scopes: string[]) {
  const sections = [...composer.querySelectorAll<HTMLElement>(":scope > .queued-turns")];
  expect(sections).toHaveLength(scopes.length);
  sections.forEach((section, index) => {
    const style = getComputedStyle(section);
    expect(style.borderTopLeftRadius, `${scopes[index]} top-left corner`).toBe(index === 0 ? "26px" : "0px");
    expect(style.borderTopRightRadius, `${scopes[index]} top-right corner`).toBe(index === 0 ? "26px" : "0px");
    expect(style.borderBottomLeftRadius).toBe("0px");
    expect(style.borderBottomRightRadius).toBe("0px");
    if (index) {
      const previous = sections[index - 1].getBoundingClientRect();
      const current = section.getBoundingClientRect();
      expect(Math.abs(current.top - previous.bottom)).toBeLessThanOrEqual(1);
      expect(Math.abs(current.left - previous.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(current.right - previous.right)).toBeLessThanOrEqual(1);
    }
  });
  expect(sections.map((section) => section.dataset.scope ?? "queue")).toEqual(scopes);
  const input = composer.querySelector<HTMLElement>(":scope > .composer-input-wrap")!;
  expect(sections.at(-1)!.getBoundingClientRect().bottom).toBeLessThanOrEqual(input.getBoundingClientRect().top + 1);
}

beforeEach(() => {
  localStorage.clear();
  resetDraftStoreForTests();
});

it.each(cases.flatMap((scenario) => (["mythra", "light-mythra"] as const).map((theme) => ({ ...scenario, theme }))))(
  "keeps a clean contiguous stack for $name in $theme",
  async ({ queue, thread, newThread, theme }) => {
    for (const width of [360, 640]) {
      for (const scale of [1, 1.5]) {
        const onRemoveQueued = vi.fn();
        const onRetryQueued = vi.fn();
        const timedActions = { onReschedule: vi.fn(() => true), onRelease: vi.fn(() => true), onRemove: vi.fn() };
        const newThreadActions = { onReschedule: vi.fn(() => true), onRelease: vi.fn(() => true), onRemove: vi.fn() };
        const fixture = (includeQueue = queue, includeThread = thread) => <div className="app-shell" data-theme={theme} data-color-scheme={themeColorScheme(theme)}
          style={{ display: "block", width, height: "auto", zoom: scale, "--ui-scale": scale } as CSSProperties}>
          <Composer threadKey={`section-stack-${theme}-${width}-${scale}`} chatFont="system" running={false} queueing={false} canSteer={false}
            dropActive={false} placeholder="Immediate draft" attachments={[]} controls={null}
            queuedTurns={[...(includeQueue ? [entry("queued"), entry("queued-second")] : []), ...(includeThread ? [entry("scheduled", true)] : [])]}
            newThreadPrompts={newThread ? [entry("new-conversation", true)] : []}
            timedActions={timedActions} newThreadActions={newThreadActions}
            onRemoveQueued={onRemoveQueued} onRetryQueued={onRetryQueued}
            onRemoveAttachment={() => {}} onPasteImages={() => {}} onSend={async () => true} onSteer={async () => true} onStop={() => {}} />
        </div>;
        const view = render(fixture());
        try {
          const composer = view.container.querySelector<HTMLElement>(".composer")!;
          const scopes = [...(queue ? ["queue"] : []), ...(thread ? ["thread"] : []), ...(newThread ? ["new-thread"] : [])];
          expectCleanStack(composer, scopes);
          if (queue) {
            expect(screen.getByRole("list", { name: "Queued follow-up messages" })).toHaveTextContent("Prompt queued");
            expect(composer.querySelector(".queued-turns-heading")).toHaveTextContent("2 queued");
          }
          const capture = queue && thread && !newThread && width === 640 && scale === 1;
          if (capture) await page.screenshot({ element: composer, path: `../../test-results/pr-screenshots/composer-queue-before-schedule-${theme}-collapsed.png` });
          for (const scope of ["thread", "new-thread"]) {
            const section = composer.querySelector<HTMLElement>(`.scheduled-prompts[data-scope="${scope}"]`);
            if (!section) continue;
            const toggle = within(section).getByRole("button");
            expect(toggle).toHaveTextContent("1 prompt");
            expect(toggle).toHaveAttribute("aria-expanded", "false");
            await userEvent.click(toggle);
            expect(toggle).toHaveAttribute("aria-expanded", "true");
            expect(within(section).getByRole("list")).toBeVisible();
            expectCleanStack(composer, scopes);
          }
          if (capture) await page.screenshot({ element: composer, path: `../../test-results/pr-screenshots/composer-queue-before-schedule-${theme}-expanded.png` });
          if (queue) {
            await userEvent.click(screen.getByRole("button", { name: "Start queued message 1" }));
            expect(onRetryQueued).toHaveBeenCalledExactlyOnceWith("queued");
            await userEvent.click(screen.getByRole("button", { name: "Remove queued message 1" }));
            expect(onRemoveQueued).toHaveBeenCalledExactlyOnceWith("queued");
          }
          if (thread) {
            await userEvent.click(screen.getByRole("button", { name: "Queue now scheduled prompt 1" }));
            expect(timedActions.onRelease).toHaveBeenCalledExactlyOnceWith("scheduled");
          }
          if (newThread) {
            await userEvent.click(screen.getByRole("button", { name: "Start now new conversation 1" }));
            expect(newThreadActions.onRelease).toHaveBeenCalledExactlyOnceWith("new-conversation");
          }
          let visibleScopes = scopes;
          if (queue && (thread || newThread)) {
            // A completed/removed queue reveals the schedules as the card's
            // outer top edge, without resetting the user's expanded state.
            view.rerender(fixture(false));
            visibleScopes = scopes.filter((scope) => scope !== "queue");
            expectCleanStack(composer, visibleScopes);
            expect(screen.queryByRole("list", { name: "Queued follow-up messages" })).toBeNull();
            for (const toggle of composer.querySelectorAll<HTMLButtonElement>(".scheduled-prompts-toggle")) expect(toggle).toHaveAttribute("aria-expanded", "true");
          }
          for (const toggle of composer.querySelectorAll<HTMLButtonElement>(".scheduled-prompts-toggle")) {
            await userEvent.click(toggle);
            expect(toggle).toHaveAttribute("aria-expanded", "false");
            expectCleanStack(composer, visibleScopes);
          }
          if (thread && newThread) {
            view.rerender(fixture(false, false));
            expectCleanStack(composer, ["new-thread"]);
          }
        } finally {
          view.unmount();
        }
      }
    }
  },
);
