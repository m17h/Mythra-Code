import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, LoaderCircle, MonitorSmartphone, Radar, RefreshCw, Settings2 } from "lucide-react";
import { safeErrorText } from "../../lib/errors";
import { LOCAL_MACHINE, switchMachine, useActiveMachine } from "../../lib/remote/activeMachine";
import { remoteFindNearby, remotePairNearby } from "../../lib/remote/client";
import { consumeEscapeUntilRelease } from "../../lib/remote/focus";
import {
  acceptRemoteSnapshot,
  deviceDotState,
  deviceStateLabel,
  hasPairingSheet,
  localMachineLabel,
  networkHelp,
  startRemoteDevices,
  useRemoteDevices,
} from "../../lib/remote/devices";
import type { RemoteDevice } from "../../lib/remote/types";
import { PairingSheets, PendingFlow } from "./PairingSheets";
import { LocalNetworkActions } from "./LocalNetworkActions";
import "./MachineSwitcher.css";

function StatusDot({ device }: { device: RemoteDevice }) {
  return <span className={`machine-dot ${deviceDotState(device)}`} aria-hidden="true" />;
}

export function MachineSwitcher({ onManageDevices, pairingBlocked = false }: { onManageDevices: () => void; pairingBlocked?: boolean }) {
  const snapshot = useRemoteDevices((state) => state.snapshot);
  const initialization = useRemoteDevices((state) => state.initialization);
  const initializationError = useRemoteDevices((state) => state.initializationError);
  const pairingPending = useRemoteDevices(hasPairingSheet);
  const [open, setOpen] = useState(false);
  const active = useActiveMachine((state) => state.machine);
  const activeName = useActiveMachine((state) => state.name);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const closeMenu = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => startRemoteDevices(), []);
  useEffect(() => {
    // Do not let this disclosure's Escape listener compete with a sheet.
    if (pairingPending) setOpen(false);
  }, [pairingPending]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || pairingPending) return;
      // Closes this menu and never reaches the handler that stops a running turn.
      event.preventDefault();
      event.stopPropagation();
      consumeEscapeUntilRelease();
      closeMenu();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [closeMenu, open, pairingPending]);

  const local = localMachineLabel(snapshot);
  const paired = snapshot?.devices.filter((device) => device.canView) ?? [];
  const nearby = snapshot?.nearby ?? [];
  const device = paired.find((entry) => entry.fingerprint === active) ?? null;
  const remoteActive = active !== LOCAL_MACHINE;
  const activeLabel = remoteActive ? device?.name ?? activeName ?? "Remote device" : local;
  // With nothing to switch to, the sidebar looks the way it always has.
  const network = snapshot ? networkHelp(snapshot) : null;
  // A Mac kept off the network would otherwise look like a quiet, empty switcher.
  const quiet = !remoteActive && paired.length === 0 && nearby.length === 0 && !network?.localNetwork;
  const looking = Boolean(snapshot?.browsing);
  const ready = initialization === "ready" && Boolean(snapshot?.ready);

  const findNearby = () => {
    setSearching(true);
    setError("");
    remoteFindNearby()
      .then(acceptRemoteSnapshot)
      .catch((reason) => setError(safeErrorText(reason, "Mythra Code couldn't look for nearby devices. Try again.")))
      .finally(() => setSearching(false));
  };

  const choose = (machine: string, name: string | null = null) => {
    setError("");
    if (!switchMachine(machine, name)) {
      setError("Finish dictating first, then switch devices.");
      return;
    }
    closeMenu();
  };

  const pair = (instance: string) => {
    setError("");
    // The row is transient; use the persistent trigger as the sheet's opener.
    closeMenu();
    remotePairNearby(instance)
      .then((next) => {
        acceptRemoteSnapshot(next);
        setOpen(false);
      })
      .catch((reason) => {
        setError(safeErrorText(reason, "Mythra Code couldn't start pairing. Try again."));
        setOpen(true);
      });
  };

  return (
    <div className="machine-switcher" ref={rootRef} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button
        ref={triggerRef}
        type="button"
        className={`machine-switcher-trigger ${quiet ? "quiet" : ""}`}
        aria-expanded={open}
        aria-label={`Choose a device, ${activeLabel}`}
        aria-controls={open ? menuId : undefined}
        title={remoteActive ? `Choose a device · ${activeLabel}` : "Choose which device to work on"}
        onClick={() => setOpen((current) => !current)}
      >
        {device && <StatusDot device={device} />}
        {!device && network?.localNetwork && <span className="machine-dot unreachable" role="img" aria-label="Local network access is off" />}
        {!quiet && <span>{activeLabel}</span>}
        <ChevronDown size={13} aria-hidden="true" />
      </button>

      {open && (
        <div className="machine-menu" id={menuId} role="group" aria-label="Devices">
          <button type="button" className="machine-row" aria-pressed={!remoteActive} onClick={() => choose(LOCAL_MACHINE)}>
            <MonitorSmartphone size={14} aria-hidden="true" />
            <span className="machine-row-name">{local}</span>
            {!remoteActive && <Check size={14} className="machine-row-check" aria-label="Selected" />}
          </button>

          {!ready && <p className="machine-menu-note" role="status">{initializationError ?? "Loading devices…"}</p>}
          {initialization === "failed" && <button type="button" className="machine-row" onClick={startRemoteDevices}>Try again</button>}
          {paired.length > 0 && <p className="machine-menu-label">Paired devices</p>}
          {paired.map((entry) => (
            <button
              type="button"
              className="machine-row"
              key={entry.fingerprint}
              disabled={!ready}
              aria-pressed={device?.fingerprint === entry.fingerprint}
              title={entry.name}
              onClick={() => choose(entry.fingerprint, entry.name)}
            >
              <StatusDot device={entry} />
              <span className="machine-row-name">{entry.name}</span>
              <small>{deviceStateLabel(entry)}</small>
              {device?.fingerprint === entry.fingerprint && <Check size={14} className="machine-row-check" aria-label="Selected" />}
            </button>
          ))}

          {nearby.length > 0 && <p className="machine-menu-label">Nearby, available to pair</p>}
          {nearby.map((entry) => (
            <button type="button" className="machine-row" key={entry.instance} title={entry.name} disabled={!ready} onClick={() => pair(entry.instance)}>
              <Radar size={14} aria-hidden="true" />
              <span className="machine-row-name">{entry.name}</span>
              <small>Pair</small>
            </button>
          ))}

          {ready && (!looking ? (
            <button type="button" className="machine-row" disabled={searching} onClick={findNearby}>
              {searching ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Radar size={14} aria-hidden="true" />}
              <span className="machine-row-name">Find nearby devices</span>
            </button>
          ) : nearby.length === 0 && (
            <p className="machine-menu-note">Looking for nearby devices. On your other computer, turn on Allow access from nearby devices, then choose Pair a device.</p>
          ))}

          {network && <p className="machine-menu-note" role={network.localNetwork ? "alert" : undefined}>{network.text}</p>}
          {network?.localNetwork ? <LocalNetworkActions row retrying={searching} onRetry={findNearby} /> : network?.canRetry && (
            <button type="button" className="machine-row" disabled={searching} onClick={findNearby}>
              <RefreshCw size={14} aria-hidden="true" />
              <span className="machine-row-name">Try again</span>
            </button>
          )}
          {snapshot?.flow && snapshot.flow.stage !== "done" && <PendingFlow flow={snapshot.flow} row onError={setError} />}
          {error && <p className="machine-menu-note error" role="alert">{error}</p>}

          <button type="button" className="machine-row subtle" onClick={() => { closeMenu(); onManageDevices(); }}>
            <Settings2 size={14} aria-hidden="true" />
            <span className="machine-row-name">Manage devices</span>
          </button>
        </div>
      )}

      <PairingSheets onManageDevices={onManageDevices} blocked={pairingBlocked} returnFocusRef={triggerRef} />
    </div>
  );
}
