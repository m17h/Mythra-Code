import { create } from "zustand";
import { isWindowsPlatform } from "../platform";
import { listenRemoteChanged, remoteSnapshot } from "./client";
import type { AccessDecision, DeviceGrant, AccessRequest, OutgoingAccessRequest, RemoteDevice, RemotePlatform, RemoteSnapshot } from "./types";

/**
 * This installation's devices and links, as reported by the native host. It
 * holds no host content. Reading it never touches the network.
 */
interface RemoteDevicesState {
  snapshot: RemoteSnapshot | null;
  initialization: "idle" | "loading" | "ready" | "failed";
  initializationError: string | null;
}

export const useRemoteDevices = create<RemoteDevicesState>(() => ({
  snapshot: null,
  initialization: "idle",
  initializationError: null,
}));

const NO_INCOMING: readonly AccessRequest[] = [];
const NO_OUTGOING: readonly OutgoingAccessRequest[] = [];
const allIncoming = (snapshot: RemoteSnapshot | null | undefined) => snapshot?.accessRequests ?? NO_INCOMING;
const NO_IDS: ReadonlySet<string> = new Set();
interface IncomingLists { pending: readonly AccessRequest[]; declined: readonly AccessRequest[] }
const incomingLists = new WeakMap<readonly AccessRequest[], WeakMap<ReadonlySet<string>, IncomingLists>>();
function requestLists(snapshot: RemoteSnapshot | null | undefined, reopened: ReadonlySet<string>): IncomingLists {
  const rows = allIncoming(snapshot);
  let cache = incomingLists.get(rows);
  if (!cache) { cache = new WeakMap(); incomingLists.set(rows, cache); }
  const found = cache.get(reopened); if (found) return found;
  const pending = rows.filter((request) => request.status !== "declined" || reopened.has(request.requestId));
  const declined = rows.filter((request) => request.status === "declined" && !reopened.has(request.requestId));
  const result = { pending: pending.length === rows.length ? rows : pending.length ? pending : NO_INCOMING,
    declined: declined.length === rows.length ? rows : declined.length ? declined : NO_INCOMING };
  cache.set(reopened, result); return result;
}
/** Undo only reopens the native card; it cannot change its answer or grant. */
export const incomingRequests = (snapshot: RemoteSnapshot | null | undefined, reopened: ReadonlySet<string> = NO_IDS) => requestLists(snapshot, reopened).pending;
export const declinedRequests = (snapshot: RemoteSnapshot | null | undefined, reopened: ReadonlySet<string> = NO_IDS) => requestLists(snapshot, reopened).declined;
export const outgoingRequests = (snapshot: RemoteSnapshot | null | undefined) => snapshot?.outgoingRequests ?? NO_OUTGOING;
/** What people call this kind of computer, for "this Mac" and "this PC". */
export const computerWord = (platform: RemotePlatform | null | undefined) => platform === "macos" ? "Mac" : platform === "windows" ? "PC" : "computer";
/** "just now", "5 min ago", "2 hours ago", "3 days ago". */
export function timeAgo(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** A delayed command reply may never restore an answered/cancelled card or an
 * old device grant over a newer event. Equal generations are duplicate state. */
export function acceptRemoteSnapshot(next: RemoteSnapshot): boolean {
  if (!next || !Number.isSafeInteger(next.generation) || next.generation < 0) return false;
  const current = useRemoteDevices.getState().snapshot;
  if (current && next.generation <= current.generation) return false;
  // Older native builds may retain the old modal handshake. It has no place in
  // this store: new incoming/outgoing requests are persistent, non-modal cards.
  const { pairing: _pairing, flow: _flow, ...snapshot } = next as RemoteSnapshot & { pairing?: unknown; flow?: unknown };
  useRemoteDevices.setState({ snapshot: { ...snapshot,
    accessRequests: Array.isArray(next.accessRequests) ? next.accessRequests : [],
    outgoingRequests: Array.isArray(next.outgoingRequests) ? next.outgoingRequests : [],
  } });
  return true;
}

type InitializationUpdate = Pick<RemoteDevicesState, "initialization" | "initializationError">;
interface DeviceSyncHooks {
  subscribe(receive: (snapshot: RemoteSnapshot) => void): Promise<() => void>;
  read(): Promise<RemoteSnapshot>;
  accept(snapshot: RemoteSnapshot): boolean;
  status(update: InitializationUpdate): void;
}
/** One installation-wide subscription, shared by picker/settings. Kept separate
 * from React lifetimes so toggling either surface never drops pending answers. */
export function createRemoteDevicesSync(hooks: DeviceSyncHooks): { start(): Promise<void> } {
  let initialized = false;
  let starting: Promise<void> | null = null;
  let stopListening: (() => void) | null = null;
  const ready = () => {
    if (initialized) return;
    initialized = true;
    hooks.status({ initialization: "ready", initializationError: null });
  };
  const receive = (snapshot: RemoteSnapshot) => { if (hooks.accept(snapshot)) ready(); };
  return { start() {
    if (starting) return starting;
    if (initialized) return Promise.resolve();
    hooks.status({ initialization: "loading", initializationError: null });
    starting = Promise.resolve().then(async () => {
      try {
        stopListening ??= await hooks.subscribe(receive);
        const snapshot = await hooks.read();
        if (!snapshot || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0) throw new Error("Invalid device state");
        hooks.accept(snapshot); ready();
      } catch {
        // An authoritative event can win while a stale initial read fails.
        if (!initialized) hooks.status({ initialization: "failed", initializationError: "Mythra Code couldn't load your devices. Choose Try again." });
      }
    }).finally(() => { starting = null; });
    return starting;
  } };
}
const devicesSync = createRemoteDevicesSync({ subscribe: listenRemoteChanged, read: remoteSnapshot, accept: acceptRemoteSnapshot,
  status: (state) => useRemoteDevices.setState(state) });
export function startRemoteDevices(): void { void devicesSync.start(); }

export function localMachineLabel(snapshot: RemoteSnapshot | null): string {
  const windows = snapshot ? snapshot.platform === "windows" : isWindowsPlatform();
  return windows ? "This PC" : snapshot?.platform === "other" ? "This device" : "This Mac";
}

export function formatPairingCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

/** The status dot. A device that only views this one shows that link instead. */
export function deviceDotState(device: RemoteDevice): RemoteDevice["state"] {
  if (device.state !== "none") return device.state;
  return device.hosting ? "connected" : "offline";
}

export function deviceStateLabel(device: RemoteDevice): string {
  switch (device.state) {
    case "none": return device.hosting ? "Connected" : "Offline";
    case "connected": return "Connected";
    case "connecting": return "Connecting…";
    case "stale": return "Connection lost";
    case "unreachable": return "Can't reach";
    case "incompatible": return "Update needed";
    case "accessRemoved": return "Access removed";
    default: return "Offline";
  }
}

/** What to do about a device, or `null` if nothing is wrong. A failed connection
 * proves nothing about why, so everything unproven here says "may". */
export function deviceHelp(device: RemoteDevice, snapshot: RemoteSnapshot): string | null {
  const name = device.name;
  const update = `These versions of Mythra Code can't connect. Update Mythra Code on ${device.updateOn === "peer" ? name : snapshot.deviceName} in Settings → Updates, then try again.`;
  switch (device.state) {
    case "incompatible":
      return update;
    case "accessRemoved":
      return `Your access to ${name} was removed. Your draft is saved. Request access again from the machine picker.`;
    case "stale":
      return `Connection lost. This conversation may be out of date. Your draft is saved. Work already started on ${name} may still be running.`;
    case "unreachable":
      if (device.platform === "windows") return `Windows may be blocking connections to Mythra Code on ${name}. On that PC, open Windows Security → Firewall & network protection → Allow an app through firewall, and allow Mythra Code on Private networks. You may need an administrator.`;
      {
        const reach = `${name} may be asleep, or Mythra Code may be closed there. This network may keep devices apart. Connect both computers to the same non-guest network, or ask the network owner to allow devices to connect. Requesting access can't bypass this restriction.`;
        // Bonjour can still find a Mac whose firewall refuses incoming connections.
        return device.platform === "macos"
          ? `${reach} Its firewall may also be blocking connections. On that Mac, open System Settings → Network → Firewall → Options and allow incoming connections for Mythra Code. Then choose Try again.`
          : reach;
      }
    default:
      // Versions can also refuse a device that only views this one.
      return device.updateOn ? update : null;
  }
}

/** A message written on the other machine, with that machine's real name in it. */
export function namingDevice(text: string, name: string): string {
  return text.replaceAll("the other device's", `${name}'s`).replaceAll("The other device's", `${name}'s`)
    .replaceAll("the other device", name).replaceAll("The other device", name);
}

export interface NetworkNotice {
  text: string;
  /** The wording asks the user to choose Try again. */
  canRetry: boolean;
  /** macOS is keeping this app off the local network: offer its settings page. */
  localNetwork?: boolean;
}

/** Notes about the network that apply to this whole device. */
/** The wording for this device asks the user to choose Try again, so a button must be beside it. */
export const deviceHelpOffersRetry = (device: RemoteDevice) => device.state === "unreachable" && device.platform === "macos";

export const LOCAL_NETWORK_BLOCKED = "macOS may be blocking Mythra Code from connecting to your local network. On this Mac, open System Settings → Privacy & Security → Local Network and turn on Mythra Code. If a permission prompt is open, choose Allow. Then choose Try again.";
/** True only on a Mac whose Local Network access is denied. */
export const localNetworkBlocked = (snapshot: Pick<RemoteSnapshot, "platform" | "networkAccess"> | null | undefined) =>
  snapshot?.platform === "macos" && snapshot.networkAccess === "blocked";

export function networkHelp(snapshot: RemoteSnapshot): NetworkNotice | null {
  if (snapshot.networkAccess === "waiting") {
    return snapshot.platform === "macos"
      ? { text: "Waiting for permission. If your Mac is asking to use the local network, choose Allow.", canRetry: false }
      : { text: "Waiting for permission to use the network.", canRetry: false };
  }
  if (snapshot.networkAccess === "blocked") {
    // The other computer is connecting back, so whatever is blocked isn't stopping anything.
    if (snapshot.platform === "macos" && outgoingRequests(snapshot).some((request) => isPendingAccessRequest(request) && request.reverseConnecting === true)) return null;
    return snapshot.platform === "macos"
      ? { text: LOCAL_NETWORK_BLOCKED, canRetry: true, localNetwork: true }
      : { text: `Windows may be blocking connections to Mythra Code on ${snapshot.deviceName}. On this PC, open Windows Security → Firewall & network protection → Allow an app through firewall, and allow Mythra Code on Private networks. You may need an administrator.`, canRetry: true };
  }
  if (snapshot.publicNetwork === true) {
    return { text: "Windows marks this network as Public. Only if this is your trusted home or work network, open its Wi-Fi or Ethernet settings and change Network profile to Private. Don't change this on public Wi-Fi.", canRetry: false };
  }
  return snapshot.discoveryError
    ? { text: "Mythra Code can't look for nearby devices right now. It will keep trying.", canRetry: false }
    : null;
}

/** Presets are immutable templates. Editing More always starts with a fresh copy. */
export const VIEW_ONLY_GRANT: DeviceGrant = Object.freeze({
  scope: Object.freeze({ kind: "all" as const }), view: true, work: false,
  capabilities: Object.freeze({ fullAccess: false, gitWrite: false, checkpointRestore: false, terminal: false, manageProjects: false }), revision: 0,
});
export const FULL_CONTROL_GRANT: DeviceGrant = Object.freeze({
  scope: Object.freeze({ kind: "all" as const }), view: true, work: true,
  capabilities: Object.freeze({ fullAccess: true, gitWrite: true, checkpointRestore: true, terminal: true, manageProjects: true }), revision: 0,
});
export function accessGrantPreset(decision: Exclude<AccessDecision, "decline">): DeviceGrant {
  if (decision !== "allow" && decision !== "viewOnly") throw new Error("Choose Full control or View only.");
  const preset = decision === "allow" ? FULL_CONTROL_GRANT : VIEW_ONLY_GRANT;
  return { ...preset, scope: { kind: "all" }, capabilities: { ...preset.capabilities } };
}
/** The picker badge is the inbox, not unanswered requests sent to other people. */
export const pendingRequestCount = (snapshot: RemoteSnapshot | null | undefined, reopened: ReadonlySet<string> = NO_IDS): number => incomingRequests(snapshot, reopened).length;
export const isPendingAccessRequest = (request: OutgoingAccessRequest): boolean => request.state === "connecting" || request.state === "waiting";
