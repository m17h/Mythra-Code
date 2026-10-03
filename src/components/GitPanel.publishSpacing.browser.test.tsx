import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { GitPanel, type GitPanelProps } from "./GitPanel";
import { themeColorScheme } from "../lib/appConfig";
import "../styles.css";
import "../styles/lumen/index.css";

it.each(["mythra", "light-mythra", "atari", "synthwave"] as const)("keeps automatic-publishing controls inset from the outline in %s", async (theme) => {
  const input: GitPanelProps = {
    repositoryState: "ready", gitInitializing: false, gitOutput: "", gitCommitSuccess: "", gitCommitBusy: false,
    githubAuthenticated: true, readOnly: false, defaultRepositoryName: "repo",
    githubRepoStatus: { isRepo: true, repository: "owner/repo", branch: "main", upstream: "origin/main", ahead: 0, behind: 0 },
    workflow: {
      snapshot: { branch: "main", headOid: "a".repeat(40), rootPath: "/test", branches: [], changedFiles: 0, stagedFiles: 0, unstagedFiles: 0, stagedPaths: [] },
      busy: false, isolated: false, onBranch: vi.fn(), onRefresh: vi.fn(),
      autoPublish: { enabled: false, status: "idle", message: "", onToggle: vi.fn(), onRetry: vi.fn() },
    },
    onAction: vi.fn(), onInitializeGit: vi.fn(), onGitHubAttach: vi.fn(), onGitHubCreate: vi.fn(), onOpenGitHubSettings: vi.fn(),
  };
  for (const width of [300, 360, 520]) {
    for (const zoom of [1, 1.5]) {
      const view = render(<div className="app-shell" data-theme={theme} data-color-scheme={themeColorScheme(theme)} style={{ display: "block", zoom }}>
        <aside className="studio-dock" style={{ width, height: 850 }}><div className="studio-panel"><GitPanel {...input} /></div></aside>
      </div>);
      const box = view.container.querySelector<HTMLElement>(".git-auto-publish")!;
      const checkInsets = () => {
        const bounds = box.getBoundingClientRect();
        for (const element of box.querySelectorAll<HTMLElement>('input, button, .git-auto-publish-toggle > span')) {
          const rect = element.getBoundingClientRect();
          expect(rect.left - bounds.left).toBeGreaterThanOrEqual(10 * zoom);
          expect(bounds.right - rect.right).toBeGreaterThanOrEqual(10 * zoom);
          expect(rect.top - bounds.top).toBeGreaterThanOrEqual(10 * zoom);
          expect(bounds.bottom - rect.bottom).toBeGreaterThanOrEqual(10 * zoom);
        }
        expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
      };
      checkInsets();
      await userEvent.click(screen.getByRole("button", { name: "What it does" }));
      checkInsets();
      await userEvent.click(screen.getByRole("switch", { name: /Automatically publish branches/ }));
      expect(screen.getByRole("group", { name: "Confirm automatic publishing" })).toBeVisible();
      checkInsets();
      expect(input.workflow!.autoPublish!.onToggle).not.toHaveBeenCalled();
      view.unmount();
    }
  }
  for (const width of [300, 360, 520]) {
    const view = render(<div className="app-shell" data-theme={theme} data-color-scheme={themeColorScheme(theme)} style={{ display: "block", zoom: 1.5 }}>
      <aside className="studio-dock" style={{ width, height: 850 }}><div className="studio-panel"><GitPanel {...input} repositoryState="absent" githubRepoStatus={null} /></div></aside>
    </div>);
    const card = view.container.querySelector<HTMLElement>(".git-initialize-card")!;
    const text = card.querySelector("div")!.getBoundingClientRect();
    const button = screen.getByRole("button", { name: "Initialize Git" });
    expect(text.width).toBeGreaterThan(card.getBoundingClientRect().width * .6);
    expect(button.getBoundingClientRect().top).toBeGreaterThanOrEqual(text.bottom + 7);
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
    await userEvent.click(button);
    expect(input.onInitializeGit).toHaveBeenCalled();
    view.unmount();
  }
});
