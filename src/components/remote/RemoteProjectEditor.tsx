import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useModalFocus } from "../../hooks/useModalFocus";
import { accessReason, hostProjectWrite, hostRead, hostRows } from "../../lib/remote/remoteActions";
import type { HostContextResult, WireParityReadResult } from "../../lib/remote/wire";

/** Remote-only for a reason: local Settings edits this device's projects, and
 * this one belongs to the other machine. */
export function RemoteProjectEditor({ device, name, workspaceId, projectName, context, onClose, onSaved }: {
  device: string; name: string; workspaceId: string; projectName: string; context: HostContextResult | undefined;
  onClose: () => void; onSaved: () => void;
}) {
  const [title, setTitle] = useState(projectName);
  const [prompt, setPrompt] = useState(context?.projectPrompt ?? "");
  const [mode, setMode] = useState<"append" | "replace">(context?.projectPromptMode ?? "replace");
  const [run, setRun] = useState(context?.run?.command ?? "");
  const [setup, setSetup] = useState(context?.run?.setupCommand ?? "");
  const [check, setCheck] = useState(context?.check?.command ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  /** What the host last said, which Save compares with. Typing beats a late read. */
  const saved = useRef({ prompt: context?.projectPrompt ?? "", mode: context?.projectPromptMode ?? "replace" });
  const edited = useRef(false);
  useModalFocus(dialog, true);
  useEffect(() => {
    let current = true;
    hostRead<WireParityReadResult>(device, "projects.instructions.read", { workspaceId }).then((result) => {
      const row = hostRows(result)[0];
      if (!current || !row) return;
      saved.current = { prompt: row.prompt ?? "", mode: row.mode === "append" ? "append" : "replace" };
      if (edited.current) return;
      setPrompt(saved.current.prompt);
      setMode(saved.current.mode);
    }, () => undefined);
    return () => { current = false; };
  }, [device, workspaceId]);
  const canManage = Boolean(context?.capabilities.manageProjects);
  const canShell = Boolean(context?.capabilities.terminal);
  const save = async () => {
    setSaving(true);
    setError("");
    const writes: [string, Record<string, unknown>, boolean][] = [
      ["projects.settings.set", { name: title.trim() }, title.trim() !== projectName],
      ["projects.instructions.set", { prompt, mode }, prompt !== saved.current.prompt || mode !== saved.current.mode],
      ["projects.run.set", { command: run.trim(), ...(setup.trim() ? { setupCommand: setup.trim() } : {}) }, canShell && (run !== (context?.run?.command ?? "") || setup !== (context?.run?.setupCommand ?? ""))],
      ["projects.check.set", { command: check.trim() }, canShell && check !== (context?.check?.command ?? "")],
    ];
    for (const [op, args, changed] of writes) {
      if (!changed) continue;
      // Each save changes the project, so each one is checked against the one before it.
      const outcome = await hostProjectWrite(device, name, workspaceId, op, args);
      if (!outcome.ok) { setError(outcome.message); setSaving(false); return; }
    }
    setSaving(false);
    onSaved();
  };
  return createPortal(<div className="remote-folder-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="remote-folder-browser remote-project-editor" role="dialog" aria-modal="true" aria-label={`Project settings on ${name}`} ref={dialog} tabIndex={-1}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <header>
        <strong>{projectName} on {name}</strong>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={15} /></button>
      </header>
      {!canManage && <p className="remote-folder-path" role="note">{accessReason(name, "change this project", "Manage projects")}</p>}
      <fieldset disabled={!canManage || saving}>
        <label><span>Name</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label><span>Project instructions</span><textarea rows={6} value={prompt} onChange={(event) => { edited.current = true; setPrompt(event.target.value); }} /></label>
        <label><span>Use with the app's instructions</span>
          <select value={mode} onChange={(event) => { edited.current = true; setMode(event.target.value === "append" ? "append" : "replace"); }}>
            <option value="replace">Replace</option>
            <option value="append">Add to them</option>
          </select>
        </label>
      </fieldset>
      <fieldset disabled={!canManage || !canShell || saving} title={canShell ? undefined : accessReason(name, "save commands", "Terminal")}>
        <label><span>Run command</span><input value={run} onChange={(event) => setRun(event.target.value)} spellCheck={false} /></label>
        <label><span>Setup command</span><input value={setup} onChange={(event) => setSetup(event.target.value)} spellCheck={false} /></label>
        <label><span>Check command</span><input value={check} onChange={(event) => setCheck(event.target.value)} spellCheck={false} /></label>
      </fieldset>
      {error && <p className="remote-composer-error" role="alert">{error}</p>}
      <footer>
        <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
        <button type="button" className="primary-button" disabled={!canManage || saving} onClick={() => void save()}>Save</button>
      </footer>
    </div>
  </div>, document.querySelector(".app-shell") ?? document.body);
}
