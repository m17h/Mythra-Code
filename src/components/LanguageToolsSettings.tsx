import { SettingInfo, Switch } from "./SettingsBits";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, Download, ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { safeErrorText } from "../lib/errors";
import {
  installLanguageTool,
  languageToolsSnapshot,
  refreshLanguageTools,
  listenLanguageToolsChanged,
  setLanguageToolEnabled,
  setLanguageToolsAutoInstall,
  type LanguageToolsSnapshot,
  type LanguageToolState,
  type LanguageToolStatus,
} from "../lib/languageTools";
import "./LanguageToolsSettings.css";

const STATE_LABELS: Record<LanguageToolState, string> = {
  installed: "Ready",
  available: "Not checked yet",
  missing: "Not installed",
  installing: "Installing…",
  error: "Couldn’t set up",
  unavailable: "Needs a prerequisite",
};

function rustPrerequisiteCommand(tool: LanguageToolStatus | undefined): string | undefined {
  return tool?.id === "rust" && tool.enabled && tool.state === "unavailable" ? tool.installCommand : undefined;
}

function installErrorResolved(snapshot: LanguageToolsSnapshot | null, id: string | null): boolean {
  if (!id) return false;
  const tool = snapshot?.tools.find((entry) => entry.id === id);
  return Boolean((tool?.state === "installed" && tool.health === "verified") || rustPrerequisiteCommand(tool));
}

export function LanguageToolsSettings() {
  const [snapshot, setSnapshot] = useState<LanguageToolsSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const errorKind = useRef<"refresh" | "mutation" | null>(null);
  const failedInstall = useRef<string | null>(null);
  const [notice, setNotice] = useState("");
  const [listenerWarning, setListenerWarning] = useState("");
  const mounted = useRef(false);
  const lifetime = useRef(0);
  const currentSnapshot = useRef<LanguageToolsSnapshot | null>(null);
  const inFlight = useRef<object | null>(null);
  const dirty = useRef<number | null | undefined>(undefined);
  const healthQueued = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshNext = useRef<(verify?: boolean) => void>(() => undefined);
  const writing = useRef(false);
  const descriptionId = useId();

  const accept = useCallback((next: LanguageToolsSnapshot) => {
    const previous = currentSnapshot.current;
    if (!mounted.current || (previous && next.generation < previous.generation)) return false;
    // A verified tool or its specific prerequisite replaces an earlier setup
    // failure for that tool. Neither can establish that a settings write persisted.
    if (errorKind.current === "mutation" && installErrorResolved(next, failedInstall.current)) {
      setError("");
      errorKind.current = null;
      failedInstall.current = null;
    }
    if (previous && next.generation > previous.generation) {
      // A newer inventory can reflect an unrelated tool change. It cannot
      // establish that a rejected settings write was persisted successfully.
      if (errorKind.current !== "mutation") setError("");
      setNotice("");
    }
    currentSnapshot.current = next;
    setSnapshot(next);
    if (typeof dirty.current === "number" && dirty.current <= next.generation) dirty.current = undefined;
    return true;
  }, []);

  const refresh = useCallback(async (verify = false) => {
    if (!mounted.current) return;
    if (verify) healthQueued.current = true;
    if (inFlight.current || writing.current) return;
    clearTimeout(timer.current);
    timer.current = undefined;
    const token = {};
    const epoch = lifetime.current;
    const generation = currentSnapshot.current?.generation;
    const checkHealth = healthQueued.current;
    healthQueued.current = false;
    dirty.current = undefined;
    inFlight.current = token;
    setRefreshing(true);
    setChecking(checkHealth);
    try {
      const next = await (checkHealth ? refreshLanguageTools() : languageToolsSnapshot());
      if (epoch === lifetime.current && accept(next)) {
        if (errorKind.current === "refresh") setError("");
      }
    } catch (failure) {
      if (mounted.current && epoch === lifetime.current && generation === currentSnapshot.current?.generation && errorKind.current !== "mutation") {
        errorKind.current = "refresh";
        setError(`Could not refresh language tools. ${safeErrorText(failure)}`);
      }
    } finally {
      if (mounted.current && epoch === lifetime.current && inFlight.current === token) {
        inFlight.current = null;
        setRefreshing(false);
        setChecking(false);
        if (!writing.current && (dirty.current !== undefined || healthQueued.current)) {
          timer.current = setTimeout(() => refreshNext.current(), 50);
        }
      }
    }
  }, [accept]);

  useEffect(() => {
    mounted.current = true;
    lifetime.current += 1;
    refreshNext.current = (verify) => { void refresh(verify); };
    let disposed = false;
    let initialReadComplete = false;
    let unlisten: (() => void) | undefined;
    // Events are hints; only authoritative responses become visible state.
    void listenLanguageToolsChanged((generation) => {
      if (disposed || (generation !== undefined && generation <= (currentSnapshot.current?.generation ?? -1))) return;
      dirty.current = generation === undefined ? null : dirty.current === null ? null : Math.max(generation, dirty.current ?? -1);
      if (!inFlight.current && !writing.current && timer.current === undefined) {
        timer.current = setTimeout(() => refreshNext.current(), 50);
      }
    })
      .then((cleanup) => {
        if (disposed) cleanup();
        else {
          unlisten = cleanup;
          // If subscription was slower than the metadata read, reconcile the
          // interval in which an external change could have been missed.
          if (initialReadComplete) {
            dirty.current = null;
            if (!inFlight.current && !writing.current && timer.current === undefined) timer.current = setTimeout(() => refreshNext.current(), 50);
          }
        }
      })
      .catch(() => {
        if (!disposed) setListenerWarning("Live updates are unavailable. Use Refresh to check installations.");
      });
    // Stored metadata is independent of listener registration and health probes.
    void refresh().finally(() => { initialReadComplete = true; });
    return () => {
      disposed = true;
      mounted.current = false;
      lifetime.current += 1;
      inFlight.current = null;
      writing.current = false;
      dirty.current = undefined;
      healthQueued.current = false;
      clearTimeout(timer.current);
      timer.current = undefined;
      unlisten?.();
    };
  }, [refresh]);

  const run = async (key: string, action: () => Promise<LanguageToolsSnapshot>, outcome: (next: LanguageToolsSnapshot) => { message: string; failed?: boolean } | null) => {
    // A synchronous guard covers repeated clicks before React renders disabled.
    if (writing.current || !snapshot) return;
    writing.current = true;
    clearTimeout(timer.current);
    timer.current = undefined;
    const epoch = lifetime.current;
    const installId = key.startsWith("install:") ? key.slice("install:".length) : null;
    setPending(key);
    setError("");
    errorKind.current = null;
    failedInstall.current = null;
    setNotice("");
    try {
      const result = await action();
      if (epoch === lifetime.current && accept(result)) {
        const completion = outcome(result);
        if (completion?.failed) {
          errorKind.current = "mutation";
          failedInstall.current = installId;
          setError(completion.message);
        }
        else if (completion) setNotice(completion.message);
      }
    } catch (reason) {
      if (mounted.current && epoch === lifetime.current) {
        if (!installErrorResolved(currentSnapshot.current, installId)) {
          errorKind.current = "mutation";
          failedInstall.current = installId;
          setError(`${installId ? "Language tool setup could not complete." : "Language tool settings could not be saved."} ${safeErrorText(reason)}`);
        }
        // A rejected mutation may still have changed the registry.
        dirty.current = null;
      }
    } finally {
      if (epoch === lifetime.current) {
        writing.current = false;
        if (mounted.current) {
          setPending(null);
          if (!inFlight.current && (dirty.current !== undefined || healthQueued.current)) timer.current = setTimeout(() => refreshNext.current(), 50);
        }
      }
    }
  };

  return <section className="set-group language-tools-settings" id="tools-language" aria-label="Language tools" aria-describedby={descriptionId}>
    <div className="set-group-head">
      <h4 tabIndex={-1}>Language tools</h4>
    </div>
    <p id={descriptionId}>Language servers that let models look up definitions, references and symbols. <SettingInfo label="About language tools">Installs are shared by all projects on this computer, and existing tools (including ones a model installed) are reused. Claude Code also gets native code-intelligence integration. Framework and native-language tools need Full access because project configuration can run code; basic TypeScript, Python, HTML/CSS/JSON and YAML lookups also work in Ask to act and Read only modes. Setup downloads local tools and uses disk space. It doesn&rsquo;t call a model or spend API tokens.</SettingInfo></p>
    <div className="set-card" aria-busy={pending !== null}>
      <div className="set-row">
        <div className="set-copy"><strong>Automatic setup for new project threads</strong><small>Installs the enabled tools a new project&rsquo;s languages need. Needs Full access; in Ask to act or Read only mode, use Install here.</small></div>
        <div className="set-control"><Switch checked={snapshot?.autoInstall ?? true} label="Automatic setup for new project threads" disabled={!snapshot || pending !== null} onChange={() => void run("automatic", () => setLanguageToolsAutoInstall(!snapshot!.autoInstall), (next) => ({ message: `Automatic setup ${next.autoInstall ? "enabled" : "disabled"}.` }))} /></div>
      </div>
      {/* M07: name the switch column once, so "on but not installed" reads
          as intended (the switch decides whether an installed tool is used). */}
      {snapshot?.tools.length ? <div className="language-tools-columns" aria-hidden="true"><span>Tool</span><span>Use when installed</span></div> : null}
      {snapshot?.tools.map((tool) => {
        const installing = tool.state === "installing" || pending === `install:${tool.id}`;
        const hasInstallation = tool.state === "installed" || tool.state === "available";
        const installCommand = rustPrerequisiteCommand(tool);
        const checkingTool = checking && (hasInstallation || Boolean(installCommand)) && tool.enabled && !installing;
        const stateLabel = installing ? "Installing…" : !tool.enabled ? "Disabled" : checkingTool ? "Checking…" : tool.state === "available" && tool.health === "stale" ? "Not checked yet" : tool.state === "error" && tool.health === "error" ? "Couldn’t verify" : STATE_LABELS[tool.state];
        // Rust's prerequisite is outside Mythra Code: point at the official
        // installer instead of showing an Install button that can't work.
        const prerequisiteGuide = tool.state === "unavailable" && tool.id === "rust" ? "https://rustup.rs" : undefined;
        // A prerequisite the runtime names ("Needs rustup on this computer")
        // replaces the generic "Needs a prerequisite" line rather than repeating it.
        const namedPrerequisite = Boolean(prerequisiteGuide && tool.detail?.trim() && tool.enabled && !installing && !checkingTool);
        // M13: a ready tool says so once (the ✓ Installed mark on the right),
        // not "Ready" on the left as well.
        const showState = !(tool.state === "installed" && tool.enabled && !installing && !checkingTool) && !namedPrerequisite;
        // Skip lines that would only repeat the line above ("Python / Python").
        const languages = tool.languages.join(" · ");
        const showLanguages = languages && languages.toLowerCase() !== tool.name.toLowerCase();
        const showDetail = tool.detail && tool.detail.trim().toLowerCase() !== String(stateLabel).toLowerCase();
        return <div key={tool.id} className="set-row language-tools-row">
          <div className="set-copy">
            <strong>{tool.name}</strong>
            {showLanguages && <small>{languages}</small>}
            {showState && <span className="language-tools-state" data-state={tool.state} role={tool.state === "error" ? "alert" : undefined}>
              {installing || checkingTool ? <LoaderCircle size={13} className="language-tools-spinner" aria-hidden="true" /> : null}
              {stateLabel}
            </span>}
            {showDetail && <small className="language-tools-detail">{tool.detail}</small>}
            {installCommand && <code className="language-tools-install-command">{installCommand}</code>}
          </div>
          <div className="set-control language-tools-controls">
            {installCommand && !installing ? <button type="button" className="secondary-button" aria-label={`Refresh ${tool.name} verification`} disabled={refreshing || pending !== null} onClick={() => void refresh(true)}>
              <RefreshCw size={13} aria-hidden="true" />{checkingTool ? "Refreshing…" : "Refresh"}
            </button> : hasInstallation && !installing ? <span className="language-tools-installed" role="img" aria-label={`${tool.name} installed`}>
              <Check size={15} aria-hidden="true" /> Installed
            </span> : prerequisiteGuide && !installing ? <button type="button" className="secondary-button" onClick={() => void openUrl(prerequisiteGuide)} title="Opens rustup.rs, the official Rust installer, in your browser">
              <ExternalLink size={13} aria-hidden="true" />Get rustup
            </button> : tool.state === "unavailable" && !installing ? null : <button type="button" className="secondary-button" aria-label={`${tool.state === "error" ? "Retry installing" : "Install"} ${tool.name}`} disabled={pending !== null || installing} onClick={() => void run(`install:${tool.id}`, () => installLanguageTool(tool.id), (next) => {
              const updated = next.tools.find((entry) => entry.id === tool.id);
              if (rustPrerequisiteCommand(updated)) return null;
              return {
                message: updated?.state === "installed" ? `${tool.name} is installed.` : `${tool.name}: ${updated?.detail || "setup hasn’t finished yet."}`,
                failed: updated?.state !== "installed",
              };
            })}><Download size={13} aria-hidden="true" />{installing ? "Installing…" : tool.state === "error" ? "Retry install" : "Install"}</button>}
            {/* The switch sits last so every row's switch lines up with the
                "Automatic setup" switch above, whatever the action beside it. */}
            <Switch checked={tool.enabled} label={`Enable ${tool.name}`} disabled={pending !== null || installing} title={tool.enabled ? "Used when installed" : "Not used"} onChange={() => {
              const enabled = !tool.enabled;
              void run(`enabled:${tool.id}`, () => setLanguageToolEnabled(tool.id, enabled), (next) => ({ message: `${tool.name} ${next.tools.find((entry) => entry.id === tool.id)?.enabled ? "enabled" : "disabled"}.` }));
            }} />
          </div>
        </div>;
      })}
      <div className="set-body language-tools-footer">
        <div className="language-tools-messages" aria-live="polite">
          {!snapshot && !error && <p>Loading language tools…</p>}
          {pending && <p>{pending.startsWith("install:") ? "Installing the selected tool…" : "Saving language tool settings…"}</p>}
          {checking && <p>Checking installed servers…</p>}
          {snapshot?.tools.some((tool) => tool.state === "available") && <p>Available installations are shown immediately. Refresh verifies that servers can start.</p>}
          {notice && <p>{notice}</p>}
          {listenerWarning && <p>{listenerWarning}</p>}
          {error && <p role="alert">{error}</p>}
          {snapshot?.tools.length === 0 && <p>No language tools are available on this computer.</p>}
        </div>
        <button type="button" className="secondary-button" disabled={refreshing || pending !== null} onClick={() => void refresh(true)}><RefreshCw size={13} aria-hidden="true" />{refreshing ? "Refreshing…" : "Refresh language tools"}</button>
      </div>
    </div>
  </section>;
}
