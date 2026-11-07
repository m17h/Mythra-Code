import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Link2 } from "lucide-react";
import { safeErrorText } from "../../lib/errors";
import { remotePairCancel, remotePairingCancelRequest, remotePairingRespond, remotePairOfferRespond } from "../../lib/remote/client";
import { consumeEscapeUntilRelease } from "../../lib/remote/focus";
import {
  acceptRemoteSnapshot,
  formatPairingCode,
  useRemoteDevices,
  VIEW_ONLY_GRANT,
} from "../../lib/remote/devices";
import type { PairingFlow, PairingRequest } from "../../lib/remote/types";

const CONSENT = "View shows conversations on this computer, including anything models or tools printed. Work lets the other device run tasks here and approve their commands, and those commands aren't limited to one project.";
const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";
type ReturnFocusRef = RefObject<HTMLButtonElement | null>;

function canFocus(element: HTMLElement | null): element is HTMLElement {
  return Boolean(element?.isConnected && !element.closest("[inert], [hidden]")
    && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
}

function otherModalIsOpen(): boolean {
  return [...document.querySelectorAll<HTMLElement>('dialog[open], [aria-modal="true"], [role="dialog"][popover]')]
    .some((element) => !element.closest("[data-pairing-sheet]")
      && !element.classList.contains("settings-modal") && canFocus(element));
}

/** Native timeline/image dialogs live outside App's modal state. Let those
 * finish first too; observe only while pairing is pending, with no idle poll. */
function useOtherModal(pending: boolean): boolean {
  const [blocked, setBlocked] = useState(false);
  useLayoutEffect(() => {
    if (!pending) { setBlocked(false); return; }
    const refresh = () => setBlocked(otherModalIsOpen());
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "hidden", "aria-hidden"] });
    document.addEventListener("toggle", refresh, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("toggle", refresh, true);
    };
  }, [pending]);
  // Check synchronously before mounting a focus trap over an existing one.
  return pending && (blocked || otherModalIsOpen());
}

/** The app defers pairing behind voice and already-open global dialogs. Once
 * shown, this sheet owns document focus and Escape, above Settings. A removed
 * disclosure row falls back to the persistent machine-switcher trigger. */
function PairingDialog({ title, announcement, children, actions, onEscape, returnFocusRef, alert = false, busy = false }: {
  title: string;
  announcement: string;
  children: ReactNode;
  actions: ReactNode;
  onEscape: () => void;
  returnFocusRef?: ReturnFocusRef;
  alert?: boolean;
  busy?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  const titleId = useId();
  const descriptionId = useId();

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const controls = () => [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(canFocus);
    const focusDefault = () => {
      const preferred = dialog.querySelector<HTMLElement>("[data-autofocus]:not([disabled])");
      (canFocus(preferred) ? preferred : controls()[0] ?? dialog).focus({ preventScroll: true });
    };
    const onFocus = (event: FocusEvent) => {
      if (!dialog.contains(event.target as Node)) focusDefault();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        consumeEscapeUntilRelease();
        if (!event.repeat) escapeRef.current();
      } else if (event.key === "Tab") {
        const items = controls();
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (!first || !dialog.contains(active) || active === dialog) {
          event.preventDefault();
          (event.shiftKey ? last ?? dialog : first ?? dialog).focus();
        } else if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("keydown", onKeyDown, true);
    focusDefault();
    return () => {
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("keydown", onKeyDown, true);
      const active = document.activeElement;
      if (active && active !== document.body && !dialog.contains(active)) return;
      const destination = canFocus(opener) && opener !== document.body ? opener : returnFocusRef?.current ?? null;
      if (canFocus(destination)) destination.focus({ preventScroll: true });
    };
  }, [returnFocusRef]);

  return (
    <div className="modal-backdrop confirm-backdrop pairing-backdrop" data-pairing-sheet="">
      <div className="confirm-dialog pairing-sheet" role={alert ? "alertdialog" : "dialog"} aria-modal="true"
        aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy || undefined} ref={dialogRef} tabIndex={-1}>
        <div className="confirm-dialog-icon"><Link2 size={17} aria-hidden="true" /></div>
        <h2 id={titleId}>{title}</h2>
        <div className="pairing-description" id={descriptionId}>{children}</div>
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
        <div className="confirm-dialog-actions">{actions}</div>
      </div>
    </div>
  );
}

function PairingCode({ code }: { code: string }) {
  return <p className="pairing-code"><span aria-hidden="true">{formatPairingCode(code)}</span>
    <span className="sr-only">Pairing code {code.split("").join(" ")}</span></p>;
}

/** The approval sheet only appears on the host. */
function ApprovalSheet({ request, returnFocusRef }: { request: PairingRequest; returnFocusRef?: ReturnFocusRef }) {
  const [work, setWork] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const answer = (approve: boolean) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    remotePairingRespond(request.id, approve, approve ? { ...VIEW_ONLY_GRANT, work } : undefined)
      .then(acceptRemoteSnapshot)
      .catch((reason) => setError(safeErrorText(reason, "That didn't work. Try again.")))
      // Success either ends this sheet or turns it into the waiting state below.
      .finally(() => {
        pending.current = false;
        setBusy(false);
      });
  };
  const stopWaiting = () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    remotePairingCancelRequest()
      .then(acceptRemoteSnapshot)
      .catch((reason) => setError(safeErrorText(reason, "That didn't work. Try again.")))
      .finally(() => {
        pending.current = false;
        setBusy(false);
      });
  };
  const name = request.name ?? "A device";
  if (request.approved) {
    // With an offer both people have to agree, and either may answer first.
    return (
      <PairingDialog title={`Waiting for ${name}`} busy={busy} returnFocusRef={returnFocusRef}
        announcement={`Approved. Waiting for ${name} to accept.`}
        onEscape={() => undefined}
        actions={<button type="button" className="secondary-button" data-autofocus disabled={busy} onClick={stopWaiting}>Stop waiting</button>}>
        <p>You approved this device. Pairing finishes once it accepts too.</p>
        <PairingCode code={request.code} />
        {error && <p className="confirm-dialog-footnote" role="alert">{error}</p>}
      </PairingDialog>
    );
  }
  return (
    <PairingDialog title={`Approve ${name}?`} alert busy={busy} returnFocusRef={returnFocusRef}
      announcement={`${name} is asking to pair. Pairing code ${request.code.split("").join(" ")}. Compare it with the other device.`}
      // A host grant always needs an explicit decision, never an Escape key.
      onEscape={() => undefined}
      actions={<>
        <button type="button" className="secondary-button" data-autofocus disabled={busy} onClick={() => answer(false)}>Deny</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => answer(true)}>Codes match, approve</button>
      </>}>
      <p>Approve only if this code matches the one on the other device. If it doesn't match, or you didn't start this, choose Deny.</p>
      <PairingCode code={request.code} />
      <p className="pairing-note">{CONSENT}</p>
      <label className="pairing-grant">
        <input type="checkbox" checked={work} disabled={busy} onChange={(event) => setWork(event.target.checked)} />
        <span>Also allow <strong>Work</strong>. Without it, the other device can only look.</span>
      </label>
      <p className="pairing-note">You can change or remove this access at any time in Settings → Connections → Devices.</p>
      {error && <p className="confirm-dialog-footnote" role="alert">{error}</p>}
    </PairingDialog>
  );
}

/** The viewer's own decision about an offer. Nothing is stored or sent until
 * this says yes. It is a separate step from the host's approval, which grants
 * access: this one only agrees to use the other device. */
export function ViewerOfferSheet({ peerName, code, onRespond, returnFocusRef }: {
  peerName: string;
  code: string;
  onRespond: (accept: boolean) => Promise<void>;
  returnFocusRef?: ReturnFocusRef;
}) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const respond = (accept: boolean) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    void onRespond(accept).catch((reason) => {
      pending.current = false;
      setBusy(false);
      setError(safeErrorText(reason, "Mythra Code couldn't answer the offer. Try again."));
    });
  };
  return <PairingDialog title={`Accept an offer from ${peerName}?`} returnFocusRef={returnFocusRef} busy={busy}
    announcement={`${peerName} is offering access. Pairing code ${code.split("").join(" ")}. Compare it with the other device.`}
    onEscape={() => respond(false)} actions={<>
      <button type="button" className="secondary-button" data-autofocus disabled={busy} onClick={() => respond(false)}>Decline</button>
      <button type="button" className="primary-button" disabled={busy} onClick={() => respond(true)}>Codes match, accept</button>
    </>}>
    <p>{peerName} is offering to let this device use it. Accept only if the code matches the one on {peerName}.</p>
    <PairingCode code={code} />
    <p className="pairing-note">Accepting does not share this device's conversations, accounts or files.</p>
    {error && <p className="confirm-dialog-footnote" role="alert">{error}</p>}
  </PairingDialog>;
}

/** Viewer-side pairing progress; native state owns the in-flight operation. */
function FlowSheet({ flow, onManageDevices, returnFocusRef }: { flow: PairingFlow; onManageDevices: () => void; returnFocusRef?: ReturnFocusRef }) {
  const [closing, setClosing] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const close = async (manage = false) => {
    if (pending.current) return;
    pending.current = true;
    setClosing(true);
    setError("");
    try {
      acceptRemoteSnapshot(await remotePairCancel());
      if (manage) onManageDevices();
    } catch (reason) {
      pending.current = false;
      setClosing(false);
      setError(safeErrorText(reason, "Mythra Code couldn't close pairing. Try again."));
    }
  };
  const finished = flow.stage === "done" || flow.stage === "failed";
  const title = flow.stage === "done"
    ? `Paired with ${flow.target}`
    : flow.stage === "failed"
      ? "Pairing didn't finish"
      : flow.stage === "comparing"
        ? "Compare this code"
        : `Connecting to ${flow.target}…`;
  const description = flow.stage === "comparing"
    ? `${flow.target} is showing a code. Make sure it matches this one, then approve there.`
    : flow.stage === "connecting"
      ? "This usually takes a few seconds."
      : flow.stage === "failed"
        ? flow.error ?? "Try pairing again from Devices settings."
        : "You can now choose this device from the switcher above New thread.";
  const announcement = `${title}. ${description}${flow.stage === "comparing" && flow.code ? ` Pairing code ${flow.code.split("").join(" ")}.` : ""}`;
  return <PairingDialog title={title} announcement={announcement} busy={closing} returnFocusRef={returnFocusRef}
    onEscape={() => void close()} actions={<>
      {flow.stage === "failed" && <button type="button" className="secondary-button" disabled={closing} onClick={() => void close(true)}>Open Devices settings</button>}
      <button type="button" className={finished ? "primary-button" : "secondary-button"} data-autofocus disabled={closing} onClick={() => void close()}>{finished ? "Done" : "Cancel"}</button>
    </>}>
    <p>{description}</p>
    {flow.stage === "comparing" && flow.code && <PairingCode code={flow.code} />}
    {error && <p className="confirm-dialog-footnote" role="alert">{error}</p>}
  </PairingDialog>;
}

/** Portal outside the sidebar's inert boundary. Voice and already-open global
 * dialogs take priority; pending pairing still blocks new app shortcuts. */
export function PairingSheets({ onManageDevices, blocked, returnFocusRef }: {
  onManageDevices: () => void;
  blocked: boolean;
  returnFocusRef?: ReturnFocusRef;
}) {
  const request = useRemoteDevices((state) => state.snapshot?.pairing?.request ?? null);
  const flow = useRemoteDevices((state) => state.snapshot?.flow ?? null);
  const otherModal = useOtherModal(Boolean(request || flow));
  const flowId = flow?.id;
  // Names the offer on screen, so a newer one cannot collect this answer.
  const respondToOffer = useCallback(async (accept: boolean) => {
    if (flowId === undefined) return;
    acceptRemoteSnapshot(await remotePairOfferRespond(flowId, accept));
  }, [flowId]);
  const host = document.querySelector(".app-shell");
  if (!host || blocked || otherModal) return null;
  if (request) return createPortal(<ApprovalSheet key={request.id} request={request} returnFocusRef={returnFocusRef} />, host);
  if (flow?.stage === "offered" && flow.code) {
    return createPortal(<ViewerOfferSheet key={flow.id} peerName={flow.target} code={flow.code} onRespond={respondToOffer} returnFocusRef={returnFocusRef} />, host);
  }
  if (flow) return createPortal(<FlowSheet flow={flow} onManageDevices={onManageDevices} returnFocusRef={returnFocusRef} />, host);
  return null;
}
