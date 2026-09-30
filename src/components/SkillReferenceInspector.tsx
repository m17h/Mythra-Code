import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type FocusEvent, type KeyboardEvent, type PointerEvent, type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Boxes, Check, CircleDashed, CornerLeftUp, FileText, RotateCcw, X } from "lucide-react";
import type { SkillDependencyReport } from "../types";
import { validSkillDependencyReport } from "../lib/skillDependencies";
import {
  buildSkillReferenceMap, describeSkillReferenceMap, isFailure, skillReasonLabel,
  type SkillMapItem, type SkillReferenceMap,
} from "../lib/skillReferenceMap";
import { adoptPortalTheme, effectiveZoom, supportsTopLayer } from "../lib/floatingLayer";
import "./skill-reference-inspector.css";

interface TokenRange { start: number; end: number; skill: { name: string } }
type Origin = "pointer" | "caret" | "keyboard";
interface Active { start: number; name: string; origin: Origin; x?: number; y?: number }
interface Selection { value: string; start: number; end: number }

const HOVER_OPEN_MS = 260;
const HOVER_CLOSE_MS = 180;
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Mirror spans are pointer-free; locate the token under a pointer by their
 * geometry instead, limited to the textarea's visible text box. */
export function skillTokenAtPoint(textarea: HTMLTextAreaElement, highlight: HTMLElement | null, x: number, y: number): number | null {
  if (!highlight) return null;
  const box = textarea.getBoundingClientRect();
  const scale = textarea.offsetWidth ? box.width / textarea.offsetWidth : 1;
  const right = box.left + (textarea.clientLeft + textarea.clientWidth) * scale;
  const bottom = box.top + (textarea.clientTop + textarea.clientHeight) * scale;
  if (x < box.left || x > right || y < box.top || y > bottom) return null;
  for (const span of highlight.querySelectorAll<HTMLElement>("[data-skill-start]")) {
    for (const rect of span.getClientRects()) {
      if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top && y <= rect.bottom) return Number(span.dataset.skillStart);
    }
  }
  return null;
}

/** True when an Escape at `target` belongs to a skill editor's own floating
 * surface (its completion list or dependency map) rather than to the popover
 * or dialog that contains the editor. Capture-phase owners must defer. */
export function skillEditorOwnsEscape(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(".skill-reference-inspector")
    || target.matches('[data-skill-prompt-editor="true"][aria-expanded="true"], [data-skill-inspector-open="true"]'));
}

function caretToken<T extends TokenRange>(ranges: readonly T[], selection: Selection): T | undefined {
  // A caret before "@" belongs to the preceding text; at the name's end it
  // still belongs to the token, as with native word selection.
  return ranges.find((range) => selection.start > range.start && selection.end <= range.end);
}

export function useSkillReferenceInspector({
  textareaRef, highlightRef, ranges, report, pending = false, error = "", channel, suppressed = false,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  highlightRef: RefObject<HTMLElement | null>;
  ranges: readonly TokenRange[];
  report?: SkillDependencyReport | null;
  pending?: boolean;
  error?: string;
  channel?: "system" | "user";
  suppressed?: boolean;
}) {
  const validated = useMemo(() => report ? validSkillDependencyReport(report) ?? null : null, [report]);
  const invalid = Boolean(report) && !validated;
  // Keyed by the authored names, not their offsets: ordinary typing moves
  // ranges on every keystroke but rarely changes which references exist.
  const names = useMemo(() => [...new Set(ranges.map((range) => range.skill.name.toLowerCase()))].join("\n"), [ranges]);
  const maps = useMemo(() => new Map<string, SkillReferenceMap>(names ? names.split("\n").map((name) =>
    [name, buildSkillReferenceMap(name, { report: validated, invalid, pending, error, channel })]) : []),
  [names, validated, invalid, pending, error, channel]);
  const flaggedNames = useMemo(() => new Set([...maps].filter(([, map]) => map.flagged).map(([name]) => name)), [maps]);
  // With no analyzer there is nothing truthful to show beyond the token.
  const hasData = Boolean(report) || pending || Boolean(error);

  const [active, setActive] = useState<Active | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const timers = useRef({ open: 0, close: 0 });
  const pendingStart = useRef<number | null>(null);
  const lastSelection = useRef<Selection | null>(null);
  const dismissed = useRef<Selection | null>(null);
  /** Focus arrived without a pointer placing the caret. WebKit reports 0–0
   * during focus and then restores the old caret with a selection change;
   * that restoration is not navigation and must not open a map. */
  const restoring = useRef(false);
  const placing = useRef(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const current = active ? ranges.find((range) => range.start === active.start && range.skill.name.toLowerCase() === active.name) : undefined;
  const map = current && active ? maps.get(active.name) : undefined;
  const open = Boolean(map && hasData && !suppressed);

  const clearTimers = () => {
    pendingStart.current = null;
    window.clearTimeout(timers.current.open);
    window.clearTimeout(timers.current.close);
  };
  const close = useCallback(() => {
    window.clearTimeout(timers.current.open);
    window.clearTimeout(timers.current.close);
    setActive(null);
  }, []);
  const scheduleClose = () => {
    window.clearTimeout(timers.current.close);
    timers.current.close = window.setTimeout(() => {
      if (activeRef.current?.origin === "pointer") setActive(null);
    }, HOVER_CLOSE_MS);
  };
  useEffect(() => () => clearTimers(), []);
  // A map that cannot show is dropped, never parked: a completion or workflow
  // list owning the caret, an edit that removed the token, or an owner that
  // closed and stopped analyzing. Otherwise the old map would resurface when
  // the list closes or the owner reopens, without a fresh hover or caret move.
  useEffect(() => {
    if (!active || open) return;
    clearTimers();
    setActive(null);
  }, [active, open]);
  // Native capture listeners see every key and press, including those an
  // owner's own handler consumes before calling into this hook.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const key = () => { restoring.current = false; };
    const press = () => { placing.current = true; restoring.current = false; };
    textarea.addEventListener("keydown", key, true);
    textarea.addEventListener("pointerdown", press, true);
    return () => {
      textarea.removeEventListener("keydown", key, true);
      textarea.removeEventListener("pointerdown", press, true);
    };
  }, [textareaRef]);

  const selectionOf = (textarea: HTMLTextAreaElement): Selection => ({ value: textarea.value, start: textarea.selectionStart, end: textarea.selectionEnd });
  const flaggedAt = (selection: Selection) => {
    const token = caretToken(ranges, selection);
    return token && maps.get(token.skill.name.toLowerCase())?.flagged ? token : undefined;
  };

  const onPointerMove = (event: PointerEvent<HTMLTextAreaElement>) => {
    if (event.pointerType === "touch" || event.buttons) {
      pendingStart.current = null;
      window.clearTimeout(timers.current.open);
      return;
    }
    const start = hasData ? skillTokenAtPoint(event.currentTarget, highlightRef.current, event.clientX, event.clientY) : null;
    const range = start === null ? undefined : ranges.find((candidate) => candidate.start === start);
    const now = activeRef.current;
    if (!range) {
      pendingStart.current = null;
      window.clearTimeout(timers.current.open);
      if (now?.origin === "pointer") scheduleClose();
      return;
    }
    window.clearTimeout(timers.current.close);
    if (now?.start === range.start || pendingStart.current === range.start) return;
    const next: Active = { start: range.start, name: range.skill.name.toLowerCase(), origin: "pointer", x: event.clientX, y: event.clientY };
    window.clearTimeout(timers.current.open);
    pendingStart.current = range.start;
    // Moving between tokens while a map is showing swaps it without delay.
    timers.current.open = window.setTimeout(() => { pendingStart.current = null; setActive(next); }, now ? 0 : HOVER_OPEN_MS);
  };
  const onPointerLeave = () => {
    pendingStart.current = null;
    window.clearTimeout(timers.current.open);
    if (activeRef.current?.origin === "pointer") scheduleClose();
  };

  const onFocus = (textarea: HTMLTextAreaElement) => {
    lastSelection.current = selectionOf(textarea);
    restoring.current = !placing.current;
  };
  /** Caret navigation (arrows, click, tap) into a red token opens its map.
   * Typing never does: a fresh report arriving under the caret stays quiet,
   * and so does the caret a focused field restores. */
  const onSelect = (textarea: HTMLTextAreaElement) => {
    const previous = lastSelection.current;
    const next = selectionOf(textarea);
    lastSelection.current = next;
    placing.current = false;
    if (restoring.current) {
      restoring.current = false;
      return;
    }
    const now = activeRef.current;
    if (!previous || previous.value !== next.value) {
      dismissed.current = null;
      if (now && now.origin !== "pointer") close();
      return;
    }
    if (previous.start === next.start && previous.end === next.end) return;
    const held = dismissed.current;
    if (held && (held.start !== next.start || held.end !== next.end)) dismissed.current = null;
    const token = next.start === next.end ? flaggedAt(next) : undefined;
    if (token && !dismissed.current) {
      if (now?.start !== token.start) setActive({ start: token.start, name: token.skill.name.toLowerCase(), origin: "caret" });
    } else if (now && now.origin !== "pointer") {
      close();
    }
  };

  /** Returns true when the inspector consumed the key. */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      dismissed.current = selectionOf(event.currentTarget);
      close();
      return true;
    }
    const mac = isMac();
    const modifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    // Also available while the completion list is open at a finished name;
    // the caller closes that list when this returns true.
    if (modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "i" && hasData) {
      const token = caretToken(ranges, selectionOf(event.currentTarget));
      if (!token) return false;
      event.preventDefault();
      clearTimers();
      setActive({ start: token.start, name: token.skill.name.toLowerCase(), origin: "keyboard" });
      return true;
    }
    return false;
  };
  const onBlur = (event: FocusEvent<HTMLTextAreaElement>) => {
    placing.current = false;
    restoring.current = false;
    const next = event.relatedTarget as Node | null;
    if (next && layerRef.current?.contains(next)) return;
    if (activeRef.current && activeRef.current.origin !== "pointer") close();
  };
  const onScroll = () => { if (activeRef.current?.origin === "pointer") close(); };

  const anchor = useCallback((): DOMRect | null => {
    const textarea = textareaRef.current;
    const target = activeRef.current;
    if (!textarea || !target) return null;
    const box = textarea.getBoundingClientRect();
    const span = highlightRef.current?.querySelector<HTMLElement>(`[data-skill-start="${target.start}"]`);
    const rects = span ? [...span.getClientRects()] : [];
    const visible = rects.filter((rect) => rect.bottom > box.top && rect.top < box.bottom);
    const rect = (target.x !== undefined && target.y !== undefined
      ? visible.find((candidate) => target.x! >= candidate.left - 1 && target.x! <= candidate.right + 1 && target.y! >= candidate.top && target.y! <= candidate.bottom)
      : undefined) ?? visible[0];
    if (!rect) return box;
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
    const left = clamp(rect.left, box.left, box.right);
    const top = clamp(rect.top, box.top, box.bottom);
    return new DOMRect(left, top, clamp(rect.right, box.left, box.right) - left, clamp(rect.bottom, box.top, box.bottom) - top);
  }, [textareaRef, highlightRef]);

  const returnFocus = useCallback(() => {
    close();
    textareaRef.current?.focus();
  }, [close, textareaRef]);

  const descriptionId = `${id}-description`;
  const inspector = open && map && active ? <>
    <span id={descriptionId} hidden>{describeSkillReferenceMap(map)}</span>
    <SkillReferenceInspector
      key={`${active.start}:${active.name}`}
      id={`${id}-inspector`} map={map} origin={active.origin} layerRef={layerRef} sourceRef={textareaRef} anchor={anchor}
      onPointerEnter={() => window.clearTimeout(timers.current.close)}
      onPointerLeave={() => { if (activeRef.current?.origin === "pointer") scheduleClose(); }}
      onDismiss={returnFocus}
      onClose={close}
    />
  </> : null;

  return {
    maps,
    flaggedNames,
    open,
    activeStart: open && active ? active.start : null,
    describedBy: open ? descriptionId : undefined,
    inspector,
    handlers: { onPointerMove, onPointerLeave, onFocus, onSelect, onKeyDown, onBlur, onScroll },
  };
}

const STATE_LABELS: Record<SkillReferenceMap["state"], string> = {
  ready: "Loads", held: "Held", blocked: "Blocked", incomplete: "Incomplete",
  checking: "Checking", unavailable: "Unavailable", unknown: "No data",
};

function compactNumber(value: number): string {
  return value >= 10_000 ? `${Math.round(value / 1000)}k` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function summary(map: SkillReferenceMap): string {
  const { counts } = map;
  const items = counts.loads + counts.held;
  const parts = [`${counts.skills} skill${counts.skills === 1 ? "" : "s"}`];
  if (counts.documents) parts.push(`${counts.documents} document${counts.documents === 1 ? "" : "s"}`);
  switch (map.state) {
    case "checking": return "Checking this reference's dependencies…";
    case "unavailable": return "The dependency check could not run, so nothing is shown as loaded.";
    case "incomplete": return "The dependency report is incomplete, so nothing is shown as loaded.";
    case "unknown": return map.flagged ? "Not in the dependency report. The turn is blocked." : "Not in the latest dependency report.";
    case "ready": return `${parts.join(" · ")} · ${compactNumber(counts.characters)} characters load`;
    case "held": return `Resolves, but nothing is sent while ${map.blockedElsewhere.join(", ") || "another reference"} is blocked.`;
    case "blocked": {
      const more = counts.blocked > 1 ? ` · ${counts.blocked - 1} more blocked` : "";
      if (map.firstFailure) {
        const path = map.failure.length > 1 ? map.failure.slice(1).join(" → ") : "this reference";
        return `${map.firstFailure.reasonLabel ?? "Blocked"} · ${path}${more}`;
      }
      if (map.rootIssues.length) return `${skillReasonLabel(map.rootIssues[0].code)} · this reference cannot load`;
      return map.turnIssues.length ? "A turn-level problem blocks every reference." : `Blocked · ${items} resolved`;
    }
  }
}

function StatusIcon({ item }: { item: SkillMapItem }) {
  const size = 11;
  if (item.status === "blocked") return <X size={size} aria-hidden="true" />;
  if (item.status === "cycle") return <RotateCcw size={size} aria-hidden="true" />;
  if (item.status === "repeat") return item.failurePath ? <X size={size} aria-hidden="true" /> : <CornerLeftUp size={size} aria-hidden="true" />;
  if (item.status === "held") return <CircleDashed size={size} aria-hidden="true" />;
  return <Check size={size} aria-hidden="true" />;
}

function statusText(item: SkillMapItem): string {
  switch (item.status) {
    case "loads": return "Loads";
    case "held": return "Held";
    case "repeat": return item.reasonLabel ?? (item.repeatOf === "blocked" ? "Blocked above" : "Listed above");
    default: return item.reasonLabel ?? "Blocked";
  }
}

function MapItem({ item }: { item: SkillMapItem }) {
  const failed = isFailure(item);
  return <li className={`sri-item is-${item.status}${failed ? " is-failed" : ""}${item.failurePath ? " on-path" : ""}`}>
    <div className="sri-row" title={item.path || item.reference}>
      {item.kind === "skill" ? <Boxes size={12} aria-hidden="true" /> : <FileText size={12} aria-hidden="true" />}
      <span className="sri-name">
        <span className="sri-label">{item.label}</span>
        <span className="sri-sr"> {item.kind}{item.location ? " in" : ""} </span>
        {item.location && <span className="sri-where"><bdi>{item.location}</bdi></span>}
      </span>
      <span className="sri-status"><StatusIcon item={item} />{statusText(item)}</span>
    </div>
    {failed && item.reason && <p className="sri-reason">{item.reason}</p>}
    {failed && item.reference && item.reference !== item.label && <code className="sri-reference">{item.reference}</code>}
    {item.children.length > 0 && <ul role="list">{item.children.map((child) => <MapItem key={child.key} item={child} />)}</ul>}
  </li>;
}

function IssueList({ title, issues }: { title: string; issues: SkillReferenceMap["rootIssues"] }) {
  if (!issues.length) return null;
  return <section className="sri-issues" aria-label={title}>
    <h4>{title}</h4>
    <ul role="list">
      {issues.map((issue, index) => <li key={`${issue.code}:${index}`}>
        <strong>{skillReasonLabel(issue.code)}</strong>
        <span>{issue.message}</span>
        {issue.chain.length > 1 && <small>{issue.chain.join(" → ")}</small>}
      </li>)}
    </ul>
  </section>;
}

export function SkillReferenceInspector({ id, map, origin, layerRef, sourceRef, anchor, onPointerEnter, onPointerLeave, onDismiss, onClose }: {
  id: string;
  map: SkillReferenceMap;
  origin: Origin;
  layerRef: RefObject<HTMLDivElement | null>;
  sourceRef: RefObject<HTMLElement | null>;
  anchor: () => DOMRect | null;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onDismiss: () => void;
  onClose: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const topLayer = supportsTopLayer();
  const titleId = `${id}-title`;
  const summaryId = `${id}-summary`;

  const place = useCallback(() => {
    const layer = layerRef.current;
    const source = sourceRef.current;
    const rect = anchor();
    if (!layer || !source || !rect) return;
    if (!topLayer) adoptPortalTheme(layer, source);
    const zoom = effectiveZoom(layer);
    const margin = 8;
    const gap = 6 * zoom;
    const width = Math.min(356 * zoom, window.innerWidth - margin * 2);
    layer.style.width = `${width / zoom}px`;
    layer.style.maxHeight = `${Math.max(1, Math.min(420 * zoom, window.innerHeight - margin * 2)) / zoom}px`;
    let height = layer.offsetHeight * zoom;
    const below = window.innerHeight - rect.bottom - gap - margin;
    const above = rect.top - gap - margin;
    const side = height <= below || below >= above ? "below" : "above";
    const room = Math.max(96 * zoom, side === "below" ? below : above);
    if (height > room) {
      layer.style.maxHeight = `${room / zoom}px`;
      height = layer.offsetHeight * zoom;
    }
    const preferred = side === "below" ? rect.bottom + gap : rect.top - gap - height;
    const top = Math.max(margin, Math.min(preferred, window.innerHeight - height - margin));
    const left = Math.max(margin, Math.min(rect.left - 10 * zoom, window.innerWidth - width - margin));
    layer.style.top = `${top / zoom}px`;
    layer.style.left = `${left / zoom}px`;
    layer.dataset.side = side;
    layer.style.visibility = "visible";
  }, [anchor, layerRef, sourceRef, topLayer]);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (topLayer && layer && !layer.matches(":popover-open")) layer.showPopover();
    place();
  });
  useLayoutEffect(() => {
    if (origin === "keyboard") bodyRef.current?.focus({ preventScroll: true });
  }, [origin]);
  useEffect(() => {
    const source = sourceRef.current;
    const observer = new ResizeObserver(place);
    if (source) observer.observe(source);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [place, sourceRef]);
  // Owners such as Settings stay mounted while closed: they turn inert and
  // hide instead. A top-layer map would outlive that, then reappear stale on
  // reopen, so it closes as soon as its source stops being usable.
  useEffect(() => {
    const source = sourceRef.current;
    if (!source) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      if (!source.isConnected || source.closest("[inert]")
        || source.checkVisibility?.({ visibilityProperty: true }) === false) onClose();
    };
    const observer = new MutationObserver(() => { frame ||= requestAnimationFrame(check); });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["inert", "hidden", "class"] });
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [onClose, sourceRef]);

  const shortcut = isMac() ? "⌘I" : "Ctrl+I";
  const blocked = map.state === "blocked" || map.state === "incomplete";
  const note = map.state === "blocked" || map.state === "held"
    ? "Nothing is sent until every reference resolves."
    : map.state === "incomplete" || map.state === "unavailable" ? "Delivery checks again before sending." : "";

  const layer = <div
    ref={layerRef}
    id={id}
    role="dialog"
    aria-labelledby={titleId}
    aria-describedby={summaryId}
    tabIndex={-1}
    className={`skill-reference-inspector is-${map.state}${topLayer ? "" : " is-portaled"}`}
    data-origin={origin}
    popover={topLayer ? "manual" : undefined}
    // Portaled layers stay in React's tree; keep outside-click handlers of
    // the owning dialog from treating a click here as an outside click.
    onPointerDown={(event) => event.stopPropagation()}
    onPointerEnter={onPointerEnter}
    onPointerLeave={onPointerLeave}
    onKeyDown={(event) => {
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      }
    }}
    onBlur={(event) => {
      const next = event.relatedTarget as Node | null;
      if (next && (event.currentTarget.contains(next) || next === sourceRef.current)) return;
      if (origin !== "pointer") onClose();
    }}
  >
    <header className="sri-head">
      {blocked ? <AlertTriangle size={13} aria-hidden="true" /> : <Boxes size={13} aria-hidden="true" />}
      <strong id={titleId}>@{map.name}<span className="sri-sr"> skill reference</span></strong>
      <span className="sri-state">{STATE_LABELS[map.state]}</span>
    </header>
    <p className="sri-summary" id={summaryId}>{summary(map)}</p>
    <div ref={bodyRef} className="sri-body" tabIndex={-1} role="group" aria-label={`Dependencies of @${map.name}`}>
      {map.state === "checking" && <p className="sri-empty">Waiting for the dependency check. Earlier results are not shown.</p>}
      {map.state === "unavailable" && <p className="sri-empty">{map.error}</p>}
      {map.state === "incomplete" && <p className="sri-empty">{map.rootIssues.length
        ? "The resolver dropped the graph because its diagnostics were too large."
        : "The dependency report failed validation, so its graph is not shown."}</p>}
      {map.root && <ul className="sri-tree" role="list"><MapItem item={map.root} /></ul>}
      {map.truncated && <p className="sri-empty">Only the first 400 entries are shown.</p>}
      <IssueList title={map.root ? "Also reported for this reference" : "Reported for this reference"} issues={map.rootIssues} />
      <IssueList title="Affects every reference" issues={map.turnIssues} />
    </div>
    <footer className="sri-foot">
      <span>{note}</span>
      <span className="sri-keys" aria-hidden="true">{origin === "keyboard"
        ? <><kbd>Esc</kbd> back to text</>
        : <><kbd>{shortcut}</kbd> inspect</>}</span>
    </footer>
  </div>;
  return topLayer ? layer : createPortal(layer, document.body);
}
