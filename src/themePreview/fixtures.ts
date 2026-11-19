// Sample content for the hidden theme preview. Everything here is invented
// and bundled with the app: no user project, thread, transcript, file,
// terminal output or account ever reaches the preview. New scenarios only
// need new data here; the views themselves are the app's own.

import { parseDiffSections, type ReviewDiff } from "../lib/gitDiff";
import type { ProjectGitChanges } from "../lib/gitInspection";
import type { GitWorkflowControls } from "../lib/gitWorkspace";
import type { ProjectGitInspection } from "../lib/projectGit";
import type { Activity, ChatMessage, ProjectRunCommand } from "../types";

/** Not a real folder: nothing in the preview reads or lists it. */
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
