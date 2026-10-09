import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, Download, LoaderCircle, RefreshCw } from "lucide-react";
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
} from "../lib/languageTools";
import "./LanguageToolsSettings.css";

const STATE_LABELS: Record<LanguageToolState, string> = {
  installed: "Verified",
  available: "Not yet verified",
  missing: "Not installed",
  installing: "Installing…",
  error: "Setup failed",
  unavailable: "Prerequisite needed",
};

function verifiedInstallation(snapshot: LanguageToolsSnapshot | null, id: string | null): boolean {
  return Boolean(id && snapshot?.tools.some((tool) => tool.id === id && tool.state === "installed" && tool.health === "verified"));
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
    // Inventory cannot prove a settings write persisted, but an exact tool's
    // successful server verification does resolve that tool's setup failure.
    if (errorKind.current === "mutation" && verifiedInstallation(next, failedInstall.current)) {
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

  const run = async (key: string, action: () => Promise<LanguageToolsSnapshot>, outcome: (next: LanguageToolsSnapshot) => { message: string; failed?: boolean }) => {
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
        if (completion.failed) {
          errorKind.current = "mutation";
          failedInstall.current = installId;
          setError(completion.message);
        }
        else setNotice(completion.message);
      }
    } catch (reason) {
      if (mounted.current && epoch === lifetime.current) {
        if (!verifiedInstallation(currentSnapshot.current, installId)) {
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

  return <section className="set-group language-tools-settings" aria-label="Language tools" aria-describedby={descriptionId}>
    <div className="set-group-head">
      <h4>Language tools</h4>
      <span className="set-group-note">saved immediately</span>
    </div>
    <div id={descriptionId} className="language-tools-description">
      <p>Installs are shared by all projects on this computer. Existing tools, including tools installed by a model, are reused.</p>
      <p>Installed, enabled language servers let tool-capable models look up definitions, references, symbol information, and file symbols. Claude Code also receives native code-intelligence integration.</p>
      <p>Framework and native-language tools require Full access because project configuration can execute code. Basic TypeScript, Python, HTML/CSS/JSON, and YAML lookups also work in Ask and Read-only modes.</p>
      <p>Setup downloads local tools and uses disk space. It does not call a model or spend API tokens.</p>
    </div>
    <div className="set-card" aria-busy={pending !== null}>
      <div className="set-row">
        <div className="set-copy"><strong>Automatic setup for new project threads</strong><small>Install enabled tools needed by a new project's languages. Turn off to install tools individually. Disabled tools are excluded.</small><small>Automatic and model-requested installation requires Full access. In Ask or Read-only mode, use Install here.</small></div>
        <div className="set-control"><button type="button" role="switch" aria-label="Automatic setup for new project threads" aria-checked={snapshot?.autoInstall ?? true} className={`toggle-switch ${snapshot?.autoInstall !== false ? "on" : ""}`} disabled={!snapshot || pending !== null} onClick={() => void run("automatic", () => setLanguageToolsAutoInstall(!snapshot!.autoInstall), (next) => ({ message: `Automatic setup ${next.autoInstall ? "enabled" : "disabled"}.` }))}><span /></button></div>
      </div>
      {snapshot?.tools.map((tool) => {
        const installing = tool.state === "installing" || pending === `install:${tool.id}`;
        const hasInstallation = tool.state === "installed" || tool.state === "available";
        const checkingTool = checking && hasInstallation && tool.enabled && !installing;
        return <div key={tool.id} className="set-row language-tools-row">
          <div className="set-copy">
            <strong>{tool.name}</strong>
            <small>{tool.languages.join(" · ")}</small>
            <span className="language-tools-state" data-state={tool.state} role={tool.state === "error" ? "alert" : undefined}>
              {installing || checkingTool ? <LoaderCircle size={13} className="language-tools-spinner" aria-hidden="true" /> : null}
              {installing ? "Installing…" : !tool.enabled ? "Disabled" : checkingTool ? "Checking…" : tool.state === "available" && tool.health === "stale" ? "Verification expired" : tool.state === "error" && tool.health === "error" ? "Verification failed" : STATE_LABELS[tool.state]}
            </span>
            {tool.detail && <small className="language-tools-detail">{tool.detail}</small>}
          </div>
          <div className="set-control language-tools-controls">
            <label className="language-tools-enabled"><input type="checkbox" aria-label={`Enable ${tool.name}`} checked={tool.enabled} disabled={pending !== null || installing} onChange={(event) => {
              const enabled = event.currentTarget.checked;
              void run(`enabled:${tool.id}`, () => setLanguageToolEnabled(tool.id, enabled), (next) => ({ message: `${tool.name} ${next.tools.find((entry) => entry.id === tool.id)?.enabled ? "enabled" : "disabled"}.` }));
            }} /> Enabled</label>
            {hasInstallation && !installing ? <span className="language-tools-installed" role="img" aria-label={`${tool.name} installed`}>
              <Check size={15} aria-hidden="true" /> Installed
            </span> : <button type="button" className="secondary-button" aria-label={`${tool.state === "error" ? "Retry installing" : "Install"} ${tool.name}`} disabled={pending !== null || installing || tool.state === "unavailable"} onClick={() => void run(`install:${tool.id}`, () => installLanguageTool(tool.id), (next) => {
              const updated = next.tools.find((entry) => entry.id === tool.id);
              return {
                message: updated?.state === "installed" ? `${tool.name} is installed.` : `${tool.name}: ${updated?.detail || `setup is ${updated?.state ?? "pending"}.`}`,
                failed: updated?.state !== "installed",
              };
            })}><Download size={13} aria-hidden="true" />{installing ? "Installing…" : tool.state === "error" ? "Retry install" : "Install"}</button>}
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
