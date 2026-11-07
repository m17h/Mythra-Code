export type RemotePlatform = "macos" | "windows" | "other";

export type DeviceGrantScope = { kind: "all" } | { kind: "projects"; projectIds: string[] };

export interface DeviceGrant {
  scope: DeviceGrantScope;
  view: boolean;
  work: boolean;
  capabilities: { fullAccess: boolean; gitWrite: boolean; checkpointRestore: boolean; terminal: boolean; manageProjects?: boolean };
  /** Owned by the host. Ignored when sent back. */
  revision: number;
}

/**
 * `offline`: nothing has been tried yet, or only briefly.
 * `unreachable`: several attempts failed and the cause is unproven.
 * `stale`: this device was connected, and the link dropped.
 * `incompatible`: the versions can't connect.
 * `accessRemoved`: the other device proved who it is and refused this one.
 * `none`: this device can't view that one, which says nothing about the reverse.
 *
 * This is the viewing relationship alone. `hosting` reports the other direction.
 */
export type RemoteDeviceState = "connected" | "connecting" | "offline" | "unreachable" | "stale" | "incompatible" | "accessRemoved" | "none";

/** `waiting`: the OS prompt may still be open. Only a policy denial counts as evidence. */
export type RemoteNetworkAccess = "ok" | "waiting" | "blocked";

export interface RemoteDevice {
  fingerprint: string;
  shortFingerprint: string;
  name: string;
  platform: RemotePlatform | null;
  pairedAt: number;
  lastSeenAt: number | null;
  /** This device can view that one. */
  canView: boolean;
  /** That device can view this one, within this grant. */
  grant: DeviceGrant | null;
  state: RemoteDeviceState;
  /** A live link where this device views that one. */
  viewing: boolean;
  /** A live link where that device views this one. */
  hosting: boolean;
  /** Which side has to update before the two can connect. */
  updateOn: "this" | "peer" | null;
  route: "direct" | "reverse" | null;
  rttMs: number | null;
  appVersion: string | null;
}

export interface NearbyDevice {
  instance: string;
  name: string;
}

export interface PairingRequest {
  id: string;
  name: string | null;
  code: string;
  invited: boolean;
  /** The user approved. Waiting for the other device, or for the save. */
  approved: boolean;
}

export interface PairingWindow {
  /** `null` once spent, and always in a temporary window. */
  invitation: string | null;
  expiresAt: number;
  /** Hosting is off, so this window only receives offers from other devices. */
  temporary: boolean;
  nearbyStopped: boolean;
  invitationSpent: boolean;
  /** Someone holds the one pending slot. The host can cancel them. */
  waiting: boolean;
  request: PairingRequest | null;
}

/** `offered`: another device offers access, and this device's user decides. */
export type PairingFlowStage = "connecting" | "offered" | "comparing" | "done" | "failed";

export interface PairingFlow {
  /** Names this flow when answering an offer. */
  id: number;
  target: string;
  stage: PairingFlowStage;
  code: string | null;
  error: string | null;
  fingerprint: string | null;
  /** The nearby device this flow dialed, so Try again can dial it again. Older hosts omit it. */
  instance?: string | null;
}

export interface RemoteSnapshot {
  generation: number;
  ready: boolean;
  platform: RemotePlatform;
  deviceName: string;
  fingerprint: string | null;
  hosting: boolean;
  listening: boolean;
  port: number | null;
  shareName: boolean;
  browsing: boolean;
  searching: boolean;
  networkAccess: RemoteNetworkAccess;
  discoveryError: string | null;
  hostError: string | null;
  /** True when Windows marks an advertised network Public. Null is unknown. */
  publicNetwork: boolean | null;
  /** Network adapters Windows refused to announce on while others stayed up. */
  refusedAdapters: number;
  /** A change is in force but not on disk yet. Quitting now could undo it. */
  unsavedChanges: boolean;
  pairing: PairingWindow | null;
  flow: PairingFlow | null;
  devices: RemoteDevice[];
  nearby: NearbyDevice[];
}

export interface RemotePingResult {
  rttMs: number;
  route: "direct" | "reverse";
  host: { name?: string; appVersion?: string; platform?: string; proto?: number; highestOpSeq?: number };
  opStatus: { opId?: string; state?: string };
}
