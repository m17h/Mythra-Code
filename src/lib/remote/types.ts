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

/** Exact host answer; arbitrary grants never arrive from an unpaired peer. */
export type AccessDecision = "allow" | "viewOnly" | "decline";

/** TLS-proven incoming request, persisted natively until answered or expired. */
export interface AccessRequest {
  requestId: string;
  fingerprint: string;
  name: string;
  platform: RemotePlatform | null;
  /** Epoch milliseconds. Expiration is native-owned, never a renderer timer. */
  createdAt: number;
  expiresAt: number;
  reciprocal: boolean;
  code: string;
  /** Declined ones stay for 7 days so a mistaken Decline can still be turned into a yes. Absent means pending. */
  status?: "pending" | "declined";
}
/** Existing UI import name; the protocol shape is AccessRequest, not a second model. */
export type IncomingAccessRequest = AccessRequest;

export type OutgoingAccessState = "connecting" | "waiting" | "allowed" | "viewOnly" | "declined" | "cancelled" | "expired" | "failed";
/** Durable request/result, including while offline or after a renderer restart. */
export interface OutgoingAccessRequest {
  requestId: string;
  fingerprint: string | null;
  name: string;
  platform: RemotePlatform | null;
  createdAt: number;
  expiresAt: number;
  reciprocal: boolean;
  code: string | null;
  state: OutgoingAccessState;
  error: string | null;
  /** Reverse TCP fallback is ordinary connection progress, not OS denial. */
  reverseConnecting?: boolean;
  /** Epoch ms when asking again is allowed (set after a Decline), otherwise null. */
  retryAfter?: number | null;
}

export interface NearbyDevice {
  instance: string;
  name: string;
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
  /** Older native builds omit these. */
  accessRequests?: AccessRequest[];
  outgoingRequests?: OutgoingAccessRequest[];
  devices: RemoteDevice[];
  nearby: NearbyDevice[];
}

export interface RemotePingResult {
  rttMs: number;
  route: "direct" | "reverse";
  host: { name?: string; appVersion?: string; platform?: string; proto?: number; highestOpSeq?: number };
  opStatus: { opId?: string; state?: string };
}
