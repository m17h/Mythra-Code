import { useCallback, useEffect, useId, useState } from "react";
import { Check, Pencil, RotateCcw, Save } from "lucide-react";
import { confirmDialog } from "../lib/confirmDialog";
import { globalInstructionFileIsEditable, readGlobalInstructionFile, registerGlobalInstructionFileFlusher, saveGlobalInstructionFile, type InstructionFileDescriptor } from "../lib/instructionFiles";

export interface GlobalInstructionEditorState {
  dirty: boolean;
  saving: boolean;
  failed: boolean;
}

interface EditorSession {
  base: InstructionFileDescriptor | null;
  draft: string;
  saving: boolean;
  reloading: boolean;
  confirming: boolean;
  available: boolean;
  phase: "idle" | "waiting" | "saving" | "saved" | "error" | "conflict";
  message: string;
  requiresReload: boolean;
  recoveryRequired: boolean;
  saveUncertain: boolean;
}

interface EditorController {
  session: { current: EditorSession };
  timer: { current: ReturnType<typeof window.setTimeout> | null };
  nextSaveAt: { current: number };
  running: { current: Promise<void> | null };
  callbacks: { current: {
    onSaved?: (file: InstructionFileDescriptor) => void;
    onStateChange: (state: GlobalInstructionEditorState) => void;
    currentSource: boolean;
  } };
  listeners: Set<() => void>;
  supersededRevisions: Set<string>;
}

// Memory-only owners survive a component remount, including in-flight writes
// and retained error drafts. Contents are never persisted to a separate store.
const editorControllers = new Map<string, EditorController>();

/** Keep retired paths with unresolved drafts reachable after Settings remounts. */
export function retainedGlobalInstructionEditorFiles(): InstructionFileDescriptor[] {
  return [...editorControllers.values()].flatMap((controller) => {
    const state = controller.session.current;
    if (!state.base) return [];
    const pending = state.draft !== state.base.content || state.saving || state.reloading || state.confirming
      || state.phase === "error" || state.phase === "conflict";
    return pending ? [state.base] : [];
  });

function rememberSupersededRevision(controller: EditorController, revision: string | null): void {
  if (!revision) return;
  controller.supersededRevisions.add(revision);
  if (controller.supersededRevisions.size > 64) {
    const oldest = controller.supersededRevisions.values().next().value;
    if (oldest) controller.supersededRevisions.delete(oldest);
  }
}

const SAVE_DELAY_MS = 500;
const MAX_FILE_BYTES = 32 * 1024;

/** Remains mounted when Settings is hidden; only the sensitive textarea is collapsed. */
export function GlobalInstructionFileEditor({ file, visible, currentSource, onSaved, onStateChange, onSaveDraftCopy }: {
  file: InstructionFileDescriptor;
  visible: boolean;
  currentSource: boolean;
  onSaved?: (file: InstructionFileDescriptor) => void;
  onStateChange: (state: GlobalInstructionEditorState) => void;
  onSaveDraftCopy: (content: string) => void;
}) {
  const [controller] = useState<EditorController>(() => {
    const key = `${file.provider}:${file.path}`;
    const existing = editorControllers.get(key);
    if (existing) return existing;
    const created: EditorController = {
      session: { current: {
        base: globalInstructionFileIsEditable(file) ? file : null,
        draft: file.content ?? "",
        saving: false,
        reloading: false,
        confirming: false,
        available: globalInstructionFileIsEditable(file) && currentSource,
        phase: "idle",
        message: "",
        requiresReload: false,
        recoveryRequired: false,
        saveUncertain: false,
      } },
      timer: { current: null },
      nextSaveAt: { current: 0 },
      running: { current: null },
      callbacks: { current: { onSaved, onStateChange, currentSource } },
      listeners: new Set(),
      supersededRevisions: new Set(),
    };
    editorControllers.set(key, created);
    return created;
  });
  const { session, timer, nextSaveAt, running, callbacks } = controller;
  const [view, setView] = useState(() => ({ ...session.current }));
  const [expanded, setExpanded] = useState(false);
  const editorId = useId();
  callbacks.current = { onSaved, onStateChange, currentSource };
  const publish = useCallback(() => {
    const state = session.current;
    for (const update of controller.listeners) update();
    // Publish edit ownership during the input/save event, before a preset can be applied.
    callbacks.current.onStateChange({
      dirty: Boolean(state.base && state.draft !== state.base.content),
      saving: state.saving || state.reloading || state.confirming,
      failed: state.phase === "error" || state.phase === "conflict",
    });
  }, [callbacks, controller, session]);
  useEffect(() => {
    const update = () => setView({ ...session.current });
    controller.listeners.add(update);
    publish();
    return () => { controller.listeners.delete(update); };
  }, [controller, publish, session]);
  const clearTimer = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, [timer]);

  const flush = useCallback(async function flush(force = false): Promise<void> {
    if (force) {
      clearTimer();
      nextSaveAt.current = 0;
    }
    if (running.current) {
      await running.current;
      if (force) await flush(true);
      return;
    }
    const state = session.current;
    if (!state.base || state.draft === state.base.content) return;
    if (state.requiresReload) throw new Error("The global instruction file requires reload or recovery.");
    if (state.reloading || state.confirming || state.phase === "error" || state.phase === "conflict") {
      throw new Error("The global instruction file has unsaved edits.");
    }
    // The write validates this exact revision and target on disk. A failed or
    // pending full discovery does not invalidate a successful file receipt.
    if (!state.available || !callbacks.current.currentSource) {
      state.phase = "error";
      state.message = "The original source is no longer available. Your draft is retained; reload the file or save your draft as a copy.";
      publish();
      throw new Error("The global instruction source is unavailable.");
    }
    if (new TextEncoder().encode(state.draft).length > MAX_FILE_BYTES) {
      state.phase = "error";
      state.message = "This draft exceeds the 32 KB file limit. Shorten it to save.";
      publish();
      throw new Error("The global instruction draft exceeds the file limit.");
    }
    const content = state.draft;
    const base = state.base;
    state.saving = true;
    state.phase = "saving";
    state.message = "";
    publish();
    const write = (async () => {
      try {
        const saved = await saveGlobalInstructionFile(base, content);
        // A successful response must describe the exact saved snapshot and target.
        if (saved.path !== base.path || saved.provider !== base.provider || saved.content !== content || !globalInstructionFileIsEditable(saved)) {
          throw new Error("GLOBAL_INSTRUCTION_SAVED_RELOAD");
        }
        rememberSupersededRevision(controller, base.revision);
        state.base = saved;
        state.available = true;
        state.phase = state.draft === content ? "saved" : "waiting";
        state.message = "";
        state.requiresReload = false;
        state.recoveryRequired = false;
        state.saveUncertain = false;
        callbacks.current.onSaved?.(saved);
      } catch (reason) {
        // Raw failures can include local secrets. Display only fixed messages.
        const errorCode = typeof reason === "string" ? reason : reason instanceof Error ? reason.message : "";
        const conflict = errorCode.includes("GLOBAL_INSTRUCTION_CONFLICT");
        const savedNeedsReload = errorCode.includes("GLOBAL_INSTRUCTION_SAVED_RELOAD");
        const recoveryRequired = errorCode.includes("GLOBAL_INSTRUCTION_RECOVERY_REQUIRED");
        const saveUncertain = errorCode.includes("GLOBAL_INSTRUCTION_SAVE_UNCERTAIN");
        state.requiresReload = savedNeedsReload || recoveryRequired || saveUncertain;
        state.recoveryRequired = recoveryRequired;
        state.saveUncertain = saveUncertain;
        state.phase = conflict || state.requiresReload ? "conflict" : "error";
        state.message = recoveryRequired
          ? "Saving needs recovery. The original file may be retained in a backup beside it, and its current location could not be confirmed. Your draft is retained. Inspect the file and retained backups, then reload before making further edits."
          : saveUncertain
          ? "The save outcome could not be confirmed; the file may have changed. Your latest draft is retained. Reload before making further edits."
          : savedNeedsReload
          ? "The file was saved, but its new revision could not be confirmed. Your latest draft is retained. Reload before making further file edits."
          : conflict
          ? "The file changed outside this editor. Your draft is retained; reload the file before editing again, or save your draft as a copy."
          : "Could not save the original file. Your draft is retained. Check file access, then retry.";
        clearTimer();
        throw new Error(state.requiresReload ? "Global instruction file needs reload or recovery." : conflict ? "Global instruction file changed externally." : "Global instruction file save failed.");
      } finally {
        state.saving = false;
        publish();
      }
    })();
    running.current = write;
    try {
      await write;
    } finally {
      if (running.current === write) running.current = null;
    }
    if (state.draft !== state.base?.content) {
      const delay = nextSaveAt.current - Date.now();
      clearTimer();
      if (force || delay <= 0) await flush(force);
      else timer.current = window.setTimeout(() => { timer.current = null; void flush().catch(() => {}); }, delay);
    }
  }, [callbacks, clearTimer, controller, nextSaveAt, publish, running, session, timer]);

  useEffect(() => registerGlobalInstructionFileFlusher(() => flush(true)), [flush]);
  useEffect(() => () => clearTimer(), [clearTimer]);
  useEffect(() => {
    const state = session.current;
    state.available = globalInstructionFileIsEditable(file) && currentSource;
    if (state.saving || state.reloading || state.confirming) return;
    if (state.requiresReload) {
      // Discovery alone cannot assert that an uncertain replacement/recovery
      // was resolved; keep the message and draft until explicit editor reload.
      publish();
      return;
    }
    // A prop captured before the receipt must not roll the editor back after save.
    if (currentSource && file.revision && controller.supersededRevisions.has(file.revision)) return;
    const dirty = Boolean(state.base && state.draft !== state.base.content);
    if (dirty) {
      if (!currentSource || !globalInstructionFileIsEditable(file) || file.revision !== state.base?.revision) {
        clearTimer();
        state.phase = "conflict";
        state.message = "The original source changed or is no longer available. Your draft is retained; reload the file or save your draft as a copy.";
      }
    } else if (globalInstructionFileIsEditable(file)) {
      if (file.revision !== state.base?.revision) {
        state.base = file;
        state.draft = file.content ?? "";
        state.phase = "idle";
        state.message = "";
        state.requiresReload = false;
        state.recoveryRequired = false;
        state.saveUncertain = false;
      }
    }
    publish();
  }, [clearTimer, controller, currentSource, file, publish, session, view.saving, view.reloading, view.confirming]);
  useEffect(() => {
    if (!visible) {
      setExpanded(false);
      // Navigation and Cancel flush the final keystroke while this owner stays mounted.
      void flush(true).catch(() => {});
    }
  }, [flush, visible]);
  const dirty = Boolean(view.base && view.draft !== view.base.content);
  const failed = view.phase === "error" || view.phase === "conflict";
  const change = (content: string) => {
    const state = session.current;
    state.draft = content;
    clearTimer();
    if (state.phase !== "conflict") {
      if (new TextEncoder().encode(content).length > MAX_FILE_BYTES) {
        state.phase = "error";
        state.message = "This draft exceeds the 32 KB file limit. Shorten it to save.";
      } else {
        state.phase = state.saving ? "saving" : content === state.base?.content ? "saved" : "waiting";
        state.message = "";
        nextSaveAt.current = Date.now() + SAVE_DELAY_MS;
        if (state.phase !== "saved") timer.current = window.setTimeout(() => { timer.current = null; void flush().catch(() => {}); }, SAVE_DELAY_MS);
      }
    }
    publish();
  };

  const retry = () => {
    const state = session.current;
    if (state.requiresReload || state.phase === "conflict") return;
    if (new TextEncoder().encode(state.draft).length > MAX_FILE_BYTES) return;
    state.phase = "waiting";
    state.message = "";
    publish();
    void flush(true).catch(() => {});
  };
  const reload = async () => {
    if (running.current || session.current.reloading || session.current.confirming) return;
    const state = session.current;
    clearTimer();
    // Pause ownership before opening an asynchronous dialog; no pending timer
    // may save a draft while the user decides whether to discard it.
    state.confirming = true;
    publish();
    let confirmed = false;
    try {
      confirmed = state.draft === state.base?.content || await confirmDialog("Reload the original instruction file and discard this editor draft? Saved file edits and prompt copies are not undone.");
    } finally {
      state.confirming = false;
    }
    if (!confirmed) {
      publish();
      void flush(true).catch(() => {});
      return;
    }
    state.reloading = true;
    publish();
    try {
      const fresh = await readGlobalInstructionFile(file);
      if (fresh.path !== file.path || fresh.provider !== file.provider || !globalInstructionFileIsEditable(fresh)) throw new Error("Source unavailable");
      if (state.base?.revision !== fresh.revision) rememberSupersededRevision(controller, state.base?.revision ?? null);
      state.base = fresh;
      state.draft = fresh.content ?? "";
      state.available = true;
      state.phase = "idle";
      state.message = "";
      state.requiresReload = false;
      state.recoveryRequired = false;
      state.saveUncertain = false;
      callbacks.current.onSaved?.(fresh);
    } catch {
      state.phase = "error";
      state.message = state.requiresReload
        ? "Could not reload this original file. Your draft is retained and saving remains blocked. Inspect the original file and any retained backups, then try Reload from disk again."
        : "Could not reload this original file. Your draft is retained. Check its path and file access, then try Reload from disk again.";
    } finally {
      state.reloading = false;
      publish();
    }
  };
  const discardDraft = async () => {
    if (running.current || session.current.reloading || session.current.confirming) return;
    const state = session.current;
    clearTimer();
    state.confirming = true;
    publish();
    let confirmed = false;
    try {
      confirmed = await confirmDialog("Discard this editor’s draft? Changes already saved to the original file and saved prompt copies are not undone. File reload or recovery requirements remain.");
    } finally {
      state.confirming = false;
    }
    if (!confirmed) {
      publish();
      void flush(true).catch(() => {});
      return;
    }
    state.draft = state.base?.content ?? "";
    if (!state.requiresReload) {
      state.phase = "idle";
      state.message = "";
    }
    publish();
  };

  if (!view.base) return null;
  return <div className="global-instruction-editor">
    <div className="instruction-file-actions">
      <button type="button" className="secondary-button" aria-expanded={expanded} aria-controls={editorId} onClick={() => setExpanded((current) => !current)}><Pencil size={12} /> {expanded ? "Hide file editor" : "Edit original file"}</button>
      <span className={`instruction-save-status ${failed ? "failed" : ""}`} role="status">{view.confirming ? "Waiting for confirmation…" : view.reloading ? "Reloading…" : view.saving ? "Saving…" : view.recoveryRequired ? "Recovery required" : view.saveUncertain ? "Save outcome unknown · reload required" : view.requiresReload ? "Saved · reload required" : failed ? "Not saved" : dirty ? "Waiting to save…" : view.phase === "saved" ? <><Check size={13} /> Saved to file</> : ""}</span>
    </div>
    {view.message && <p className="instruction-save-error" role="alert">{view.message}</p>}
    {failed && <div className="instruction-file-actions">
      <button type="button" className="secondary-button" disabled={view.saving || view.reloading || view.confirming || view.requiresReload || view.phase === "conflict" || !currentSource} onClick={retry}><RotateCcw size={12} /> Retry save</button>
      <button type="button" className="secondary-button" disabled={view.saving || view.reloading || view.confirming} onClick={() => { void reload(); }}><RotateCcw size={12} /> Reload from disk</button>
      {dirty && <button type="button" className="secondary-button" disabled={view.confirming} onClick={() => onSaveDraftCopy(view.draft)}><Save size={12} /> Save draft as copy</button>}
      {dirty && <button type="button" className="secondary-button" disabled={view.saving || view.reloading || view.confirming} onClick={() => { void discardDraft(); }}>Discard editor draft</button>}
    </div>}
    {expanded && visible && <div className="instruction-file-preview" id={editorId}>
      <label>Edit original {file.name}<textarea aria-label={`Edit original ${file.provider === "codex" ? "Codex" : "Claude"} ${file.name}`} value={view.draft} readOnly={view.reloading || view.confirming || view.requiresReload || !currentSource} onChange={(event) => change(event.target.value)} onBlur={() => { void flush(true).catch(() => {}); }} rows={8} spellCheck={false} /></label>
      <p className="instruction-editor-note">Edits save automatically to the original file. Settings Cancel does not undo file edits. App-specific provider prompts and saved copies change only when you choose a preset.</p>
    </div>}
  </div>;
}
