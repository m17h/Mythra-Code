import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { EmptyState as BaseEmptyState } from "./EmptyState";
import { Info } from "lucide-react";
import { InfoPopover } from "./InfoPopover";

/**
 * Small shared pieces for Settings rows, so every pane says the same thing
 * the same way.
 *
 * Settings saves as you go, so nothing here marks a control as "instant":
 * every control is.
 */

/** The one on/off control, shared app-wide (src/components/Switch.tsx). */
export { Switch } from "./Switch";

/** The longer explanation for a row, behind a small info button. */
export function SettingInfo({ label, children }: { label: string; children: ReactNode }) {
  return <InfoPopover label={label} className="set-info" triggerClassName="set-info-trigger" trigger={<Info size={13} aria-hidden="true" />}>
    <div className="set-info-body">{children}</div>
  </InfoPopover>;
}

/**
 * Arrow-key movement for a choose-one group (`role="radiogroup"` with
 * `role="radio"` children, or a `role="tablist"` of tabs). Put it on the
 * group's onKeyDown and give only the selected item `tabIndex={0}`:
 * ←/→/↑/↓ move and select, Home/End jump to the ends, like native radios.
 */
export function rovingChoiceKeyDown(event: KeyboardEvent<HTMLElement>): void {
  const { key } = event;
  if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(key)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"], [role="tab"]')]
    .filter((item) => !item.hasAttribute("disabled") && item.closest('[role="radiogroup"], [role="tablist"]') === event.currentTarget);
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (index < 0 || !items.length) return;
  event.preventDefault();
  const next = key === "Home" ? 0
    : key === "End" ? items.length - 1
      : (index + (key === "ArrowRight" || key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[next]!.focus();
  items[next]!.click();
}

/**
 * The app's one empty state (src/components/EmptyState.tsx), laid out for
 * Settings lists: icon, title and one line of help on the left, an optional
 * action on the right, on a plain card. `inline` sits inside a card that
 * already has a surface. Never a dashed box.
 */
export function EmptyState({ icon, title, detail, action, inline = false }: {
  icon?: ComponentType<{ size?: number | string; "aria-hidden"?: boolean | "true" | "false" }>;
  title: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  inline?: boolean;
}) {
  return <BaseEmptyState
    variant={inline ? "inline" : "compact"}
    className={`set-empty${inline ? " inline" : ""}${icon ? "" : " no-icon"}`}
    icon={icon}
    title={title}
    text={detail}
  >{action && <span className="set-empty-action">{action}</span>}</BaseEmptyState>;
}

/**
 * A compact in-page index for a long pane (O10/M04). It sticks to the top of
 * the scrolling pane, marks the section in view, and moves both the scroll
 * position and keyboard focus to the chosen section's heading. Sections are
 * found by id; each heading should carry tabIndex={-1}.
 */
export function SettingsJumpList({ label, items, scrollRef }: {
  label: string;
  items: ReadonlyArray<{ id: string; label: string }>;
  scrollRef: RefObject<HTMLElement | null>;
}) {
  const [current, setCurrent] = useState(items[0]?.id ?? "");
  // A chosen section stays marked while the jump's own scroll settles, even
  // when it ends at the bottom where a later, shorter section is in view.
  // A chosen section stays marked until the person scrolls on their own
  // (wheel, touch or keys), so a short last section isn't unmarked the
  // moment its jump settles.
  const chosen = useRef<string | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (chosen.current) { setCurrent(chosen.current); return; }
      // Opus R6 D10 / Sol M07: the marked section is the one that fills
      // most of what is visible below the sticky index, so the mark matches
      // the content in view (not a short last section at the very end).
      const box = root.getBoundingClientRect();
      const top = box.top + (navRef.current?.offsetHeight ?? 40);
      let next = items[0]?.id ?? "";
      let best = 0;
      for (const item of items) {
        const rect = document.getElementById(item.id)?.getBoundingClientRect();
        if (!rect) continue;
        const shown = Math.min(rect.bottom, box.bottom) - Math.max(rect.top, top);
        if (shown > best + 1) { best = shown; next = item.id; }
      }
      setCurrent(next);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    const release = () => { if (chosen.current) { chosen.current = null; onScroll(); } };
    update();
    root.addEventListener("scroll", onScroll, { passive: true });
    root.addEventListener("wheel", release, { passive: true });
    root.addEventListener("touchstart", release, { passive: true });
    root.addEventListener("keydown", release);
    // Sections that load after the list (e.g. Language tools) change the
    // pane's height; until then the pane can look "scrolled to the end" and
    // the last section would be marked. Re-measure when any section resizes.
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(onScroll) : null;
    for (const item of items) { const element = document.getElementById(item.id); if (element) resize?.observe(element); }
    return () => {
      root.removeEventListener("scroll", onScroll);
      root.removeEventListener("wheel", release);
      root.removeEventListener("touchstart", release);
      root.removeEventListener("keydown", release);
      resize?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [items, scrollRef]);
  return (
    // An in-page index, not tabs: every section stays on the page, so it
    // reads "On this page" and marks the section in view with an underline.
    <nav className="set-jump" aria-label={label} ref={navRef}>
      <span className="set-jump-label" aria-hidden="true">On this page</span>
      {items.map((item) => (
        <button key={item.id} type="button" aria-current={current === item.id ? "location" : undefined}
          className={current === item.id ? "current" : undefined}
          onClick={() => {
            const section = document.getElementById(item.id);
            if (!section) return;
            const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
            // Land just below the sticky index, whatever height it wraps to.
            section.style.scrollMarginTop = `${(navRef.current?.offsetHeight ?? 40) + 8}px`;
            section.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
            const heading = section.querySelector<HTMLElement>("h4");
            heading?.focus({ preventScroll: true });
            // The section just landed on is marked briefly, as search does.
            const mark = section.querySelector<HTMLElement>(":scope > .set-card") ?? section;
            mark.classList.add("settings-row-highlight");
            window.setTimeout(() => mark.classList.remove("settings-row-highlight"), 1_600);
            chosen.current = item.id;
            setCurrent(item.id);
          }}>{item.label}</button>
      ))}
    </nav>
  );
}
