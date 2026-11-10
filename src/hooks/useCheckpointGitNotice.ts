import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { formatGitError } from "../lib/errors";
import { normalizedProjectPath } from "../lib/paths";
import { LOCAL_MACHINE, useActiveMachine } from "../lib/remote/activeMachine";
import { useTaskStore } from "../lib/taskStore";
import { isVoiceInputLocked } from "../lib/voiceInputLock";
import { initializeWorkspaceGit, readWorkspaceGitInfo, type WorkspaceGitInitializeResult } from "../lib/worktrees";
import type { Project } from "../types";

export interface CheckpointGitNotice {
  /** Identity of this showing; a later notification never inherits its outcome. */
  key: string;
  threadId: string;
  /** The exact folder whose automatic checkpoint was skipped. */
  workspacePath: string;
  projectId: string;
  projectName: string;
  phase: "idle" | "initializing" | "failed";
  error?: string;
}

interface CheckpointGitNoticeOptions {
  projectsRef: MutableRefObject<Project[]>;
  activeThreadId: string | null;
  activeProjectId: string | null;
  activeExecutionPath: string;
  /** Another Initialize Git action (the composer's) is already working on this folder. */
  isInitializingElsewhere: (workspacePath: string) => boolean;
  /** Git was set up for this project from the notification. */
  onInitialized: (project: Project, result: WorkspaceGitInitializeResult) => void;
  showSuccessToast: (message: string) => void;
}

/** How often an open notification checks whether Git appeared some other way. */
const GIT_PROBE_MS = 5_000;

// An ancestor repository also makes the missing-Git diagnosis obsolete, even
// though checkpoints may still require selecting that repository's root.
const gitExists = (info: { isRepo: boolean; error?: string | null }) => info.isRepo && !info.error;
const localViewActive = () => {
  const state = useActiveMachine.getState();
  return state.machine === LOCAL_MACHINE && state.shown === LOCAL_MACHINE;
};

/**
 * The "Git isn't initialized" notification for automatic checkpoints. Dismissed
 * folders stay quiet for the session until Git becomes available there;
 * initializing only ever targets the exact folder the skipped checkpoint
 * recorded, and only from the button on this machine's own view.
 */
export function useCheckpointGitNotice(options: CheckpointGitNoticeOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [notice, setNoticeState] = useState<CheckpointGitNotice | null>(null);
  const noticeRef = useRef<CheckpointGitNotice | null>(null);
  const notifiedPathsRef = useRef(new Set<string>());
  const initializingPathsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const lifetimeRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      lifetimeRef.current += 1;
    };
  }, []);

  const setNotice = useCallback((next: CheckpointGitNotice | null) => {
    if (!mountedRef.current) return;
    noticeRef.current = next;
    setNoticeState(next);
  }, []);

  const scopeIsActive = useCallback((scope: { threadId: string; workspacePath: string; projectId?: string }) => {
    const current = optionsRef.current;
    return localViewActive()
      // This store changes synchronously when a newly created thread is
      // selected; React's activeThread prop may still describe its draft.
      && useTaskStore.getState().activeThreadId === scope.threadId
      && (!scope.projectId || current.activeProjectId === scope.projectId)
      && normalizedProjectPath(current.activeExecutionPath) === normalizedProjectPath(scope.workspacePath);
  }, []);

  const showCheckpointGitNotice = useCallback(({ threadId, workspacePath }: { threadId: string; workspacePath: string }) => {
    const pathKey = normalizedProjectPath(workspacePath);
    if (!mountedRef.current || !scopeIsActive({ threadId, workspacePath })) return;
    if (notifiedPathsRef.current.has(pathKey) || initializingPathsRef.current.has(pathKey)) return;
    const project = optionsRef.current.projectsRef.current.find((entry) => (
      entry.id === optionsRef.current.activeProjectId && !entry.isChat && normalizedProjectPath(entry.path) === pathKey
    ));
    if (!project) return;
    const current = noticeRef.current;
    // An initialization in progress keeps its notification until it settles.
    if (current?.phase === "initializing") return;
    notifiedPathsRef.current.add(pathKey);
    setNotice({
      key: crypto.randomUUID(),
      threadId,
      workspacePath,
      projectId: project.id,
      projectName: project.name,
      phase: "idle",
    });
  }, [scopeIsActive, setNotice]);

  /**
   * Git now exists for this folder. Future skipped checkpoints may notify
   * again if it later disappears. `settled` also clears an initializing
   * notification, because the caller itself just set Git up.
   */
  const markCheckpointGitAvailable = useCallback((workspacePath: string, settled = false) => {
    if (!mountedRef.current) return;
    const pathKey = normalizedProjectPath(workspacePath);
    notifiedPathsRef.current.delete(pathKey);
    const current = noticeRef.current;
    if (!current || normalizedProjectPath(current.workspacePath) !== pathKey) return;
    if (current.phase !== "initializing" || settled) setNotice(null);
  }, [setNotice]);

  const dismissCheckpointGitNotice = useCallback((key: string) => {
    if (noticeRef.current?.key === key) setNotice(null);
  }, [setNotice]);

  const initializeCheckpointGit = useCallback(async (key: string) => {
    const shown = noticeRef.current;
    if (!mountedRef.current || !shown || shown.key !== key || shown.phase === "initializing") return;
    // The button lives in this machine's view; it never acts while voice owns
    // input or while another machine is on screen.
    if (isVoiceInputLocked() || !scopeIsActive(shown)) return;
    const pathKey = normalizedProjectPath(shown.workspacePath);
    if (initializingPathsRef.current.has(pathKey) || optionsRef.current.isInitializingElsewhere(shown.workspacePath)) return;
    const project = optionsRef.current.projectsRef.current.find((entry) => (
      entry.id === shown.projectId && !entry.isChat && normalizedProjectPath(entry.path) === pathKey
    ));
    if (!project) {
      setNotice({ ...shown, phase: "failed", error: "This project is no longer open in Mythra Code, so Git was not initialized." });
      return;
    }
    initializingPathsRef.current.add(pathKey);
    const lifetime = lifetimeRef.current;
    setNotice({ ...shown, phase: "initializing", error: undefined });
    try {
      // The recorded execution folder, never whichever project is open now.
      const result = await initializeWorkspaceGit(shown.workspacePath);
      if (!mountedRef.current || lifetimeRef.current !== lifetime) return;
      const liveProject = optionsRef.current.projectsRef.current.find((entry) => (
        entry.id === shown.projectId && !entry.isChat && normalizedProjectPath(entry.path) === pathKey
      ));
      const stillShown = noticeRef.current?.key === key && scopeIsActive(shown);
      if (liveProject) optionsRef.current.onInitialized(liveProject, result);
      markCheckpointGitAvailable(shown.workspacePath, true);
      if (liveProject && stillShown) {
        optionsRef.current.showSuccessToast(
          `Git initialized for ${liveProject.name}. Automatic checkpoints start with the next run; earlier changes can’t be reverted with them.`,
        );
      }
    } catch (reason) {
      if (!mountedRef.current || lifetimeRef.current !== lifetime) return;
      const error = formatGitError(reason);
      const current = noticeRef.current;
      const projectStillExists = optionsRef.current.projectsRef.current.some((entry) => (
        entry.id === shown.projectId && !entry.isChat && normalizedProjectPath(entry.path) === pathKey
      ));
      if (current?.key === key && scopeIsActive(shown) && projectStillExists) setNotice({ ...current, phase: "failed", error });
    } finally {
      initializingPathsRef.current.delete(pathKey);
    }
  }, [markCheckpointGitAvailable, scopeIsActive, setNotice]);

  const isCheckpointGitInitializing = useCallback((workspacePath: string) => (
    initializingPathsRef.current.has(normalizedProjectPath(workspacePath))
  ), []);

  // Git can also appear from a terminal or the model's own `git init`. While
  // an idle or failed notification is open, a read-only look closes it once
  // Git is there. Each look is bound to the notification that started it.
  const noticeKey = notice?.key;
  const noticePhase = notice?.phase;
  const noticePath = notice?.workspacePath;
  useEffect(() => {
    if (!noticeKey || noticePhase === "initializing" || !noticePath) return;
    let disposed = false;
    let probing = false;
    const probe = () => {
      if (probing) return;
      probing = true;
      void readWorkspaceGitInfo(noticePath)
        .then((info) => {
          if (!disposed && noticeRef.current?.key === noticeKey && gitExists(info)) markCheckpointGitAvailable(noticePath);
        }, () => undefined)
        .finally(() => { probing = false; });
    };
    const interval = window.setInterval(probe, GIT_PROBE_MS);
    window.addEventListener("focus", probe);
    probe();
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", probe);
    };
  }, [markCheckpointGitAvailable, noticeKey, noticePath, noticePhase]);

  // A notification belongs to one local thread/folder. Retiring it permits a
  // later local run there to announce again; explicit Dismiss stays deduped.
  const retireOutOfScopeNotice = useCallback(() => {
    const current = noticeRef.current;
    if (!current) return;
    const projectStillExists = optionsRef.current.projectsRef.current.some((entry) => (
      entry.id === current.projectId && !entry.isChat
      && normalizedProjectPath(entry.path) === normalizedProjectPath(current.workspacePath)
    ));
    if (scopeIsActive(current) && projectStillExists) return;
    notifiedPathsRef.current.delete(normalizedProjectPath(current.workspacePath));
    setNotice(null);
  }, [scopeIsActive, setNotice]);

  useEffect(retireOutOfScopeNotice, [retireOutOfScopeNotice, options.activeThreadId, options.activeProjectId, options.activeExecutionPath, options.projectsRef.current]);

  // Zustand subscriptions retire the notice synchronously, before a stale
  // button or asynchronous result can run ahead of React's next render.
  useEffect(() => useActiveMachine.subscribe((state) => {
    if (state.machine !== LOCAL_MACHINE || state.shown !== LOCAL_MACHINE) retireOutOfScopeNotice();
  }), [retireOutOfScopeNotice]);
  useEffect(() => useTaskStore.subscribe((state) => {
    if (noticeRef.current && state.activeThreadId !== noticeRef.current.threadId) retireOutOfScopeNotice();
  }), [retireOutOfScopeNotice]);

  return {
    checkpointGitNotice: notice,
    showCheckpointGitNotice,
    markCheckpointGitAvailable,
    dismissCheckpointGitNotice,
    initializeCheckpointGit,
    isCheckpointGitInitializing,
  };
}
