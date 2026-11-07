import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { DeviceGrant, RemotePingResult, RemoteSnapshot } from "./types";

export const remoteSnapshot = () => invoke<RemoteSnapshot>("remote_snapshot");
export const remoteSetHosting = (enabled: boolean) => invoke<RemoteSnapshot>("remote_set_hosting", { enabled });
export const remoteSetDeviceName = (name: string) => invoke<RemoteSnapshot>("remote_set_device_name", { name });
export const remoteSetShareName = (shared: boolean) => invoke<RemoteSnapshot>("remote_set_share_name", { shared });
/** The one settings page that grants Local Network access. Its scope allows nothing else. */
export const LOCAL_NETWORK_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork";
export const openLocalNetworkSettings = () => openUrl(LOCAL_NETWORK_SETTINGS);
export const remoteFindNearby = () => invoke<RemoteSnapshot>("remote_find_nearby");
export const remotePairingOpen = () => invoke<RemoteSnapshot>("remote_pairing_open");
export const remotePairingClose = () => invoke<RemoteSnapshot>("remote_pairing_close");
export const remotePairingCancelRequest = () => invoke<RemoteSnapshot>("remote_pairing_cancel_request");
export const remotePairingRespond = (requestId: string, approve: boolean, grant?: DeviceGrant) =>
  invoke<RemoteSnapshot>("remote_pairing_respond", { requestId, approve, grant: grant ?? null });
export const remotePairNearby = (instance: string) => invoke<RemoteSnapshot>("remote_pair_nearby", { instance });
export const remotePairInvitation = (invitation: string) => invoke<RemoteSnapshot>("remote_pair_invitation", { invitation });
export const remotePairOffer = (instance: string) => invoke<RemoteSnapshot>("remote_pair_offer", { instance });
export const remotePairOfferRespond = (flowId: number, accept: boolean) =>
  invoke<RemoteSnapshot>("remote_pair_offer_respond", { flowId, accept });
export const remotePairCancel = () => invoke<RemoteSnapshot>("remote_pair_cancel");
export const remoteDeviceRevoke = (fingerprint: string) => invoke<RemoteSnapshot>("remote_device_revoke", { fingerprint });
export const remoteDeviceForget = (fingerprint: string) => invoke<RemoteSnapshot>("remote_device_forget", { fingerprint });
export const remoteDeviceSetGrant = (fingerprint: string, grant: DeviceGrant, expectedRevision: number) =>
  invoke<RemoteSnapshot>("remote_device_set_grant", { fingerprint, grant, expectedRevision });
export const remoteDevicePing = (fingerprint: string) => invoke<RemotePingResult>("remote_device_ping", { fingerprint });

export function listenRemoteChanged(onChanged: (snapshot: RemoteSnapshot) => void): Promise<UnlistenFn> {
  return listen<RemoteSnapshot>("remote-changed", (event) => onChanged(event.payload));
}
