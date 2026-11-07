import { create } from "zustand";
import { isWindowsPlatform } from "../platform";
import { listenRemoteChanged, remoteSnapshot } from "./client";
import type { DeviceGrant, RemoteDevice, RemoteSnapshot } from "./types";

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

/** Settings is deliberately not a blocker: pairing is shown above it. */
export function hasPairingSheet(state: RemoteDevicesState): boolean {
  return Boolean(state.snapshot?.pairing?.request || state.snapshot?.flow);
}

export function acceptRemoteSnapshot(next: RemoteSnapshot): void {
  const current = useRemoteDevices.getState().snapshot;
  if (current && next.generation < current.generation) return;
  useRemoteDevices.setState({ snapshot: next });
}

let initialized = false;
let starting: Promise<void> | null = null;
let stopListening: Awaited<ReturnType<typeof listenRemoteChanged>> | null = null;

/** Subscribe before reading so a change during startup cannot be missed.
 * Failed steps remain retryable; successful subscriptions are reused. */
export function startRemoteDevices(): void {
  if (initialized || starting) return;
  useRemoteDevices.setState({ initialization: "loading", initializationError: null });
  starting = Promise.resolve().then(async () => {
    try {
      stopListening ??= await listenRemoteChanged(acceptRemoteSnapshot);
      acceptRemoteSnapshot(await remoteSnapshot());
      initialized = true;
      useRemoteDevices.setState({ initialization: "ready", initializationError: null });
    } catch {
      useRemoteDevices.setState({
        initialization: "failed",
        initializationError: "Mythra Code couldn't load your devices. Choose Try again.",
      });
    }
  }).finally(() => { starting = null; });
}

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
      return `Your access to ${name} was removed. Your draft is saved. Ask someone at ${name} to pair this device again.`;
    case "stale":
      return `Connection lost. This conversation may be out of date. Your draft is saved. Work already started on ${name} may still be running.`;
    case "unreachable":
      return device.platform === "windows"
        ? `Windows may be blocking connections to Mythra Code on ${name}. On that PC, open Windows Security → Firewall & network protection → Allow an app through firewall, and allow Mythra Code on Private networks. You may need an administrator.`
        : `${name} may be asleep, or Mythra Code may be closed there. This network may keep devices apart. Connect both computers to the same non-guest network, or ask the network owner to allow devices to connect. An invitation won't bypass this restriction.`;
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
}

/** Notes about the network that apply to this whole device. */
export function networkHelp(snapshot: RemoteSnapshot): NetworkNotice | null {
  if (snapshot.networkAccess === "waiting") {
    return snapshot.platform === "macos"
      ? { text: "Waiting for permission. If your Mac is asking to use the local network, choose Allow.", canRetry: false }
      : { text: "Waiting for permission to use the network.", canRetry: false };
  }
  if (snapshot.networkAccess === "blocked") {
    return snapshot.platform === "macos"
      ? { text: "Mythra Code can't access your local network. On this Mac, open System Settings → Privacy & Security → Local Network and turn on Mythra Code. Then choose Try again.", canRetry: true }
      : { text: `Windows may be blocking connections to Mythra Code on ${snapshot.deviceName}. On that PC, open Windows Security → Firewall & network protection → Allow an app through firewall, and allow Mythra Code on Private networks. You may need an administrator.`, canRetry: true };
  }
  if (snapshot.publicNetwork === true) {
    return { text: "Windows marks this network as Public. Only if this is your trusted home or work network, open its Wi-Fi or Ethernet settings and change Network profile to Private. Don't change this on public Wi-Fi.", canRetry: false };
  }
  return snapshot.discoveryError
    ? { text: "Mythra Code can't look for nearby devices right now. It will keep trying.", canRetry: false }
    : null;
}

export const VIEW_ONLY_GRANT: DeviceGrant = {
  scope: { kind: "all" },
  view: true,
  work: false,
  capabilities: { fullAccess: false, gitWrite: false, checkpointRestore: false, terminal: false, manageProjects: false },
  revision: 0,
};
