/**
 * Which sub-agent capabilities a long-lived runtime thread was last configured
 * with, and in which app-server process.
 *
 * Provider lifetimes differ, and the difference decides whether a settings
 * change reaches the model at all:
 *
 * - Claude Code and Cursor Agent start a fresh process per turn, so every turn
 *   already carries the current sub-agent flags and the current bridge config.
 * - The Codex app server keeps one thread alive across turns. Startup-only
 *   `config` is ignored when `thread/resume` merely rejoins an already loaded
 *   thread, so a capability change for such a thread first refreshes the
 *   managed app-server and then resumes the same durable thread with the new
 *   config.
 *
 * Both halves of that decision are needed, which is why every record is keyed
 * by the app-server instance that produced it:
 *
 * - Same instance, different capabilities → the thread really is loaded with
 *   the wrong config, and only a runtime refresh can replace it.
 * - Different instance → that process is gone and took its loaded threads with
 *   it, so a plain resume applies the new config. Restarting a runtime that
 *   has nothing loaded would cost the user a needless interruption.
 *
 * Records are durable because the renderer can reload without replacing
 * app-server, and a reload must not be mistaken for a runtime restart.
 */

import { loadStored, storeValue } from "./storage";
import type { NativeSubagentOptions } from "../types";
import { sanitizeNativeSubagentMax, sanitizeNativeSubagentOptions } from "./threadSubagentSettings";

const STORAGE_KEY = "kiwi.threadSubagentCapabilities";
/** Bump whenever startup-only routing policy changes for loaded threads. */
const RUNTIME_POLICY_REVISION = "managed-v3";
/** Longest signature worth trusting from disk; real ones are far shorter. */
const MAX_SIGNATURE_LENGTH = 1024;

interface AppliedCapabilities {
  /** App-server process that was told this, from {@link runtimeInstanceId}. */
  instance: string;
  signature: string;
}

function loadApplied(): Map<string, AppliedCapabilities> {
  const stored = loadStored<Record<string, unknown>>(STORAGE_KEY, {});
  return new Map(Object.entries(stored).flatMap(([threadId, record]) => {
    if (!threadId.trim() || !record || typeof record !== "object") return [];
    const { instance, signature } = record as Partial<AppliedCapabilities>;
    if (typeof instance !== "string" || !instance) return [];
    if (typeof signature !== "string" || signature.length > MAX_SIGNATURE_LENGTH) return [];
    return [[threadId, { instance, signature }] as const];
  }));
}

/** Capabilities last applied to a runtime thread, keyed by thread id. */
const applied = loadApplied();

function persistApplied(): void {
  storeValue(STORAGE_KEY, Object.fromEntries(applied));
}

export interface SubagentCapabilities {
  subagentsEnabled: boolean;
  subagentMax: number;
  subagentEngine?: "mythra" | "native";
  nativeSubagentMax?: number;
  nativeSubagentOptions?: NativeSubagentOptions;
  autoCompactTokens?: number;
  /** Concrete bridge launch backing delegation, including its fresh token file. */
  bridgeInstanceId?: string;
}

export function subagentCapabilitySignature(capabilities: SubagentCapabilities): string {
  // A parallel limit only means something while sub-agents are on, so nudging
  // it with the feature switched off is not a reason to reconfigure anything.
  const route = capabilities.subagentsEnabled ? capabilities.subagentEngine === "native" ? "native" : "on" : "off";
  const max = route === "native" ? sanitizeNativeSubagentMax(capabilities.nativeSubagentMax)
    : capabilities.subagentsEnabled ? Math.max(1, Math.floor(capabilities.subagentMax) || 1) : 1;
  const nativeOptions = route === "native" ? sanitizeNativeSubagentOptions(capabilities.nativeSubagentOptions)?.codex : undefined;
  return `${RUNTIME_POLICY_REVISION}:${route}:${max}:${capabilities.bridgeInstanceId ?? ""}${route === "native" ? `:${JSON.stringify(nativeOptions ?? {})}` : ""}:compact=${capabilities.autoCompactTokens ?? "default"}`;
}

export interface SubagentCapabilityPlan {
  /**
   * The current app-server is holding this thread with different capabilities.
   * It only reads config while loading a thread, so nothing short of a fresh
   * runtime can replace them.
   */
  restartRuntime: boolean;
  /** Resume this thread with the full runtime config before the turn starts. */
  resume: boolean;
}

const UNCHANGED: SubagentCapabilityPlan = { restartRuntime: false, resume: false };

/**
 * What has to happen before this thread's next turn so the runtime really has
 * the capabilities the app is showing.
 *
 * Even an off-policy thread requires evidence for a loaded process. Managed
 * defaults do not prove how an unknown thread was originally configured.
 */
export function planSubagentCapabilities(
  threadId: string,
  runtimeInstance: string,
  signature: string,
  runtimeLoaded = true,
): SubagentCapabilityPlan {
  const record = applied.get(threadId);
  // A durable transcript can be displayed without loading it into app-server.
  // A fresh runtime therefore needs one resume, never a restart, regardless of
  // what an older process was configured with.
  if (!runtimeLoaded) return { restartRuntime: false, resume: true };
  // A record from an earlier app-server describes a process that no longer
  // exists. If this replacement nevertheless loaded the thread through a
  // different renderer path, its startup config is unknown and must be
  // replaced rather than silently ignored by another resume.
  if (record && record.instance !== runtimeInstance) {
    return { restartRuntime: true, resume: true };
  }
  // Missing evidence is not an off-policy guarantee: this process may have
  // loaded the thread through another path or restored a native transcript.
  // A warm resume ignores startup config, including explicit disabled flags.
  if (!record) return { restartRuntime: true, resume: true };
  if (record.signature === signature) return UNCHANGED;
  return { restartRuntime: true, resume: true };
}

/** Record the capabilities a `thread/start` or `thread/resume` just applied. */
export function recordSubagentCapabilities(threadId: string, runtimeInstance: string, signature: string): void {
  applied.set(threadId, { instance: runtimeInstance, signature });
  persistApplied();
}

/**
 * Compatibility helper for a verified cold startup, without overwriting what
 * the same app-server was already told. A missing record does not prove the
 * thread was unloaded: callers must establish that separately before seeding.
 * Current startup paths record only after their guarded startup succeeds.
 */
export function seedSubagentCapabilities(threadId: string, runtimeInstance: string, signature: string): void {
  const record = applied.get(threadId);
  if (record && record.instance === runtimeInstance) return;
  recordSubagentCapabilities(threadId, runtimeInstance, signature);
}

/**
 * Forget one thread, or every thread. A forgotten thread is re-evaluated from
 * scratch, which is the right answer after its runtime state was discarded.
 */
export function forgetSubagentCapabilities(threadId?: string): void {
  if (threadId === undefined) applied.clear();
  else applied.delete(threadId);
  persistApplied();
}
