import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { GitPanel, type GitPanelProps } from "./GitPanel";
import { StudioDock } from "./StudioDock";
import { CommandPalette } from "./CommandPalette";
import { THEMES, themeColorScheme } from "../lib/appConfig";
import { EMPTY_REVIEW_DIFF } from "../lib/gitDiff";
import type { GitChange, ProjectGitChanges } from "../lib/gitInspection";
import type { GitWorkflowControls } from "../lib/gitWorkspace";
import type { ProjectGitInspection, ProjectPullRequestAccess } from "../lib/projectGit";
import type { PullRequest, PullRequestSummary } from "../lib/pullRequests";
import "../styles.css";

afterEach(async () => { await commands.setStreamTestReducedMotion(false); });

let counter = 0;
const cwd = (name: string) => `/browser-git/${name}-${counter += 1}`;
const LONG_DIR = "packages/some-deeply-nested-workspace/src/components/really/long/folder/names";
const ROWS: GitChange[] = [
  { path: `${LONG_DIR}/AnExtremelyLongComponentFileNameThatMustTruncate.tsx`, originalPath: null, area: "staged", status: "M" },
  { path: "docs/renamed guide.md", originalPath: "docs/original guide.md", area: "staged", status: "R" },
  { path: `${LONG_DIR}/AnExtremelyLongComponentFileNameThatMustTruncate.tsx`, originalPath: null, area: "unstaged", status: "M" },
  { path: "src/deleted.ts", originalPath: null, area: "unstaged", status: "D" },
  { path: ".github/workflows/new-check.yml", originalPath: null, area: "untracked", status: "?" },
];
const changes = (rows: GitChange[]): ProjectGitChanges => ({
  rootPath: "/p", rows, truncated: false,
  stagedFiles: rows.filter((row) => row.area === "staged").length,
  unstagedFiles: rows.filter((row) => row.area === "unstaged").length,
  untrackedFiles: rows.filter((row) => row.area === "untracked").length,
  changedFiles: new Set(rows.map((row) => row.path)).size,
});
function inspection(): ProjectGitInspection {
  return {
    cwd: cwd("changes"),
    getChanges: vi.fn().mockResolvedValue(changes(ROWS)),
    getFileDiff: vi.fn(async (_cwd: string, path: string, area) => ({
      path, area, binary: false, truncated: false,
      text: `diff --git a/${path} b/${path}\n@@ -1,3 +1,3 @@\n context line\n-${"removed ".repeat(20)}\n+${"added ".repeat(24)}\n`,
    })),
    getHistory: vi.fn(),
  };
}
const workflow = (): GitWorkflowControls => ({
  snapshot: {
    branch: "feature/a-very-long-branch-name-for-narrow-docks", headOid: "a".repeat(40), rootPath: "/p", isRoot: true,
    stagedFiles: 2, unstagedFiles: 2, changedFiles: 4, stagedPaths: [],
    branches: Array.from({ length: 14 }, (_, index) => ({ name: `feature/branch-with-a-long-name-${index}`, current: false, worktreePath: null })),
  },
  busy: false, isolated: false, onBranch: vi.fn().mockResolvedValue(true), onRefresh: vi.fn(),
});
function props(overrides: Partial<GitPanelProps> = {}): GitPanelProps {
  return {
    repositoryState: "ready", gitInitializing: false, gitOutput: "", gitCommitSuccess: "", gitCommitBusy: false,
    githubAuthenticated: true, readOnly: false, defaultRepositoryName: "repo",
    githubRepoStatus: { isRepo: true, repository: "owner/a-repository-with-a-long-name", branch: "feature/a-very-long-branch-name-for-narrow-docks", upstream: "origin/feature/a-very-long-branch-name-for-narrow-docks", ahead: 3, behind: 1 },
    workflow: workflow(), inspection: inspection(), onPathAction: vi.fn(),
    onAction: vi.fn(), onInitializeGit: vi.fn(), onGitHubAttach: vi.fn(), onGitHubCreate: vi.fn(), onOpenGitHubSettings: vi.fn(),
    ...overrides,
  };
}
function mount(input: GitPanelProps, width: number, theme = "mythra", zoom = 1) {
  return render(<div className="app-shell" data-theme={theme} data-color-scheme={themeColorScheme(theme as never)} style={{ display: "block", padding: 16, zoom }}>
    <aside className="studio-dock" style={{ width, height: 860 }}>
      <nav className="studio-tabs" aria-label="Workspace tools"><button className="active" type="button">Git</button></nav>
      <div className="studio-panel"><GitPanel {...input} /></div>
    </aside>
  </div>);
}

function luminance(color: string) {
  const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((value) => {
    const channel = value / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
const contrast = (first: string, second: string) => {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
};
function composite(color: string, background: string) {
  const channels = color.match(/[\d.]+/g)!.map(Number);
  if (color.startsWith("color(srgb")) for (let index = 0; index < 3; index++) channels[index] *= 255;
  const backdrop = background.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  const alpha = channels[3] ?? 1;
  return `rgb(${channels.slice(0, 3).map((channel, index) => channel * alpha + backdrop[index] * (1 - alpha)).join(", ")})`;
}

for (const width of [360, 520]) {
  it(`reviews, stages and previews files without overflow at ${width}px`, async () => {
    const input = props();
    const view = mount(input, width);
    const staged = await screen.findByRole("region", { name: /Staged/ });
    const row = within(staged).getByRole("button", { name: new RegExp(`^${LONG_DIR}/AnExtremely`) });
    await userEvent.click(row);
    const preview = await screen.findByRole("region", { name: new RegExp("Changes in packages/") });
    await waitFor(() => expect(within(preview).getByText(/added added/)).toBeInTheDocument());
    // Keyboard: arrows move between file rows.
    row.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toHaveAccessibleName(/docs\/renamed guide\.md, Renamed from docs\/original guide\.md/);
    await userEvent.click(within(screen.getByRole("region", { name: /Not staged/ })).getByRole("button", { name: "Stage src/deleted.ts" }));
    expect(input.onPathAction).toHaveBeenCalledWith("stage", "src/deleted.ts");
    const panel = view.container.querySelector<HTMLElement>(".studio-panel")!;
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
    const dock = view.container.querySelector(".studio-dock")!.getBoundingClientRect();
    for (const action of view.container.querySelectorAll(".git-row-action")) {
      expect(action.getBoundingClientRect().right).toBeLessThanOrEqual(dock.right + 1);
    }
    await page.getByRole("button", { name: "Switch or create a branch" }).click();
    const menu = screen.getByRole("menu", { name: "Switch or create a branch" }).getBoundingClientRect();
    expect(menu.left).toBeGreaterThanOrEqual(dock.left);
    expect(menu.right).toBeLessThanOrEqual(dock.right + 1);
    await userEvent.keyboard("{Escape}");
    await page.screenshot({ path: `../../test-results/pr-screenshots/git-changes-${width}.png` });
  });
}

it.each(THEMES)("keeps the $name Git workspace readable at 150% zoom in a narrow dock", async ({ id }) => {
  const view = mount(props(), 360, id, 1.5);
  await screen.findByRole("region", { name: /Staged/ });
  const panel = view.container.querySelector<HTMLElement>(".studio-panel")!;
  expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
  const surface = getComputedStyle(view.container.querySelector<HTMLElement>(".studio-dock")!).backgroundColor;
  for (const selector of [".git-change-name", ".git-sync-line", ".git-view-tabs > button.active", ".git-checkout-repo strong"]) {
    const node = view.container.querySelector<HTMLElement>(selector)!;
    const ink = composite(getComputedStyle(node).color, surface);
    expect(contrast(ink, surface), `${selector} in ${id}`).toBeGreaterThanOrEqual(4.5);
  }
  // The counts beside a long branch stay on screen.
  const header = view.container.querySelector(".git-checkout")!.getBoundingClientRect();
  expect(screen.getByLabelText("3 to push").getBoundingClientRect().right).toBeLessThanOrEqual(header.right + 1);
  if (id === "atari" || id === "monochrome" || id === "daylight") await page.screenshot({ path: `../../test-results/pr-screenshots/git-changes-${id}-150.png` });
});

it("honours reduced motion without removing the transitions otherwise", async () => {
  const view = mount(props(), 420);
  await screen.findByRole("region", { name: /Staged/ });
  expect(getComputedStyle(view.container.querySelector(".git-view-panel")!).animationName).toBe("git-view-in");
  await commands.setStreamTestReducedMotion(true);
  await userEvent.click(screen.getByRole("tab", { name: /History/ }));
  await userEvent.click(screen.getByRole("tab", { name: /Changes/ }));
  expect(getComputedStyle(view.container.querySelector(".git-view-panel")!).animationName).toBe("none");
  expect(getComputedStyle(view.container.querySelector(".git-view-tabs > button")!).transitionDuration).toMatch(/^0s/);
});

it("stops Git busy spinners for reduced motion and restores them otherwise", async () => {
  const view = mount(props({ gitCommitBusy: true }), 360);
  const spinner = view.container.querySelector(".git-commit-button .spin")!;
  expect(getComputedStyle(spinner).animationName).toBe("spin");
  await commands.setStreamTestReducedMotion(true);
  expect(getComputedStyle(spinner).animationName).toBe("none");
  await commands.setStreamTestReducedMotion(false);
  expect(getComputedStyle(spinner).animationName).toBe("spin");
});

it.each(["tracked", "new"] as const)("allows keyboard scrolling through a long %s file preview", async (kind) => {
  const api = inspection();
  const row: GitChange = kind === "new" ? { path: "new-file.txt", area: "untracked", status: "?", originalPath: null } : ROWS[0];
  api.getChanges = vi.fn().mockResolvedValue(changes([row]));
  api.getFileDiff = vi.fn(async (_cwd, path, area) => ({ path, area, binary: false, truncated: false, text: Array.from({ length: 400 }, (_, index) => `${kind === "new" ? "" : "+"}line ${index}`).join("\n") }));
  const view = mount(props({ inspection: api }), 360);
  const select = await screen.findByRole("button", { name: new RegExp(`^${row.path}`) });
  await userEvent.click(select);
  const preview = await screen.findByRole("region", { name: `Changes in ${row.path}` });
  await waitFor(() => expect(preview.querySelector("pre")).not.toBeNull());
  const scroll = preview.querySelector<HTMLPreElement>("pre")!;
  scroll.focus();
  expect(document.activeElement).toBe(scroll);
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
  await userEvent.keyboard("{PageDown}");
  await waitFor(() => expect(scroll.scrollTop).toBeGreaterThan(0));
  expect(view.container.querySelector<HTMLElement>(".studio-panel")!.scrollWidth).toBeLessThanOrEqual(view.container.querySelector<HTMLElement>(".studio-panel")!.clientWidth + 1);
});

it.each(["mythra", "light-mythra", "atari", "monochrome"])("keeps %s Git status and selected-row safety text readable on actual surfaces", async (theme) => {
  const view = mount(props(), 360, theme);
  const [select] = await screen.findAllByRole("button", { name: new RegExp(`^${LONG_DIR}/AnExtremely`) });
  await userEvent.click(select);
  await screen.findByRole("region", { name: new RegExp("Changes in packages/") });
  const surface = getComputedStyle(view.container.querySelector<HTMLElement>(".studio-dock")!).backgroundColor;
  const workspace = view.container.querySelector<HTMLElement>(".git-workspace")!;
  for (const selector of [".git-change-group h3", ".git-change-group > header small", ".git-change-status", ".git-change-dir", ".git-change-from", ".git-change-chip", ".git-change-meta", ".git-view-summary small"]) {
    for (const node of workspace.querySelectorAll<HTMLElement>(selector)) {
      const ancestors: HTMLElement[] = [];
      for (let parent: HTMLElement | null = node; parent && parent !== workspace; parent = parent.parentElement) ancestors.push(parent);
      const background = ancestors.reverse().reduce((color, element) => composite(getComputedStyle(element).backgroundColor, color), surface);
      expect(contrast(composite(getComputedStyle(node).color, background), background), `${theme} ${selector}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

it.each(["missing", "disabled"] as const)("focuses an accessible reason once when a remote destination is %s", async (scenario) => {
  const onFocusHandled = vi.fn();
  const input = props({
    githubRepoStatus: { isRepo: true, repository: scenario === "missing" ? null : "owner/repo", branch: "feature/work", upstream: null, ahead: 0, behind: 0 },
    focusRequest: { view: "changes", focus: scenario === "missing" ? "push" : "pull", nonce: 91 },
    onFocusHandled,
  });
  const view = mount(input, 360);
  await waitFor(() => expect(onFocusHandled).toHaveBeenCalledOnce());
  expect(document.activeElement).not.toBe(document.body);
  expect(document.activeElement).toHaveTextContent(scenario === "missing" ? /Connect a GitHub repository/ : /tracked branch/i);
  expect(input.onAction).not.toHaveBeenCalled();
  // Owner rerenders (including inspection results) must not replay the route.
  const focus = document.activeElement;
  view.rerender(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ display: "block", padding: 16 }}><aside className="studio-dock" style={{ width: 360, height: 860 }}><nav className="studio-tabs"><button type="button">Git</button></nav><div className="studio-panel"><GitPanel {...input} githubAuthenticated={false} /></div></aside></div>);
  await waitFor(() => expect(onFocusHandled).toHaveBeenCalledOnce());
  expect(document.activeElement).toBe(focus);
});

it("waits for deferred checkout reads and uses current props for a pending Push route", async () => {
  const onFocusHandled = vi.fn();
  const input = props({ repositoryState: "unknown", githubRepoStatus: null, workflow: { ...workflow(), snapshot: null }, focusRequest: { view: "changes", focus: "push", nonce: 92 }, onFocusHandled });
  const view = mount(input, 360);
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  expect(onFocusHandled).not.toHaveBeenCalled();
  const ready = props({ focusRequest: input.focusRequest, onFocusHandled });
  view.rerender(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ display: "block", padding: 16 }}><aside className="studio-dock" style={{ width: 360, height: 860 }}><nav className="studio-tabs"><button type="button">Git</button></nav><div className="studio-panel"><GitPanel {...ready} /></div></aside></div>);
  await waitFor(() => expect(onFocusHandled).toHaveBeenCalledOnce());
  expect(document.activeElement).toHaveAccessibleName("Push commits");
  expect(screen.queryByText(/Connect a GitHub repository before/)).toBeNull();
  expect(ready.onAction).not.toHaveBeenCalled();
});

it.each(["failed", "pending", "missing"] as const)("distinguishes a %s repository probe in the focused remote-route recovery", async (probe) => {
  const onFocusHandled = vi.fn();
  const input = props({
    githubRepoStatus: probe === "missing" ? { isRepo: true, repository: null, branch: "feature/work", upstream: null, ahead: 0, behind: 0 } : null,
    githubRepoError: probe === "failed" ? "Repository status could not be read: network unavailable." : undefined,
    focusRequest: { view: "changes", focus: "push", nonce: 97 }, onFocusHandled,
  });
  const view = mount(input, 360);
  await waitFor(() => expect(onFocusHandled).toHaveBeenCalledExactlyOnceWith(97));
  const notice = view.container.querySelector<HTMLElement>(".git-route-notice")!;
  expect(document.activeElement).toBe(notice);
  expect(notice).toHaveTextContent(probe === "missing" ? /Connect a GitHub repository before pushing commits/ : /GitHub connection status is unavailable/);
  if (probe !== "missing") expect(notice).not.toHaveTextContent(/Connect a GitHub repository before/);
  expect(input.onAction).not.toHaveBeenCalled();
  notice.focus();
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  expect(onFocusHandled).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(notice);
});

it("clears obsolete route notices on a valid route and a checkout change", async () => {
  const onFocusHandled = vi.fn();
  const input = props({ githubRepoStatus: { isRepo: true, repository: "owner/repo", branch: "feature/work", upstream: null, ahead: 0, behind: 0 }, focusRequest: { view: "changes", focus: "pull", nonce: 93 }, onFocusHandled });
  const wrapper = (next: GitPanelProps) => <div className="app-shell" data-theme="mythra" data-color-scheme="dark"><aside className="studio-dock" style={{ width: 360, height: 860 }}><div className="studio-panel"><GitPanel {...next} /></div></aside></div>;
  const view = render(wrapper(input));
  await waitFor(() => expect(onFocusHandled).toHaveBeenCalledOnce());
  expect(screen.getByText(/Pull needs a tracked branch/)).toBeInTheDocument();
  view.rerender(wrapper({ ...input, focusRequest: { view: "changes", focus: "commit", nonce: 94 } }));
  await waitFor(() => expect(document.activeElement).toHaveAccessibleName(/^Commit message/));
  expect(screen.queryByText(/Pull needs a tracked branch/)).toBeNull();
  view.rerender(wrapper({ ...input, focusRequest: { view: "changes", focus: "pull", nonce: 95 } }));
  await waitFor(() => expect(onFocusHandled).toHaveBeenCalledTimes(3));
  view.rerender(wrapper({ ...input, inspection: { ...input.inspection!, cwd: cwd("other-checkout") }, focusRequest: null }));
  await waitFor(() => expect(screen.queryByText(/Pull needs a tracked branch/)).toBeNull());
});

it.each([
  ["git changes", { view: "changes" }],
  ["git commit", { view: "changes", focus: "commit" }],
  ["git PR", { view: "pulls", focus: "pullRequestSearch" }],
  ["branch git", { view: "changes", focus: "branch" }],
  ["git fetch", { view: "changes", focus: "fetch" }],
  ["git pull", { view: "changes", focus: "pull" }],
  ["git push", { view: "changes", focus: "push" }],
] as const)("routes the natural browser palette query %s without executing Git", async (query, route) => {
  const onGitRoute = vi.fn(), onTool = vi.fn();
  render(<CommandPalette open projects={[]} threads={[]} workflows={[]} projectActive onClose={vi.fn()} onProject={vi.fn()} onThread={vi.fn()} onWorkflow={vi.fn()} onNewThread={vi.fn()} onSettings={vi.fn()} onTool={onTool} onGitRoute={onGitRoute} />);
  const search = screen.getByRole("textbox", { name: "Search commands, projects, and threads" });
  await userEvent.click(search);
  await userEvent.type(search, query);
  await userEvent.keyboard("{Enter}");
  expect(onGitRoute).toHaveBeenCalledExactlyOnceWith(route);
  expect(onTool).not.toHaveBeenCalled();
});

it("does not replay a pending Git route in another checkout", async () => {
  const route = { view: "changes" as const, focus: "push" as const, nonce: 96 };
  const dock = (projectPath: string, ready: boolean) => <div className="app-shell" data-theme="mythra" data-color-scheme="dark"><button type="button">Selected project</button><StudioDock
    {...({} as Parameters<typeof StudioDock>[0])}
    open tab="git" activeThread={false} reviewDiff={EMPTY_REVIEW_DIFF} projectPath={projectPath} projectName={projectPath}
    agents={[]} terminalOutput={{} as never} terminalRunning={false} terminalRunningCommand="" terminalRunningElsewhere={[]} commandsReadOnly={false}
    checkpoints={[]} attachments={[]} usage={null} accountUsage={{ label: "Usage", summary: "" }} skills={[]} mcpServers={[]}
    gitOutput="" gitCommitSuccess="" gitCommitBusy={false} gitRepositoryState={ready ? "ready" : "unknown"} gitInitializing={false}
    githubAuthenticated githubRepoStatus={ready ? { isRepo: true, repository: "owner/repo", branch: "feature/work", upstream: "origin/feature/work", ahead: 1, behind: 0 } : null}
    gitActionsReadOnly={false} defaultRepositoryName="p" promptAudit={[]} projectActions={[]} workflows={[]} workflowRuns={[]}
    gitRoute={route} onTab={vi.fn()} onClose={vi.fn()} onRefreshDiff={vi.fn()} onReview={vi.fn()} onGitAction={vi.fn()} onGitPathAction={vi.fn()}
  /></div>;
  const view = render(dock("/checkout-a", false));
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const selectedProject = screen.getByRole("button", { name: "Selected project" });
  selectedProject.focus();
  view.rerender(dock("/checkout-b", true));
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  expect(document.activeElement).toBe(selectedProject);
  expect(view.container.querySelector(".git-route-notice")).toBeNull();
});

for (const { width, zoom, reduced } of [{ width: 430, zoom: 1, reduced: false }, { width: 360, zoom: 1.5, reduced: true }, { width: 360, zoom: 1.8, reduced: false }]) {
  it.each(["pull", "push", "commit"] as const)(`keeps routed %s visible below the actual sticky dock header at ${width}px/${zoom * 100}%`, async (target) => {
    await commands.setStreamTestReducedMotion(reduced);
    const api = inspection();
    const rows: GitChange[] = Array.from({ length: 30 }, (_, index) => ({ path: `src/long-changes/file-${index}.tsx`, originalPath: null, area: "staged", status: "M" }));
    api.getChanges = vi.fn().mockResolvedValue(changes(rows));
    const onGitAction = vi.fn();
    const draftWorkflow = workflow();
    const dock = (routed: boolean, readRevision = 0) => <div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ display: "flex", height: 500 / zoom, width: width / zoom, zoom }}><StudioDock
      {...({} as Parameters<typeof StudioDock>[0])}
      open tab="git" activeThread={false} reviewDiff={EMPTY_REVIEW_DIFF} projectPath={api.cwd} projectName="p"
      agents={[]} terminalOutput={{} as never} terminalRunning={false} terminalRunningCommand="" terminalRunningElsewhere={[]} commandsReadOnly={false}
      checkpoints={[]} attachments={[]} usage={null} accountUsage={{ label: "Usage", summary: "" }} skills={[]} mcpServers={[]}
      gitOutput="" gitCommitSuccess="" gitCommitBusy={false} gitRepositoryState="ready" gitInitializing={false}
      githubAuthenticated githubRepoStatus={{ isRepo: true, repository: "owner/repo", branch: "feature/work", upstream: target === "pull" ? null : "origin/feature/work", ahead: 1, behind: 0 }}
      gitActionsReadOnly={false} defaultRepositoryName="p" promptAudit={[]} projectActions={[]} workflows={[]} workflowRuns={[]}
      projectGitInspection={api} gitWorkflow={{ ...draftWorkflow, readRevision }} gitRoute={routed ? { view: "changes", focus: target, nonce: 101 } : null}
      onTab={vi.fn()} onClose={vi.fn()} onRefreshDiff={vi.fn()} onReview={vi.fn()} onGitAction={onGitAction} onGitPathAction={vi.fn()}
    /></div>;
    const view = render(dock(false));
    const actualDock = view.container.querySelector<HTMLElement>(".studio-dock")!;
    actualDock.style.width = `${width / zoom}px`;
    actualDock.style.flexBasis = `${width / zoom}px`;
    await screen.findByRole("button", { name: /^src\/long-changes\/file-29\.tsx,/ });
    const panel = view.container.querySelector<HTMLElement>(".studio-panel")!;
    const header = view.container.querySelector<HTMLElement>(".studio-header")!;
    expect(getComputedStyle(header).position).toBe("sticky");
    panel.scrollTop = panel.scrollHeight;
    expect(panel.scrollTop).toBeGreaterThan(header.offsetHeight);
    view.rerender(dock(true));
    const destination = target === "pull" ? await screen.findByText(/Pull needs a tracked branch/) : target === "push" ? screen.getByRole("button", { name: "Push commits" }) : screen.getByRole("textbox", { name: /^Commit message/ });
    await waitFor(() => expect(document.activeElement).toBe(destination));
    const assertVisible = () => {
      expect(document.activeElement).toBe(destination);
      expect(destination.getBoundingClientRect().top).toBeGreaterThanOrEqual(header.getBoundingClientRect().bottom - 1);
      expect(destination.getBoundingClientRect().bottom).toBeLessThanOrEqual(panel.getBoundingClientRect().bottom + 1);
    };
    assertVisible();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    assertVisible();
    const priorReads = vi.mocked(api.getChanges).mock.calls.length;
    view.rerender(dock(true, 1));
    await waitFor(() => expect(vi.mocked(api.getChanges).mock.calls.length).toBeGreaterThan(priorReads));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    assertVisible();
    expect(onGitAction).not.toHaveBeenCalled();
    expect(draftWorkflow.onBranch).not.toHaveBeenCalled();
  });
}

/* ------------------------------------------------------------------ */

const summary = (number: number, overrides: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
  repository: "owner/repo", number, url: `https://github.com/owner/repo/pull/${number}`,
  title: `A long pull request title that has to truncate politely in a narrow dock #${number}`,
  state: "OPEN", isDraft: false, headRefName: `feature/very-long-pull-request-branch-${number}`, baseRefName: "main",
  updatedAt: new Date().toISOString(), authorLogin: "octo", ...overrides,
});
const detail = (number: number): PullRequest => ({
  ...summary(number), body: "Describes the change.", headOid: "a".repeat(40), mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED",
  checks: [
    { name: "a very long check name for the integration test matrix on every platform", state: "FAILURE", url: "https://github.com/owner/repo/actions/runs/1" },
    { name: "lint", state: "QUEUED", url: "" },
  ],
  canMerge: false, viewerCanMerge: true, autoMergeAllowed: true, mergeMethods: ["squash", "merge"],
});
function prAccess(): ProjectPullRequestAccess {
  return {
    cwd: cwd("prs"), projectPath: "/p", repository: "owner/repo", authenticated: true, threadActive: false, isolated: false,
    mutationBlockedReason: null, checkMutationAllowed: () => null,
    list: vi.fn().mockResolvedValue([summary(41), summary(42, { isDraft: true }), summary(43, { state: "MERGED" })]),
    view: vi.fn(async (_cwd: string, _repository: string, number: number) => detail(number)),
    context: vi.fn().mockResolvedValue({ repository: "owner/repo", branch: "feature/local-work", defaultBranch: "main", headOid: "c".repeat(40), dirty: false, ahead: 2, behind: 0, pushRemote: "origin", permission: "write", mergeMethods: ["squash"] }),
    find: vi.fn().mockResolvedValue(null),
    create: vi.fn(), merge: vi.fn(), ready: vi.fn(), createBranch: vi.fn(),
  };
}

describe("project pull requests in the dock", () => {
  it.each(["mythra", "light-mythra", "atari", "monochrome"])("keeps %s project PR labels readable on actual list and detail surfaces", async (theme) => {
    const access = prAccess();
    access.threadLink = { repository: "owner/repo", number: 41 };
    const view = mount(props({ view: "pulls", pullRequests: access }), 360, theme);
    await screen.findByRole("button", { name: /#42 A long pull request title/ });
    const surface = getComputedStyle(view.container.querySelector<HTMLElement>(".studio-dock")!).backgroundColor;
    const assertLabels = (selectors: string[]) => {
      const workspace = view.container.querySelector<HTMLElement>(".git-workspace")!;
      for (const selector of selectors) for (const node of workspace.querySelectorAll<HTMLElement>(selector)) {
        const ancestors: HTMLElement[] = [];
        for (let parent: HTMLElement | null = node; parent && parent !== workspace; parent = parent.parentElement) ancestors.push(parent);
        const background = ancestors.reverse().reduce((color, element) => composite(getComputedStyle(element).backgroundColor, color), surface);
        expect(contrast(composite(getComputedStyle(node).color, background), background), `${theme} ${selector}`).toBeGreaterThanOrEqual(4.5);
      }
    };
    assertLabels([".git-pr-row-main small", ".git-pr-row-tags em"]);
    await userEvent.click(screen.getByRole("button", { name: /#41 A long pull request title/ }));
    await screen.findByRole("list", { name: "Checks for #41" });
    assertLabels([".thread-pr-state", ".thread-pr-check-state", ".thread-pr-signals dd", ".thread-pr-fact"]);
  });

  it("lists and opens details with named checks in a 360px dock", async () => {
    const view = mount(props({ view: "pulls", pullRequests: prAccess() }), 360);
    await userEvent.click(await screen.findByRole("button", { name: /#41 A long pull request title/ }));
    const checks = await screen.findByRole("list", { name: "Checks for #41" });
    expect(within(checks).getByText(/a very long check name/)).toBeInTheDocument();
    const panel = view.container.querySelector<HTMLElement>(".studio-panel")!;
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
    await userEvent.click(screen.getByRole("button", { name: /Merge on GitHub…/ }));
    const confirm = screen.getByRole("group", { name: "Confirm merge" });
    expect(within(confirm).getByText(/A review is still required/)).toBeInTheDocument();
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
    await page.screenshot({ path: "../../test-results/pr-screenshots/git-pull-request-detail-360.png" });
  });

  it("keeps a project pull request draft across Git → Review → Git in the actual dock", async () => {
    const access = prAccess();
    const dock = (tab: "git" | "review") => (
      <div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ display: "block" }}>
        <StudioDock
          {...({} as Parameters<typeof StudioDock>[0])}
          open tab={tab} activeThread={false} reviewDiff={EMPTY_REVIEW_DIFF} projectPath="/p" projectName="p"
          agents={[]} terminalOutput={{} as never} terminalRunning={false} terminalRunningCommand="" terminalRunningElsewhere={[]} commandsReadOnly={false}
          checkpoints={[]} attachments={[]} usage={null} accountUsage={{ label: "Usage", summary: "" }} skills={[]} mcpServers={[]}
          gitOutput="" gitCommitSuccess="" gitCommitBusy={false} gitRepositoryState="ready" gitInitializing={false}
          githubAuthenticated githubRepoStatus={{ isRepo: true, repository: "owner/repo", branch: "feature/local-work", upstream: null, ahead: 0, behind: 0 }}
          gitActionsReadOnly={false} defaultRepositoryName="p" promptAudit={[]} projectActions={[]} workflows={[]} workflowRuns={[]}
          projectPullRequests={access} gitRoute={{ view: "pulls", nonce: 1 }}
          onTab={vi.fn()} onClose={vi.fn()} onRefreshDiff={vi.fn()} onReview={vi.fn()} onGitAction={vi.fn()} onGitPathAction={vi.fn()}
        />
      </div>
    );
    const view = render(dock("git"));
    await userEvent.click(await screen.findByRole("button", { name: "Create a pull request" }));
    await userEvent.clear(screen.getByLabelText("Title"));
    await userEvent.type(screen.getByLabelText("Title"), "Survives navigation");
    await userEvent.type(screen.getByLabelText(/Description/), "Body text too");
    view.rerender(dock("review"));
    expect(screen.queryByLabelText("Title")).toBeNull();
    view.rerender(dock("git"));
    await userEvent.click(await screen.findByRole("button", { name: "Create a pull request" }));
    expect(screen.getByLabelText("Title")).toHaveValue("Survives navigation");
    expect(screen.getByLabelText(/Description/)).toHaveValue("Body text too");
  });
});
