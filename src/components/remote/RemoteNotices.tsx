import { X } from "lucide-react";
import { dismissRemoteNotice, openRemoteNotice, useRemoteNotices } from "../../lib/remote/activeMachine";

/** Remote notifications, in the app. Open is the only thing that switches machines. */
export function RemoteNotices() {
  const notices = useRemoteNotices((state) => state.notices);
  if (!notices.length) return null;
  return <div className="remote-notices" role="status" aria-live="polite">
    {notices.map((notice) => <div className="remote-notice" key={notice.id}>
      <div><strong>{notice.title}</strong><small>{notice.body}</small></div>
      <button type="button" className="remote-notice-open" onClick={() => openRemoteNotice(notice)}>Open</button>
      <button type="button" className="icon-button" aria-label={`Dismiss: ${notice.title}`} onClick={() => dismissRemoteNotice(notice.id)}><X size={13} /></button>
    </div>)}
  </div>;
}
