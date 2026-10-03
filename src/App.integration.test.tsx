import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import type { SkillDependencyReport, Thread } from "./types";
import { emptySkillDependencyReport } from "./lib/skillDependencies";
import { skillDependencyFixture } from "./test/skillDependencyFixtures";
import type { PullRequest } from "./lib/pullRequests";
import { DEFAULT_SETTINGS } from "./lib/appConfig";
import { scheduleRunSnapshot } from "./lib/turnConfig";
import { projectRunExecCommand } from "./lib/projectRun";
import type { WorkflowDefinition } from "./lib/workflows";
import type { LocalSkillFile } from "./lib/skills";
import type { GitWorkspaceRevertPreview } from "./lib/gitWorkspace";

/**
 * Integration harness for App-level lifecycle regressions. Mocks the Tauri
 * bridge and drives the real sidebar/selection flows.
 */

const invokeMock = vi.fn();
const settingsPrewarm = vi.hoisted(() => ({ schedule: vi.fn<(preload: () => void) => () => void>(() => () => {}) }));
vi.mock("./lib/settingsPreload", () => ({ scheduleSettingsPreload: settingsPrewarm.schedule }));
const tauriEvents = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: Record<string, unknown>) => invokeMock(command, args),
  isTauri: () => false,
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    tauriEvents.handlers.set(name, handler);
    return () => tauriEvents.handlers.delete(name);
  }),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "0.0.0-test"),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => false),
  requestPermission: vi.fn(async () => "denied"),
  sendNotification: vi.fn(),
}));

const PROJECT_A = { id: "project-a", name: "Alpha", path: "/projects/alpha" };
const PROJECT_B = { id: "project-b", name: "Beta", path: "/projects/beta" };

const selectedReviewSkill: LocalSkillFile = {
  path: "/skills/review/SKILL.md", relativePath: "review/SKILL.md", fileName: "SKILL.md",
  defaultName: "review", description: "Review carefully", supportingMarkdownCount: 0,
};

const THREAD_A: Thread = {
  id: "thread-a",
  name: "Alpha thread",
  preview: "work in alpha",
  cwd: PROJECT_A.path,
  updatedAt: 1_700_000_000,
  modelProvider: "openai",
};

const THREAD_B: Thread = {
  id: "thread-b",
  name: "Beta thread",
  preview: "second thread in alpha",
  cwd: PROJECT_A.path,
  updatedAt: 1_700_000_100,
  modelProvider: "openai",
};

const LINKED_PR: PullRequest = {
  repository: "test-user/alpha", number: 31, url: "https://github.com/test-user/alpha/pull/31",
  title: "Improve Alpha", body: "Review these changes", state: "OPEN", isDraft: false,
  headRefName: "feature/alpha", baseRefName: "main", headOid: "a".repeat(40),
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED",
  checks: [], updatedAt: "2026-09-22T12:00:00Z", canMerge: true, mergeMethods: ["squash"],
};

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let pendingResume: Deferred<{ thread: Thread }>;
let resumeImpl: (params: Record<string, unknown>) => unknown;
let threadReadImpl: (params: Record<string, unknown>) => unknown;
let threadListImpl: (params: Record<string, unknown>) => unknown;
let threadTurnsListImpl: (params: Record<string, unknown>) => unknown;
let turnStartImpl: (params: Record<string, unknown>) => unknown;
let accountReadImpl: (params: Record<string, unknown>) => unknown;
let accountLogoutImpl: () => unknown;
let rateLimitsImpl: () => unknown;
let openRouterReadyImpl: () => boolean;
let openRouterCreditsImpl: () => unknown;
let commandExecImpl: (params: Record<string, unknown>) => unknown;
let claudeRuntimeStatusImpl: () => unknown;
let cursorRuntimeStatusImpl: () => unknown;
let localSkillsScanImpl: (folder: string) => unknown;
let localSkillsSyncImpl: (folder: string) => unknown;
let localSkillsResolvePromptImpl: (params: Record<string, unknown>) => unknown;
let localSkillsMentionNamesImpl: (message: string) => unknown;
let claudeModelsImpl: () => unknown;
let modelListImpl: (params: Record<string, unknown>) => unknown;
let refreshedCodexRuntimeStatusImpl: () => unknown;
let cursorModelsImpl: () => unknown;
/** Bumped by every managed app-server restart, real or simulated. */
let runtimeGeneration: number;
let runtimeLoadedThreads: Set<string>;
let workspaceGitInfoImpl: () => unknown;
let workspaceGitInitializeImpl: () => unknown;
let lmStudioModelsImpl: (baseUrl: string) => unknown;
/** Throwing here is how a runtime without the review diff behaves. */
let gitDiffToRemoteImpl: () => unknown;

function stubInvoke(command: string, args?: Record<string, unknown>): unknown {
  if (command === "codex_runtime_status_refresh") return refreshedCodexRuntimeStatusImpl();
  if (command === "codex_runtime_status") {
    return {
      available: true,
      source: "Codex CLI",
      path: "/usr/local/bin/codex",
      runningPath: "/usr/local/bin/codex",
      dataHome: "/profiles/localdev/codex-home",
      version: "99.0.0",
      runningVersion: "99.0.0",
      runningCommands: 0,
      runtimeChanged: false,
      compatible: true,
      warning: null,
    };
  }
  if (command === "claude_runtime_status") {
    return claudeRuntimeStatusImpl();
  }
  if (command === "cursor_runtime_status") return cursorRuntimeStatusImpl();
  if (command === "local_skills_scan") return localSkillsScanImpl(String(args?.folder ?? ""));
  if (command === "local_skills_sync") return localSkillsSyncImpl(String(args?.folder ?? ""));
  if (command === "local_skills_analyze_prompts") return emptySkillDependencyReport();
  if (command === "local_skills_resolve_prompt") return localSkillsResolvePromptImpl(args ?? {});
  if (command === "local_skills_resolve_prompts") return (async () => {
    const params = args ?? {};
    const source = String(params.mentionSource ?? params.message ?? "");
    const names = localSkillsMentionNamesImpl(source) as string[];
    return {
      prompt: names.length ? await localSkillsResolvePromptImpl(params) : params.message,
      systemPrompt: params.systemPrompt,
    };
  })();
  if (command === "local_skills_mention_names") return localSkillsMentionNamesImpl(String(args?.message ?? ""));
  if (command === "claude_models") return claudeModelsImpl();
  if (command === "cursor_models") return cursorModelsImpl();
  if (command === "github_status") {
    return {
      available: true,
      authenticated: true,
      path: "/opt/homebrew/bin/gh",
      version: "gh version test",
      login: "test-user",
      name: "Test User",
      email: null,
      avatarUrl: null,
      profileUrl: null,
      error: null,
    };
  }
  if (command === "github_repo_status") {
    return {
      isRepo: true,
      remoteUrl: "https://github.com/test-user/alpha.git",
      repository: "test-user/alpha",
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
    };
  }
  if (command === "git_workspace_commit") {
    // The native command owns this transaction; tests simulate its output,
    // while Rust fixtures cover its actual index/identity/locking behavior.
    return (async () => {
      if (!args?.stagedOnly) {
        const stage = await commandExecImpl({ command: ["git", "add", "--all"], cwd: args?.cwd }) as { exitCode: number; stdout: string; stderr: string };
        if (stage.exitCode !== 0) throw new Error(stage.stdout + stage.stderr);
      }
      const committed = await commandExecImpl({ command: ["git", "commit", "-m", args?.message], cwd: args?.cwd }) as { exitCode: number; stdout: string; stderr: string };
      if (committed.exitCode !== 0) throw new Error(committed.stdout + committed.stderr);
      return { headOid: "b".repeat(40), branch: "main", stdout: committed.stdout, stderr: committed.stderr };
    })();
  }
  if (command === "git_workspace_stage") return { stdout: "", stderr: "" };
  if (command === "git_project_diff") return { text: "", source: "repository", baseline: "HEAD", untrackedPaths: [], truncated: false };
  // Project Changes/History/PR reads: native commands are exercised by Rust
  // fixtures; these mirror the one-unstaged-file snapshot below.
  if (command === "git_project_changes") return {
    rootPath: String(args?.cwd ?? PROJECT_A.path), rows: [{ path: "README.md", originalPath: null, area: "unstaged", status: "M" }],
    stagedFiles: 0, unstagedFiles: 1, untrackedFiles: 0, changedFiles: 1, truncated: false,
  };
  if (command === "git_project_file_diff") return { path: args?.path, area: args?.area, text: "@@ -1 +1 @@\n-old\n+new\n", binary: false, truncated: false };
  if (command === "git_project_history") return { entries: [], hasMore: false, nextOffset: 0, headOid: "a".repeat(40), truncated: false };
  if (command === "github_pr_list") return [];
  if (command === "git_workspace_snapshot") return {
    branch: "main", headOid: "a".repeat(40), branches: [], stagedFiles: 0,
    unstagedFiles: 1, changedFiles: 1, stagedPaths: [], rootPath: String(args?.cwd ?? PROJECT_A.path),
  };
  if (command === "git_workspace_push") return (async () => {
    const result = await commandExecImpl({ command: ["git", "push"], cwd: args?.cwd }) as { exitCode: number; stdout: string; stderr: string };
    if (result.exitCode !== 0) throw new Error(result.stdout + result.stderr);
    return { stdout: result.stdout, stderr: result.stderr };
  })();
  if (command === "github_pr_context") return {
    repository: "test-user/alpha", branch: "feature/alpha", defaultBranch: "main",
    headOid: "a".repeat(40), dirty: false, ahead: 1, behind: 0,
    pushRemote: "origin", permission: "write", mergeMethods: ["squash"],
  };
  if (command === "github_pr_find") return null;
  if (command === "github_pr_view") return LINKED_PR;
  if (command === "state_read") return null;
  if (command === "local_transcript_list") return [];
  if (command === "audit_recent") return [];
  // Every app-server restart hands back a different identity, which is how the
  // app knows the threads that process had loaded are gone with it.
  if (command === "runtime_instance") return `runtime-${runtimeGeneration}`;
  if (command === "runtime_thread_state") {
    const threadId = String(args?.threadId ?? "");
    return { instance: `runtime-${runtimeGeneration}`, loaded: runtimeLoadedThreads.has(threadId) };
  }
  if (command === "restart_runtime") {
    runtimeGeneration += 1;
    runtimeLoadedThreads.clear();
    return null;
  }
  if (command === "reserve_runtime_restart") return "test-runtime-refresh-reservation";
  if (command === "release_runtime_restart") return null;
  if (command === "restart_runtime_reserved") {
    runtimeGeneration += 1;
    runtimeLoadedThreads.clear();
    return null;
  }
  if (command === "normal_chat_workspace") return "/chats";
  if (command === "workspace_git_info") {
    return workspaceGitInfoImpl();
  }
  if (command === "workspace_git_initialize") {
    return workspaceGitInitializeImpl();
  }
  if (command === "worktree_create") {
    return {
      path: "/managed/worktrees/isolated-thread",
      branch: "openkiwi/isolated-thread",
      baseCommit: "head",
      gitDir: "/projects/alpha/.git",
    };
  }
  if (command === "worktree_status") {
    if (String(args?.worktreePath).includes("missing")) {
      return {
        exists: false,
        registered: false,
        branch: null,
        baseCommit: null,
        changedFiles: 0,
        untrackedFiles: 0,
        ignoredFileCount: 0,
        ahead: 0,
        behind: 0,
        clean: false,
      };
    }
    return {
      exists: true,
      registered: true,
      branch: "openkiwi/isolated-thread",
      baseCommit: "head",
      changedFiles: 0,
      untrackedFiles: 0,
      ignoredFileCount: 0,
      ahead: 0,
      behind: 0,
      clean: true,
    };
  }
  if (command === "worktree_remove") return { folderRemoved: true, branchDeleted: true, retainedBranch: null, retainedBranchOid: null, branchDeleteError: null };
  if (command === "checkpoint_create") {
    return {
      commit: `before-${String(args?.id)}`,
      repoRoot: String(args?.cwd),
      fileCount: 4,
      branch: "main",
      head: "head",
    };
  }
  if (command === "checkpoint_complete") {
    return {
      snapshot: {
        commit: `after-${String(args?.id)}`,
        repoRoot: String(args?.cwd),
        fileCount: 5,
        branch: "main",
        head: "head",
      },
      changedFiles: 1,
      additions: 2,
      deletions: 0,
    };
  }
  if (command === "checkpoint_delete") return null;
  if (command === "child_agent_session_start") {
    const options = (args?.options ?? {}) as { targets?: unknown[]; sessionId?: string };
    const delegation = Boolean(options.targets?.length);
    return {
      name: "mythra_agents",
      command: "/Applications/Mythra Code.app/Contents/MacOS/mythra-code",
      args: ["--openkiwi-agent-bridge", `/tmp/${options.sessionId ?? "session"}.json`],
      configPath: `/tmp/${options.sessionId ?? "session"}.mcp.json`,
      toolNames: delegation
        ? ["spawn_mythra_agent", "agent_status", "collect_agent", "cancel_agent", "propose_agent_settings"]
        : ["propose_agent_settings"],
    };
  }
  if (command === "child_agent_session_end" || command === "child_agent_finished" || command === "child_agent_respond") return null;
  if (command === "has_openrouter_key") return openRouterReadyImpl();
  if (command === "openrouter_credits") return openRouterCreditsImpl();
  if (command === "list_lmstudio_models") return lmStudioModelsImpl(String(args?.baseUrl ?? ""));
  if (command === "codex_rpc") {
    const method = args?.method as string;
    const params = (args?.params ?? {}) as Record<string, unknown>;
    if (method === "thread/list") return threadListImpl(params);
    if (method === "thread/start") {
      runtimeLoadedThreads.add("isolated-thread");
      return {
        thread: {
          ...THREAD_A,
          id: "isolated-thread",
          cwd: String(params.cwd),
          turns: [],
        },
      };
    }
    if (method === "command/exec") return commandExecImpl(params);
    if (method === "gitDiffToRemote") return gitDiffToRemoteImpl();
    if (method === "fs/readDirectory") {
      return { entries: [
        { fileName: "diagram.PNG", isDirectory: false, isFile: true },
        { fileName: "notes.md", isDirectory: false, isFile: true },
      ] };
    }
    if (method === "fs/readFile") return { dataBase64: btoa("preview") };
    if (method === "fuzzyFileSearch") return { files: [] };
    if (method === "thread/read") {
      return threadReadImpl(params);
    }
    if (method === "thread/turns/list") return threadTurnsListImpl(params);
    if (method === "thread/resume") {
      return Promise.resolve(resumeImpl(params)).then((result) => {
        runtimeLoadedThreads.add(String(params.threadId));
        return result;
      });
    }
    if (method === "turn/start") return turnStartImpl(params);
    if (method === "account/read") {
      return accountReadImpl(params);
    }
    if (method === "account/logout") {
      const result = accountLogoutImpl();
      // Codex confirms a logout with the same notification an expired session
      // produces.
      queueMicrotask(() => tauriEvents.handlers.get("codex-event")?.({ payload: { method: "account/updated", params: { authMode: null, planType: null } } }));
      return result;
    }
    if (method === "account/rateLimits/read") return rateLimitsImpl();
    if (method === "model/list") return modelListImpl(params);
    return {};
  }
  return null;
}

async function renderApp() {
  // App reads persisted projects at module scope, so the module registry must
  // be reset after seeding storage for each test.
  vi.resetModules();
  const { default: App } = await import("./App");
  const view = render(<App />);
  await screen.findByRole("button", { name: PROJECT_B.name });
  return view;
}

beforeEach(() => {
  localStorage.clear();
  tauriEvents.handlers.clear();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  pendingResume = deferred<{ thread: Thread }>();
  resumeImpl = () => pendingResume.promise;
  threadReadImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
  threadListImpl = (params) => ({
    data: params.cwd === PROJECT_A.path ? [THREAD_A, THREAD_B] : [],
    nextCursor: null,
  });
  threadTurnsListImpl = () => ({ data: [], nextCursor: null, backwardsCursor: null });
  turnStartImpl = (params) => ({ turn: { id: `turn-${String(params.threadId)}` } });
  accountReadImpl = () => ({ account: { type: "chatgpt", email: "test@example.com", planType: "pro" }, requiresOpenaiAuth: true });
  accountLogoutImpl = () => ({});
  rateLimitsImpl = () => ({ rateLimits: {} });
  openRouterReadyImpl = () => false;
  openRouterCreditsImpl = () => ({ remaining: 0, used: null, source: "account" });
  commandExecImpl = () => ({ exitCode: 0, stdout: "", stderr: "" });
  cursorRuntimeStatusImpl = () => null;
  refreshedCodexRuntimeStatusImpl = () => ({
    available: true,
    source: "Codex CLI",
    path: "/usr/local/bin/codex",
    runningPath: "/usr/local/bin/codex",
    dataHome: "/profiles/localdev/codex-home",
    version: "99.0.0",
    runningVersion: "99.0.0",
    runningCommands: 0,
    runtimeChanged: false,
    compatible: true,
    warning: null,
  });
  localSkillsScanImpl = () => [];
  localSkillsSyncImpl = () => "/runtime/skills";
  localSkillsResolvePromptImpl = (params) => params.message;
  // Stands in for the native parser: an @ token only counts when it starts a
  // word and ends at one, which is what keeps e-mail addresses and file paths
  // out of the skill path.
  localSkillsMentionNamesImpl = (message) => Array.from(message.matchAll(/(?:^|\s)@([a-z0-9][a-z0-9-]*)(?=$|\s|[.,;:!?](?:\s|$))/gi)).map((match) => match[1].toLowerCase());
  claudeRuntimeStatusImpl = () => ({
    available: false,
    path: null,
    version: null,
    loggedIn: false,
    authMethod: null,
    email: null,
    subscriptionType: null,
    warning: null,
  });
  claudeModelsImpl = () => ({ models: [] });
  modelListImpl = () => ({ data: [] });
  cursorModelsImpl = () => [];
  runtimeGeneration = 1;
  runtimeLoadedThreads = new Set();
  workspaceGitInfoImpl = () => ({ isRepo: true, isRoot: true, hasCommit: true, branch: "main", head: "head" });
  workspaceGitInitializeImpl = () => ({
    info: { isRepo: true, isRoot: true, hasCommit: true, branch: "main", head: "new-head" },
    initialized: true,
    createdCommit: true,
    trackedFiles: 2,
  });
  lmStudioModelsImpl = () => ({ models: [] });
  gitDiffToRemoteImpl = () => ({ diff: "" });
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
    stubInvoke(command, args),
  );
  localStorage.setItem("kiwi.projects", JSON.stringify([PROJECT_A, PROJECT_B]));
  localStorage.setItem("kiwi.workspaceMode", JSON.stringify("project"));
});

afterEach(async () => {
  // vi.resetModules() does not cancel timers owned by the previous Composer
  // module. Its debounced save must not overwrite the next test's seeded
  // storage while a slower runner is importing a fresh App instance.
  const { resetDraftStoreForTests } = await import("./components/Composer");
  resetDraftStoreForTests();
  vi.doUnmock("./components/SettingsModal");
});

describe("skill file recovery messages", () => {
  it.each(["import", "create"] as const)("preserves partial-write recovery details after skill %s", { timeout: 15_000 }, async (operation) => {
    localStorage.setItem("kiwi.skillsFolder", JSON.stringify("/skills"));
    const message = `Could not ${operation} the skill: Permission denied. The new file /skills/source-2.md may be incomplete; existing files were not changed.`;
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === `local_skills_${operation}`) throw new Error(message);
      return stubInvoke(command, args);
    });
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" }, { timeout: 10_000 });
    await user.click(within(settings).getByRole("button", { name: "Skills" }));
    if (operation === "import") {
      const { open } = await import("@tauri-apps/plugin-dialog");
      vi.mocked(open).mockResolvedValueOnce(["/private/source.md"]);
      await user.click(within(settings).getByRole("button", { name: "Import Markdown" }));
    } else {
      await user.click(within(settings).getByRole("button", { name: "Add a new skill" }));
      await user.type(within(settings).getByRole("textbox", { name: "Skill name" }), "source");
      await user.type(within(settings).getByRole("textbox", { name: "Instructions" }), "Test instructions");
      await user.click(within(settings).getByRole("button", { name: "Create skill" }));
    }
    expect(await within(settings).findByText(message)).toBeVisible();
    expect(within(settings).queryByText(/Check the project folder and permission mode/)).not.toBeInTheDocument();
    if (operation === "create") expect(within(settings).getByRole("textbox", { name: "Instructions" })).toHaveValue("Test instructions");
  });
});

describe("onboarding Settings handoff", () => {
  async function runOnboarding() {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" }, { timeout: 10_000 });
    await user.click(within(settings).getByRole("button", { name: "Runtime" }));
    await user.click(within(settings).getByRole("button", { name: "Run onboarding" }));
    return { user, tour: await screen.findByRole("dialog", { name: "Mythra Code onboarding" }) };
  }

  it("opens Models & accounts with the provider picked in the tour and discards that unsaved choice", { timeout: 15_000 }, async () => {
    localStorage.setItem("kiwi.settings", JSON.stringify({ provider: "openai", model: "gpt-5.6-sol" }));
    const { user, tour } = await runOnboarding();
    await user.click(within(tour).getByRole("radio", { name: "Claude" }));
    expect(within(tour).getByRole("radio", { name: "Claude" })).toHaveAttribute("aria-checked", "true");
    await user.click(within(tour).getByRole("button", { name: "Models & accounts" }));

    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(settings).getByRole("heading", { name: "Models & accounts" })).toBeInTheDocument();
    expect(within(settings).getByRole("button", { name: /Anthropic.*Claude Code subscription/ })).toHaveClass("selected");
    expect(within(settings).getByRole("button", { name: "Default Claude model" })).toBeInTheDocument();
    expect(within(settings).getByText("Unsaved changes")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("kiwi.settings")!).provider).toBe("openai");

    await user.click(within(settings).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("dialog", { name: "Mythra Code onboarding" })).toBeInTheDocument();
    expect(within(tour).getByRole("radio", { name: "Claude" })).toHaveAttribute("aria-checked", "true");

    await user.click(within(tour).getByRole("button", { name: "Skip tour" }));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const reopened = await screen.findByRole("dialog", { name: "Settings" });
    await user.click(within(reopened).getByRole("button", { name: "Models & accounts" }));
    expect(within(reopened).getByRole("button", { name: /OpenAI.*ChatGPT subscription/ })).toHaveClass("selected");
    expect(within(reopened).queryByText("Unsaved changes")).not.toBeInTheDocument();
  });

  it("saves the onboarding theme immediately but discards unsaved font and slider drafts on cancel", { timeout: 15_000 }, async () => {
    localStorage.setItem("kiwi.settings", JSON.stringify({ theme: "mythra", chatFont: "system", effortSlider: "aurora" }));
    const { user, tour } = await runOnboarding();
    await user.click(within(tour).getByRole("button", { name: "Make it yours" }));
    expect(within(tour).getByRole("heading", { name: "Make it feel like yours." })).toBeInTheDocument();
    await user.click(within(tour).getByRole("radio", { name: "Synthwave" }));
    expect(document.querySelector(".app-shell")).toHaveAttribute("data-theme", "synthwave");
    expect(JSON.parse(localStorage.getItem("kiwi.settings")!).theme).toBe("synthwave");
    await user.click(within(tour).getByRole("radio", { name: "Mono" }));
    await user.click(within(tour).getByRole("button", { name: "Next slider style" }));
    expect(within(tour).getByText("Astra")).toBeInTheDocument();
    await user.click(within(tour).getByRole("button", { name: "Review this look in Settings" }));

    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(settings).getByRole("heading", { name: "Interface" })).toBeInTheDocument();
    expect(within(settings).getByRole("button", { name: /Synthwave.*neon pink/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(settings).getByRole("button", { name: /Monospace/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(settings).getByRole("button", { name: /Astra.*living nebula/i })).toHaveAttribute("aria-pressed", "true");
    expect(within(settings).getByText("Unsaved changes")).toBeInTheDocument();
    expect(document.querySelector(".app-shell")).toHaveAttribute("data-theme", "synthwave");
    expect(document.querySelector(".app-shell")).toHaveAttribute("data-chat-font", "mono");
    expect(document.querySelector(".app-shell")).toHaveAttribute("data-effort-slider", "astra");
    expect(JSON.parse(localStorage.getItem("kiwi.settings")!).theme).toBe("synthwave");

    await user.click(within(settings).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("dialog", { name: "Mythra Code onboarding" })).toBeInTheDocument();
    expect(within(tour).getByRole("heading", { name: "Make it feel like yours." })).toBeInTheDocument();
    expect(document.querySelector(".app-shell")).toHaveAttribute("data-theme", "synthwave");
    expect(document.querySelector(".app-shell")).toHaveAttribute("data-chat-font", "system");

    await user.click(within(tour).getByRole("button", { name: "Skip tour" }));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const reopened = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(reopened).getByRole("button", { name: /Synthwave.*neon pink/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(reopened).getByRole("button", { name: /Interface default.*same typeface/i })).toHaveAttribute("aria-pressed", "true");
    expect(within(reopened).getByRole("button", { name: /Aurora.*northern-light/i })).toHaveAttribute("aria-pressed", "true");
    expect(within(reopened).queryByText("Unsaved changes")).not.toBeInTheDocument();
  });
});

describe("background helper usage", () => {
  it("records native helper events once without creating a chat thread and unsubscribes on close", async () => {
    const app = await renderApp();
    const { usageTotals } = await import("./lib/usageLedger");
    await waitFor(() => expect(tauriEvents.handlers.has("background-helper-usage")).toBe(true));
    const event = {
      executionId: "c012b670-3bb2-4f48-8b4c-329d2065ab17", provider: "claude", model: "claude-haiku-4-5",
      modelSource: "reported", purpose: "thread-title", serviceTier: null, serviceTierSource: "unknown",
      requestedServiceTier: null, outcome: "completed", tokenAvailability: "reported", reportedCost: null,
      usage: { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 10,
        cacheWrite1hInputTokens: 0, outputTokens: 15, reasoningOutputTokens: null, totalTokens: 115 },
    };
    act(() => {
      tauriEvents.handlers.get("background-helper-usage")?.({ payload: event });
      tauriEvents.handlers.get("background-helper-usage")?.({ payload: event });
    });
    expect(usageTotals()).toMatchObject({ inputTokens: 100, outputTokens: 15, totalTokens: 115, auxiliaryRequests: 1, threads: 0 });
    app.unmount();
    expect(tauriEvents.handlers.has("background-helper-usage")).toBe(false);
  });
});

describe("Codex cold startup", () => {
  it("seals queued text and reports dropped approvals after a runtime disconnect", async () => {
    await renderApp();
    await waitFor(() => expect(tauriEvents.handlers.has("codex-runtime")).toBe(true));
    const { useTaskStore } = await import("./lib/taskStore");
    act(() => {
      const store = useTaskStore.getState();
      store.setActiveTurn(THREAD_A.id, "turn-disconnected");
      store.setTaskStatus(THREAD_A.id, "running");
      store.queueAssistantDelta(THREAD_A.id, "partial-answer", "partial text", "turn-disconnected");
      store.enqueueApproval({ id: 44, method: "item/commandExecution/requestApproval", params: { threadId: THREAD_A.id, turnId: "turn-disconnected" }, threadId: THREAD_A.id, receivedAt: Date.now() });
      tauriEvents.handlers.get("codex-runtime")?.({ payload: { alive: false } });
    });

    await waitFor(() => expect(useTaskStore.getState().statuses[THREAD_A.id]).toBe("error"), { timeout: 4000 });
    const task = useTaskStore.getState().tasks[THREAD_A.id];
    expect(task.activeTurnId).toBeUndefined();
    expect(task.messages).toContainEqual(expect.objectContaining({
      id: "partial-answer", text: "partial text", streaming: false, turnStatus: "failed",
    }));
    expect(task.approvals).toEqual([]);
    expect(task.activities).toContainEqual(expect.objectContaining({ title: "A pending approval was dropped" }));
    expect(task.error).toBe("The Codex runtime disconnected during this task.");
  }, 10_000);

  it("shows a timed sign-in toast without selecting an unavailable provider or opening settings", async () => {
    accountReadImpl = () => ({ account: null, requiresOpenaiAuth: true });
    await renderApp();
    const provider = await screen.findByRole("button", { name: "New thread provider: OpenAI" });
    await waitFor(() => expect(provider).toHaveClass("unavailable"));
    vi.useFakeTimers();
    try {
      fireEvent.click(provider);
      const option = screen.getByRole("menuitemradio", { name: /OpenAI/ });
      fireEvent.click(option);
      const message = "Sign in to ChatGPT in Settings → Models & accounts to use OpenAI.";
      expect(screen.getByText(message).closest(".app-toast")).toHaveClass("info");
      expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
      expect(provider).toHaveAttribute("aria-expanded", "true");
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      fireEvent.click(option);
      await act(async () => { await vi.advanceTimersByTimeAsync(4_499); });
      expect(screen.getByText(message)).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(screen.queryByText(message)).not.toBeInTheDocument();
      expect(provider).toHaveAccessibleName("New thread provider: OpenAI");
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  describe("failed Settings load dismissal", () => {
    let PreparedApp: (typeof import("./App"))["default"];

    beforeEach(async () => {
      // Keep the deliberately cold module evaluation in the hook timeout so
      // the test's five seconds measure the Settings failure interaction. A
      // contended Windows runner can otherwise spend that budget importing
      // App before the first behavioral assertion executes.
      vi.resetModules();
      ({ default: PreparedApp } = await import("./App"));
    });

    it.each(["button", "Escape"])("dismisses with %s and permits a fresh open", async how => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.doMock("./components/SettingsModal", () => { throw new Error("Settings chunk unavailable"); });
      render(<PreparedApp />);
      await screen.findByRole("button", { name: PROJECT_B.name });
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      const reload = await screen.findByRole("button", { name: "Reload view" });
      expect(reload).toHaveFocus();
      if (how === "Escape") fireEvent.keyDown(reload, { key: "Escape" });
      else fireEvent.click(screen.getByRole("button", { name: "Close settings error" }));
      expect(screen.queryByText("The settings view hit a problem")).not.toBeInTheDocument();
      expect(document.querySelector(".sidebar")).not.toHaveAttribute("inert");
      vi.doMock("./components/SettingsModal", () => ({ SettingsModal: () => <div role="dialog" aria-label="Reopened settings" /> }));
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      expect(await screen.findByRole("dialog", { name: "Reopened settings" })).toBeInTheDocument();
    });
  });
  it("mounts cold-loaded Settings once and retains the same instance on reopening", async () => {
    const mounted = vi.fn();
    function TestSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
      useEffect(() => { mounted(); }, []);
      return <div role="dialog" aria-label="Loaded settings" hidden={!open}><button onClick={onClose}>Close test settings</button></div>;
    }
    vi.doMock("./components/SettingsModal", () => ({ SettingsModal: TestSettings }));
    await renderApp();
    expect(mounted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Loaded settings" });
    // The DOM can commit before passive effects run on a slower host.
    await waitFor(() => expect(mounted).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Close test settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("dialog", { name: "Loaded settings" })).toBe(dialog);
    expect(mounted).toHaveBeenCalledOnce();
  });
  it("surfaces a Settings import failure and reloads successfully through the existing boundary", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.doMock("./components/SettingsModal", () => { throw new Error("Settings chunk unavailable"); });
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByText("The settings view hit a problem")).toBeInTheDocument();
    vi.doMock("./components/SettingsModal", () => ({ SettingsModal: () => <div role="dialog" aria-label="Recovered settings" /> }));
    fireEvent.click(screen.getByRole("button", { name: "Reload view" }));
    expect(await screen.findByRole("dialog", { name: "Recovered settings" })).toBeInTheDocument();
  });
  it("opens preloaded Settings synchronously without mounting it during prewarm", async () => {
    await renderApp();
    const preload = settingsPrewarm.schedule.mock.calls.at(-1)?.[0] as (() => Promise<unknown>) | undefined;
    expect(preload).toBeTypeOf("function");
    await act(async () => { await preload!(); });
    expect(document.querySelector(".settings-backdrop")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    // No findBy/waitFor: a fulfilled preload must bypass React.lazy's initial
    // Suspense retry, not merely make its promise resolve a little faster.
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });
  it.each(["main", "sub-agent"])("keeps the topbar Ready or Working and reports %s bulk actions outside it", async (kind) => {
    const user = userEvent.setup();
    const threads = [THREAD_A, THREAD_B].map(thread => kind === "sub-agent" ? { ...thread, parentThreadId: "root", threadSource: "subagent" } : thread);
    threadListImpl = (params) => ({ data: params.cwd === PROJECT_A.path ? threads : [], nextCursor: null });
    resumeImpl = () => ({ thread: { ...threads[0], turns: [] } });
    await renderApp();
    if (kind === "sub-agent") await user.click(within(screen.getByRole("group", { name: "Thread type" })).getByRole("button", { name: /^Sub-agents/ }));
    const status = document.querySelector(".runtime-status")!;
    expect(status.textContent).toBe("Ready");
    await user.click(await screen.findByText("Alpha thread"));
    const { useTaskStore } = await import("./lib/taskStore");
    await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe(THREAD_A.id));
    act(() => useTaskStore.getState().setTaskStatus(THREAD_A.id, "running"));
    expect(status.textContent).toBe("Working");
    act(() => useTaskStore.getState().setTaskStatus(THREAD_A.id, "completed"));
    expect(status.textContent).toBe("Ready");
    const { save } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(save).mockResolvedValueOnce("/tmp/transcript-test.md");
    await user.click(screen.getByRole("button", { name: "Export conversation as Markdown" }));
    const exported = await screen.findByText("Transcript exported");
    expect(exported.closest(".app-toast")).toHaveClass("info");
    expect(status.textContent).toBe("Ready");
    await user.click(screen.getByRole("button", { name: "Archive all" }));
    expect(await screen.findByText(`Archived 2 ${kind} threads`)).toBeInTheDocument();
    expect(status.textContent).toBe("Ready");
    expect(status).not.toHaveTextContent("Archived");
  });
  it("exports output that streamed while the Save dialog was open", async () => {
    const user = userEvent.setup();
    threadListImpl = (params) => ({ data: params.cwd === PROJECT_A.path ? [THREAD_A] : [], nextCursor: null });
    resumeImpl = () => ({ thread: { ...THREAD_A, turns: [] } });
    await renderApp();
    await user.click(await screen.findByText("Alpha thread"));
    const { useTaskStore } = await import("./lib/taskStore");
    await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe(THREAD_A.id));
    act(() => {
      const store = useTaskStore.getState();
      store.setActiveTurn(THREAD_A.id, "turn-export");
      store.setTaskStatus(THREAD_A.id, "running");
      store.queueAssistantDelta(THREAD_A.id, "export-answer", "Before the dialog. ", "turn-export");
      store.flushDeltas();
    });
    const chosenPath = deferred<string | null>();
    const { save } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(save).mockReturnValueOnce(chosenPath.promise);
    await user.click(screen.getByRole("button", { name: "Export conversation as Markdown" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    act(() => {
      const store = useTaskStore.getState();
      store.queueAssistantDelta(THREAD_A.id, "export-answer", "Streamed while saving.", "turn-export");
      store.completeTurn(THREAD_A.id, "turn-export", "completed");
      // Still queued when the dialog closes: export must flush it too.
      store.queueAssistantDelta(THREAD_A.id, "export-late", "Queued at save time.");
    });
    await act(async () => {
      chosenPath.resolve("/tmp/streamed-export.md");
      await chosenPath.promise;
    });
    expect(await screen.findByText("Transcript exported")).toBeInTheDocument();
    const contents = String(invokeMock.mock.calls.find(([command]) => command === "export_text_file")?.[1]?.contents);
    expect(contents).toContain("Before the dialog. Streamed while saving.");
    expect(contents).toContain("Queued at save time.");
  });
  it("does not archive a parent while a persisted sub-agent still has an unknown outcome", async () => {
    localStorage.setItem("kiwi.childAgentLinks", JSON.stringify({
      "unfinished-child": { childThreadId: "unfinished-child", rootThreadId: THREAD_A.id,
        sessionId: "session-guard", targetId: "reviewer", provider: "claude", model: "claude-fable-5",
        reasoningEffort: "high", title: "Unfinished review", createdAt: Date.now() },
    }));
    threadListImpl = (params) => ({ data: params.cwd === PROJECT_A.path ? [THREAD_A, THREAD_B] : [], nextCursor: null });
    await renderApp();
    await screen.findByText("Alpha thread");
    fireEvent.click(screen.getByRole("button", { name: "Archive all" }));
    expect(await screen.findByText("Archived 1 main thread")).toBeInTheDocument();
    expect(screen.getByText("Alpha thread")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("kiwi.childAgentLinks") ?? "{}")["unfinished-child"].terminalStatus).toBeUndefined();
  });
  it("keeps the app visible while the Settings chunk loads for the first time", { timeout: 15_000 }, async () => {
    await renderApp();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.queryByRole("dialog", { name: "Loading settings…" })).not.toBeInTheDocument();
    expect(document.querySelector(".settings-backdrop.open .runtime-setup-modal")).not.toBeInTheDocument();
    expect(document.querySelector(".app-shell")).toBeInTheDocument();
    // A cold Windows CI runner can take more than Testing Library's one-second
    // default to transform the lazy Settings chunk while the full suite runs.
    // The immediate assertions above are the regression guard; this longer
    // wait only proves the chunk eventually resolves instead of hiding an
    // actual import failure.
    expect(await screen.findByRole("dialog", { name: "Settings" }, { timeout: 10_000 })).toBeInTheDocument();
  });

  it("loads local threads without waiting for a forced token refresh", async () => {
    const auth = deferred<{ account: { type: "chatgpt"; email: string; planType: string }; requiresOpenaiAuth: boolean }>();
    accountReadImpl = () => auth.promise;
    await renderApp();

    await waitFor(() => {
      const call = invokeMock.mock.calls.find(([, args]) => args?.method === "account/read");
      expect(call?.[1]?.params).toEqual({ refreshToken: false });
    });
    const methodsBeforeAuth = invokeMock.mock.calls
      .filter(([command]) => command === "codex_rpc")
      .map(([, args]) => args?.method);
    expect(methodsBeforeAuth).toContain("thread/list");
    expect(methodsBeforeAuth).not.toContain("model/list");
    expect(methodsBeforeAuth).toContain("skills/list");

    await act(async () => {
      auth.resolve({
        account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
        requiresOpenaiAuth: true,
      });
      await auth.promise;
    });

    await waitFor(() => {
      const methods = invokeMock.mock.calls
        .filter(([command]) => command === "codex_rpc")
        .map(([, args]) => args?.method);
      expect(methods).toContain("thread/list");
      expect(methods).toContain("model/list");
      expect(methods).toContain("skills/list");
    });
  });

  it("recovers a durable local thread when the browser sidebar index is missing", async () => {
    const user = userEvent.setup();
    const claudeThread: Thread = {
      ...THREAD_A,
      id: "durable-claude",
      name: "Recovered Claude thread",
      preview: "recover me from SQLite",
      modelProvider: "claude",
    };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "local_transcript_list") return [claudeThread];
      if (command === "local_transcript_page_read" && args?.threadId === claudeThread.id) {
        return {
          thread: claudeThread,
          messages: [{ id: "recovered-message", role: "assistant", text: "durable history is visible", timelineOrder: 1 }],
          activities: [],
          nextCursor: null,
          headSeq: 0,
          tailSeq: 1,
          generation: 3,
          byteLen: 512,
        };
      }
      return stubInvoke(command, args);
    });

    await renderApp();
    await user.click(await screen.findByText("Recovered Claude thread"));

    // This is a persistence assertion, not a cold-module latency benchmark.
    // Await the real lazy timeline import before starting findBy's 1s clock.
    await act(async () => { await import("./components/ChatTimeline"); });

    expect(await screen.findByText("durable history is visible")).toBeInTheDocument();
    const remembered = JSON.parse(localStorage.getItem("kiwi.knownThreads") ?? "{}") as Record<string, Thread>;
    expect(remembered[claudeThread.id]).toMatchObject({ id: claudeThread.id, modelProvider: "claude" });
  });

  it("keeps durable local threads available when OpenAI listing fails", async () => {
    const claudeThread: Thread = {
      ...THREAD_A,
      id: "offline-claude",
      name: "Offline Claude thread",
      modelProvider: "claude",
    };
    threadListImpl = () => {
      throw new Error("OpenAI runtime is temporarily unavailable");
    };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "local_transcript_list") return [claudeThread];
      return stubInvoke(command, args);
    });

    await renderApp();

    expect(await screen.findByText("Offline Claude thread")).toBeInTheDocument();
    expect(screen.getByText("OpenAI runtime is temporarily unavailable")).toBeInTheDocument();
  });

  it("does not resurrect an archived local transcript during durable discovery", async () => {
    const archivedClaude: Thread = {
      ...THREAD_A,
      id: "archived-claude",
      name: "Archived Claude thread",
      modelProvider: "claude",
    };
    localStorage.setItem("kiwi.archivedThreads", JSON.stringify([{
      id: archivedClaude.id,
      label: archivedClaude.name,
      path: PROJECT_A.path,
      archivedAt: Date.now(),
      provider: "claude",
    }]));
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "local_transcript_list") return [archivedClaude];
      return stubInvoke(command, args);
    });

    await renderApp();

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("local_transcript_list", {
      knownThreadIds: [archivedClaude.id],
    }));
    expect(screen.queryByText("Archived Claude thread")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Archived\s*1/i })).toBeInTheDocument();
  });

  it("renders the newest thread page while older sidebar pages are still loading", async () => {
    const olderPage = deferred<{ data: Thread[]; nextCursor: null }>();
    threadListImpl = (params) => {
      if (params.cwd !== PROJECT_A.path) return { data: [], nextCursor: null };
      if (params.cursor === "older-threads") return olderPage.promise;
      return { data: [THREAD_A], nextCursor: "older-threads" };
    };
    await renderApp();

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({
      method: "thread/list",
      params: { cwd: PROJECT_A.path, limit: 100, cursor: "older-threads" },
    })));
    expect(await screen.findByText("Alpha thread", {}, { timeout: 500 })).toBeInTheDocument();
    expect(screen.queryByText("Beta thread")).not.toBeInTheDocument();

    await act(async () => {
      olderPage.resolve({ data: [THREAD_B], nextCursor: null });
      await olderPage.promise;
    });
    expect(await screen.findByText("Beta thread")).toBeInTheDocument();
  });

  it("refreshes models and usage when a signed-in account update arrives", async () => {
    let loggedIn = false;
    accountReadImpl = () => ({
      account: loggedIn ? { type: "chatgpt", email: "test@example.com", planType: "pro" } : null,
      requiresOpenaiAuth: true,
    });
    await renderApp();
    await waitFor(() => expect(tauriEvents.handlers.has("codex-event")).toBe(true));
    expect(invokeMock.mock.calls.filter(([, args]) => args?.method === "model/list")).toHaveLength(0);

    loggedIn = true;
    await act(async () => {
      tauriEvents.handlers.get("codex-event")?.({ payload: { method: "account/updated", params: {} } });
    });

    await waitFor(() => {
      expect(invokeMock.mock.calls.some(([, args]) => args?.method === "model/list")).toBe(true);
      expect(invokeMock.mock.calls.some(([, args]) => args?.method === "account/rateLimits/read")).toBe(true);
    });
  });
});

describe("chat header provider usage", () => {
  it("does not reuse another account's quota or accept its late response", async () => {
    rateLimitsImpl = () => ({ rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300 } } });
    await renderApp();
    const trigger = await screen.findByRole("button", { name: /OpenAI subscription: 5h 58% left/ });
    const oldRead = deferred<unknown>();
    rateLimitsImpl = () => oldRead.promise;
    fireEvent.click(trigger);
    await waitFor(() => expect(invokeMock.mock.calls.filter(([, args]) => args?.method === "account/rateLimits/read").length).toBeGreaterThan(1));
    const newRead = deferred<unknown>();
    rateLimitsImpl = () => newRead.promise;
    accountReadImpl = () => ({ account: { type: "chatgpt", email: "different@example.com", planType: "pro" } });
    await act(async () => {
      tauriEvents.handlers.get("codex-event")?.({ payload: { method: "account/updated", params: { authMode: "chatgpt" } } });
    });
    expect(screen.queryByRole("button", { name: /OpenAI subscription: 5h 58% left/ })).not.toBeInTheDocument();
    await act(async () => { newRead.resolve({ rateLimits: { primary: { usedPercent: 70, windowDurationMins: 300 } } }); });
    await screen.findByRole("button", { name: /OpenAI subscription: 5h 30% left/ });
    await act(async () => { oldRead.resolve({ rateLimits: { primary: { usedPercent: 99, windowDurationMins: 300 } } }); });
    expect(screen.getByRole("button", { name: /OpenAI subscription: 5h 30% left/ })).toBeInTheDocument();
  });

  it("retains a same-account quota with its age when a refresh fails", async () => {
    rateLimitsImpl = () => ({ rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300 } } });
    await renderApp();
    const trigger = await screen.findByRole("button", { name: /OpenAI subscription: 5h 58% left/ });
    rateLimitsImpl = () => { throw new Error("500 Internal Server Error"); };
    fireEvent.click(trigger);
    await screen.findByText("Usage refresh unavailable · last reading retained");
    expect(screen.getByRole("button", { name: /OpenAI subscription: 5h 58% left/ })).toBeInTheDocument();
    expect(screen.getByText("Updated just now")).toBeInTheDocument();
  });

  it("revalidates the saved OpenAI session when Settings opens", async () => {
    await renderApp();
    await screen.findByRole("button", { name: /OpenAI subscription/ });
    accountReadImpl = ({ refreshToken }) => {
      if (refreshToken) throw new Error("refresh_token_expired");
      return { account: { type: "chatgpt", email: "old@example.com", planType: "pro" } };
    };
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({ method: "account/read", params: { refreshToken: true } })));
    await screen.findByRole("button", { name: /OpenAI subscription.*Sign in for usage/ });
  });

  it("clears stale OpenAI identity when the runtime drops the session and ignores an older account response", async () => {
    await renderApp();
    await screen.findByRole("button", { name: /OpenAI subscription/ });
    const stale = deferred<{ account: { type: string; email: string; planType: string } }>();
    accountReadImpl = () => stale.promise;
    await act(async () => { tauriEvents.handlers.get("codex-event")?.({ payload: { method: "account/updated", params: { authMode: "chatgpt", planType: "pro" } } }); });
    await act(async () => { tauriEvents.handlers.get("codex-event")?.({ payload: { method: "account/updated", params: { authMode: null, planType: null } } }); });
    expect(screen.getByRole("button", { name: /OpenAI subscription.*Sign in for usage/ })).toBeInTheDocument();
    await act(async () => {
      stale.resolve({ account: { type: "chatgpt", email: "stale@example.com", planType: "pro" } });
      await stale.promise;
    });
    expect(screen.getByRole("button", { name: /OpenAI subscription.*Sign in for usage/ })).toBeInTheDocument();
  });

  it("keeps the ChatGPT account when a stderr 401 belongs to something else", async () => {
    rateLimitsImpl = () => ({ rateLimits: { primary: { usedPercent: 42, windowMinutes: 300 } } });
    await renderApp();
    await screen.findByRole("button", { name: /OpenAI subscription.*58% left/ });
    const readsBefore = invokeMock.mock.calls.filter(([, args]) => args?.method === "account/read").length;
    // An MCP server or OpenRouter rejection shares the runtime's stderr.
    await act(async () => { tauriEvents.handlers.get("codex-event")?.({ payload: { stream: "stderr", line: "mcp server github: 401 Unauthorized" } }); });
    await waitFor(() => expect(invokeMock.mock.calls.filter(([, args]) => args?.method === "account/read").length).toBe(readsBefore + 1));
    const verification = invokeMock.mock.calls.filter(([, args]) => args?.method === "account/read").at(-1)?.[1] as { params?: { refreshToken?: boolean } } | undefined;
    expect(verification?.params?.refreshToken).toBe(true);
    expect(screen.getByRole("button", { name: /OpenAI subscription.*58% left/ })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Sign in before sending" })).not.toBeInTheDocument();
  });

  it("signs out when the verification triggered by a stderr 401 is itself rejected", async () => {
    rateLimitsImpl = () => ({ rateLimits: { primary: { usedPercent: 42, windowMinutes: 300 } } });
    await renderApp();
    await screen.findByRole("button", { name: /OpenAI subscription.*58% left/ });
    accountReadImpl = () => { throw new Error("refresh_token_expired"); };
    await act(async () => { tauriEvents.handlers.get("codex-event")?.({ payload: { stream: "stderr", line: "401 Unauthorized" } }); });
    expect(await screen.findByRole("button", { name: /OpenAI subscription.*Sign in for usage/ })).toBeInTheDocument();
    expect(await screen.findByRole("dialog", { name: "Sign in before sending" })).toBeInTheDocument();
  });

  it.each([true, false])("only clears identity for authentication failures during usage refresh (%s)", async (authFailure) => {
    const user = userEvent.setup();
    await renderApp();
    const trigger = await screen.findByRole("button", { name: /OpenAI subscription/ });
    rateLimitsImpl = () => { throw new Error(authFailure ? "refresh_token_reused" : "500 Internal Server Error"); };
    await user.click(trigger);
    await waitFor(() => expect(invokeMock.mock.calls.filter(([, args]) => args?.method === "account/rateLimits/read").length).toBeGreaterThan(1));
    if (authFailure) await screen.findByRole("button", { name: /OpenAI subscription.*Sign in for usage/ });
    else expect(screen.queryByRole("button", { name: /OpenAI subscription.*Sign in for usage/ })).not.toBeInTheDocument();
  });

  it("persists the chosen OpenAI window separately from Claude and restores it after reopening", async () => {
    const user = userEvent.setup();
    rateLimitsImpl = () => ({ rateLimits: { primary: { usedPercent: 42, windowMinutes: 300 }, secondary: { usedPercent: 10, windowMinutes: 10080 } } });
    localStorage.setItem("kiwi.headerUsageWindows", JSON.stringify({ claude: "Weekly Fable" }));
    const view = await renderApp();
    const trigger = await screen.findByRole("button", { name: /OpenAI subscription: 5h 58% left/ });
    const reads = invokeMock.mock.calls.filter(([, args]) => args?.method === "account/rateLimits/read").length;
    await user.click(trigger);
    await user.click(screen.getByRole("radio", { name: "Show Weekly in top bar" }));
    expect(trigger).toHaveTextContent("Weekly 90% left");
    // Opening asks for one fresh reading; picking a window inside the same
    // panel is a display choice and must not ask the provider again.
    expect(invokeMock.mock.calls.filter(([, args]) => args?.method === "account/rateLimits/read")).toHaveLength(reads + 1);
    expect(JSON.parse(localStorage.getItem("kiwi.headerUsageWindows")!)).toEqual({ openai: "Weekly", claude: "Weekly Fable" });
    view.unmount();
    await renderApp();
    expect(await screen.findByRole("button", { name: /OpenAI subscription: Weekly 90% left/ })).not.toHaveTextContent("5h");
  });

  it("keeps the control visible when Local Dev is signed out and opens account settings", async () => {
    const user = userEvent.setup();
    accountReadImpl = () => ({ account: null, requiresOpenaiAuth: true });
    await renderApp();

    const signInUsage = await screen.findByRole("button", {
      name: /OpenAI subscription.*Sign in for usage.*Open usage details/i,
    });
    expect(signInUsage).toHaveTextContent("Sign in for usage");
    expect(screen.queryByRole("button", { name: /^Models & accounts/ })).not.toBeInTheDocument();
    await user.click(signInUsage);
    await user.click(screen.getByRole("button", { name: "Models & accounts" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.getByRole("button", { name: "Sign in", hidden: true })).toBeInTheDocument();
    await user.click(signInUsage);
    await user.click(screen.getByRole("button", { name: "Models & accounts" }));
    expect(screen.getByRole("button", { name: "Sign in", hidden: true })).toBeInTheDocument();
  });

  it("shows live OpenRouter credits and opens the detailed usage surface", async () => {
    const user = userEvent.setup();
    openRouterReadyImpl = () => true;
    openRouterCreditsImpl = () => ({ remaining: 74.75, used: 25.75, source: "account" });
    localStorage.setItem("kiwi.settings", JSON.stringify({ provider: "openrouter", model: "x-ai/grok-4.5" }));
    await renderApp();

    const credits = await screen.findByRole("button", { name: /OpenRouter account.*74\.75 credits left.*Open usage details/i });
    expect(credits).toHaveTextContent("$74.75 credits left");
    await user.click(credits);
    expect(await screen.findByText(/Usage & audit|Provider quota display/)).toBeInTheDocument();
  });

  it("refreshes OpenRouter credits when an existing API key is replaced", async () => {
    const user = userEvent.setup();
    let requests = 0;
    openRouterReadyImpl = () => true;
    openRouterCreditsImpl = () => ({ remaining: requests++ === 0 ? 10 : 20, used: 1, source: "account" });
    localStorage.setItem("kiwi.settings", JSON.stringify({ provider: "openrouter", model: "x-ai/grok-4.5" }));
    await renderApp();

    expect(await screen.findByRole("button", { name: /\$10\.00 credits left/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: /Models & accounts/ }));
    await user.click(screen.getByRole("button", { name: /OpenRouter.*Pay-as-you-go API key/ }));
    await user.type(screen.getByPlaceholderText("sk-or-v1-…"), "sk-or-v1-new");
    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(await screen.findByRole("button", { name: /\$20\.00 credits left/i })).toBeInTheDocument();
    expect(requests).toBeGreaterThanOrEqual(2);
  });

  it("clears the previous OpenAI quota immediately after sign-out", async () => {
    const user = userEvent.setup();
    let loggedIn = true;
    accountReadImpl = () => ({
      account: loggedIn ? { type: "chatgpt", email: "test@example.com", planType: "pro" } : null,
      requiresOpenaiAuth: true,
    });
    accountLogoutImpl = () => {
      loggedIn = false;
      return {};
    };
    rateLimitsImpl = () => ({
      rateLimits: { primary: { usedPercent: 42, windowMinutes: 300, resetsAt: null } },
    });
    await renderApp();

    expect(await screen.findByRole("button", { name: /OpenAI subscription.*58% left/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: /Models & accounts/ }));
    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("button", { name: /OpenAI subscription.*Sign in for usage/i })).toHaveTextContent("Sign in for usage");
    expect(screen.queryByRole("button", { name: /OpenAI subscription.*58% left/i })).not.toBeInTheDocument();
    // A deliberate sign-out must not nag with the sign-in prompt that an
    // expired session raises.
    expect(screen.queryByRole("dialog", { name: "Sign in before sending" })).not.toBeInTheDocument();

    await act(async () => {
      tauriEvents.handlers.get("codex-event")?.({ payload: { method: "account/updated", params: { authMode: null, planType: null } } });
    });
    expect(screen.queryByRole("dialog", { name: "Sign in before sending" })).not.toBeInTheDocument();
  });

  it("prompts for sign-in when the runtime loses the session on its own", async () => {
    accountReadImpl = () => ({
      account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
      requiresOpenaiAuth: true,
    });
    await renderApp();
    expect(await screen.findByRole("button", { name: /OpenAI subscription/i })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Sign in before sending" })).not.toBeInTheDocument();

    await act(async () => {
      tauriEvents.handlers.get("codex-event")?.({ payload: { method: "account/updated", params: { authMode: null, planType: null } } });
    });
    expect(await screen.findByRole("dialog", { name: "Sign in before sending" })).toBeInTheDocument();
  });

  it("ignores an old quota request that completes after sign-out", async () => {
    const user = userEvent.setup();
    const pendingUsage = deferred<{ rateLimits: { primary: { usedPercent: number; windowMinutes: number } } }>();
    let loggedIn = true;
    accountReadImpl = () => ({
      account: loggedIn ? { type: "chatgpt", email: "test@example.com", planType: "pro" } : null,
      requiresOpenaiAuth: true,
    });
    accountLogoutImpl = () => {
      loggedIn = false;
      return {};
    };
    rateLimitsImpl = () => pendingUsage.promise;
    await renderApp();
    await waitFor(() => expect(invokeMock.mock.calls.some(([, args]) => args?.method === "account/rateLimits/read")).toBe(true));

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: /Models & accounts/ }));
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    await act(async () => {
      pendingUsage.resolve({ rateLimits: { primary: { usedPercent: 42, windowMinutes: 300 } } });
      await pendingUsage.promise;
    });

    expect(await screen.findByRole("button", { name: /OpenAI subscription.*Sign in for usage/i })).toHaveTextContent("Sign in for usage");
    expect(screen.queryByRole("button", { name: /OpenAI subscription.*58% left/i })).not.toBeInTheDocument();
  });
});

describe("project sidebar Open folder action", () => {
  it("opens an inactive project's own folder without changing the active workspace", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(await screen.findByRole("button", { name: `Options for ${PROJECT_B.name}` }));
    await user.click(screen.getByRole("menuitem", { name: "Open folder" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("open_workspace_folder", { path: PROJECT_B.path }));
    expect(screen.queryByRole("menu", { name: `Options for ${PROJECT_B.name}` })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: PROJECT_A.name }).closest(".workspace-row-wrap")).toHaveClass("active");
    expect(invokeMock.mock.calls.some(([command, args]) => command === "codex_rpc" && args?.method === "thread/resume")).toBe(false);
  });

  it("keeps a missing project folder error visible without suggesting a runtime reinstall", async () => {
    const failure = "Could not access the folder: No such file or directory";
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "open_workspace_folder") throw new Error(failure);
      return stubInvoke(command, args);
    });
    const user = userEvent.setup();
    await renderApp();
    await user.click(await screen.findByRole("button", { name: `Options for ${PROJECT_A.name}` }));
    await user.click(screen.getByRole("menuitem", { name: "Open folder" }));
    expect(await screen.findByText(failure)).toBeInTheDocument();
    expect(screen.queryByText(/Codex runtime could not be found/)).not.toBeInTheDocument();
  });
});

describe("thread inbox Open folder action", () => {
  it("opens an inactive thread's folder without selecting or resuming the thread", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(await screen.findByRole("button", { name: "Options for Beta thread" }));
    await user.click(screen.getByRole("menuitem", { name: "Open folder" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("open_workspace_folder", { path: PROJECT_A.path }));
    expect(screen.queryByRole("menu", { name: "Options for Beta thread" })).not.toBeInTheDocument();
    expect(invokeMock.mock.calls.some(([command, args]) => command === "codex_rpc" && args?.method === "thread/resume")).toBe(false);
  });

  it("opens the thread's isolated worktree rather than the shared project", async () => {
    localStorage.setItem("kiwi.threadWorktrees", JSON.stringify({
      [THREAD_A.id]: {
        threadId: THREAD_A.id, projectId: PROJECT_A.id, projectPath: PROJECT_A.path,
        path: "/managed/worktrees/thread-a", branch: "mythra/thread-a",
        baseCommit: "head", gitDir: "/projects/alpha/.git", createdAt: 1, status: "active",
      },
    }));
    const user = userEvent.setup();
    await renderApp();
    await user.click(await screen.findByRole("button", { name: "Options for Alpha thread" }));
    await user.click(screen.getByRole("menuitem", { name: "Open folder" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("open_workspace_folder", { path: "/managed/worktrees/thread-a" }));
  });

  it("uses the durable project binding when a provider reports an old folder", async () => {
    localStorage.setItem("kiwi.threadProjects", JSON.stringify({ [THREAD_A.id]: PROJECT_A.path }));
    threadListImpl = () => ({ data: [{ ...THREAD_A, cwd: "/old/project-location" }], nextCursor: null });
    const user = userEvent.setup();
    await renderApp();
    await user.click(await screen.findByRole("button", { name: "Options for Alpha thread" }));
    await user.click(screen.getByRole("menuitem", { name: "Open folder" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("open_workspace_folder", { path: PROJECT_A.path }));
  });

  it("keeps native folder failures visible without misreporting a missing Codex runtime", async () => {
    const failure = "Could not access the thread's folder: No such file or directory";
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "open_workspace_folder") throw new Error(failure);
      return stubInvoke(command, args);
    });
    const user = userEvent.setup();
    await renderApp();
    await user.click(await screen.findByRole("button", { name: "Options for Alpha thread" }));
    await user.click(screen.getByRole("menuitem", { name: "Open folder" }));
    expect(await screen.findByText(failure)).toBeInTheDocument();
    expect(screen.queryByText(/Codex runtime could not be found/)).not.toBeInTheDocument();
  });
});

describe("GitHub CLI installation refresh", () => {
  it("detects a newly installed CLI from Settings without remounting the app", async () => {
    let installed = false;
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "github_status" && !installed) return {
        available: false, authenticated: false, error: "GitHub CLI is not installed.",
      };
      return stubInvoke(command, args);
    });
    await renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: /^GitHub/ }));
    expect(await screen.findByText("GitHub CLI is required")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh GitHub status" })).toBeEnabled());
    installed = true;
    await user.click(screen.getByRole("button", { name: "Refresh GitHub status" }));
    expect(await screen.findByText("@test-user")).toBeInTheDocument();
    expect(screen.queryByText("GitHub CLI is required")).not.toBeInTheDocument();
  });
});

describe("GitHub clone parent-folder flow", () => {
  it("clones to the previewed subfolder and preserves projects added while the clone is running", async () => {
    const user = userEvent.setup();
    const pendingClone = deferred<null>();
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => command === "github_clone_repository" ? pendingClone.promise : stubInvoke(command, args));
    await renderApp();
    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValueOnce("/projects").mockResolvedValueOnce("/projects/added-during-clone");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: /^GitHub/ }));
    await user.type(screen.getByRole("textbox", { name: "Repository URL" }), "https://github.com/owner/cloned.git?tab=readme");
    await user.click(screen.getByRole("button", { name: "Choose parent folder…" }));
    expect(await screen.findByText("/projects/cloned")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clone repository" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("github_clone_repository", { url: "https://github.com/owner/cloned.git", destination: "/projects/cloned" }));
    await user.click(screen.getByRole("button", { name: "Close settings" }));
    await user.click(screen.getByRole("button", { name: "Add project" }));
    expect(await screen.findByRole("button", { name: "added-during-clone" })).toBeInTheDocument();
    await act(async () => { pendingClone.resolve(null); await pendingClone.promise; });
    expect(await screen.findByRole("button", { name: "cloned" })).toBeInTheDocument();
    const paths = JSON.parse(localStorage.getItem("kiwi.projects")!).map((project: { path: string }) => project.path);
    expect(paths).toEqual([PROJECT_A.path, PROJECT_B.path, "/projects/added-during-clone", "/projects/cloned"]);
  });
});

describe("project defaults", () => {
  it("automatically applies project provider, model, theme, effort-slider, and chat-font defaults", async () => {
    localStorage.setItem("kiwi.projects", JSON.stringify([
      {
        ...PROJECT_A,
        overrides: {
          defaults: {
            provider: "claude",
            model: "claude-opus-5",
            theme: "synthwave",
            effortSlider: "coil",
            chatFont: "humanist",
          },
        },
      },
      PROJECT_B,
    ]));

    const user = userEvent.setup();
    await renderApp();
    const shell = document.querySelector(".app-shell");

    expect(shell).toHaveAttribute("data-theme", "synthwave");
    expect(shell).toHaveAttribute("data-effort-slider", "coil");
    expect(shell).toHaveAttribute("data-chat-font", "humanist");
    expect(screen.getByRole("button", { name: "New thread provider: Claude" })).toHaveTextContent("Claude");
    expect(screen.getByRole("button", { name: /Claude model:/ })).toHaveTextContent("Opus");

    await user.click(screen.getByRole("button", { name: PROJECT_B.name }));

    expect(shell).toHaveAttribute("data-theme", "mythra");
    expect(shell).toHaveAttribute("data-effort-slider", "aurora");
    expect(shell).toHaveAttribute("data-chat-font", "system");
    expect(screen.getByRole("button", { name: "New thread provider: OpenAI" })).toBeInTheDocument();
  });
});

describe("Claude model updates", () => {
  it("routes an update-required successor to Settings without selecting its sentinel id", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    localStorage.setItem("kiwi.settings", JSON.stringify({ provider: "claude", model: "sonnet" }));
    claudeRuntimeStatusImpl = () => ({
      available: true,
      path: "/usr/local/bin/claude",
      version: "2.1.250",
      loggedIn: true,
      authMethod: "claude.ai",
      email: "test@example.com",
      subscriptionType: "max",
      warning: null,
    });
    claudeModelsImpl = () => ({
      models: [
        { value: "sonnet", displayName: "Sonnet", description: "Sonnet 5", resolvedModel: "claude-sonnet-5" },
        { value: "claude-fable-5[1m]", displayName: "Fable", description: "Fable 5 · Most capable", resolvedModel: "claude-fable-5[1m]" },
        { value: "cc-update-required-1", displayName: "Fable 5.1 (disabled)", description: "Update to 2.1.255+ to use Fable 5.1", resolvedModel: "cc-update-required-1", isDisabled: true },
      ],
    });

    try {
      const user = userEvent.setup();
      await renderApp();
      await user.click(await screen.findByRole("button", { name: /Claude model: Sonnet/i }));
      expect(screen.queryByRole("menuitemradio", { name: /^Fable$/ })).not.toBeInTheDocument();
      await user.click(await screen.findByRole("menuitem", { name: /Fable 5\.1 \(Claude Code update required\)/ }));
      expect(localStorage.getItem("kiwi.settings")).toContain('"model":"sonnet"');
      await user.click(await screen.findByRole("button", { name: "Go to Updates" }));
      const settings = await screen.findByRole("dialog", { name: "Settings" });
      expect(within(settings).getByRole("heading", { name: "Updates" })).toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    }
  });
});

describe("chat typeface", () => {
  it.each([["atari", "light"], ["synthwave", "dark"]])("restores the saved %s palette on the actual app shell", async (theme, scheme) => {
    localStorage.setItem("kiwi.settings", JSON.stringify({ theme }));
    await renderApp();
    const shell = document.querySelector(".app-shell");
    expect(shell).toHaveAttribute("data-theme", theme);
    expect(shell).toHaveAttribute("data-color-scheme", scheme);
  });

  it.each(["midnight", "monochrome"])("opens a saved retired %s palette as Mythra instead of an unstyled shell", async (theme) => {
    localStorage.setItem("kiwi.settings", JSON.stringify({ theme }));
    await renderApp();
    const shell = document.querySelector(".app-shell");
    expect(shell).toHaveAttribute("data-theme", "mythra");
    expect(shell).toHaveAttribute("data-color-scheme", "dark");
  });

  it("publishes a saved chat font on the shell for the scoped chat styles to read", async () => {
    localStorage.setItem("kiwi.settings", JSON.stringify({ chatFont: "serif" }));

    await renderApp();

    expect(document.querySelector(".app-shell")).toHaveAttribute("data-chat-font", "serif");
  });

  it("falls back to the interface default for settings saved before the selector", async () => {
    // A settings blob from an older build has no chatFont at all, and a
    // hand-edited one can hold anything; both must render as the default.
    localStorage.setItem("kiwi.settings", JSON.stringify({ theme: "synthwave", chatFont: "Papyrus" }));

    await renderApp();

    const shell = document.querySelector(".app-shell");
    expect(shell).toHaveAttribute("data-chat-font", "system");
    expect(shell).toHaveAttribute("data-theme", "synthwave");
  });

  it("previews live and restores the saved typeface when Settings is cancelled", async () => {
    const user = userEvent.setup();
    await renderApp();
    const shell = document.querySelector(".app-shell");

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: /Reading serif/ }));
    expect(shell).toHaveAttribute("data-chat-font", "serif");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument());
    expect(shell).toHaveAttribute("data-chat-font", "system");
    expect(JSON.parse(localStorage.getItem("kiwi.settings") ?? "{}").chatFont).toBeUndefined();
  });

  it("persists a saved typeface through the real app settings store", async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: /Monospace/ }));
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(JSON.parse(localStorage.getItem("kiwi.settings") ?? "{}").chatFont).toBe("mono"));
    expect(document.querySelector(".app-shell")).toHaveAttribute("data-chat-font", "mono");
  });
});

describe("overlapping refresh ordering", () => {
  it("ignores an older Cursor status check that completes after a newer one", async () => {
    localStorage.setItem("kiwi.settings", JSON.stringify({ provider: "cursor", model: "auto" }));
    const checks: Array<Deferred<unknown>> = [];
    cursorRuntimeStatusImpl = () => {
      const check = deferred<unknown>();
      checks.push(check);
      return check.promise;
    };
    const user = userEvent.setup();
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await user.click(screen.getByRole("button", { name: "Models & accounts" }));
    const started = checks.length;
    await user.click(await screen.findByRole("button", { name: "Refresh Cursor status" }));
    await waitFor(() => expect(checks.length).toBeGreaterThan(started));
    expect(checks.length).toBeGreaterThanOrEqual(2);
    const newest = checks[checks.length - 1];
    const older = checks.slice(0, -1);
    const signedIn = { available: true, path: "/usr/local/bin/cursor-agent", version: "2026.07.23", loggedIn: true, email: "person@example.com", subscriptionType: "Pro", warning: null };
    await act(async () => { newest.resolve(signedIn); });
    await waitFor(() => expect(dialog.querySelector(".credential-panel .connected-badge")).toBeInTheDocument());
    // The slower, older checks land afterwards and must not undo the sign-in.
    await act(async () => {
      for (const check of older) check.resolve({ ...signedIn, loggedIn: false, email: null, subscriptionType: null });
    });
    await act(async () => { await Promise.resolve(); });
    expect(dialog.querySelector(".credential-panel .connected-badge")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("lets a slow skills refresh finish instead of superseding it on each poll", async () => {
    localStorage.setItem("kiwi.skillsFolder", JSON.stringify("/skills"));
    const scan = deferred<unknown>();
    localSkillsScanImpl = () => scan.promise;
    const sync = deferred<string>();
    localSkillsSyncImpl = () => sync.promise;
    await renderApp();
    await screen.findByText("Alpha thread");
    const scans = () => invokeMock.mock.calls.filter(([command]) => command === "local_skills_scan").length;
    const initialScans = scans();
    expect(initialScans).toBeGreaterThan(0);
    const intervals = vi.spyOn(window, "setInterval");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(intervals.mock.calls.some(([, delay]) => delay === 5_000)).toBe(true));
    const poll = intervals.mock.calls.find(([, delay]) => delay === 5_000)![0] as () => void;
    // Reproduce a scan/sync taking longer than several watcher ticks.
    await act(async () => { poll(); poll(); poll(); });
    expect(scans()).toBe(initialScans);
    await act(async () => { scan.resolve([{ path: "/skills/review/SKILL.md", relativePath: "review/SKILL.md", fileName: "SKILL.md", defaultName: "review", description: "", supportingMarkdownCount: 0 }]); });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("local_skills_sync", expect.anything()));
    await act(async () => { poll(); });
    expect(scans()).toBe(initialScans);
    await act(async () => { sync.resolve("/runtime/skills"); });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({ method: "skills/extraRoots/set", params: { extraRoots: ["/runtime/skills"] } })));
    await act(async () => { poll(); });
    expect(scans()).toBe(initialScans + 1);
  });

  it("serializes skills sync so an older scan cannot overwrite a newer runtime", async () => {
    localStorage.setItem("kiwi.skillsFolder", JSON.stringify("/skills"));
    let scans = 0;
    // Every scan reports a different library so a silent refresh never
    // short-circuits as unchanged.
    localSkillsScanImpl = () => {
      scans += 1;
      return [{ path: `/skills/skill-${scans}/SKILL.md`, relativePath: `skill-${scans}/SKILL.md`, fileName: "SKILL.md", defaultName: `skill-${scans}`, description: "", supportingMarkdownCount: 0 }];
    };
    const syncs: Array<Deferred<string>> = [];
    localSkillsSyncImpl = () => {
      const sync = deferred<string>();
      syncs.push(sync);
      return sync.promise;
    };
    await renderApp();
    await screen.findByText("Alpha thread");
    await waitFor(() => expect(syncs.length).toBeGreaterThanOrEqual(1));
    const oldest = syncs[0];
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    // The newer native sync is queued behind the old one because both replace
    // the same app-managed runtime directory.
    expect(syncs).toHaveLength(1);
    await act(async () => { oldest.resolve("/runtime/stale"); });
    await waitFor(() => expect(syncs.length).toBeGreaterThanOrEqual(2));
    const newest = syncs[syncs.length - 1];
    const extraRootsCalls = () => invokeMock.mock.calls
      .filter(([command, args]) => command === "codex_rpc" && args?.method === "skills/extraRoots/set")
      .map(([, args]) => ((args?.params ?? {}) as { extraRoots: string[] }).extraRoots);
    await act(async () => { newest.resolve("/runtime/newest"); });
    await waitFor(() => expect(extraRootsCalls().at(-1)).toEqual(["/runtime/newest"]));
    expect(extraRootsCalls().flat()).not.toContain("/runtime/stale");
  });

  it("waits for the persisted skills folder before resolving the first @skill prompt", async () => {
    localStorage.setItem("kiwi.skillsFolder", JSON.stringify("/skills"));
    const scan = deferred<unknown>();
    localSkillsScanImpl = () => scan.promise;
    localSkillsResolvePromptImpl = (params) => `resolved selected skill\n\n${String(params.message)}`;
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);

    await user.type(composer, "@review inspect this{Enter}");
    expect(invokeMock.mock.calls.some(([command, args]) => command === "codex_rpc" && args?.method === "turn/start")).toBe(false);

    await act(async () => {
      scan.resolve([{
        path: "/skills/review/SKILL.md",
        relativePath: "review/SKILL.md",
        fileName: "SKILL.md",
        defaultName: "review",
        description: "Review carefully",
        supportingMarkdownCount: 0,
      }]);
    });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("local_skills_resolve_prompts", expect.objectContaining({
      folder: "/skills",
      message: "@review inspect this",
      skills: [expect.objectContaining({ name: "review", enabled: true })],
    })));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({
      method: "turn/start",
      params: expect.objectContaining({
        input: [expect.objectContaining({ text: "resolved selected skill\n\n@review inspect this" })],
      }),
    })));
  });

  it.each(["review", "unknown"] as const)("revalidates @%s when a skill is disabled during resolution", async (mention) => {
    localStorage.setItem("kiwi.skillsFolder", JSON.stringify("/skills"));
    localSkillsScanImpl = () => [selectedReviewSkill];
    const pending = deferred<{ prompt: string; systemPrompt: string }>();
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "local_skills_resolve_prompts") return pending.promise;
      return stubInvoke(command, args);
    });
    const user = userEvent.setup();
    await renderApp();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("local_skills_sync", expect.anything()));
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    await user.type(await screen.findByPlaceholderText(/Ask Mythra Code to work in/), `@${mention} inspect{Enter}`);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("local_skills_resolve_prompts", expect.anything()));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Settings" })).getByRole("button", { name: "Skills" }));
    await user.click(await screen.findByRole("switch", { name: "Disable review" }));
    await screen.findByRole("switch", { name: "Enable review" });
    await act(async () => pending.resolve({ prompt: mention === "review" ? "stale review instructions" : "@unknown inspect", systemPrompt: "" }));
    if (mention === "review") {
      await waitFor(() => expect(screen.getByText(/skills library changed while preparing/i)).toBeInTheDocument());
      expect(invokeMock.mock.calls.some(([command, args]) => command === "codex_rpc" && args?.method === "turn/start")).toBe(false);
    } else {
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({
        method: "turn/start", params: expect.objectContaining({ input: [expect.objectContaining({ text: "@unknown inspect" })] }),
      })));
    }
  });

  it.each(["user", "system"] as const)("refreshes an edited supporting document before a %s skill send", async (channel) => {
    localStorage.setItem("kiwi.skillsFolder", JSON.stringify("/skills"));
    if (channel === "system") localStorage.setItem("kiwi.settings", JSON.stringify({ ...DEFAULT_SETTINGS, systemPrompt: "Use @review." }));
    let guide = "old guide";
    let mirroredGuide = "";
    localSkillsScanImpl = () => [{ ...selectedReviewSkill, contentFingerprint: guide }];
    localSkillsSyncImpl = () => { mirroredGuide = guide; return "/runtime/skills"; };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "local_skills_resolve_prompts") return {
        prompt: channel === "user" ? `Guide: ${mirroredGuide}\n${String(args?.message)}` : args?.message,
        systemPrompt: channel === "system" ? `Guide: ${mirroredGuide}\n${String(args?.systemPrompt)}` : args?.systemPrompt,
      };
      return stubInvoke(command, args);
    });
    const user = userEvent.setup();
    await renderApp();
    await waitFor(() => expect(mirroredGuide).toBe("old guide"));
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    const scansBeforeSend = invokeMock.mock.calls.filter(([command]) => command === "local_skills_scan").length;
    guide = "new guide from guide.txt";
    await user.type(await screen.findByPlaceholderText(/Ask Mythra Code to work in/), `${channel === "user" ? "@review " : ""}Inspect this project{Enter}`);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({ method: "turn/start" })));
    expect(invokeMock.mock.calls.filter(([command]) => command === "local_skills_scan").length).toBeGreaterThan(scansBeforeSend);
    expect(mirroredGuide).toBe("new guide from guide.txt");
    const turn = invokeMock.mock.calls.find(([command, args]) => command === "codex_rpc" && args?.method === "turn/start")![1]?.params as {
      input: Array<{ text: string }>;
      collaborationMode: { settings: { developer_instructions: string } };
    };
    const delivered = channel === "user" ? turn.input[0].text : turn.collaborationMode.settings.developer_instructions;
    expect(delivered).toContain("Guide: new guide from guide.txt");
    expect(delivered).not.toContain("Guide: old guide");
  });

  it.each(["scan", "sync"] as const)("blocks a skill send when its required %s fails after a prior mirror was prepared", async (failure) => {
    localStorage.setItem("kiwi.skillsFolder", JSON.stringify("/skills"));
    let fail = false;
    localSkillsScanImpl = () => {
      if (fail && failure === "scan") throw new Error("Skill source unavailable");
      return [{ ...selectedReviewSkill, contentFingerprint: fail ? "updated guide" : "old guide" }];
    };
    localSkillsSyncImpl = () => {
      if (fail && failure === "sync") throw new Error("Skill mirror unavailable");
      return "/runtime/skills";
    };
    const user = userEvent.setup();
    await renderApp();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("local_skills_sync", expect.anything()));
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    fail = true;
    await user.type(await screen.findByPlaceholderText(/Ask Mythra Code to work in/), "@review Inspect this project{Enter}");
    expect(await screen.findByText(/could not (?:load|refresh) the selected skills folder/i)).toBeInTheDocument();
    expect(invokeMock.mock.calls.some(([command, args]) => command === "codex_rpc" && ["thread/start", "turn/start"].includes(String(args?.method)))).toBe(false);
    expect(invokeMock.mock.calls.some(([command]) => command === "local_skills_resolve_prompts")).toBe(false);
    if (failure === "sync") {
      const roots = invokeMock.mock.calls
        .filter(([command, args]) => command === "codex_rpc" && args?.method === "skills/extraRoots/set")
        .map(([, args]) => ((args?.params ?? {}) as { extraRoots: string[] }).extraRoots);
      expect(roots).toContainEqual(["/runtime/skills"]);
      expect(roots.at(-1)).toEqual([]);
    }
  });

  it("does not scan the skills folder for an ordinary send after warmup", async () => {
    localStorage.setItem("kiwi.skillsFolder", JSON.stringify("/skills"));
    localSkillsScanImpl = () => [selectedReviewSkill];
    const user = userEvent.setup();
    await renderApp();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("local_skills_sync", expect.anything()));
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    const scansBeforeSend = invokeMock.mock.calls.filter(([command]) => command === "local_skills_scan").length;
    await user.type(await screen.findByPlaceholderText(/Ask Mythra Code to work in/), "Inspect this project{Enter}");
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({ method: "turn/start" })));
    expect(invokeMock.mock.calls.filter(([command]) => command === "local_skills_scan")).toHaveLength(scansBeforeSend);
  });

  it("retries a skill send when a focus refresh supersedes its scan", async () => {
    localStorage.setItem("kiwi.skillsFolder", JSON.stringify("/skills"));
    localSkillsScanImpl = () => [selectedReviewSkill];
    const user = userEvent.setup();
    await renderApp();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("local_skills_sync", expect.anything()));
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    const sendScan = deferred<LocalSkillFile[]>();
    let held = false;
    localSkillsScanImpl = () => {
      if (!held) { held = true; return sendScan.promise; }
      return [selectedReviewSkill];
    };
    await user.type(await screen.findByPlaceholderText(/Ask Mythra Code to work in/), "@review Inspect this project{Enter}");
    await waitFor(() => expect(held).toBe(true));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await act(async () => { sendScan.resolve([selectedReviewSkill]); });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({ method: "turn/start" })));
    expect(invokeMock.mock.calls.filter(([command]) => command === "local_skills_scan").length).toBeGreaterThanOrEqual(3);
  });

  it("discovers a newly added user skill before resolving its first send", async () => {
    localStorage.setItem("kiwi.skillsFolder", JSON.stringify("/skills"));
    const newSkill: LocalSkillFile = {
      path: "/skills/new/SKILL.md", relativePath: "new/SKILL.md", fileName: "SKILL.md",
      defaultName: "new", description: "New skill", supportingMarkdownCount: 0,
    };
    let files = [selectedReviewSkill];
    localSkillsScanImpl = () => files;
    const user = userEvent.setup();
    await renderApp();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("local_skills_sync", expect.anything()));
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    files = [selectedReviewSkill, newSkill];
    await user.type(await screen.findByPlaceholderText(/Ask Mythra Code to work in/), "@new Inspect this project{Enter}");
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("local_skills_resolve_prompts", expect.objectContaining({
      skills: expect.arrayContaining([expect.objectContaining({ sourcePath: newSkill.path, name: "new", enabled: true })]),
    })));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({ method: "turn/start" })));
  });

  it("keeps scanned broken skills visible and analyzable when runtime sync rejects them", async () => {
    localStorage.setItem("kiwi.skillsFolder", JSON.stringify("/skills"));
    const testsSkill: LocalSkillFile = {
      path: "/skills/tests/SKILL.md", relativePath: "tests/SKILL.md", fileName: "SKILL.md",
      defaultName: "tests", description: "Test instructions", supportingMarkdownCount: 0,
    };
    const report: SkillDependencyReport = {
      ...emptySkillDependencyReport(),
      roots: [{ nodeId: "review", channel: "user", name: "review" }],
      nodes: [
        { id: "review", kind: "skill", name: "review", path: selectedReviewSkill.path, status: "loaded", depth: 0, characterCount: 30 },
        { id: "tests", kind: "skill", name: "tests", path: testsSkill.path, status: "loaded", depth: 1, characterCount: 30 },
        { id: "checklist", kind: "document", name: "checklist.txt", path: "/skills/tests/checklist.txt", status: "blocked", depth: 2, characterCount: 0 },
      ],
      edges: [{ from: "review", to: "tests", reference: "@tests" }, { from: "tests", to: "checklist", reference: "checklist.txt" }],
      issues: [{ code: "missing-document", rootName: "review", chain: ["@review", "@tests", "checklist.txt"], reference: "checklist.txt", message: "The nested checklist is missing." }],
    };
    localSkillsScanImpl = () => [selectedReviewSkill, testsSkill];
    localSkillsSyncImpl = () => { throw new Error("The nested checklist is missing."); };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "local_skills_analyze_prompts") return report;
      if (command === "local_skills_read") return "# Review\n\nUse @tests.\n";
      return stubInvoke(command, args);
    });
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: /^Skills/ }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(await within(settings).findByRole("button", { name: "Edit review skill" })).toBeInTheDocument();
    expect(within(settings).getByRole("button", { name: "Edit tests skill" })).toBeInTheDocument();
    expect(within(settings).queryByText("No skills in this folder yet")).not.toBeInTheDocument();
    await user.click(within(settings).getByRole("button", { name: "Edit review skill" }));
    const editor = await screen.findByRole("dialog", { name: "Edit @review" });
    expect(await within(editor).findByText("Turn blocked by skill dependencies")).toBeInTheDocument();
    expect(within(editor).getAllByText(/nested checklist is missing/).length).toBeGreaterThan(0);
    await user.click(within(editor).getByRole("button", { name: /Close/ }));
    await user.click(within(settings).getByRole("button", { name: "Close settings" }));
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    await user.type(await screen.findByPlaceholderText(/Ask Mythra Code to work in/), "@review Inspect this project{Enter}");
    expect(await screen.findByText(/could not load the selected skills folder/i)).toBeInTheDocument();
    expect(invokeMock.mock.calls.some(([command, args]) => command === "codex_rpc" && ["thread/start", "turn/start"].includes(String(args?.method)))).toBe(false);
  });

  it("blocks plain sends until a failed provider-root clear is repaired", async () => {
    localStorage.setItem("kiwi.skillsFolder", JSON.stringify("/skills"));
    let fingerprint = "old";
    let syncFails = false;
    let clearFails = false;
    localSkillsScanImpl = () => [{ ...selectedReviewSkill, contentFingerprint: fingerprint }];
    localSkillsSyncImpl = () => {
      if (syncFails) throw new Error("Skill mirror failed");
      return "/runtime/skills";
    };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "codex_rpc" && args?.method === "skills/extraRoots/set"
        && ((args.params ?? {}) as { extraRoots: string[] }).extraRoots.length === 0 && clearFails) {
        throw new Error("Could not clear the old root");
      }
      return stubInvoke(command, args);
    });
    const user = userEvent.setup();
    await renderApp();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({
      method: "skills/extraRoots/set", params: { extraRoots: ["/runtime/skills"] },
    })));
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    const clearCount = () => invokeMock.mock.calls.filter(([command, args]) => command === "codex_rpc"
      && args?.method === "skills/extraRoots/set"
      && ((args.params ?? {}) as { extraRoots: string[] }).extraRoots.length === 0).length;
    const clearsBefore = clearCount();
    fingerprint = "new";
    syncFails = true;
    clearFails = true;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(clearCount()).toBeGreaterThan(clearsBefore));
    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);
    await user.type(composer, "Inspect this project{Enter}");
    expect(await screen.findByText(/could not clear the previous skills runtime/i)).toBeInTheDocument();
    expect(invokeMock.mock.calls.some(([command, args]) => command === "codex_rpc" && ["thread/start", "turn/start"].includes(String(args?.method)))).toBe(false);
    syncFails = false;
    clearFails = false;
    const rootsBefore = invokeMock.mock.calls.filter(([command, args]) => command === "codex_rpc"
      && args?.method === "skills/extraRoots/set"
      && ((args.params ?? {}) as { extraRoots: string[] }).extraRoots[0] === "/runtime/skills").length;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(invokeMock.mock.calls.filter(([command, args]) => command === "codex_rpc"
      && args?.method === "skills/extraRoots/set"
      && ((args.params ?? {}) as { extraRoots: string[] }).extraRoots[0] === "/runtime/skills").length).toBeGreaterThan(rootsBefore));
    await user.type(composer, "{Enter}");
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({ method: "turn/start" })));
  });

  it("sends a message whose only @ words are not skills while the folder cannot be read", async () => {
    localStorage.setItem("kiwi.skillsFolder", JSON.stringify("/skills"));
    localSkillsScanImpl = () => { throw new Error("Folder is locked by another process"); };
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);

    // Mount's own visible refresh already failed; let it settle so the only
    // skills work left to attribute is the send's.
    const scans = () => invokeMock.mock.calls.filter(([command]) => command === "local_skills_scan").length;
    await waitFor(() => expect(scans()).toBeGreaterThan(0));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const scansBeforeSend = scans();

    await user.type(composer, "mail me@example.com about @src/App.tsx today{Enter}");

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({
      method: "turn/start",
      params: expect.objectContaining({
        input: [expect.objectContaining({ text: "mail me@example.com about @src/App.tsx today" })],
      }),
    })));
    // Nothing skill-shaped was mentioned, so the send never re-read the
    // unreadable folder and never tore the library down retrying it.
    expect(scans()).toBe(scansBeforeSend);
    expect(invokeMock).toHaveBeenCalledWith("local_skills_resolve_prompts", expect.objectContaining({
      folder: "",
      message: "mail me@example.com about @src/App.tsx today",
      skills: [],
    }));
    expect(invokeMock).toHaveBeenCalledWith("local_skills_mention_names", { message: "mail me@example.com about @src/App.tsx today" });
  });

  it("keeps an unknown user @word literal while the folder cannot be read", async () => {
    localStorage.setItem("kiwi.skillsFolder", JSON.stringify("/skills"));
    localSkillsScanImpl = () => { throw new Error("Folder is locked by another process"); };
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);

    await user.type(composer, "@review inspect this{Enter}");

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({
      method: "turn/start",
      params: expect.objectContaining({ input: [expect.objectContaining({ text: "@review inspect this" })] }),
    })));
  });

  it("refuses a plain user message when its system prompt invokes an unreadable selected-folder skill", async () => {
    localStorage.setItem("kiwi.skillsFolder", JSON.stringify("/skills"));
    localStorage.setItem("kiwi.settings", JSON.stringify({ ...DEFAULT_SETTINGS, systemPrompt: "Use @review." }));
    localSkillsScanImpl = () => { throw new Error("Selected folder is unreadable"); };
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);
    await user.type(composer, "Inspect this project{Enter}");
    expect(await screen.findByText(/could not load the selected skills folder/)).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("local_skills_mention_names", { message: "Use @review." });
    expect(invokeMock.mock.calls.some(([command, args]) => command === "codex_rpc" && ["thread/start", "turn/start"].includes(String(args?.method)))).toBe(false);
  });

  it.each(["append", "replace"] as const)("resolves the effective global, subscription and project skill prompt in %s mode through one native request", async (mode) => {
    const globalPrompt = "Global instructions use @review.";
    const codexPrompt = "Codex instructions use @review.";
    const projectPrompt = "Alpha project instructions use @review.";
    const combined = mode === "append" ? `${globalPrompt}\n\n${codexPrompt}\n\n${projectPrompt}` : projectPrompt;
    const resolvedSystem = `Selected-folder review instructions\n\n${combined}`;
    localStorage.setItem("kiwi.skillsFolder", JSON.stringify("/skills"));
    localStorage.setItem("kiwi.settings", JSON.stringify({
      ...DEFAULT_SETTINGS, systemPrompt: globalPrompt, codexSystemPrompt: codexPrompt,
      claudeSystemPrompt: "Claude-only @unselected must not participate.",
    }));
    localStorage.setItem("kiwi.projects", JSON.stringify([
      { ...PROJECT_A, overrides: { systemPrompt: projectPrompt, systemPromptMode: mode } }, PROJECT_B,
    ]));
    localSkillsScanImpl = () => [selectedReviewSkill];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "local_skills_resolve_prompts") return { prompt: args?.message, systemPrompt: resolvedSystem };
      return stubInvoke(command, args);
    });
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);
    await user.type(composer, "Inspect this project{Enter}");
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("local_skills_resolve_prompts", expect.objectContaining({
      folder: "/skills", message: "Inspect this project", systemPrompt: combined,
      skills: [expect.objectContaining({ sourcePath: selectedReviewSkill.path, name: "review", enabled: true })],
    })));
    const resolutions = invokeMock.mock.calls.filter(([command]) => command === "local_skills_resolve_prompts");
    expect(resolutions).toHaveLength(1);
    expect(invokeMock.mock.calls.some(([command]) => command === "local_skills_resolve_prompt")).toBe(false);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({
      method: "thread/start", params: expect.objectContaining({ baseInstructions: "" }),
    })));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({
      method: "turn/start", params: expect.objectContaining({ input: [expect.objectContaining({ text: "Inspect this project" })] }),
    })));
    const currentTurn = invokeMock.mock.calls.find(([command, args]) => command === "codex_rpc" && args?.method === "turn/start")![1]?.params as { collaborationMode: { settings: { developer_instructions: string } } };
    expect(currentTurn.collaborationMode.settings.developer_instructions.split(resolvedSystem)).toHaveLength(2);
    expect(currentTurn.collaborationMode.settings.developer_instructions).toContain(`Current effective app system prompt:\n${resolvedSystem}`);
    const { useTaskStore } = await import("./lib/taskStore");
    const displayed = useTaskStore.getState().tasks["isolated-thread"]?.messages.find((message) => message.role === "user")?.text;
    expect(displayed).toBe("Inspect this project");
    expect(JSON.parse(localStorage.getItem("kiwi.settings") ?? "{}").systemPrompt).toBe(globalPrompt);
    expect(JSON.parse(localStorage.getItem("kiwi.projects") ?? "[]")[0].overrides.systemPrompt).toBe(projectPrompt);
  });

  it("retains the full system-only nested graph on a plain user message", async () => {
    const report: SkillDependencyReport = { ...emptySkillDependencyReport(),
      roots: [{ nodeId: "review", channel: "system", name: "review" }],
      nodes: [
        { id: "review", kind: "skill", name: "review", path: "/skills/review/SKILL.md", status: "loaded", depth: 0, characterCount: 30 },
        { id: "security", kind: "skill", name: "security", path: "/skills/security.md", status: "loaded", depth: 1, characterCount: 20 },
        { id: "checklist", kind: "document", name: "checklist.txt", path: "/skills/checklist.txt", status: "loaded", depth: 2, characterCount: 40 },
      ], edges: [{ from: "review", to: "security", reference: "@security" }, { from: "security", to: "checklist", reference: "checklist.txt" }],
    };
    localStorage.setItem("kiwi.skillsFolder", JSON.stringify("/skills"));
    localStorage.setItem("kiwi.settings", JSON.stringify({ ...DEFAULT_SETTINGS, systemPrompt: "Use @review." }));
    localSkillsScanImpl = () => [selectedReviewSkill];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "local_skills_analyze_prompts") return report;
      if (command === "local_skills_resolve_prompts") return { prompt: args?.message, systemPrompt: "Complete nested system context", skillDependencies: report };
      return stubInvoke(command, args);
    });
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    await user.type(await screen.findByPlaceholderText(/Ask Mythra Code to work in/), "Inspect this project{Enter}");
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({ method: "turn/start" })));
    const { useTaskStore } = await import("./lib/taskStore");
    const message = useTaskStore.getState().tasks["isolated-thread"]?.messages.find((entry) => entry.role === "user");
    expect(message?.text).toBe("Inspect this project");
    expect(message?.skillDependencies).toEqual(report);
  });

  it("shows a blocked nested system chain in red and does not start a model", async () => {
    const report: SkillDependencyReport = { ...emptySkillDependencyReport(),
      roots: [{ nodeId: "review", channel: "system", name: "review" }],
      nodes: [
        { id: "review", kind: "skill", name: "review", path: "/skills/review/SKILL.md", status: "loaded", depth: 0, characterCount: 30 },
        { id: "checklist", kind: "document", name: "checklist.txt", path: "/skills/checklist.txt", status: "blocked", depth: 5, characterCount: 0 },
      ], edges: [{ from: "review", to: "checklist", reference: "checklist.txt" }],
      issues: [{ code: "depth-limit", rootName: "review", chain: ["@review", "@security", "checklist.txt"], reference: "checklist.txt", message: "This chain exceeds the limit of 4 dependency hops." }],
    };
    localStorage.setItem("kiwi.skillsFolder", JSON.stringify("/skills"));
    localStorage.setItem("kiwi.settings", JSON.stringify({ ...DEFAULT_SETTINGS, systemPrompt: "Use @review." }));
    localSkillsScanImpl = () => [selectedReviewSkill];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "local_skills_analyze_prompts") return report;
      if (command === "local_skills_resolve_prompts") return { prompt: args?.message, systemPrompt: args?.systemPrompt, skillDependencies: report };
      return stubInvoke(command, args);
    });
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    expect(await screen.findByText("Turn blocked by skill dependencies")).toBeInTheDocument();
    await user.type(await screen.findByPlaceholderText(/Ask Mythra Code to work in/), "Inspect this project{Enter}");
    await waitFor(() => expect(screen.getByText(/Skills were not loaded and the model was not started/)).toBeInTheDocument());
    expect(invokeMock.mock.calls.some(([command, args]) => command === "codex_rpc" && ["thread/start", "turn/start"].includes(String(args?.method)))).toBe(false);
    expect(screen.getByPlaceholderText(/Ask Mythra Code to work in/)).toHaveValue("Inspect this project");
    expect(screen.queryByRole("button", { name: "Check settings" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Edit global prompt" }));
    const editor = await screen.findByRole("textbox", { name: "Global Mythra Code prompt" });
    expect(editor).toHaveFocus();
    expect(editor).toHaveValue("Use @review.");
  });

  it("routes a blocked Codex subscription reference to its own prompt field", async () => {
    const report = skillDependencyFixture(true);
    localStorage.setItem("kiwi.skillsFolder", JSON.stringify("/skills"));
    localStorage.setItem("kiwi.settings", JSON.stringify({ ...DEFAULT_SETTINGS, codexSystemPrompt: "Use @review for Codex." }));
    localSkillsScanImpl = () => [selectedReviewSkill];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "local_skills_analyze_prompts") return report;
      if (command === "local_skills_resolve_prompts") return { prompt: args?.message, systemPrompt: args?.systemPrompt, skillDependencies: report };
      return stubInvoke(command, args);
    });
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    await user.type(await screen.findByPlaceholderText(/Ask Mythra Code to work in/), "Inspect this project{Enter}");
    await user.click(await screen.findByRole("button", { name: "Edit Codex prompt" }));
    const editor = await screen.findByRole("textbox", { name: "Codex subscription prompt" });
    expect(editor).toHaveFocus();
    expect(editor).toHaveValue("Use @review for Codex.");
    expect(screen.queryByRole("button", { name: "Edit global prompt" })).toBeNull();
    await user.clear(editor);
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(screen.queryByText(/Skills were not loaded and the model was not started/)).toBeNull();
  });

  it("opens the affected project editor instead of a suppressed app prompt", async () => {
    const report = skillDependencyFixture(true);
    localStorage.setItem("kiwi.skillsFolder", JSON.stringify("/skills"));
    localStorage.setItem("kiwi.settings", JSON.stringify({ ...DEFAULT_SETTINGS, systemPrompt: "Also use @review globally." }));
    localStorage.setItem("kiwi.projects", JSON.stringify([
      { ...PROJECT_A, overrides: { systemPrompt: "Use @review for Alpha.", systemPromptMode: "replace" } }, PROJECT_B,
    ]));
    localSkillsScanImpl = () => [selectedReviewSkill];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "local_skills_analyze_prompts") return report;
      if (command === "local_skills_resolve_prompts") return { prompt: args?.message, systemPrompt: args?.systemPrompt, skillDependencies: report };
      return stubInvoke(command, args);
    });
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    await user.type(await screen.findByPlaceholderText(/Ask Mythra Code to work in/), "Inspect this project{Enter}");
    expect(screen.queryByRole("button", { name: "Edit global prompt" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Edit project prompt" }));
    expect(await screen.findByRole("dialog", { name: "Project instructions for Alpha" })).toBeVisible();
    const editor = screen.getByRole("textbox", { name: "Prompt for Alpha" });
    expect(editor).toHaveFocus();
    expect(editor).toHaveValue("Use @review for Alpha.");
    await user.clear(editor);
    await user.type(editor, "Alpha instructions without a skill.");
    await user.click(screen.getByRole("button", { name: "Save project prompt" }));
    expect(screen.queryByText(/Skills were not loaded and the model was not started/)).toBeNull();
  });

  it("opens an exact history skill link directly in its Settings source editor", async () => {
    localStorage.setItem("kiwi.skillsFolder", JSON.stringify("/skills"));
    localSkillsScanImpl = () => [selectedReviewSkill];
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    threadTurnsListImpl = () => ({
      data: [{ id: "review-history-turn", status: "completed", items: [{
        id: "review-history-message", type: "userMessage", content: [{ type: "text", text: "Use @review to inspect this." }],
      }] }], nextCursor: null, backwardsCursor: null,
    });
    const markdown = "# Selected local review\n\nThis is the user's exact selected file.\n";
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "local_skills_read") return markdown;
      return stubInvoke(command, args);
    });
    const user = userEvent.setup();
    await renderApp();
    await user.click(await screen.findByText("Alpha thread"));
    const link = await screen.findByRole("link", { name: "@review" });
    const previousHash = window.location.hash;
    await user.click(link);
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(settings).getByRole("heading", { name: "Skills" })).toBeInTheDocument();
    const editor = await screen.findByRole("dialog", { name: "Edit @review" });
    expect(await within(editor).findByRole("textbox", { name: "Markdown for review" })).toHaveValue(markdown);
    expect(invokeMock).toHaveBeenCalledWith("local_skills_read", { folder: "/skills", path: selectedReviewSkill.path });
    expect(invokeMock.mock.calls.filter(([command]) => command === "local_skills_read")).toHaveLength(1);
    expect(window.location.hash).toBe(previousHash);
  });

  it("passes the live paired skill resolver from App into a delegated child turn", async () => {
    localStorage.setItem("kiwi.skillsFolder", JSON.stringify("/skills"));
    localSkillsScanImpl = () => [selectedReviewSkill];
    localStorage.setItem("kiwi.threadProjects", JSON.stringify({ [THREAD_A.id]: PROJECT_A.path }));
    localStorage.setItem("kiwi.childAgentPolicies", JSON.stringify({
      "session-skills": {
        sessionId: "session-skills", rootThreadId: THREAD_A.id, maxConcurrent: 1,
        permission: "read-only", systemPrompt: "Captured system use @review.",
        providerSystemPrompts: { openai: "Captured Codex system use @review." },
        projectInstructionsEnabled: false, reasoningEffort: "medium", serviceTier: null, capturedAt: 1,
        targets: [{ id: "reviewer", provider: "openai", model: "gpt-5.6-sol", label: "Reviewer", description: "", enabled: true, reasoningMode: "inherit", reasoningEffort: "medium", reasoningMaxEffort: "high" }],
      },
    }));
    const resolvedSystem = "Selected review instructions for child system";
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "local_skills_resolve_prompts") return { prompt: "Resolved child user instructions", systemPrompt: resolvedSystem };
      return stubInvoke(command, args);
    });
    await renderApp();
    await waitFor(() => expect(tauriEvents.handlers.has("child-agent-request")).toBe(true));
    await act(async () => tauriEvents.handlers.get("child-agent-request")?.({ payload: {
      requestId: "child-skills-1", sessionId: "session-skills", tool: "spawn_mythra_agent",
      arguments: { target: "reviewer", prompt: "Use @review to inspect this child task." },
    } }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("local_skills_resolve_prompts", expect.objectContaining({
      folder: "/skills", message: "Use @review to inspect this child task.",
      systemPrompt: "Captured Codex system use @review.",
    })));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({
      method: "thread/start", params: expect.objectContaining({ baseInstructions: "" }),
    })));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({
      method: "turn/start", params: expect.objectContaining({ input: [expect.objectContaining({ text: "Resolved child user instructions" })] }),
    })));
    const currentTurn = invokeMock.mock.calls.find(([command, args]) => command === "codex_rpc" && args?.method === "turn/start")![1]?.params as { collaborationMode: { settings: { developer_instructions: string } } };
    expect(currentTurn.collaborationMode.settings.developer_instructions.split(resolvedSystem)).toHaveLength(2);
    expect(currentTurn.collaborationMode.settings.developer_instructions).toContain(`Current effective app system prompt:\n${resolvedSystem}`);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("child_agent_respond", expect.objectContaining({ requestId: "child-skills-1" })));
  });
});

describe("model catalog request ordering", () => {
  const catalogModel = (id: string) => ({ id, model: id, displayName: id, description: "Account model", supportedReasoningEfforts: [], defaultReasoningEffort: "high", isDefault: false });

  it("keeps Cursor refresh failures inside the picker and clears them on retry", async () => {
    localStorage.setItem("kiwi.settings", JSON.stringify({ provider: "cursor", model: "auto" }));
    cursorModelsImpl = () => [{ id: "auto", name: "Auto", configOptions: [] }];
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: /^Cursor model:/ }));
    const refresh = screen.getByRole("button", { name: "Refresh Cursor model catalog" });
    await waitFor(() => expect(refresh).toBeEnabled());
    cursorModelsImpl = () => { throw new Error("Cursor catalog offline"); };
    await user.click(refresh);
    expect(await screen.findByRole("status")).toHaveTextContent("Cursor catalog offline");
    expect(screen.getAllByText(/Cursor catalog offline/)).toHaveLength(1);
    cursorModelsImpl = () => [{ id: "auto", name: "Auto", configOptions: [] }];
    await user.click(refresh);
    expect(screen.queryByText(/Cursor catalog offline/)).not.toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /^Auto,/ })).toBeInTheDocument();
  });

  it("ignores an older OpenAI refresh that completes after a newer account refresh", async () => {
    modelListImpl = () => ({ data: [catalogModel("gpt-5.6-sol")] });
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: /^OpenAI model:/ }));
    const refresh = screen.getByRole("button", { name: "Refresh OpenAI model catalog" });
    await waitFor(() => expect(refresh).toBeEnabled());
    const oldRequest = deferred<{ data: unknown[] }>();
    const newRequest = deferred<{ data: unknown[] }>();
    let calls = 0;
    modelListImpl = () => ++calls === 1 ? oldRequest.promise : newRequest.promise;
    await user.click(refresh);
    await act(async () => { tauriEvents.handlers.get("codex-event")?.({ payload: { method: "account/updated", params: {} } }); });
    await waitFor(() => expect(calls).toBe(2));
    await act(async () => { newRequest.resolve({ data: [catalogModel("newest-model")] }); });
    expect(await screen.findByRole("menuitemradio", { name: /^newest-model:/ })).toBeInTheDocument();
    expect(refresh).toBeEnabled();
    await act(async () => { oldRequest.resolve({ data: [] }); });
    expect(screen.getByRole("menuitemradio", { name: /^newest-model:/ })).toBeInTheDocument();
    expect(screen.queryByText(/empty model catalog/)).not.toBeInTheDocument();
    expect(refresh).toBeEnabled();
  });

  it("refreshes OpenAI pages from the picker without replacing the chosen model or restarting the runtime", async () => {
    const user = userEvent.setup();
    modelListImpl = () => ({ data: [catalogModel("gpt-5.6-sol")] });
    await renderApp();
    await user.click(screen.getByRole("button", { name: /^OpenAI model:/ }));
    const refresh = screen.getByRole("button", { name: "Refresh OpenAI model catalog" });
    await waitFor(() => expect(refresh).toBeEnabled());
    const nextPage = deferred<{ data: unknown[] }>();
    modelListImpl = (params) => params.cursor === "page-2" ? nextPage.promise : { data: [catalogModel("new-model")], nextCursor: "page-2" };
    const requestsBefore = invokeMock.mock.calls.length;
    await user.click(refresh);
    expect(refresh).toBeDisabled();
    expect(screen.queryByRole("menuitemradio", { name: /^new-model:/ })).not.toBeInTheDocument();
    await act(async () => { nextPage.resolve({ data: [catalogModel("new-model-two")] }); });
    expect(await screen.findByRole("menuitemradio", { name: /^new-model-two:/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /^new-model:/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^OpenAI model: gpt-5.6-sol/ })).toHaveAttribute("aria-expanded", "true");
    expect(refresh).toBeEnabled();
    expect(refresh).toHaveFocus();
    const calls = invokeMock.mock.calls.slice(requestsBefore);
    expect(calls.filter(([, args]) => args?.method === "model/list").map(([, args]) => args?.params.cursor)).toEqual([null, "page-2"]);
    expect(calls.some(([command, args]) => command === "restart_runtime" || ["turn/start", "thread/start", "account/read"].includes(args?.method))).toBe(false);
  });

  it("restarts an idle stale runtime before refreshing the OpenAI catalog", async () => {
    localStorage.setItem("kiwi.settings", JSON.stringify({ provider: "openai", model: "gpt-5.6-sol" }));
    refreshedCodexRuntimeStatusImpl = () => ({
      available: true,
      source: "Codex CLI",
      path: "/usr/local/bin/codex",
      runningPath: "/usr/local/bin/codex",
      dataHome: "/profiles/localdev/codex-home",
      version: "100.0.0",
      runningVersion: "99.0.0",
      runningCommands: 0,
      runtimeChanged: true,
      compatible: true,
      warning: null,
    });
    const initialRuntimeGeneration = runtimeGeneration;
    modelListImpl = () => ({ data: runtimeGeneration === initialRuntimeGeneration
      ? [catalogModel("gpt-5.6-sol")]
      : [catalogModel("gpt-6-sol"), catalogModel("gpt-6-luna")] });
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: /^OpenAI model:/ }));
    expect(await screen.findByRole("menuitemradio", { name: /^gpt-5.6-sol:/ })).toBeInTheDocument();
    const refresh = screen.getByRole("button", { name: "Refresh OpenAI model catalog" });

    await user.click(refresh);

    expect(await screen.findByRole("menuitemradio", { name: /^gpt-6-sol:/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /^gpt-6-luna:/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^OpenAI model: gpt-5.6-sol/ })).toHaveAttribute("aria-expanded", "true");
    expect(invokeMock.mock.calls.filter(([command]) => command === "restart_runtime_reserved")).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([command]) => command === "release_runtime_restart")).toHaveLength(1);
    expect(invokeMock.mock.calls.some(([command, args]) => command === "codex_rpc" && ["turn/start", "thread/start"].includes(args?.method))).toBe(false);
  });

  it("preserves the current catalog and avoids restart when the installed runtime cannot be resolved", async () => {
    refreshedCodexRuntimeStatusImpl = () => ({
      available: false,
      source: "Codex CLI",
      path: null,
      runningPath: "/usr/local/bin/codex",
      dataHome: "/profiles/localdev/codex-home",
      version: null,
      runningVersion: "99.0.0",
      runningCommands: 0,
      runtimeChanged: false,
      compatible: false,
      warning: "The installed Codex runtime could not be resolved.",
    });
    modelListImpl = () => ({ data: [catalogModel("gpt-5.6-sol")] });
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: /^OpenAI model:/ }));
    const refresh = screen.getByRole("button", { name: "Refresh OpenAI model catalog" });
    const requestsBeforeRefresh = invokeMock.mock.calls.length;

    await user.click(refresh);

    expect(await screen.findByRole("status")).toHaveTextContent(/installed Codex runtime could not be resolved/i);
    expect(screen.getByRole("menuitemradio", { name: /^gpt-5.6-sol:/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^OpenAI model: gpt-5.6-sol/ })).toHaveAttribute("aria-expanded", "true");
    expect(invokeMock.mock.calls.filter(([command]) => ["restart_runtime", "restart_runtime_reserved"].includes(command))).toHaveLength(0);
    expect(invokeMock.mock.calls.slice(requestsBeforeRefresh).some(([command, args]) => command === "codex_rpc" && args?.method === "model/list")).toBe(false);
  });

  it.each(["active runtime task", "pending runtime approval", "active terminal command"])("preserves the current catalog and avoids restart when a %s exists", async (blocker) => {
    refreshedCodexRuntimeStatusImpl = () => ({
      available: true,
      source: "Codex CLI",
      path: "/usr/local/bin/codex",
      runningPath: "/usr/local/bin/codex",
      dataHome: "/profiles/localdev/codex-home",
      version: "100.0.0",
      runningVersion: "99.0.0",
      runningCommands: blocker === "active terminal command" ? 1 : 0,
      runtimeChanged: true,
      compatible: true,
      warning: null,
    });
    modelListImpl = () => ({ data: [catalogModel("gpt-5.6-sol")] });
    const user = userEvent.setup();
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");
    act(() => {
      const store = useTaskStore.getState();
      store.ensureTask("busy-runtime-thread");
      if (blocker === "active runtime task") store.setTaskStatus("busy-runtime-thread", "running");
      else if (blocker === "pending runtime approval") store.enqueueApproval({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: {},
        threadId: "busy-runtime-thread",
        receivedAt: Date.now(),
      });
    });
    await user.click(screen.getByRole("button", { name: /^OpenAI model:/ }));
    const refresh = screen.getByRole("button", { name: "Refresh OpenAI model catalog" });
    await user.click(refresh);

    expect(await screen.findByRole("status")).toHaveTextContent(/Finish active work and respond to pending approvals/);
    expect(screen.getByRole("menuitemradio", { name: /^gpt-5.6-sol:/ })).toBeInTheDocument();
    expect(invokeMock.mock.calls.filter(([command]) => ["restart_runtime", "restart_runtime_reserved"].includes(command))).toHaveLength(0);
    expect(invokeMock.mock.calls.filter(([command]) => command === "release_runtime_restart")).toHaveLength(1);
    if (blocker === "pending runtime approval") {
      expect(useTaskStore.getState().tasks["busy-runtime-thread"]?.approvals).toHaveLength(1);
    }
  });

  it.each(["failed page", "empty catalog", "endless pages"])("keeps the last complete OpenAI catalog on %s and offers a working retry", async (failure) => {
    const user = userEvent.setup();
    modelListImpl = () => ({ data: [catalogModel("gpt-5.6-sol")] });
    await renderApp();
    await user.click(screen.getByRole("button", { name: /^OpenAI model:/ }));
    const refresh = screen.getByRole("button", { name: "Refresh OpenAI model catalog" });
    await waitFor(() => expect(refresh).toBeEnabled());
    modelListImpl = (params) => {
      if (failure === "empty catalog") return { data: [] };
      if (params.cursor && failure === "failed page") throw new Error("Network unavailable");
      return { data: [catalogModel("partial-model")], nextCursor: "more" };
    };
    await user.click(refresh);
    expect(await screen.findByRole("status")).toHaveTextContent("Showing the last loaded catalog");
    expect(screen.getByRole("menuitemradio", { name: /^gpt-5.6-sol:/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio", { name: /^partial-model:/ })).not.toBeInTheDocument();
    expect(refresh).toBeEnabled();
    modelListImpl = () => ({ data: [catalogModel("recovered-model")] });
    await user.click(refresh);
    expect(await screen.findByRole("menuitemradio", { name: /^recovered-model:/ })).toBeInTheDocument();
    expect(screen.queryByText(/Showing the last loaded catalog/)).not.toBeInTheDocument();
  });
  it("does not let a slow LM Studio startup probe overwrite a newer manual refresh", { timeout: 15_000 }, async () => {
    const startup = deferred<{ models: unknown[] }>();
    const manual = deferred<{ models: unknown[] }>();
    let requests = 0;
    const urls: string[] = [];
    lmStudioModelsImpl = (baseUrl) => {
      urls.push(baseUrl);
      return requests++ === 0 ? startup.promise : manual.promise;
    };

    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: /Models & accounts/ }));
    await user.click(screen.getByRole("button", { name: /LM Studio.*Local models/ }));
    fireEvent.change(screen.getByPlaceholderText("http://127.0.0.1:1234/v1"), { target: { value: "http://10.0.0.2:1234/v1" } });
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(urls).toEqual(["http://127.0.0.1:1234/v1", "http://10.0.0.2:1234/v1"]);

    await act(async () => {
      manual.resolve({ models: [{
        type: "llm",
        key: "new/model",
        display_name: "New model",
        capabilities: { trained_for_tool_use: true },
      }] });
      await manual.promise;
    });
    expect(await screen.findByText("1 model available")).toBeInTheDocument();

    await act(async () => {
      startup.resolve({ models: [
        { type: "llm", key: "old/one", display_name: "Old one" },
        { type: "llm", key: "old/two", display_name: "Old two" },
      ] });
      await startup.promise;
    });
    expect(screen.getByText("1 model available")).toBeInTheDocument();
    expect(screen.queryByText("2 models available")).not.toBeInTheDocument();
  });
});

describe("workspace switching during thread selection", () => {
  beforeEach(() => {
    // These flows select Claude; signed-out selection is covered separately.
    claudeRuntimeStatusImpl = () => ({ available: true, path: "/usr/bin/claude", version: "99.0.0", loggedIn: true, authMethod: "subscription", email: null, subscriptionType: "pro", warning: null });
  });

  it("does not offer a runtime thread remembered from another isolated Codex home", async () => {
    const foreign: Thread = {
      ...THREAD_A,
      id: "foreign-thread",
      name: "Foreign runtime thread",
      path: "/profiles/production/codex-home/sessions/foreign-thread.jsonl",
    };
    localStorage.setItem("kiwi.knownThreads", JSON.stringify({ [foreign.id]: foreign }));
    localStorage.setItem("kiwi.threadProjects", JSON.stringify({ [foreign.id]: PROJECT_A.path }));

    await renderApp();

    expect(await screen.findByText("Alpha thread")).toBeInTheDocument();
    expect(screen.queryByText("Foreign runtime thread")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("kiwi.knownThreads") ?? "{}")).toHaveProperty(foreign.id);
  });

  it("shows Windows shortcut labels for new threads and search", async () => {
    const user = userEvent.setup();
    await renderApp();

    expect(screen.getByText("Ctrl+N").closest("button")).toHaveClass("new-thread-button");
    const searchButton = screen.getByRole("button", { name: "Open command palette" });
    expect(searchButton).toHaveTextContent("Ctrl+K");
    expect(searchButton.querySelector(".lucide-command")).toBeNull();
    expect(searchButton.querySelector(".lucide-search")).not.toBeNull();
    expect(screen.queryByText(/⌘/)).not.toBeInTheDocument();
    await user.click(searchButton);
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
  });

  it("keeps a persisted native Codex child in the Sub-agents inbox and depth-limits it", async () => {
    const user = userEvent.setup();
    const nativeChild: Thread = {
      id: "native-child",
      name: "Native child",
      preview: "Review the implementation",
      cwd: PROJECT_A.path,
      updatedAt: THREAD_B.updatedAt + 1,
      modelProvider: "openai",
      parentThreadId: THREAD_A.id,
      threadSource: "subagent",
    };
    localStorage.setItem("kiwi.knownThreads", JSON.stringify({ [nativeChild.id]: nativeChild }));
    localStorage.setItem("kiwi.threadProjects", JSON.stringify({ [nativeChild.id]: PROJECT_A.path }));
    localStorage.setItem("kiwi.nativeAgentLinks", JSON.stringify({
      [nativeChild.id]: {
        childThreadId: nativeChild.id,
        rootThreadId: THREAD_A.id,
        title: nativeChild.preview,
        createdAt: nativeChild.updatedAt * 1000,
      },
    }));
    resumeImpl = (params) => ({ thread: { ...nativeChild, id: String(params.threadId), turns: [] } });

    await renderApp();
    expect(screen.queryByText("Native child")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Sub-agents \d+$/ }));
    await user.click(await screen.findByText("Native child"));

    await waitFor(() => {
      const resumeCalls = invokeMock.mock.calls
        .filter(([command, args]) => command === "codex_rpc" && args?.method === "thread/resume")
        .map(([, args]) => args?.params as Record<string, unknown>);
      expect(resumeCalls.at(-1)).toMatchObject({
        threadId: nativeChild.id,
        config: { features: { multi_agent: false } },
      });
    });
    expect(invokeMock.mock.calls.some(([command]) => command === "child_agent_session_start")).toBe(false);
  });

  it("keeps the root conversation in the main inbox when storage claims it is its own child's child", async () => {
    // A reversed ownership record plus the matching thread metadata is exactly
    // the durable state that used to move the user's main conversation into the
    // Sub-agents inbox and keep it there across reloads.
    const user = userEvent.setup();
    const poisonedRoot: Thread = {
      ...THREAD_A,
      parentThreadId: "native-child",
      threadSource: "subagent",
    };
    const nativeChild: Thread = {
      id: "native-child",
      name: "Native child",
      preview: "Review the implementation",
      cwd: PROJECT_A.path,
      updatedAt: THREAD_B.updatedAt + 1,
      modelProvider: "openai",
      parentThreadId: THREAD_A.id,
      threadSource: "subagent",
    };
    localStorage.setItem("kiwi.knownThreads", JSON.stringify({
      [poisonedRoot.id]: poisonedRoot,
      [nativeChild.id]: nativeChild,
    }));
    localStorage.setItem("kiwi.threadProjects", JSON.stringify({
      [poisonedRoot.id]: PROJECT_A.path,
      [nativeChild.id]: PROJECT_A.path,
    }));
    localStorage.setItem("kiwi.nativeAgentLinks", JSON.stringify({
      [nativeChild.id]: {
        childThreadId: nativeChild.id,
        rootThreadId: THREAD_A.id,
        title: nativeChild.preview,
        createdAt: nativeChild.updatedAt * 1000,
      },
      [poisonedRoot.id]: {
        childThreadId: poisonedRoot.id,
        rootThreadId: nativeChild.id,
        title: "Reversed",
        createdAt: nativeChild.updatedAt * 1000,
      },
    }));

    await renderApp();
    // The root owns a child, so it is a root however its own record reads.
    expect(await screen.findByText("Alpha thread")).toBeInTheDocument();
    expect(screen.queryByText("Native child")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Sub-agents \d+$/ }));
    expect(await screen.findByText("Native child")).toBeInTheDocument();
    expect(screen.queryByText("Alpha thread")).not.toBeInTheDocument();

    await waitFor(() => {
      const remembered = JSON.parse(localStorage.getItem("kiwi.knownThreads") ?? "{}") as Record<string, Thread>;
      expect(remembered[THREAD_A.id]).not.toHaveProperty("parentThreadId");
      expect(remembered[THREAD_A.id]).not.toHaveProperty("threadSource");
    });
  });

  it("drops a stale native child claim when thread/list identifies that thread as a root", async () => {
    localStorage.setItem("kiwi.knownThreads", JSON.stringify({
      [THREAD_A.id]: { ...THREAD_A, parentThreadId: "missing-child", threadSource: "subagent" },
    }));
    localStorage.setItem("kiwi.nativeAgentLinks", JSON.stringify({
      [THREAD_A.id]: {
        childThreadId: THREAD_A.id,
        rootThreadId: "missing-child",
        title: "Stale reversed claim",
        createdAt: 1,
      },
    }));

    await renderApp();
    expect(await screen.findByText("Alpha thread")).toBeInTheDocument();
    await waitFor(() => {
      const links = JSON.parse(localStorage.getItem("kiwi.nativeAgentLinks") ?? "{}") as Record<string, unknown>;
      expect(links).not.toHaveProperty(THREAD_A.id);
    });
  });

  it("initializes a plain project before offering an isolated worktree", async () => {
    workspaceGitInfoImpl = () => ({
      isRepo: false,
      isRoot: false,
      hasCommit: false,
      branch: null,
      head: null,
      error: null,
    });
    const user = userEvent.setup();
    await renderApp();

    await user.click(await screen.findByRole("button", { name: /Initialize Git repository/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("workspace_git_initialize", {
        cwd: PROJECT_A.path,
      });
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Git repository created for Alpha. Isolated worktrees are ready.",
    );
    const isolatedChoice = await screen.findByRole("button", { name: /Isolated worktree/i });
    expect(isolatedChoice).toBeEnabled();
  });

  it("reorders projects by dragging and persists the exact order", async () => {
    const user = userEvent.setup();
    await renderApp();
    const alphaRow = screen.getByRole("button", { name: PROJECT_A.name }).closest(".workspace-row-wrap");
    const betaRow = screen.getByRole("button", { name: PROJECT_B.name }).closest(".workspace-row-wrap");
    const workspaceList = alphaRow?.closest(".workspace-list");
    expect(alphaRow).not.toBeNull();
    expect(betaRow).not.toBeNull();
    expect(workspaceList).not.toBeNull();
    vi.spyOn(workspaceList!, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 200,
      height: 200,
    } as DOMRect);
    vi.spyOn(betaRow!, "getBoundingClientRect").mockReturnValue({
      top: 0,
      height: 34,
    } as DOMRect);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => betaRow),
    });

    await user.pointer([
      { keys: "[MouseLeft>]", target: alphaRow!, coords: { clientX: 10, clientY: 10 } },
      { target: betaRow!, coords: { clientX: 10, clientY: 30 } },
    ]);
    expect(alphaRow).toHaveClass("dragging");
    await user.pointer({ keys: "[/MouseLeft]", target: betaRow!, coords: { clientX: 10, clientY: 30 } });

    const renderedOrder = [...document.querySelectorAll(".workspace-row-wrap .workspace-name")]
      .map((node) => node.textContent);
    expect(renderedOrder).toEqual([PROJECT_B.name, PROJECT_A.name]);
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("kiwi.projects") ?? "[]") as Array<{ id: string }>;
      expect(stored.map((project) => project.id)).toEqual([PROJECT_B.id, PROJECT_A.id]);
    });
  });

  it("refuses to drag an unpinned project above a pinned one", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.projects", JSON.stringify([{ ...PROJECT_A, pinned: true }, PROJECT_B]));
    await renderApp();
    const alphaRow = screen.getByRole("button", { name: PROJECT_A.name }).closest(".workspace-row-wrap");
    const betaRow = screen.getByRole("button", { name: PROJECT_B.name }).closest(".workspace-row-wrap");
    const workspaceList = betaRow?.closest(".workspace-list");
    vi.spyOn(workspaceList!, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 200, height: 200 } as DOMRect);
    vi.spyOn(alphaRow!, "getBoundingClientRect").mockReturnValue({ top: 0, height: 34 } as DOMRect);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => alphaRow) });

    await user.pointer([
      { keys: "[MouseLeft>]", target: betaRow!, coords: { clientX: 10, clientY: 40 } },
      { target: alphaRow!, coords: { clientX: 10, clientY: 4 } },
    ]);
    expect(betaRow).toHaveClass("dragging");
    // The pinned row is not a legal target, so nothing is marked as a drop.
    expect(document.querySelector(".workspace-row-wrap.drop-before")).toBeNull();
    expect(document.querySelector(".workspace-row-wrap.drop-after")).toBeNull();
    await user.pointer({ keys: "[/MouseLeft]", target: alphaRow!, coords: { clientX: 10, clientY: 4 } });

    expect([...document.querySelectorAll(".workspace-row-wrap .workspace-name")].map((node) => node.textContent))
      .toEqual([PROJECT_A.name, PROJECT_B.name]);
  });

  it("keeps a newly pinned project above the unpinned ones, wherever it was dragged", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.projects", JSON.stringify([PROJECT_A, PROJECT_B]));
    await renderApp();
    expect([...document.querySelectorAll(".workspace-row-wrap .workspace-name")].map((node) => node.textContent))
      .toEqual([PROJECT_A.name, PROJECT_B.name]);

    await user.click(screen.getByRole("button", { name: `Options for ${PROJECT_B.name}` }));
    await user.click(await screen.findByRole("menuitem", { name: "Pin project" }));

    expect([...document.querySelectorAll(".workspace-row-wrap .workspace-name")].map((node) => node.textContent))
      .toEqual([PROJECT_B.name, PROJECT_A.name]);
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("kiwi.projects") ?? "[]") as Array<{ id: string; pinned?: boolean }>;
      expect(stored.map((project) => [project.id, Boolean(project.pinned)]))
        .toEqual([[PROJECT_B.id, true], [PROJECT_A.id, false]]);
    });
  });

  it("collapses the pinned group and remembers it across reopens", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.projects", JSON.stringify([{ ...PROJECT_A, pinned: true }, PROJECT_B]));
    const view = await renderApp();

    const toggle = screen.getByRole("button", { name: /Pinned/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: PROJECT_A.name })).toBeInTheDocument();

    await user.click(toggle);
    expect(screen.queryByRole("button", { name: PROJECT_A.name })).toBeNull();
    // The unpinned list keeps the sidebar to itself, and the count is the only
    // trace of what was hidden.
    expect(screen.getByRole("button", { name: PROJECT_B.name })).toBeInTheDocument();
    expect(toggle).toHaveTextContent("1");
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    view.unmount();
    await renderApp();
    expect(screen.queryByRole("button", { name: PROJECT_A.name })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Pinned/ }));
    expect(screen.getByRole("button", { name: PROJECT_A.name })).toBeInTheDocument();
  });

  it("tracks the pointer live while dragging the sidebar edge", async () => {
    await renderApp();
    const shell = document.querySelector(".app-shell") as HTMLElement;
    const sidebar = document.querySelector("aside.sidebar") as HTMLElement;
    const separator = screen.getByRole("separator", { name: "Resize sidebar" });

    expect(sidebar.style.getPropertyValue("--sidebar-width")).toBe("260px");
    // The pane must not be sized by an inline React style, or a render landing
    // mid-drag would snap it back to the last committed width.
    expect(sidebar.style.width).toBe("");
    expect(sidebar.style.flexBasis).toBe("");
    // Nor by a property on the shell, which every pointer move would restyle
    // the whole app through.
    expect(shell.style.getPropertyValue("--sidebar-width")).toBe("");

    fireEvent.pointerDown(separator, { clientX: 260, button: 0 });
    fireEvent.pointerMove(window, { clientX: 300 });
    // The edge has already moved, before anything reached React or storage.
    expect(sidebar.style.getPropertyValue("--sidebar-width")).toBe("300px");
    expect(document.body).toHaveAttribute("data-pane-resizing", "sidebar");
    expect(localStorage.getItem("kiwi.paneSizes")).toBeNull();

    fireEvent.pointerUp(window);
    expect(separator).toHaveAttribute("aria-valuenow", "300");
    expect(document.body).not.toHaveAttribute("data-pane-resizing");
    expect(JSON.parse(localStorage.getItem("kiwi.paneSizes") ?? "{}").sidebar).toBe(300);
  });

  it("resizes the sidebar from the keyboard", async () => {
    await renderApp();
    const sidebar = document.querySelector("aside.sidebar") as HTMLElement;
    const separator = screen.getByRole("separator", { name: "Resize sidebar" });

    separator.focus();
    fireEvent.keyDown(separator, { key: "ArrowRight" });

    expect(sidebar.style.getPropertyValue("--sidebar-width")).toBe("276px");
    expect(separator).toHaveAttribute("aria-valuenow", "276");
    expect(JSON.parse(localStorage.getItem("kiwi.paneSizes") ?? "{}").sidebar).toBe(276);
  });

  it("resizes and persists the Projects/Threads divider", async () => {
    await renderApp();
    const separator = screen.getByRole("separator", { name: "Resize projects and threads" });
    vi.spyOn(separator.parentElement!, "getBoundingClientRect").mockReturnValue({
      top: 100,
      height: 600,
    } as DOMRect);

    const sections = document.querySelector(".sidebar-sections") as HTMLElement;
    expect(sections.style.getPropertyValue("--sidebar-split")).toBe("30%");

    fireEvent.pointerDown(separator, { clientY: 280 });
    fireEvent.pointerMove(window, { clientY: 500 });
    expect(sections.style.getPropertyValue("--sidebar-split")).toBe("66.67%");
    fireEvent.pointerUp(window);

    expect(separator).toHaveAttribute("aria-valuenow", "67");
    expect(sections.style.getPropertyValue("--sidebar-split")).toBe("66.67%");
    expect(JSON.parse(localStorage.getItem("kiwi.sidebarSplitRatio") ?? "0")).toBeCloseTo(2 / 3);
  });

  it("shows only actively working thread counts beside projects", async () => {
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    expect(screen.queryByText("0", { selector: ".workspace-thread-count" })).not.toBeInTheDocument();
    act(() => {
      useTaskStore.getState().ensureTask(THREAD_A.id, PROJECT_A.path);
      useTaskStore.getState().ensureTask(THREAD_B.id, PROJECT_A.path);
      useTaskStore.getState().setTaskStatus(THREAD_A.id, "running");
      useTaskStore.getState().setTaskStatus(THREAD_B.id, "completed");
    });

    expect(await screen.findByRole("button", { name: `${PROJECT_A.name}, 1 thread working` })).toBeInTheDocument();
    expect(screen.queryAllByText("1", { selector: ".workspace-thread-count" })).toHaveLength(1);
  });

  it("shows a successful push immediately, then explains uncommitted entries", async () => {
    const user = userEvent.setup();
    const pendingStatus = deferred<{ exitCode: number; stdout: string; stderr: string }>();
    let pushed = false;
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "github_repo_status" || command === "git_workspace_snapshot") return {
        ...(stubInvoke(command, args) as Record<string, unknown>),
        upstream: "origin/main", ahead: pushed ? 0 : 1, behind: 0,
      };
      return stubInvoke(command, args);
    });
    commandExecImpl = (params) => {
      const command = params.command as string[];
      if (command.join(" ") === "git push") {
        pushed = true;
        return { exitCode: 0, stdout: "", stderr: "Everything up-to-date\n" };
      }
      if (command.join(" ") === "git status --porcelain -uall") return pendingStatus.promise;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await renderApp();

    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Push commits" }));

    expect(await screen.findByText(/Everything up-to-date/)).toBeInTheDocument();
    expect(screen.queryByText(/uncommitted entr/)).not.toBeInTheDocument();

    await act(async () => {
      pendingStatus.resolve({ exitCode: 0, stdout: " M src/App.tsx\n?? src/new.ts\n", stderr: "" });
      await pendingStatus.promise;
    });
    expect(await screen.findByText(/2 uncommitted entries remain local/)).toBeInTheDocument();
  });

  it("stages and commits locally with either the default or an optional custom message", async () => {
    const user = userEvent.setup();
    const commands: string[][] = [];
    commandExecImpl = (params) => {
      const command = params.command as string[];
      commands.push(command);
      if (command[1] === "commit") {
        return { exitCode: 0, stdout: `[main abc1234] ${command.at(-1)}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await renderApp();

    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    const commitButton = await screen.findByRole("button", { name: "Commit all changes locally" });
    await user.click(commitButton);

    await waitFor(() => {
      expect(commands.slice(0, 2)).toEqual([
        ["git", "add", "--all"],
        ["git", "commit", "-m", "Update project files"],
      ]);
    });
    expect(await screen.findByText("Committed successfully")).toBeInTheDocument();
    expect(screen.getByText(/“Update project files” was saved/)).toBeInTheDocument();
    expect(screen.getByText("Changes committed locally")).toBeInTheDocument();

    const message = screen.getByLabelText(/Commit message/i);
    await user.type(message, "Polish the Git panel");
    await user.click(commitButton);
    await waitFor(() => {
      expect(commands.slice(-2)).toEqual([
        ["git", "add", "--all"],
        ["git", "commit", "-m", "Polish the Git panel"],
      ]);
    });
    expect(await screen.findByText(/“Polish the Git panel” was saved/)).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("git_workspace_commit", expect.objectContaining({ cwd: PROJECT_A.path, message: "Polish the Git panel", stagedOnly: false }));
  });

  it("refreshes isolated-worktree availability after the first commit in the Git tab", async () => {
    const user = userEvent.setup();
    let committed = false;
    workspaceGitInfoImpl = () => ({ isRepo: true, isRoot: true, hasCommit: committed, branch: "main", head: committed ? "head" : null });
    commandExecImpl = (params) => {
      const command = params.command as string[];
      if (command[1] === "commit") committed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await renderApp();
    expect(await screen.findByRole("button", { name: /Create initial Git snapshot/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Commit all changes locally" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Isolated worktree/i })).toBeEnabled());
    expect(screen.queryByRole("button", { name: /Create initial Git snapshot/i })).not.toBeInTheDocument();
  });

  it("keeps failed GitHub attachment input and shows its error in the connection form", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "github_repo_status") return { isRepo: true, repository: null, remoteUrl: null, branch: "main", upstream: null, ahead: 0, behind: 0 };
      if (command === "github_attach_remote") throw new Error("An origin remote already exists. It was left unchanged.");
      return stubInvoke(command, args);
    });
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.click(await screen.findByRole("button", { name: /(?:Publish this project to GitHub|Connect a GitHub repository)/ }));
    const url = screen.getByLabelText("Existing repository URL");
    await user.type(url, "https://github.com/owner/alpha");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("alert", { name: "" })).toHaveTextContent("An origin remote already exists");
    expect(url).toHaveValue("https://github.com/owner/alpha");
    expect(screen.getByRole("button", { name: "Attach remote" })).toBeEnabled();
    expect(invokeMock).toHaveBeenCalledWith("github_attach_remote", { cwd: PROJECT_A.path, url: "https://github.com/owner/alpha.git" });
  });

  it("serializes GitHub attachment and ignores its result after changing projects", async () => {
    const user = userEvent.setup();
    const pendingAttach = deferred<{ isRepo: boolean; repository: string; remoteUrl: string; branch: string; upstream: null; ahead: number; behind: number }>();
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "github_repo_status") return { isRepo: true, repository: null, remoteUrl: null, branch: "main", upstream: null, ahead: 0, behind: 0 };
      if (command === "github_attach_remote") return pendingAttach.promise;
      return stubInvoke(command, args);
    });
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.click(await screen.findByRole("button", { name: /(?:Publish this project to GitHub|Connect a GitHub repository)/ }));
    await user.type(screen.getByLabelText("Existing repository URL"), "https://github.com/owner/alpha");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("button", { name: "Attaching…" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "Attach an existing GitHub repository" }));
    expect(invokeMock.mock.calls.filter(([command]) => command === "github_attach_remote")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Commit all changes locally" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: PROJECT_B.name }));
    await act(async () => { pendingAttach.resolve({ isRepo: true, repository: "owner/alpha", remoteUrl: "https://github.com/owner/alpha.git", branch: "main", upstream: null, ahead: 0, behind: 0 }); await pendingAttach.promise; });
    expect(screen.queryByText("owner/alpha")).not.toBeInTheDocument();
    expect(screen.queryByText("GitHub repository attached")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Commit all changes locally" })).toBeEnabled();
  });

  it("uses the visible commit message for Commit & push", async () => {
    const user = userEvent.setup();
    const commands: string[][] = [];
    commandExecImpl = (params) => {
      commands.push(params.command as string[]);
      return { exitCode: 0, stdout: "done", stderr: "" };
    };
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.type(screen.getByLabelText(/Commit message/i), "Keep this exact message");
    await user.click(screen.getByRole("button", { name: /Commit & push/i }));
    await waitFor(() => expect(commands).toContainEqual(["git", "commit", "-m", "Keep this exact message"]));
    expect(commands).not.toContainEqual(["git", "commit", "-m", "Update project files"]);
    expect(invokeMock).toHaveBeenCalledWith("git_workspace_push", {
      cwd: PROJECT_A.path, headOid: "b".repeat(40), branch: "main",
      expectedRemoteUrl: "https://github.com/test-user/alpha.git", expectedRepository: "test-user/alpha",
    });
  });

  it("refreshes a connection completed after navigating away and back to its project", async () => {
    const user = userEvent.setup();
    const pendingAttach = deferred<{ isRepo: boolean; repository: string; remoteUrl: string; branch: string; upstream: null; ahead: number; behind: number }>();
    let connected = false;
    const connectedStatus = { isRepo: true, repository: "owner/alpha", remoteUrl: "https://github.com/owner/alpha.git", branch: "main", upstream: null, ahead: 0, behind: 0 };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "github_repo_status") return connected && args?.cwd === PROJECT_A.path ? connectedStatus : { isRepo: true, repository: null, remoteUrl: null, branch: "main", upstream: null, ahead: 0, behind: 0 };
      if (command === "github_attach_remote") return pendingAttach.promise;
      return stubInvoke(command, args);
    });
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.click(await screen.findByRole("button", { name: /Connect a GitHub repository/ }));
    await user.type(screen.getByLabelText("Existing repository URL"), "https://github.com/owner/alpha");
    await user.keyboard("{Enter}");
    await screen.findByRole("button", { name: "Attaching…" });
    await user.click(screen.getByRole("button", { name: PROJECT_B.name }));
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    expect(screen.getByRole("button", { name: "Commit all changes locally" })).toBeDisabled();
    await act(async () => { connected = true; pendingAttach.resolve(connectedStatus); await pendingAttach.promise; });
    expect(await screen.findByText("owner/alpha")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Commit all changes locally" })).toBeEnabled();
  });

  it("can retry a failed push without committing the saved changes again", async () => {
    const user = userEvent.setup();
    const commands: string[][] = [];
    let committed = false;
    let pushed = false;
    let pushes = 0;
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "github_repo_status") return {
        ...(stubInvoke(command, args) as Record<string, unknown>), ahead: committed && !pushed ? 1 : 0,
      };
      if (command === "git_workspace_snapshot") return {
        ...(stubInvoke(command, args) as Record<string, unknown>),
        headOid: (committed ? "b" : "a").repeat(40), stagedFiles: 0,
        unstagedFiles: committed ? 0 : 1, changedFiles: committed ? 0 : 1,
        upstream: "origin/main", ahead: committed && !pushed ? 1 : 0, behind: 0,
      };
      if (command === "git_project_changes" && committed) return {
        rootPath: String(args?.cwd ?? PROJECT_A.path), rows: [],
        stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0, changedFiles: 0, truncated: false,
      };
      return stubInvoke(command, args);
    });
    commandExecImpl = (params) => {
      const command = params.command as string[];
      commands.push(command);
      if (command[1] === "commit") committed = true;
      if (command[1] === "push") {
        if (++pushes === 1) return { exitCode: 1, stdout: "", stderr: "Network unavailable" };
        pushed = true;
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.type(screen.getByLabelText(/Commit message/), "Keep my local commit");
    await user.click(screen.getByRole("button", { name: /Commit & push/ }));
    expect(await screen.findByText(/Changes committed locally; GitHub push needs attention/)).toBeInTheDocument();
    expect(screen.getByText(/“Keep my local commit” was saved/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Push commits" }));
    await waitFor(() => expect(pushes).toBe(2));
    expect(commands.filter((command) => command[1] === "commit")).toHaveLength(1);
    expect(commands.filter((command) => command[1] === "add")).toHaveLength(1);
  });

  it("settles dirty edits to a local commit, pushes it without another commit, and keeps the next draft", async () => {
    const user = userEvent.setup();
    const commands: string[][] = [];
    let committed = false;
    let pushed = false;
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      const ahead = committed && !pushed ? 1 : 0;
      if (command === "github_repo_status") return { ...(stubInvoke(command, args) as Record<string, unknown>), ahead };
      if (command === "git_workspace_snapshot") return {
        branch: "main", headOid: (committed ? "b" : "a").repeat(40), branches: [],
        stagedFiles: 0, unstagedFiles: committed ? 0 : 1, changedFiles: committed ? 0 : 1, stagedPaths: [],
        rootPath: String(args?.cwd ?? PROJECT_A.path), isRoot: true,
        upstream: "origin/main", ahead, behind: 0,
      };
      if (command === "git_project_changes" && committed) return {
        rootPath: String(args?.cwd ?? PROJECT_A.path), rows: [],
        stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0, changedFiles: 0, truncated: false,
      };
      return stubInvoke(command, args);
    });
    commandExecImpl = (params) => {
      const command = params.command as string[];
      commands.push(command);
      if (command[1] === "commit") committed = true;
      if (command[1] === "push") pushed = true;
      return { exitCode: 0, stdout: "done", stderr: "" };
    };
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    const message = screen.getByLabelText(/Commit message/i);
    await user.type(message, "Save the dirty edits locally");
    await user.click(await screen.findByRole("button", { name: "Commit all changes locally" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Nothing to commit" })).toBeDisabled());
    expect(message).toHaveValue("");
    expect(screen.getByLabelText("1 to push")).toBeInTheDocument();
    expect(invokeMock.mock.calls.filter(([command]) => command === "git_workspace_commit")).toEqual([
      ["git_workspace_commit", {
        cwd: PROJECT_A.path, message: "Save the dirty edits locally", stagedOnly: false,
        expectedHeadOid: "a".repeat(40), expectedBranch: "main",
      }],
    ]);

    await user.type(message, "Keep this for my next edit");
    const push = await screen.findByRole("button", { name: "Push" });
    await waitFor(() => expect(push).toBeEnabled());
    await user.click(push);
    await waitFor(() => expect(screen.getByRole("button", { name: "Nothing to commit and push" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Push commits" })).toBeDisabled();
    expect(screen.getByLabelText("0 to push")).toBeInTheDocument();
    expect(message).toHaveValue("Keep this for my next edit");
    expect(invokeMock.mock.calls.filter(([command]) => command === "git_workspace_push")).toEqual([
      ["git_workspace_push", {
        cwd: PROJECT_A.path, headOid: "b".repeat(40), branch: "main",
        expectedRemoteUrl: "https://github.com/test-user/alpha.git", expectedRepository: "test-user/alpha",
      }],
    ]);
    const synced = screen.getByRole("button", { name: "Nothing to commit and push" });
    await user.click(synced);
    fireEvent.submit(synced.closest("form")!);
    expect(invokeMock.mock.calls.filter(([command]) => command === "git_workspace_commit")).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([command]) => command === "git_workspace_push")).toHaveLength(1);
    expect(commands.filter((command) => command[1] === "commit")).toEqual([["git", "commit", "-m", "Save the dirty edits locally"]]);
    expect(commands.filter((command) => command[1] === "add")).toHaveLength(1);
  });

  it("commits only the existing index when staged files are selected", async () => {
    const user = userEvent.setup();
    const commands: string[][] = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "git_workspace_snapshot") return {
        branch: "main", headOid: "a".repeat(40), branches: [], stagedFiles: 1,
        unstagedFiles: 2, changedFiles: 3, stagedPaths: ["chosen.ts"], rootPath: PROJECT_A.path,
      };
      if (command === "git_project_changes") return {
        rootPath: PROJECT_A.path, truncated: false, stagedFiles: 1, unstagedFiles: 2, untrackedFiles: 0, changedFiles: 3,
        rows: [
          { path: "chosen.ts", originalPath: null, area: "staged", status: "M" },
          { path: "left.ts", originalPath: null, area: "unstaged", status: "M" },
          { path: "other.ts", originalPath: null, area: "unstaged", status: "M" },
        ],
      };
      return stubInvoke(command, args);
    });
    commandExecImpl = (params) => {
      commands.push(params.command as string[]);
      return { exitCode: 0, stdout: "committed", stderr: "" };
    };
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.type(screen.getByLabelText(/Commit message/i), "Only chosen.ts");
    await user.click(await screen.findByRole("button", { name: "Commit staged (1)" }));
    await waitFor(() => expect(commands).toContainEqual(["git", "commit", "-m", "Only chosen.ts"]));
    expect(commands.some((command) => command[1] === "add")).toBe(false);
    expect(await screen.findByText(/Using the existing staged changes/)).toBeInTheDocument();
    expect(screen.queryByText(/\$ git add --all/)).not.toBeInTheDocument();
  });

  it("loads repository Review changes without a thread or a model runtime diff", async () => {
    const user = userEvent.setup();
    const patch = "diff --git a/project.ts b/project.ts\n--- a/project.ts\n+++ b/project.ts\n@@ -1 +1 @@\n-old\n+project-only change\n";
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "git_project_diff") return { text: patch, source: "repository", baseline: "HEAD", untrackedPaths: [], truncated: false };
      return stubInvoke(command, args);
    });
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Review changes" }));
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("git_project_diff", { cwd: PROJECT_A.path }));
    expect(await screen.findByText(/project-only change/)).toBeInTheDocument();
    expect(invokeMock.mock.calls.some(([command, args]) => command === "codex_rpc" && args?.method === "gitDiffToRemote")).toBe(false);
  });

  it.each(["success", "refused"] as const)("uses the guarded native fast-forward Pull without an unsafe shell fallback: %s", async (outcome) => {
    const user = userEvent.setup();
    const refusal = "Pull refused because ignored local files would be overwritten. Your files were kept.";
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "git_workspace_pull") {
        if (outcome === "refused") throw new Error(refusal);
        return { stdout: "Fast-forward complete", stderr: "" };
      }
      return stubInvoke(command, args);
    });
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.click(await screen.findByRole("button", { name: /^Pull$/ }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("git_workspace_pull", {
      cwd: PROJECT_A.path, expectedHeadOid: "a".repeat(40), expectedBranch: "main",
      expectedRemoteUrl: "https://github.com/test-user/alpha.git", expectedRepository: "test-user/alpha",
    }));
    expect(await screen.findByText(outcome === "refused" ? refusal : /Fast-forward complete/)).toBeInTheDocument();
    expect(invokeMock.mock.calls.some(([command, args]) => command === "codex_rpc"
      && args?.method === "command/exec" && (args.params as { command?: string[] })?.command?.includes("pull"))).toBe(false);
  });

  it.each([
    ["Pull", "read-only"], ["Pull", "revisit"], ["Pull", "agent-started"],
    ["Push", "read-only"], ["Push", "revisit"], ["Push", "agent-started"],
  ] as const)("cancels %s when authorization changes during snapshot preflight: %s", async (action, change) => {
    const user = userEvent.setup();
    const pending = deferred<unknown>();
    const nativeCommand = action === "Pull" ? "git_workspace_pull" : "git_workspace_push";
    const buttonName = action === "Pull" ? /^Pull$/ : "Push commits";
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      // This exercises cancellation/retry of an actionable transfer. A clean
      // tracking baseline with zero unpublished commits now correctly disables
      // Push once the deferred workspace snapshot settles.
      if (action === "Push" && command === "github_repo_status") return {
        ...(stubInvoke(command, args) as Record<string, unknown>), ahead: 1,
      };
      if (command === "git_workspace_snapshot" && args?.cwd === PROJECT_A.path) return pending.promise;
      if (command === nativeCommand) return { stdout: "Transfer complete", stderr: "" };
      return stubInvoke(command, args);
    });
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    const reads = () => invokeMock.mock.calls.filter(([command, args]) => command === "git_workspace_snapshot" && args?.cwd === PROJECT_A.path).length;
    const readsBeforeClick = reads();
    await user.click(await screen.findByRole("button", { name: buttonName }));
    await waitFor(() => expect(reads()).toBeGreaterThan(readsBeforeClick));
    if (change === "read-only") {
      await user.click(screen.getByRole("button", { name: "Ask to act" }));
      await user.click(within(screen.getByRole("menu", { name: "Permission mode" })).getByRole("button", { name: /Read only/ }));
    } else if (change === "revisit") {
      await user.click(screen.getByRole("button", { name: /^Beta$/ }));
      await user.click(screen.getByRole("button", { name: /^Alpha$/ }));
    } else {
      const { useTaskStore } = await import("./lib/taskStore");
      act(() => {
        useTaskStore.getState().ensureTask("pull-preflight-agent", PROJECT_A.path);
        useTaskStore.getState().setTaskStatus("pull-preflight-agent", "running");
      });
    }
    await act(async () => pending.resolve(await stubInvoke("git_workspace_snapshot", { cwd: PROJECT_A.path })));
    expect(invokeMock.mock.calls.some(([command]) => command === nativeCommand)).toBe(false);
    if (change === "read-only") {
      expect(await screen.findByText("Switch this thread from Read only to Ask or Full access before changing Git or contacting GitHub.")).toBeInTheDocument();
    } else if (change === "agent-started") {
      expect(await screen.findByText("Wait for agents in this folder to finish before changing Git.")).toBeInTheDocument();
    } else {
      // Cancellation releases the original mutation leases for a fresh click.
      const retry = await screen.findByRole("button", { name: buttonName });
      await waitFor(() => expect(retry).toBeEnabled());
      await user.click(retry);
      await waitFor(() => expect(invokeMock.mock.calls.filter(([command]) => command === nativeCommand)).toHaveLength(1));
    }
  });

  it.each(["Pull", "Push"] as const)("ignores a superseded %s preflight error after revisiting a project", async (action) => {
    const user = userEvent.setup();
    const pending = deferred<void>();
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "git_workspace_snapshot" && args?.cwd === PROJECT_A.path) {
        await pending.promise;
        throw new Error("Stale preflight snapshot failed");
      }
      return stubInvoke(command, args);
    });
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    const reads = () => invokeMock.mock.calls.filter(([command, args]) => command === "git_workspace_snapshot" && args?.cwd === PROJECT_A.path).length;
    const before = reads();
    await user.click(await screen.findByRole("button", { name: action === "Pull" ? /^Pull$/ : "Push commits" }));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await user.click(screen.getByRole("button", { name: /^Beta$/ }));
    await user.click(screen.getByRole("button", { name: /^Alpha$/ }));
    await act(async () => pending.resolve());
    expect(document.querySelector(".git-screen")?.textContent ?? "").not.toContain("Stale preflight snapshot failed");
    expect(invokeMock.mock.calls.some(([command]) => command === "git_workspace_pull" || command === "git_workspace_push")).toBe(false);
  });

  it("keeps GitHub terminal sign-in failures inside the Settings modal", async () => {
    const user = userEvent.setup();
    const failure = "Run gh auth login in your terminal, then refresh GitHub settings.";
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "github_status") return { available: true, authenticated: false, path: "gh" };
      if (command === "github_login") throw new Error(failure);
      return stubInvoke(command, args);
    });
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    await user.click(within(settings).getByRole("button", { name: "GitHub" }));
    await user.click(within(settings).getByRole("button", { name: "Sign in" }));
    expect(await within(settings).findByText(failure)).toBeInTheDocument();
    expect(within(settings).getByText("gh auth login --hostname github.com")).toBeInTheDocument();
    expect(within(settings).getByRole("button", { name: /Refresh/ })).toBeEnabled();
  });

  it.each(["accept", "cancel", "stale", "partial-failure"] as const)("uses a native bulk Revert preview and preserves new files: %s", async (outcome) => {
    const user = userEvent.setup();
    const refusal = outcome === "partial-failure"
      ? "Revert all reset the index, but restoring committed working files did not finish: permission denied. Some tracked paths may have changed. Refresh and inspect before trying again."
      : "The repository changed while confirmation was open. Nothing reverted.";
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "git_workspace_revert_all_preview") return { token: "bulk-preview", restorePaths: ["tracked.txt"], preservedPaths: ["added.txt", "untracked.txt"], headOid: "a".repeat(40), branch: "main" };
      if (command === "git_workspace_revert_all") {
        if (outcome === "stale" || outcome === "partial-failure") throw new Error(refusal);
        return { stdout: "", stderr: "" };
      }
      return stubInvoke(command, args);
    });
    vi.mocked(window.confirm).mockReturnValue(outcome !== "cancel");
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.click(screen.getByRole("button", { name: "More local Git actions" }));
    await user.click(screen.getByRole("menuitem", { name: /Revert all changes/ }));
    await waitFor(() => expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("2 added, untracked, or renamed destination paths will be kept")));
    if (outcome === "cancel") expect(invokeMock.mock.calls.some(([command]) => command === "git_workspace_revert_all")).toBe(false);
    else {
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("git_workspace_revert_all", { cwd: PROJECT_A.path, expectedToken: "bulk-preview" }));
      expect(await screen.findByText(outcome === "stale" || outcome === "partial-failure" ? refusal : /New file contents were kept/)).toBeInTheDocument();
    }
    expect(invokeMock.mock.calls.some(([command, args]) => command === "codex_rpc" && args?.method === "command/exec" && (args.params as { command: string[] }).command.includes("restore"))).toBe(false);
  });

  it("does not confirm or execute a bulk Revert preview after switching projects", async () => {
    const user = userEvent.setup();
    const pending = deferred<{ token: string; restorePaths: string[]; preservedPaths: string[]; headOid: string; branch: string }>();
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => command === "git_workspace_revert_all_preview" ? pending.promise : stubInvoke(command, args));
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.click(screen.getByRole("button", { name: "More local Git actions" }));
    await user.click(screen.getByRole("menuitem", { name: /Revert all changes/ }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("git_workspace_revert_all_preview", { cwd: PROJECT_A.path }));
    await user.click(screen.getByRole("button", { name: /^Beta$/ }));
    await act(async () => pending.resolve({ token: "old-project", restorePaths: ["tracked.txt"], preservedPaths: [], headOid: "a".repeat(40), branch: "main" }));
    expect(window.confirm).not.toHaveBeenCalled();
    expect(invokeMock.mock.calls.some(([command]) => command === "git_workspace_revert_all")).toBe(false);
  });

  it("does not confirm or execute a file Revert preview after switching projects", async () => {
    const user = userEvent.setup();
    const pending = deferred<GitWorkspaceRevertPreview>();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    gitDiffToRemoteImpl = () => ({ diff: "diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n" });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => command === "git_workspace_revert_preview" ? pending.promise : stubInvoke(command, args));
    await renderApp();
    await user.click(await screen.findByRole("button", { name: /^Open Alpha thread\b/ }));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Review workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    await user.click(await screen.findByRole("button", { name: "Revert new.txt" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("git_workspace_revert_preview", { cwd: PROJECT_A.path, path: "new.txt" }));
    await user.click(screen.getByRole("button", { name: /^Beta$/ }));
    await act(async () => pending.resolve({ token: "old-file-preview", paths: ["old.txt", "new.txt"], restorePaths: ["old.txt"], preservedPaths: ["new.txt"], headOid: "a".repeat(40), branch: "main" }));
    expect(window.confirm).not.toHaveBeenCalled();
    expect(invokeMock.mock.calls.some(([command]) => command === "git_workspace_revert")).toBe(false);
  });

  it("does not execute a file Revert after switching projects during confirmation", async () => {
    const user = userEvent.setup();
    const pending = deferred<boolean>();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    gitDiffToRemoteImpl = () => ({ diff: "diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n" });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => command === "git_workspace_revert_preview"
      ? { token: "old-file-preview", paths: ["old.txt", "new.txt"], restorePaths: ["old.txt"], preservedPaths: ["new.txt"], headOid: "a".repeat(40), branch: "main" }
      : stubInvoke(command, args));
    // confirmDialog awaits an asynchronous in-app modal in the native app.
    vi.mocked(window.confirm).mockReturnValue(pending.promise as unknown as boolean);
    await renderApp();
    await user.click(await screen.findByRole("button", { name: /^Open Alpha thread\b/ }));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Review workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    await user.click(await screen.findByRole("button", { name: "Revert new.txt" }));
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: /^Beta$/ }));
    await act(async () => pending.resolve(true));
    expect(invokeMock.mock.calls.some(([command]) => command === "git_workspace_revert")).toBe(false);
  });

  it("does not execute a file Revert after leaving and returning to the project during confirmation", async () => {
    const user = userEvent.setup();
    const pending = deferred<boolean>();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    gitDiffToRemoteImpl = () => ({ diff: "diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n" });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => command === "git_workspace_revert_preview"
      ? { token: "old-file-preview", paths: ["old.txt", "new.txt"], restorePaths: ["old.txt"], preservedPaths: ["new.txt"], headOid: "a".repeat(40), branch: "main" }
      : stubInvoke(command, args));
    vi.mocked(window.confirm).mockReturnValue(pending.promise as unknown as boolean);
    await renderApp();
    await user.click(await screen.findByRole("button", { name: /^Open Alpha thread\b/ }));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Review workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    await user.click(await screen.findByRole("button", { name: "Revert new.txt" }));
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    // The same checkout string again is a new visit, not the confirmed intent.
    await user.click(screen.getByRole("button", { name: /^Beta$/ }));
    await user.click(screen.getByRole("button", { name: /^Alpha$/ }));
    await act(async () => pending.resolve(true));
    expect(invokeMock.mock.calls.some(([command]) => command === "git_workspace_revert")).toBe(false);
  });

  it("refuses a confirmed file Revert when an agent starts in the folder during confirmation", async () => {
    const user = userEvent.setup();
    const pending = deferred<boolean>();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    gitDiffToRemoteImpl = () => ({ diff: "diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n" });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => command === "git_workspace_revert_preview"
      ? { token: "old-file-preview", paths: ["old.txt", "new.txt"], restorePaths: ["old.txt"], preservedPaths: ["new.txt"], headOid: "a".repeat(40), branch: "main" }
      : stubInvoke(command, args));
    vi.mocked(window.confirm).mockReturnValue(pending.promise as unknown as boolean);
    await renderApp();
    await user.click(await screen.findByRole("button", { name: /^Open Alpha thread\b/ }));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Review workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    await user.click(await screen.findByRole("button", { name: "Revert new.txt" }));
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    // Scheduled and workflow runs do not pass through the composer's lease check.
    const { useTaskStore } = await import("./lib/taskStore");
    act(() => {
      useTaskStore.getState().ensureTask("scheduled-run", PROJECT_A.path);
      useTaskStore.getState().setTaskStatus("scheduled-run", "running");
    });
    await act(async () => pending.resolve(true));
    expect(invokeMock.mock.calls.some(([command]) => command === "git_workspace_revert")).toBe(false);
    expect(await screen.findByText("Wait for agents in this folder to finish before changing Git.")).toBeInTheDocument();
  });

  it("refuses a confirmed file Revert when permission changes to Read only during confirmation", async () => {
    const user = userEvent.setup();
    const pending = deferred<boolean>();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    gitDiffToRemoteImpl = () => ({ diff: "diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n" });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => command === "git_workspace_revert_preview"
      ? { token: "permission-preview", paths: ["old.txt", "new.txt"], restorePaths: ["old.txt"], preservedPaths: ["new.txt"], headOid: "a".repeat(40), branch: "main" }
      : stubInvoke(command, args));
    vi.mocked(window.confirm).mockReturnValue(pending.promise as unknown as boolean);
    await renderApp();
    await user.click(await screen.findByRole("button", { name: /^Open Alpha thread\b/ }));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Review workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    await user.click(await screen.findByRole("button", { name: "Revert new.txt" }));
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "Ask to act" }));
    await user.click(within(screen.getByRole("menu", { name: "Permission mode" })).getByRole("button", { name: /Read only/ }));
    expect(screen.getByRole("button", { name: "Read only" })).toBeInTheDocument();
    await act(async () => pending.resolve(true));
    expect(invokeMock.mock.calls.some(([command]) => command === "git_workspace_revert")).toBe(false);
    expect(await screen.findByText("Switch this thread from Read only to Ask or Full access before changing Git or contacting GitHub.")).toBeInTheDocument();
  });

  it("names restored and kept paths when a file Revert preserves a renamed destination", async () => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    gitDiffToRemoteImpl = () => ({ diff: "diff --git a/old.txt b/new.txt\nsimilarity index 90%\nrename from old.txt\nrename to new.txt\n" });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "git_workspace_revert_preview") return {
        token: "rename-preview", paths: ["old.txt", "new.txt"], restorePaths: ["old.txt"], preservedPaths: ["new.txt"], headOid: "a".repeat(40), branch: "main",
      };
      if (command === "git_workspace_revert") return { stdout: "", stderr: "" };
      return stubInvoke(command, args);
    });
    await renderApp();
    await user.click(await screen.findByRole("button", { name: /^Open Alpha thread\b/ }));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Review workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    await user.click(await screen.findByRole("button", { name: "Revert new.txt" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("git_workspace_revert", { cwd: PROJECT_A.path, path: "new.txt", expectedToken: "rename-preview" }));
    const confirmation = vi.mocked(window.confirm).mock.calls[0]?.[0] as string;
    expect(confirmation).toContain('restores the committed content of "old.txt"');
    expect(confirmation).toContain('"new.txt" will be unstaged and kept as a new untracked file with its current contents');
    expect(confirmation).not.toContain("discards staged and working edits for these paths");
  });

  it("refuses a confirmed bulk Revert when an agent starts in the folder during confirmation", async () => {
    const user = userEvent.setup();
    const pending = deferred<boolean>();
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => command === "git_workspace_revert_all_preview"
      ? { token: "bulk-preview", restorePaths: ["tracked.txt"], preservedPaths: [], headOid: "a".repeat(40), branch: "main" }
      : stubInvoke(command, args));
    vi.mocked(window.confirm).mockReturnValue(pending.promise as unknown as boolean);
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.click(screen.getByRole("button", { name: "More local Git actions" }));
    await user.click(screen.getByRole("menuitem", { name: /Revert all changes/ }));
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    const { useTaskStore } = await import("./lib/taskStore");
    act(() => {
      useTaskStore.getState().ensureTask("workflow-run", PROJECT_A.path);
      useTaskStore.getState().setTaskStatus("workflow-run", "running");
    });
    await act(async () => pending.resolve(true));
    expect(invokeMock.mock.calls.some(([command]) => command === "git_workspace_revert_all")).toBe(false);
    expect(await screen.findByText("Wait for agents in this folder to finish before changing Git.")).toBeInTheDocument();
  });

  it("keeps native recovery guidance when a commit times out after it may have been saved", async () => {
    const user = userEvent.setup();
    const failure = "Git operation timed out\n\nHEAD is now bbbbbbb. A commit may already have been saved. Refresh and inspect it before trying another commit.";
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "git_workspace_commit") throw new Error(failure);
      return stubInvoke(command, args);
    });
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.type(screen.getByLabelText(/Commit message/i), "Slow hook");
    await user.click(screen.getByRole("button", { name: "Commit all changes locally" }));
    expect(await screen.findByText(/A commit may already have been saved\. Refresh and inspect it before trying another commit\./)).toBeInTheDocument();
    expect(screen.queryByText(/The runtime took too long to respond/)).not.toBeInTheDocument();
  });

  it("keeps native push rejection detail after a saved commit", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "git_workspace_push") throw new Error("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.");
      return stubInvoke(command, args);
    });
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.type(screen.getByLabelText(/Commit message/i), "Push me");
    await user.click(screen.getByRole("button", { name: /Commit & push/i }));
    expect(await screen.findByText(/GitHub push needs attention:\s+git@github\.com: Permission denied \(publickey\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Check the project folder and permission mode/)).not.toBeInTheDocument();
  });

  it("keeps a created repository URL when attaching it to the project fails", async () => {
    const user = userEvent.setup();
    const failure = "GitHub repository created at https://github.com/test-user/fresh.git, but it could not be attached to this project. error: could not lock config file .git/config: Permission denied Use Attach remote with this URL to finish connecting it. No commits were uploaded.";
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "github_repo_status") return { isRepo: true, repository: null, remoteUrl: null, branch: "main", upstream: null, ahead: 0, behind: 0 };
      if (command === "github_create_repository") throw new Error(failure);
      return stubInvoke(command, args);
    });
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.click(await screen.findByRole("button", { name: /(?:Publish this project to GitHub|Connect a GitHub repository)/ }));
    const repositoryName = await screen.findByLabelText("New GitHub repository name");
    await user.clear(repositoryName);
    await user.type(repositoryName, "fresh");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("github_create_repository", expect.objectContaining({ cwd: PROJECT_A.path, name: "fresh" })));
    const alerts = await screen.findAllByText(/https:\/\/github\.com\/test-user\/fresh\.git.*Use Attach remote with this URL/);
    expect(alerts.length).toBeGreaterThan(0);
    expect(screen.queryByText(/Check the project folder and permission mode/)).not.toBeInTheDocument();
  });

  it("uses a native exact-file preview token when reverting a rename", async () => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    gitDiffToRemoteImpl = () => ({ diff: "diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n" });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "git_workspace_revert_preview") return { token: "frozen-preview", paths: ["old.txt", "new.txt"], restorePaths: ["old.txt"], preservedPaths: ["new.txt"], headOid: "a".repeat(40), branch: "main" };
      if (command === "git_workspace_revert") return { stdout: "", stderr: "" };
      return stubInvoke(command, args);
    });
    await renderApp();
    await user.click(await screen.findByRole("button", { name: /^Open Alpha thread\b/ }));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Review workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    await user.click(await screen.findByRole("button", { name: "Revert new.txt" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("git_workspace_revert", { cwd: PROJECT_A.path, path: "new.txt", expectedToken: "frozen-preview" }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('"old.txt" and "new.txt"'));
    expect(invokeMock.mock.calls.some(([command, args]) => command === "codex_rpc" && args?.method === "command/exec" && (args.params as { command: string[] }).command.includes("restore"))).toBe(false);
  });

  it("shows a stale Revert refusal without leaving the Review tab", async () => {
    const user = userEvent.setup();
    const refusal = "The repository or file changed while confirmation was open. Nothing reverted.";
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    gitDiffToRemoteImpl = () => ({ diff: "diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n" });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "git_workspace_revert_preview") return { token: "stale-preview", paths: ["old.txt", "new.txt"], restorePaths: ["old.txt"], preservedPaths: ["new.txt"], headOid: "a".repeat(40), branch: "main" };
      if (command === "git_workspace_revert") throw new Error(refusal);
      return stubInvoke(command, args);
    });
    await renderApp();
    await user.click(await screen.findByRole("button", { name: /^Open Alpha thread\b/ }));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Review workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    await user.click(await screen.findByRole("button", { name: "Revert new.txt" }));
    expect(await screen.findByText(refusal)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Review workspace tool" })).toHaveAttribute("aria-selected", "true");
  });

  it.each([
    { branchDeleted: false, retainedBranch: "kiwi/alpha", retainedBranchOid: "b".repeat(40), branchDeleteError: "Branch is not fully merged into its upstream.", message: "Branch kiwi/alpha was kept" },
    { branchDeleted: true, retainedBranch: null, retainedBranchOid: null, branchDeleteError: "Branch configuration cleanup timed out.", message: "Branch kiwi/alpha was deleted, but cleanup is incomplete" },
    { branchDeleted: false, retainedBranch: null, retainedBranchOid: null, branchDeleteError: "Branch inspection timed out.", message: "The state of branch kiwi/alpha could not be verified. Inspect the branch before retrying cleanup" },
  ])("records a removed worktree and honestly reports partial branch cleanup: $message", async (outcome) => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    localStorage.setItem("kiwi.studioTab", JSON.stringify("worktrees"));
    localStorage.setItem("kiwi.threadWorktrees", JSON.stringify({ [THREAD_A.id]: {
      threadId: THREAD_A.id, projectId: PROJECT_A.id, projectPath: PROJECT_A.path,
      path: "/managed/worktrees/alpha", branch: "kiwi/alpha", baseCommit: "head",
      gitDir: "/projects/alpha/.git", createdAt: 1, status: "active",
    } }));
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "worktree_remove") return { folderRemoved: true, ...outcome };
      return stubInvoke(command, args);
    });
    await renderApp();
    await user.click(await screen.findByRole("button", { name: /^Open Alpha thread\b/ }));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("button", { name: "More worktree actions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Remove worktree/ }));
    expect(await screen.findByText(`The worktree folder was removed. ${outcome.message}: ${outcome.branchDeleteError}`)).toBeInTheDocument();
    await waitFor(() => {
      const record = JSON.parse(localStorage.getItem("kiwi.threadWorktrees") ?? "{}")[THREAD_A.id];
      expect(record).toMatchObject({ status: "removed", branchDeleteError: outcome.branchDeleteError });
      expect(record.retainedBranch).toBe(outcome.retainedBranch ?? undefined);
      expect(record.retainedBranchOid).toBe(outcome.retainedBranchOid ?? undefined);
    });
  });

  it("shows native worktree removal failures instead of runtime setup advice", async () => {
    const user = userEvent.setup();
    const failure = "Git operation timed out\nThe isolated worktree at /managed/worktrees/alpha may be partly removed. Inspect it before retrying.";
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    localStorage.setItem("kiwi.studioTab", JSON.stringify("worktrees"));
    localStorage.setItem("kiwi.threadWorktrees", JSON.stringify({ [THREAD_A.id]: {
      threadId: THREAD_A.id, projectId: PROJECT_A.id, projectPath: PROJECT_A.path,
      path: "/managed/worktrees/alpha", branch: "kiwi/alpha", baseCommit: "head",
      gitDir: "/projects/alpha/.git", createdAt: 1, status: "active",
    } }));
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "worktree_remove") throw new Error(failure);
      return stubInvoke(command, args);
    });
    await renderApp();
    await user.click(await screen.findByRole("button", { name: /^Open Alpha thread\b/ }));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("button", { name: "More worktree actions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Remove worktree/ }));
    expect(await screen.findByText(/may be partly removed\. Inspect it before retrying\./)).toBeInTheDocument();
    expect(screen.queryByText(/The runtime took too long to respond/)).not.toBeInTheDocument();
  });

  it("shows native worktree recreation failures instead of runtime setup advice", async () => {
    const user = userEvent.setup();
    const failure = "Could not create the Mythra Code worktree folder: No such file or directory (os error 2)";
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    localStorage.setItem("kiwi.studioTab", JSON.stringify("worktrees"));
    localStorage.setItem("kiwi.threadWorktrees", JSON.stringify({ [THREAD_A.id]: {
      threadId: THREAD_A.id, projectId: PROJECT_A.id, projectPath: PROJECT_A.path,
      path: "/managed/worktrees/missing-alpha", branch: "kiwi/alpha", baseCommit: "head",
      gitDir: "/projects/alpha/.git", createdAt: 1, status: "missing",
    } }));
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "worktree_recreate") throw new Error(failure);
      return stubInvoke(command, args);
    });
    await renderApp();
    await user.click(await screen.findByRole("button", { name: /^Open Alpha thread\b/ }));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("button", { name: /Recreate from branch/ }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("worktree_recreate", expect.objectContaining({ projectPath: PROJECT_A.path, branch: "kiwi/alpha" })));
    expect(await screen.findByText(failure)).toBeInTheDocument();
    expect(screen.queryByText(/The Codex runtime could not be found/)).not.toBeInTheDocument();
  });

  it("wires per-file Unstage in Review to the index without reverting the file", async () => {
    const user = userEvent.setup();
    const commands: string[][] = [];
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    gitDiffToRemoteImpl = () => ({ diff: "diff --git a/chosen.ts b/chosen.ts\n--- a/chosen.ts\n+++ b/chosen.ts\n@@ -1 +1 @@\n-old\n+new\n" });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "git_workspace_snapshot") return {
        branch: "main", headOid: "a".repeat(40), branches: [], stagedFiles: 1,
        unstagedFiles: 0, changedFiles: 1, stagedPaths: ["chosen.ts"], rootPath: PROJECT_A.path,
      };
      return stubInvoke(command, args);
    });
    commandExecImpl = (params) => {
      commands.push(params.command as string[]);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await renderApp();
    await user.click(await screen.findByRole("button", { name: /^Open Alpha thread\b/ }));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Review workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    await user.click(await screen.findByRole("button", { name: "Unstage" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("git_workspace_stage", expect.objectContaining({ cwd: PROJECT_A.path, path: "chosen.ts", unstage: true })));
    expect(commands.some((command) => command[1] === "restore")).toBe(false);
  });

  it.each(["stage", "unstage", "revert"] as const)("rejects a nested Review %s at the App owner before confirmation or mutation", async (action) => {
    const user = userEvent.setup();
    let dockProps: Parameters<(typeof import("./components/StudioDock"))["StudioDock"]>[0] | undefined;
    vi.doMock("./components/StudioDock", async () => {
      const actual = await vi.importActual<typeof import("./components/StudioDock")>("./components/StudioDock");
      return { ...actual, StudioDock: (props: Parameters<typeof actual.StudioDock>[0]) => {
        dockProps = props;
        return <actual.StudioDock {...props} />;
      } };
    });
    try {
      resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
      gitDiffToRemoteImpl = () => ({ diff: "diff --git a/alpha/chosen.ts b/alpha/chosen.ts\n--- a/alpha/chosen.ts\n+++ b/alpha/chosen.ts\n@@ -1 +1 @@\n-old\n+new\n" });
      invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => command === "git_workspace_snapshot"
        ? { branch: "main", headOid: "a".repeat(40), branches: [], stagedFiles: 1, unstagedFiles: 0, changedFiles: 1, stagedPaths: ["alpha/chosen.ts"], rootPath: "/projects", isRoot: false }
        : stubInvoke(command, args));
      const commands: string[][] = [];
      commandExecImpl = (params) => {
        commands.push(params.command as string[]);
        return { exitCode: 0, stdout: "", stderr: "" };
      };
      await renderApp();
      await user.click(await screen.findByRole("button", { name: /^Open Alpha thread\b/ }));
      await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
      await user.click(await screen.findByRole("tab", { name: "Review workspace tool" }));
      await waitFor(() => expect(dockProps?.gitWorkflow?.snapshot?.isRoot).toBe(false));
      vi.mocked(window.confirm).mockClear();
      // Call the owner's callback directly: disabled buttons cannot prove that
      // another caller, or a stale view, is refused before destructive work.
      await act(async () => {
        if (action === "unstage") dockProps?.onGitPathUnstage?.("alpha/chosen.ts");
        else dockProps?.onGitPathAction(action, "alpha/chosen.ts");
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      expect(window.confirm).not.toHaveBeenCalled();
      expect(invokeMock.mock.calls.some(([command]) => command === "git_workspace_stage")).toBe(false);
      expect(commands.some((command) => command.includes("restore"))).toBe(false);
      await user.click(screen.getByRole("tab", { name: "Git workspace tool" }));
      expect(screen.getByText("Git output").closest("details")).toHaveTextContent("Open the repository root (/projects)");
    } finally {
      vi.doUnmock("./components/StudioDock");
    }
  });

  it("unstages an initial snapshot without deleting its working files", async () => {
    const user = userEvent.setup();
    const commands: string[][] = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "git_workspace_snapshot") return { branch: "main", headOid: null, branches: [], stagedFiles: 1, unstagedFiles: 1, changedFiles: 1, stagedPaths: ["new.txt"], rootPath: PROJECT_A.path };
      if (command === "git_project_changes") return {
        rootPath: PROJECT_A.path, truncated: false, stagedFiles: 1, unstagedFiles: 1, untrackedFiles: 0, changedFiles: 1,
        rows: [{ path: "new.txt", originalPath: null, area: "staged", status: "A" }, { path: "new.txt", originalPath: null, area: "unstaged", status: "M" }],
      };
      return stubInvoke(command, args);
    });
    commandExecImpl = (params) => {
      const command = params.command as string[];
      commands.push(command);
      return { exitCode: command[1] === "rev-parse" ? 1 : 0, stdout: "", stderr: "" };
    };
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.click(screen.getByRole("button", { name: "More local Git actions" }));
    await user.click(screen.getByRole("menuitem", { name: /Unstage all/ }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("git_workspace_stage", expect.objectContaining({ cwd: PROJECT_A.path, path: null, unstage: true })));
    expect(commands.some((command) => command[1] === "reset")).toBe(false);
  });

  it("does not show a finished commit under a project selected while it was running", async () => {
    const user = userEvent.setup();
    const pendingCommit = deferred<{ exitCode: number; stdout: string; stderr: string }>();
    commandExecImpl = (params) => {
      const command = params.command as string[];
      if (command[1] === "commit") return pendingCommit.promise;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await renderApp();

    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.type(screen.getByLabelText(/Commit message/i), "Commit Alpha changes");
    await user.click(screen.getByRole("button", { name: "Commit all changes locally" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("git_workspace_commit", expect.objectContaining({ cwd: PROJECT_A.path, message: "Commit Alpha changes", stagedOnly: false }));
    });

    await user.click(screen.getByRole("button", { name: PROJECT_B.name }));
    expect(screen.getByLabelText(/Commit message/i)).toHaveValue("");

    await act(async () => {
      pendingCommit.resolve({ exitCode: 0, stdout: "[main abc1234] Commit Alpha changes\n", stderr: "" });
      await pendingCommit.promise;
    });

    expect(screen.queryByText("Committed successfully")).not.toBeInTheDocument();
    expect(screen.queryByText("Changes committed locally")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Commit message/i)).toHaveValue("");
  });

  it("shows a completed commit and refreshes its checkout after navigating away and back", async () => {
    const user = userEvent.setup();
    const pendingCommit = deferred<{ exitCode: number; stdout: string; stderr: string }>();
    let committed = false;
    commandExecImpl = (params) => {
      const command = params.command as string[];
      if (command[1] === "commit") return pendingCommit.promise.then((result) => { committed = true; return result; });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      const result = await stubInvoke(command, args);
      if (command === "git_workspace_snapshot" && args?.cwd === PROJECT_A.path) return {
        ...result as Record<string, unknown>, headOid: (committed ? "b" : "a").repeat(40),
      };
      return result;
    });
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.type(screen.getByLabelText(/Commit message/i), "Saved after returning");
    await user.click(screen.getByRole("button", { name: "Commit all changes locally" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("git_workspace_commit", expect.objectContaining({ cwd: PROJECT_A.path, message: "Saved after returning" })));
    await user.click(screen.getByRole("button", { name: PROJECT_B.name }));
    expect(screen.getByRole("button", { name: "Commit all changes locally" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    expect(screen.getByLabelText(/Commit message/i)).toHaveValue("Saved after returning");
    expect(screen.getByRole("button", { name: "Committing…" })).toBeDisabled();
    const readsBeforeCompletion = invokeMock.mock.calls.filter(([command, args]) => command === "git_workspace_snapshot" && args?.cwd === PROJECT_A.path).length;
    await act(async () => {
      pendingCommit.resolve({ exitCode: 0, stdout: "[main bbbbbbb] Saved after returning\n", stderr: "" });
      await pendingCommit.promise;
    });
    expect(await screen.findByText(/“Saved after returning” was saved/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/Commit message/i)).toHaveValue(""));
    expect(screen.getByRole("button", { name: "Commit all changes locally" })).toBeEnabled();
    await waitFor(() => expect(invokeMock.mock.calls.filter(([command, args]) => command === "git_workspace_snapshot" && args?.cwd === PROJECT_A.path).length).toBeGreaterThan(readsBeforeCompletion));
    expect(invokeMock.mock.calls.filter(([command]) => command === "git_workspace_commit")).toHaveLength(1);
  });

  it("retains a commit completed in another checkout and consumes its draft on return", async () => {
    const user = userEvent.setup();
    const pendingCommit = deferred<{ exitCode: number; stdout: string; stderr: string }>();
    commandExecImpl = (params) => (params.command as string[])[1] === "commit"
      ? pendingCommit.promise : { exitCode: 0, stdout: "", stderr: "" };
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.type(screen.getByLabelText(/Commit message/i), "Saved while viewing Beta");
    await user.click(screen.getByRole("button", { name: "Commit all changes locally" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("git_workspace_commit", expect.objectContaining({ cwd: PROJECT_A.path, message: "Saved while viewing Beta" })));
    await user.click(screen.getByRole("button", { name: PROJECT_B.name }));
    await act(async () => {
      pendingCommit.resolve({ exitCode: 0, stdout: "[main bbbbbbb] Saved while viewing Beta\n", stderr: "" });
      await pendingCommit.promise;
    });
    expect(screen.queryByText("Committed successfully")).not.toBeInTheDocument();
    expect(screen.queryByText("Changes committed locally")).not.toBeInTheDocument();
    expect(screen.queryByText(/Saved while viewing Beta/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Commit message/i)).toHaveValue("");
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    expect(await screen.findByText(/“Saved while viewing Beta” was saved/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/Commit message/i)).toHaveValue(""));
    expect(screen.getByRole("button", { name: "Commit all changes locally" })).toBeEnabled();
    expect(invokeMock.mock.calls.filter(([command]) => command === "git_workspace_commit")).toHaveLength(1);
  });

  it("does not install a thread whose resume settles after switching workspaces", async () => {
    const user = userEvent.setup();
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    // Project Alpha is active by default; open its thread while the resume
    // RPC is still in flight.
    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some(
          ([command, args]) => command === "codex_rpc" && args?.method === "thread/resume",
        ),
      ).toBe(true);
    });

    // Switch to project Beta before the resume resolves.
    await user.click(screen.getByRole("button", { name: PROJECT_B.name }));

    // The stale resume from Alpha settles late. It must not leak Alpha's
    // thread into Beta's workspace.
    await act(async () => {
      pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } as Thread });
      await pendingResume.promise;
    });

    expect(useTaskStore.getState().activeThreadId).toBeNull();
    expect(screen.queryByText("work in alpha")).not.toBeInTheDocument();
  });

  it("does not reopen a preparing thread after the user starts a new one", async () => {
    const user = userEvent.setup();
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some(
          ([command, args]) => command === "codex_rpc" && args?.method === "thread/resume",
        ),
      ).toBe(true);
    });

    await user.click(screen.getByRole("button", { name: /^New threadCtrl/ }));
    await act(async () => {
      pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } as Thread });
      await pendingResume.promise;
    });

    expect(useTaskStore.getState().activeThreadId).toBeNull();
    expect(screen.queryByText("work in alpha")).not.toBeInTheDocument();
  });

  it("removes a stale sidebar row when its OpenAI rollout is definitively missing", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.knownThreads", JSON.stringify({ [THREAD_A.id]: THREAD_A }));
    threadReadImpl = (params) => {
      if (String(params.threadId) === THREAD_A.id) {
        throw new Error(`no rollout found for thread id ${THREAD_A.id}`);
      }
      return { thread: { ...THREAD_B, id: String(params.threadId), turns: [] } };
    };
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));

    expect(await screen.findByText(/removed its stale sidebar entry/i)).toBeInTheDocument();
    expect(screen.queryByText("Alpha thread")).not.toBeInTheDocument();
    const remembered = JSON.parse(localStorage.getItem("kiwi.knownThreads") ?? "{}") as Record<string, Thread>;
    expect(remembered).not.toHaveProperty(THREAD_A.id);
    const { useTaskStore } = await import("./lib/taskStore");
    expect(useTaskStore.getState().activeThreadId).toBeNull();
  });

  it("paints OpenAI history before live-runtime preparation finishes", async () => {
    const user = userEvent.setup();
    threadTurnsListImpl = () => ({
      data: [{
        id: "recent-turn",
        status: "completed",
        items: [{
          id: "recent-message",
          type: "userMessage",
          content: [{ type: "text", text: "visible before Windows runtime preparation" }],
        }],
      }],
      nextCursor: null,
      backwardsCursor: null,
    });
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));

    expect(await screen.findByText("visible before Windows runtime preparation")).toBeInTheDocument();
    const methods = invokeMock.mock.calls
      .filter(([command]) => command === "codex_rpc")
      .map(([, args]) => args?.method);
    expect(methods.indexOf("thread/read")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("thread/read")).toBeLessThan(methods.indexOf("thread/resume"));

    await act(async () => {
      pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } });
      await pendingResume.promise;
    });
  });

  it("requests OpenAI metadata and recent history concurrently", async () => {
    const user = userEvent.setup();
    const metadata = deferred<{ thread: Thread }>();
    threadReadImpl = (params) => params.includeTurns
      ? { thread: { ...THREAD_A, id: String(params.threadId), turns: [] } }
      : metadata.promise;
    threadTurnsListImpl = () => ({
      data: [{
        id: "recent-turn",
        status: "completed",
        items: [{
          id: "recent-message",
          type: "userMessage",
          content: [{ type: "text", text: "parallel history" }],
        }],
      }],
      nextCursor: null,
      backwardsCursor: null,
    });
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({
      method: "thread/turns/list",
      params: expect.objectContaining({ threadId: THREAD_A.id }),
    })));
    expect(screen.queryByText("parallel history")).not.toBeInTheDocument();

    await act(async () => {
      metadata.resolve({ thread: { ...THREAD_A, turns: [] } });
      await metadata.promise;
    });
    expect(await screen.findByText("parallel history")).toBeInTheDocument();
    // Settle the independent runtime-preparation work before test cleanup.
    await act(async () => {
      pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } });
      await pendingResume.promise;
    });
  });

  it("falls back safely when paging is rejected before metadata resolves", async () => {
    const user = userEvent.setup();
    const metadata = deferred<{ thread: Thread }>();
    let metadataReadPending = true;
    threadReadImpl = (params) => {
      const thread = String(params.threadId) === THREAD_B.id ? THREAD_B : THREAD_A;
      if (!params.includeTurns && metadataReadPending && thread.id === THREAD_A.id) {
        metadataReadPending = false;
        return metadata.promise;
      }
      return {
        thread: {
          ...thread,
          turns: params.includeTurns && thread.id === THREAD_A.id
            ? [{
                id: "fallback-turn",
                status: "completed",
                items: [{
                  id: "fallback-message",
                  type: "userMessage",
                  content: [{ type: "text", text: "history from compatibility fallback" }],
                }],
              }]
            : [],
        },
      };
    };
    threadTurnsListImpl = () => {
      throw new Error("unknown field `itemsView`");
    };
    resumeImpl = (params) => ({
      thread: { ...(String(params.threadId) === THREAD_B.id ? THREAD_B : THREAD_A), turns: [] },
    });
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");
    const turnsListCalls = () => invokeMock.mock.calls.filter(([command, args]) => (
      command === "codex_rpc" && args?.method === "thread/turns/list"
    ));

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => expect(turnsListCalls()).toHaveLength(1));
    expect(screen.queryByText("history from compatibility fallback")).not.toBeInTheDocument();

    await act(async () => {
      metadata.resolve({ thread: { ...THREAD_A, turns: [] } });
      await metadata.promise;
    });
    expect(await screen.findByText("history from compatibility fallback")).toBeInTheDocument();

    await user.click(await screen.findByText("Beta thread"));
    await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe(THREAD_B.id));
    expect(turnsListCalls()).toHaveLength(1);
  });

  it("opens a local-provider thread from a bounded page and recovers stale backward paging", async () => {
    const user = userEvent.setup();
    const claudeThread: Thread = {
      ...THREAD_A,
      id: "claude-thread",
      name: "Paged Claude thread",
      preview: "newest local message",
      modelProvider: "claude",
    };
    let staleCursorOnce = true;
    localStorage.setItem("kiwi.knownThreads", JSON.stringify({ [claudeThread.id]: claudeThread }));
    localStorage.setItem("kiwi.threadProjects", JSON.stringify({ [claudeThread.id]: PROJECT_A.path }));
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "local_transcript_page_read") {
        if (args?.cursor) {
          if (staleCursorOnce) {
            staleCursorOnce = false;
            throw new Error("Local transcript cursor is stale");
          }
          return {
            thread: claudeThread,
            messages: [{ id: "older-local", role: "user", text: "older local message", turnId: "older-turn", turnStatus: "completed", timelineOrder: 1 }],
            activities: [],
            nextCursor: null,
            headSeq: 2,
            tailSeq: 3,
            generation: 7,
            byteLen: 1_024,
          };
        }
        return {
          thread: claudeThread,
          messages: [{ id: "newest-local", role: "assistant", text: "newest local message", turnId: "newest-turn", turnStatus: "completed", timelineOrder: 2 }],
          activities: [],
          nextCursor: "7:1",
          headSeq: 2,
          tailSeq: 3,
          generation: 7,
          byteLen: 8_192,
        };
      }
      if (command === "local_transcript_write_state_read") {
        return { generation: 7, headSeq: 2, tailSeq: 3 };
      }
      return stubInvoke(command, args);
    });
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Paged Claude thread"));

    expect(await screen.findByText("newest local message")).toBeInTheDocument();
    expect(screen.queryByText("older local message")).not.toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("local_transcript_page_read", {
      provider: "claude",
      threadId: claudeThread.id,
      cursor: null,
      byteBudget: 40 * 1024,
    });
    expect(useTaskStore.getState().tasks[claudeThread.id]?.history).toMatchObject({
      paginated: true,
      hasMore: true,
      nextCursor: "7:1",
    });

    await user.click(await screen.findByRole("button", { name: "Load earlier messages" }));

    expect(await screen.findByText("older local message")).toBeInTheDocument();
    expect(useTaskStore.getState().tasks[claudeThread.id]?.history).toMatchObject({
      paginated: true,
      hasMore: false,
      nextCursor: null,
    });
    expect(invokeMock).toHaveBeenCalledWith("local_transcript_page_read", {
      provider: "claude",
      threadId: claudeThread.id,
      cursor: "7:1",
      byteBudget: 40 * 1024,
    });
    expect(invokeMock.mock.calls.filter(([command, args]) => (
      command === "local_transcript_page_read" && args?.threadId === claudeThread.id
    ))).toHaveLength(4);

    const readsAfterPaging = invokeMock.mock.calls.filter(([command, args]) => (
      command === "local_transcript_page_read" && args?.threadId === claudeThread.id
    )).length;
    await user.click(await screen.findByText("Beta thread"));
    await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe(THREAD_B.id));
    await user.click(await screen.findByText("Paged Claude thread"));
    await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe(claudeThread.id));
    expect(invokeMock.mock.calls.filter(([command, args]) => (
      command === "local_transcript_page_read" && args?.threadId === claudeThread.id
    ))).toHaveLength(readsAfterPaging);
  });

  it("clears an older-page loading latch when the user leaves the thread", async () => {
    const user = userEvent.setup();
    const olderPage = deferred<unknown>();
    resumeImpl = () => ({ thread: { ...THREAD_A, turns: [] } });
    threadTurnsListImpl = (params) => params.cursor
      ? olderPage.promise
      : { data: [], nextCursor: "older-a", backwardsCursor: null };
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => expect(useTaskStore.getState().tasks[THREAD_A.id]?.history.nextCursor).toBe("older-a"));
    await user.click(await screen.findByRole("button", { name: "Load earlier messages" }));
    await waitFor(() => expect(useTaskStore.getState().tasks[THREAD_A.id]?.history.loading).toBe(true));
    await user.click(screen.getByRole("button", { name: PROJECT_B.name }));

    await act(async () => {
      olderPage.resolve({ data: [], nextCursor: null, backwardsCursor: null });
      await olderPage.promise;
    });
    await waitFor(() => expect(useTaskStore.getState().tasks[THREAD_A.id]?.history.loading).toBe(false));
  });

  it("recovers a stale local cursor at the first page not already in memory", async () => {
    const user = userEvent.setup();
    const claudeThread: Thread = {
      ...THREAD_A,
      id: "deep-claude-thread",
      name: "Deep Claude thread",
      modelProvider: "claude",
    };
    localStorage.setItem("kiwi.knownThreads", JSON.stringify({ [claudeThread.id]: claudeThread }));
    localStorage.setItem("kiwi.threadProjects", JSON.stringify({ [claudeThread.id]: PROJECT_A.path }));
    const localPage = (id: string, text: string, nextCursor: string | null, generation: number) => ({
      thread: claudeThread,
      messages: [{ id, role: "assistant", text, turnId: id, turnStatus: "completed", timelineOrder: generation }],
      activities: [],
      nextCursor,
      headSeq: 3,
      tailSeq: 4,
      generation,
      byteLen: 1_024,
    });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "local_transcript_page_read" && args?.threadId === claudeThread.id) {
        if (args.cursor === null) {
          const recovering = invokeMock.mock.calls.some(([calledCommand, calledArgs]) => (
            calledCommand === "local_transcript_page_read" && calledArgs?.cursor === "7:1"
          ));
          return localPage("newest", "newest page", recovering ? "8:2" : "7:2", recovering ? 8 : 7);
        }
        if (args.cursor === "7:2") return localPage("middle", "middle page", "7:1", 7);
        if (args.cursor === "7:1") throw new Error("Local transcript cursor is stale");
        if (args.cursor === "8:2") return localPage("middle", "middle page", "8:1", 8);
        if (args.cursor === "8:1") return localPage("oldest", "genuinely older page", null, 8);
      }
      return stubInvoke(command, args);
    });
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Deep Claude thread"));
    await user.click(await screen.findByRole("button", { name: "Load earlier messages" }));
    expect(await screen.findByText("middle page")).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Load earlier messages" }));

    expect(await screen.findByText("genuinely older page")).toBeInTheDocument();
    expect(useTaskStore.getState().tasks[claudeThread.id]?.history).toMatchObject({
      hasMore: false,
      nextCursor: null,
    });
    expect(invokeMock.mock.calls.filter(([command, args]) => (
      command === "local_transcript_page_read" && args?.threadId === claudeThread.id
    )).map(([, args]) => args?.cursor)).toEqual([null, "7:2", "7:1", null, "8:2", "8:1"]);
  });

  it("keeps a local history cursor when live events arrive during first hydration", async () => {
    const user = userEvent.setup();
    const claudeThread: Thread = {
      ...THREAD_A,
      id: "hydration-race-claude",
      name: "Hydration race Claude thread",
      modelProvider: "claude",
    };
    const pendingPage = deferred<unknown>();
    localStorage.setItem("kiwi.knownThreads", JSON.stringify({ [claudeThread.id]: claudeThread }));
    localStorage.setItem("kiwi.threadProjects", JSON.stringify({ [claudeThread.id]: PROJECT_A.path }));
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "local_transcript_page_read" && args?.threadId === claudeThread.id) return pendingPage.promise;
      return stubInvoke(command, args);
    });
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Hydration race Claude thread"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("local_transcript_page_read", expect.objectContaining({
      threadId: claudeThread.id,
    })));
    act(() => {
      useTaskStore.getState().appendUserMessage(claudeThread.id, { id: "live", role: "user", text: "arrived while loading" });
    });
    await act(async () => {
      pendingPage.resolve({
        thread: claudeThread,
        messages: [{ id: "disk", role: "assistant", text: "durable page", turnId: "disk-turn", turnStatus: "completed", timelineOrder: 1 }],
        activities: [],
        nextCursor: "5:1",
        headSeq: 2,
        tailSeq: 3,
        generation: 5,
        byteLen: 1_024,
      });
      await pendingPage.promise;
    });

    expect(useTaskStore.getState().tasks[claudeThread.id]).toMatchObject({
      history: { paginated: true, hasMore: true, nextCursor: "5:1" },
      messages: [expect.objectContaining({ id: "live" })],
    });
    expect(await screen.findByRole("button", { name: "Load earlier messages" })).toBeInTheDocument();
  });

  it("recovers a sealed pending local prompt before exposing older pages", async () => {
    const user = userEvent.setup();
    const claudeThread: Thread = {
      ...THREAD_A,
      id: "pending-recovery-claude",
      name: "Pending recovery Claude thread",
      modelProvider: "claude",
    };
    const pending = { id: "local-pending", role: "user", text: "starting prompt", timelineOrder: 2 };
    localStorage.setItem("kiwi.knownThreads", JSON.stringify({ [claudeThread.id]: claudeThread }));
    localStorage.setItem("kiwi.threadProjects", JSON.stringify({ [claudeThread.id]: PROJECT_A.path }));
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "local_transcript_page_read" && args?.threadId === claudeThread.id) return {
        thread: claudeThread, messages: [pending], activities: [], nextCursor: "5:1",
        headSeq: 2, tailSeq: 3, generation: 5, byteLen: 1_024,
      };
      if (command === "local_transcript_full_read" && args?.threadId === claudeThread.id) return {
        thread: claudeThread,
        messages: [{ id: "disk", role: "assistant", text: "older durable page", turnId: "old-turn", turnStatus: "completed", timelineOrder: 1 }, pending],
        activities: [],
      };
      return stubInvoke(command, args);
    });
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Pending recovery Claude thread"));
    expect(await screen.findByText("older durable page")).toBeInTheDocument();
    expect(useTaskStore.getState().tasks[claudeThread.id]).toMatchObject({
      history: { paginated: true, hasMore: false, nextCursor: null },
      messages: [expect.objectContaining({ id: "disk" }), expect.objectContaining({ id: "local-pending" })],
    });
    expect(invokeMock).toHaveBeenCalledWith("local_transcript_full_read", { provider: "claude", threadId: claudeThread.id });
    expect(screen.queryByRole("button", { name: "Load earlier messages" })).not.toBeInTheDocument();
  });

  it("rejects an older page whose cursor was replaced by a same-thread rehydrate", async () => {
    const user = userEvent.setup();
    const stalePage = deferred<unknown>();
    let initialPageCount = 0;
    resumeImpl = () => ({ thread: { ...THREAD_A, turns: [] } });
    threadTurnsListImpl = (params) => params.cursor
      ? stalePage.promise
      : {
          data: [],
          nextCursor: initialPageCount++ === 0 ? "cursor-before-refresh" : "cursor-after-refresh",
          backwardsCursor: null,
        };
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    const threadRow = await screen.findByText("Alpha thread");
    await user.click(threadRow);
    await waitFor(() => expect(useTaskStore.getState().tasks[THREAD_A.id]?.history.nextCursor).toBe("cursor-before-refresh"));
    await user.click(await screen.findByRole("button", { name: "Load earlier messages" }));
    await waitFor(() => expect(useTaskStore.getState().tasks[THREAD_A.id]?.history.loading).toBe(true));
    await user.click(threadRow);
    await waitFor(() => expect(useTaskStore.getState().tasks[THREAD_A.id]?.history.nextCursor).toBe("cursor-after-refresh"));

    await act(async () => {
      stalePage.resolve({
        data: [{
          id: "stale-old-turn",
          status: "completed",
          items: [{ id: "stale-old-message", type: "userMessage", content: [{ type: "text", text: "must not appear" }] }],
        }],
        nextCursor: "stale-next",
        backwardsCursor: null,
      });
      await stalePage.promise;
    });

    const task = useTaskStore.getState().tasks[THREAD_A.id];
    expect(task.history.nextCursor).toBe("cursor-after-refresh");
    expect(task.messages.some((message) => message.id === "stale-old-message")).toBe(false);
  });

  it("falls back for a malformed older page without disabling pagination globally", async () => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({
      thread: { ...(params.threadId === THREAD_B.id ? THREAD_B : THREAD_A), turns: [] },
    });
    threadTurnsListImpl = (params) => params.cursor
      ? {
          data: [{ id: "malformed-turn", status: "completed", items: null }],
          nextCursor: null,
          backwardsCursor: null,
        }
      : { data: [], nextCursor: `older-${String(params.threadId)}`, backwardsCursor: null };
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Alpha thread"));
    await user.click(await screen.findByRole("button", { name: "Load earlier messages" }));
    await waitFor(() => expect(useTaskStore.getState().tasks[THREAD_A.id]?.history.paginated).toBe(false));
    expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({
      method: "thread/read",
      params: { threadId: THREAD_A.id, includeTurns: true },
    }));

    await user.click(await screen.findByText("Beta thread"));
    await waitFor(() => expect(useTaskStore.getState().tasks[THREAD_B.id]?.history).toMatchObject({
      paginated: true,
      nextCursor: `older-${THREAD_B.id}`,
    }));
  });

  it("falls back with a read instead of resuming twice when turn summaries are unsupported", async () => {
    const user = userEvent.setup();
    let resumeCalls = 0;
    resumeImpl = () => {
      resumeCalls += 1;
      return { thread: { ...THREAD_A, turns: [] } };
    };
    threadTurnsListImpl = () => {
      throw new Error("unknown field `itemsView`");
    };
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => expect(useTaskStore.getState().tasks[THREAD_A.id]?.history.paginated).toBe(false));
    expect(resumeCalls).toBe(1);
    expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({
      method: "thread/read",
      params: { threadId: THREAD_A.id, includeTurns: true },
    }));
  });

  it("does not disable pagination after an unrelated unsupported resume error", async () => {
    const user = userEvent.setup();
    let resumeCalls = 0;
    resumeImpl = () => {
      resumeCalls += 1;
      if (resumeCalls === 1) throw new Error("unsupported model selection");
      return { thread: { ...THREAD_A, turns: [] } };
    };
    threadTurnsListImpl = () => ({ data: [], nextCursor: "older-after-retry", backwardsCursor: null });
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    const threadRow = await screen.findByText("Alpha thread");
    await user.click(threadRow);
    await screen.findByText("unsupported model selection");
    await user.click(threadRow);
    await waitFor(() => expect(useTaskStore.getState().tasks[THREAD_A.id]?.history).toMatchObject({
      paginated: true,
      nextCursor: "older-after-retry",
    }));
    expect(resumeCalls).toBe(2);
  });

  it("does not mark an idle thread as running/steering while another thread's start is in flight", async () => {
    const user = userEvent.setup();
    // Thread A's turn/start never resolves; any other thread starts normally.
    turnStartImpl = (params) =>
      params.threadId === THREAD_A.id
        ? new Promise(() => undefined)
        : { turn: { id: `turn-${String(params.threadId)}` } };
    resumeImpl = (params) => ({
      thread: { ...(params.threadId === THREAD_B.id ? THREAD_B : THREAD_A), turns: [] },
    });
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    // Prime both durable threads before one becomes busy. This mirrors a user
    // revisiting established conversations and keeps this test focused on
    // per-thread run state rather than the one-time capability migration.
    await user.click(await screen.findByText("Beta thread"));
    await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe(THREAD_B.id));

    // Open thread A and send — its turn/start stays in flight.
    await user.click(await screen.findByText("Alpha thread"));
    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);
    await user.type(composer, "start something in alpha{Enter}");
    await waitFor(() => {
      expect(useTaskStore.getState().statuses[THREAD_A.id]).toBe("starting");
    });
    const checkpointCall = invokeMock.mock.calls.findIndex(
      ([command]) => command === "checkpoint_create",
    );
    const turnStartCall = invokeMock.mock.calls.findIndex(
      ([command, args]) => command === "codex_rpc" && args?.method === "turn/start",
    );
    expect(checkpointCall).toBeGreaterThanOrEqual(0);
    expect(turnStartCall).toBeGreaterThan(checkpointCall);
    expect(screen.getByText("Enter queues")).toBeInTheDocument();

    // Navigate to idle thread B while A's start is still pending.
    await user.click(screen.getByText("Beta thread"));
    await waitFor(() => {
      expect(useTaskStore.getState().activeThreadId).toBe(THREAD_B.id);
    });

    // B must not present as running or queueing just because A is starting.
    expect(screen.queryByText("Enter queues")).not.toBeInTheDocument();
    const idleComposer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);
    expect(idleComposer).not.toHaveAttribute("placeholder", "Queue a follow-up for after this run…");

    // A send from B must start a new turn for B — never steer.
    await user.type(idleComposer, "hello from beta{Enter}");
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some(
          ([command, args]) =>
            command === "codex_rpc"
            && args?.method === "turn/start"
            && (args?.params as Record<string, unknown>)?.threadId === THREAD_B.id,
        ),
      ).toBe(true);
    });
    expect(
      invokeMock.mock.calls.some(([command, args]) => command === "codex_rpc" && args?.method === "turn/steer"),
    ).toBe(false);
    // Thread A is still starting, untouched by any of this.
    expect(useTaskStore.getState().statuses[THREAD_A.id]).toBe("starting");
  });

  it("keeps steering available while final output is arriving", async () => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe(THREAD_A.id));

    act(() => {
      const store = useTaskStore.getState();
      store.setActiveTurn(THREAD_A.id, "turn-final");
      store.setTaskStatus(THREAD_A.id, "running");
      // Do not flush: the steering lock must beat the frame-batched text.
      store.queueAssistantDelta(THREAD_A.id, "answer", "Finishing the response");
    });

    expect(await screen.findByText("Enter queues")).toBeInTheDocument();

    const composer = screen.getByPlaceholderText(/Queue a follow-up for after this run/);
    await user.type(composer, "change direction now");
    expect(screen.getByRole("button", { name: "Steer" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Steer" }));
    await waitFor(() => {
      expect(useTaskStore.getState().tasks[THREAD_A.id]?.messages).toContainEqual(
        expect.objectContaining({ text: "change direction now", steerStatus: "accepted", turnId: "turn-final" }),
      );
    });
    expect(invokeMock.mock.calls).toContainEqual(["codex_rpc", expect.objectContaining({
      method: "turn/steer",
      params: expect.objectContaining({ threadId: THREAD_A.id, expectedTurnId: "turn-final" }),
    })]);
    expect(await screen.findByText("Steer accepted by active turn")).toBeInTheDocument();
  });

  it("still opens the selected thread when no workspace switch happens", async () => {
    const user = userEvent.setup();
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Alpha thread"));
    await act(async () => {
      pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } as Thread });
      await pendingResume.promise;
    });

    await waitFor(() => {
      expect(useTaskStore.getState().activeThreadId).toBe(THREAD_A.id);
    });
  });

  it("completes performance diagnostics for an empty thread", async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await act(async () => {
      pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } as Thread });
      await pendingResume.promise;
    });

    await waitFor(() => {
      expect(invokeMock.mock.calls).toContainEqual([
        "audit_append",
        expect.objectContaining({
          kind: "performance.threadOpen",
          payload: expect.objectContaining({
            outcome: "completed",
            render: expect.objectContaining({ rows: 0 }),
          }),
        }),
      ]);
    });
  });

  it("restores each thread's remembered reasoning level when switching conversations", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.threadReasoning", JSON.stringify({
      [THREAD_A.id]: { reasoningEffort: "low", ultra: false },
      [THREAD_B.id]: { reasoningEffort: "high", ultra: false },
    }));
    resumeImpl = (params) => ({
      thread: {
        ...(String(params.threadId) === THREAD_B.id ? THREAD_B : THREAD_A),
        id: String(params.threadId),
        turns: [],
      },
    });
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => expect(screen.getByRole("slider", { name: "Reasoning effort" })).toHaveValue("0"));

    await user.click(await screen.findByText("Beta thread"));
    await waitFor(() => expect(screen.getByRole("slider", { name: "Reasoning effort" })).toHaveValue("2"));

    fireEvent.change(screen.getByRole("slider", { name: "Reasoning effort" }), { target: { value: "3" } });
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem("kiwi.threadReasoning") ?? "{}")[THREAD_B.id])
        .toEqual({ reasoningEffort: "xhigh", ultra: false });
    });
    await user.click(screen.getByText("Alpha thread"));
    await waitFor(() => expect(screen.getByRole("slider", { name: "Reasoning effort" })).toHaveValue("0"));
    await user.click(screen.getByText("Beta thread"));
    await waitFor(() => expect(screen.getByRole("slider", { name: "Reasoning effort" })).toHaveValue("3"));
  });

  it("explains that a reasoning change during a run applies to the next prompt", async () => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({
      thread: { ...THREAD_A, id: String(params.threadId), turns: [] },
    });
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe(THREAD_A.id));
    expect(screen.queryByText("Reasoning change will apply to the next prompt.")).not.toBeInTheDocument();

    act(() => useTaskStore.getState().setTaskStatus(THREAD_A.id, "running"));
    fireEvent.change(screen.getByRole("slider", { name: "Reasoning effort" }), { target: { value: "3" } });

    expect(await screen.findByText("Reasoning change will apply to the next prompt.")).toBeInTheDocument();

    act(() => useTaskStore.getState().setTaskStatus(THREAD_A.id, "idle"));
    await waitFor(() => {
      expect(screen.queryByText("Reasoning change will apply to the next prompt.")).not.toBeInTheDocument();
    });
  });

  it("recovers safely from malformed and legacy Ultra reasoning storage", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.settings", JSON.stringify({ reasoningEffort: "not-a-level", ultra: true }));
    localStorage.setItem("kiwi.threadReasoning", JSON.stringify({
      [THREAD_A.id]: null,
      [THREAD_B.id]: { reasoningEffort: "ultra", ultra: true },
      broken: { reasoningEffort: 42, ultra: true },
    }));
    resumeImpl = (params) => ({
      thread: {
        ...(String(params.threadId) === THREAD_B.id ? THREAD_B : THREAD_A),
        id: String(params.threadId),
        turns: [],
      },
    });
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => expect(screen.getByRole("slider", { name: "Reasoning effort" })).toHaveValue("1"));
    expect(screen.queryByRole("switch", { name: /Ultra/i })).not.toBeInTheDocument();

    await user.click(await screen.findByText("Beta thread"));
    await waitFor(() => expect(screen.getByRole("slider", { name: "Reasoning effort" })).toHaveValue("4"));
  });

  it("defaults safely when the entire saved reasoning map is null", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.threadReasoning", "null");
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => expect(screen.getByRole("slider", { name: "Reasoning effort" })).toHaveValue("1"));
  });

  it("keeps the source task when the handoff formatter cannot load", async () => {
    vi.doMock("./lib/providerHandoffPrompt", () => { throw new Error("Handoff formatter unavailable"); });
    try {
      const user = userEvent.setup();
      await renderApp();
      const { useTaskStore } = await import("./lib/taskStore");
      await user.click(await screen.findByText("Alpha thread"));
      await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe(THREAD_A.id));
      await user.click(screen.getByRole("button", { name: "Thread provider: OpenAI" }));
      await user.click(screen.getByRole("menuitemradio", { name: /Hand off to Claude/ }));
      expect(await screen.findByText(/Handoff formatter unavailable|error when mocking a module/i)).toBeInTheDocument();
      expect(useTaskStore.getState().activeThreadId).toBe(THREAD_A.id);
      expect(JSON.parse(localStorage.getItem("kiwi.pendingHandoff") ?? "null")).toBeNull();
    } finally { vi.doUnmock("./lib/providerHandoffPrompt"); }
  });

  it("does not replace a newly selected task when a handoff formatter loads late", async () => {
    let resolveFormatter!: (module: { buildProviderHandoffPrompt: () => string }) => void;
    vi.doMock("./lib/providerHandoffPrompt", () => new Promise((resolve) => { resolveFormatter = resolve; }));
    try {
      const user = userEvent.setup();
      resumeImpl = (params) => ({ thread: { ...(params.threadId === THREAD_B.id ? THREAD_B : THREAD_A), turns: [] } });
      await renderApp();
      const { useTaskStore } = await import("./lib/taskStore");
      await user.click(await screen.findByText("Alpha thread"));
      await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe(THREAD_A.id));
      await user.click(screen.getByRole("button", { name: "Thread provider: OpenAI" }));
      await user.click(screen.getByRole("menuitemradio", { name: /Hand off to Claude/ }));
      await waitFor(() => expect(resolveFormatter).toBeTypeOf("function"));
      await user.click(screen.getByText("Beta thread"));
      await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe(THREAD_B.id));
      await act(async () => { resolveFormatter({ buildProviderHandoffPrompt: () => "Stale handoff" }); });
      expect(useTaskStore.getState().activeThreadId).toBe(THREAD_B.id);
      expect(JSON.parse(localStorage.getItem("kiwi.pendingHandoff") ?? "null")).toBeNull();
    } finally { vi.doUnmock("./lib/providerHandoffPrompt"); }
  });

  it("creates an editable provider handoff draft without changing the source thread", async () => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => {
      expect(useTaskStore.getState().activeThreadId).toBe(THREAD_A.id);
    });
    act(() => {
      useTaskStore.getState().appendUserMessage(THREAD_A.id, {
        id: "handoff-goal",
        role: "user",
        text: "Preserve the current API and finish the queue UI.",
      });
    });

    await user.click(screen.getByRole("button", { name: "Thread provider: OpenAI" }));
    await user.click(screen.getByRole("menuitemradio", { name: /Hand off to Claude/ }));

    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in Alpha/);
    await waitFor(() => {
      expect((composer as HTMLTextAreaElement).value).toContain("Continue “Alpha thread”");
    });
    expect((composer as HTMLTextAreaElement).value).toContain("Preserve the current API and finish the queue UI.");
    expect(screen.getByText(/review the visible context below/)).toBeInTheDocument();
    expect(useTaskStore.getState().activeThreadId).toBeNull();
    expect(screen.getByText("Alpha thread")).toBeInTheDocument();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/^Hand off the current thread to Claude\?/));
    expect(window.confirm).not.toHaveBeenCalledWith(expect.stringContaining("Alpha thread"));
    expect(window.confirm).not.toHaveBeenCalledWith(expect.stringContaining("Preserve the current API"));
    expect(JSON.parse(localStorage.getItem("kiwi.pendingHandoff") ?? "null")).toMatchObject({
      sourceThreadId: THREAD_A.id,
      targetProvider: "claude",
      workspacePath: PROJECT_A.path,
    });

    // Abandoning the handoff must clear its persisted new-thread draft so it
    // cannot reappear later without the target-provider/provenance state.
    await user.click(screen.getByText("Alpha thread"));
    await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe(THREAD_A.id));
    await user.click(screen.getByRole("button", { name: /New thread/ }));
    expect(await screen.findByPlaceholderText(/Ask Mythra Code to work in Alpha/)).toHaveValue("");
    expect(JSON.parse(localStorage.getItem("kiwi.pendingHandoff") ?? "null")).toBeNull();
  });

  it("restores an unfinished provider handoff with its destination after restart", async () => {
    localStorage.setItem("kiwi.pendingHandoff", JSON.stringify({
      sourceThreadId: THREAD_A.id,
      sourceTitle: "Alpha thread",
      sourceProvider: "openai",
      sourceModel: "gpt-5.6-sol",
      workspacePath: PROJECT_A.path,
      targetProvider: "claude",
      createdAt: 1,
    }));
    localStorage.setItem("kiwi.drafts", JSON.stringify({
      [`new:${PROJECT_A.path}`]: "Continue the restored handoff.",
    }));

    await renderApp();

    expect(await screen.findByText("Provider handoff ready")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "New thread provider: Claude" })).toBeInTheDocument();
    expect(await screen.findByPlaceholderText(/Ask Mythra Code to work in Alpha/)).toHaveValue("Continue the restored handoff.");
  });

  it("refuses a provider handoff while the source thread owns an isolated worktree", async () => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    localStorage.setItem("kiwi.threadWorktrees", JSON.stringify({
      [THREAD_A.id]: {
        threadId: THREAD_A.id,
        projectId: PROJECT_A.id,
        projectPath: PROJECT_A.path,
        path: "/managed/worktrees/alpha",
        branch: "kiwi/alpha",
        baseCommit: "head",
        gitDir: "/projects/alpha/.git",
        createdAt: 1,
        status: "active",
      },
    }));
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => {
      expect(useTaskStore.getState().activeThreadId).toBe(THREAD_A.id);
    });

    await user.click(screen.getByRole("button", { name: "Thread provider: OpenAI" }));
    await user.click(screen.getByRole("menuitemradio", { name: /Hand off to Claude/ }));

    // The handed-off copy would run in the shared project folder, so the
    // isolated conversation must be resolved before it can be handed off.
    expect(await screen.findByText(/owns an isolated worktree/)).toBeInTheDocument();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(useTaskStore.getState().activeThreadId).toBe(THREAD_A.id);
  });

  it("does not copy worktree changes if an agent starts during confirmation", async () => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    localStorage.setItem("kiwi.studioTab", JSON.stringify("worktrees"));
    localStorage.setItem("kiwi.threadWorktrees", JSON.stringify({
      [THREAD_A.id]: {
        threadId: THREAD_A.id, projectId: PROJECT_A.id, projectPath: PROJECT_A.path,
        path: "/managed/worktrees/alpha", branch: "kiwi/alpha", baseCommit: "head",
        gitDir: "/projects/alpha/.git", createdAt: 1, status: "active",
      },
    }));
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");
    await user.click(await screen.findByText("Alpha thread"));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    const copy = await screen.findByRole("button", { name: "Copy changes to project" });
    vi.mocked(window.confirm).mockImplementation(() => {
      useTaskStore.getState().setTaskStatus(THREAD_A.id, "running");
      return true;
    });
    const callsBefore = invokeMock.mock.calls.length;
    await user.click(copy);
    expect(await screen.findByText(/workspace became busy/i)).toBeInTheDocument();
    expect(invokeMock.mock.calls.slice(callsBefore).some(([command]) =>
      command === "worktree_apply_to_source" || command === "checkpoint_create",
    )).toBe(false);
  });

  it("starts an isolated thread in its worktree while keeping it grouped under the project", async () => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    await renderApp();

    await user.click(await screen.findByRole("button", { name: /Isolated worktree/i }));
    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);
    await user.type(composer, "build this in isolation{Enter}");

    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some(
          ([command, args]) =>
            command === "codex_rpc"
            && args?.method === "thread/start"
            && (args?.params as Record<string, unknown>)?.cwd === "/managed/worktrees/isolated-thread",
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some(
          ([command, args]) =>
            command === "checkpoint_create"
            && args?.cwd === "/managed/worktrees/isolated-thread",
        ),
      ).toBe(true);
    });
    const storedBindings = JSON.parse(localStorage.getItem("kiwi.threadProjects") ?? "{}") as Record<string, string>;
    expect(Object.values(storedBindings)).toContain(PROJECT_A.path);
    const storedWorktrees = JSON.parse(localStorage.getItem("kiwi.threadWorktrees") ?? "{}") as Record<string, { path: string; projectPath: string }>;
    expect(Object.values(storedWorktrees)).toContainEqual(expect.objectContaining({
      path: "/managed/worktrees/isolated-thread",
      projectPath: PROJECT_A.path,
    }));
  });

  it("resumes an isolated thread with its execution cwd and shared Git metadata root", async () => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    localStorage.setItem("kiwi.threadWorktrees", JSON.stringify({
      [THREAD_A.id]: {
        threadId: THREAD_A.id,
        projectId: PROJECT_A.id,
        projectPath: PROJECT_A.path,
        path: "/managed/worktrees/thread-a",
        branch: "openkiwi/thread-a",
        baseCommit: "head",
        gitDir: "/projects/alpha/.git",
        createdAt: Date.now(),
        status: "active",
      },
    }));
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some(
          ([command, args]) => {
            if (command !== "codex_rpc" || args?.method !== "thread/resume") return false;
            const params = args.params as Record<string, unknown>;
            const roots = params.runtimeWorkspaceRoots as string[] | undefined;
            return params.cwd === "/managed/worktrees/thread-a"
              && roots?.includes("/projects/alpha/.git");
          },
        ),
      ).toBe(true);
    });
  });

  it("loads a missing isolated transcript read-only and blocks model sends", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.threadWorktrees", JSON.stringify({
      [THREAD_A.id]: {
        threadId: THREAD_A.id,
        projectId: PROJECT_A.id,
        projectPath: PROJECT_A.path,
        path: "/managed/worktrees/missing-thread-a",
        branch: "openkiwi/thread-a",
        baseCommit: "head",
        gitDir: "/projects/alpha/.git",
        createdAt: Date.now(),
        status: "missing",
      },
    }));
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some(
          ([command, args]) => command === "codex_rpc" && args?.method === "thread/read",
        ),
      ).toBe(true);
    });
    const turnsBefore = invokeMock.mock.calls.filter(
      ([command, args]) => command === "codex_rpc" && args?.method === "turn/start",
    ).length;
    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);
    await user.type(composer, "do not run this{Enter}");
    expect(
      invokeMock.mock.calls.filter(
        ([command, args]) => command === "codex_rpc" && args?.method === "turn/start",
      ),
    ).toHaveLength(turnsBefore);
    expect(await screen.findByText(/isolated worktree is unavailable/i)).toBeInTheDocument();
  });
});

describe("composer sub-agent command center", () => {
  beforeEach(() => {
    // These flows select Claude; signed-out selection is covered separately.
    claudeRuntimeStatusImpl = () => ({ available: true, path: "/usr/bin/claude", version: "99.0.0", loggedIn: true, authMethod: "subscription", email: null, subscriptionType: "pro", warning: null });
  });

  async function openCrew(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: /^Sub-agents(?: off|:| \d+\/)/ }));
    return screen.getByRole("dialog", { name: "Sub-agent command center" });
  }

  /** Params of every app-server call made with one JSON-RPC method. */
  function codexCalls(method: string): Record<string, unknown>[] {
    return invokeMock.mock.calls
      .filter(([command, args]) => command === "codex_rpc" && args?.method === method)
      .map(([, args]) => (args?.params ?? {}) as Record<string, unknown>);
  }

  /** The sub-agent policy a project actually persisted for its own threads. */
  function projectSubagents(projectId: string): unknown {
    const stored = JSON.parse(localStorage.getItem("kiwi.projects") ?? "[]") as Array<{
      id: string;
      overrides?: { subagents?: unknown };
    }>;
    return stored.find((project) => project.id === projectId)?.overrides?.subagents;
  }

  it("starts each new thread off despite enabled defaults and preserves an existing opt-in", async () => {
    const user = userEvent.setup();
    const configured = { subagentsEnabled: true, subagentMax: 2, childAgents: { enabled: true, targets: [{ id: "claude", provider: "claude", model: "claude-fable-5", label: "Reviewer", description: "", enabled: true }] } };
    localStorage.setItem("kiwi.settings", JSON.stringify(configured));
    await renderApp();
    await openCrew(user);
    expect(screen.getByRole("switch", { name: "Allow sub-agent spawning" })).not.toBeChecked();
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Allow sub-agent spawning" }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /^New threadCtrl/ }));
    await openCrew(user);
    expect(screen.getByRole("switch", { name: "Allow sub-agent spawning" })).not.toBeChecked();
    await user.keyboard("{Escape}");
    pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } });
    await user.click(await screen.findByText("Alpha thread"));
    await openCrew(user);
    expect(screen.getByRole("switch", { name: "Allow sub-agent spawning" })).toBeChecked();
    expect(JSON.parse(localStorage.getItem("kiwi.settings") ?? "{}")).toMatchObject(configured);
    expect(projectSubagents(PROJECT_A.id)).toBeUndefined();
  });

  it.each([false, true])("persists a newly created thread's explicit spawning choice %s across navigation", async (optIn) => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.settings", JSON.stringify({ subagentsEnabled: true, childAgents: { enabled: true, targets: [{ id: "reviewer", provider: "openai", model: "gpt-5.6-terra", label: "Reviewer", enabled: true }] } }));
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    await renderApp();
    if (optIn) {
      await openCrew(user);
      await user.click(screen.getByRole("switch", { name: "Allow sub-agent spawning" }));
      await user.keyboard("{Escape}");
    }
    await user.type(await screen.findByPlaceholderText(/Ask Mythra Code to work in/), "save this choice{Enter}");
    await waitFor(() => expect(codexCalls("turn/start").at(-1)).toMatchObject({ threadId: "isolated-thread" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("kiwi.threadSubagentSettings") ?? "{}")["isolated-thread"]).toBe(optIn));
    const sessions = invokeMock.mock.calls.filter(([command]) => command === "child_agent_session_start");
    expect(sessions.some(([, args]) => Array.isArray((args?.options as { targets?: unknown[] } | undefined)?.targets) && ((args?.options as { targets: unknown[] }).targets.length > 0))).toBe(optIn);
    await user.click(screen.getByRole("button", { name: /^New threadCtrl/ }));
    await openCrew(user);
    expect(screen.getByRole("switch", { name: "Allow sub-agent spawning" })).not.toBeChecked();
    await user.keyboard("{Escape}");
    // The newly created row carries its active task in this harness, while
    // the legacy row with the same label has never been started.
    await user.click(screen.getAllByRole("button", { name: "Open Alpha thread" }).find((row) => row.classList.contains("live"))!);
    await openCrew(user);
    expect(screen.getByRole("switch", { name: "Allow sub-agent spawning" }).getAttribute("aria-checked")).toBe(String(optIn));
  });

  it("saves a project's configured roster while keeping its new-thread opt-in local", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));

    await openCrew(user);
    expect(screen.getByText("Editing this new thread")).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Allow sub-agent spawning" }));
    await user.click(screen.getByRole("button", { name: "Add Claude sub-agent" }));

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("kiwi.projects") ?? "[]") as Array<{
        id: string;
        overrides?: { subagents?: { enabled: boolean; maxConcurrent: number } };
      }>;
      expect(stored.find((project) => project.id === PROJECT_A.id)?.overrides?.subagents)
        .toMatchObject({ enabled: false, maxConcurrent: 1, childAgents: { targets: [expect.objectContaining({ id: "claude" })] } });
      // The sibling project keeps inheriting the global defaults.
      expect(stored.find((project) => project.id === PROJECT_B.id)?.overrides).toBeUndefined();
    });
    expect(JSON.parse(localStorage.getItem("kiwi.settings") ?? "{}").subagentsEnabled ?? false).toBe(false);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /^New threadCtrl/ }));
    await openCrew(user);
    expect(screen.getByRole("switch", { name: "Allow sub-agent spawning" })).not.toBeChecked();
    expect(within(screen.getByRole("dialog", { name: "Sub-agent command center" })).getAllByText("Claude").length).toBeGreaterThan(0);
  });

  it("writes edits made in Chats to the global defaults", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: /Chats/ }));

    await openCrew(user);
    expect(screen.getByText("Editing this new thread")).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Allow sub-agent spawning" }));
    await user.click(screen.getByRole("button", { name: "More concurrent sub-agents" }));
    await user.click(screen.getByRole("button", { name: "Add Claude sub-agent" }));

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("kiwi.settings") ?? "{}");
      expect(stored.subagentsEnabled ?? false).toBe(false);
      expect(stored.subagentMax).toBe(1);
      expect(stored.childAgents).toMatchObject({
        enabled: true,
        targets: [expect.objectContaining({ id: "claude", provider: "claude" })],
      });
    });
    const stored = JSON.parse(localStorage.getItem("kiwi.projects") ?? "[]") as Array<{ overrides?: unknown }>;
    expect(stored.every((project) => project.overrides === undefined)).toBe(true);
  });

  it("lets a conversation already in progress configure sub-agents for its next turn", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.settings", JSON.stringify({ subagentsEnabled: false, subagentMax: 5 }));
    await renderApp();
    pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } });
    await user.click(await screen.findByText("Alpha thread"));

    const control = await screen.findByRole("button", { name: /^Sub-agents(?: off|:| \d+\/)/ });
    expect(control).toBeEnabled();
    await openCrew(user);

    // Nothing was frozen because this thread has never run with a
    // cross-provider roster available.
    expect(screen.queryByText(/froze its destinations/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Allow sub-agent spawning" }));
    await user.click(screen.getByRole("button", { name: "Add Claude sub-agent" }));

    // The crew remains reusable in this project; spawning is opted into only
    // for the open conversation.
    await waitFor(() => {
      expect(projectSubagents(PROJECT_A.id)).toMatchObject({
        enabled: false,
        childAgents: {
          enabled: true,
          targets: [expect.objectContaining({ id: "claude", provider: "claude" })],
        },
      });
      expect(JSON.parse(localStorage.getItem("kiwi.threadSubagentSettings") ?? "{}")[THREAD_A.id]).toBe(true);
    });
  });

  it("stages idle captured-crew edits on the thread without rewriting defaults", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.settings", JSON.stringify({
      subagentsEnabled: true,
      subagentMax: 5,
      childAgents: { enabled: true, targets: [{ id: "cursor", provider: "cursor", model: "auto", label: "Cursor", description: "", enabled: true }] },
    }));
    localStorage.setItem("kiwi.childAgentPolicies", JSON.stringify({
      "session-a": {
        rootThreadId: THREAD_A.id,
        maxConcurrent: 2,
        permission: "ask",
        systemPrompt: "",
        projectInstructionsEnabled: false,
        reasoningEffort: "medium",
        serviceTier: null,
        targets: [{ id: "frozen", provider: "claude", model: "claude-fable-5", label: "Frozen reviewer", description: "", enabled: true }],
        capturedAt: 1,
      },
    }));
    await renderApp();
    pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } });
    await user.click(await screen.findByText("Alpha thread"));
    const crew = await openCrew(user);

    expect(screen.getByText("Editing this thread")).toBeInTheDocument();
    expect(screen.getByText(/Sub-agent and limit changes stay in this thread/)).toBeInTheDocument();
    expect(within(crew).getByText("Frozen reviewer")).toBeInTheDocument();
    // The destination configured since is not one this thread may reach.
    expect(within(crew).queryByText("Cursor")).not.toBeInTheDocument();
    await user.click(within(crew).getByRole("button", { name: "Add OpenAI sub-agent" }));

    await waitFor(() => {
      const policies = JSON.parse(localStorage.getItem("kiwi.childAgentPolicies") ?? "{}");
      expect(policies["session-a"].pendingRecapture).toMatchObject({
        targets: [
          expect.objectContaining({ id: "frozen", provider: "claude" }),
          expect.objectContaining({ id: "openai", provider: "openai" }),
        ],
      });
    });
    // This edit belongs to THREAD_A only. New chats and other project threads
    // continue to inherit the defaults they had before the click.
    const storedSettings = JSON.parse(localStorage.getItem("kiwi.settings") ?? "{}");
    expect(storedSettings.subagentMax).toBe(5);
    expect(storedSettings.childAgents.targets).toEqual([expect.objectContaining({ id: "cursor" })]);
    expect(projectSubagents(PROJECT_A.id)).toBeUndefined();
  });

  it("clears an idle captured crew without rewriting defaults", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.settings", JSON.stringify({
      subagentsEnabled: true,
      subagentMax: 5,
      childAgents: { enabled: true, targets: [{ id: "cursor", provider: "cursor", model: "auto", label: "Cursor", description: "", enabled: true }] },
    }));
    localStorage.setItem("kiwi.childAgentPolicies", JSON.stringify({
      "session-a": {
        rootThreadId: THREAD_A.id,
        maxConcurrent: 2,
        permission: "ask",
        systemPrompt: "",
        projectInstructionsEnabled: false,
        reasoningEffort: "medium",
        serviceTier: null,
        targets: [{ id: "frozen", provider: "claude", model: "claude-fable-5", label: "Frozen reviewer", description: "", enabled: true }],
        capturedAt: 1,
      },
    }));
    await renderApp();
    pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } });
    await user.click(await screen.findByText("Alpha thread"));
    const crew = await openCrew(user);

    expect(screen.getByText("Editing this thread")).toBeInTheDocument();
    expect(screen.getByText(/Sub-agent and limit changes stay in this thread/)).toBeInTheDocument();
    expect(within(crew).getByText("Frozen reviewer")).toBeInTheDocument();
    // The destination configured since is not one this thread may reach.
    expect(within(crew).queryByText("Cursor")).not.toBeInTheDocument();
    await user.click(within(crew).getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(within(crew).queryByText("Frozen reviewer")).not.toBeInTheDocument());

    await waitFor(() => {
      const policies = JSON.parse(localStorage.getItem("kiwi.childAgentPolicies") ?? "{}");
      expect(policies["session-a"].pendingRecapture).toMatchObject({
        targets: [],
      });
    });
    // This edit belongs to THREAD_A only. New chats and other project threads
    // continue to inherit the defaults they had before the click.
    const storedSettings = JSON.parse(localStorage.getItem("kiwi.settings") ?? "{}");
    expect(storedSettings.subagentMax).toBe(5);
    expect(storedSettings.childAgents.targets).toEqual([expect.objectContaining({ id: "cursor" })]);
    expect(projectSubagents(PROJECT_A.id)).toBeUndefined();
  });

  /**
   * The whole point of the fix, end to end: a conversation that has already
   * been running gets sub-agents switched on, and its very next message runs
   * with them — through a runtime that had the thread loaded without them.
   */
  it("gives a running conversation the sub-agents it just switched on, on its next message", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.settings", JSON.stringify({
      subagentsEnabled: false,
      subagentMax: 5,
      childAgents: {
        enabled: true,
        targets: [{ id: "managed-openai", provider: "openai", model: "gpt-5.6-terra", label: "Managed OpenAI", description: "", enabled: true, reasoningMode: "inherit", reasoningEffort: "medium", reasoningMaxEffort: "high" }],
      },
    }));
    await renderApp();
    pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } });
    await user.click(await screen.findByText("Alpha thread"));

    // Opening the thread loaded it into this app-server with sub-agents off.
    await waitFor(() => {
      expect(codexCalls("thread/resume").at(-1)).toMatchObject({
        threadId: THREAD_A.id,
        config: { features: { multi_agent: false } },
      });
    });
    const restartsAfterOpen = invokeMock.mock.calls.filter(([command]) => command === "restart_runtime").length;

    await openCrew(user);
    await user.click(screen.getByRole("switch", { name: "Allow sub-agent spawning" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(JSON.parse(localStorage.getItem("kiwi.threadSubagentSettings") ?? "{}")[THREAD_A.id]).toBe(true));

    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);
    await user.type(composer, "now split this up{Enter}");

    await waitFor(() => {
      expect(codexCalls("turn/start").at(-1)).toMatchObject({ threadId: THREAD_A.id });
    });
    // Startup-only config is ignored for a thread the app-server already holds,
    // so the switch is only real if the runtime was replaced first.
    expect(invokeMock.mock.calls.filter(([command]) => command === "restart_runtime")).toHaveLength(restartsAfterOpen + 1);
    expect(codexCalls("thread/resume").at(-1)).toMatchObject({
      threadId: THREAD_A.id,
      config: {
        features: { multi_agent: false, multi_agent_v2: false },
        // The user's limit of five rides on the Mythra Code bridge below, never on
        // Codex's own agent runtime, which stays pinned so the bridge remains
        // the only spawning authority.
        agents: { max_threads: 1, max_depth: 1 },
        mcp_servers: { mythra_agents: expect.anything() },
      },
    });
  });

  it("does not disturb the runtime for an ordinary follow-up message", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.settings", JSON.stringify({ subagentsEnabled: true, subagentMax: 5 }));
    await renderApp();
    pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } });
    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => expect(codexCalls("thread/resume")).not.toHaveLength(0));
    expect(codexCalls("thread/resume")[0]).toMatchObject({ excludeTurns: true });
    expect(codexCalls("thread/resume")[0]).not.toHaveProperty("initialTurnsPage");
    expect(codexCalls("thread/turns/list")[0]).toMatchObject({
      threadId: THREAD_A.id,
      limit: 10,
      sortDirection: "desc",
      itemsView: "summary",
    });
    const restartsAfterOpen = invokeMock.mock.calls.filter(([command]) => command === "restart_runtime").length;

    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);
    await user.type(composer, "carry on{Enter}");

    await waitFor(() => {
      expect(codexCalls("turn/start").at(-1)).toMatchObject({ threadId: THREAD_A.id });
    });
    expect(invokeMock.mock.calls.filter(([command]) => command === "restart_runtime")).toHaveLength(restartsAfterOpen);
    expect(codexCalls("thread/resume")).toHaveLength(1);
  });
});

describe("local thread renaming", () => {
  it.each(["claude", "cursor"])("renames an unopened %s thread using metadata only", async (provider) => {
    const user = userEvent.setup();
    const thread = { ...THREAD_A, modelProvider: provider };
    threadListImpl = () => ({ data: [thread], nextCursor: null });
    localStorage.setItem("kiwi.knownThreads", JSON.stringify({ [thread.id]: thread }));
    await renderApp();
    await user.click(await screen.findByRole("button", { name: "Options for Alpha thread" }));
    await user.click(await screen.findByText("Rename"));
    const input = screen.getByRole("textbox", { name: "Thread name" });
    await user.clear(input);
    await user.type(input, "Renamed safely{Enter}");
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("local_transcript_rename", { provider, threadId: thread.id, name: "Renamed safely" }));
    expect(invokeMock.mock.calls.some(([command]) => command === "local_transcript_snapshot_write" || command === "local_transcript_tail_write")).toBe(false);
  });
});

describe("local workflow threads", () => {
  function composerRecipe(provider: "openai" | "claude" = "openai"): WorkflowDefinition {
    return {
      id: "composer-recipe",
      name: "Release review",
      description: "Review a release before shipping",
      projectId: PROJECT_A.id,
      enabled: true,
      trigger: { type: "manual" },
      steps: [{ id: "review", type: "agent", name: "Review", prompt: "Check release readiness.", continueOnError: false }],
      skillNames: [],
      run: scheduleRunSnapshot({ ...DEFAULT_SETTINGS, provider, model: provider === "claude" ? "sonnet" : DEFAULT_SETTINGS.model }),
      createdAt: 1,
      updatedAt: 1,
    };
  }

  it("keeps an explicit Composer recipe and note through canceled review, then sends the note after thread start", async () => {
    const user = userEvent.setup();
    const threadStart = deferred<{ thread: Thread }>();
    localStorage.setItem("kiwi.workflows", JSON.stringify([composerRecipe()]));
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "codex_rpc" && args?.method === "thread/start") return threadStart.promise;
      return stubInvoke(command, args);
    });
    await renderApp();
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);
    await user.type(composer, "!Release");
    await user.click(await screen.findByRole("option", { name: /Release review/ }));
    expect(screen.getByRole("button", { name: "Remove workflow Release review" })).toBeInTheDocument();
    fireEvent.change(composer, { target: { value: "Please inspect the release notes." } });
    await user.click(screen.getByRole("button", { name: "Run workflow Release review" }));
    const firstReview = await screen.findByRole("dialog", { name: "Run Release review" });
    expect(within(firstReview).getByText("Please inspect the release notes.")).toBeInTheDocument();
    await user.click(within(firstReview).getByRole("button", { name: "Cancel" }));
    expect(composer).toHaveValue("Please inspect the release notes.");
    expect(screen.getByRole("button", { name: "Remove workflow Release review" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Run workflow Release review" }));
    const secondReview = await screen.findByRole("dialog", { name: "Run Release review" });
    await user.click(within(secondReview).getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({ method: "thread/start" })));
    expect(composer).toHaveValue("Please inspect the release notes.");
    expect(screen.getByRole("button", { name: "Remove workflow Release review" })).toBeInTheDocument();

    await act(async () => threadStart.resolve({ thread: { ...THREAD_A, id: "isolated-thread", cwd: PROJECT_A.path, turns: [] } }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({
      method: "turn/start",
      params: expect.objectContaining({ input: [expect.objectContaining({ text: expect.stringContaining("Additional instructions for this run:\nPlease inspect the release notes.") })] }),
    })));
    const { draftFor } = await import("./components/Composer");
    await waitFor(() => expect(draftFor(`new:${PROJECT_A.path}`)).toBe(""));
    const { useTaskStore } = await import("./lib/taskStore");
    act(() => useTaskStore.getState().completeTurn("isolated-thread", "turn-isolated-thread", "completed"));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("kiwi.workflowRuns") ?? "[]")[0]).toMatchObject({ status: "completed" }));
  });

  it("retains the Composer recipe and note when workflow preflight fails", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.workflows", JSON.stringify([composerRecipe("claude")]));
    await renderApp();
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);
    await user.type(composer, "!Release");
    await user.click(await screen.findByRole("option", { name: /Release review/ }));
    fireEvent.change(composer, { target: { value: "Please inspect the release notes." } });
    await user.click(screen.getByRole("button", { name: "Run workflow Release review" }));
    const review = await screen.findByRole("dialog", { name: "Run Release review" });
    await user.click(within(review).getByRole("button", { name: "Run now" }));

    expect(await screen.findByText("Set up Claude Code and sign in before running this Claude workflow.")).toBeInTheDocument();
    expect(composer).toHaveValue("Please inspect the release notes.");
    expect(screen.getByRole("button", { name: "Remove workflow Release review" })).toBeInTheDocument();
    expect(invokeMock.mock.calls.some(([command, args]) => command === "codex_rpc" && args?.method === "thread/start")).toBe(false);
  });

  it("opens a manual workflow thread in its project when another project was selected", async () => {
    const user = userEvent.setup();
    const workflow: WorkflowDefinition = {
      id: "workflow-other-project",
      name: "Beta review",
      description: "",
      projectId: PROJECT_B.id,
      enabled: true,
      trigger: { type: "manual" },
      steps: [{ id: "check", type: "command", name: "Check", command: "git status", continueOnError: false }],
      skillNames: [],
      run: scheduleRunSnapshot({ ...DEFAULT_SETTINGS, provider: "claude", model: "sonnet" }),
      createdAt: 1,
      updatedAt: 1,
    };
    localStorage.setItem("kiwi.workflows", JSON.stringify([workflow]));
    claudeRuntimeStatusImpl = () => ({ available: true, path: "/usr/local/bin/claude", version: "99.0.0", loggedIn: true,
      authMethod: "subscription", email: "test@example.com", subscriptionType: "pro", warning: null });
    let stored: { thread: Thread; messages: unknown[]; activities: unknown[] } | null = null;
    const savedThread = () => stored?.thread;
    let generation = 0;
    invokeMock.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === "local_transcript_snapshot_write") {
        stored = args?.value as typeof stored;
        return { generation: ++generation, headSeq: 0, tailSeq: 0, rewrittenChunks: 1, totalChunks: 1, compatibilitySnapshotCreated: false };
      }
      if (name === "local_transcript_page_read" && stored) return { ...stored, nextCursor: null, headSeq: 0, tailSeq: 0, generation, byteLen: 0 };
      return stubInvoke(name, args);
    });

    await renderApp();
    expect(screen.getByRole("button", { name: PROJECT_A.name }).parentElement).toHaveClass("active");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    await user.click(within(settings).getByRole("button", { name: "Workflows" }));
    await user.click(within(settings).getByRole("button", { name: "Run" }));
    await user.click(screen.getByRole("button", { name: "Run now" }));

    const { useTaskStore } = await import("./lib/taskStore");
    await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe(savedThread()?.id));
    expect(savedThread()?.cwd).toBe(PROJECT_B.path);
    expect(screen.queryByText("That thread belongs to a different chat or project and cannot be opened here.")).not.toBeInTheDocument();

    await waitFor(() => expect(JSON.parse(localStorage.getItem("kiwi.workflowRuns") ?? "[]")[0]).toMatchObject({ status: "completed" }));
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBeNull());
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const reopened = await screen.findByRole("dialog", { name: "Settings" });
    await user.click(within(reopened).getByRole("button", { name: "Workflows" }));
    await user.click(within(reopened).getByRole("button", { name: "Last thread" }));
    await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe(savedThread()?.id));
    expect(screen.queryByText("That thread belongs to a different chat or project and cannot be opened here.")).not.toBeInTheDocument();
  });

  it("keeps Composer Stop available during a command step and stops the owning workflow", async () => {
    const user = userEvent.setup();
    const command = deferred<{ exitCode: number; stdout: string; stderr: string }>();
    commandExecImpl = () => command.promise;
    const workflow: WorkflowDefinition = {
      ...composerRecipe(),
      id: "command-recipe",
      name: "Command review",
      steps: [{ id: "command", type: "command", name: "Check", command: "sleep 30", continueOnError: false }],
    };
    localStorage.setItem("kiwi.workflows", JSON.stringify([workflow]));
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Tools workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Run workflow" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Run Command review" })).getByRole("button", { name: "Run now" }));

    const { useTaskStore } = await import("./lib/taskStore");
    await waitFor(() => expect(useTaskStore.getState().workflowOwners["isolated-thread"]).toMatchObject({ workflowId: "command-recipe" }));
    const composer = await screen.findByPlaceholderText(/Queue a follow-up|Ask Mythra Code to work in/);
    fireEvent.change(composer, { target: { value: "follow up after workflow" } });
    await user.click(await screen.findByRole("button", { name: "Queue" }));
    expect(useTaskStore.getState().tasks["isolated-thread"].queuedTurns[0]).toMatchObject({ status: "queued" });

    await user.click(screen.getByRole("button", { name: "Stop the active task and its sub-agents" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({ method: "command/exec/terminate" })));
    await act(async () => command.resolve({ exitCode: 130, stdout: "", stderr: "stopped" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("kiwi.workflowRuns") ?? "[]")[0]).toMatchObject({ status: "interrupted" }));
    expect(useTaskStore.getState().tasks["isolated-thread"].status).toBe("interrupted");
    expect(useTaskStore.getState().tasks["isolated-thread"].queuedTurns[0]).toMatchObject({ status: "queued" });
  });

  it("keeps a renamed Claude workflow thread in the sidebar and durable transcript", async () => {
    const user = userEvent.setup();
    const command = deferred<{ exitCode: number; stdout: string; stderr: string }>();
    const workflow: WorkflowDefinition = {
      id: "workflow-claude",
      name: "Claude review",
      description: "",
      projectId: PROJECT_A.id,
      enabled: true,
      trigger: { type: "manual" },
      steps: [{ id: "check", type: "command", name: "Check", command: "git status", continueOnError: false }],
      skillNames: [],
      run: scheduleRunSnapshot({ ...DEFAULT_SETTINGS, provider: "claude", model: "sonnet" }),
      createdAt: 1,
      updatedAt: 1,
    };
    localStorage.setItem("kiwi.workflows", JSON.stringify([workflow]));
    claudeRuntimeStatusImpl = () => ({ available: true, path: "/usr/local/bin/claude", version: "99.0.0", loggedIn: true,
      authMethod: "subscription", email: "test@example.com", subscriptionType: "pro", warning: null });
    commandExecImpl = () => command.promise;
    let stored: { thread: Thread; messages: unknown[]; activities: unknown[] } | null = null;
    const savedThread = () => stored?.thread;
    let generation = 0;
    invokeMock.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === "local_transcript_snapshot_write") {
        stored = args?.value as typeof stored;
        return { generation: ++generation, headSeq: 0, tailSeq: 0, rewrittenChunks: 1, totalChunks: 1, compatibilitySnapshotCreated: false };
      }
      if (name === "local_transcript_page_read" && stored) return { ...stored, nextCursor: null, headSeq: 0, tailSeq: 0, generation, byteLen: 0 };
      if (name === "local_transcript_tail_write" && stored) {
        const tail = args?.value as { messages: unknown[]; activities: unknown[] };
        stored = { ...stored, messages: [...stored.messages, ...tail.messages], activities: [...stored.activities, ...tail.activities] };
        return { generation, headSeq: 0, tailSeq: stored.messages.length + stored.activities.length };
      }
      if (name === "local_transcript_rename" && stored) {
        stored = { ...stored, thread: { ...stored.thread, name: String(args?.name) } };
        return null;
      }
      return stubInvoke(name, args);
    });

    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Tools workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Run workflow" }));
    const launch = await screen.findByRole("dialog", { name: "Run Claude review" });
    expect(within(launch).getByRole("button", { name: "Run in project" })).toHaveTextContent(PROJECT_A.name);
    expect(savedThread()).toBeUndefined();
    await user.click(within(launch).getByRole("button", { name: "Run now" }));

    const initialTitle = "Workflow: Claude review";
    await user.click(await screen.findByRole("button", { name: `Options for ${initialTitle}` }));
    await user.click(await screen.findByText("Rename"));
    const input = screen.getByRole("textbox", { name: "Thread name" });
    await user.clear(input);
    await user.type(input, "My Claude review{Enter}");
    await waitFor(() => expect(savedThread()?.name).toBe("My Claude review"));

    await act(async () => command.resolve({ exitCode: 0, stdout: "clean", stderr: "" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("kiwi.workflowRuns") ?? "[]")[0]).toMatchObject({ status: "completed" }));
    await waitFor(() => expect(stored?.activities).toContainEqual(expect.objectContaining({ status: "completed" })));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("kiwi.knownThreads") ?? "{}")).toEqual(
      expect.objectContaining({ [savedThread()!.id]: expect.objectContaining({ name: "My Claude review", modelProvider: "claude" }) }),
    ));
    expect(savedThread()?.name).toBe("My Claude review");
    expect(screen.getAllByText("My Claude review").length).toBeGreaterThan(0);
  });
});

describe("workspace attachments", () => {
  function codexCalls(method: string): Record<string, unknown>[] {
    return invokeMock.mock.calls
      .filter(([command, args]) => command === "codex_rpc" && args?.method === method)
      .map(([, args]) => (args?.params ?? {}) as Record<string, unknown>);
  }

  /** The sidebar row, not the header title that repeats the open thread. */
  function threadRow(name: string): HTMLElement {
    const rows = screen.getAllByText(name).filter((node) => node.closest(".thread-row-wrap"));
    return rows[0] ?? screen.getByText(name);
  }

  it("keeps attachment selections inside the thread they were made for", async () => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Files workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "notes.md" }));
    await user.click(await screen.findByRole("button", { name: "Attach notes.md" }));
    expect(await screen.findByRole("button", { name: "Remove attachment notes.md" })).toBeInTheDocument();

    // Switching conversations must not carry the file into the other thread.
    await user.click(threadRow("Beta thread"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove attachment notes.md" })).not.toBeInTheDocument());

    // Returning to the original thread finds the file still chosen for it.
    await user.click(threadRow("Alpha thread"));
    expect(await screen.findByRole("button", { name: "Remove attachment notes.md" })).toBeInTheDocument();
  });

  it("captures all pasted images before clipboard access is sealed", async () => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    let counter = 0;
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "save_pasted_image") return `/app-data/message-images/paste-${++counter}.png`;
      if (command === "persist_image_attachment") return args?.path;
      return stubInvoke(command, args);
    });
    await renderApp();
    await user.click(await screen.findByText("Alpha thread"));
    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);
    let sealed = false;
    const files = [new File(["one"], "one.png", { type: "image/png" }), new File(["two"], "two.png", { type: "image/png" })];
    fireEvent.paste(composer, { clipboardData: { items: files.map((file) => ({ type: file.type, getAsFile: () => sealed ? null : file })) } });
    sealed = true;
    await user.type(composer, "Review both images{Enter}");
    await waitFor(() => expect(codexCalls("turn/start")).toHaveLength(1));
    expect((codexCalls("turn/start")[0].input as Array<{ type: string; path?: string }>).filter((item) => item.type === "localImage").map((item) => item.path)).toEqual([
      "/app-data/message-images/paste-1.png", "/app-data/message-images/paste-2.png",
    ]);
  });

  it("keeps a waiting attachment send out of a newly selected thread", async () => {
    const user = userEvent.setup();
    const pasted = deferred<string>();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "save_pasted_image") return pasted.promise;
      return stubInvoke(command, args);
    });
    await renderApp();
    await user.click(await screen.findByText("Alpha thread"));
    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);
    const file = new File(["image"], "image.png", { type: "image/png" });
    fireEvent.paste(composer, { clipboardData: { items: [{ type: file.type, getAsFile: () => file }] } });
    await user.type(composer, "Keep this in Alpha{Enter}");
    await user.click(threadRow("Beta thread"));
    await act(async () => { pasted.resolve("/app-data/message-images/alpha/image.png"); });
    await waitFor(() => expect(JSON.parse(localStorage.getItem("kiwi.drafts") ?? "{}")[THREAD_A.id]).toContain("Keep this in Alpha"));
    expect(codexCalls("turn/start")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Remove attachment image.png" })).not.toBeInTheDocument();
  });

  it("rejects unsupported pasted image formats before creating an attachment", async () => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    await renderApp();
    await user.click(await screen.findByText("Alpha thread"));
    const file = new File(["heic"], "photo.heic", { type: "image/heic" });
    fireEvent.paste(await screen.findByPlaceholderText(/Ask Mythra Code to work in/), { clipboardData: { items: [{ type: file.type, getAsFile: () => file }] } });
    expect(await screen.findByText(/HEIC\/HEIF images are not supported/)).toBeInTheDocument();
    expect(invokeMock.mock.calls.some(([command]) => command === "save_pasted_image")).toBe(false);
  });

  it("waits for the durable image before steering and clears the sent chip", async () => {
    const user = userEvent.setup();
    const persisted = deferred<string>();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "persist_image_attachment") return persisted.promise;
      return stubInvoke(command, args);
    });
    await renderApp();
    await user.click(await screen.findByText("Alpha thread"));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Files workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "diagram.PNG" }));
    await user.click(await screen.findByRole("button", { name: "Attach diagram.PNG" }));
    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);
    const { useTaskStore } = await import("./lib/taskStore");
    act(() => { useTaskStore.getState().setActiveTurn(THREAD_A.id, "working-turn"); useTaskStore.getState().setTaskStatus(THREAD_A.id, "running"); });
    await user.type(composer, "Use this image");
    await user.click(await screen.findByRole("button", { name: "Steer" }));
    expect(codexCalls("turn/steer")).toHaveLength(0);
    await act(async () => { persisted.resolve("/app-data/message-images/steered/diagram.PNG"); });
    await waitFor(() => expect(codexCalls("turn/steer")).toHaveLength(1));
    expect(codexCalls("turn/steer")[0].input).toContainEqual(expect.objectContaining({ type: "localImage", path: "/app-data/message-images/steered/diagram.PNG" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove attachment diagram.PNG" })).not.toBeInTheDocument());
  });

  it("sends a Files-tab image as a native image input", async () => {
    const user = userEvent.setup();
    const persisted = deferred<string>();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "persist_image_attachment") return persisted.promise;
      return stubInvoke(command, args);
    });
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Files workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "diagram.PNG" }));
    await user.click(await screen.findByRole("button", { name: "Attach diagram.PNG" }));

    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);
    await user.type(composer, "look at this{Enter}");
    expect(codexCalls("turn/start")).toHaveLength(0);

    await act(async () => {
      persisted.resolve("/app-data/message-images/durable/diagram.PNG");
      await persisted.promise;
    });

    await waitFor(() => expect(codexCalls("turn/start")).not.toHaveLength(0));
    const started = codexCalls("turn/start").at(-1) as { input?: Array<Record<string, unknown>> };
    // The Files surface classifies extensions exactly like the picker, so the
    // screenshot arrives as an image rather than as a bare path.
    expect(started.input).toContainEqual(expect.objectContaining({
      type: "localImage",
      path: "/app-data/message-images/durable/diagram.PNG",
    }));
  });
});

describe("workspace review diff", () => {
  const STAGED_DIFF = [
    'diff --git "a/src/caf\\303\\251 note.ts" "b/src/caf\\303\\251 note.ts"',
    '--- "a/src/caf\\303\\251 note.ts"',
    '+++ "b/src/caf\\303\\251 note.ts"',
    "@@ -0,0 +1 @@",
    "+staged change",
  ].join("\n");

  it("does not surface a post-run spawn error when Git is unavailable on Windows", async () => {
    const user = userEvent.setup();
    workspaceGitInfoImpl = () => ({
      isRepo: false,
      isRoot: false,
      hasCommit: false,
      branch: null,
      head: null,
      error: null,
    });
    gitDiffToRemoteImpl = () => { throw new Error("failed to spawn command: program not found"); };
    commandExecImpl = () => { throw new Error("failed to spawn command: program not found"); };
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Review workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("workspace_git_info", { cwd: PROJECT_A.path }));
    const attemptedDiffCommands = invokeMock.mock.calls
      .filter(([command, args]) => command === "codex_rpc" && ["gitDiffToRemote", "command/exec"].includes(String(args?.method)))
      .map(([, args]) => args?.method);
    expect(attemptedDiffCommands).toEqual([]);
    expect(screen.queryByText(/failed to spawn command|program not found/i)).not.toBeInTheDocument();
  });

  it("falls back to staged and unstaged changes and names untracked files", async () => {
    const user = userEvent.setup();
    const commands: string[][] = [];
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    gitDiffToRemoteImpl = () => { throw new Error("gitDiffToRemote is not available"); };
    commandExecImpl = (params) => {
      const command = params.command as string[];
      commands.push(command);
      if (command.join(" ") === "git diff --no-ext-diff HEAD --") {
        return { exitCode: 0, stdout: STAGED_DIFF, stderr: "" };
      }
      if (command.join(" ") === "git ls-files --others --exclude-standard") {
        return { exitCode: 0, stdout: "src/brand new.ts\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Review workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Refresh" }));

    // `git diff` alone would have hidden the staged change entirely.
    await waitFor(() => expect(commands).toContainEqual(["git", "diff", "--no-ext-diff", "HEAD", "--"]));
    expect(await screen.findByText("Repository changes")).toBeInTheDocument();
    expect(screen.getByText("1 file changed · against HEAD")).toBeInTheDocument();
    // A quoted non-ASCII path is decoded, so its per-file actions are real.
    expect(screen.getByText("src/café note.ts")).toBeInTheDocument();
    // Untracked files cannot appear in a diff, so they are named rather than
    // silently implied not to exist.
    expect(screen.getByText(/src\/brand new\.ts/)).toBeInTheDocument();
  });

  it("includes staged files when a repository has no first commit yet", async () => {
    const user = userEvent.setup();
    const commands: string[][] = [];
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    gitDiffToRemoteImpl = () => { throw new Error("gitDiffToRemote is not available"); };
    commandExecImpl = (params) => {
      const command = params.command as string[];
      commands.push(command);
      const joined = command.join(" ");
      if (joined === "git diff --no-ext-diff HEAD --") {
        return { exitCode: 128, stdout: "", stderr: "fatal: bad revision 'HEAD'" };
      }
      if (joined === "git diff --no-ext-diff --cached --") {
        return { exitCode: 0, stdout: STAGED_DIFF, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Review workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(commands).toContainEqual(["git", "diff", "--no-ext-diff", "--cached", "--"]));
    expect(screen.getByText("1 file changed · against the empty repository")).toBeInTheDocument();
    expect(screen.getByText("src/café note.ts")).toBeInTheDocument();
  });

  it("keeps the Git console's own diff out of the Review panel", async () => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    commandExecImpl = (params) => {
      const command = params.command as string[];
      if (command.join(" ") === "git diff HEAD --stat --patch") {
        return { exitCode: 0, stdout: "diff --git a/console.ts b/console.ts\n+++ b/console.ts\n+console only", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "More local Git actions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Show full diff output/ }));
    await waitFor(() => expect(screen.getByText(/console only/)).toBeInTheDocument());

    await user.click(screen.getByRole("tab", { name: "Review workspace tool" }));
    expect(await screen.findByText("No changes loaded · against the tracked remote branch")).toBeInTheDocument();
    expect(screen.queryByText("console.ts")).not.toBeInTheDocument();
  });
});

describe("project Run button", () => {
  it("lights up with the project's saved command and runs it in the Terminal panel", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.projects", JSON.stringify([
      { ...PROJECT_A, overrides: { run: { command: "npm run dev", label: "Dev server", updatedAt: 1 } } },
      PROJECT_B,
    ]));
    const executed: Array<Record<string, unknown>> = [];
    commandExecImpl = (params) => {
      executed.push(params);
      return { exitCode: 0, stdout: "ready\n", stderr: "" };
    };
    await renderApp();

    const trigger = await screen.findByRole("button", { name: "Run: ready" });
    expect(trigger).toHaveTextContent("Dev server");
    await user.click(trigger);

    await waitFor(() => expect(executed.some((params) => (params.command as string[]).join(" ").includes("npm run dev"))).toBe(true));
    const call = executed.find((params) => (params.command as string[]).join(" ").includes("npm run dev"))!;
    expect(call.cwd).toBe("/projects/alpha");
    expect(call.tty).toBe(true);
  });

  it("runs saved setup and launch in one shell from the thread's worktree", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.projects", JSON.stringify([
      { ...PROJECT_A, overrides: { run: { setupCommand: "npm ci", command: "npm run dev", updatedAt: 1 } } },
      PROJECT_B,
    ]));
    localStorage.setItem("kiwi.threadWorktrees", JSON.stringify({
      [THREAD_A.id]: {
        threadId: THREAD_A.id, projectId: PROJECT_A.id, projectPath: PROJECT_A.path,
        path: "/managed/worktrees/thread-a", branch: "openkiwi/thread-a",
        baseCommit: "head", gitDir: "/projects/alpha/.git", createdAt: 1, status: "active",
      },
    }));
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    const executed: Array<Record<string, unknown>> = [];
    commandExecImpl = (params) => { executed.push(params); return { exitCode: 0, stdout: "ready", stderr: "" }; };
    await renderApp();
    await user.click(await screen.findByText("Alpha thread"));
    await user.click(await screen.findByRole("button", { name: "Run: ready" }));
    const expected = projectRunExecCommand({ setupCommand: "npm ci", command: "npm run dev", updatedAt: 1 });
    await waitFor(() => expect(executed.some((params) => JSON.stringify(params.command) === JSON.stringify(expected))).toBe(true));
    const call = executed.find((params) => JSON.stringify(params.command) === JSON.stringify(expected))!;
    expect(call.cwd).toBe("/managed/worktrees/thread-a");
    expect(call.sandboxPolicy).toEqual(expect.objectContaining({
      type: "workspaceWrite", writableRoots: ["/managed/worktrees/thread-a", "/projects/alpha/.git"],
    }));
    expect(call.tty).toBe(true);
  });

  it("keeps the real terminal panel rendered instead of tripping the workspace tools boundary", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Terminal workspace tool" }));

    // xterm mounts its own element inside the host once `open` succeeds.
    await waitFor(() => expect(document.querySelector(".xterm-host .xterm")).toBeInTheDocument());
    expect(screen.queryByText("The workspace tools view hit a problem")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload view" })).not.toBeInTheDocument();
  });

  it("is greyed out until a command is saved from the header editor, per project", async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(await screen.findByRole("button", { name: "Run: not set" }));
    await user.type(screen.getByRole("textbox", { name: "Run command for Alpha" }), "make dev");
    await user.click(screen.getByRole("button", { name: "Save run command" }));

    expect(await screen.findByRole("button", { name: "Run: ready" })).toHaveTextContent("make dev");
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("kiwi.projects")!) as Array<{ id: string; overrides?: { run?: { command: string } } }>;
      expect(stored.find((project) => project.id === "project-a")?.overrides?.run?.command).toBe("make dev");
      expect(stored.find((project) => project.id === "project-b")?.overrides?.run).toBeUndefined();
    });
  });

  it("saves a discovered run recipe to the project that started discovery after navigation", async () => {
    const user = userEvent.setup();
    const discovery = deferred<{ command: string; setupCommand: string; label: string; explanation: string }>();
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
      command === "run_discovery_start" ? discovery.promise : stubInvoke(command, args));
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Edit run command" }));
    await user.click(await screen.findByRole("button", { name: "Find run command" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("run_discovery_start", {
      options: expect.objectContaining({ cwd: PROJECT_A.path }),
    }));

    await user.click(screen.getByRole("button", { name: PROJECT_B.name }));
    await act(async () => discovery.resolve({ command: "npm run dev", setupCommand: "npm ci", label: "Dev server", explanation: "package.json defines dev" }));

    await waitFor(() => {
      const projects = JSON.parse(localStorage.getItem("kiwi.projects") ?? "[]") as Array<{ id: string; overrides?: { run?: { command: string; setupCommand?: string } } }>;
      expect(projects.find((project) => project.id === PROJECT_A.id)?.overrides?.run).toMatchObject({ command: "npm run dev", setupCommand: "npm ci" });
      expect(projects.find((project) => project.id === PROJECT_B.id)?.overrides?.run).toBeUndefined();
    });
    expect(invokeMock.mock.calls.some(([command, args]) => command === "codex_rpc" && args?.method === "command/exec")).toBe(false);
  });

  it("keeps an agent's newer run recipe when discovery finishes late", async () => {
    const user = userEvent.setup();
    const discovery = deferred<{ command: string; setupCommand: string; label: string; explanation: string }>();
    localStorage.setItem("kiwi.threadProjects", JSON.stringify({ [THREAD_A.id]: PROJECT_A.path }));
    localStorage.setItem("kiwi.childAgentPolicies", JSON.stringify({
      "session-run": {
        sessionId: "session-run", rootThreadId: THREAD_A.id, maxConcurrent: 1,
        permission: "read-only", systemPrompt: "", projectInstructionsEnabled: false,
        reasoningEffort: "medium", serviceTier: null, targets: [], capturedAt: 1,
      },
    }));
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
      command === "run_discovery_start" ? discovery.promise : stubInvoke(command, args));
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Edit run command" }));
    await user.click(await screen.findByRole("button", { name: "Find run command" }));
    await waitFor(() => expect(invokeMock.mock.calls.some(([command]) => command === "run_discovery_start")).toBe(true));

    await waitFor(() => expect(tauriEvents.handlers.has("child-agent-request")).toBe(true));
    await act(async () => tauriEvents.handlers.get("child-agent-request")?.({ payload: {
      requestId: "agent-run-1", sessionId: "session-run", tool: "set_project_run_command",
      arguments: { command: "npm run preview", setupCommand: "npm ci", label: "Preview" },
    } }));
    await waitFor(() => {
      const projects = JSON.parse(localStorage.getItem("kiwi.projects") ?? "[]") as Array<{ id: string; overrides?: { run?: { command: string } } }>;
      expect(projects.find((project) => project.id === PROJECT_A.id)?.overrides?.run?.command).toBe("npm run preview");
    });

    await act(async () => discovery.resolve({ command: "npm run dev", setupCommand: "npm install", label: "Dev server", explanation: "package.json defines dev" }));
    await waitFor(() => expect(screen.getByText(/newer command was kept/i)).toBeInTheDocument());
    const projects = JSON.parse(localStorage.getItem("kiwi.projects") ?? "[]") as Array<{ id: string; overrides?: { run?: { command: string; setupCommand?: string } } }>;
    expect(projects.find((project) => project.id === PROJECT_A.id)?.overrides?.run).toMatchObject({ command: "npm run preview", setupCommand: "npm ci" });
  });
});

describe("project checks", () => {
  it("saves a found check to the project that started discovery after navigation without running it", async () => {
    const user = userEvent.setup();
    const discovery = deferred<{ command: string; label: string; explanation: string }>();
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
      command === "run_discovery_start" ? discovery.promise : stubInvoke(command, args));
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Review workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Find checks" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("run_discovery_start", {
      options: expect.objectContaining({ cwd: PROJECT_A.path, purpose: "checks" }),
    }));

    await user.click(screen.getByRole("button", { name: PROJECT_B.name }));
    await act(async () => discovery.resolve({ command: "npm run verify", label: "Verify", explanation: "package.json defines verify" }));

    await waitFor(() => {
      const projects = JSON.parse(localStorage.getItem("kiwi.projects") ?? "[]") as Array<{ id: string; overrides?: { check?: { command: string } } }>;
      expect(projects.find((project) => project.id === PROJECT_A.id)?.overrides?.check?.command).toBe("npm run verify");
      expect(projects.find((project) => project.id === PROJECT_B.id)?.overrides?.check).toBeUndefined();
    });
    expect(invokeMock.mock.calls.some(([command, args]) => command === "codex_rpc" && args?.method === "command/exec")).toBe(false);
  });

  it("keeps a newer manual check command when an earlier discovery finishes late", async () => {
    const user = userEvent.setup();
    const discovery = deferred<{ command: string; label: string; explanation: string }>();
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
      command === "run_discovery_start" ? discovery.promise : stubInvoke(command, args));
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Review workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Find checks" }));
    await waitFor(() => expect(invokeMock.mock.calls.some(([command]) => command === "run_discovery_start")).toBe(true));

    await user.click(screen.getByRole("button", { name: "Edit check command" }));
    await user.type(await screen.findByRole("textbox", { name: "Check command" }), "npm test");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const projects = JSON.parse(localStorage.getItem("kiwi.projects") ?? "[]") as Array<{ id: string; overrides?: { check?: { command: string } } }>;
      expect(projects.find((project) => project.id === PROJECT_A.id)?.overrides?.check?.command).toBe("npm test");
    });

    await act(async () => discovery.resolve({ command: "npm run verify", label: "Verify", explanation: "package.json defines verify" }));
    await waitFor(() => expect(screen.getByText(/newer command was kept/i)).toBeInTheDocument());
    const projects = JSON.parse(localStorage.getItem("kiwi.projects") ?? "[]") as Array<{ id: string; overrides?: { check?: { command: string } } }>;
    expect(projects.find((project) => project.id === PROJECT_A.id)?.overrides?.check?.command).toBe("npm test");
    expect(invokeMock.mock.calls.some(([command, args]) => command === "codex_rpc" && args?.method === "command/exec")).toBe(false);
  });

  it("keeps a newer agent-saved check command when discovery finishes late", async () => {
    const user = userEvent.setup();
    const discovery = deferred<{ command: string; label: string; explanation: string }>();
    localStorage.setItem("kiwi.threadProjects", JSON.stringify({ [THREAD_A.id]: PROJECT_A.path }));
    localStorage.setItem("kiwi.childAgentPolicies", JSON.stringify({
      "session-check": {
        sessionId: "session-check", rootThreadId: THREAD_A.id, maxConcurrent: 1,
        permission: "read-only", systemPrompt: "", projectInstructionsEnabled: false,
        reasoningEffort: "medium", serviceTier: null, targets: [], capturedAt: 1,
      },
    }));
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
      command === "run_discovery_start" ? discovery.promise : stubInvoke(command, args));
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Review workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Find checks" }));
    await waitFor(() => expect(invokeMock.mock.calls.some(([command]) => command === "run_discovery_start")).toBe(true));

    await waitFor(() => expect(tauriEvents.handlers.has("child-agent-request")).toBe(true));
    await act(async () => tauriEvents.handlers.get("child-agent-request")?.({ payload: {
      requestId: "agent-check-1", sessionId: "session-check", tool: "set_project_check_command",
      arguments: { command: "npm test" },
    } }));
    await waitFor(() => {
      const projects = JSON.parse(localStorage.getItem("kiwi.projects") ?? "[]") as Array<{ id: string; overrides?: { check?: { command: string } } }>;
      expect(projects.find((project) => project.id === PROJECT_A.id)?.overrides?.check?.command).toBe("npm test");
      expect(invokeMock).toHaveBeenCalledWith("child_agent_respond", expect.objectContaining({
        requestId: "agent-check-1", result: expect.objectContaining({ saved: true, command: "npm test" }),
      }));
    });

    await act(async () => discovery.resolve({ command: "npm run verify", label: "Verify", explanation: "package.json defines verify" }));
    await waitFor(() => expect(screen.getByText(/newer command was kept/i)).toBeInTheDocument());
    const projects = JSON.parse(localStorage.getItem("kiwi.projects") ?? "[]") as Array<{ id: string; overrides?: { check?: { command: string } } }>;
    expect(projects.find((project) => project.id === PROJECT_A.id)?.overrides?.check?.command).toBe("npm test");
    expect(invokeMock.mock.calls.some(([command, args]) => command === "codex_rpc" && args?.method === "command/exec")).toBe(false);
  });

  it.each([
    { label: "with an optional prompt", prompt: "Please also explain the cause.", invokesSkill: false },
    { label: "with feedback alone", prompt: "", invokesSkill: false },
    { label: "with a user-authored skill mention", prompt: "@review Please also explain the cause.", invokesSkill: true },
  ])("runs a failed worktree check and sends one agent request $label", async ({ prompt, invokesSkill }) => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.projects", JSON.stringify([
      { ...PROJECT_A, overrides: { check: { command: "npm test", updatedAt: 1 } } },
      PROJECT_B,
    ]));
    localStorage.setItem("kiwi.threadWorktrees", JSON.stringify({
      [THREAD_A.id]: {
        threadId: THREAD_A.id, projectId: PROJECT_A.id, projectPath: PROJECT_A.path,
        path: "/managed/worktrees/thread-a", branch: "openkiwi/thread-a",
        baseCommit: "head", gitDir: "/projects/alpha/.git", createdAt: 1, status: "active",
      },
    }));
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    const executed: Array<Record<string, unknown>> = [];
    commandExecImpl = (params) => {
      executed.push(params);
      return (params.command as string[])[2] === "npm test"
        ? { exitCode: 2, stdout: "", stderr: "1 test failed: important case @review" }
        : { exitCode: 0, stdout: "", stderr: "" };
    };
    if (invokesSkill) localSkillsResolvePromptImpl = (params) => `resolved selected skill\n\n${String(params.message)}`;
    await renderApp();
    await user.click(await screen.findByText("Alpha thread"));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Review workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Run checks" }));

    await waitFor(() => expect(executed.some((params) => (params.command as string[])[2] === "npm test")).toBe(true));
    const checkCall = executed.find((params) => (params.command as string[])[2] === "npm test")!;
    expect(checkCall.cwd).toBe("/managed/worktrees/thread-a");
    expect(checkCall).toMatchObject({ outputBytesCap: 65_536, tty: false, streamStdoutStderr: false });
    expect(checkCall.sandboxPolicy).toEqual(expect.objectContaining({
      type: "workspaceWrite", writableRoots: ["/managed/worktrees/thread-a", "/projects/alpha/.git"],
    }));
    expect(await screen.findByText("Checks failed · exit 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Output" }));
    expect(screen.getByLabelText("Check output")).toHaveTextContent("1 test failed: important case");
    expect(invokeMock.mock.calls.filter(([command, args]) => command === "codex_rpc" && args?.method === "turn/start")).toHaveLength(0);

    await user.click(await screen.findByRole("button", { name: "Ask agent to fix" }));
    const send = await screen.findByRole("button", { name: "Send feedback and optional prompt" });
    expect(send).toBeEnabled();
    expect(invokeMock.mock.calls.filter(([command, args]) => command === "codex_rpc" && args?.method === "turn/start")).toHaveLength(0);
    if (prompt) await user.type(await screen.findByPlaceholderText(/Add a message \(optional\)/), prompt);
    const skillCallsBeforeSend = invokeMock.mock.calls.filter(([command]) => command === "local_skills_resolve_prompts").length;
    await user.click(send);

    await waitFor(() => expect(invokeMock.mock.calls.filter(([command, args]) => command === "codex_rpc" && args?.method === "turn/start")).toHaveLength(1));
    const turn = invokeMock.mock.calls.find(([command, args]) => command === "codex_rpc" && args?.method === "turn/start")![1]?.params as Record<string, unknown>;
    expect(turn.threadId).toBe(THREAD_A.id);
    const input = (turn.input as Array<{ text?: string }>).map((item) => item.text ?? "").join("\n");
    if (prompt) expect(input).toContain(prompt);
    expect(input).toContain("npm test");
    expect(input).toContain("1 test failed: important case");
    expect(input).toContain("/managed/worktrees/thread-a");
    expect(input).toContain("exit 2");
    expect(input).toContain("important case @review");
    const { useTaskStore } = await import("./lib/taskStore");
    const displayed = useTaskStore.getState().tasks[THREAD_A.id]?.messages.filter((message) => message.role === "user").at(-1)?.text;
    expect(displayed).toContain("important case @review");
    expect(displayed).not.toContain("resolved selected skill");
    const skillCalls = invokeMock.mock.calls.filter(([command]) => command === "local_skills_resolve_prompts").slice(skillCallsBeforeSend);
    if (invokesSkill) {
      expect(skillCalls).toHaveLength(1);
      expect(String(skillCalls[0][1]?.message)).toContain("important case @review");
      expect(String(skillCalls[0][1]?.mentionSource)).toContain(prompt);
      expect(String(skillCalls[0][1]?.mentionSource)).not.toContain("important case @review");
      expect(input).toContain("resolved selected skill");
    } else {
      expect(skillCalls).toHaveLength(0);
    }
  });
});


describe("Thread pull request integration", () => {
  it("does not refresh the newly selected project when an old project PR merge completes", async () => {
    const pending = deferred<PullRequest>();
    const pullRequest = { ...LINKED_PR, viewerCanMerge: true, autoMergeAllowed: false };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "github_pr_list") return args?.cwd === PROJECT_A.path ? [pullRequest] : [];
      if (command === "github_pr_view") return pullRequest;
      if (command === "github_pr_merge") return pending.promise;
      return stubInvoke(command, args);
    });
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: /^Pull requests/ }));
    await user.click(await screen.findByRole("button", { name: /#31 Improve Alpha.*Open details/ }));
    await user.click(await screen.findByRole("button", { name: "Merge on GitHub…" }));
    await user.click(within(screen.getByRole("group", { name: "Confirm merge" })).getByRole("button", { name: "Merge #31 on GitHub" }));
    await waitFor(() => expect(invokeMock.mock.calls.some(([command]) => command === "github_pr_merge")).toBe(true));
    await user.click(screen.getByRole("button", { name: /^Beta$/ }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("github_repo_status", { cwd: PROJECT_B.path }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("git_workspace_snapshot", { cwd: PROJECT_B.path }));
    const callsBeforeCompletion = invokeMock.mock.calls.length;
    await act(async () => { pending.resolve({ ...pullRequest, state: "MERGED" }); await pending.promise; });
    await waitFor(() => expect(invokeMock.mock.calls.slice(callsBeforeCompletion).some(([command]) => command === "github_pr_list")).toBe(true));
    const ownerReads = new Set(["github_repo_status", "git_project_diff", "git_workspace_snapshot"]);
    expect(invokeMock.mock.calls.slice(callsBeforeCompletion).filter(([command, args]) => ownerReads.has(command) && args?.cwd === PROJECT_B.path)).toEqual([]);
  });

  it("keeps local-only projects usable without showing a failed PR connection", async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "github_status") return { ...(stubInvoke(command, args) as object), authenticated: false };
      if (command === "github_repo_status") return { isRepo: true, repository: null, remoteUrl: null, branch: "main", upstream: null, ahead: 0, behind: 0 };
      return stubInvoke(command, args);
    });
    const user = userEvent.setup();
    await renderApp();
    await user.click(await screen.findByRole("button", { name: /^Open Alpha thread\b/ }));
    await user.click(await screen.findByRole("button", { name: /^Pull requests/ }));
    // The shortcut opens Pull requests, which explains the missing remote
    // instead of reporting a failure; local commits are one tab away.
    expect(await screen.findByText("Pull requests need a GitHub repository")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /Changes/ }));
    expect(await screen.findByRole("button", { name: "Commit all changes locally" })).toBeEnabled();
    expect(screen.queryByRole("region", { name: "Pull request" })).not.toBeInTheDocument();
    expect(screen.queryByText(/cannot read this folder's Git repository/)).not.toBeInTheDocument();
    expect(invokeMock.mock.calls.some(([command]) => command === "github_pr_context")).toBe(false);
  });

  it("creates and switches a local branch while signed out of GitHub", async () => {
    const user = userEvent.setup();
    let branch = "main";
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "github_status") return { ...(stubInvoke(command, args) as object), authenticated: false };
      if (command === "github_repo_status") return { isRepo: true, repository: null, branch, upstream: null, ahead: 0, behind: 0 };
      if (command === "git_workspace_branch") branch = String(args?.name);
      if (command === "git_workspace_snapshot" || command === "git_workspace_branch") return {
        branch, headOid: "a".repeat(40), branches: [{ name: branch, current: true, worktreePath: PROJECT_A.path }],
        stagedFiles: 0, unstagedFiles: 0, changedFiles: 0, stagedPaths: [], rootPath: PROJECT_A.path,
      };
      return stubInvoke(command, args);
    });
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Switch or create a branch" }));
    await user.click(screen.getByRole("menuitem", { name: /New branch/ }));
    await user.type(screen.getByRole("textbox", { name: "New branch name" }), "feature/offline");
    await user.click(screen.getByRole("button", { name: "Create branch" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("git_workspace_branch", {
      cwd: PROJECT_A.path, name: "feature/offline", create: true, expectedHeadOid: "a".repeat(40), expectedBranch: "main",
    }));
    expect(await screen.findByText(/Created local branch feature\/offline/)).toBeInTheDocument();
    expect(invokeMock.mock.calls.some(([command]) => command === "github_pr_create_branch" || command === "git_publish_commit")).toBe(false);
  });

  it("attaches a PR durably to one thread without attaching it to its shared-folder neighbour", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(await screen.findByRole("button", { name: /^Open Alpha thread\b/ }));
    await user.click(await screen.findByRole("button", { name: /^Pull requests for/ }));
    const reference = await screen.findByRole("textbox", { name: "Pull request number or link" });
    await user.type(reference, "#31");
    expect(within(screen.getByRole("region", { name: "Pull request" })).getByRole("button", { name: "Attach" })).toBeEnabled();
    await user.click(within(screen.getByRole("region", { name: "Pull request" })).getByRole("button", { name: "Attach" }));
    expect(await screen.findByText("Improve Alpha")).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(localStorage.getItem("kiwi.threadPullRequests") || "{}")[THREAD_A.id]?.number).toBe(31));
    await user.click(screen.getByRole("button", { name: /^Open Beta thread\b/ }));
    await waitFor(() => expect(screen.queryByText("Improve Alpha")).not.toBeInTheDocument());
    expect(JSON.parse(localStorage.getItem("kiwi.threadPullRequests") || "{}")[THREAD_B.id]).toBeUndefined();
    await user.click(screen.getByRole("button", { name: /^Open Alpha thread\b/ }));
    expect(await screen.findByText("Improve Alpha")).toBeInTheDocument();
  });
});

describe("archived scheduled prompt visibility", () => {
  it("keeps an unopened thread's schedules discoverable through archive, disclosure and restore", { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.threadProjects", JSON.stringify({ [THREAD_A.id]: PROJECT_A.path }));
    localStorage.setItem("kiwi.knownThreads", JSON.stringify({ [THREAD_A.id]: THREAD_A }));
    localStorage.setItem("kiwi.queuedTurns", JSON.stringify({
      [THREAD_A.id]: [{ id: "archived-follow-up", threadId: THREAD_A.id, text: "Inspect tomorrow's build", attachments: [],
        createdAt: Date.now(), deliverAt: Date.now() + 86_400_000, status: "queued" }],
    }));
    await renderApp();
    const { useTaskStore, storedPendingTimedTurns } = await import("./lib/taskStore");
    const projectName = "Alpha, 1 scheduled prompt in existing threads";
    expect(await screen.findByRole("button", { name: projectName })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Open Alpha thread · 1 scheduled prompt in this thread" })).toBeInTheDocument();
    expect(useTaskStore.getState().tasks[THREAD_A.id]).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "Options for Alpha thread" }));
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({
      method: "thread/archive", params: { threadId: THREAD_A.id },
    })));
    const archived = await screen.findByRole("button", { name: "Archived, 1 thread, 1 scheduled prompt in archived threads" });
    expect(archived).toHaveAttribute("aria-expanded", "false");
    expect(archived.querySelector(".scheduled-count")).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: projectName })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Open Alpha thread/ })).toBeNull();
    expect(storedPendingTimedTurns()).toHaveLength(1);

    await user.click(archived);
    const archivedRow = screen.getByRole("group", { name: "Alpha thread, 1 scheduled prompt in this thread" });
    expect(archivedRow.querySelector(".scheduled-count")).toHaveTextContent("1");
    await user.click(archived);
    expect(screen.getByRole("button", { name: projectName })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Options for archived Alpha thread" })).toBeNull();
    await user.click(archived);
    await user.click(screen.getByRole("button", { name: "Options for archived Alpha thread" }));
    await user.click(screen.getByRole("menuitem", { name: "Restore" }));
    expect(await screen.findByRole("button", { name: "Open Alpha thread · 1 scheduled prompt in this thread" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Archived, 1 thread/ })).toBeNull();
    expect(screen.getByRole("button", { name: projectName })).toBeInTheDocument();
    expect(invokeMock.mock.calls.some(([command, args]) => command === "codex_rpc" && args?.method === "turn/start")).toBe(false);
  });
});

describe("scheduled new conversations", () => {
  function inTwoDays(): string {
    const date = new Date(Date.now() + 2 * 86_400_000);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  it("keeps a scheduled new conversation visible and actionable after a normal first send opens a thread", { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    await renderApp();
    const { useNewThreadTimedPrompts } = await import("./lib/newThreadTimedPrompts");
    const { useTaskStore } = await import("./lib/taskStore");
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    const draft = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);

    // 1. Schedule a first prompt from the new-thread draft.
    await user.type(draft, "Nightly dependency audit");
    await user.click(screen.getByRole("button", { name: "Schedule this prompt" }));
    const picker = await screen.findByRole("dialog", { name: "Schedule prompt" });
    fireEvent.change(within(picker).getByLabelText("Date"), { target: { value: inTwoDays() } });
    fireEvent.change(within(picker).getByLabelText("Time"), { target: { value: "09:00" } });
    await user.click(within(picker).getByRole("button", { name: "Schedule" }));
    const draftToggle = await screen.findByRole("button", { name: /Scheduled · new conversations/ });
    expect(draftToggle).toHaveAttribute("aria-expanded", "false");
    expect(draftToggle).toHaveTextContent("1 prompt");
    await user.click(draftToggle);
    const draftList = await screen.findByRole("list", { name: "Scheduled new conversations" });
    expect(within(draftList).getByText("Nightly dependency audit")).toBeInTheDocument();
    const [scheduled] = Object.values(useNewThreadTimedPrompts.getState().prompts).flat();
    expect(scheduled).toMatchObject({ text: "Nightly dependency audit", status: "queued" });
    await user.click(draftToggle);

    // 2. A normal first send creates and opens a thread.
    await user.type(screen.getByPlaceholderText(/Ask Mythra Code to work in/), "Inspect this project{Enter}");
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({ method: "turn/start" })));
    await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe("isolated-thread"));
    // The ordinary send did not consume or start the scheduled prompt.
    expect(Object.values(useNewThreadTimedPrompts.getState().prompts).flat()).toEqual([expect.objectContaining({ id: scheduled.id, status: "queued" })]);

    // 3. Inside the thread, the scheduled new conversation stays reachable,
    // clearly scoped apart from this thread's own schedule.
    const toggle = await screen.findByRole("button", { name: /Scheduled · new conversations/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("1 prompt");
    expect(toggle).toHaveAttribute("title", expect.stringContaining("Each starts its own thread"));
    expect(screen.queryByRole("list", { name: "Scheduled for this thread" })).toBeNull();
    await user.click(toggle);
    const list = screen.getByRole("list", { name: "Scheduled new conversations" });
    expect(within(list).getByText("Nightly dependency audit")).toBeInTheDocument();
    expect(list).toHaveTextContent("new OpenAI conversation");

    // Edit, reschedule and remove all act on the scheduled entry by id.
    await user.click(within(list).getByRole("button", { name: "Edit new conversation 1" }));
    const editor = await screen.findByRole("textbox", { name: "Edit new conversation 1" });
    await user.clear(editor);
    await user.type(editor, "Weekly dependency audit");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(Object.values(useNewThreadTimedPrompts.getState().prompts).flat()[0]).toMatchObject({ text: "Weekly dependency audit" }));

    await user.click(within(screen.getByRole("list", { name: "Scheduled new conversations" })).getByRole("button", { name: "Reschedule new conversation 1" }));
    const reschedule = await screen.findByRole("dialog", { name: "Reschedule new conversation" });
    fireEvent.change(within(reschedule).getByLabelText("Time"), { target: { value: "10:30" } });
    await user.click(within(reschedule).getByRole("button", { name: "Reschedule" }));
    await waitFor(() => expect(new Date(Object.values(useNewThreadTimedPrompts.getState().prompts).flat()[0].deliverAt).getHours()).toBe(10));

    await user.click(within(screen.getByRole("list", { name: "Scheduled new conversations" })).getByRole("button", { name: "Remove new conversation 1" }));
    await waitFor(() => expect(useNewThreadTimedPrompts.getState().prompts).toEqual({}));
    expect(screen.queryByRole("button", { name: /Scheduled · new conversations/ })).toBeNull();
  });

  it("surfaces a missed new conversation in its compact header and starts it only on request", { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    await renderApp();
    const { useNewThreadTimedPrompts } = await import("./lib/newThreadTimedPrompts");
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));
    await user.type(await screen.findByPlaceholderText(/Ask Mythra Code to work in/), "Release notes draft");
    await user.click(screen.getByRole("button", { name: "Schedule this prompt" }));
    const picker = await screen.findByRole("dialog", { name: "Schedule prompt" });
    fireEvent.change(within(picker).getByLabelText("Date"), { target: { value: inTwoDays() } });
    await user.click(within(picker).getByRole("button", { name: "Schedule" }));
    await screen.findByRole("button", { name: /Scheduled · new conversations/ });
    await user.click(await screen.findByRole("button", { name: /^Open Alpha thread\b/ }));
    const [prompt] = Object.values(useNewThreadTimedPrompts.getState().prompts).flat();
    act(() => { useNewThreadTimedPrompts.getState().markMissed([prompt.id]); });

    // Needs a decision: expose that in the compact header without sending it.
    const toggle = await screen.findByRole("button", { name: /Scheduled · new conversations/ });
    expect(toggle).toHaveTextContent("1 missed");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    const list = await screen.findByRole("list", { name: "Scheduled new conversations" });
    expect(list).toHaveTextContent("not sent automatically");
    const turnStarts = () => invokeMock.mock.calls.filter(([command, args]) => command === "codex_rpc" && args?.method === "turn/start").length;
    expect(turnStarts()).toBe(0);
    await user.click(within(list).getByRole("button", { name: "Start now new conversation 1" }));
    await waitFor(() => expect(turnStarts()).toBe(1));
    await waitFor(() => expect(useNewThreadTimedPrompts.getState().prompts).toEqual({}));
  });
});
