import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import type { UsageProvider } from "../lib/usageLedger";
import { shiftDayKey } from "../lib/usageHistory";
import { buildUsageCalendar, formatDayShare, usageCalendarRange, type CalendarDay, type UsageCalendar } from "../lib/usageCalendar";
import type { UsageRange } from "../lib/usageSummary";
import type { UsageDashboardSource } from "./usageDashboardPreview";

const number = (value: number) => Math.round(value).toLocaleString();
const COMPACT = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const compact = (value: number) => (Math.abs(value) < 10_000 ? number(value) : COMPACT.format(Math.round(value)));
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function dateOf(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date, 12);
}
const longDay = (day: string) => dateOf(day).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const cardDay = (day: string) => dateOf(day).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const shortDay = (day: string) => dateOf(day).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const monthOf = (day: string) => dateOf(day).toLocaleDateString(undefined, { month: "short" });

const VIEWPORT_MARGIN = 8;
/** Less than the 3px spacing between squares, so the pointer passes from a
 * square straight into its card without crossing a neighbouring square. */
const CARD_GAP = 1;
/** Time to cross from a square into its card before the card closes. */
const HOVER_GRACE_MS = 180;

// Ephemeral mouse history survives a calendar remount under a stationary
// pointer. Listeners exist only while a calendar is mounted. Before any sample
// is known, the first move must remain usable as a legitimate pointer request.
let lastPointerPoint: { x: number; y: number } | null = null;

function effectiveZoom(element: HTMLElement): number {
  const current = (element as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom;
  if (typeof current === "number" && Number.isFinite(current) && current > 0) return current;
  // WebKit versions without currentCSSZoom still expose each ancestor's zoom.
  let zoom = 1;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const value = getComputedStyle(node).zoom;
    const factor = value.endsWith("%") ? Number.parseFloat(value) / 100 : Number.parseFloat(value);
    if (Number.isFinite(factor) && factor > 0) zoom *= factor;
  }
  return zoom;
}

interface Box { top: number; left: number; right: number; bottom: number }

/**
 * The part of the viewport left visible by the scrolling and clipping boxes
 * from `node` outwards. A fixed box is clipped only from its own containing
 * block up (Settings' fixed backdrop escapes the app shell's overflow).
 */
function visibleBox(node: HTMLElement | null): Box {
  const box = { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
  while (node && node !== document.body && node !== document.documentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX !== "visible" || style.overflowY !== "visible") {
      const rect = node.getBoundingClientRect();
      box.top = Math.max(box.top, rect.top); box.left = Math.max(box.left, rect.left);
      box.right = Math.min(box.right, rect.right); box.bottom = Math.min(box.bottom, rect.bottom);
    }
    node = style.position === "fixed" ? fixedContainingBlock(node) : node.parentElement;
  }
  return box;
}

/** Without the top layer, `position: fixed` is relative to the nearest
 * ancestor that contains fixed elements: Settings' transformed sheet, or the
 * dashboard's own size container. */
function fixedContainingBlock(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node) as CSSStyleDeclaration & { webkitBackdropFilter?: string };
    const backdrop = style.backdropFilter || style.webkitBackdropFilter || "none";
    if (style.transform !== "none" || style.perspective !== "none" || style.filter !== "none" || backdrop !== "none"
      || /paint|layout|strict|content/.test(style.contain) || (style.containerType && style.containerType !== "normal")
      || /transform|perspective|filter/.test(style.willChange)) return node;
  }
  return null;
}

/**
 * Above the square when it fits, else below, clamped inside `bounds` (the
 * viewport in the top layer). The card's height is capped to the roomier side
 * so it doesn't cover its square (or, when both are short, to the bounds), and
 * its list scrolls. Rectangles are visual pixels; fixed offsets are layout
 * pixels from `origin` under UI zoom. A square that its scrolling ancestors
 * have hidden takes its card with it.
 */
function placeCard(card: HTMLElement, anchor: DOMRect, anchorVisible: Box, bounds: Box, origin: { x: number; y: number }) {
  const zoom = effectiveZoom(card);
  const hidden = anchor.bottom <= anchorVisible.top || anchor.top >= anchorVisible.bottom
    || anchor.right <= anchorVisible.left || anchor.left >= anchorVisible.right;
  card.style.visibility = hidden ? "hidden" : "";
  const top0 = bounds.top + VIEWPORT_MARGIN;
  const bottom0 = bounds.bottom - VIEWPORT_MARGIN;
  const left0 = bounds.left + VIEWPORT_MARGIN;
  const right0 = bounds.right - VIEWPORT_MARGIN;
  const spaceAbove = anchor.top - CARD_GAP - top0;
  const spaceBelow = bottom0 - anchor.bottom - CARD_GAP;
  const room = Math.max(spaceAbove, spaceBelow);
  const maxHeight = room >= 180 ? room : bottom0 - top0;
  card.style.maxWidth = `${Math.max(0, right0 - left0) / zoom}px`;
  card.style.maxHeight = `${Math.max(0, maxHeight) / zoom}px`;
  const cardWidth = card.offsetWidth * zoom;
  const cardHeight = card.offsetHeight * zoom;
  const above = anchor.top - CARD_GAP - cardHeight;
  const below = anchor.bottom + CARD_GAP;
  let top = above >= top0 ? above : below + cardHeight <= bottom0 ? below : spaceAbove > spaceBelow ? top0 : below;
  top = Math.min(Math.max(top, top0), Math.max(top0, bottom0 - cardHeight));
  const preferredLeft = anchor.left + anchor.width / 2 - cardWidth / 2;
  const left = Math.min(Math.max(preferredLeft, left0), Math.max(left0, right0 - cardWidth));
  card.style.top = `${(top - origin.y) / zoom}px`;
  card.style.left = `${(left - origin.x) / zoom}px`;
  card.dataset.side = top + cardHeight <= anchor.top + 1 ? "above" : "below";
}

const TABBABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex='-1'])";

/** The first focusable control after `section` in document order, within its dialog. */
function nextFocusable(section: HTMLElement): HTMLElement | null {
  const root = section.closest<HTMLElement>("[role='dialog']") ?? document.body;
  for (const element of root.querySelectorAll<HTMLElement>(TABBABLE)) {
    if (section.contains(element) || !(section.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    if (element.tabIndex < 0 || element.closest("[inert]") || !element.getClientRects().length) continue;
    if (getComputedStyle(element).visibility === "visible") return element;
  }
  return null;
}

function dayLabel(entry: CalendarDay, outside: boolean): string {
  const amount = entry.state === "active" ? `${number(entry.totalTokens)} tokens`
    : entry.state === "empty" ? "no recorded tokens" : "not tracked";
  return `${longDay(entry.day)}: ${amount}${outside ? ", outside selected range" : ""}`;
}

/** Month names over the week columns they begin in; a one-column sliver is left blank. */
function monthSegments(calendar: UsageCalendar): Array<{ key: string; span: number; label: string }> {
  const segments: Array<{ key: string; span: number; label: string }> = [];
  for (const week of calendar.weeks) {
    const month = week[0]!.day.slice(0, 7);
    const last = segments[segments.length - 1];
    if (last?.key === month) last.span += 1;
    else segments.push({ key: month, span: 1, label: monthOf(week[0]!.day) });
  }
  return segments.map((segment) => (segment.span < 2 ? { ...segment, label: "" } : segment));
}

function DayCard({ entry, today, trackedFrom, startedDay, providerLabel, modelLabel, pinned }: {
  entry: CalendarDay; today: string; trackedFrom: string | null; startedDay: string | null;
  providerLabel: (provider: UsageProvider) => string; modelLabel: (model: string) => string; pinned: boolean;
}) {
  const total = entry.totalTokens;
  return <>
    <div className="usage-heat-card-head">
      <strong>{cardDay(entry.day)}</strong>
      {entry.day === today && <small>Today so far</small>}
    </div>
    {entry.state === "unavailable"
      ? <p className="usage-heat-card-note">{entry.unavailableReason === "past-retention"
        ? `Not tracked: dated detail before ${trackedFrom ? shortDay(trackedFrom) : "this day"} is no longer retained.`
        : startedDay ? `Not tracked: dated usage tracking began ${shortDay(startedDay)}.` : "Not tracked: dated usage tracking starts with your next message."}</p>
      : <>
        <p className="usage-heat-card-total"><span>Total tokens</span><strong>{number(total)}</strong></p>
        {entry.state === "empty" ? <p className="usage-heat-card-note">No tokens recorded on this day.</p> : <>
          <div className="usage-heat-card-list" tabIndex={pinned ? 0 : undefined} role={pinned ? "region" : undefined}
            aria-label={pinned ? `Providers and models on ${cardDay(entry.day)}` : undefined}>
            {entry.providers.map((provider) => <section key={provider.provider} className="usage-heat-provider">
              <h6><span>{providerLabel(provider.provider)}</span><span>{number(provider.totalTokens)}</span><span>{formatDayShare(provider.totalTokens, total)}</span></h6>
              <ul>{provider.models.map((model) => <li key={model.model}>
                <span>{modelLabel(model.model)}</span><span>{number(model.totalTokens)}</span><span>{formatDayShare(model.totalTokens, total)}</span>
              </li>)}</ul>
            </section>)}
          </div>
          <p className="usage-heat-card-note">Percentages are shares of this day’s total tokens.</p>
        </>}
      </>}
  </>;
}

/**
 * The trailing year of recorded tokens, one square per local day. It always
 * spans the same year so activity over time stays visible; the page's
 * selected range is shown by fading the days outside it, never by hiding
 * usage. Hover, focus or tap a square for that day's providers and models.
 */
export function UsageCalendarCard({ source, revision, today, range, providerLabel, modelLabel }: {
  source: UsageDashboardSource;
  /** The ledger revision; a change means recorded usage may have changed. */
  revision: number;
  today: string;
  /** The page's selected range, or null for all time. */
  range: UsageRange | null;
  providerLabel: (provider: UsageProvider) => string;
  modelLabel: (model: string) => string;
}) {
  const baseId = useId();
  const cardId = `${baseId}-card`;
  const sectionRef = useRef<HTMLElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const graceRef = useRef<number | null>(null);
  const keyboardOwnsCard = useRef(false);
  const pointerPoint = useRef(lastPointerPoint);
  const clickPointerType = useRef("mouse");

  // Layout/top-layer changes can dispatch pointer boundary events (and even
  // pointermove) without moving the mouse. Only changed viewport coordinates
  // release a keyboard request. Track outside the grid too, so leaving and
  // returning to the same square still counts as deliberate pointer use.
  useEffect(() => {
    const onMove = (event: globalThis.PointerEvent) => {
      if (event.pointerType === "touch") return;
      const previous = pointerPoint.current;
      if (!previous || previous.x !== event.clientX || previous.y !== event.clientY) keyboardOwnsCard.current = false;
      pointerPoint.current = { x: event.clientX, y: event.clientY };
      lastPointerPoint = pointerPoint.current;
    };
    document.addEventListener("pointermove", onMove, true);
    return () => document.removeEventListener("pointermove", onMove, true);
  }, []);

  const { calendar, detailAhead, startedDay } = useMemo(() => {
    const detail = source.detail(usageCalendarRange(today));
    // Keyed to the ledger revision: the same source returns new records after a write.
    return { revision, calendar: buildUsageCalendar(detail.buckets, today, detail), detailAhead: Boolean(detail.detailAhead), startedDay: detail.startedDay };
  }, [source, revision, today]);

  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  // The roving tab stop; null follows today, including across local midnight.
  const [cursor, setCursor] = useState<string | null>(null);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  // Escape hides a focus-driven card until the next move, without moving focus.
  const [suppressed, setSuppressed] = useState(false);

  // A day that left the calendar (after local midnight) can't stay selected.
  const inCalendar = (day: string | null) => (day && calendar.days.has(day) ? day : null);
  const cursorDay = inCalendar(cursor) ?? calendar.range.to;
  const pinnedDay = inCalendar(pinned);
  const shownDay = inCalendar(hover) ?? (keyboardFocus && !suppressed ? cursorDay : null) ?? pinnedDay;
  const shown = shownDay ? calendar.days.get(shownDay)! : null;
  const topLayer = typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover === "function";

  const cancelGrace = useCallback(() => {
    if (graceRef.current !== null) window.clearTimeout(graceRef.current);
    graceRef.current = null;
  }, []);
  const leaveSoon = useCallback(() => {
    cancelGrace();
    graceRef.current = window.setTimeout(() => { graceRef.current = null; setHover(null); }, HOVER_GRACE_MS);
  }, [cancelGrace]);
  useEffect(() => cancelGrace, [cancelGrace]);

  // Newest days are on the right; a narrow panel starts scrolled to them.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollLeft = scroller.scrollWidth;
  }, [calendar.range.to, detailAhead]);

  const position = useCallback(() => {
    const card = cardRef.current;
    const cell = shownDay ? tableRef.current?.querySelector<HTMLElement>(`[data-day="${shownDay}"]`) : null;
    if (!card || !cell) return;
    const viewport = { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
    let bounds: Box = viewport;
    let origin = { x: 0, y: 0 };
    let inTopLayer = false;
    try { inTopLayer = card.matches(":popover-open"); } catch { /* No Popover API: the selector itself is unknown. */ }
    if (!inTopLayer) {
      // Fallback for engines without the top layer: stay inside whatever
      // clips the card, measured from its real containing block.
      const block = fixedContainingBlock(card);
      bounds = visibleBox(block);
      if (block) {
        const rect = block.getBoundingClientRect();
        const zoom = effectiveZoom(block);
        origin = { x: rect.left + block.clientLeft * zoom, y: rect.top + block.clientTop * zoom };
      }
    }
    placeCard(card, cell.getBoundingClientRect(), visibleBox(cell.parentElement), bounds, origin);
  }, [shownDay]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    const cell = shownDay ? tableRef.current?.querySelector<HTMLElement>(`[data-day="${shownDay}"]`) : null;
    if (!card || !cell) return;
    if (topLayer) {
      try { if (!card.matches(":popover-open")) card.showPopover(); } catch { /* Already shown or unsupported. */ }
    }
    // Describe the square by its breakdown while the card is showing it.
    cell.setAttribute("aria-describedby", cardId);
    position();
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => { frame = null; position(); });
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(card);
    return () => {
      cell.removeAttribute("aria-describedby");
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      observer?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [shownDay, shown, topLayer, cardId, position]);

  // Escape closes the card first; a second Escape reaches Settings. Focus
  // inside the closing card returns to its day rather than to the page.
  const visible = shown !== null;
  const cursorRef = useRef(cursorDay);
  useLayoutEffect(() => { cursorRef.current = cursorDay; }, [cursorDay]);
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector("[data-app-select-open]")) return;
      event.preventDefault();
      event.stopPropagation();
      if (document.activeElement instanceof Node && cardRef.current?.contains(document.activeElement)) {
        tableRef.current?.querySelector<HTMLElement>(`[data-day="${cursorRef.current}"]`)?.focus({ preventScroll: true });
      }
      cancelGrace();
      keyboardOwnsCard.current = true;
      setHover(null);
      setPinned(null);
      setSuppressed(true);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [visible, cancelGrace]);

  // A tap or click anywhere else releases a pinned day.
  useEffect(() => {
    if (!pinnedDay) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && sectionRef.current?.contains(event.target)) return;
      setPinned(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [pinnedDay]);

  const dayOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>("[data-day]")?.dataset.day ?? null : null);
  const focusDay = (day: string) => {
    setCursor(day);
    setSuppressed(false);
    tableRef.current?.querySelector<HTMLElement>(`[data-day="${day}"]`)?.focus();
    // Explicit navigation is keyboard input even if an engine's focus-visible
    // heuristic doesn't carry across a programmatic focus change.
    setKeyboardFocus(true);
  };

  const onPointerOver = (event: PointerEvent<HTMLTableElement>) => {
    // Touch has no hover; a tap selects instead.
    if (event.pointerType === "touch" || keyboardOwnsCard.current) return;
    const day = dayOf(event.target);
    if (!day) return;
    cancelGrace();
    setHover(day);
  };
  const onClick = (event: MouseEvent<HTMLTableElement>) => {
    const day = dayOf(event.target);
    if (!day) return;
    keyboardOwnsCard.current = false;
    cancelGrace();
    // Keyboard/assistive activation has detail=0 and must not fabricate a
    // sticky hover. Real mouse unpinning retains the still-hovered breakdown.
    setHover(clickPointerType.current !== "touch" && event.detail > 0 ? day : null);
    setKeyboardFocus(false);
    setCursor(day);
    setSuppressed(false);
    setPinned((current) => (current === day ? null : day));
  };
  const onFocus = (event: FocusEvent<HTMLElement>) => {
    const day = dayOf(event.target);
    if (!day) return;
    setCursor(day);
    // Returning to a day is a new request for its breakdown. Escape sets
    // suppression after restoring focus, so that dismissal still wins.
    setSuppressed(false);
    let keyboard = true;
    try { keyboard = event.target.matches(":focus-visible"); } catch { /* Older engines: treat as keyboard focus. */ }
    if (keyboard) {
      // A stationary mouse may still be over an older day. The newer keyboard
      // request wins until the user deliberately moves the pointer again.
      cancelGrace();
      keyboardOwnsCard.current = true;
      setHover(null);
    }
    setKeyboardFocus(keyboard);
  };
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && sectionRef.current?.contains(next)) {
      if (!dayOf(next)) setKeyboardFocus(false);
      return;
    }
    setKeyboardFocus(false);
    // Tabbing out of the calendar closes its card; no hidden focus stop remains.
    if (next) setPinned(null);
  };
  // Engines differ on where Tab goes from inside a top-layer popover (WebKit
  // drops focus to the page), so leave the pinned list in document order here.
  const onCardKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !(event.target instanceof HTMLElement) || !event.target.classList.contains("usage-heat-card-list")) return;
    const target = event.shiftKey ? tableRef.current?.querySelector<HTMLElement>(`[data-day="${cursorDay}"]`) : sectionRef.current && nextFocusable(sectionRef.current);
    if (!target) return;
    event.preventDefault();
    target.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    const day = dayOf(event.target);
    if (!day) return;
    if (["Tab", "Enter", " ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      cancelGrace();
      keyboardOwnsCard.current = true;
      setKeyboardFocus(true);
      setHover(null);
    }
    if (event.key === "Tab" && !event.shiftKey) {
      // WebKit can lose its sequential focus position after a top-layer
      // card closes. Explicitly follow the same order with or without it:
      // the pinned list, then the next control after the calendar.
      const target = cardRef.current?.querySelector<HTMLElement>(".usage-heat-card-list[tabindex='0']")
        ?? (sectionRef.current && nextFocusable(sectionRef.current));
      if (target) {
        event.preventDefault();
        target.focus();
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSuppressed(false);
      setPinned((current) => (current === day ? null : day));
      return;
    }
    const weekday = (dateOf(day).getDay() + 6) % 7;
    const rowStart = shiftDayKey(calendar.range.from, weekday);
    let rowEnd = rowStart;
    while (shiftDayKey(rowEnd, 7) <= calendar.range.to) rowEnd = shiftDayKey(rowEnd, 7);
    const next = event.key === "ArrowUp" ? shiftDayKey(day, -1)
      : event.key === "ArrowDown" ? shiftDayKey(day, 1)
        : event.key === "ArrowLeft" ? shiftDayKey(day, -7)
          : event.key === "ArrowRight" ? shiftDayKey(day, 7)
            : event.key === "Home" ? (event.ctrlKey || event.metaKey ? calendar.range.from : rowStart)
              : event.key === "End" ? (event.ctrlKey || event.metaKey ? calendar.range.to : rowEnd)
                : null;
    if (next === null) return;
    event.preventDefault();
    if (calendar.days.has(next)) focusDay(next);
  };

  // The page builds a new range object each render; depend on its days.
  const rangeFrom = range?.from ?? null;
  const rangeTo = range?.to ?? null;
  const outsideRange = useCallback((day: string) => rangeFrom !== null && rangeTo !== null && (day < rangeFrom || day > rangeTo), [rangeFrom, rangeTo]);
  // Hovering changes only the card; the 371 squares re-render when data,
  // range, the roving focus stop or the pinned day change.
  const body = useMemo(() => <tbody>
    {WEEKDAYS.map((weekday, row) => <tr key={weekday}>
      <th scope="row" className="usage-heat-weekday"><span aria-hidden="true">{row % 2 === 0 && row < 6 ? weekday.slice(0, 3) : ""}</span><span className="sr-only">{weekday}</span></th>
      {calendar.weeks.map((week, column) => {
        const entry = week[row];
        if (!entry) return <td key={column} className="usage-heat-pad" aria-hidden="true" />;
        const outside = outsideRange(entry.day);
        return <td key={entry.day} role="gridcell" data-day={entry.day} data-state={entry.state} data-level={entry.level}
          className={`usage-heat-day${outside ? " outside" : ""}`} tabIndex={entry.day === cursorDay ? 0 : -1}
          aria-selected={entry.day === pinnedDay} aria-label={dayLabel(entry, outside)} />;
      })}
    </tr>)}
  </tbody>, [calendar, outsideRange, cursorDay, pinnedDay]);

  const months = useMemo(() => monthSegments(calendar), [calendar]);
  const rangeNote = range ? "Faded days are outside the selected range." : null;
  const noteId = `${baseId}-scope`;

  return <section ref={sectionRef} className="usage-dashboard-card usage-heat" aria-labelledby={`${baseId}-heading`} onFocus={onFocus} onBlur={onBlur}>
    <div className="usage-heat-head">
      <div>
        <h5 id={`${baseId}-heading`}>Token activity</h5>
        <p className="usage-heat-summary">{detailAhead ? "Dated detail is hidden until it agrees with saved totals."
          : calendar.activeDays ? `${compact(calendar.totalTokens)} tokens on ${number(calendar.activeDays)} ${calendar.activeDays === 1 ? "day" : "days"} · last 12 months`
            : "No dated tokens recorded in the last 12 months"}</p>
      </div>
      <div className="usage-heat-legend" aria-hidden="true">
        <span>Less</span>
        {([0, 1, 2, 3, 4] as const).map((level) => <i key={level} className="usage-heat-swatch" data-state={level ? "active" : "empty"} data-level={level} />)}
        <span>More</span>
        <span className="usage-heat-legend-item"><i className="usage-heat-swatch" data-state="unavailable" />Not tracked</span>
      </div>
    </div>
    <p id={noteId} className="usage-heat-scope">
      Dated local records only: a prompt’s tokens count on the local day its first usage was recorded. Earlier undated usage isn’t placed on any day.
      {rangeNote && ` ${rangeNote}`}
    </p>
    {!detailAhead && <div ref={scrollRef} className="usage-heat-scroll">
      <table ref={tableRef} className="usage-heat-table" role="grid" aria-readonly="true" aria-describedby={noteId}
        aria-label={`Tokens per day, ${shortDay(calendar.range.from)} to ${shortDay(calendar.range.to)}`}
        onPointerOver={onPointerOver} onPointerMove={onPointerOver} onPointerLeave={(event) => { if (event.pointerType !== "touch") leaveSoon(); }}
        onPointerDown={(event) => { clickPointerType.current = event.pointerType; }} onClick={onClick} onKeyDown={onKeyDown}>
        <thead aria-hidden="true">
          <tr><td />{months.map((month) => <th key={month.key} colSpan={month.span} className="usage-heat-month"><span>{month.label}</span></th>)}</tr>
        </thead>
        {body}
      </table>
    </div>}
    {shown && !detailAhead && <div ref={cardRef} id={cardId} className="usage-heat-card" popover={topLayer ? "manual" : undefined}
      role="group" aria-label={`Usage on ${longDay(shown.day)}`} data-state={shown.state}
      onPointerEnter={cancelGrace} onKeyDown={onCardKeyDown} onPointerLeave={(event) => { if (event.pointerType !== "touch" && hover) leaveSoon(); }}>
      <DayCard entry={shown} today={today} trackedFrom={calendar.trackedFrom} startedDay={startedDay}
        providerLabel={providerLabel} modelLabel={modelLabel} pinned={shown.day === pinnedDay} />
    </div>}
  </section>;
}
