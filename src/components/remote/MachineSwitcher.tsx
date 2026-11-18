import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Switch } from "../Switch";
import { Check, ChevronDown, LoaderCircle, MonitorSmartphone, Radar, RefreshCw, Settings2 } from "lucide-react";
import { safeErrorText } from "../../lib/errors";
import { LOCAL_MACHINE, switchMachine, useActiveMachine } from "../../lib/remote/activeMachine";
import { remoteFindNearby, remoteSetHosting } from "../../lib/remote/client";
import { consumeEscapeUntilRelease } from "../../lib/remote/focus";
import {
  acceptRemoteSnapshot,
  deviceDotState,
  deviceStateLabel,
  incomingRequests,
  localMachineLabel,
  networkHelp,
  startRemoteDevices,
  useRemoteDevices,
} from "../../lib/remote/devices";
import type { RemoteDevice } from "../../lib/remote/types";
import { LocalNetworkActions } from "./LocalNetworkActions";
import { askableNearby, DeclineUndo, HOSTING_LABEL, IncomingRequestCard, NearbyRow, OutgoingRequestCard, showsLocalNetwork, useDeclines, visibleOutgoing } from "./AccessRequests";
import "./MachineSwitcher.css";
import "./AccessRequests.css";

function StatusDot({ device }: { device: RemoteDevice }) {
  return <span className={`machine-dot ${deviceDotState(device)}`} aria-hidden="true" />;
}

export function MachineSwitcher({ onManageDevices }: { onManageDevices: () => void }) {
  const snapshot = useRemoteDevices((state) => state.snapshot);
  const initialization = useRemoteDevices((state) => state.initialization);
  const initializationError = useRemoteDevices((state) => state.initializationError);
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

  const menuRef = useRef<HTMLDivElement>(null);
  const focusFirstRow = useRef<"first" | "last" | null>(null);
  const moveRow = useCallback((step: "next" | "previous" | "first" | "last") => {
    const rows = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), [role='switch']:not(:disabled)") ?? [])
      .filter((row) => row.getClientRects().length > 0);
    if (!rows.length) return;
    const index = rows.indexOf(document.activeElement as HTMLElement);
    const next = step === "first" ? 0 : step === "last" ? rows.length - 1
      : index < 0 ? (step === "next" ? 0 : rows.length - 1)
      : (index + (step === "next" ? 1 : -1) + rows.length) % rows.length;
    rows[next]?.focus();
  }, []);
  // Opened from the keyboard: focus lands on the first (or last) row.
  useEffect(() => {
    if (!open || !focusFirstRow.current) return;
    const where = focusFirstRow.current;
    focusFirstRow.current = null;
    requestAnimationFrame(() => moveRow(where));
  }, [moveRow, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
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
  }, [closeMenu, open]);

  const local = localMachineLabel(snapshot);
  const paired = snapshot?.devices.filter((device) => device.canView) ?? [];
  const nearby = askableNearby(snapshot);
  const reopened = useDeclines((state) => state.reopened);
  const incoming = incomingRequests(snapshot, reopened);
  const outgoing = visibleOutgoing(snapshot);
  const [changing, setChanging] = useState(false);
  const device = paired.find((entry) => entry.fingerprint === active) ?? null;
  const remoteActive = active !== LOCAL_MACHINE;
  const activeLabel = remoteActive ? device?.name ?? activeName ?? "Remote device" : local;
  // With nothing to switch to, the sidebar looks the way it always has.
  const outgoingCards = snapshot ? visibleOutgoing(snapshot) : [];
  const rawNetwork = snapshot ? networkHelp(snapshot) : null;
  // A request card already carries the Local Network help; say it once.
  const network = rawNetwork?.localNetwork && outgoingCards.some(showsLocalNetwork) ? null : rawNetwork;
  // Always findable: this menu is where other computers are found and answered.
  const quiet = false;
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

  const setHosting = (enabled: boolean) => {
    setChanging(true);
    setError("");
    remoteSetHosting(enabled)
      .then(acceptRemoteSnapshot)
      .catch((reason) => setError(safeErrorText(reason, "Mythra Code couldn't change that setting. Try again.")))
      .finally(() => setChanging(false));
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
        onClick={(event) => {
          // detail is 0 for Enter/Space: keyboard users land on the first row.
          if (event.detail === 0 && !open) focusFirstRow.current = "first";
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          // Same entry keys as every other menu: ↓ opens on the first row.
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          focusFirstRow.current = event.key === "ArrowUp" ? "last" : "first";
          if (open) moveRow(event.key === "ArrowUp" ? "last" : "first");
          else setOpen(true);
        }}
      >
        {device && <StatusDot device={device} />}
        {!device && network?.localNetwork && <span className="machine-dot unreachable" role="img" aria-label="Local network access is off" />}
        {incoming.length > 0 && <span className="access-badge" aria-label={`${incoming.length} asking to use this computer`}>{incoming.length}</span>}
        {!quiet && <span>{activeLabel}</span>}
        <ChevronDown size={13} aria-hidden="true" />
      </button>

      {open && (
        <div ref={menuRef} className="machine-menu" id={menuId} role="group" aria-label="Devices" onKeyDown={(event) => {
          // ↑/↓ move between the rows and buttons; Home/End jump to the ends.
          const step = { ArrowDown: "next", ArrowUp: "previous", Home: "first", End: "last" }[event.key] as "next" | "previous" | "first" | "last" | undefined;
          if (!step || event.target instanceof HTMLInputElement) return;
          event.preventDefault();
          moveRow(step);
        }}>
          <button type="button" className="machine-row" aria-pressed={!remoteActive} onClick={() => choose(LOCAL_MACHINE)}>
            <MonitorSmartphone size={14} aria-hidden="true" />
            <span className="machine-row-name">{local}</span>
            {!remoteActive && <Check size={14} className="machine-row-check" aria-hidden="true" />}
          </button>

          {!ready && <p className="machine-menu-note" role="status">{initializationError ?? "Loading devices…"}</p>}
          {initialization === "failed" && <button type="button" className="machine-row" onClick={startRemoteDevices}>Try again</button>}
          {incoming.length > 0 && <p className="machine-menu-label">Asking to use this computer</p>}
          {incoming.map((request) => <IncomingRequestCard key={request.requestId} request={request} compact />)}
          <DeclineUndo compact />

          {paired.length > 0 && <p className="machine-menu-label">Your computers</p>}
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
              {device?.fingerprint === entry.fingerprint && <Check size={14} className="machine-row-check" aria-hidden="true" />}
            </button>
          ))}

          {outgoing.map((request) => <OutgoingRequestCard key={request.requestId} request={request} compact />)}
          {ready && snapshot && nearby.length > 0 && <p className="machine-menu-label">Nearby computers</p>}
          {ready && snapshot && nearby.map((entry) => <NearbyRow key={entry.instance} device={entry} snapshot={snapshot} compact onError={setError} />)}
          {ready && nearby.length === 0 && outgoing.length === 0 && (looking
            ? <p className="machine-menu-note" role="status">Looking for your other computers… On the other one, turn on {HOSTING_LABEL} in Mythra Code.</p>
            : <button type="button" className="machine-row" disabled={searching} onClick={findNearby}>
              {searching ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Radar size={14} aria-hidden="true" />}
              <span className="machine-row-name">Find my other computers</span>
            </button>)}

          {network && <p className="machine-menu-note" role={network.localNetwork ? "alert" : undefined}>{network.text}</p>}
          {network?.localNetwork ? <LocalNetworkActions row retrying={searching} onRetry={findNearby} /> : network?.canRetry && (
            <button type="button" className="machine-row" disabled={searching} onClick={findNearby}>
              <RefreshCw size={14} aria-hidden="true" />
              <span className="machine-row-name">Try again</span>
            </button>
          )}
          {error && <p className="machine-menu-note error" role="alert">{error}</p>}

          {ready && snapshot && <div className="access-switch">
            <span>{HOSTING_LABEL}<small>Also shows this computer's name on your network.</small></span>
            <Switch checked={snapshot.hosting} onChange={(next) => setHosting(next)} label={HOSTING_LABEL} disabled={changing} />
          </div>}
          <button type="button" className="machine-row subtle" onClick={() => { closeMenu(); onManageDevices(); }}>
            <Settings2 size={14} aria-hidden="true" />
            <span className="machine-row-name">Manage devices</span>
          </button>
        </div>
      )}

    </div>
  );
}
