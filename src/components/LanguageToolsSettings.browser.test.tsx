import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CSSProperties } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import type { LanguageToolsSnapshot } from "../lib/languageTools";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({ ...await importOriginal<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({ ...await importOriginal<typeof import("@tauri-apps/api/event")>(), listen: mocks.listen }));

import { LanguageToolsSettings } from "./LanguageToolsSettings";
import { SettingsModal } from "./SettingsModal";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const noop = () => {};
const asyncNoop = async () => {};
function settingsProps(): Parameters<typeof SettingsModal>[0] {
  return {
    open: true, initialSection: "tools", settings: { ...DEFAULT_SETTINGS },
    appUpdater: { phase: "idle", currentVersion: "1.23.0", availableVersion: null, notes: null, publishedAt: null, downloadedBytes: 0, totalBytes: null, error: null, checkForUpdates: asyncNoop, downloadAndRestart: asyncNoop },
    developerRuntimeUpdater: { status: null, checking: false, updating: null, error: null, message: null, checkForUpdates: asyncNoop, updateRuntime: asyncNoop },
    account: null, runtimeStatus: null, openRouterReady: false, githubStatus: null,
    childAgentReadiness: { codexRuntimeAvailable: false, openAiSignedIn: false, openRouterReady: false, claudeReady: false, cursorReady: false },
    onClose: noop, onSave: noop, onThemePreview: noop, onEffortSliderPreview: noop, onChatFontPreview: noop,
    onSignIn: asyncNoop, onRuntimeRequired: noop, onWorkspaceTools: noop, onOpenRouterChange: noop,
    onGitHubSignIn: asyncNoop, onGitHubRefresh: asyncNoop, onGitHubClone: async () => true, onError: noop,
    profiles: [], agents: [], actions: [], schedules: [], workflows: [], workflowRuns: [], projects: [],
    skillsFolder: "", skills: [], removedSkills: [], skillsBusy: false, skillsError: "", workspaceToolsAvailable: false,
    onProfiles: noop, onAgents: noop, onActions: noop, onSchedules: noop, onWorkflows: noop,
    onRunWorkflow: noop, onStopWorkflow: async () => true, onProjects: noop,
    onChooseSkillsFolder: noop, onRefreshSkills: noop, onImportSkills: noop, onCreateSkill: async () => true,
    onReadSkill: async () => "", onUpdateSkill: asyncNoop, onRenameSkill: () => true,
    onToggleSkill: noop, onRemoveSkill: async () => true, onRestoreSkill: async () => true, onOpenOnboarding: noop,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

async function expectThumbAtEdge(track: HTMLElement, enabled: boolean) {
  // Measure pixels after the transition settles, accounting for the app's
  // real zoom setting instead of confusing scaled pixels with CSS pixels.
  await waitFor(() => {
    const trackBounds = track.getBoundingClientRect();
    const thumb = track.querySelector<HTMLElement>("span")!.getBoundingClientRect();
    const scale = trackBounds.width / Number.parseFloat(getComputedStyle(track).width);
    const inset = enabled ? trackBounds.right - thumb.right : thumb.left - trackBounds.left;
    expect(inset / scale).toBeCloseTo(3, 1);
    expect((thumb.top - trackBounds.top) / scale).toBeCloseTo(3, 1);
    expect((trackBounds.bottom - thumb.bottom) / scale).toBeCloseTo(3, 1);
  });
  // A spring can pass its final position before finishing, and the track's
  // color animates separately. Capture only after every transition finishes.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.all(track.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined)));
}

describe("language tool settings in the browser", () => {
  beforeEach(() => { mocks.invoke.mockReset(); mocks.listen.mockReset(); mocks.listen.mockResolvedValue(() => undefined); });
  afterEach(async () => { await commands.setStreamTestReducedMotion(false); await page.viewport(1400, 900); });

  it("keeps a rejected settings save visible when an unrelated installation finishes in full Settings", async () => {
    await commands.setStreamTestReducedMotion(true);
    const inventory: LanguageToolsSnapshot = {
      autoInstall: true, generation: 1,
      tools: [{ id: "python", name: "Python", languages: ["Python"], state: "installed", health: "verified", detail: "Server start verified.", enabled: true }],
    };
    const read = deferred<LanguageToolsSnapshot>();
    const mutation = deferred<LanguageToolsSnapshot>();
    mocks.invoke.mockResolvedValueOnce(inventory).mockReturnValueOnce(read.promise).mockReturnValueOnce(mutation.promise).mockResolvedValue({ ...inventory, generation: 3 });
    render(<div className="app-shell" data-theme="mythra"><SettingsModal {...settingsProps()} /></div>);
    const toggle = screen.getByRole("switch", { name: "Automatic setup for new project threads" });
    await waitFor(() => expect(toggle).toBeEnabled());
    act(() => (mocks.listen.mock.calls[0][1] as (event: unknown) => void)({ payload: { generation: 2 } }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
    await page.getByRole("switch", { name: "Automatic setup for new project threads" }).click();
    await act(async () => read.resolve({ ...inventory, generation: 2, tools: inventory.tools.map((tool) => ({ ...tool, detail: "Installed by another thread." })) }));
    await act(async () => mutation.reject(new Error("Could not persist settings. Check storage permissions, then retry.")));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(4));
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Check storage permissions, then retry");
    expect(screen.queryByText("Automatic setup disabled.")).not.toBeInTheDocument();
  });

  it.each([["mythra", 1400, 900, 1], ["atari", 980, 680, 1.5]] as const)("renders truthful inventory and immediate saves inside full %s Settings at scale %s", async (theme, width, height, scale) => {
    await commands.setStreamTestReducedMotion(true);
    await page.viewport(width, height);
    let snapshot: LanguageToolsSnapshot = {
      autoInstall: true, generation: 1,
      tools: [{ id: "typescript", name: "TypeScript", languages: ["TypeScript"], state: "available", health: "stale", detail: "The previous verification expired. Refresh to check this server.", enabled: true }],
    };
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "language_tools_set_auto_install") {
        snapshot = { ...snapshot, generation: 2, autoInstall: args.enabled };
        (mocks.listen.mock.calls[0][1] as (event: unknown) => void)({ payload: { generation: 2 } });
      }
      if (command === "language_tools_refresh") snapshot = { ...snapshot, generation: 3, tools: snapshot.tools.map((tool) => ({ ...tool, state: "installed", health: "verified", detail: "Server start verified." })) };
      return snapshot;
    });
    render(<div className="app-shell" data-theme={theme} data-color-scheme={theme === "atari" ? "light" : "dark"} style={{ zoom: scale, "--ui-scale": scale } as CSSProperties}><SettingsModal {...settingsProps()} /></div>);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    const tools = within(dialog).getByRole("region", { name: "Language tools" });
    await waitFor(() => expect(within(tools).getByText("Verification expired")).toBeInTheDocument());
    const toggle = within(tools).getByRole("switch", { name: "Automatic setup for new project threads" });
    toggle.scrollIntoView({ block: "center" });
    await page.getByRole("switch", { name: "Automatic setup for new project threads" }).click();
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(["language_tools_snapshot", "language_tools_set_auto_install"]);
    const refresh = within(tools).getByRole("button", { name: "Refresh language tools" });
    refresh.scrollIntoView({ block: "center" });
    await page.getByRole("button", { name: "Refresh language tools" }).click();
    await waitFor(() => expect(within(tools).getByText("Server start verified.")).toBeInTheDocument());
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "language_tools_refresh")).toHaveLength(1);
    const content = dialog.querySelector<HTMLElement>(".settings-content")!;
    expect(content.scrollWidth).toBeLessThanOrEqual(content.clientWidth + 1);
    const bounds = dialog.getBoundingClientRect();
    for (const control of tools.querySelectorAll<HTMLElement>("input, button")) {
      const rect = control.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
      expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
    }
    tools.querySelector<HTMLElement>(".language-tools-row")!.scrollIntoView({ block: "center" });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await page.screenshot({ element: dialog, path: `../../test-results/language-tools-full-settings-${theme}-${scale}.png` });
  });

  it("announces failed setup and supports a successful retry", async () => {
    let snapshot: LanguageToolsSnapshot = {
      autoInstall: true,
      generation: 1,
      tools: [{ id: "typescript", name: "TypeScript", languages: ["TypeScript", "JavaScript"], state: "missing", health: "unverified", detail: "Uses the shared Node.js installation.", enabled: true }],
    };
    let attempts = 0;
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "language_tools_install") {
        attempts += 1;
        snapshot = { ...snapshot, tools: snapshot.tools.map((tool) => ({ ...tool, state: attempts === 1 ? "error" : "installed", detail: attempts === 1 ? "Download failed. Check your connection, then retry." : "Verified language server; shared by your projects." })) };
      }
      return snapshot;
    });
    render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ display: "block", width: 360, height: "auto", minHeight: 0, padding: 12 }}><LanguageToolsSettings /></div>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Install TypeScript" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Install TypeScript" }));
    await waitFor(() => expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("Download failed"))).toBe(true));
    const retry = screen.getByRole("button", { name: "Retry installing TypeScript" });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByText("TypeScript is installed.")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install TypeScript" })).toBeDisabled();
    expect(attempts).toBe(2);
  });

  for (const scheme of ["dark", "light"] as const) {
    for (const width of [360, 700]) {
      it(`fits the ${scheme} settings pane at ${width}px and reflects external installs`, async () => {
        let snapshot: LanguageToolsSnapshot = {
          autoInstall: true,
          generation: 1,
          tools: [
            { id: "typescript", name: "TypeScript / JavaScript", languages: ["TypeScript", "JavaScript"], state: "missing", health: "unverified", detail: "Uses Node.js. Install once and reuse across your projects.", enabled: true },
            { id: "python", name: "Python", languages: ["Python"], state: "installed", health: "verified", detail: "Reusing an existing installation.", enabled: true },
            { id: "rust", name: "Rust", languages: ["Rust"], state: "unavailable", health: "unverified", detail: "Install Rust before setting up rust-analyzer.", enabled: true },
          ],
        };
        mocks.invoke.mockImplementation(async (command, args) => {
          if (command === "language_tools_set_auto_install") snapshot = { ...snapshot, autoInstall: args.enabled };
          return snapshot;
        });
        const view = render(<div className="app-shell" data-theme={scheme === "light" ? "light-mythra" : "mythra"} data-color-scheme={scheme} style={{ display: "block", width, height: "auto", minHeight: 0, padding: 12, background: "var(--panel)" }}><LanguageToolsSettings /></div>);
        await waitFor(() => expect(screen.getByRole("checkbox", { name: "Enable TypeScript / JavaScript" })).toBeEnabled());
        const shell = view.container.querySelector<HTMLElement>(".app-shell")!;
        const bounds = shell.getBoundingClientRect();
        const background = getComputedStyle(shell).backgroundColor.match(/\d+/g)!.map(Number);
        expect(background.slice(0, 3).every((channel) => scheme === "light" ? channel > 200 : channel < 100)).toBe(true);
        expect(shell.scrollWidth).toBeLessThanOrEqual(shell.clientWidth);
        for (const element of shell.querySelectorAll<HTMLElement>("button, input, .set-copy")) {
          const rect = element.getBoundingClientRect();
          expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
          expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
        }
        const copy = shell.querySelector<HTMLElement>(".language-tools-row > .set-copy")!;
        const controls = shell.querySelector<HTMLElement>(".language-tools-row > .language-tools-controls")!;
        if (width === 360) expect(controls.getBoundingClientRect().top).toBeGreaterThan(copy.getBoundingClientRect().bottom);
        expect(getComputedStyle(copy).color).not.toBe("rgba(0, 0, 0, 0)");
        fireEvent.click(screen.getByRole("switch"));
        await waitFor(() => expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false"));
        await expectThumbAtEdge(screen.getByRole("switch"), false);
        snapshot = { ...snapshot, tools: snapshot.tools.map((tool) => tool.id === "typescript" ? { ...tool, state: "installed", detail: "Found an installation added by a model." } : tool) };
        await act(async () => (mocks.listen.mock.calls[0][1] as (event: unknown) => void)({ payload: null }));
        await waitFor(() => expect(screen.getByRole("button", { name: "Install TypeScript / JavaScript" })).toHaveTextContent("Installed"));
        await page.screenshot({ element: shell, path: `../../test-results/language-tools-${scheme}-${width}.png` });
      });
    }
  }

  for (const scheme of ["dark", "light"] as const) {
    for (const scale of [0.9, 1, 1.25]) {
      it(`places the automatic-setup thumb at both track edges in ${scheme} at ${scale * 100}% scale`, async () => {
        let snapshot: LanguageToolsSnapshot = { autoInstall: true, generation: 1, tools: [] };
        mocks.invoke.mockImplementation(async (command, args) => {
          if (command === "language_tools_set_auto_install") snapshot = { ...snapshot, autoInstall: args.enabled };
          return snapshot;
        });
        const view = render(<div className="app-shell" data-theme={scheme === "light" ? "light-mythra" : "mythra"} data-color-scheme={scheme} style={{ display: "block", width: 700, height: "auto", minHeight: 0, padding: 12, background: "var(--panel)", zoom: scale, "--ui-scale": scale } as CSSProperties}><LanguageToolsSettings /></div>);
        const track = screen.getByRole("switch");
        await waitFor(() => expect(track).toBeEnabled());
        await expectThumbAtEdge(track, true);
        const shell = view.container.querySelector<HTMLElement>(".app-shell")!;
        await page.screenshot({ element: shell, path: `../../test-results/language-tools-switch-${scheme}-${scale * 100}-on.png` });
        fireEvent.click(track);
        await waitFor(() => expect(track).toHaveAttribute("aria-checked", "false"));
        await expectThumbAtEdge(track, false);
        await page.screenshot({ element: shell, path: `../../test-results/language-tools-switch-${scheme}-${scale * 100}-off.png` });
        fireEvent.click(track);
        await waitFor(() => expect(track).toHaveAttribute("aria-checked", "true"));
        await expectThumbAtEdge(track, true);
      });
    }
  }
});
