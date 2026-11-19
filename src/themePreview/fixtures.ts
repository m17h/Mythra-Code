// Sample content for the hidden theme preview. Everything here is invented
// and bundled with the app: no user project, thread, transcript, file,
// terminal output or account ever reaches the preview. New scenes (see
// src/lib/customThemes/previewScenes.ts) only need new data here; the views
// themselves are the app's own. Every value is a constant, so the same job
// always draws the same picture.

import { parseDiffSections, type ReviewDiff } from "../lib/gitDiff";
import type { ProjectGitChanges } from "../lib/gitInspection";
import type { GitWorkflowControls } from "../lib/gitWorkspace";
import type { ProjectGitInspection } from "../lib/projectGit";
import type { LocalSkill } from "../lib/skills";
import type { ThreadWorktreeRecord, WorkspaceGitInfo, WorktreeStatus } from "../lib/worktrees";
import type { DirectoryEntry, FileBrowserSource } from "../components/FileBrowser";
import type { McpView } from "../components/StudioDock";
import type { TerminalOutputStore } from "../hooks/useTerminal";
import { basename } from "../lib/paths";
import type { Activity, ChatMessage, Project, ProjectRunCommand, Thread } from "../types";

/** Invented paths that identify bundled sample content. */
export const SAMPLE_PROJECT = { name: "lantern-notes", path: "/sample/lantern-notes" };
export const SAMPLE_RUN: ProjectRunCommand = { command: "npm run dev", label: "Dev server" };
export const SAMPLE_CHECK_COMMAND = "npm test";

export const SAMPLE_PROJECTS: ReadonlyArray<{ id: string; name: string; pinned: boolean }> = [
  { id: "sample-lantern", name: SAMPLE_PROJECT.name, pinned: true },
  { id: "sample-orbit", name: "orbit-design-system", pinned: false },
  { id: "sample-garden", name: "garden-api", pinned: false },
];

export const SAMPLE_THREADS: ReadonlyArray<{ id: string; title: string; current?: boolean; pinned?: boolean; scheduled?: number; unread?: boolean }> = [
  { id: "sample-thread-sync", title: "Smooth the notebook list refresh after sync", current: true },
  { id: "sample-thread-export", title: "Fix the flaky Markdown export test", pinned: true, unread: true },
  { id: "sample-thread-search", title: "Add fuzzy matching to note search", scheduled: 1 },
  { id: "sample-thread-copy", title: "Tidy the onboarding copy" },
];

const SAMPLE_FILES = [
  { path: "docs/sync.md", text: "# Notebook sync\n\nThe list preserves its scroll position when notes change.\n" },
  { path: "src/notebooks/NotebookList.tsx", text: "export function NotebookList() {\n  return <ul aria-label=\"Notebooks\" />;\n}\n" },
  { path: "README.md", text: "# Lantern Notes\n\nA notebook that works offline.\n" },
  { path: "package.json", text: '{ "name": "lantern-notes", "private": true }\n' },
  { path: "tsconfig.json", text: '{ "compilerOptions": { "strict": true } }\n' },
];

export const SAMPLE_FILE_SOURCE: FileBrowserSource = {
  list: async (path) => {
    const entries = new Map<string, DirectoryEntry>();
    for (const file of SAMPLE_FILES) {
      const absolute = `${SAMPLE_PROJECT.path}/${file.path}`;
      if (!absolute.startsWith(`${path}/`)) continue;
      const [fileName, ...children] = absolute.slice(path.length + 1).split("/");
      const isDirectory = children.length > 0;
      entries.set(fileName, { fileName, isDirectory, isFile: !isDirectory });
    }
    return { entries: [...entries.values()] };
  },
  search: async (query, root) => ({
    files: root === SAMPLE_PROJECT.path ? SAMPLE_FILES
      .filter((file) => file.path.toLowerCase().includes(query.toLowerCase()))
      .map((file) => ({ root, path: file.path, file_name: basename(file.path), score: 1 })) : [],
  }),
  preview: async (root, path) => {
    const file = root === SAMPLE_PROJECT.path && SAMPLE_FILES.find((entry) => `${root}/${entry.path}` === path);
    if (!file) throw new Error("Sample file is unavailable");
    return { text: file.text, truncated: false, binary: false };
  },
};

export const SAMPLE_TERMINAL_RESULT = "38 passed";
const SAMPLE_TERMINAL_TEXT = [
  "$ npm test -- notebooks",
  "",
  "\x1b[32mPASS\x1b[0m NotebookList.test.tsx",
  "\x1b[32mPASS\x1b[0m useNotebookSync.test.ts",
  "",
  `Tests: \x1b[32m${SAMPLE_TERMINAL_RESULT}\x1b[0m, 38 total`,
  "",
].join("\n");

export const SAMPLE_TERMINAL: TerminalOutputStore = {
  appendedLength: () => SAMPLE_TERMINAL_TEXT.length,
  read: (cursor) => ({ text: SAMPLE_TERMINAL_TEXT.slice(cursor), cursor: SAMPLE_TERMINAL_TEXT.length }),
  generation: () => 0,
  subscribe: () => () => {},
};

const TURN_ONE = "sample-turn-1";
const TURN_TWO = "sample-turn-2";

export const SAMPLE_MESSAGES: ChatMessage[] = [
  {
    id: "sample-user-1", role: "user", turnId: TURN_ONE, turnStatus: "completed", timelineOrder: 1,
    text: "The notebook list flickers when sync finishes. Can you make the refresh smoother and keep the scroll position?",
  },
  {
    id: "sample-assistant-1", role: "assistant", phase: "final", turnId: TURN_ONE, turnStatus: "completed", turnDurationMs: 48_000, timelineOrder: 6,
    text: "The list now **merges changes in place**, so it keeps its scroll position. All 38 notebook tests pass. See the [sync notes](https://example.com/lantern/sync) for the edge cases.",
  },
  {
    id: "sample-user-2", role: "user", turnId: TURN_TWO, turnStatus: "completed", timelineOrder: 7,
    text: "Nice. Could the empty state use the accent colour too?",
  },
  {
    id: "sample-assistant-2", role: "assistant", phase: "final", turnId: TURN_TWO, turnStatus: "completed", turnDurationMs: 9_000, timelineOrder: 9,
    text: [
      "The empty state now follows the active theme.",
      "",
      "- The icon uses **the theme’s accent**.",
      "- The sentence keeps the muted text colour.",
      "",
      "```tsx",
      "<Sparkles size={14} color=\"var(--accent)\" />",
      "```",
    ].join("\n"),
  },
];

export const SAMPLE_ACTIVITIES: Activity[] = [
  {
    id: "sample-search", kind: "command", workType: "research", title: "rg -n \"refreshNotebooks\" src", status: "completed",
    detail: "src/notebooks/useNotebookSync.ts:31:  refreshNotebooks(await api.list());\nsrc/notebooks/NotebookList.tsx:18:  const notebooks = useNotebookSync();",
    turnId: TURN_ONE, turnStatus: "completed", timelineOrder: 2,
  },
  {
    id: "sample-edit", kind: "file", workType: "files", title: "2 file changes", itemCount: 2, status: "completed",
    detail: "src/notebooks/NotebookList.tsx\nsrc/notebooks/useNotebookSync.ts",
    turnId: TURN_ONE, turnStatus: "completed", timelineOrder: 3,
  },
  {
    id: "sample-test", kind: "command", workType: "commands", title: "npm test -- notebooks", status: "completed",
    detail: "PASS src/notebooks/NotebookList.test.tsx\nPASS src/notebooks/useNotebookSync.test.ts\n\nTests: 38 passed, 38 total",
    turnId: TURN_ONE, turnStatus: "completed", timelineOrder: 4,
  },
  {
    id: "sample-reasoning", kind: "reasoning", title: "Model thinking", status: "completed",
    detail: "Keep the array identity stable so React doesn't remount the rows.",
    turnId: TURN_ONE, turnStatus: "completed", timelineOrder: 5,
  },
  {
    id: "sample-edit-2", kind: "file", workType: "files", title: "1 file change", itemCount: 1, status: "completed",
    detail: "src/notebooks/EmptyNotebook.tsx",
    turnId: TURN_TWO, turnStatus: "completed", timelineOrder: 8,
  },
];

export const SAMPLE_DIFF = [
  "diff --git a/src/notebooks/NotebookList.tsx b/src/notebooks/NotebookList.tsx",
  "index 3f2a1c4..8b7d9e0 100644",
  "--- a/src/notebooks/NotebookList.tsx",
  "+++ b/src/notebooks/NotebookList.tsx",
  "@@ -14,8 +14,13 @@ export function NotebookList({ onOpen }: NotebookListProps) {",
  "   const notebooks = useNotebookSync();",
  "   const listRef = useRef<HTMLUListElement>(null);",
  "+  const scrollTop = useRef(0);",
  "+",
  "+  useLayoutEffect(() => {",
  "+    if (listRef.current) listRef.current.scrollTop = scrollTop.current;",
  "+  }, [notebooks]);",
  " ",
  "   return (",
  "-    <ul ref={listRef} className=\"notebook-list\">",
  "+    <ul ref={listRef} className=\"notebook-list\" onScroll={(event) => { scrollTop.current = event.currentTarget.scrollTop; }}>",
  "       {notebooks.map((notebook) => (",
  "         <NotebookRow key={notebook.id} notebook={notebook} onOpen={onOpen} />",
  "       ))}",
  "diff --git a/src/notebooks/useNotebookSync.ts b/src/notebooks/useNotebookSync.ts",
  "index 91c0d2e..4aa7f13 100644",
  "--- a/src/notebooks/useNotebookSync.ts",
  "+++ b/src/notebooks/useNotebookSync.ts",
  "@@ -27,6 +27,7 @@ export function useNotebookSync(): Notebook[] {",
  "   useEffect(() => subscribeSync(async () => {",
  "-    refreshNotebooks(await api.list());",
  "+    const incoming = await api.list();",
  "+    setNotebooks((previous) => mergeById(previous, incoming, sameRevision));",
  "   }), []);",
  " ",
  "   return notebooks;",
  " }",
  "diff --git a/src/notebooks/EmptyNotebook.tsx b/src/notebooks/EmptyNotebook.tsx",
  "index 0d1e2f3..5a6b7c8 100644",
  "--- a/src/notebooks/EmptyNotebook.tsx",
  "+++ b/src/notebooks/EmptyNotebook.tsx",
  "@@ -3,4 +3,4 @@ export function EmptyNotebook() {",
  "   return <p className=\"empty-notebook\">",
  "-    <Sparkles size={14} /> Nothing here yet.",
  "+    <Sparkles size={14} color=\"var(--accent)\" /> Nothing here yet.",
  "   </p>;",
  " }",
  "",
].join("\n");

/** The working changes, as the Changes tab receives them from Git. */
export const SAMPLE_REVIEW_DIFF: ReviewDiff = {
  cwd: SAMPLE_PROJECT.path,
  text: SAMPLE_DIFF,
  successfulText: SAMPLE_DIFF,
  source: "repository",
  baseline: "HEAD",
  untrackedPaths: [],
};

const SAMPLE_SECTIONS = parseDiffSections(SAMPLE_DIFF);
const SAMPLE_HEAD = "3f2a1c4bdf19e65054bb3324a1cca4355acdd08e";
const SAMPLE_CHANGES: ProjectGitChanges = {
  rootPath: SAMPLE_PROJECT.path,
  rows: SAMPLE_SECTIONS.flatMap((section) => section.path ? [{ path: section.path, originalPath: null, area: "unstaged" as const, status: "M" }] : []),
  stagedFiles: 0,
  unstagedFiles: SAMPLE_SECTIONS.length,
  untrackedFiles: 0,
  changedFiles: SAMPLE_SECTIONS.length,
  truncated: false,
};

/** The settled checkout snapshot the local Changes panel normally receives. */
export const SAMPLE_GIT_WORKFLOW: GitWorkflowControls = {
  snapshot: {
    branch: "main",
    headOid: SAMPLE_HEAD,
    branches: [{ name: "main", current: true, worktreePath: SAMPLE_PROJECT.path }],
    rootPath: SAMPLE_PROJECT.path,
    isRoot: true,
    stagedPaths: [],
    stagedFiles: SAMPLE_CHANGES.stagedFiles,
    unstagedFiles: SAMPLE_CHANGES.unstagedFiles,
    changedFiles: SAMPLE_CHANGES.changedFiles,
    changes: SAMPLE_CHANGES,
  },
  busy: false,
  isolated: false,
  onBranch: async () => false,
  onRefresh: () => {},
};

/** Git reads answered from the sample diff, never from a disk. */
export const SAMPLE_GIT: ProjectGitInspection = {
  cwd: SAMPLE_PROJECT.path,
  getChanges: async () => SAMPLE_CHANGES,
  getFileDiff: async (_cwd, path, area) => ({
    path, area, binary: false, truncated: false,
    text: SAMPLE_SECTIONS.find((section) => section.path === path)?.text ?? "",
  }),
  getHistory: async () => ({ entries: [], hasMore: false, nextOffset: 0, headOid: SAMPLE_HEAD, truncated: false }),
};

/** Chats (no project folder) in the sidebar of the new-chat scene. */
export const SAMPLE_CHATS: ReadonlyArray<{ id: string; title: string }> = [
  { id: "sample-chat-naming", title: "Names for a note-taking app" },
  { id: "sample-chat-regex", title: "Explain lookbehind in regular expressions" },
];

/** The sample project's Git state on the new-thread landing (a committed repository root). */
export const SAMPLE_WORKSPACE_GIT: WorkspaceGitInfo = { isRepo: true, isRoot: true, hasCommit: true, branch: "main", head: SAMPLE_HEAD, error: null };

export const SAMPLE_WORKTREE: ThreadWorktreeRecord = {
  threadId: SAMPLE_THREADS[0]!.id,
  projectId: SAMPLE_PROJECTS[0]!.id,
  projectPath: SAMPLE_PROJECT.path,
  path: "/sample/worktrees/lantern-notes/smooth-sync",
  branch: "mythra/smooth-sync",
  baseCommit: SAMPLE_HEAD,
  gitDir: `${SAMPLE_PROJECT.path}/.git/worktrees/smooth-sync`,
  createdAt: 1_767_225_600_000,
  status: "active",
};

export const SAMPLE_WORKTREE_STATUS: WorktreeStatus = {
  exists: true,
  registered: true,
  branch: SAMPLE_WORKTREE.branch,
  sourceBranch: "main",
  baseCommit: SAMPLE_WORKTREE.baseCommit,
  changedFiles: SAMPLE_CHANGES.changedFiles,
  untrackedFiles: 0,
  ignoredFileCount: 1,
  ahead: 2,
  behind: 0,
  clean: false,
};

/** Text typed into a composer so its Send button is enabled (only when a Send state is previewed). */
export const SAMPLE_DRAFT = "Add a keyboard shortcut for the notebook search";

/** The command palette's project and thread rows. */
export const SAMPLE_PALETTE_PROJECTS: Project[] = SAMPLE_PROJECTS.map((project) => ({
  id: project.id, name: project.name, path: `/sample/${project.name}`, pinned: project.pinned,
}));
export const SAMPLE_PALETTE_THREADS: Thread[] = SAMPLE_THREADS.map((thread, index) => ({
  id: thread.id, name: thread.title, preview: "", cwd: SAMPLE_PROJECT.path, updatedAt: 1_767_225_600_000 - index * 3_600_000, modelProvider: "openai",
}));

/** Skills & MCP in Tools. */
export const SAMPLE_SKILLS: LocalSkill[] = [
  { path: "/sample/skills/release-notes.md", relativePath: "release-notes.md", fileName: "release-notes.md", defaultName: "release-notes", name: "release-notes", description: "Draft release notes from merged changes", supportingMarkdownCount: 0, enabled: true },
  { path: "/sample/skills/a11y-review.md", relativePath: "a11y-review.md", fileName: "a11y-review.md", defaultName: "a11y-review", name: "a11y-review", description: "Check new UI for keyboard and screen reader access", supportingMarkdownCount: 1, enabled: false },
];
export const SAMPLE_MCP_SERVERS: McpView[] = [
  { name: "docs-search", status: "ready", tools: 3 },
  { name: "issue-tracker", status: "notLoggedIn", tools: 0 },
];
