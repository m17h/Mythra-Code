import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";
import { LoaderCircle } from "lucide-react";
import { safeErrorText } from "../../lib/errors";
import { remoteAccessCancel, remoteAccessRequest, remoteAccessRespond, remoteAccessRetry, remoteFindNearby } from "../../lib/remote/client";
import {
  acceptRemoteSnapshot, computerWord, formatPairingCode, incomingRequests, LOCAL_NETWORK_BLOCKED, localNetworkBlocked,
  outgoingRequests, timeAgo, useRemoteDevices,
} from "../../lib/remote/devices";
import type { AccessDecision, AccessRequest, NearbyDevice, OutgoingAccessRequest, RemoteSnapshot } from "../../lib/remote/types";
import { LocalNetworkActions } from "./LocalNetworkActions";
import "./AccessRequests.css";

/** The one switch, word for word wherever it appears. */
export const HOSTING_LABEL = "Let my other computers use this one";

/** The code is only something to glance at if you want to be sure. Nothing waits on it. */
const Code = ({ code }: { code: string | null }) => code
  ? <span className="access-code" aria-label={`Code ${code.split("").join(" ")}`}>Code {formatPairingCode(code)}</span> : null;

/** The last Decline, for a few seconds of Undo, and declines taken back with it. */
interface DeclineMemory { last: { requestId: string; name: string } | null; reopened: ReadonlySet<string> }
export const useDeclines = create<DeclineMemory>(() => ({ last: null, reopened: new Set() }));
let undoTimer: ReturnType<typeof setTimeout> | undefined;
const UNDO_MS = 10_000;
function rememberDecline(request: AccessRequest) {
  const reopened = new Set(useDeclines.getState().reopened); reopened.delete(request.requestId);
  useDeclines.setState({ last: { requestId: request.requestId, name: request.name }, reopened });
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => useDeclines.setState({ last: null }), UNDO_MS);
}
/** Undo puts the card back exactly as it was; the answer is still this person's to give. */
function undoDecline() {
  const last = useDeclines.getState().last;
  if (!last) return;
  clearTimeout(undoTimer);
  useDeclines.setState((state) => ({ last: null, reopened: new Set([...state.reopened, last.requestId]) }));
}
/** "Declined ZEDS-PC · Undo", shown right after a Decline. */
export function DeclineUndo({ compact = false }: { compact?: boolean }) {
  const last = useDeclines((state) => state.last);
  if (!last) return null;
  return <div className={`access-undo ${compact ? "compact" : ""}`} role="status">
    <span>Declined {last.name}</span>
    <button type="button" className="access-link" onClick={undoDecline}>Undo</button>
  </div>;
}

/** Turns an action into a busy flag plus a plain error, the same way in every card. */
function useAction(onError?: (message: string) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = (work: () => Promise<RemoteSnapshot>, fallback: string) => {
    if (busy) return;
    setBusy(true); setError(""); onError?.("");
    work().then(acceptRemoteSnapshot).catch((reason) => { const text = safeErrorText(reason, fallback); setError(text); onError?.(text); }).finally(() => setBusy(false));
  };
  return { busy, error, run };
}

/** Someone wants to use this computer. It stays until it's answered. */
export function IncomingRequestCard({ request, compact = false }: { request: AccessRequest; compact?: boolean }) {
  const { busy, error, run } = useAction();
  const answer = (decision: AccessDecision) => run(async () => {
    const next = await remoteAccessRespond(request.fingerprint, request.requestId, decision);
    if (decision === "decline") rememberDecline(request);
    else useDeclines.setState((state) => { const reopened = new Set(state.reopened); reopened.delete(request.requestId); return { reopened }; });
    return next;
  }, "That didn't work. Try again.");
  return <div className={`access-card incoming ${compact ? "compact" : ""}`} role="group" aria-label={`${request.name} wants to use this computer`}>
    <strong className="access-title">{request.name} wants to use this computer</strong>
    {/* Anyone can pick a name, so it's labelled as theirs, not as proof. */}
    <span className="access-detail">The name that computer gave itself · <Code code={request.code} /></span>
    <span className="access-detail">Asked {timeAgo(request.createdAt)}.{request.reciprocal ? ` Allowing also lets this computer use ${request.name}.` : ""}</span>
    <span className="access-detail">Allow full use: it can open your projects and run commands here. View only lets it look without changing anything.</span>
    <div className="access-actions">
      <button type="button" className="primary-button" disabled={busy} onClick={() => answer("allow")}>Allow full use</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => answer("viewOnly")}>View only</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => answer("decline")}>Decline</button>
      {busy && <LoaderCircle size={14} className="spin" aria-hidden="true" />}
    </div>
    {error && <span className="access-error" role="alert">{error}</span>}
  </div>;
}

/** A declined request, kept 7 days in case the Decline was a mistake. */
export function DeclinedRow({ request }: { request: AccessRequest }) {
  const { busy, error, run } = useAction();
  const answer = (decision: AccessDecision) => run(() => remoteAccessRespond(request.fingerprint, request.requestId, decision), "That didn't work. Try again.");
  return <div className="set-row access-declined">
    <div className="set-copy">
      <strong>{request.name}</strong>
      <small>Declined · asked {timeAgo(request.createdAt)} · <Code code={request.code} /></small>
      {error && <small className="access-error" role="alert">{error}</small>}
    </div>
    <div className="set-control access-actions">
      <button type="button" className="secondary-button" disabled={busy} onClick={() => answer("allow")}>Allow full use</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => answer("viewOnly")}>View only</button>
    </div>
  </div>;
}

/** Results that need nothing from anyone: the computer simply appears, or the request is gone. */
const QUIET: ReadonlySet<OutgoingAccessRequest["state"]> = new Set(["allowed", "viewOnly", "cancelled"]);
/** The outgoing requests worth a card, newest first, one per computer. */
export function visibleOutgoing(snapshot: RemoteSnapshot | null | undefined): OutgoingAccessRequest[] {
  // A name is only what a computer calls itself; the key is who it is.
  const seen = new Set<string>();
  return [...outgoingRequests(snapshot)].sort((left, right) => right.createdAt - left.createdAt).filter((request) => {
    const key = request.fingerprint ?? request.requestId;
    if (QUIET.has(request.state) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The other computer is connecting back, so this is just slow, never a network problem.
const reverseReaching = (request: OutgoingAccessRequest) => request.reverseConnecting && (request.state === "connecting" || request.state === "failed");
/** Whether this card carries the Local Network help itself, so the general notice can step aside. */
export const showsLocalNetwork = (request: OutgoingAccessRequest) => !reverseReaching(request) && (request.state === "connecting" || request.state === "failed");

/** "waiting" until an epoch-ms time passes, then "passed"; one bounded timer, none when there's no time. */
function useWaitUntil(at: number | null): "none" | "waiting" | "passed" {
  const [, tick] = useState(0);
  const now = Date.now();
  useEffect(() => {
    if (at === null || at <= Date.now()) return;
    const timer = setTimeout(() => tick((value) => value + 1), Math.min(at - Date.now() + 50, 24 * 3600_000));
    return () => clearTimeout(timer);
  }, [at]);
  return at === null ? "none" : at <= now ? "passed" : "waiting";
}

/** This computer's own request to another, from asking to an answer. */
export function OutgoingRequestCard({ request, compact = false }: { request: OutgoingAccessRequest; compact?: boolean }) {
  const snapshot = useRemoteDevices((state) => state.snapshot);
  const blocked = localNetworkBlocked(snapshot);
  const { busy, error, run } = useAction();
  const cancel = () => run(() => remoteAccessCancel(request.requestId), "Mythra Code couldn't cancel that. Try again.");
  // Only the exact computer this request reached can be asked again. A name proves nothing,
  // so without a known key the person picks it again from Nearby computers.
  const known = request.fingerprint !== null;
  const waitUntil = useWaitUntil(request.state === "declined" ? request.retryAfter ?? null : null);
  const canAskAgain = known && (request.state === "declined" ? waitUntil === "passed" : request.state === "expired" || request.state === "failed");
  const again = () => run(() => remoteAccessRetry(request.requestId), "Mythra Code couldn't ask again. Try again.");
  // While a request is still live, Try again only nudges the connection; it never makes a new request.
  const nudge = () => run(() => remoteFindNearby(), "Mythra Code couldn't try again. Try again in a moment.");
  // A declined request can still turn into a yes on the other computer, so it stays cancellable.
  const live = request.state === "connecting" || request.state === "waiting" || request.state === "declined";
  const reaching = reverseReaching(request);
  const localNetwork = blocked && showsLocalNetwork(request);
  const title = reaching ? "Connecting…"
    : request.state === "connecting" ? `Asking ${request.name}…`
    : request.state === "waiting" ? `Waiting for ${request.name} to accept`
    : request.state === "declined" ? (canAskAgain ? `${request.name} declined` : `${request.name} declined. You can ask again later.`)
    : request.state === "expired" ? `${request.name} didn't answer`
    : `Couldn't ask ${request.name}`;
  const detail = reaching ? `${request.name} is opening the connection.`
    : localNetwork ? LOCAL_NETWORK_BLOCKED
    : request.state === "connecting" ? `This keeps trying while Mythra Code is open on ${request.name}.`
    : request.state === "waiting" ? `Answer on ${request.name}. You can close this; the request stays there until someone answers.`
    : request.state === "declined" ? `If ${request.name} changes its mind, you'll be connected without doing anything.`
    : !known ? "Choose it again under Nearby computers."
    : request.state === "expired" ? "Requests last 7 days. You can ask again."
    : request.error ?? `Make sure Mythra Code is open on ${request.name}, with ${HOSTING_LABEL} turned on.`;
  return <div className={`access-card outgoing ${compact ? "compact" : ""}`} role="status">
    <strong className="access-title">{(request.state === "connecting" || reaching) && !localNetwork && <LoaderCircle size={13} className="spin" aria-hidden="true" />}{title}</strong>
    {detail && <span className="access-detail">{detail}</span>}
    {request.code && live && request.state !== "declined" && <span className="access-detail"><Code code={request.code} /></span>}
    <div className="access-actions">
      {localNetwork && <LocalNetworkActions retrying={busy} onRetry={request.state === "connecting" ? nudge : canAskAgain ? again : nudge} />}
      {/* After a Decline the other computer won't take a new request until its wait ends. */}
      {canAskAgain && !localNetwork && <button type="button" className="secondary-button" disabled={busy} onClick={again}>{request.state === "failed" ? "Try again" : "Ask again"}</button>}
      {live ? <button type="button" className="secondary-button" disabled={busy} onClick={cancel}>{request.state === "declined" ? "Cancel request" : "Cancel"}</button>
        : !known && <button type="button" className="secondary-button" disabled={busy} onClick={cancel}>Dismiss</button>}
    </div>
    {error && <span className="access-error" role="alert">{error}</span>}
  </div>;
}

/** A nearby computer and the one question to ask it. The two-way box is on by default. */
export function NearbyRow({ device, snapshot, compact = false, onError }: { device: NearbyDevice; snapshot: RemoteSnapshot; compact?: boolean; onError?: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reciprocal, setReciprocal] = useState(true);
  const { busy, error, run } = useAction(onError);
  const here = computerWord(snapshot.platform);
  // Native turns this computer's own switch on with the request when the box is ticked.
  const request = () => run(() => remoteAccessRequest(device.instance, reciprocal), `Mythra Code couldn't ask ${device.name}. Try again.`);
  return <div className={`access-nearby ${open ? "open" : ""} ${compact ? "compact" : ""}`}>
    <button type="button" className={compact ? "machine-row" : "access-nearby-head"} aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      <span className="machine-row-name" title={device.name}>{device.name}</span>
      <span className="access-nearby-hint">Request access</span>
    </button>
    {open && <div className="access-nearby-body">
      <label className="access-check">
        <input type="checkbox" checked={reciprocal} disabled={busy} onChange={(event) => setReciprocal(event.target.checked)} />
        <span>Let {device.name} use this {here} too</span>
      </label>
      {reciprocal && <small className="access-detail">One Allow on {device.name} sets up both ways.{snapshot.hosting ? "" : ` This also turns on ${HOSTING_LABEL}.`}</small>}
      <div className="access-actions">
        <button type="button" className="primary-button" disabled={busy} onClick={request}>Request access</button>
        {busy && <LoaderCircle size={14} className="spin" aria-hidden="true" />}
      </div>
      {error && <span className="access-error" role="alert">{error}</span>}
    </div>}
  </div>;
}

/** Nearby computers, minus ones already on screen as a request card or a connected computer.
 * Names aren't identity, so a row is only folded away when its name is unique nearby;
 * two computers with the same name both stay listed. */
export function askableNearby(snapshot: RemoteSnapshot | null | undefined): NearbyDevice[] {
  if (!snapshot) return [];
  const count = new Map<string, number>();
  for (const device of snapshot.nearby) count.set(device.name, (count.get(device.name) ?? 0) + 1);
  const shown = new Set([...visibleOutgoing(snapshot).filter((request) => request.fingerprint !== null || request.state === "connecting" || request.state === "waiting").map((request) => request.name), ...snapshot.devices.filter((device) => device.canView).map((device) => device.name)]);
  return snapshot.nearby.filter((device) => count.get(device.name) !== 1 || !shown.has(device.name));
}

const NOTIFIED_LIMIT = 256;

/** A desktop notification for each new request, and for each of ours that was accepted. */
export function useAccessNotifications(enabled: boolean) {
  const snapshot = useRemoteDevices((state) => state.snapshot);
  const seen = useRef<Set<string> | null>(null);
  const waiting = useRef(new Map<string, string>());
  useEffect(() => {
    if (!snapshot) return;
    const incoming = incomingRequests(snapshot);
    const notify = (title: string, body: string) => {
      if (enabled) void isPermissionGranted().then((granted) => { if (granted) sendNotification({ title, body }); }).catch(() => undefined);
    };
    // The first snapshot is what was already there, not news. After that a request is
    // announced once, however often it reappears with a reconnect.
    if (seen.current === null) seen.current = new Set(incoming.map((request) => request.requestId));
    for (const request of incoming) if (!seen.current.has(request.requestId)) {
      seen.current.add(request.requestId);
      notify(`${request.name} wants to use this computer`, "Open Mythra Code to allow or decline.");
    }
    // Forget the oldest only, never the ones still waiting.
    for (const id of seen.current) {
      if (seen.current.size <= NOTIFIED_LIMIT) break;
      if (!incoming.some((request) => request.requestId === id)) seen.current.delete(id);
    }
    const outgoing = outgoingRequests(snapshot);
    for (const [id, name] of waiting.current) {
      const now = outgoing.find((request) => request.requestId === id);
      if (now && (now.state === "waiting" || now.state === "connecting")) continue;
      waiting.current.delete(id);
      if (now?.state === "allowed" || now?.state === "viewOnly") notify(`${name} accepted`, `You can now choose ${name} from the menu at the top of the sidebar.`);
      else if (now?.state === "declined") notify(`${name} declined`, "You can ask again later.");
    }
    for (const request of outgoing) if (request.state === "waiting" || request.state === "connecting") waiting.current.set(request.requestId, request.name);
  }, [enabled, snapshot]);
}
