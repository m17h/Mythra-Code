// Live theme previews (Theme library cards and details): a miniature,
// non-interactive copy of the Mythra Code window with the theme applied, its
// effects (ThemeEffectsLayer) and its sanitized customCss included.
//
// Isolation: the copy is drawn inside a shadow root. The app's stylesheets are
// shared into it (replicaSheets.ts), so it looks exactly like the app, but the
// theme on screen can't restyle it (document rules don't cross the shadow
// boundary) and its own theme is compiled for [data-ct-replica] only, so it
// can't restyle the app either.
//
// Cost: nothing is built until the card first comes near the screen
// (IntersectionObserver). Only an animating preview moves: still previews stop
// every animation and transition, and their particle canvas draws one frame.
// Particle canvases are sized for the card, not the 1200px window.
//
// Content is fixed sample text: no user data, no app state, no focusable
// element (the host is inert and aria-hidden, and nothing takes a pointer).

import "./CustomThemePreview.css";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, CalendarClock, ChevronDown, Circle, Folder, Gauge, GitPullRequest, MessageSquare, Mic, PanelLeftClose, PanelRight, Paperclip, Play, Plus, Search, Settings, ShieldCheck, SlidersHorizontal, Users } from "lucide-react";
import { ProviderLogo } from "./BrandLogos";
import { MythraMark } from "./MythraMark";
import { ThemeEffectsLayer } from "./ThemeEffectsLayer";
import { isThemeMotionTransientlyPaused, subscribeThemeMotion } from "../lib/customThemes/motion";
import { REPLICA_SIZE } from "../lib/customThemes/replicaCss";
import { adoptReplicaSheets, appSheet, themeSheet } from "../lib/customThemes/replicaSheets";
import { builtInScheme, type CustomThemeId, type ThemeSpec } from "../lib/customThemes/spec";
import { resolveTheme } from "../lib/customThemes/validate";
import { formatColor } from "../lib/customThemes/color";

function forcedColors(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(forced-colors: active)").matches;
}

/** seen: has come near the screen once (build it); onScreen: visible right now (may animate). */
function useVisibility(ref: RefObject<HTMLElement | null>): { seen: boolean; onScreen: boolean } {
  const [state, setState] = useState({ seen: false, onScreen: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver !== "function") { setState({ seen: true, onScreen: true }); return; }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const near = entry.isIntersecting;
      setState((current) => (current.onScreen === near && (current.seen || !near) ? current : { seen: current.seen || near, onScreen: near }));
    }, { rootMargin: "160px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return state;
}

// Building a replica costs a render and a style pass for ~150 nodes. A library
// opening with 20 cards on screen would do them all in one long frame, so
// builds are handed out a couple per frame, the details preview first.
const BUILDS_PER_FRAME = 2;
const buildQueue: Array<() => void> = [];
let buildFrame = 0;
function pumpBuilds() {
  buildFrame = 0;
  for (let i = 0; i < BUILDS_PER_FRAME && buildQueue.length; i++) buildQueue.shift()!();
  if (buildQueue.length) buildFrame = requestAnimationFrame(pumpBuilds);
}
/** Ask for a build slot; returns a cancel function. */
function requestBuild(run: () => void, first: boolean): () => void {
  if (typeof requestAnimationFrame !== "function") { run(); return () => undefined; }
  if (first) buildQueue.unshift(run); else buildQueue.push(run);
  if (!buildFrame) buildFrame = requestAnimationFrame(pumpBuilds);
  return () => {
    const index = buildQueue.indexOf(run);
    if (index >= 0) buildQueue.splice(index, 1);
  };
}

/** True while theme motion is paused for a moment (window hidden or in the background, a pane drag). */
function useTransientPause(): boolean {
  const [paused, setPaused] = useState(isThemeMotionTransientlyPaused);
  useEffect(() => subscribeThemeMotion(setPaused), []);
  return paused;
}

export interface CustomThemePreviewProps {
  id: CustomThemeId;
  spec: ThemeSpec;
  /** The revision drawn (caches the compiled theme); any number works for unsaved specs. */
  revision?: number;
  /** Hovered, focused or the details preview, and motion is allowed. */
  animate: boolean;
  /** False when the app wouldn't run this theme's customCss (safe mode). */
  customCssEnabled?: boolean;
  /** Build before the grid's cards (the details preview). */
  eager?: boolean;
}

export function CustomThemePreview({ id, spec, revision = 0, animate, customCssEnabled = true, eager = false }: CustomThemePreviewProps) {
  const outerRef = useRef<HTMLSpanElement | null>(null);
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const { seen, onScreen } = useVisibility(outerRef);
  const paused = useTransientPause();
  const [mount, setMount] = useState<{ root: ShadowRoot; frame: HTMLDivElement } | null>(null);
  const [granted, setGranted] = useState(false);
  const [pixelRatio, setPixelRatio] = useState(0.5);

  const base = useMemo(() => {
    try {
      const resolved = resolveTheme(spec);
      return { scheme: resolved.scheme, bg: formatColor(resolved.palette.bg) };
    } catch {
      return { scheme: builtInScheme(spec.base), bg: "" };
    }
  }, [spec]);
  const css = customCssEnabled && !forcedColors();
  const sheet = useMemo(() => (granted ? themeSheet(id, revision, spec, css) : null), [granted, id, revision, spec, css]);
  const moving = Boolean(animate && onScreen && !paused && spec.motion?.enabled !== false && sheet?.hasMotion);

  // Build the shadow root the first time the card comes near the screen, when its turn comes.
  useEffect(() => {
    if (!seen || granted) return;
    return requestBuild(() => setGranted(true), eager);
  }, [seen, granted, eager]);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!granted || !host || mount) return;
    host.setAttribute("inert", "");
    let root: ShadowRoot;
    try {
      // Closed: nothing outside (page scripts, automation, the theme tools' inspectors) can reach in.
      root = host.attachShadow({ mode: "closed" });
    } catch {
      return; // no shadow DOM: the card keeps its plain background
    }
    const frame = document.createElement("div");
    frame.className = "ct-replica-frame";
    root.appendChild(frame);
    setMount({ root, frame });
  }, [granted, mount]);

  useLayoutEffect(() => {
    if (!mount || !sheet) return;
    adoptReplicaSheets(mount.root, [appSheet(), sheet]);
  }, [mount, sheet]);

  // Scale the 1200x750 window to cover the card. Written straight to the node (no render).
  useLayoutEffect(() => {
    const outer = outerRef.current;
    if (!mount || !outer) return;
    const fit = () => {
      const width = outer.clientWidth;
      const height = outer.clientHeight;
      if (!width || !height) return;
      const scale = Math.max(width / REPLICA_SIZE.width, height / REPLICA_SIZE.height);
      mount.frame.style.transform = `scale(${scale.toFixed(4)})`;
      // The particle canvas only needs the card's pixels; quarter steps avoid redraws on every resize.
      const ratio = Math.max(0.25, Math.min(1.5, Math.ceil(scale * (window.devicePixelRatio || 1) * 4) / 4));
      setPixelRatio((current) => (current === ratio ? current : ratio));
    };
    fit();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(fit);
    observer.observe(outer);
    return () => observer.disconnect();
  }, [mount]);

  return (
    <span ref={outerRef} className="ct-preview" data-ct-preview={id} data-built={mount ? "" : undefined} data-animate={moving ? "on" : "off"} data-scheme={base.scheme} aria-hidden="true" style={base.bg ? { backgroundColor: base.bg } : undefined}>
      <span ref={hostRef} className="ct-preview-host" />
      {mount && sheet && createPortal(
        <ReplicaWindow id={id} spec={spec} scheme={base.scheme} moving={moving} pixelRatio={pixelRatio} />,
        mount.frame,
      )}
    </span>
  );
}

// ---- The window ------------------------------------------------------------------
// Real class names from App.tsx, SidebarLists.tsx, ChatTimeline and the composer, with
// fixed sample content. Keep it close to the real markup: the theme's customCss and the
// design kit's region map (designKit.ts) target these selectors.

type Vars = CSSProperties & Record<`--${string}`, string | number>;

const PROJECTS = ["harbor-app", "ledger-api", "field-notes"];
const THREADS: Array<{ title: string; active?: boolean }> = [
  { title: "Polish the settings page", active: true },
  { title: "Fix flaky checkout test" },
  { title: "Add a dark mode toggle" },
  { title: "Speed up product search" },
  { title: "Write release notes for 2.4" },
];

function ReplicaWindow({ id, spec, scheme, moving, pixelRatio }: { id: CustomThemeId; spec: ThemeSpec; scheme: "light" | "dark"; moving: boolean; pixelRatio: number }) {
  const motion = moving ? "on" : "paused";
  return (
    <div
      className="app-shell"
      data-ct-replica=""
      data-ct-still={moving ? undefined : ""}
      data-theme={spec.base}
      data-color-scheme={scheme}
      data-custom-theme={id}
      data-theme-motion={motion}
      data-model-provider="openai"
      data-effort-slider="studio"
      data-chat-font="system"
      data-openai-logo="openai"
      data-claude-logo="claude"
      data-cursor-logo="cube"
      style={{ "--ui-scale": 1 } as Vars}
    >
      <ThemeEffectsLayer spec={spec} id={id} motion={motion} pixelRatio={pixelRatio} />
      <ReplicaSidebar />
      <ReplicaMain />
    </div>
  );
}

function Row({ children, className }: { children: ReactNode; className: string }) {
  return <button type="button" tabIndex={-1} className={className}>{children}</button>;
}

function ReplicaSidebar() {
  return (
    <aside className="sidebar open" style={{ "--sidebar-width": "260px" } as Vars}>
      <div className="sidebar-brand">
        <div className="brand-mark"><MythraMark /></div>
        <span>Mythra Code</span>
        <div className="machine-switcher">
          <Row className="machine-switcher-trigger"><span>This Mac</span><ChevronDown size={13} /></Row>
        </div>
        <Row className="icon-button subtle collapse-button"><PanelLeftClose size={17} /></Row>
      </div>
      <Row className="new-thread-button"><Plus size={16} /><span>New thread</span><kbd>⌘N</kbd></Row>
      <div className="sidebar-sections" style={{ "--sidebar-split": "30%" } as Vars}>
        <div className="sidebar-machine-lists">
          <div className="sidebar-section workspaces-section">
            <div className="section-label-row">
              <span className="section-label">Projects</span>
              <Row className="icon-button tiny"><Plus size={14} /></Row>
            </div>
            <div className="workspace-list">
              <Row className="workspace-row chat"><span className="workspace-icon chat"><MessageSquare size={14} /></span><span className="workspace-name">Chats</span></Row>
              {PROJECTS.map((name, index) => (
                <div key={name} className={`workspace-row-wrap${index === 0 ? " active" : ""}`}>
                  <Row className="workspace-row"><span className="workspace-icon"><Folder size={14} /></span><span className="workspace-name">{name}</span><span className="workspace-counts" /></Row>
                </div>
              ))}
            </div>
          </div>
          <div className="sidebar-section-resize" />
          <div className="sidebar-section threads-section">
            <div className="section-label-row">
              <span className="section-label">Threads</span>
              <span className="section-label-tools"><span className="row-menu"><Row className="row-menu-trigger"><SlidersHorizontal size={14} /></Row></span></span>
            </div>
            <div className="thread-search-actions">
              <label className="thread-search"><Search size={11} /><input tabIndex={-1} readOnly placeholder={`Search ${PROJECTS[0]}…`} defaultValue="" /></label>
            </div>
            <div className="thread-list">
              {THREADS.map((thread) => (
                <div key={thread.title} className={`thread-row-wrap${thread.active ? " active" : ""}`}>
                  <Row className="thread-card provider-openai">
                    <span className="thread-card-context"><span className="thread-card-workspace"><Folder size={11} /><span>{PROJECTS[0]}</span></span></span>
                    <span className="thread-title thread-card-title" data-state="settled"><span className="thread-title-text">{thread.title}</span></span>
                    <span className="thread-card-meta">
                      <span className="thread-card-directory">code/{PROJECTS[0]}</span>
                      <span className="thread-card-provider openai"><ProviderLogo provider="openai" size={13} /></span>
                    </span>
                  </Row>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="sidebar-footer">
        <Row className="sidebar-settings"><Settings size={15} /><span>Settings</span><kbd>⌘,</kbd></Row>
      </div>
    </aside>
  );
}

function ReplicaMain() {
  return (
    <main className="main-panel">
      <div className="local-machine-surface">
        <header className="topbar">
          <div className="topbar-left">
            <div className="project-heading">
              <span>{PROJECTS[0]}</span>
              <small><span className="thread-title" data-state="settled"><span className="thread-title-text">{THREADS[0].title}</span></span></small>
            </div>
            <Row className="thread-pr-chip empty"><GitPullRequest size={13} /><span>Pull requests</span></Row>
          </div>
          <div className="topbar-right">
            <div className="runtime-status" data-status="ready"><Circle size={7} /><span>Ready</span></div>
            <div className="project-run-control">
              <Row className="project-run-trigger unset"><Play size={13} /><span>Run</span></Row>
              <Row className="project-run-edit"><ChevronDown size={13} /></Row>
            </div>
            <Row className="command-palette-trigger"><Search size={13} /><span>Search</span><kbd>⌘K</kbd></Row>
            <span className="topbar-usage-slot"><span className="usage-popover-anchor">
              <Row className="topbar-usage-chip openai"><Gauge size={13} /><span className="usage-chip-text"><span className="usage-chip-window">5h · </span><span className="usage-chip-value">62%</span><span className="usage-chip-suffix"> left</span></span><ChevronDown size={12} /></Row>
            </span></span>
            <Row className="workspace-tools-trigger studio-toggle"><PanelRight size={15} /><span>Tools</span><kbd>⌘B</kbd></Row>
          </div>
        </header>
        <section className="conversation">
          <div className="timeline-shell" data-scroll-mode="following-end">
            <div className="timeline flow-timeline">
              <div className="timeline-top-space" />
              <div className="flow-timeline-list">
                <div className="timeline-entry timeline-entry-message">
                  <article className="message user">
                    <div className="message-avatar"><span>You</span></div>
                    <div className="message-body">
                      <div className="message-text rich-markdown"><p>The settings page feels cramped. Can you tighten the spacing and line up the switches?</p></div>
                    </div>
                  </article>
                </div>
                <div className="timeline-entry timeline-entry-message">
                  <article className="message assistant">
                    <div className="message-avatar provider-openai"><ProviderLogo provider="openai" size={14} /></div>
                    <div className="message-body">
                      <div className="message-text rich-markdown">
                        <p>Done. The rows now share one <strong>8px grid</strong>, and every switch sits on the same edge.</p>
                        <ul>
                          <li>Moved the row spacing into <code>--row-gap</code>.</li>
                          <li>Aligned the controls with <a href="#preview" tabIndex={-1}>the shared layout</a>.</li>
                        </ul>
                        <div className="code-block has-header">
                          <div className="code-block-header"><span className="code-block-language">CSS</span></div>
                          <pre><code><span className="syn-punct">.</span><span className="syn-function">settings-row</span> <span className="syn-punct">{"{"}</span>{"\n"}  <span className="syn-keyword">display</span><span className="syn-punct">:</span> grid<span className="syn-punct">;</span>{"\n"}  <span className="syn-keyword">gap</span><span className="syn-punct">:</span> <span className="syn-string">var(--row-gap)</span><span className="syn-punct">;</span>{"\n"}<span className="syn-punct">{"}"}</span></code></pre>
                        </div>
                        <p>Want me to apply the same spacing to the Tools panel?</p>
                      </div>
                    </div>
                  </article>
                </div>
              </div>
              <div className="timeline-bottom-space" />
            </div>
          </div>
        </section>
        <section className="composer-zone ambiance-openai">
          <div className="composer">
            <div className="composer-input-wrap">
              <textarea tabIndex={-1} readOnly rows={1} aria-hidden="true" defaultValue="Yes, and match the empty states too." style={{ height: 68, overflowY: "hidden" }} />
            </div>
            <div className="model-power-control sol">
              <div className="thread-provider-control composer-provider-control">
                <Row className="provider-pill openrouter-trigger">
                  <span className="provider-mark openai"><ProviderLogo provider="openai" size={13} /></span>
                  <span className="openrouter-trigger-copy"><small>Provider</small><strong>OpenAI</strong></span>
                  <ChevronDown size={13} />
                </Row>
              </div>
              <div className="model-picker">
                <Row className="model-picker-trigger">
                  <span className="model-orb named-model-art"><img alt="" draggable={false} src="/model-icons/sol.png" /></span>
                  <span className="model-picker-copy"><small>Model</small><strong>GPT-5.6 Sol</strong><em>Detail and polish</em></span>
                  <ChevronDown size={13} />
                </Row>
              </div>
              <div className="reasoning-control">
                <div className="reasoning-heading"><Gauge size={12} /><span>Reasoning</span><strong>Medium</strong></div>
                <div className="reasoning-rail" style={{ "--reasoning-fill": "25%", "--effort-heat": 0.25 } as Vars}>
                  <div className="reasoning-ticks"><i className="reached" /><i className="reached current" /><i /><i /><i /></div>
                  <input tabIndex={-1} readOnly min="0" max="4" step="any" type="range" defaultValue="1" />
                </div>
                <div className="reasoning-labels"><span>Light</span><span className="active">Medium</span><span>High</span><span>Extra</span><span>Max</span></div>
              </div>
            </div>
            <div className="composer-toolbar">
              <div className="composer-controls">
                <div className="permission-control"><Row className="toolbar-button permission-trigger mode-ask"><ShieldCheck size={14} />Ask to act<ChevronDown size={12} /></Row></div>
                <div className="subagent-control"><Row className="toolbar-button agents-button enabled"><span className="sa-trigger-content"><Users size={14} />Sub-agents: 1</span></Row></div>
                <Row className="toolbar-button attach-button"><Paperclip size={14} />Attach</Row>
              </div>
              <div className="composer-actions">
                <Row className="voice-input-button"><Mic size={15} /></Row>
                <Row className="schedule-button"><CalendarClock size={15} /></Row>
                <Row className="send-button"><ArrowUp size={16} /></Row>
              </div>
            </div>
          </div>
          <div className="composer-caption">Mythra Code can make mistakes. Review commands and changes before shipping.</div>
        </section>
      </div>
    </main>
  );
}

export default CustomThemePreview;
