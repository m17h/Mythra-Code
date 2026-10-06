import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowDownToLine, ChevronDown, ChevronRight, ChevronUp, CircleDot, FileCode2, FoldVertical, MessageSquareText, Sparkles, TerminalSquare, TriangleAlert, UsersRound, X } from "lucide-react";
import type { Activity, ChatMessage } from "../types";
import type { CompactWorkEntry, CompactWorkState } from "../lib/compactActivity";
import { adoptPortalTheme, effectiveZoom } from "../lib/floatingLayer";
import { prefersReducedMotion } from "../lib/flipRoster";
import { useModalFocus } from "../hooks/useModalFocus";
import { SETTLED_ACTIVITY_LABELS, UNCONFIRMED_ACTIVITY_LABEL, type ActivityStatusCategory } from "./ActivityStatus";
import "./ActivityDetailsModal.css";

/** Searchable text for one transcript entry, shared with timeline search. */
export function workEntrySearchText(entry: CompactWorkEntry): string {
  if (entry.kind === "message") return entry.value.text;
  if (entry.kind === "activity") return `${entry.value.title} ${entry.value.detail ?? ""}`;
  return entry.value.map((activity) => `${activity.title} ${activity.detail ?? ""}`).join(" ");
}

type ActivityStep =
  | { id: string; kind: "message"; value: ChatMessage }
  | { id: string; kind: "activity"; value: Activity }
  | { id: string; kind: "spawns"; value: Activity[] };

/** Flatten grouped tool runs so every operation is its own readable step. */
function stepsFor(entries: readonly CompactWorkEntry[]): ActivityStep[] {
  const steps: ActivityStep[] = [];
  for (const entry of entries) {
    if (entry.kind === "message") steps.push({ id: entry.value.id, kind: "message", value: entry.value });
    else if (entry.kind === "activity" && entry.value.kind === "agent" && entry.value.agent?.action === "spawn") {
      // A lone dispatch keeps its relay card and Open/Stop controls.
      steps.push({ id: entry.value.id, kind: "spawns", value: [entry.value] });
    } else if (entry.kind === "activity") steps.push({ id: entry.value.id, kind: "activity", value: entry.value });
    else if (entry.kind === "spawns") { if (entry.value[0]) steps.push({ id: entry.value[0].id, kind: "spawns", value: entry.value }); }
    else for (const activity of entry.value) steps.push({ id: activity.id, kind: "activity", value: activity });
  }
  return steps;
}

function stepSearchText(step: ActivityStep): string {
  if (step.kind === "message") return step.value.text;
  if (step.kind === "activity") return `${step.value.title} ${step.value.detail ?? ""}`;
  return step.value.map((activity) => `${activity.title} ${activity.detail ?? ""}`).join(" ");
}

const STATUS_WORDS: Record<string, string> = {
  inProgress: "Running", running: "Running", started: "Running", starting: "Starting", pending: "Pending",
  completed: "Done", succeeded: "Done", success: "Done", failed: "Failed", error: "Failed",
  interrupted: "Stopped", cancelled: "Cancelled", declined: "Declined",
};

function statusWord(status?: string): string | undefined {
  return status ? STATUS_WORDS[status] ?? status : undefined;
}

function statusTone(status?: string): "live" | "bad" | "stopped" | "" {
  if (status === "inProgress" || status === "running" || status === "started" || status === "starting" || status === "pending") return "live";
  if (status === "failed" || status === "error") return "bad";
  if (status === "interrupted" || status === "cancelled" || status === "declined") return "stopped";
  return "";
}

export interface ActivityDetailsRun {
  /** Original transcript entries for the whole logical run, in order. */
  entries: readonly CompactWorkEntry[];
  state: CompactWorkState;
  /** Live semantic status (never a decorative phrase). */
  label?: string;
  category?: ActivityStatusCategory;
  /** Settled summary, e.g. "Worked for 3 minutes · 4 commands". */
  summary?: string;
  /** The provider went idle before confirming the turn finished. */
  unconfirmed?: boolean;
}

export interface ActivityDetailsModalProps {
  run: ActivityDetailsRun;
  /** Item ids already shown in chat; drawn as context, not hidden work. */
  visibleIds?: ReadonlySet<string>;
  /** Step to bring into view on open (the clicked group or a search hit). */
  focusId?: string;
  searchQuery?: string;
  /** Element whose theme and scale a fallback overlay should adopt. */
  sourceRef: RefObject<HTMLElement | null>;
  renderMessage: (message: ChatMessage) => ReactNode;
  renderSubAgents: (activities: Activity[]) => ReactNode;
  onAnswerQuestion?: (message: ChatMessage) => void;
  onClose: () => void;
}

function supportsModalDialog(): boolean {
  return typeof HTMLDialogElement !== "undefined"
    && typeof HTMLDialogElement.prototype.showModal === "function"
    && typeof HTMLDialogElement.prototype.close === "function";
}

const FOLLOW_THRESHOLD_PX = 32;

function stepElement(region: HTMLElement | null, id: string | undefined): HTMLElement | null {
  if (!region || !id) return null;
  for (const element of region.querySelectorAll<HTMLElement>("[data-step-id]")) {
    if (element.dataset.stepId === id) return element;
  }
  return null;
}

const ActivityStepRow = memo(function ActivityStepRow({ step, inChat, match, current, target, renderMessage, renderSubAgents, onAnswerQuestion }: {
  step: ActivityStep;
  inChat: boolean;
  match: boolean;
  current: boolean;
  target: boolean;
  renderMessage: (message: ChatMessage) => ReactNode;
  renderSubAgents: (activities: Activity[]) => ReactNode;
  onAnswerQuestion?: (message: ChatMessage) => void;
}) {
  const [expanded, setExpanded] = useState(match);
  // A search hit must show its matching text, not just a collapsed title.
  useEffect(() => { if (match) setExpanded(true); }, [match]);
  const flags = `${match ? " is-match" : ""}${current ? " is-current-match" : ""}${target ? " is-target" : ""}${inChat ? " in-chat" : ""}`;

  if (step.kind === "spawns") {
    return <li className={`activity-step kind-agents${flags}`} data-step-id={step.id}>
      <span className="activity-step-node" aria-hidden="true"><UsersRound size={11} /></span>
      <div className="activity-step-body">{renderSubAgents(step.value)}</div>
    </li>;
  }

  if (step.kind === "message") {
    const message = step.value;
    const user = message.role === "user";
    const question = Boolean(message.questions?.length);
    const label = user ? "You" : question ? "Question" : message.phase === "final" ? "Response" : "Update";
    return <li className={`activity-step kind-message ${user ? "from-user" : "from-agent"}${flags}`} data-step-id={step.id}>
      <span className="activity-step-node" aria-hidden="true"><MessageSquareText size={11} /></span>
      <div className="activity-step-body">
        <div className="activity-step-head">
          <span className="activity-step-kind">{label}</span>
          {message.streaming && <span className="activity-step-chip tone-live">Writing</span>}
          {inChat && !user && <span className="activity-step-chip">In chat</span>}
        </div>
        <div className="activity-step-message">{renderMessage(message)}</div>
        {question && onAnswerQuestion && (
          <button type="button" className="activity-step-action" onClick={() => onAnswerQuestion(message)}>Answer in chat</button>
        )}
      </div>
    </li>;
  }

  const activity = step.value;
  if (activity.kind === "compaction") {
    return <li className={`activity-step kind-compaction${flags}`} data-step-id={step.id}>
      <span className="activity-step-node" aria-hidden="true"><FoldVertical size={11} /></span>
      <div className="activity-step-body"><div className="activity-step-head"><span className="activity-step-title">{activity.title}</span></div>
        {activity.detail && <p className="activity-step-note">{activity.detail}</p>}</div>
    </li>;
  }
  const reasoning = activity.kind === "reasoning";
  const warning = activity.kind === "warning";
  const Icon = activity.kind === "command" ? TerminalSquare : activity.kind === "file" ? FileCode2 : reasoning ? Sparkles
    : warning ? TriangleAlert : activity.kind === "agent" ? UsersRound : CircleDot;
  const detail = activity.detail?.trim() ? activity.detail : "";
  // Warnings explain themselves; everything else keeps long output folded.
  const collapsible = Boolean(detail) && !warning;
  const showDetail = Boolean(detail) && (!collapsible || expanded);
  const word = statusWord(activity.status);
  const title = reasoning ? "Thinking" : activity.title;
  const mono = activity.kind === "command" || activity.kind === "file";
  const toggleLabel = reasoning ? "thinking" : activity.kind === "command" ? "output" : "details";
  return <li className={`activity-step kind-${activity.kind}${flags}`} data-step-id={step.id}>
    <span className="activity-step-node" aria-hidden="true"><Icon size={11} /></span>
    <div className="activity-step-body">
      <div className="activity-step-head">
        {collapsible ? (
          <button type="button" className="activity-step-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}
            aria-label={`${expanded ? "Hide" : "Show"} ${toggleLabel}: ${title}`}>
            <ChevronRight className="activity-step-chevron" size={12} aria-hidden="true" />
            <span className={`activity-step-title${mono ? " mono" : ""}`}>{title}</span>
          </button>
        ) : <span className={`activity-step-title${mono ? " mono" : ""}`}>{title}</span>}
        {activity.itemCount && activity.itemCount > 1 ? <span className="activity-step-chip">{activity.itemCount} items</span> : null}
        {word && <span className={`activity-step-chip tone-${statusTone(activity.status) || "quiet"}`}>{word}</span>}
      </div>
      {!showDetail && reasoning && detail && <p className="activity-step-preview">{detail.slice(0, 220)}</p>}
      {showDetail && (reasoning ? <div className="activity-step-thought">{detail}</div> : <pre className="activity-step-output">{detail}</pre>)}
    </div>
  </li>;
}, (previous, next) => previous.inChat === next.inChat && previous.match === next.match
  && previous.current === next.current && previous.target === next.target
  && previous.renderMessage === next.renderMessage && previous.renderSubAgents === next.renderSubAgents
  && previous.onAnswerQuestion === next.onAnswerQuestion && sameStep(previous.step, next.step));

/** Steps are rebuilt per update; their transcript objects keep identity. */
function sameStep(left: ActivityStep, right: ActivityStep): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "spawns") {
    const values = (right as typeof left).value;
    return left.value.length === values.length && left.value.every((activity, index) => activity === values[index]);
  }
  return left.value === right.value;
}

/** Safari 13 has neither native modal dialogs nor inert. Keep the overlay out
 * of transcript clipping and contain background interaction without either. */
function FallbackLayer({ sourceRef, labelledBy, onClose, children, frameRef }: {
  sourceRef: RefObject<HTMLElement | null>;
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
  frameRef: RefObject<HTMLDivElement | null>;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  useModalFocus(frameRef, true);
  useLayoutEffect(() => {
    const layer = layerRef.current;
    const source = sourceRef.current;
    if (!layer || !source) return;
    const sync = () => {
      adoptPortalTheme(layer, source);
      const zoom = effectiveZoom(layer);
      layer.style.setProperty("--ui-scale", String(zoom));
      layer.style.width = `${window.innerWidth / zoom}px`;
      layer.style.height = `${window.innerHeight / zoom}px`;
    };
    sync();
    const themeObserver = new MutationObserver(sync);
    const shell = source.closest(".app-shell");
    if (shell) themeObserver.observe(shell, { attributes: true });
    window.addEventListener("resize", sync);
    return () => {
      themeObserver.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [sourceRef]);
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const hidden = new Map<Element, string | null>();
    const hideBackground = () => {
      for (const sibling of document.body.children) {
        if (sibling === layer || hidden.has(sibling)) continue;
        hidden.set(sibling, sibling.getAttribute("aria-hidden"));
        sibling.setAttribute("aria-hidden", "true");
      }
    };
    hideBackground();
    const bodyObserver = new MutationObserver(hideBackground);
    bodyObserver.observe(document.body, { childList: true });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const inside = (target: EventTarget | null) => target instanceof Node && layer.contains(target);
    const retainFocus = (event: FocusEvent) => {
      if (!inside(event.target)) frameRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
    };
    const blockBackground = (event: Event) => {
      if (inside(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const pointerEvents = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "touchstart"] as const;
    for (const type of pointerEvents) document.addEventListener(type, blockBackground, { capture: true, passive: false });
    document.addEventListener("focusin", retainFocus, true);
    return () => {
      bodyObserver.disconnect();
      for (const type of pointerEvents) document.removeEventListener(type, blockBackground, true);
      document.removeEventListener("focusin", retainFocus, true);
      for (const [element, value] of hidden) {
        if (value === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", value);
      }
      document.body.style.overflow = previousOverflow;
    };
  }, [frameRef]);
  return createPortal(<div ref={layerRef} className="activity-details-fallback" onClick={(event) => {
    event.stopPropagation();
    if (event.target === event.currentTarget) onClose();
  }}>
    <div ref={frameRef} className="activity-details-dialog activity-details-dialog-fallback" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
      {children}
    </div>
  </div>, document.body);
}

/** Steps mounted at once. Every step stays searchable; only rendering
 * (including Markdown parsing) is bounded, like the timeline's suffix. */
export const ACTIVITY_STEP_WINDOW = 60;

/** Mounted step range; `end: null` tracks the live end of the run. */
interface StepRange { start: number; end: number | null }

function latestRange(length: number): StepRange {
  return { start: Math.max(0, length - ACTIVITY_STEP_WINDOW), end: null };
}

function rangeAround(index: number, length: number): StepRange {
  if (index < 0 || index >= length - ACTIVITY_STEP_WINDOW) return latestRange(length);
  const start = Math.max(0, index - Math.floor(ACTIVITY_STEP_WINDOW / 3));
  return { start, end: start + ACTIVITY_STEP_WINDOW };
}

type ScrollRequest = { kind: "end"; behavior: ScrollBehavior } | { kind: "step"; id: string; block: ScrollLogicalPosition };

/**
 * The full record of one logical run, in an in-app window about the size of
 * Settings. It follows live work only while the reader stays at the end, owns
 * every key while open (Escape never reaches the app's stop-turn shortcut),
 * and mounts a bounded window of steps only while open.
 */
export function ActivityDetailsModal({
  run, visibleIds, focusId, searchQuery, sourceRef, renderMessage, renderSubAgents, onAnswerQuestion, onClose,
}: ActivityDetailsModalProps) {
  const titleId = useId();
  const nativeDialog = useMemo(supportsModalDialog, []);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fallbackRef = useRef<HTMLDivElement>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const requestClose = useCallback(() => closeRef.current(), []);
  const live = run.state === "running";
  const followingRef = useRef(live && !focusId);
  // Scroll positions this window set itself, so only the reader's own
  // scrolling (wheel, keys, touch, scrollbar drag or track click) stops follow.
  const ownScrollTopRef = useRef<number | null>(null);
  const smoothScrollRef = useRef(false);
  const [showLatest, setShowLatest] = useState(false);
  const steps = useMemo(() => stepsFor(run.entries), [run.entries]);

  const query = searchQuery?.trim().toLowerCase() ?? "";
  const matches = useMemo(() => query
    ? steps.flatMap((step, index) => stepSearchText(step).toLowerCase().includes(query) ? [index] : [])
    : [], [query, steps]);
  const matchIds = useMemo(() => new Set(matches.map((index) => steps[index].id)), [matches, steps]);
  const [matchCursor, setMatchCursor] = useState(() => {
    const focusIndex = focusId ? steps.findIndex((step) => step.id === focusId) : -1;
    const first = matches.findIndex((index) => index >= focusIndex);
    return first < 0 ? 0 : first;
  });
  const currentMatchId = matches.length ? steps[matches[Math.min(matchCursor, matches.length - 1)]]?.id : undefined;
  const [targetId, setTargetId] = useState(currentMatchId ?? focusId);
  const [range, setRange] = useState<StepRange>(() => {
    const initial = rangeAround(targetId ? steps.findIndex((step) => step.id === targetId) : -1, steps.length);
    return !followingRef.current && initial.end === null ? { ...initial, end: steps.length } : initial;
  });
  const scrollRequestRef = useRef<ScrollRequest | null>(targetId
    ? { kind: "step", id: targetId, block: currentMatchId ? "center" : "start" }
    : followingRef.current ? { kind: "end", behavior: "auto" } : null);
  const anchorRef = useRef<{ id: string; top: number } | null>(null);

  const start = Math.min(range.start, latestRange(steps.length).start);
  const end = range.end === null ? steps.length : Math.min(range.end, steps.length);
  const mounted = steps.slice(start, end);
  const hasLater = end < steps.length;

  const setOwnScrollTop = (region: HTMLElement, top: number) => {
    const before = region.scrollTop;
    region.scrollTop = top;
    // No scroll event follows an unchanged position; never leave it pending.
    ownScrollTopRef.current = region.scrollTop === before ? null : region.scrollTop;
  };

  const pinToEnd = useCallback((behavior: ScrollBehavior = "auto") => {
    const region = regionRef.current;
    if (!region) return;
    if (behavior === "smooth" && typeof region.scrollTo === "function") {
      smoothScrollRef.current = true;
      region.scrollTo({ top: region.scrollHeight, behavior });
    } else {
      const before = region.scrollTop;
      region.scrollTop = region.scrollHeight;
      ownScrollTopRef.current = region.scrollTop === before ? null : region.scrollTop;
    }
  }, []);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!nativeDialog || !dialog) return;
    // The native top layer escapes transcript clipping and supplies modal
    // containment plus focus restoration without a second focus trap.
    if (!dialog.open) dialog.showModal();
    regionRef.current?.focus({ preventScroll: true });
    return () => { if (dialog.open) dialog.close(); };
  }, [nativeDialog]);

  // Keys aimed outside the dialog (focus can fall to <body> after a click on
  // plain text) must never trigger app shortcuts such as stop-turn, new
  // thread, palette, search or Settings while this window is open.
  useEffect(() => {
    const guard = (event: KeyboardEvent) => {
      const frame = nativeDialog ? dialogRef.current : fallbackRef.current;
      if (frame && event.target instanceof Node && frame.contains(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") requestClose();
      // A control that vanished (e.g. a stopped sub-agent's Stop button)
      // drops focus to <body>; bring keyboard users back into the window.
      else regionRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", guard, true);
    return () => document.removeEventListener("keydown", guard, true);
  }, [nativeDialog, requestClose]);

  // A long live session must not grow the mounted window without bound
  // while the reader follows the end; older steps stay one click away.
  useLayoutEffect(() => {
    if (followingRef.current && range.end === null && steps.length - range.start > ACTIVITY_STEP_WINDOW * 2) {
      setRange(latestRange(steps.length));
    }
  }, [range, steps.length]);

  // Applies, after layout, the scroll a window change asked for: the opened
  // step or search hit, the live end, or the reader's anchor when earlier
  // steps are mounted above it.
  useLayoutEffect(() => {
    const region = regionRef.current;
    if (!region) return;
    const anchor = anchorRef.current;
    if (anchor) {
      anchorRef.current = null;
      const element = stepElement(region, anchor.id);
      if (element) setOwnScrollTop(region, region.scrollTop + element.getBoundingClientRect().top - anchor.top);
    }
    const request = scrollRequestRef.current;
    if (!request) return;
    scrollRequestRef.current = null;
    if (request.kind === "end") pinToEnd(request.behavior);
    else {
      followingRef.current = false;
      stepElement(region, request.id)?.scrollIntoView?.({ block: request.block });
    }
  });

  // Follow new work only while the reader is at the end of the log.
  useEffect(() => {
    const region = regionRef.current;
    const list = listRef.current;
    if (!region || !list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) pinToEnd();
      else if (live) setShowLatest(region.scrollHeight - region.scrollTop - region.clientHeight > FOLLOW_THRESHOLD_PX);
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [live, pinToEnd]);

  const moveMatch = (delta: number) => {
    if (!matches.length) return;
    const next = (matchCursor + delta + matches.length) % matches.length;
    const index = matches[next];
    setMatchCursor(next);
    setTargetId(steps[index].id);
    followingRef.current = false;
    smoothScrollRef.current = false;
    if (index < start || index >= end) setRange(rangeAround(index, steps.length));
    scrollRequestRef.current = { kind: "step", id: steps[index].id, block: "center" };
  };

  const showEarlier = () => {
    const first = mounted[0];
    const element = stepElement(regionRef.current, first?.id);
    if (first && element) anchorRef.current = { id: first.id, top: element.getBoundingClientRect().top };
    followingRef.current = false;
    setRange({ start: Math.max(0, start - ACTIVITY_STEP_WINDOW), end: range.end ?? steps.length });
  };

  const showLater = () => {
    const next = end + ACTIVITY_STEP_WINDOW;
    setRange({ start, end: next >= steps.length ? null : next });
  };

  const jumpToLatest = () => {
    followingRef.current = true;
    setShowLatest(false);
    const behavior: ScrollBehavior = prefersReducedMotion() ? "auto" : "smooth";
    if (hasLater) {
      setRange(latestRange(steps.length));
      scrollRequestRef.current = { kind: "end", behavior };
    } else pinToEnd(behavior);
  };

  const stopFollowing = () => {
    smoothScrollRef.current = false;
    const region = regionRef.current;
    if (!region || region.scrollHeight <= region.clientHeight + 1) return;
    followingRef.current = false;
    // Freeze the mounted endpoint too. Merely disabling scroll following
    // would still parse every future message while the reader looks back.
    setRange((current) => current.end === null ? { ...current, end: steps.length } : current);
  };

  const settledLabel = run.state === "running" ? undefined
    : run.unconfirmed ? UNCONFIRMED_ACTIVITY_LABEL : SETTLED_ACTIVITY_LABELS[run.state];
  const stepCount = steps.filter((step) => !visibleIds?.has(step.id)).length;
  const stepText = `${stepCount} step${stepCount === 1 ? "" : "s"}`;

  const contents = <>
    <header className="activity-details-header">
      <div className="activity-details-heading">
        <h2 id={titleId}>Activity</h2>
        <div className="activity-details-status" role={live ? "status" : undefined}>
          <span className={`activity-details-state state-${run.state}${run.unconfirmed ? " unconfirmed" : ""}`}>{live ? run.label || "Working" : settledLabel}</span>
          <span className="activity-details-meta">{[run.summary, stepText].filter(Boolean).join(" · ")}</span>
        </div>
      </div>
      {query && (
        <div className="activity-details-search" role="group" aria-label="Search matches">
          <span aria-live="polite">{matches.length ? `${Math.min(matchCursor, matches.length - 1) + 1} of ${matches.length}` : "No matches"}</span>
          <button type="button" aria-label="Previous match" disabled={!matches.length} onClick={() => moveMatch(-1)}><ChevronUp size={14} aria-hidden="true" /></button>
          <button type="button" aria-label="Next match" disabled={!matches.length} onClick={() => moveMatch(1)}><ChevronDown size={14} aria-hidden="true" /></button>
        </div>
      )}
      <button type="button" className="activity-details-close" aria-label="Close activity" onClick={requestClose}><X size={16} aria-hidden="true" /></button>
    </header>
    <div
      ref={regionRef}
      className="activity-details-scroll"
      role="region"
      aria-label="Activity steps"
      tabIndex={0}
      data-autofocus
      onScroll={(event) => {
        const region = event.currentTarget;
        const own = ownScrollTopRef.current !== null && Math.abs(region.scrollTop - ownScrollTopRef.current) <= 1;
        ownScrollTopRef.current = null;
        const atEnd = !hasLater && region.scrollHeight - region.scrollTop - region.clientHeight <= FOLLOW_THRESHOLD_PX;
        if (atEnd) {
          followingRef.current = true;
          smoothScrollRef.current = false;
          setRange((current) => current.end === null ? current : { ...current, end: null });
        } else if (!own && !smoothScrollRef.current) {
          followingRef.current = false;
          setRange((current) => current.end === null ? { ...current, end: steps.length } : current);
        }
        setShowLatest(live && !atEnd);
      }}
      onWheel={(event) => { if (event.deltaY < 0) stopFollowing(); }}
      onTouchMove={stopFollowing}
      // The scrollbar belongs to the region itself; its drag or track click
      // then arrives as an ordinary scroll that is not this window's own.
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget) return;
        smoothScrollRef.current = false;
        ownScrollTopRef.current = null;
      }}
      onKeyDown={(event) => {
        if (event.key === "PageUp" || event.key === "Home" || event.key === "ArrowUp" || (event.shiftKey && event.key === " ")) stopFollowing();
      }}
    >
      {start > 0 && (
        <div className="activity-details-window">
          <button type="button" onClick={showEarlier}>Show {Math.min(ACTIVITY_STEP_WINDOW, start)} earlier step{Math.min(ACTIVITY_STEP_WINDOW, start) === 1 ? "" : "s"}</button>
        </div>
      )}
      {/* The list stays mounted while empty so following starts with the first step. */}
      <ol ref={listRef} className="activity-details-steps">
        {mounted.map((step) => (
          <ActivityStepRow
            key={step.id}
            step={step}
            inChat={Boolean(visibleIds?.has(step.id))}
            match={matchIds.has(step.id)}
            current={step.id === currentMatchId}
            target={step.id === targetId && step !== steps[0]}
            renderMessage={renderMessage}
            renderSubAgents={renderSubAgents}
            onAnswerQuestion={onAnswerQuestion}
          />
        ))}
      </ol>
      {hasLater && (
        <div className="activity-details-window later">
          <button type="button" onClick={showLater}>Show {Math.min(ACTIVITY_STEP_WINDOW, steps.length - end)} later step{Math.min(ACTIVITY_STEP_WINDOW, steps.length - end) === 1 ? "" : "s"}</button>
        </div>
      )}
      {stepCount === 0 && (
        <div className="activity-details-empty">
          <span className={`activity-details-empty-mark${live ? " live" : ""}`} aria-hidden="true"><Sparkles size={13} /></span>
          <p>{live ? "Steps will appear here as the agent works." : "No steps were recorded for this run."}</p>
        </div>
      )}
    </div>
    {(showLatest || hasLater) && live && (
      <button type="button" className="activity-details-latest" onClick={jumpToLatest}>
        <ArrowDownToLine size={13} aria-hidden="true" /> Latest activity
      </button>
    )}
  </>;

  const onKeyDown = (event: ReactKeyboardEvent) => {
    // Activity owns keys while modal: dismissing it never stops a running
    // turn, and app shortcuts stay quiet. Nested controls handle Escape first.
    event.stopPropagation();
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      requestClose();
    }
  };

  if (!nativeDialog) {
    return <FallbackLayer sourceRef={sourceRef} labelledBy={titleId} onClose={requestClose} frameRef={fallbackRef}>
      <div className="activity-details-frame" onKeyDown={onKeyDown}>{contents}</div>
    </FallbackLayer>;
  }
  return <dialog
    ref={dialogRef}
    className="activity-details-dialog"
    aria-labelledby={titleId}
    onKeyDown={onKeyDown}
    onCancel={(event) => { event.preventDefault(); requestClose(); }}
    // A user agent may still close without a cancellable event. A close
    // queued by an effect cleanup (StrictMode re-runs effects) arrives after
    // showModal reopened the dialog and must not dismiss it.
    onClose={(event) => { if (!event.currentTarget.open) requestClose(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) requestClose();
    }}
  >
    <div className="activity-details-frame">{contents}</div>
  </dialog>;
}
