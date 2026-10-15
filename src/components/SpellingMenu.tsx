import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { SpellCheck } from "lucide-react";
import { applySpellingSuggestion, dismissSpellingMenu, useSpellingMenu } from "../lib/spelling";

/** Render inside app-shell so every theme and UI scale is inherited. The
 * popover top layer keeps it above Settings without an OS/browser menu.
 *
 * Motion uses the same CSS keyframe pattern as the app's other panels: the
 * outer popover box is only positioned (never transformed, so measurement is
 * exact) and the inner panel plays the entrance/exit. A popover is display:none
 * until shown, so the entrance starts on the first painted frame at opacity 0. */
export function SpellingMenu({ scope }: { scope: string }) {
  const menu = useSpellingMenu((state) => state.menu);
  // Dismissed menus stop being actionable at once, but their snapshot stays
  // mounted until the exit animation ends.
  const [renderedMenu, setRenderedMenu] = useState(menu);
  // Painted highlight, so the chosen row does not snap off when :hover and
  // focus disappear at the start of the exit.
  const [highlighted, setHighlighted] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    dismissSpellingMenu();
    return () => dismissSpellingMenu();
  }, [scope]);
  useLayoutEffect(() => {
    if (menu) {
      setRenderedMenu(menu);
      setHighlighted(menu.viaKeyboard && menu.suggestions.length ? 0 : -1);
    }
  }, [menu]);
  const active = Boolean(menu && renderedMenu && menu.id === renderedMenu.id);
  const finishExit = (id: number) => {
    if (useSpellingMenu.getState().menu?.id === id) return;
    setRenderedMenu((current) => current?.id === id ? null : current);
  };
  useLayoutEffect(() => {
    const element = ref.current;
    if (!renderedMenu || !element) return;
    element.showPopover?.();
    const box = element.getBoundingClientRect();
    const scale = box.width / element.offsetWidth || 1;
    const left = Math.max(8, Math.min(renderedMenu.x, window.innerWidth - box.width - 8));
    // The composer sits at the bottom of the window: open upward from the
    // pointer rather than clamping the menu over it when there is no room below.
    const above = renderedMenu.y + box.height + 8 > window.innerHeight && renderedMenu.y - box.height >= 8;
    const top = above ? renderedMenu.y - box.height : Math.max(8, Math.min(renderedMenu.y, window.innerHeight - box.height - 8));
    element.style.left = `${left / scale}px`;
    element.style.top = `${top / scale}px`;
    element.dataset.placement = above ? "above" : "below";
    const first = element.querySelector<HTMLButtonElement>("button");
    (renderedMenu.viaKeyboard && first ? first : element).focus({ preventScroll: true });
  }, [renderedMenu]);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!renderedMenu || active || !panel) return;
    const id = renderedMenu.id;
    // Reduced motion (or no animation support) has nothing to wait for.
    if (getComputedStyle(panel).animationName === "none") {
      finishExit(id);
      return;
    }
    // animationend never arrives if the window stops rendering mid-exit.
    const fallback = window.setTimeout(() => finishExit(id), 600);
    return () => window.clearTimeout(fallback);
  }, [active, renderedMenu]);
  if (!renderedMenu) return null;
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") { dismissSpellingMenu(true); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
    if (!buttons.length) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === "Home" || (current < 0 && event.key === "ArrowDown") ? 0
      : event.key === "End" || (current < 0 && event.key === "ArrowUp") ? buttons.length - 1
        : (current + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
    buttons[index]?.focus();
  };
  return <div key={renderedMenu.id} ref={ref} tabIndex={-1} popover="manual" className="spelling-menu" data-state={active ? "open" : "closing"} inert={!active} aria-hidden={!active || undefined} role="menu" aria-label={`Spelling suggestions for ${renderedMenu.word}`} onKeyDown={active ? keyboard : undefined}>
    <div ref={panelRef} className="spelling-menu-panel" onAnimationEnd={(event) => {
      if (event.target === event.currentTarget && !active) finishExit(renderedMenu.id);
    }} onPointerLeave={() => { if (active) setHighlighted(-1); }}>
      <div className="spelling-menu-heading"><SpellCheck size={14} aria-hidden="true" /><span>Spelling</span></div>
      <div className="spelling-menu-word">{renderedMenu.word}</div>
      {renderedMenu.suggestions.map((suggestion, index) => <button key={suggestion} type="button" role="menuitem" tabIndex={-1} data-highlighted={highlighted === index || undefined}
        onPointerMove={() => { if (active && highlighted !== index) setHighlighted(index); }}
        onFocus={() => { if (active) setHighlighted(index); }}
        onClick={() => { if (active) applySpellingSuggestion(renderedMenu.id, suggestion); }}>{suggestion}</button>)}
      {!renderedMenu.suggestions.length && <span className="spelling-menu-empty">No suggestions found</span>}
    </div>
  </div>;
}
