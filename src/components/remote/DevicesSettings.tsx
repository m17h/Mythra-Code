import { useEffect, useId, useRef, useState } from "react";
import { Check, Copy, Info, LoaderCircle, Radar } from "lucide-react";
import { confirmDialog } from "../../lib/confirmDialog";
import { safeErrorText } from "../../lib/errors";
import {
  remotePairingCancelRequest,
  remoteDeviceForget,
  remoteDeviceRevoke,
  remoteDeviceSetGrant,
  remoteFindNearby,
  remotePairInvitation,
  remotePairOffer,
  remotePairingClose,
  remotePairingOpen,
  remoteSetDeviceName,
  remoteSetHosting,
  remoteSetShareName,
  remoteSnapshot,
} from "../../lib/remote/client";
import {
  acceptRemoteSnapshot,
  deviceDotState,
  deviceHelp,
  deviceStateLabel,
  localMachineLabel,
  networkHelp,
  startRemoteDevices,
  useRemoteDevices,
} from "../../lib/remote/devices";
import type { DeviceGrant, RemoteDevice, RemoteSnapshot } from "../../lib/remote/types";
import "./DevicesSettings.css";

function Switch({ label, checked, disabled, describedBy, onChange }: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  describedBy?: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      aria-describedby={describedBy}
      disabled={disabled}
      className={`toggle-switch ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    ><span /></button>
  );
}

function lastSeenLabel(device: RemoteDevice): string {
  if (deviceDotState(device) !== "offline" || !device.lastSeenAt) return deviceStateLabel(device);
  return `Offline, last seen ${new Date(device.lastSeenAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}

function minutesAndSeconds(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const CAPABILITIES: ReadonlyArray<{ key: keyof DeviceGrant["capabilities"]; label: string }> = [
  { key: "fullAccess", label: "Let tasks it starts run with full access. Without this, they ask before acting" },
  { key: "gitWrite", label: "Change Git history" },
  { key: "checkpointRestore", label: "Restore checkpoints" },
  { key: "terminal", label: "Use the terminal" },
  { key: "manageProjects", label: "Manage projects: add and remove them, and change their settings, prompts, skills and tools" },
];
/** A shortcut for your own machines. It sets the same switches, nothing more. */
const FULL_CONTROL = {
  view: true, work: true,
  capabilities: { fullAccess: true, gitWrite: true, checkpointRestore: true, terminal: true, manageProjects: true },
};

function GrantEditor({ device, grant, saving, onChange }: { device: RemoteDevice; grant: DeviceGrant; saving: boolean; onChange: (grant: DeviceGrant) => void }) {
  return (
    <div className="devices-grant" aria-busy={saving}>
      <div className="devices-grant-row">
        <span>Full control: turn on everything below, for a device that's yours</span>
        <button type="button" className="secondary-button" disabled={saving || (grant.view && grant.work && Object.keys(FULL_CONTROL.capabilities).every((key) => grant.capabilities[key as keyof DeviceGrant["capabilities"]]))}
          onClick={() => onChange({ ...grant, ...FULL_CONTROL })}>Turn on all</button>
      </div>
      <div className="devices-grant-row">
        <span>View: see conversations on this computer, including anything tools printed</span>
        <Switch label={`Let ${device.name} see threads`} checked={grant.view} disabled={saving} onChange={(view) => onChange({ ...grant, view })} />
      </div>
      <div className="devices-grant-row">
        <span>Work: run tasks and approve commands on this computer</span>
        <Switch label={`Let ${device.name} work here`} checked={grant.work} disabled={saving || !grant.view} onChange={(work) => onChange({ ...grant, work })} />
      </div>
      {CAPABILITIES.map(({ key, label }) => (
        <div className="devices-grant-row" key={key}>
          <span>{label}</span>
          <Switch
            label={`Let ${device.name}: ${label}`}
            checked={Boolean(grant.capabilities[key])}
            disabled={saving || !grant.view}
            onChange={(next) => onChange({ ...grant, capabilities: { ...grant.capabilities, [key]: next } })}
          />
        </div>
      ))}
      {!grant.capabilities.terminal && (grant.capabilities.gitWrite || grant.capabilities.checkpointRestore) && (
        <div className="devices-grant-row" role="note">
          <span>{grant.capabilities.gitWrite ? "Changing Git history" : "Restoring checkpoints"} also needs Use the terminal, because Git hooks and helper programs can run commands on this computer. It won't work until that's on.</span>
          <button type="button" className="secondary-button" disabled={saving || !grant.view} onClick={() => onChange({ ...grant, capabilities: { ...grant.capabilities, terminal: true } })}>Turn on terminal</button>
        </div>
      )}
      <p className="devices-note">{grant.scope.kind === "all" ? "Covers every project on this device, except archived threads and sub-agent threads." : `Covers ${grant.scope.projectIds.length} selected projects.`} This sets which conversations it can open. It isn't a sandbox: a model with enough permission can reach files outside a project.</p>
      <span className="sr-only" role="status">{saving ? "Saving access settings…" : ""}</span>
    </div>
  );
}

function PairedDeviceRow({ device, snapshot, onError }: { device: RemoteDevice; snapshot: RemoteSnapshot; onError: (message: string) => void }) {
  const [showAccess, setShowAccess] = useState(false);
  const [savingGrant, setSavingGrant] = useState(false);
  const grantPending = useRef(false);
  const grantFocus = useRef<HTMLButtonElement | null>(null);
  const help = deviceHelp(device, snapshot);
  useEffect(() => {
    if (savingGrant) return;
    const control = grantFocus.current;
    grantFocus.current = null;
    if (document.activeElement === document.body && control?.isConnected && !control.disabled) control.focus();
  }, [savingGrant]);

  const fail = (fallback: string) => (reason: unknown) => onError(safeErrorText(reason, fallback));
  const revoke = async () => {
    if (grantPending.current) return;
    const confirmed = await confirmDialog(
      `Remove ${device.name}'s access?\n\nIt disconnects now and can't reach this device until you pair again. Work it already started here keeps running.`,
      { confirmLabel: "Remove access", cancelLabel: "Cancel" },
    );
    if (confirmed) await remoteDeviceRevoke(device.fingerprint).then(acceptRemoteSnapshot).catch(fail("Mythra Code couldn't remove that access. Try again."));
  };
  const forget = async () => {
    if (grantPending.current) return;
    const confirmed = await confirmDialog(
      `Remove ${device.name} from this device?\n\nYou'll need to pair again to use it. Nothing changes on ${device.name}.`,
      { confirmLabel: "Remove", cancelLabel: "Cancel" },
    );
    if (confirmed) await remoteDeviceForget(device.fingerprint).then(acceptRemoteSnapshot).catch(fail("Mythra Code couldn't remove that device. Try again."));
  };
  const saveGrant = (grant: DeviceGrant) => {
    if (grantPending.current || !device.grant) return;
    const expectedRevision = device.grant.revision;
    grantFocus.current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    grantPending.current = true;
    setSavingGrant(true);
    onError("");
    void (async () => {
      try {
        acceptRemoteSnapshot(await remoteDeviceSetGrant(device.fingerprint, grant, expectedRevision));
      } catch (reason) {
        // A stale grant must be reviewed, never silently retried over a newer one.
        let changed = /revision|stale|access.*changed/i.test(safeErrorText(reason));
        try {
          const current = await remoteSnapshot();
          acceptRemoteSnapshot(current);
          changed ||= current.devices.find((entry) => entry.fingerprint === device.fingerprint)?.grant?.revision !== expectedRevision;
        } catch { /* Keep the refusal visible even if the refresh also failed. */ }
        onError(changed
          ? "The access settings changed. Review them before trying again."
          : safeErrorText(reason, "Mythra Code couldn't save that change. Try again."));
      } finally {
        grantPending.current = false;
        setSavingGrant(false);
      }
    })();
  };

  return (
    <div className="devices-row">
      <div className="set-row">
        <div className="set-copy">
          <strong><span className={`machine-dot ${deviceDotState(device)}`} aria-hidden="true" /><span className="devices-name" title={device.name}>{device.name}</span></strong>
          <small>
            {lastSeenLabel(device)}
            {device.grant && device.canView ? " · You can use each other's devices" : device.grant ? " · Can use this device" : " · You can use this device"}
          </small>
          <small className="devices-fingerprint" title={device.fingerprint}>ID {device.shortFingerprint}</small>
        </div>
        <div className="set-control devices-row-actions">
          {device.grant && <button type="button" className="secondary-button" aria-expanded={showAccess} onClick={() => setShowAccess((current) => !current)}>Access</button>}
          {device.grant && <button type="button" className="secondary-button devices-danger" aria-label={`Revoke ${device.name}'s access`} disabled={savingGrant} onClick={() => void revoke()}>Revoke</button>}
          {device.canView && <button type="button" className="secondary-button devices-danger" aria-label={`Remove ${device.name}`} disabled={savingGrant} onClick={() => void forget()}>Remove</button>}
        </div>
      </div>
      {help && <p className="devices-help">{help}</p>}
      {device.grant && showAccess && <GrantEditor device={device} grant={device.grant} saving={savingGrant} onChange={saveGrant} />}
    </div>
  );
}

function PairingPanel({ snapshot, onError }: { snapshot: RemoteSnapshot; onError: (message: string) => void }) {
  const window_ = snapshot.pairing;
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  const [invitation, setInvitation] = useState("");
  const [busy, setBusy] = useState(false);
  const [offering, setOffering] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inviteHelpId = useId();

  useEffect(() => {
    if (!window_) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [window_]);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const fail = (fallback: string) => (reason: unknown) => onError(safeErrorText(reason, fallback));
  const open = () => {
    onError("");
    void remotePairingOpen().then(acceptRemoteSnapshot).catch(fail("Mythra Code couldn't start pairing. Try again."));
  };
  const close = () => {
    void remotePairingClose().then(acceptRemoteSnapshot).catch(() => undefined);
  };
  const cancelRequest = () => {
    void remotePairingCancelRequest().then(acceptRemoteSnapshot).catch(() => undefined);
  };
  const copy = () => {
    if (!window_?.invitation) return;
    navigator.clipboard.writeText(window_.invitation).then(() => {
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    }).catch(() => onError("Mythra Code couldn't copy the invitation. Select it and copy it by hand."));
  };
  const useInvitation = () => {
    onError("");
    setBusy(true);
    remotePairInvitation(invitation)
      .then((next) => {
        acceptRemoteSnapshot(next);
        setInvitation("");
      })
      .catch(fail("Mythra Code couldn't use that invitation. Try again."))
      .finally(() => setBusy(false));
  };
  const offer = (instance: string) => {
    onError("");
    setOffering(instance);
    remotePairOffer(instance)
      .then(acceptRemoteSnapshot)
      .catch(fail("Mythra Code couldn't reach that device. Try again."))
      .finally(() => setOffering(null));
  };

  return (
    <div className="set-group">
      <h4>Pair a device</h4>
      <div className="set-card">
        <div className="set-row">
          <div className="set-copy">
            <strong>Pair a device</strong>
            <small>
              {window_
                ? window_.temporary
                  ? `Waiting for ${minutesAndSeconds(window_.expiresAt - now)}. On the other device, choose Pair a device, then Offer access. Nothing on this device is shared.`
                  : `Open for ${minutesAndSeconds(window_.expiresAt - now)}. On your other device, pick this one from the switcher above New thread.`
                : snapshot.hosting
                  ? "Lets one new device ask to pair for the next 5 minutes. You approve it here."
                  : "With access off, this only lets another device offer to let this one use it. Nothing on this device is shared. To let a device use this one, turn on Allow access from nearby devices first."}
            </small>
          </div>
          <div className="set-control">
            {window_
              ? <button type="button" className="secondary-button" onClick={close}>Stop</button>
              : <button type="button" className="secondary-button" onClick={open}>Pair a device</button>}
          </div>
        </div>
        {window_?.waiting && !window_.request && (
          <div className="set-body devices-offer">
            <div className="devices-offer-row">
              <span>A device is asking to pair.</span>
              <button type="button" className="secondary-button" onClick={cancelRequest}>Cancel request</button>
            </div>
          </div>
        )}
        {window_?.nearbyStopped && <div className="set-body devices-offer"><span>Too many nearby requests failed, so nearby pairing has stopped until you start again.</span></div>}
        {window_?.invitationSpent && <div className="set-body devices-offer"><span>The invitation can't be used anymore. Choose Stop, then Pair a device, to make a new one.</span></div>}
        {window_?.invitation && (
          <div className="set-body devices-invitation">
            <span>If the other device can't find this one, copy this invitation to it. It works once.</span>
            <div className="key-input-row">
              <input readOnly value={window_.invitation} aria-label="Invitation" onFocus={(event) => event.target.select()} />
              <button type="button" className="secondary-button" onClick={copy}>
                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        )}
        {window_ && !window_.temporary && snapshot.nearby.length > 0 && (
          <div className="set-body devices-offer">
            <span>If the other device can't connect to this one, offer access from here. Start Pair a device on it first.</span>
            {snapshot.nearby.map((device) => (
              <div className="devices-offer-row" key={device.instance}>
                <span className="devices-name" title={device.name}>{device.name}</span>
                <button type="button" className="secondary-button" disabled={offering !== null} onClick={() => offer(device.instance)}>
                  {offering === device.instance ? <LoaderCircle size={13} className="spin" /> : <Radar size={13} />} Offer access
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="set-body devices-invitation">
          <label htmlFor={inviteHelpId}>Have an invitation from another device? Paste it here.</label>
          <div className="key-input-row">
            <input
              id={inviteHelpId}
              value={invitation}
              autoComplete="off"
              spellCheck={false}
              placeholder="mythra-invite:1:…"
              onChange={(event) => setInvitation(event.target.value)}
            />
            <button type="button" className="secondary-button" disabled={busy || !invitation.trim()} onClick={useInvitation}>Connect</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function DevicesSettings() {
  const snapshot = useRemoteDevices((state) => state.snapshot);
  const initialization = useRemoteDevices((state) => state.initialization);
  const initializationError = useRemoteDevices((state) => state.initializationError);
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [changing, setChanging] = useState(false);
  const [searching, setSearching] = useState(false);
  const nameHelpId = useId();
  const hostingHelpId = useId();
  const shareHelpId = useId();

  useEffect(() => startRemoteDevices(), []);

  if (!snapshot || initialization !== "ready" || !snapshot.ready) {
    return (
      <section className="settings-section">
        <p className="settings-footnote" role="status"><Info size={13} aria-hidden="true" /><span>{initializationError ?? "Loading devices…"}</span></p>
        {initialization === "failed" && <button type="button" className="secondary-button" onClick={startRemoteDevices}>Try again</button>}
      </section>
    );
  }

  const saveName = () => {
    if (name === null) return;
    const next = name.trim();
    setName(null);
    if (!next || next === snapshot.deviceName) return;
    setError("");
    void remoteSetDeviceName(next).then(acceptRemoteSnapshot).catch((reason) => setError(safeErrorText(reason, "Mythra Code couldn't save that name. Try again.")));
  };
  const setHosting = (enabled: boolean) => {
    setChanging(true);
    setError("");
    remoteSetHosting(enabled)
      .then(acceptRemoteSnapshot)
      .catch((reason) => setError(safeErrorText(reason, "Mythra Code couldn't change that setting. Try again.")))
      .finally(() => setChanging(false));
  };
  const setShare = (shared: boolean) => {
    setError("");
    void remoteSetShareName(shared).then(acceptRemoteSnapshot).catch((reason) => setError(safeErrorText(reason, "Mythra Code couldn't change that setting. Try again.")));
  };
  const findNearby = () => {
    setSearching(true);
    setError("");
    remoteFindNearby()
      .then(acceptRemoteSnapshot)
      .catch((reason) => setError(safeErrorText(reason, "Mythra Code couldn't look for nearby devices. Try again.")))
      .finally(() => setSearching(false));
  };

  const network = networkHelp(snapshot);
  return (
    <section className="settings-section devices-settings">
      <p className="settings-footnote" role="note"><Info size={13} aria-hidden="true" /><span>Changes here take effect immediately, and apply to {localMachineLabel(snapshot)}.</span></p>
      <div className="set-group">
        <h4>This device</h4>
        <div className="set-card">
          <div className="set-row">
            <div className="set-copy">
              <strong>Device name</strong>
              <small id={nameHelpId}>How this device appears on your other devices.</small>
            </div>
            <div className="set-control key-input-row">
              <input
                aria-label="Device name"
                aria-describedby={nameHelpId}
                maxLength={64}
                value={name ?? snapshot.deviceName}
                onChange={(event) => setName(event.target.value)}
                onBlur={saveName}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </div>
          </div>
          <div className="set-row">
            <div className="set-copy">
              <strong>Allow access from nearby devices</strong>
              <small id={hostingHelpId}>Lets devices you've paired use this device while Mythra Code is open, including when it's minimized. Prompts run here, with this device's accounts and files.</small>
            </div>
            <div className="set-control">
              {changing && <LoaderCircle size={14} className="spin" aria-hidden="true" />}
              <Switch label="Allow access from nearby devices" describedBy={hostingHelpId} checked={snapshot.hosting} disabled={changing} onChange={setHosting} />
            </div>
          </div>
          <div className="set-row">
            <div className="set-copy">
              <strong>Show this name to nearby devices</strong>
              <small id={shareHelpId}>When this is off, Mythra Code leaves the name out of its announcement, and devices see it after pairing. Your computer's own network name can still be visible on the network.</small>
            </div>
            <div className="set-control">
              <Switch label="Show this name to nearby devices" describedBy={shareHelpId} checked={snapshot.shareName} onChange={setShare} />
            </div>
          </div>
        </div>
        {snapshot.hostError && <p className="settings-footnote devices-error" role="alert"><Info size={13} aria-hidden="true" /><span>{snapshot.hostError}</span></p>}
        {network && (
          <p className="settings-footnote" role="note">
            <Info size={13} aria-hidden="true" />
            <span>{network.text}</span>
            {network.canRetry && <button type="button" className="secondary-button" disabled={searching} onClick={findNearby}>Try again</button>}
          </p>
        )}
        {snapshot.refusedAdapters > 0 && <p className="settings-footnote" role="note"><Info size={13} aria-hidden="true" /><span>Windows wouldn't announce this device on every network it's connected to. Devices on those networks may not find it, but an invitation can still work.</span></p>}
        {snapshot.unsavedChanges && <p className="settings-footnote devices-error" role="alert"><Info size={13} aria-hidden="true" /><span>Your latest change is active, but Mythra Code hasn't saved it yet and is still trying. If you quit now, it could be undone.</span></p>}
        {error && <p className="settings-footnote devices-error" role="alert"><Info size={13} aria-hidden="true" /><span>{error}</span></p>}
      </div>

      <PairingPanel snapshot={snapshot} onError={setError} />

      <div className="set-group">
        <div className="set-group-head"><h4>Paired devices</h4></div>
        {snapshot.devices.length > 0 ? (
          <div className="set-card">
            {snapshot.devices.map((device) => <PairedDeviceRow key={device.fingerprint} device={device} snapshot={snapshot} onError={setError} />)}
          </div>
        ) : (
          <div className="set-card"><div className="set-row">
            <div className="set-copy">
              <strong>No paired devices yet</strong>
              <small>Paired devices stay listed here, even when they're offline.</small>
            </div>
            {!snapshot.browsing && (
              <div className="set-control">
                <button type="button" className="secondary-button" disabled={searching} onClick={findNearby}>
                  {searching ? <LoaderCircle size={13} className="spin" /> : <Radar size={13} />} Find nearby devices
                </button>
              </div>
            )}
          </div></div>
        )}
      </div>
    </section>
  );
}
