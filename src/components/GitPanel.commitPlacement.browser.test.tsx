import { render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { GitPanel, type GitPanelProps } from "./GitPanel";
import { themeColorScheme } from "../lib/appConfig";
import type { GitChange } from "../lib/gitInspection";
import "../styles.css";
import "../styles/lumen/index.css";

it.each(["mythra", "light-mythra"] as const)("keeps commit controls above every change group with a long list in %s", async (theme) => {
  for (const width of [300, 360, 520]) {
    for (const zoom of [1, 1.5]) {
      const rootPath = `/test/commit-placement-${theme}-${width}-${zoom}`;
      const rows: GitChange[] = [
        { path: "src/staged.ts", originalPath: null, area: "staged", status: "M" },
        ...Array.from({ length: 180 }, (_, index): GitChange => ({ path: `src/changed-${index}.ts`, originalPath: null, area: "unstaged", status: "M" })),
        { path: "src/new.ts", originalPath: null, area: "untracked", status: "?" },
      ];
      const input: GitPanelProps = {
        repositoryState: "ready", gitInitializing: false, gitOutput: "", gitCommitSuccess: "", gitCommitBusy: false,
        githubAuthenticated: true, readOnly: false, defaultRepositoryName: "repo",
        githubRepoStatus: { isRepo: true, repository: "owner/repo", branch: "feature/test", upstream: "origin/feature/test", ahead: 0, behind: 0 },
        workflow: {
          snapshot: { branch: "feature/test", headOid: "a".repeat(40), rootPath, isRoot: true, upstream: "origin/feature/test", upstreamRemote: "origin", ahead: 0, behind: 0,
            branches: [], changedFiles: 182, stagedFiles: 1, unstagedFiles: 181, stagedPaths: ["src/staged.ts"] },
          busy: false, isolated: false, onBranch: vi.fn(), onRefresh: vi.fn(),
        },
        inspection: {
          cwd: rootPath,
          getChanges: vi.fn().mockResolvedValue({ rootPath, rows, stagedFiles: 1, unstagedFiles: 180, untrackedFiles: 1, changedFiles: 182, truncated: false }),
          getFileDiff: vi.fn(), getHistory: vi.fn(),
        },
        onAction: vi.fn(), onPathAction: vi.fn(), onInitializeGit: vi.fn(), onGitHubAttach: vi.fn(), onGitHubCreate: vi.fn(), onOpenGitHubSettings: vi.fn(),
      };
      const view = render(<div className="app-shell" data-theme={theme} data-color-scheme={themeColorScheme(theme)} style={{ display: "block", zoom }}>
        <aside className="studio-dock" style={{ width, height: 650 }}><div className="studio-panel"><GitPanel {...input} /></div></aside>
      </div>);
      try {
        await waitFor(() => expect(view.container.querySelectorAll(".git-change-group")).toHaveLength(3));
        const card = view.container.querySelector<HTMLElement>(".git-commit-card")!;
        const panel = view.container.querySelector<HTMLElement>(".studio-panel")!;
        for (const group of view.container.querySelectorAll<HTMLElement>(".git-change-group")) {
          expect(card.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
          expect(card.getBoundingClientRect().bottom).toBeLessThanOrEqual(group.getBoundingClientRect().top);
        }
        expect(panel.scrollHeight).toBeGreaterThan(panel.clientHeight * 2);
        card.scrollIntoView({ block: "start" });
        const local = screen.getByRole("button", { name: "Commit staged (1)" });
        const publish = screen.getByRole("button", { name: "Commit & push" });
        for (const button of [local, publish]) {
          expect(button.getBoundingClientRect().top).toBeGreaterThanOrEqual(panel.getBoundingClientRect().top - 1);
          expect(button.getBoundingClientRect().bottom).toBeLessThanOrEqual(panel.getBoundingClientRect().bottom + 1);
          expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth + 1);
        }
        const last = view.container.querySelector(".git-change-group:last-child")!;
        expect(last.getBoundingClientRect().top).toBeGreaterThan(panel.getBoundingClientRect().bottom);
        await userEvent.fill(screen.getByRole("textbox", { name: /Commit message/ }), "Save the staged file");
        await userEvent.click(local);
        expect(input.onAction).toHaveBeenLastCalledWith("commitStaged", "Save the staged file");
        await userEvent.click(publish);
        expect(input.onAction).toHaveBeenLastCalledWith("commitStagedPush", "Save the staged file");
        if (width === 360 && zoom === 1) {
          // Trusted input can scroll a focused button into view. Restore the
          // complete card for visual evidence instead of capturing its footer.
          card.scrollIntoView({ block: "start" });
          window.scrollTo(0, 0);
          await page.screenshot({ path: `../../test-results/pr-screenshots/git-commit-above-changes-${theme}.png` });
        }
      } finally {
        view.unmount();
      }
    }
  }
});
