import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AccessDecision, DeviceGrant, RemotePingResult, RemoteSnapshot } from "./types";

export const remoteSnapshot = () => invoke<RemoteSnapshot>("remote_snapshot");
export const remoteSetHosting = (enabled: boolean) => invoke<RemoteSnapshot>("remote_set_hosting", { enabled });
export const remoteSetDeviceName = (name: string) => invoke<RemoteSnapshot>("remote_set_device_name", { name });
export const remoteSetShareName = (shared: boolean) => invoke<RemoteSnapshot>("remote_set_share_name", { shared });
/** The one settings page that grants Local Network access. Its scope allows nothing else. */
export const LOCAL_NETWORK_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork";
export const openLocalNetworkSettings = () => openUrl(LOCAL_NETWORK_SETTINGS);
export const remoteFindNearby = () => invoke<RemoteSnapshot>("remote_find_nearby");
/** With `reciprocal`, native also turns this computer's own switch on. */
/** The checked reciprocal choice durably enables local hosting natively, but
 * grants nothing until the pinned peer accepts. No optimistic renderer grant. */
export const remoteAccessRequest = (instance: string, reciprocal = true) =>
  invoke<RemoteSnapshot>("remote_access_request", { instance, reciprocal });
/** Exact outgoing request only; cancellation never revokes an independent grant. */
export const remoteAccessCancel = (requestId: string) =>
  invoke<RemoteSnapshot>("remote_access_cancel", { requestId });
/** Asks the exact computer this request already reached again. Never by name. */
export const remoteAccessRetry = (requestId: string) =>
  invoke<RemoteSnapshot>("remote_access_retry", { requestId });
/** Both identities are required so a late card cannot answer its replacement. */
export function remoteAccessRespond(fingerprint: string, requestId: string, decision: AccessDecision): Promise<RemoteSnapshot> {
  if (!fingerprint || !requestId || !["allow", "viewOnly", "decline"].includes(decision)) {
    return Promise.reject(new Error("This access request is no longer available. Refresh Devices and try again."));
  }
  return invoke<RemoteSnapshot>("remote_access_respond", { fingerprint, requestId, decision });
}
export const remoteDeviceRevoke = (fingerprint: string) => invoke<RemoteSnapshot>("remote_device_revoke", { fingerprint });
export const remoteDeviceForget = (fingerprint: string) => invoke<RemoteSnapshot>("remote_device_forget", { fingerprint });
export const remoteDeviceSetGrant = (fingerprint: string, grant: DeviceGrant, expectedRevision: number) =>
  invoke<RemoteSnapshot>("remote_device_set_grant", { fingerprint, grant, expectedRevision });
export const remoteDevicePing = (fingerprint: string) => invoke<RemotePingResult>("remote_device_ping", { fingerprint });

export function listenRemoteChanged(onChanged: (snapshot: RemoteSnapshot) => void): Promise<UnlistenFn> {
  return listen<RemoteSnapshot>("remote-changed", (event) => onChanged(event.payload));
}
