import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CalendarClock, Info, X } from "lucide-react";
import { effectiveZoom, supportsTopLayer } from "../lib/floatingLayer";
import {
  dateInputValue,
  defaultDeliveryTime,
  formatDeliveryTimeLong,
  localTimeZoneName,
  parseLocalDateTime,
  timeInputValue,
  tomorrowMorning,
} from "../lib/timedPrompts";
import "./TimedPrompts.css";

const VIEWPORT_MARGIN = 8;
const GAP = 6;
const WIDTH = 320;

/**
 * Date/time chooser for timed prompts. It floats in the top layer (or a portal
 * inside the themed shell on older WebViews) so the composer's rounded,
 * overflow-clipped card can never cut it off.
 */
export function TimedPromptPicker({
  anchorRef,
  title,
  submitLabel,
  initialDeliverAt,
  contextLabel,
  onSubmit,
  onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  title: string;
  submitLabel: string;
  initialDeliverAt?: number;
  /** One line describing where the prompt will go when it is due. */
  contextLabel?: string;
  /** Resolve true once the schedule is accepted; false keeps the picker open. */
  onSubmit: (deliverAt: number) => boolean | Promise<boolean>;
  onClose: () => void;
}) {
  const initial = useMemo(() => {
    const at = initialDeliverAt && initialDeliverAt > Date.now() ? initialDeliverAt : defaultDeliveryTime();
    return { date: dateInputValue(at), time: timeInputValue(at) };
  }, [initialDeliverAt]);
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Re-evaluate "in the past" while the picker sits open across a minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const parsed = parseLocalDateTime(date, time, now);
  const panelRef = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const hintId = useId();
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const topLayer = supportsTopLayer();
  const portalHost = topLayer ? null : anchorRef.current?.closest<HTMLElement>(".app-shell") ?? document.body;
  const zone = localTimeZoneName();

  const close = useCallback(() => {
    onClose();
    requestAnimationFrame(() => {
      const anchor = anchorRef.current;
      if (anchor?.isConnected && (document.activeElement === document.body || !document.activeElement?.isConnected)) anchor.focus();
    });
  }, [anchorRef, onClose]);

  const position = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const rect = anchor.getBoundingClientRect();
    const zoom = effectiveZoom(panel);
    const maxWidth = Math.max(1, window.innerWidth - VIEWPORT_MARGIN * 2);
    const width = Math.min(WIDTH * zoom, maxWidth);
    panel.style.width = `${width / zoom}px`;
    const height = panel.offsetHeight * zoom;
    // The composer sits at the bottom of the window, so prefer opening above.
    const above = rect.top - GAP - height;
    const top = above >= VIEWPORT_MARGIN ? above : Math.min(rect.bottom + GAP, window.innerHeight - VIEWPORT_MARGIN - height);
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.right - width, window.innerWidth - VIEWPORT_MARGIN - width));
    setStyle({ top: Math.max(VIEWPORT_MARGIN, top) / zoom, left: left / zoom, width: width / zoom, visibility: "visible" });
  }, [anchorRef]);

  const setPanelRef = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    if (node && topLayer) {
      try { node.showPopover?.(); } catch { /* already shown */ }
    }
  }, [topLayer]);

  useLayoutEffect(() => {
    position();
    const onViewport = () => position();
    window.addEventListener("resize", onViewport);
    window.addEventListener("scroll", onViewport, true);
    return () => {
      window.removeEventListener("resize", onViewport);
      window.removeEventListener("scroll", onViewport, true);
    };
  }, [position, parsed.ok, submitError]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => dateRef.current?.focus());
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [anchorRef, close, onClose]);

  const choose = (epoch: number) => {
    setDate(dateInputValue(epoch));
    setTime(timeInputValue(epoch));
    setTouched(true);
    setSubmitError(null);
  };

  const submit = async () => {
    setTouched(true);
    const result = parseLocalDateTime(date, time);
    if (!result.ok || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (await onSubmit(result.deliverAt)) close();
      else setSubmitError("This prompt could not be scheduled. Check the message above the composer.");
    } catch {
      setSubmitError("This prompt could not be scheduled.");
    } finally {
      setSubmitting(false);
    }
  };

  const showError = !parsed.ok && (touched || parsed.reason !== "past");
  const panel = (
    <div
      ref={setPanelRef}
      className="timed-prompt-picker"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={hintId}
      popover={topLayer ? "manual" : undefined}
      style={{ position: "fixed", inset: "auto", margin: 0, ...style }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <header>
          <span id={titleId}><CalendarClock size={14} aria-hidden="true" /> {title}</span>
          <button type="button" className="timed-prompt-close" onClick={close} aria-label="Close scheduling"><X size={13} /></button>
        </header>
        {contextLabel && <p className="timed-prompt-context">{contextLabel}</p>}
        <div className="timed-prompt-fields">
          <label>
            <span>Date</span>
            <input ref={dateRef} type="date" value={date} min={dateInputValue(now)} required
              onChange={(event) => { setDate(event.target.value); setTouched(true); setSubmitError(null); }} />
          </label>
          <label>
            <span>Time</span>
            <input type="time" value={time} step={60} required
              onChange={(event) => { setTime(event.target.value); setTouched(true); setSubmitError(null); }} />
          </label>
        </div>
        <div className="timed-prompt-quick" role="group" aria-label="Quick choices">
          <button type="button" onClick={() => choose(Date.now() + 60 * 60_000)}>In 1 hour</button>
          <button type="button" onClick={() => choose(tomorrowMorning())}>Tomorrow 9:00</button>
        </div>
        <p className={`timed-prompt-summary${showError ? " is-error" : ""}`} role={showError ? "alert" : undefined} aria-live="polite">
          {parsed.ok
            ? <>Sends {formatDeliveryTimeLong(parsed.deliverAt)}</>
            : showError ? parsed.message : <>Times use your local time zone ({zone}).</>}
        </p>
        <p id={hintId} className="timed-prompt-disclosure">
          <Info size={12} aria-hidden="true" />
          <span>
            Mythra Code must be open and awake at that time. If it is closed or asleep, the prompt is marked missed and waits for you; it is never sent late.
            After a restart, open this thread or draft before then so it can send. When due it joins the queue and never interrupts a running task.
          </span>
        </p>
        {submitError && <p className="timed-prompt-summary is-error" role="alert">{submitError}</p>}
        <footer>
          <button type="button" onClick={close}>Cancel</button>
          <button type="submit" className="timed-prompt-submit" disabled={!parsed.ok || submitting}>{submitLabel}</button>
        </footer>
      </form>
    </div>
  );
  return portalHost ? createPortal(panel, portalHost) : panel;
}
