import { useCallback, useReducer, useRef } from "react";
import { rpc } from "../lib/codex";
import { friendlyError } from "../lib/errors";
import { shellCommand } from "../lib/shellCommand";
import { commandSandbox } from "../lib/turnConfig";
import { readWorkspaceGitInfo } from "../lib/worktrees";
import { CHECK_OUTPUT_BYTES_CAP, checkOutputTail, sanitizeProjectCheckCommand, type ProjectCheckResult } from "../lib/projectChecks";
import type { PermissionMode } from "../types";

const MAX_IDLE_CHECK_SCOPES = 6;
const CHECK_TIMEOUT_MS = 300_000;
const GIT_PREFLIGHT_TIMEOUT_MS = 3_000;

export interface ProjectCheckScope {
  projectId: string | null;
  threadId: string | null;
  cwd: string;
  command?: string;
  /** Saving or clearing and re-adding an identical command is a new config. */
  checkUpdatedAt?: number;
  permission: PermissionMode;
  additionalWritableRoots?: string[];
  /** Rechecked after Git preflight, before the shell command can start. */
  canStart?: () => boolean;
}

interface CheckRun {
  id: string;
  command: string;
  startedAt: number;
  cancelled: boolean;
  launched: boolean;
  cancelPreflight?: () => void;
  terminatePromise?: Promise<void>;
}

interface CheckSession {
  running: CheckRun | null;
  latest: ProjectCheckResult | null;
  touchedAt: number;
}

function scopeKey(scope: ProjectCheckScope): string | null {
  const command = sanitizeProjectCheckCommand({ command: scope.command })?.command;
  if (!scope.projectId || !scope.cwd || !command) return null;
  // A change to any of these makes the previous result ineligible for this view.
  return JSON.stringify([scope.projectId, scope.threadId, scope.cwd, command, scope.checkUpdatedAt ?? null]);
}

export function useProjectChecks(scope: ProjectCheckScope) {
  const [, rerender] = useReducer((value: number) => value + 1, 0);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const sessionsRef = useRef(new Map<string, CheckSession>());
  const liveByCwdRef = useRef(new Map<string, { run: CheckRun; session: CheckSession }>());
  const clockRef = useRef(0);

  const sessionFor = useCallback((key: string): CheckSession => {
    const sessions = sessionsRef.current;
    clockRef.current += 1;
    let session = sessions.get(key);
    if (!session) {
      session = { running: null, latest: null, touchedAt: clockRef.current };
      sessions.set(key, session);
    }
    session.touchedAt = clockRef.current;
    const selected = scopeKey(scopeRef.current);
    const idle = [...sessions.entries()]
      .filter(([entryKey, entry]) => entryKey !== selected && entryKey !== key && !entry.running)
      .sort((left, right) => left[1].touchedAt - right[1].touchedAt);
    for (let index = 0; idle.length - index > MAX_IDLE_CHECK_SCOPES; index += 1) {
      sessions.delete(idle[index][0]);
    }
    return session;
  }, []);

  const selectedKey = scopeKey(scope);
  const selected = selectedKey ? sessionsRef.current.get(selectedKey) : undefined;
  const live = liveByCwdRef.current.get(scope.cwd);

  const start = useCallback(async (): Promise<ProjectCheckResult | null> => {
    const snapshot = scopeRef.current;
    const key = scopeKey(snapshot);
    const command = sanitizeProjectCheckCommand({ command: snapshot.command })?.command;
    if (!key || !snapshot.projectId || !command || snapshot.canStart?.() === false) return null;
    if (liveByCwdRef.current.has(snapshot.cwd)) return null;
    const session = sessionFor(key);
    if (session.running) return null;
    const run: CheckRun = { id: crypto.randomUUID(), command, startedAt: Date.now(), cancelled: false, launched: false };
    session.running = run;
    session.latest = null;
    liveByCwdRef.current.set(snapshot.cwd, { run, session });
    rerender();

    const startedAt = run.startedAt;
    const cwd = snapshot.cwd;
    const projectId = snapshot.projectId;
    const threadId = snapshot.threadId;
    const permission = snapshot.permission;
    const writableRoots = [...(snapshot.additionalWritableRoots ?? [])];
    let head: string | null = null;
    let exitCode: number | null = null;
    let output = "";
    let outputTruncated = false;
    let error: string | undefined;
    try {
      // A missing repository or failed Git lookup does not prevent a check.
      // Git is optional metadata. A stalled native Git lookup must not pin the
      // check slot or make Stop wait for it to return.
      let preflightTimer: ReturnType<typeof setTimeout> | undefined;
      const preflightCancelled = new Promise<null>((resolve) => {
        run.cancelPreflight = () => resolve(null);
      });
      const preflightTimedOut = new Promise<null>((resolve) => {
        preflightTimer = setTimeout(() => resolve(null), GIT_PREFLIGHT_TIMEOUT_MS);
      });
      try {
        head = (await Promise.race([
          readWorkspaceGitInfo(cwd).catch(() => null),
          preflightCancelled,
          preflightTimedOut,
        ]))?.head ?? null;
      } finally {
        if (preflightTimer !== undefined) clearTimeout(preflightTimer);
        run.cancelPreflight = undefined;
      }
      if (!run.cancelled && snapshot.canStart?.() === false) {
        error = "The project became busy before checks started. Run checks again when it is ready.";
      }
      if (!run.cancelled && !error) {
        run.launched = true;
        const result = await rpc<{ exitCode: number; stdout: string; stderr: string }>("command/exec", {
          command: shellCommand(command),
          processId: run.id,
          cwd,
          tty: false,
          streamStdoutStderr: false,
          timeoutMs: CHECK_TIMEOUT_MS,
          outputBytesCap: CHECK_OUTPUT_BYTES_CAP,
          sandboxPolicy: commandSandbox(permission, cwd, writableRoots),
        });
        const bounded = checkOutputTail(result.stdout, result.stderr);
        output = bounded.output;
        outputTruncated = bounded.outputTruncated;
        if (Number.isInteger(result.exitCode)) exitCode = result.exitCode;
        else error = "The check ended without a valid exit code.";
      }
    } catch (reason) {
      error = friendlyError(reason).slice(0, 2_000);
    }
    // A command can settle while its terminate request is still in flight.
    // Report cancellation only after the runtime confirms that request.
    await run.terminatePromise?.catch(() => undefined);
    const finishedAt = Date.now();
    const status = run.cancelled ? "cancelled" : error ? "error" : exitCode === 0 ? "passed" : "failed";
    const latest: ProjectCheckResult = {
      id: run.id, projectId, threadId, cwd, command, head, startedAt, finishedAt,
      status, exitCode, output, outputTruncated,
      ...(error ? { error } : {}),
    };
    if (session.running === run) {
      session.running = null;
      session.latest = latest;
      if (liveByCwdRef.current.get(cwd)?.run === run) liveByCwdRef.current.delete(cwd);
      rerender();
    }
    return latest;
  }, [sessionFor]);

  const stop = useCallback(async (): Promise<void> => {
    const cwd = scopeRef.current.cwd;
    const live = liveByCwdRef.current.get(cwd);
    const run = live?.run;
    if (!run || run.cancelled) return;
    if (!run.launched) {
      run.cancelled = true;
      run.cancelPreflight?.();
      return;
    }
    if (!run.terminatePromise) {
      run.terminatePromise = rpc("command/exec/terminate", { processId: run.id })
        .then(() => { run.cancelled = true; })
        .catch((reason) => { throw new Error(friendlyError(reason)); })
        .finally(() => { run.terminatePromise = undefined; });
    }
    await run.terminatePromise;
  }, []);

  return {
    latest: selected?.latest ?? null,
    status: live ? "running" as const : selected?.latest?.status ?? "idle" as const,
    running: Boolean(live),
    startedAt: live?.run.startedAt ?? null,
    runningCommand: live?.run.command,
    start,
    stop,
  };
}
