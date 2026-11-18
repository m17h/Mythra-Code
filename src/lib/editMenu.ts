import { formatKeys } from "./shortcuts";

/**
 * Cut / Copy / Paste / Select all for text boxes that opt in with a
 * `data-edit-menu` attribute (the composer). The app turns the webview's own
 * right-click menu off everywhere (`installContextMenuBlocker`), so these
 * boxes get this menu instead; it shares the spelling menu's popover, so a
 * misspelled word still shows its suggestions above the edit commands.
 *
 * Clipboard reads go through the standard async Clipboard API, which needs
 * no plugin:
 * - macOS (WKWebView): text this app copied pastes at once. Text copied in
 *   another app makes WebKit show its own one-item "Paste" button first,
 *   which is the system's privacy check and can't be skipped from the page.
 * - Windows (WebView2): the first read asks for clipboard permission; once
 *   allowed it is remembered. If it was blocked, Paste shows as unavailable
 *   (the keyboard shortcut still pastes).
 */

export type EditCommand = "cut" | "copy" | "paste" | "selectAll";

/** What the menu knows about the clipboard. "unknown" means the engine can't
 * say without asking the user (WebKit always; WebView2 before permission),
 * so Paste stays available and the choice itself asks. */
export type ClipboardContents = "unknown" | "empty" | "text" | "image" | "unreadable";

export interface EditorSnapshot {
  selectionStart: number;
  selectionEnd: number;
  length: number;
  /** False for read-only or disabled boxes (voice input holds the draft). */
  editable: boolean;
}

export interface EditMenuItem {
  command: EditCommand;
  label: string;
  /** Formatted for display: ⌘X on macOS, Ctrl+X elsewhere. */
  shortcut: string;
  /** For `aria-keyshortcuts`. */
  ariaShortcut: string;
  disabled: boolean;
  separatorBefore?: boolean;
}

const KEYS: Record<EditCommand, string> = { cut: "X", copy: "C", paste: "V", selectAll: "A" };

/** A text box keeps its own plain text, so "Paste as plain text" would do the
 * same as Paste and is left out. */
export function editMenuItems(editor: EditorSnapshot, clipboard: ClipboardContents, platform?: string): EditMenuItem[] {
  const selected = editor.selectionEnd > editor.selectionStart;
  const mac = formatKeys(["Mod"], platform) === "⌘";
  const item = (command: EditCommand, label: string, disabled: boolean, separatorBefore?: boolean): EditMenuItem => ({
    command,
    label,
    shortcut: formatKeys(["Mod", KEYS[command]], platform),
    ariaShortcut: `${mac ? "Meta" : "Control"}+${KEYS[command]}`,
    disabled,
    ...(separatorBefore ? { separatorBefore } : {}),
  });
  return [
    item("cut", "Cut", !selected || !editor.editable),
    item("copy", "Copy", !selected),
    item("paste", "Paste", !editor.editable || clipboard === "empty" || clipboard === "unreadable"),
    item("selectAll", "Select all", editor.length === 0, true),
  ];
}

/** Line breaks as a native textarea paste stores them; NULs never reach a draft. */
export function normalizePastedText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\0/g, "");
}

/** Trim a paste so it fits a `maxlength`, as a native paste does. */
export function fitPasteToMaxLength(text: string, valueLength: number, selectionLength: number, maxLength: number): string {
  if (maxLength < 0) return text;
  const room = Math.max(0, maxLength - (valueLength - selectionLength));
  if (text.length <= room) return text;
  // Don't split a surrogate pair at the cut.
  const cut = text.slice(0, room);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Classify a clipboard read (`ClipboardItem.types` lists and the text, if any). */
export function classifyClipboard(types: readonly (readonly string[])[], text: string | null): ClipboardContents {
  if (types.some((list) => list.some((type) => type.startsWith("image/")))) return "image";
  if (text) return "text";
  return "empty";
}

type Editor = HTMLInputElement | HTMLTextAreaElement;
export interface EditTarget {
  editor: Editor;
  /** The selection and value when the menu opened. */
  selectionStart: number;
  selectionEnd: number;
  originalValue: string;
}

function isPermissionError(reason: unknown): boolean {
  return reason instanceof DOMException && (reason.name === "NotAllowedError" || reason.name === "SecurityError");
}

/** Only where the engine can answer without asking the user (a granted
 * Chromium permission). WebKit has no clipboard permission query and would
 * show its Paste prompt on every right-click, so it stays "unknown". */
export async function probeClipboard(): Promise<ClipboardContents> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard?.read && !clipboard?.readText) return "unknown";
  let state: PermissionState;
  try {
    state = (await navigator.permissions.query({ name: "clipboard-read" as PermissionName })).state;
  } catch {
    return "unknown";
  }
  if (state === "denied") return "unreadable";
  if (state !== "granted") return "unknown";
  try {
    if (clipboard.read) {
      const items = await clipboard.read();
      const types = items.map((entry) => entry.types);
      const textItem = items.find((entry) => entry.types.includes("text/plain"));
      const text = textItem ? await (await textItem.getType("text/plain")).text() : null;
      return classifyClipboard(types, text);
    }
    return classifyClipboard([], await clipboard.readText());
  } catch (reason) {
    return isPermissionError(reason) ? "unreadable" : "unknown";
  }
}

/** Focus the box and put back the selection the menu was opened on. */
function focusTarget({ editor, selectionStart, selectionEnd, originalValue }: EditTarget): void {
  editor.focus({ preventScroll: true });
  if (editor.value === originalValue) editor.setSelectionRange(selectionStart, selectionEnd);
}

/** insertText keeps native undo (⌘Z) and fires the real input event React's
 * controlled draft listens to. setRangeText alone does neither. */
function insertText(editor: Editor, text: string, inputType: string): void {
  if (document.execCommand("insertText", false, text)) return;
  const start = editor.selectionStart ?? editor.value.length;
  const end = editor.selectionEnd ?? start;
  editor.setRangeText(text, start, end, "end");
  editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data: text }));
}

async function readClipboard(): Promise<{ text: string; images: File[] }> {
  const clipboard = navigator.clipboard;
  if (clipboard.read) {
    try {
      const items = await clipboard.read();
      const images: File[] = [];
      let text = "";
      for (const entry of items) {
        const imageType = entry.types.find((type) => type.startsWith("image/"));
        if (imageType) {
          const blob = await entry.getType(imageType);
          images.push(new File([blob], `clipboard.${imageType.split("/")[1] || "png"}`, { type: imageType }));
        }
        if (!text && entry.types.includes("text/plain")) text = await (await entry.getType("text/plain")).text();
      }
      return { text, images };
    } catch (reason) {
      // A refused prompt must not be asked twice.
      if (isPermissionError(reason)) throw reason;
    }
  }
  return { text: await clipboard.readText(), images: [] };
}

export type PasteOutcome = "pasted" | "empty" | "refused";

/**
 * Paste at the caret, replacing the selection. The read starts inside the
 * click so the engine sees the user's gesture. Everything read is offered
 * first as a `paste` event on the box, so its own handler still decides
 * (the composer turns images into attachments); text it leaves alone is
 * inserted with undo intact.
 */
export async function pasteIntoEditor(target: EditTarget): Promise<PasteOutcome> {
  const { editor } = target;
  focusTarget(target);
  if (!navigator.clipboard?.read && !navigator.clipboard?.readText) {
    // No async clipboard (an insecure page): the legacy command is the only way.
    return document.execCommand("paste") ? "pasted" : "refused";
  }
  let contents: { text: string; images: File[] };
  try {
    contents = await readClipboard();
  } catch {
    return "refused";
  }
  if (!editor.isConnected || editor.disabled || editor.readOnly) return "refused";
  // A prompt (WebKit's Paste button, WebView2's permission) moves focus.
  if (editor.ownerDocument.activeElement !== editor) focusTarget(target);
  const text = normalizePastedText(contents.text);
  if (typeof DataTransfer === "function") {
    const transfer = new DataTransfer();
    for (const image of contents.images) transfer.items.add(image);
    if (text) transfer.setData("text/plain", text);
    const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
    // Handlers read event.clipboardData; skip engines that drop it.
    if (event.clipboardData) {
      editor.dispatchEvent(event);
      if (event.defaultPrevented) return "pasted";
    }
  }
  if (!text) return "empty";
  const start = editor.selectionStart ?? editor.value.length;
  const end = editor.selectionEnd ?? start;
  const fitted = fitPasteToMaxLength(text, editor.value.length, end - start, editor.maxLength);
  if (!fitted) return "empty";
  insertText(editor, fitted, "insertFromPaste");
  return "pasted";
}

/** execCommand keeps undo for Cut and needs no permission in either engine;
 * the async API is the fallback. */
export async function copyFromEditor(target: EditTarget, cut: boolean): Promise<boolean> {
  const { editor } = target;
  focusTarget(target);
  const start = editor.selectionStart ?? 0;
  const end = editor.selectionEnd ?? start;
  if (end <= start) return false;
  if (document.execCommand(cut ? "cut" : "copy")) return true;
  const text = editor.value.slice(start, end);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return false;
  }
  if (cut && editor.isConnected && !editor.readOnly && !editor.disabled) {
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(start, end);
    if (!document.execCommand("delete")) {
      editor.setRangeText("", start, end, "end");
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteByCut" }));
    }
  }
  return true;
}

export function selectAllInEditor(target: EditTarget): void {
  target.editor.focus({ preventScroll: true });
  target.editor.select();
}

export function runEditCommand(command: EditCommand, target: EditTarget): void {
  if (command === "cut" || command === "copy") void copyFromEditor(target, command === "cut");
  else if (command === "paste") void pasteIntoEditor(target);
  else selectAllInEditor(target);
}
