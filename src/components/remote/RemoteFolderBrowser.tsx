import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Folder, FolderUp, LoaderCircle, X } from "lucide-react";
import { useModalFocus } from "../../hooks/useModalFocus";
import { safeErrorText } from "../../lib/errors";
import { addRemoteProject, browseRemoteFolders } from "../../lib/remote/remoteWork";
import type { FoldersBrowseResult } from "../../lib/remote/wire-studio";

/** Remote-only for a reason: a native folder dialog would open on the other
 * machine's screen, where the user can't see it. */
export function RemoteFolderBrowser({ device, name, onClose, onAdded }: {
  device: string;
  name: string;
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
      {error && <p className="remote-composer-error" role="alert">{error}</p>}
      <footer>
        <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
        <button type="button" className="primary-button" disabled={busy || !listing?.folder?.canAdd} onClick={add}>Add project</button>
      </footer>
    </div>
  </div>, document.querySelector(".app-shell") ?? document.body);
}
