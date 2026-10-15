import { invoke, isTauri } from "@tauri-apps/api/core";
import { create } from "zustand";

type Editor = HTMLInputElement | HTMLTextAreaElement;
interface SpellingMenu {
  id: number;
  x: number;
  y: number;
  word: string;
  suggestions: string[];
  editor: Editor;
  originalValue: string;
  start: number;
  end: number;
  viaKeyboard: boolean;
}

export const useSpellingMenu = create<{ menu: SpellingMenu | null }>(() => ({ menu: null }));
let requestId = 0;
// The editor of a lookup still in flight, so unrelated scrolling elsewhere
// (a streaming transcript, a sidebar) cannot cancel it.
let pendingEditor: Editor | null = null;
let lookupRunning = false;
let nextLookup: (() => Promise<void>) | null = null;

/** Keep one active lookup and only the most recent waiting click. */
async function runLookup(work: () => Promise<void>): Promise<void> {
  if (lookupRunning) { nextLookup = work; return; }
  lookupRunning = true;
  try { await work(); }
  catch { /* Missing/busy OS dictionaries must never interrupt typing. */ }
  finally {
    lookupRunning = false;
    const next = nextLookup;
    nextLookup = null;
    if (next) void runLookup(next);
  }
}

export function dismissSpellingMenu(restoreFocus = false): void {
  requestId++;
  nextLookup = null;
  pendingEditor = null;
  const menu = useSpellingMenu.getState().menu;
  useSpellingMenu.setState({ menu: null });
  if (restoreFocus && menu?.editor.isConnected) menu.editor.focus({ preventScroll: true });
}

/** Only scrolling that moves the menu's word away from the pointer closes it. */
export function dismissSpellingMenuForScroll(target: EventTarget | null): void {
  const editor = useSpellingMenu.getState().menu?.editor ?? pendingEditor;
  if (!editor) return;
  if (target instanceof Document || (target instanceof Node && target.contains(editor))) dismissSpellingMenu();
}

function editable(target: EventTarget | null): Editor | null {
  if (!(target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) return null;
  if (target instanceof HTMLInputElement && !["text", "search"].includes(target.type)) return null;
  if (target.matches(":disabled") || target.readOnly || !target.spellcheck || target.closest('[inert], [aria-hidden="true"]') || !target.getClientRects().length) return null;
  return target;
}

/** Native spellcheck ranges are not exposed to JS. A short-lived, invisible
 * layout mirror hit-tests the word at the pointer, including wrapped/scrolled
 * textarea content. It never focuses the editor or changes its selection. */
function wordAtPoint(editor: Editor, x: number, y: number) {
  const value = editor.value;
  if (!value || value.length > 100_000) return null;
  const doc = editor.ownerDocument;
  const rect = editor.getBoundingClientRect();
  const style = getComputedStyle(editor);
  const scale = rect.width / editor.offsetWidth || 1;
  const mirror = doc.createElement("div");
  const properties = ["boxSizing", "width", "height", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant", "fontStretch", "lineHeight", "letterSpacing", "wordSpacing", "textIndent", "textAlign", "textTransform", "direction", "tabSize", "wordBreak", "overflowWrap", "scrollbarGutter"] as const;
  for (const property of properties) mirror.style[property] = style[property];
  Object.assign(mirror.style, {
    position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, margin: "0",
    transform: `scale(${scale})`, transformOrigin: "top left", zIndex: "2147483647",
    opacity: "0", borderStyle: "solid", overflow: "auto", pointerEvents: "auto",
    whiteSpace: editor instanceof HTMLTextAreaElement && editor.wrap !== "off" ? "pre-wrap" : "pre",
  });
  mirror.setAttribute("aria-hidden", "true");
  const text = doc.createTextNode(value);
  mirror.append(text);
  doc.body.append(mirror);
  mirror.scrollTop = editor.scrollTop;
  mirror.scrollLeft = editor.scrollLeft;
  try {
    const hitDoc = doc as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const position = hitDoc.caretPositionFromPoint?.(x, y);
    const caret = position ? null : hitDoc.caretRangeFromPoint?.(x, y);
    const node = position?.offsetNode ?? caret?.startContainer;
    const offset = position?.offset ?? caret?.startOffset;
    if (node !== text || offset === undefined) return null;
    const segments = new Intl.Segmenter(undefined, { granularity: "word" }).segment(value);
    for (const part of segments) {
      if (!part.isWordLike || offset < part.index || offset > part.index + part.segment.length) continue;
      const word = part.segment;
      if (word.length > 128 || !/^[\p{L}\p{M}'’ʼ-]+$/u.test(word)) continue;
      const range = doc.createRange();
      range.setStart(text, part.index);
      range.setEnd(text, part.index + word.length);
      const hit = Array.from(range.getClientRects()).some((box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom);
      if (hit) return { word, start: part.index, end: part.index + word.length };
    }
    return null;
  } finally {
    mirror.remove();
  }
}

export function requestSpellingMenu(event: Pick<MouseEvent, "target" | "clientX" | "clientY">): void {
  dismissSpellingMenu();
  const editor = editable(event.target);
  if (!editor || !isTauri()) return;
  // Keyboard context-menu invocation uses the selected word/caret instead.
  const keyboard = event.clientX === 0 && event.clientY === 0;
  let hit: { word: string; start: number; end: number } | null = null;
  if (keyboard && editor.value.length <= 100_000 && editor.selectionStart !== null && editor.selectionEnd !== null) {
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    if (end > start) hit = { word: editor.value.slice(start, end), start, end };
    else {
      for (const part of new Intl.Segmenter(undefined, { granularity: "word" }).segment(editor.value)) {
        if (part.isWordLike && start >= part.index && start <= part.index + part.segment.length) {
          hit = { word: part.segment, start: part.index, end: part.index + part.segment.length };
          break;
        }
      }
    }
  } else if (!keyboard) hit = wordAtPoint(editor, event.clientX, event.clientY);
  if (!hit || hit.word.length > 128 || !/^[\p{L}\p{M}'’ʼ-]+$/u.test(hit.word)) return;
  const id = requestId;
  pendingEditor = editor;
  const originalValue = editor.value;
  const bounds = editor.getBoundingClientRect();
  const { word, start, end } = hit;
  // Only the clicked word is sent to the local OS dictionary, never the draft.
  void runLookup(async () => {
    if (id !== requestId || !editor.isConnected || editor.value !== originalValue) return;
    const result = await invoke<{ misspelled: boolean; suggestions: string[] }>("spelling_suggestions", { word, language: editor.lang || null });
    if (id === requestId) pendingEditor = null;
    if (id !== requestId || !result.misspelled || !editor.isConnected || editor.ownerDocument.activeElement !== editor || editor.value !== originalValue || !editable(editor)) return;
    const suggestions = [...new Set(result.suggestions)].filter((entry) => entry !== word && entry.length <= 128 && !/[\r\n\0]/.test(entry)
      && (editor.maxLength < 0 || originalValue.length - word.length + entry.length <= editor.maxLength)).slice(0, 6);
    useSpellingMenu.setState({ menu: { id, x: keyboard ? bounds.left + 12 : event.clientX, y: keyboard ? bounds.bottom : event.clientY, word, start, end, suggestions, editor, originalValue, viaKeyboard: keyboard } });
  });
}

export function applySpellingSuggestion(id: number, suggestion: string): void {
  const menu = useSpellingMenu.getState().menu;
  if (!menu || menu.id !== id || !menu.suggestions.includes(suggestion)) return;
  const { editor, start, end, originalValue } = menu;
  if (!editable(editor) || !editor.isConnected || editor.value !== originalValue || originalValue.slice(start, end) !== menu.word
    || (editor.maxLength >= 0 && originalValue.length - (end - start) + suggestion.length > editor.maxLength)) {
    dismissSpellingMenu();
    return;
  }
  dismissSpellingMenu();
  editor.focus({ preventScroll: true });
  editor.setSelectionRange(start, end);
  // insertText preserves the native undo history and emits the real input
  // event React uses to update controlled drafts. setRangeText alone does not.
  if (!document.execCommand("insertText", false, suggestion)) {
    editor.setRangeText(suggestion, start, end, "end");
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: suggestion }));
  }
}
