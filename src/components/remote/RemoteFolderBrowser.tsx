import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Folder, FolderUp, LoaderCircle, X } from "lucide-react";
import { useModalFocus } from "../../hooks/useModalFocus";
import { safeErrorText } from "../../lib/errors";
import { parseGitHubCloneTarget } from "../../lib/github";
import { accessReason } from "../../lib/remote/remoteActions";
import { addRemoteProject, browseRemoteFolders, readRemoteClone, startRemoteClone } from "../../lib/remote/remoteWork";
import type { FoldersBrowseResult } from "../../lib/remote/wire-studio";

const RECHECK_MS = 2_000;
/** The host gives up at 15 minutes, so this only outlasts it. */
const LONGEST_MS = 16 * 60_000;
const MISSED_ANSWERS = 30;
const MOST_FOLDER_PAGES = 20;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Remote-only for a reason: a native folder dialog would open on the other
 * machine's screen, where the user can't see it. */
export function RemoteFolderBrowser({ device, name, canClone, onClose, onAdded }: {
  device: string;
  name: string;
  /** Cloning runs Git on that machine, so it also needs Terminal. */
  canClone: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [listing, setListing] = useState<FoldersBrowseResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const request = useRef(0);
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog, true);
  const open = useCallback((folderId?: string) => {
    const current = ++request.current;
    setBusy(true);
    setError("");
    browseRemoteFolders(device, folderId)
      .then((next) => { if (current === request.current) setListing(next); })
      .catch((reason) => { if (current === request.current) setError(safeErrorText(reason, `Mythra Code couldn't read folders on ${name}. Try again.`)); })
      .finally(() => { if (current === request.current) setBusy(false); });
  }, [device, name]);
  useEffect(() => { open(); }, [open]);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloning, setCloning] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  /** Clones into this folder, then adds the result the way Add project does. */
  const cloneReason = canClone ? undefined : accessReason(name, "clone repositories", "Terminal");
  const clone = async () => {
    const parent = listing?.folder;
    const target = parseGitHubCloneTarget(cloneUrl);
    if (!parent) return;
    if (!target) { setError("Enter a valid GitHub repository address."); return; }
    setCloning(true);
    setError("");
    const fail = (message: string) => { if (mounted.current) { setError(message); setCloning(false); } };
    const started = await startRemoteClone(device, name, parent.id, target.url);
    if ("failure" in started) { fail(started.failure); return; }
    const deadline = Date.now() + LONGEST_MS;
    let missed = 0;
    for (;;) {
      await wait(RECHECK_MS);
      if (!mounted.current) return;
      if (Date.now() > deadline) { fail(`This clone is taking too long. Check the folder on ${name}.`); return; }
      try {
        const { state } = await readRemoteClone(device, started.handle);
        missed = 0;
        if (state === "completed") break;
        if (state === "timedOut") { fail(`This repository took too long to clone on ${name}. Try again.`); return; }
        if (state === "failed") { fail(`${name} couldn't clone that repository. Check the address, and that GitHub is connected on ${name}.`); return; }
      } catch {
        missed += 1;
        if (missed >= MISSED_ANSWERS) { fail(`Mythra Code lost track of this clone. Check the folder on ${name}.`); return; }
      }
    }
    try {
      let cursor: string | undefined;
      for (let page = 0; page < MOST_FOLDER_PAGES; page += 1) {
        const rows = await browseRemoteFolders(device, parent.id, cursor);
        const made = rows.folders.find((folder) => folder.name === started.folder);
        if (made) {
          const failure = await addRemoteProject(device, name, made.id);
          if (failure) fail(failure); else onAdded();
          return;
        }
        cursor = rows.cursor;
        if (!cursor) break;
      }
    } catch { /* Said below. */ }
    fail(`The repository was cloned on ${name}, but it couldn't be added. Open its folder here to add it.`);
  };
  const add = () => {
    const folder = listing?.folder;
    if (!folder?.canAdd) return;
    setBusy(true);
    setError("");
    void addRemoteProject(device, name, folder.id).then((failure) => {
      if (failure) { setError(failure); setBusy(false); } else onAdded();
    });
  };
  return createPortal(<div className="remote-folder-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="remote-folder-browser" role="dialog" aria-modal="true" aria-label={`Open a folder on ${name}`} ref={dialog} tabIndex={-1}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <header>
        <strong>Open a folder on {name}</strong>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={15} /></button>
      </header>
      <p className="remote-folder-path">{listing?.folder?.name ?? name}</p>
      <div className="remote-folder-list" role="list">
        {listing?.parent && <button type="button" onClick={() => open(listing.parent?.id)}><FolderUp size={14} aria-hidden="true" /><span>{listing.parent.name}</span></button>}
        {listing?.folders.map((folder) => <button type="button" key={folder.id} onClick={() => open(folder.id)}>
          <Folder size={14} aria-hidden="true" /><span>{folder.name}</span><ChevronRight size={13} aria-hidden="true" />
        </button>)}
        {busy && !listing && <p role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" /> Loading folders…</p>}
        {listing?.truncated && <p role="note">Only the first folders are shown.</p>}
      </div>
      {listing?.folder && <div className="remote-folder-clone">
        <input aria-label="GitHub repository address" placeholder="Clone a GitHub repository here: https://github.com/owner/name" value={cloneUrl} disabled={cloning || !canClone} title={cloneReason} maxLength={2048} onChange={(event) => setCloneUrl(event.target.value)} />
        <button type="button" className="secondary-button" disabled={cloning || !canClone || !cloneUrl.trim()} title={cloneReason} onClick={() => void clone()}>
          {cloning ? <><LoaderCircle size={13} className="spin" aria-hidden="true" /> Cloning…</> : "Clone here"}
        </button>
      </div>}
      {cloneReason && listing?.folder && <p className="remote-folder-note" role="note">{cloneReason}</p>}
      {error && <p className="remote-composer-error" role="alert">{error}</p>}
      <footer>
        <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
        <button type="button" className="primary-button" disabled={busy || cloning || !listing?.folder?.canAdd} onClick={add}>Add project</button>
      </footer>
    </div>
  </div>, document.querySelector(".app-shell") ?? document.body);
}
