import { describe, expect, it } from "vitest";
import type { Thread } from "../types";
import {
  compactSidebarIndex,
  countActiveThreadsByWorkspace,
  filterThreadsByKind,
  filterThreadsForWorkspace,
  forgetSidebarThread,
  MAX_THREAD_PREVIEW_CHARACTERS,
  optimisticStartedThread,
  partitionBulkArchiveThreads,
  reconcileSidebarIndex,
  reconcileWorkspaceThreads,
  rememberSidebarThread,
  repairRootThreadMetadata,
  sidebarThread,
  upsertThread,
} from "./threadList";

function makeThread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    name: null,
    preview: "",
    cwd: "/workspace",
    updatedAt: 10,
    modelProvider: "openai",
    ...overrides,
  };
}

describe("thread sidebar list", () => {
  it("shows a newly started thread immediately with its first message", () => {
    const started = optimisticStartedThread(makeThread("normal-chat"), "A normal chat", 20);
    const threads = upsertThread([], started);

    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ id: "normal-chat", preview: "A normal chat", updatedAt: 20 });
  });

  it("reconciles indexed metadata without duplicating the thread", () => {
    const optimistic = optimisticStartedThread(makeThread("normal-chat"), "A normal chat", 20);
    const indexed = makeThread("normal-chat", { name: "Saved chat", preview: "A normal chat", updatedAt: 25 });

    expect(upsertThread([optimistic], indexed)).toEqual([indexed]);
  });

  it("bounds sidebar previews without retaining turns or splitting Unicode graphemes", () => {
    const emoji = "👨‍👩‍👧";
    const thread = makeThread("large-preview", {
      preview: emoji.repeat(MAX_THREAD_PREVIEW_CHARACTERS + 20),
      turns: [{ id: "turn", items: [] }],
    });

    const summary = sidebarThread(thread);

    expect(summary).not.toHaveProperty("turns");
    expect(Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(summary.preview)))
      .toHaveLength(MAX_THREAD_PREVIEW_CHARACTERS);
    expect(summary.preview.endsWith(emoji)).toBe(true);
  });

  it("survives malformed legacy sidebar rows during startup compaction", () => {
    const malformed = {
      missingPreview: { id: "missing-preview", name: null, cwd: "/workspace", updatedAt: 1, modelProvider: "openai" },
      missingWorkspace: { id: "missing-workspace", name: null, preview: "unsafe", updatedAt: 1, modelProvider: "openai" },
      nullRow: null,
    } as unknown as Record<string, Thread>;

    expect(compactSidebarIndex(malformed)).toEqual({
      "missing-preview": expect.objectContaining({ preview: "" }),
    });
  });

  it("compacts legacy sidebar rows on startup", () => {
    const legacy = makeThread("legacy", {
      preview: "x".repeat(MAX_THREAD_PREVIEW_CHARACTERS * 4),
      turns: [{ id: "turn", items: [] }],
    });

    expect(compactSidebarIndex({ legacy })).toEqual({
      legacy: expect.objectContaining({
        preview: "x".repeat(MAX_THREAD_PREVIEW_CHARACTERS),
      }),
    });
    expect(compactSidebarIndex({ legacy }).legacy).not.toHaveProperty("turns");
  });

  it("keeps a newly started OpenRouter chat while the runtime index catches up", () => {
    const chat = makeThread("router-chat", { cwd: "/normal-chats", modelProvider: "openrouter" });
    const remembered = rememberSidebarThread({}, optimisticStartedThread(chat, "Hello OpenRouter", 20));

    expect(reconcileWorkspaceThreads([], remembered, "/normal-chats", { "router-chat": "/normal-chats" }))
      .toEqual([expect.objectContaining({ id: "router-chat", preview: "Hello OpenRouter", modelProvider: "openrouter" })]);
  });

  it("hides runtime threads remembered from another isolated Codex home", () => {
    const foreign = makeThread("foreign", {
      path: "/profiles/production/codex-home/sessions/foreign.jsonl",
      updatedAt: 10,
    });

    expect(reconcileWorkspaceThreads([], { foreign }, "/workspace", {}, {
      runtimeHome: "/profiles/localdev/codex-home",
      runtimeIndexComplete: false,
      nowSeconds: 1_000,
    })).toEqual([]);
  });

  it("keeps same-profile rows during loading but removes absent stale rows after an exhaustive index", () => {
    const indexed = makeThread("indexed", {
      path: "/profiles/localdev/codex-home/sessions/indexed.jsonl",
      updatedAt: 10,
    });
    const optimistic = makeThread("optimistic", {
      path: null,
      updatedAt: 950,
    });
    const remembered = { indexed, optimistic };

    expect(reconcileWorkspaceThreads([], remembered, "/workspace", {}, {
      runtimeHome: "/profiles/localdev/codex-home",
      runtimeIndexComplete: false,
      nowSeconds: 1_000,
    })).toHaveLength(2);
    expect(reconcileWorkspaceThreads([], remembered, "/workspace", {}, {
      runtimeHome: "/profiles/localdev/codex-home",
      runtimeIndexComplete: true,
      nowSeconds: 1_000,
    })).toEqual([optimistic]);
  });

  it("keeps recoverable metadata while refreshing runtime-owned rows", () => {
    const foreign = makeThread("foreign", {
      path: "C:\\Users\\Morgan\\AppData\\Roaming\\production\\codex-home\\sessions\\foreign.jsonl",
    });
    const claude = makeThread("claude", { modelProvider: "claude" });
    const otherWorkspace = makeThread("other", {
      cwd: "/other",
      path: "C:\\Users\\Morgan\\AppData\\Roaming\\localdev\\codex-home\\sessions\\other.jsonl",
    });

    expect(reconcileSidebarIndex({ foreign, claude, other: otherWorkspace }, []))
      .toEqual({ foreign, claude, other: otherWorkspace });
  });

  it("preserves a managed-worktree row outside a cwd-scoped runtime listing", () => {
    const managed = makeThread("managed", {
      cwd: "/managed/worktrees/thread",
      path: "/profiles/localdev/codex-home/sessions/managed.jsonl",
      updatedAt: 10,
    });

    expect(reconcileWorkspaceThreads([], { managed }, "/workspace", { managed: "/workspace" }, {
      runtimeHome: "/profiles/localdev/codex-home",
      runtimeIndexComplete: true,
      nowSeconds: 1_000,
    })).toEqual([managed]);
  });

  it("merges runtime metadata into remembered chats and removes forgotten chats", () => {
    const optimistic = optimisticStartedThread(makeThread("chat", { cwd: "/normal-chats" }), "Hello", 20);
    const remembered = rememberSidebarThread({}, optimistic);
    const indexed = makeThread("chat", { cwd: "/normal-chats", name: "Saved chat", preview: "Hello", updatedAt: 25 });

    expect(reconcileWorkspaceThreads([indexed], remembered, "/normal-chats", {})).toEqual([indexed]);
    expect(forgetSidebarThread(remembered, "chat")).toEqual({});
  });

  it("filters a stale mixed sidebar list at the workspace boundary", () => {
    const alpha = makeThread("alpha", { cwd: "/projects/alpha" });
    const beta = makeThread("beta", { cwd: "/projects/beta" });

    expect(filterThreadsForWorkspace([alpha, beta], "/projects/beta", {})).toEqual([beta]);
  });

  it("keeps sub-agent threads in a separate inbox view", () => {
    const main = makeThread("main");
    const child = makeThread("child");
    const links = { child: { rootThreadId: "main" } };
    expect(filterThreadsByKind([main, child], links, "main")).toEqual([main]);
    expect(filterThreadsByKind([main, child], links, "subagents")).toEqual([child]);
  });

  it("recognizes native Codex children even before a durable ownership link is restored", () => {
    const main = makeThread("main");
    const nativeChild = makeThread("native-child", { parentThreadId: "main", threadSource: "subagent" });
    expect(filterThreadsByKind([main, nativeChild], {}, "main")).toEqual([main]);
    expect(filterThreadsByKind([main, nativeChild], {}, "subagents")).toEqual([nativeChild]);
  });

  it("keeps a thread that owns children in the main inbox despite reversed thread metadata", () => {
    // The runtime stamped the root's own thread record as a sub-agent of one of
    // its children. That metadata is persisted and would answer yes forever
    // after, so Mythra Code's ownership records outrank it: a thread that owns
    // children is a root, and the user's main conversation stays put.
    const main = makeThread("main", { parentThreadId: "child", threadSource: "subagent" });
    const child = makeThread("child");
    const links = { child: { rootThreadId: "main" } };
    expect(filterThreadsByKind([main, child], links, "main")).toEqual([main]);
    expect(filterThreadsByKind([main, child], links, "subagents")).toEqual([child]);
  });

  it("never classifies a thread reported as its own parent", () => {
    const main = makeThread("main", { parentThreadId: "main" });
    expect(filterThreadsByKind([main], {}, "main")).toEqual([main]);
    expect(filterThreadsByKind([main], {}, "subagents")).toEqual([]);
  });

  it("strips poisoned child metadata from a proven root before its last link disappears", () => {
    const poisoned = makeThread("main", {
      parentThreadId: "child",
      threadSource: "subagent",
      agentNickname: "wrong",
      agentRole: "worker",
      agentPath: "/wrong/path",
    });
    const repaired = repairRootThreadMetadata(poisoned, { child: { rootThreadId: "main" } });
    expect(repaired).not.toBe(poisoned);
    expect(repaired).not.toHaveProperty("parentThreadId");
    expect(repaired).not.toHaveProperty("threadSource");
    expect(repaired).not.toHaveProperty("agentNickname");
    expect(repaired).not.toHaveProperty("agentRole");
    expect(repaired).not.toHaveProperty("agentPath");
    expect(filterThreadsByKind([repaired], {}, "main")).toEqual([repaired]);
  });

  it("uses working statuses and persisted bindings for project counts", () => {
    const shared = makeThread("shared", { cwd: "/projects/alpha" });
    const isolated = makeThread("isolated", { cwd: "/managed/worktrees/isolated" });
    const beta = makeThread("beta", { cwd: "/projects/beta" });
    const bindings = { isolated: "/projects/alpha" };
    const index = { shared, isolated, beta };

    expect(filterThreadsForWorkspace(Object.values(index), "/projects/alpha", bindings))
      .toEqual([shared, isolated]);
    expect(countActiveThreadsByWorkspace(index, bindings, {
      shared: "completed",
      isolated: "running",
      beta: "starting",
    })).toEqual({
      "/projects/alpha": 1,
      "/projects/beta": 1,
    });
  });

  it("counts a newly starting task before its sidebar metadata arrives", () => {
    expect(countActiveThreadsByWorkspace({}, { draft: "/projects/alpha" }, { draft: "starting" })).toEqual({
      "/projects/alpha": 1,
    });
  });

  it("keeps live tasks out of a bulk archive operation", () => {
    const idle = makeThread("idle");
    const starting = makeThread("starting");
    const running = makeThread("running");
    const completed = makeThread("completed");
    const failed = makeThread("failed");

    expect(partitionBulkArchiveThreads(
      [idle, starting, running, completed, failed],
      {
        idle: "idle",
        starting: "starting",
        running: "running",
        completed: "completed",
        failed: "error",
      },
    )).toEqual({
      ready: [idle, completed, failed],
      active: [starting, running],
    });
  });
});
