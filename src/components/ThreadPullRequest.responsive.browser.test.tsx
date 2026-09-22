import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { ThreadPullRequestPanel } from "./ThreadPullRequestPanel";
import { ThreadPullRequestChip } from "./ThreadPullRequestChip";
import type { PullRequest, PullRequestContext, PullRequestPanelProps } from "../lib/pullRequests";
import "../styles.css";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

// Deliberately awkward content: a long owner/name, a long branch and a long
// title are the real shapes that break a 360px dock.
const LONG_REPOSITORY = "some-long-organisation-name/mythra-code-desktop-application";
const LONG_BRANCH = "codex/thread-github-pull-request-workflow-with-a-very-long-name";

function context(overrides: Partial<PullRequestContext> = {}): PullRequestContext {
  return {
    repository: LONG_REPOSITORY,
    branch: LONG_BRANCH,
    defaultBranch: "main",
    headOid: "abc1234",
    dirty: true,
    ahead: 3,
    behind: 2,
    pushRemote: "origin",
    permission: "write",
    mergeMethods: ["squash", "merge", "rebase"],
    ...overrides,
  };
}

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repository: LONG_REPOSITORY,
    number: 12345,
    url: "https://github.com/owner/repo/pull/12345",
    title: "Thread the GitHub pull request workflow through the studio dock without breaking the narrow layout",
    body: "",
    state: "OPEN",
    isDraft: false,
    headRefName: LONG_BRANCH,
    baseRefName: "main",
    headOid: "abc1234",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "REVIEW_REQUIRED",
    checks: [{ name: "build", state: "IN_PROGRESS", url: "" }],
    updatedAt: "2026-09-22T10:00:00Z",
    canMerge: false,
    mergeMethods: ["squash", "merge", "rebase"],
    ...overrides,
  };
}

function panelProps(overrides: Partial<PullRequestPanelProps> = {}): PullRequestPanelProps {
  return {
    threadId: "thread-1",
    context: context(),
    pullRequest: null,
    linked: false,
    isolated: false,
    loading: false,
    busy: false,
    error: null,
    notice: null,
    mutationBlockedReason: null,
    onRefresh: vi.fn(),
    onAttach: vi.fn().mockResolvedValue(undefined),
    onDetach: vi.fn(),
    onCreate: vi.fn().mockResolvedValue(undefined),
    onMerge: vi.fn().mockResolvedValue(undefined),
    onCreateBranch: vi.fn().mockResolvedValue(undefined),
    onOpenWorktrees: vi.fn(),
    onOpenGitHubSettings: vi.fn(),
    ...overrides,
  };
}

/**
 * The Git dock at the widths a person can actually drag it to, with the real
 * structure: the dock is a grid whose first column is the 70px tab rail, so
 * this panel only ever sees the dock's width minus the rail, its border and
 * the scroll gutters.
 */
function dock(width: number, scheme: string, children: React.ReactNode) {
  return (
    <div className="app-shell" data-color-scheme={scheme} style={{ display: "block" }}>
      <aside className="studio-dock open" style={{ width }}>
        <div className="studio-tabs" />
        <div className="studio-panel">{children}</div>
      </aside>
    </div>
  );
}

// Geometry, not choreography: the entry animations move things by a few pixels
// for a moment, and this spec measures resting layout. Turning them off here
// also exercises the reduced-motion rules.
beforeEach(async () => { await commands.setStreamTestReducedMotion(true); });
afterEach(async () => { await commands.setStreamTestReducedMotion(false); });

const DOCK_WIDTHS = [360, 400, 430, 500];

describe("thread pull request panel — narrow dock", () => {
  it.each(["dark", "light"])("never overflows the dock at any draggable width in %s mode", (scheme) => {
    for (const width of DOCK_WIDTHS) {
      const view = render(dock(width, scheme, <ThreadPullRequestPanel {...panelProps({ linked: true, pullRequest: pullRequest() })} />));
      const panel = view.container.querySelector<HTMLElement>(".thread-pr")!;

      expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
      for (const element of panel.querySelectorAll<HTMLElement>("*")) {
        expect(element.getBoundingClientRect().right).toBeLessThanOrEqual(panel.getBoundingClientRect().right + 0.5);
      }
      view.unmount();
    }
  });

  it("truncates a long repository, branch and title instead of widening the dock", () => {
    const view = render(dock(360, "dark", <ThreadPullRequestPanel {...panelProps({ linked: true, pullRequest: pullRequest() })} />));
    const panel = view.container.querySelector<HTMLElement>(".thread-pr")!;

    const fact = panel.querySelector<HTMLElement>(".thread-pr-fact")!;
    expect(getComputedStyle(fact).textOverflow).toBe("ellipsis");
    expect(fact.scrollWidth).toBeGreaterThan(fact.clientWidth); // it really is being clipped

    const ref = panel.querySelector<HTMLElement>(".thread-pr-refs span")!;
    expect(getComputedStyle(ref).textOverflow).toBe("ellipsis");

    // The title wraps to a bounded two lines rather than running away.
    const title = panel.querySelector<HTMLElement>(".thread-pr-title")!;
    const lineHeight = parseFloat(getComputedStyle(title).lineHeight);
    expect(title.getBoundingClientRect().height).toBeLessThanOrEqual(lineHeight * 2 + 1);
  });

  it("stacks the branch row once the dock is genuinely narrow", () => {
    const narrow = render(dock(360, "dark", <ThreadPullRequestPanel {...panelProps({ context: context({ branch: "main" }) })} />));
    const narrowRow = narrow.container.querySelector<HTMLElement>(".thread-pr-row")!;
    expect(getComputedStyle(narrowRow).flexDirection).toBe("column");
    narrow.unmount();

    const wide = render(dock(500, "dark", <ThreadPullRequestPanel {...panelProps({ context: context({ branch: "main" }) })} />));
    const wideRow = wide.container.querySelector<HTMLElement>(".thread-pr-row")!;
    expect(getComputedStyle(wideRow).flexDirection).toBe("row");
    wide.unmount();
  });

  it("keeps the create editor's fields and plan inside the dock", () => {
    const view = render(dock(360, "dark", <ThreadPullRequestPanel {...panelProps()} />));
    const panel = view.container.querySelector<HTMLElement>(".thread-pr")!;

    fireEvent.click(panel.querySelector<HTMLButtonElement>(".thread-pr-wide-button.primary")!);

    const editor = panel.querySelector<HTMLElement>(".thread-pr-editor")!;
    expect(editor.scrollWidth).toBeLessThanOrEqual(editor.clientWidth);
    for (const field of editor.querySelectorAll<HTMLElement>("input, textarea")) {
      expect(field.getBoundingClientRect().right).toBeLessThanOrEqual(editor.getBoundingClientRect().right + 0.5);
    }
  });
});

describe("thread pull request chip — crowded header", () => {
  function header(width: number, children: React.ReactNode) {
    return (
      <div className="app-shell" style={{ display: "block" }}>
        <div className="main-panel" style={{ width, display: "block" }}>
          <div className="topbar"><div className="topbar-right">{children}</div></div>
        </div>
      </div>
    );
  }

  it("keeps its number at a comfortable chat width", () => {
    const view = render(header(1100, <ThreadPullRequestChip repository={LONG_REPOSITORY} pullRequest={pullRequest()} linked onClick={vi.fn()} />));
    const chip = view.container.querySelector<HTMLElement>(".thread-pr-chip")!;
    const label = chip.querySelector<HTMLElement>("span")!;

    expect(getComputedStyle(label).display).not.toBe("none");
    expect(chip.scrollWidth).toBeLessThanOrEqual(chip.clientWidth);
    expect(chip.offsetWidth).toBeLessThanOrEqual(132);
  });

  it("drops to an icon on the same breakpoint the other header chips use", () => {
    const view = render(header(700, <ThreadPullRequestChip repository={LONG_REPOSITORY} pullRequest={pullRequest()} linked onClick={vi.fn()} />));
    const chip = view.container.querySelector<HTMLElement>(".thread-pr-chip")!;

    expect(getComputedStyle(chip.querySelector<HTMLElement>("span")!).display).toBe("none");
    // Square, and still a comfortable target rather than a shrunken one.
    expect(chip.offsetWidth).toBe(chip.offsetHeight);
    expect(chip.offsetWidth).toBeGreaterThanOrEqual(28);
    // The description stays, so the icon is never an unlabelled mystery.
    expect(chip.getAttribute("aria-label")).toContain("#12345");
  });

  it("does not push the other header controls out of the bar", () => {
    const view = render(header(700, <>
      <ThreadPullRequestChip repository={LONG_REPOSITORY} pullRequest={pullRequest()} linked onClick={vi.fn()} />
      <button className="topbar-usage-chip" type="button"><span>25% used</span></button>
    </>));
    const bar = view.container.querySelector<HTMLElement>(".topbar")!;
    const chip = view.container.querySelector<HTMLElement>(".thread-pr-chip")!;

    expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth);
    expect(chip.getBoundingClientRect().right).toBeLessThanOrEqual(bar.getBoundingClientRect().right + 0.5);
  });
});
