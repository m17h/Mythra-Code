import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
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

  it("keeps the number in a narrow header, and sheds the least useful part instead", () => {
    // Changed deliberately. The chip used to become an icon here, which left
    // it saying only "there is a pull request somewhere" — and the number is
    // the one thing anyone scans a header for.
    const view = render(header(700, <ThreadPullRequestChip repository={LONG_REPOSITORY} pullRequest={pullRequest()} onClick={vi.fn()} linked={false} />));
    const chip = view.container.querySelector<HTMLElement>(".thread-pr-chip")!;

    expect(getComputedStyle(chip.querySelector<HTMLElement>("span")!).display).not.toBe("none");
    expect(chip.textContent).toContain("#12345");
    // The "found" tag is what goes: the dashed border and the description
    // already carry that state.
    expect(getComputedStyle(chip.querySelector<HTMLElement>("em")!).display).toBe("none");
    expect(chip.getAttribute("aria-label")).toContain("#12345");
    expect(chip.scrollWidth).toBeLessThanOrEqual(chip.clientWidth);
  });

  it("still collapses to an icon when there is no number to keep", () => {
    const view = render(header(700, <ThreadPullRequestChip repository={LONG_REPOSITORY} pullRequest={null} linked={false} onClick={vi.fn()} />));
    const chip = view.container.querySelector<HTMLElement>(".thread-pr-chip")!;

    expect(getComputedStyle(chip.querySelector<HTMLElement>("span")!).display).toBe("none");
    // Square, and still a comfortable target rather than a shrunken one.
    expect(chip.offsetWidth).toBe(chip.offsetHeight);
    expect(chip.offsetWidth).toBeGreaterThanOrEqual(28);
    // The description stays, so the icon is never an unlabelled mystery.
    expect(chip.getAttribute("aria-label")).toContain("No pull request is linked");
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


describe("merge help in the real dock", () => {
  it.each(["dark", "light"])("stays readable and independent from the radios in %s mode", async (scheme) => {
    const props = panelProps({ linked: true, pullRequest: pullRequest({ viewerCanMerge: true }) });
    const view = render(dock(360, scheme, <ThreadPullRequestPanel {...props} />));
    await page.getByRole("button", { name: "Merge on GitHub…" }).click();
    const label = "What “Rebase and merge” does";
    const help = page.getByRole("button", { name: label });
    await help.hover();
    expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-expanded", "true");
    const bubble = screen.getByText(/They get new commit IDs/);
    await page.getByText(/They get new commit IDs/).hover();
    expect(bubble).toBeVisible();
    const rect = bubble.getBoundingClientRect();
    const panel = view.container.querySelector<HTMLElement>(".studio-panel")!;
    const bounds = panel.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
    expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
    expect(bubble.scrollWidth).toBeLessThanOrEqual(bubble.clientWidth + 1);
    expect(screen.getByRole("radio", { name: "Squash and merge" })).toBeChecked();
    await help.click();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("group", { name: "Confirm merge" })).toBeVisible();
    expect(props.onMerge).not.toHaveBeenCalled();
    await help.click();
    await page.screenshot({ path: `../../test-results/pr-screenshots/merge-help-${scheme}.png` });
  });
});
