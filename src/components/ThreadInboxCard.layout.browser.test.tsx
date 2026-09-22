import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { ThreadInboxCard } from "./ThreadInboxCard";
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
