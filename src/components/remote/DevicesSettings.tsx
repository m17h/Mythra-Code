import { useEffect, useId, useRef, useState } from "react";
import { Info, LoaderCircle, Radar } from "lucide-react";
import { confirmDialog } from "../../lib/confirmDialog";
import { safeErrorText } from "../../lib/errors";
import {
  remoteDeviceForget,
  remoteDeviceRevoke,
  remoteDeviceSetGrant,
  remoteFindNearby,
  remoteSetDeviceName,
  remoteSetHosting,
  remoteSetShareName,
  remoteSnapshot,
} from "../../lib/remote/client";
import {
  acceptRemoteSnapshot,
  deviceDotState,
  deviceHelp,
  deviceHelpOffersRetry,
  declinedRequests,
  deviceStateLabel,
  FULL_CONTROL_GRANT,
  incomingRequests,
  networkHelp,
  startRemoteDevices,
  useRemoteDevices,
} from "../../lib/remote/devices";
import type { DeviceGrant, RemoteDevice, RemoteSnapshot } from "../../lib/remote/types";
import type { Project } from "../../types";
import "./DevicesSettings.css";
import { LocalNetworkActions } from "./LocalNetworkActions";
import { askableNearby, DeclinedRow, DeclineUndo, HOSTING_LABEL, IncomingRequestCard, NearbyRow, OutgoingRequestCard, showsLocalNetwork, useDeclines, visibleOutgoing } from "./AccessRequests";

export const HOSTING_HELP = "Your other computers on the same network can then ask to use this one. Nothing is shared until you allow it here. Turning this on also shows this computer's name on your network.";

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

const CAPABILITIES: ReadonlyArray<{ key: keyof DeviceGrant["capabilities"]; label: string }> = [
  { key: "fullAccess", label: "Full access: tasks it starts can act without asking first. With this off, they ask." },
  { key: "terminal", label: "Terminal: run any command on this computer. Run, Checks and worktrees need this too." },
  { key: "gitWrite", label: "Git changes: commit, push, and manage branches and pull requests" },
  { key: "checkpointRestore", label: "Restore checkpoints: put files back to an earlier saved state" },
  { key: "manageProjects", label: "Manage projects: add and remove them, and change their settings, prompts, skills and tools" },
];
/** The most project IDs one grant can hold, the same as MAX_GRANT_PROJECTS in Rust. */
const MAX_PICKED_PROJECTS = 1000;
/** A shortcut for your own machines: the same preset an Allow gives. */
const FULL_CONTROL = { scope: FULL_CONTROL_GRANT.scope, view: FULL_CONTROL_GRANT.view, work: FULL_CONTROL_GRANT.work, capabilities: FULL_CONTROL_GRANT.capabilities };

function ProjectScope({ device, grant, projects, saving, onChange }: { device: RemoteDevice; grant: DeviceGrant; projects: readonly Project[]; saving: boolean; onChange: (grant: DeviceGrant) => void }) {
  const picked = grant.scope.kind === "projects" ? grant.scope.projectIds : null;
  const disabled = saving || !grant.view;
  return (
    <>
      <div className="devices-grant-row">
        <span>All projects: every conversation on this computer, including archived and sub-agent ones. Turn this off to pick projects.</span>
        <Switch
          label={`Let ${device.name} open all projects`}
          checked={picked === null}
          disabled={disabled}
          // Starts from everything so turning this off takes nothing away until a box is cleared.
          onChange={(all) => onChange({ ...grant, scope: all ? { kind: "all" } : { kind: "projects", projectIds: projects.slice(0, MAX_PICKED_PROJECTS).map((project) => project.id) } })}
        />
      </div>
      {picked && (
        <div className="devices-grant-projects" role="group" aria-label={`Projects ${device.name} can open`}>
          {projects.map((project) => (
            <label key={project.id}>
              <input
                type="checkbox"
                checked={picked.includes(project.id)}
                disabled={disabled || (!picked.includes(project.id) && picked.length >= MAX_PICKED_PROJECTS)}
                onChange={(event) => onChange({ ...grant, scope: { kind: "projects", projectIds: event.target.checked ? [...picked, project.id] : picked.filter((id) => id !== project.id) } })}
              />
              <span className="devices-name" title={project.name}>{project.name}</span>
            </label>
          ))}
          {projects.length === 0 && <span>This computer has no projects yet.</span>}
        </div>
      )}
    </>
  );
}

function GrantEditor({ device, grant, projects, saving, onChange }: { device: RemoteDevice; grant: DeviceGrant; projects: readonly Project[]; saving: boolean; onChange: (grant: DeviceGrant) => void }) {
  return (
    <div className="devices-grant" aria-busy={saving}>
      <div className="devices-grant-row">
        <span>Full control: turn on everything below, for a device that's yours</span>
        <button type="button" className="secondary-button" disabled={saving || (grant.scope.kind === "all" && grant.view && grant.work && Object.keys(FULL_CONTROL.capabilities).every((key) => grant.capabilities[key as keyof DeviceGrant["capabilities"]]))}
          onClick={() => onChange({ ...grant, ...FULL_CONTROL })}>Turn on all</button>
      </div>
      <ProjectScope device={device} grant={grant} projects={projects} saving={saving} onChange={onChange} />
      <div className="devices-grant-row">
        <span>View: see conversations on this computer, including anything tools printed</span>
        <Switch label={`Let ${device.name} see threads`} checked={grant.view} disabled={saving} onChange={(view) => onChange({ ...grant, view })} />
      </div>
      <div className="devices-grant-row">
        <span>Work: run tasks here and approve their commands one at a time</span>
        <Switch label={`Let ${device.name} work here`} checked={grant.work} disabled={saving || !grant.view} onChange={(work) => onChange({ ...grant, work })} />
      </div>
      {!grant.work && <p className="devices-note">The switches below need Work, so they stay off until it's on.</p>}
      {CAPABILITIES.map(({ key, label }) => (
        <div className="devices-grant-row" key={key}>
          <span>{label}</span>
          <Switch
            label={`Let ${device.name}: ${label}`}
            checked={Boolean(grant.capabilities[key])}
            // The host drops Manage projects without Work and all projects, so a live switch would just flip back.
            disabled={saving || !grant.view || !grant.work || (key === "manageProjects" && grant.scope.kind !== "all")}
            onChange={(next) => onChange({ ...grant, capabilities: { ...grant.capabilities, [key]: next } })}
          />
        </div>
      ))}
      {grant.work && grant.scope.kind !== "all" && <p className="devices-note">Manage projects needs All projects.</p>}
      {!grant.capabilities.terminal && (grant.capabilities.gitWrite || grant.capabilities.checkpointRestore) && (
        <div className="devices-grant-row" role="note">
          <span>{grant.capabilities.gitWrite ? "Git changes" : "Restoring checkpoints"} also needs Terminal, because Git can run other programs on this computer. It won't work until that's on.</span>
          <button type="button" className="secondary-button" disabled={saving || !grant.view} onClick={() => onChange({ ...grant, capabilities: { ...grant.capabilities, terminal: true } })}>Turn on Terminal</button>
        </div>
      )}
      <p className="devices-note">Choosing projects sets what it can open. It isn't a sandbox: a task with enough permission can still reach files outside those projects.</p>
      <span className="sr-only" role="status">{saving ? "Saving access settings…" : ""}</span>
    </div>
  );
}

function PairedDeviceRow({ device, snapshot, projects, onError }: { device: RemoteDevice; snapshot: RemoteSnapshot; projects: readonly Project[]; onError: (message: string) => void }) {
  const [showAccess, setShowAccess] = useState(false);
  const [savingGrant, setSavingGrant] = useState(false);
  const grantPending = useRef(false);
  const grantFocus = useRef<HTMLButtonElement | null>(null);
  const help = deviceHelp(device, snapshot);
  const [retrying, setRetrying] = useState(false);
  const retry = () => {
    setRetrying(true);
    void remoteFindNearby().then(acceptRemoteSnapshot).catch(fail(`Mythra Code couldn't try ${device.name} again. Try again.`)).finally(() => setRetrying(false));
  };
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
      `Remove ${device.name}'s access?\n\nIt disconnects now and can't use this computer again unless it asks and you allow it. Work it already started here keeps running.`,
      { confirmLabel: "Remove access", cancelLabel: "Cancel" },
    );
    if (confirmed) await remoteDeviceRevoke(device.fingerprint).then(acceptRemoteSnapshot).catch(fail("Mythra Code couldn't remove that access. Try again."));
  };
  const forget = async () => {
    if (grantPending.current) return;
    const confirmed = await confirmDialog(
      `Forget ${device.name}?\n\nThis computer stops using it. To go back, ask ${device.name} for access again. Nothing changes on ${device.name}.`,
      { confirmLabel: "Forget", cancelLabel: "Cancel" },
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
            {device.grant && device.canView ? " · You can use each other" : device.grant ? " · It can use this computer" : " · This computer can use it"}
            {device.grant && ` · ${grantSummary(device.grant)}`}
          </small>
          <small className="devices-fingerprint" title={device.fingerprint}>ID {device.shortFingerprint}</small>
        </div>
        <div className="set-control devices-row-actions">
          {device.grant && <button type="button" className="secondary-button" aria-expanded={showAccess} title={`Choose exactly what ${device.name} can do here`} onClick={() => setShowAccess((current) => !current)}>More</button>}
          {device.grant && <button type="button" className="secondary-button devices-danger" aria-label={`Remove ${device.name}'s access`} disabled={savingGrant} onClick={() => void revoke()}>Remove access</button>}
          {device.canView && <button type="button" className="secondary-button devices-danger" aria-label={`Forget ${device.name}`} disabled={savingGrant} onClick={() => void forget()}>Forget</button>}
        </div>
      </div>
      {help && <p className="devices-help">{help}</p>}
      {deviceHelpOffersRetry(device) && <button type="button" className="secondary-button" disabled={retrying} onClick={retry}>Try again</button>}
      {device.grant && showAccess && <GrantEditor device={device} grant={device.grant} projects={projects} saving={savingGrant} onChange={saveGrant} />}
    </div>
  );
}

/** What an access setting adds up to, in the words of the two answers. */
function grantSummary(grant: DeviceGrant): string {
  if (!grant.view) return "No access";
  if (!grant.work) return "View only";
  const all = grant.scope.kind === "all" && Object.values(grant.capabilities).every(Boolean);
  return all ? "Full use" : "Custom access";
}

export function DevicesSettings({ projects }: { projects: readonly Project[] }) {
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

  const rawNetwork = networkHelp(snapshot);
  const network = rawNetwork?.localNetwork && visibleOutgoing(snapshot).some(showsLocalNetwork) ? null : rawNetwork;
  const reopened = useDeclines((state) => state.reopened);
  const incoming = incomingRequests(snapshot, reopened);
  const declined = declinedRequests(snapshot, reopened);
  const outgoing = visibleOutgoing(snapshot);
  const nearby = askableNearby(snapshot);
  return (
    <section className="settings-section devices-settings">
      <p className="settings-footnote" role="note"><Info size={13} aria-hidden="true" /><span>Changes on this page take effect right away. There's nothing to save.</span></p>
      <div className="set-group">
        <h4>This computer</h4>
        <div className="set-card">
          <div className="set-row">
            <div className="set-copy">
              <strong>{HOSTING_LABEL}</strong>
              <small id={hostingHelpId}>{HOSTING_HELP}</small>
            </div>
            <div className="set-control">
              {changing && <LoaderCircle size={14} className="spin" aria-hidden="true" />}
              <Switch label={HOSTING_LABEL} describedBy={hostingHelpId} checked={snapshot.hosting} disabled={changing} onChange={setHosting} />
            </div>
          </div>
          <div className="set-row">
            <div className="set-copy">
              <strong>Name</strong>
              <small id={nameHelpId}>How this computer appears on your other computers.</small>
            </div>
            <div className="set-control key-input-row">
              <input
                aria-label="Name"
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
          <details className="devices-more">
            <summary>More</summary>
            <div className="set-row">
              <div className="set-copy">
                <strong>Show this name to nearby computers</strong>
                <small id={shareHelpId}>When this is off, your other computers see a plain network name until they're connected.</small>
              </div>
              <div className="set-control">
                <Switch label="Show this name to nearby computers" describedBy={shareHelpId} checked={snapshot.shareName} onChange={setShare} />
              </div>
            </div>
          </details>
        </div>
        {snapshot.hostError && <p className="settings-footnote devices-error" role="alert"><Info size={13} aria-hidden="true" /><span>{snapshot.hostError}</span></p>}
        {network && (
          <p className={`settings-footnote ${network.localNetwork ? "local-network-note" : ""}`} role={network.localNetwork ? "alert" : "note"}>
            <Info size={13} aria-hidden="true" />
            <span>{network.text}</span>
            {network.localNetwork ? <LocalNetworkActions retrying={searching} onRetry={findNearby} />
              : network.canRetry && <button type="button" className="secondary-button" disabled={searching} onClick={findNearby}>Try again</button>}
          </p>
        )}
        {snapshot.refusedAdapters > 0 && <p className="settings-footnote" role="note"><Info size={13} aria-hidden="true" /><span>Windows wouldn't announce this computer on every network it's connected to. Computers on those networks may not find it.</span></p>}
        {snapshot.unsavedChanges && <p className="settings-footnote devices-error" role="alert"><Info size={13} aria-hidden="true" /><span>Your latest change is active, but Mythra Code hasn't saved it yet and is still trying. If you quit now, it may be undone.</span></p>}
        {error && <p className="settings-footnote devices-error" role="alert"><Info size={13} aria-hidden="true" /><span>{error}</span></p>}
      </div>

      {incoming.length > 0 && (
        <div className="set-group">
          <h4>Asking to use this computer</h4>
          <div className="access-list">{incoming.map((request) => <IncomingRequestCard key={request.requestId} request={request} />)}</div>
        </div>
      )}
      <DeclineUndo />

      <div className="set-group">
        <h4>Use another computer</h4>
        {outgoing.length > 0 && <div className="access-list">{outgoing.map((request) => <OutgoingRequestCard key={request.requestId} request={request} />)}</div>}
        <div className="set-card">
          {nearby.map((device) => <NearbyRow key={device.instance} device={device} snapshot={snapshot} onError={setError} />)}
          {nearby.length === 0 && (
            <div className="set-row">
              <div className="set-copy">
                <strong>{snapshot.browsing ? "Looking for your other computers…" : "No other computers found"}</strong>
                <small>On the other computer, open Mythra Code and turn on {HOSTING_LABEL}. It shows up here, and you can ask to use it.</small>
              </div>
              {!snapshot.browsing && (
                <div className="set-control">
                  <button type="button" className="secondary-button" disabled={searching} onClick={findNearby}>
                    {searching ? <LoaderCircle size={13} className="spin" /> : <Radar size={13} />} Look again
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        <p className="settings-footnote" role="note"><Info size={13} aria-hidden="true" /><span>Both computers need Mythra Code open and the same network. Once you're connected, switch between them from the menu at the top of the sidebar.</span></p>
      </div>

      {declined.length > 0 && (
        <div className="set-group">
          <h4>Declined requests</h4>
          <div className="set-card">{declined.map((request) => <DeclinedRow key={request.requestId} request={request} />)}</div>
          <p className="settings-footnote" role="note"><Info size={13} aria-hidden="true" /><span>Kept for 7 days, in case you change your mind.</span></p>
        </div>
      )}

      {snapshot.devices.length > 0 && (
        <div className="set-group">
          <div className="set-group-head"><h4>Connected computers</h4></div>
          <div className="set-card">
            {snapshot.devices.map((device) => <PairedDeviceRow key={device.fingerprint} device={device} snapshot={snapshot} projects={projects} onError={setError} />)}
          </div>
        </div>
      )}
    </section>
  );
}
