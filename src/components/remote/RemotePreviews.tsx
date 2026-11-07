import { useEffect, useRef, useState } from "react";
import { Globe } from "lucide-react";
import { closeRemotePreview, listRemotePreviews, openRemotePreview, type RemotePreview } from "../../lib/remote/remotePreviews";

/** Web apps running on the other machine, next to Run. */
export function RemotePreviews({ device, workspaceId, threadId, name, onNotice }: {
  device: string; workspaceId: string; threadId?: string; name: string; onNotice: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [previews, setPreviews] = useState<RemotePreview[] | null>(null);
  const [running, setRunning] = useState<Record<string, string>>({});
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    let current = true;
    listRemotePreviews(device, workspaceId, threadId).then((found) => { if (current) setPreviews(found); }, () => { if (current) setPreviews([]); });
    const onPointerDown = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { current = false; document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [device, open, threadId, workspaceId]);
  const start = (preview: RemotePreview) => {
    openRemotePreview(device, preview.endpointId).then(({ previewId, notice }) => {
      onNotice(notice);
      if (previewId) setRunning((current) => ({ ...current, [preview.endpointId]: previewId }));
    }, () => onNotice(`Mythra Code couldn't open that preview from ${name}. Check that it's still running.`));
  };
  const stop = (endpointId: string) => {
    const previewId = running[endpointId];
    setRunning(({ [endpointId]: _closed, ...rest }) => rest);
    if (previewId) void closeRemotePreview(previewId).catch(() => undefined);
  };
  return <div className="remote-previews" ref={root}>
    <button type="button" className="icon-button" title={`Web previews on ${name}`} aria-label={`Web previews on ${name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}><Globe size={15} /></button>
    {open && <div className="remote-previews-menu" role="menu" aria-label={`Web previews on ${name}`}>
      {previews?.length ? previews.map((preview) => <div className="remote-preview-row" key={preview.endpointId}>
        <span>{preview.name}</span>
        {running[preview.endpointId] ? <button type="button" onClick={() => stop(preview.endpointId)}>Close</button> : <button type="button" onClick={() => start(preview)}>Open</button>}
      </div>) : <small>{previews ? `Web apps appear here when this thread mentions a local address on ${name}.` : "Looking…"}</small>}
    </div>}
  </div>;
}
