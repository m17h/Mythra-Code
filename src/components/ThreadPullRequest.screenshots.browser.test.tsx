import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { GitBranch, PanelLeftOpen, Search } from "lucide-react";
import { ThreadPullRequestPanel } from "./ThreadPullRequestPanel";
import { ThreadPullRequestChip } from "./ThreadPullRequestChip";
import type { PullRequest, PullRequestContext, PullRequestPanelProps } from "../lib/pullRequests";
import "../styles.css";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

// Keep generated captures in the existing ignored test-artifact directory.
const OUT = "../../test-results/pr-screenshots";
const REPOSITORY = "m17h/Mythra-Code";
const BRANCH = "codex/thread-github-pr-workflow";

function context(overrides: Partial<PullRequestContext> = {}): PullRequestContext {
  return {
    repository: REPOSITORY,
    branch: BRANCH,
    defaultBranch: "main",
    headOid: "a1b2c3d",
    dirty: true,
    ahead: 3,
    behind: 1,
    pushRemote: "origin",
    permission: "write",
    mergeMethods: ["squash", "merge"],
    changedFiles: [
      "src/components/ThreadPullRequestPanel.tsx",
      "src/components/ThreadPullRequestChip.tsx",
      "src/components/thread-pull-requests.css",
      "src/components/GitPanel.tsx",
      "src/components/StudioDock.tsx",
      "src/lib/pullRequests.ts",
      "src-tauri/src/github_pr.rs",
      "src/hooks/useThreadPullRequest.ts",
    ],
    changedFileCount: 8,
    commits: ["Add the per-thread pull request panel", "Keep the narrow dock from overflowing"],
    ...overrides,
  };
}

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repository: REPOSITORY,
    number: 103,
    url: `https://github.com/${REPOSITORY}/pull/103`,
    title: "Thread the GitHub pull request workflow through the studio dock",
    body: "",
    state: "OPEN",
    isDraft: false,
    headRefName: BRANCH,
    baseRefName: "main",
    headOid: "a1b2c3d",
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    checks: [
      { name: "verify", state: "SUCCESS", url: "" },
      { name: "build", state: "IN_PROGRESS", url: "" },
    ],
    updatedAt: "2026-09-22T10:00:00Z",
    canMerge: false,
    viewerCanMerge: true,
    autoMergeAllowed: true,
    mergeMethods: ["squash", "merge"],
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
    onReady: vi.fn().mockResolvedValue(undefined),
    onCreateBranch: vi.fn().mockResolvedValue(undefined),
    onOpenWorktrees: vi.fn(),
    onOpenGitHubSettings: vi.fn(),
    ...overrides,
  };
}

/** The Git dock at a genuinely narrow drag, with its real 70px tab rail. */
function dock(width: number, scheme: string, theme: string, children: React.ReactNode) {
  return (
    <div className="app-shell" data-color-scheme={scheme} data-theme={theme} style={{ display: "block", padding: 24, background: "var(--bg)" }}>
      <aside className="studio-dock open" style={{ width, height: 760 }}>
        <div className="studio-tabs" />
        <div className="studio-panel" style={{ paddingTop: 12 }}>{children}</div>
      </aside>
    </div>
  );
}

/** A top bar carrying everything it really carries, plus the chip. */
function header(width: number, scheme: string, chip: React.ReactNode) {
  return (
    <div className="app-shell" data-color-scheme={scheme} style={{ display: "block", padding: 24, background: "var(--bg)" }}>
      <div className="main-panel" style={{ width, display: "block" }}>
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button" type="button" aria-label="Show sidebar"><PanelLeftOpen size={18} /></button>
            <div className="project-heading">
              <span>Mythra Code</span>
              <small>Thread the GitHub pull request workflow</small>
            </div>
            <button className="isolation-chip" type="button"><GitBranch size={12} /> <span>Isolated</span></button>
            {chip}
          </div>
          <div className="topbar-right">
            <button className="command-palette-trigger" type="button"><Search size={14} /><span>Search</span><kbd>⌘+K</kbd></button>
            <div className="runtime-status"><span className="status-orb ready" /><span>Ready</span></div>
            <button className="topbar-usage-chip" type="button"><span>Claude · 25% used</span></button>
            <button className="workspace-tools-trigger" type="button"><span>Workspace</span><kbd>⌘+J</kbd></button>
          </div>
        </header>
      </div>
    </div>
  );
}

// Screenshots of resting layout, so the entry animations are stilled first.
beforeEach(async () => { await commands.setStreamTestReducedMotion(true); });
afterEach(async () => { await commands.setStreamTestReducedMotion(false); });

async function shoot(name: string) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

describe("thread pull request — screenshots", () => {
  it("captures the merge confirmation in a narrow dark dock", async () => {
    const view = render(dock(360, "dark", "mythra", <ThreadPullRequestPanel {...panelProps({ linked: true, pullRequest: pullRequest() })} />));
    fireEvent.click(screen.getByRole("button", { name: /merge…/i }));
    await shoot("01-merge-narrow-dark");
    expect(view.container.querySelector(".thread-pr-editor.confirm")).toBeTruthy();
  });

  it("captures the create editor with its change review in a narrow light dock", async () => {
    const view = render(dock(360, "light", "mythra", <ThreadPullRequestPanel {...panelProps()} />));
    fireEvent.click(screen.getByRole("button", { name: /create a pull request/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /commit every change in this folder first/i }));
    await shoot("02-create-narrow-light");
    expect(view.container.querySelector(".thread-pr-review")).toBeTruthy();

    // ...and again with the optional detail opened, to prove it still fits.
    fireEvent.click(screen.getByRole("button", { name: /uncommitted files/i }));
    await shoot("09-create-detail-expanded");
    expect(view.container.querySelector(".thread-pr-review-body")).toBeTruthy();
  });

  it("captures a draft with the mark-ready confirmation", async () => {
    const view = render(dock(400, "dark", "midnight", <ThreadPullRequestPanel {...panelProps({ linked: true, pullRequest: pullRequest({ isDraft: true }) })} />));
    fireEvent.click(screen.getByRole("button", { name: /mark ready…/i }));
    await shoot("03-mark-ready-midnight");
    expect(view.container.querySelector("[aria-label='Confirm mark ready for review']")).toBeTruthy();
  });

  it("captures a blocked merge with no permission", async () => {
    const view = render(dock(360, "dark", "mythra", <ThreadPullRequestPanel {...panelProps({
      linked: true,
      pullRequest: pullRequest({ viewerCanMerge: false, autoMergeAllowed: false }),
    })} />));
    fireEvent.click(screen.getByRole("button", { name: /merge…/i }));
    await shoot("04-merge-no-permission");
    expect(view.container.querySelector(".thread-pr-blockers.hard")).toBeTruthy();
  });

  it("captures the unattached state with a cross-repository candidate", async () => {
    render(dock(360, "dark", "mythra", <ThreadPullRequestPanel {...panelProps({
      linked: false,
      pullRequest: pullRequest({ repository: "upstream-org/mythra-code", number: 5501 }),
    })} />));
    await shoot("05-candidate-unattached");
    expect(screen.getByRole("button", { name: "Attach to this thread" })).toBeTruthy();
  });

  it("captures the crowded header chip at a wide and a narrow chat column", async () => {
    const wide = render(header(1200, "dark", <ThreadPullRequestChip repository={REPOSITORY} pullRequest={pullRequest()} linked onClick={vi.fn()} />));
    await shoot("06-header-wide");
    wide.unmount();

    const narrow = render(header(680, "dark", <ThreadPullRequestChip repository={REPOSITORY} pullRequest={pullRequest()} linked onClick={vi.fn()} />));
    await shoot("07-header-narrow");
    const chip = narrow.container.querySelector<HTMLElement>(".thread-pr-chip")!;
    expect(getComputedStyle(chip.querySelector("span")!).display).toBe("none");
    narrow.unmount();

    const light = render(header(1200, "light", <ThreadPullRequestChip repository={REPOSITORY} pullRequest={pullRequest({ isDraft: true })} linked={false} onClick={vi.fn()} />));
    await shoot("08-header-candidate-light");
    light.unmount();
  });
});
