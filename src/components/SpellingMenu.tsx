import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { SpellCheck } from "lucide-react";
import { useMenuKeyboard } from "../hooks/useMenuKeyboard";
import { editMenuItems, probeClipboard, runEditCommand, type ClipboardContents, type EditCommand } from "../lib/editMenu";
import { applySpellingSuggestion, dismissSpellingMenu, useSpellingMenu } from "../lib/spelling";

/** Render inside app-shell so every theme and UI scale is inherited. The
 * popover top layer keeps it above Settings without an OS/browser menu.
 *
 * Motion uses the same CSS keyframe pattern as the app's other panels: the
 * outer popover box is only positioned (never transformed, so measurement is
 * exact) and the inner panel plays the entrance/exit. A popover is display:none
 * until shown, so the entrance starts on the first painted frame at opacity 0.
 *
 * Boxes with `data-edit-menu` (the composer) also get Cut, Copy, Paste and
 * Select all here, under any spelling suggestions (see lib/editMenu.ts).
 * Keys follow the shared menu contract (useMenuKeyboard); Escape and Tab
 * return focus to the text box. */
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
  // The text box plays the trigger's part: Escape, Tab and choices return to it.
  const editorRef = useRef<HTMLElement | null>(null);
  editorRef.current = renderedMenu?.editor ?? null;
  const [clipboard, setClipboard] = useState<ClipboardContents>("unknown");
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
  const setOpen = useCallback((open: boolean) => { if (!open) dismissSpellingMenu(); }, []);
  const keys = useMenuKeyboard({ open: active, setOpen, menuRef: ref, triggerRef: editorRef, focusOnOpen: false });
  const editId = menu?.edit ? menu.id : null;
  // Paste is only marked unavailable when the engine can tell without a prompt.
  useEffect(() => {
    if (editId === null) return;
    let current = true;
    setClipboard("unknown");
    void probeClipboard().then((contents) => { if (current) setClipboard(contents); });
    return () => { current = false; };
  }, [editId]);
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
    const first = element.querySelector<HTMLButtonElement>("button:not(:disabled)");
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
  const { editor, edit } = renderedMenu;
  const suggestions = renderedMenu.misspelled ? renderedMenu.suggestions : [];
  const editItems = edit ? editMenuItems({
    selectionStart: edit.selectionStart,
    selectionEnd: edit.selectionEnd,
    length: renderedMenu.originalValue.length,
    editable: !editor.readOnly && !editor.disabled,
  }, clipboard) : [];
  const choose = (command: EditCommand) => {
    if (!active || !edit) return;
    dismissSpellingMenu();
    runEditCommand(command, { editor, ...edit, originalValue: renderedMenu.originalValue });
  };
  const label = renderedMenu.misspelled
    ? edit ? `Edit, with spelling suggestions for ${renderedMenu.word}` : `Spelling suggestions for ${renderedMenu.word}`
    : "Edit";
  return <div key={renderedMenu.id} ref={ref} tabIndex={-1} popover="manual" className={`spelling-menu${edit ? " edit-menu" : ""}`} data-state={active ? "open" : "closing"} inert={!active} aria-hidden={!active || undefined} role="menu" aria-label={label} onKeyDown={active ? keys.onMenuKeyDown : undefined}>
    <div ref={panelRef} className="spelling-menu-panel" onAnimationEnd={(event) => {
      if (event.target === event.currentTarget && !active) finishExit(renderedMenu.id);
    }} onPointerLeave={() => { if (active) setHighlighted(-1); }}>
      {renderedMenu.misspelled && <>
        <div className="spelling-menu-heading"><SpellCheck size={14} aria-hidden="true" /><span>Spelling</span></div>
        <div className="spelling-menu-word">{renderedMenu.word}</div>
        {suggestions.map((suggestion, index) => <button key={suggestion} type="button" role="menuitem" tabIndex={-1} data-highlighted={highlighted === index || undefined}
          onPointerMove={() => { if (active && highlighted !== index) setHighlighted(index); }}
          onFocus={() => { if (active) setHighlighted(index); }}
          onClick={() => { if (active) applySpellingSuggestion(renderedMenu.id, suggestion); }}>{suggestion}</button>)}
        {!suggestions.length && <span className="spelling-menu-empty">No suggestions found</span>}
      </>}
      {editItems.length > 0 && <div role="group" aria-label="Edit" className={`edit-menu-group${renderedMenu.misspelled ? " separated" : ""}`}>
        {editItems.map((item, offset) => {
          const index = suggestions.length + offset;
          return <button key={item.command} type="button" role="menuitem" tabIndex={-1} disabled={item.disabled}
            className={`edit-menu-item${item.separatorBefore ? " separated" : ""}`}
            aria-label={item.label} aria-keyshortcuts={item.ariaShortcut}
            data-highlighted={!item.disabled && highlighted === index || undefined}
            onPointerMove={() => { if (active && !item.disabled && highlighted !== index) setHighlighted(index); }}
            onFocus={() => { if (active) setHighlighted(index); }}
            onClick={() => choose(item.command)}>
            <span>{item.label}</span><kbd aria-hidden="true">{item.shortcut}</kbd>
          </button>;
        })}
      </div>}
    </div>
  </div>;
}
