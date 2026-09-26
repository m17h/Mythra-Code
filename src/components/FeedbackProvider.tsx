import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MessageSquarePlus } from "lucide-react";
import {
  MAX_FEEDBACK_NOTES,
  MAX_FEEDBACK_QUOTE_CHARS,
  assistantFeedbackAnchor,
  parseDiffLineAnchors,
  type FeedbackAnchor,
} from "../lib/reviewFeedback";
import type { DiffSection, ReviewDiff } from "../lib/gitDiff";
import type { ChatMessage } from "../types";
import { FeedbackFloat, FeedbackNoteCard, toFeedbackRect, useFloatDismiss, type FeedbackRect } from "./FeedbackNoteCard";

/** What a Review diff file offers for line feedback. Checkpoint previews pass nothing. */
export interface FeedbackDiffSource {
  section: DiffSection;
  diff: Pick<ReviewDiff, "baseline" | "source">;
}

interface FeedbackRegistry {
  enabled: boolean;
  /** Completed assistant texts by message id, read only when a note is made. */
  messages: Map<string, string>;
  diffs: WeakMap<Element, { current: FeedbackDiffSource | undefined }>;
  openForMessage: (messageId: string, trigger: HTMLElement) => void;
}

const FeedbackContext = createContext<FeedbackRegistry | null>(null);

const SOURCE_SELECTOR = "[data-feedback-message],[data-feedback-diff]";

interface Candidate { anchor: FeedbackAnchor; rect: FeedbackRect; source: HTMLElement }

function sourceFor(node: Node | null): HTMLElement | null {
  const element = node && (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement);
  return element?.closest<HTMLElement>(SOURCE_SELECTOR) ?? null;
}

/** The last painted line box of a range, where the selection visibly ends. */
function rangeEndRect(range: Range, fallback: Element): FeedbackRect {
  const rects = typeof range.getClientRects === "function" ? Array.from(range.getClientRects()) : [];
  const last = [...rects].reverse().find((rect) => rect.width > 0 && rect.height > 0);
  return toFeedbackRect(last ?? fallback.getBoundingClientRect());
}

/**
 * Rendered text of a reply fragment, without copy buttons or other controls.
 * `innerText` keeps paragraph and list breaks; jsdom falls back to text.
 */
function renderedText(range: Range): string {
  const fragment = range.cloneContents();
  fragment.querySelectorAll("button, [data-feedback-exclude]").forEach((node) => node.remove());
  const probe = document.createElement("div");
  probe.className = "feedback-text-probe";
  probe.append(fragment);
  document.body.append(probe);
  const text = (typeof probe.innerText === "string" ? probe.innerText : probe.textContent) ?? "";
  probe.remove();
  return text.replace(/​/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_FEEDBACK_QUOTE_CHARS);
}

/** Index of the rendered diff line (a direct child of the pre) holding a boundary. */
function diffLineIndex(pre: HTMLElement, node: Node, offset: number, edge: "start" | "end"): number {
  const count = pre.children.length;
  if (!count) return -1;
  if (node === pre) return Math.min(Math.max(edge === "start" ? offset : offset - 1, 0), count - 1);
  let child: Node | null = node;
  while (child && child.parentNode !== pre) child = child.parentNode;
  if (!(child instanceof Element)) return -1;
  let index = Array.prototype.indexOf.call(pre.children, child) as number;
  // A drag or triple-click that ends at the very start of the next line
  // should not pull that line into the note.
  if (edge === "end" && offset === 0 && index > 0 && (node === child || node === child.firstChild)) index -= 1;
  return index;
}

function diffAnchor(pre: HTMLElement, range: Range, source: FeedbackDiffSource): FeedbackAnchor | null {
  const start = diffLineIndex(pre, range.startContainer, range.startOffset, "start");
  const end = diffLineIndex(pre, range.endContainer, range.endOffset, "end");
  if (start < 0 || end < start) return null;
  const lines = parseDiffLineAnchors(source.section, source.diff).filter((entry) => entry.index >= start && entry.index <= end);
  if (!lines.length) return null;
  // A multi-line selection is a patch excerpt, preserving +/- and any hunk
  // separator. The coordinate identifies where that excerpt starts, not the
  // side of every later line. Nothing is ever relocated.
  const quote = lines.length === 1
    ? lines[0].anchor.quote
    : source.section.text.split("\n").slice(lines[0].index, lines[lines.length - 1].index + 1).join("\n").slice(0, MAX_FEEDBACK_QUOTE_CHARS);
  return { ...lines[0].anchor, quote };
}

function candidateFromRange(registry: FeedbackRegistry, range: Range, source: HTMLElement): Candidate | null {
  const messageId = source.getAttribute("data-feedback-message");
  let anchor: FeedbackAnchor | null = null;
  if (messageId !== null) {
    const text = registry.messages.get(messageId);
    const quote = text === undefined ? "" : renderedText(range);
    if (text !== undefined && quote) anchor = assistantFeedbackAnchor({ id: messageId, text }, quote);
  } else {
    const diff = registry.diffs.get(source)?.current;
    if (diff) anchor = diffAnchor(source, range, diff);
  }
  return anchor ? { anchor, rect: rangeEndRect(range, source), source } : null;
}

function selectionCandidate(registry: FeedbackRegistry): Candidate | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount || !selection.toString().trim()) return null;
  const range = selection.getRangeAt(0);
  // Both ends must sit inside one source: one reply, or one Review file.
  const source = sourceFor(range.commonAncestorContainer);
  return source ? candidateFromRange(registry, range, source) : null;
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/**
 * Holds the single floating Feedback button and note editor for the
 * conversation and Review panel. Notes are only staged through `onAdd`;
 * nothing is sent from here. A scope change closes transient UI without
 * remounting the conversation or workspace beneath this provider.
 */
export function FeedbackProvider({ enabled, scopeKey = "", onAdd, children }: {
  enabled: boolean;
  scopeKey?: string;
  /** Stage a note. Return false when it was refused (for example, the tray is full). */
  onAdd: (anchor: FeedbackAnchor, comment: string) => boolean;
  children: ReactNode;
}) {
  const messagesRef = useRef(new Map<string, string>());
  const diffsRef = useRef(new WeakMap<Element, { current: FeedbackDiffSource | undefined }>());
  const onAddRef = useRef(onAdd);
  useEffect(() => { onAddRef.current = onAdd; });
  const layerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const focusSelectionButtonRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const editorOpenRef = useRef(false);

  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [buttonOpen, setButtonOpen] = useState(false);
  const [draft, setDraft] = useState<(Candidate & { key: number }) | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [editorScope, setEditorScope] = useState(scopeKey);
  const scopeMatches = editorScope === scopeKey;
  // Reset only the transient controller, never its children. The render guard
  // also prevents a stale editor from submitting during a navigation commit.
  if (!scopeMatches) {
    returnFocusRef.current = null;
    focusSelectionButtonRef.current = false;
    setEditorScope(scopeKey);
    setButtonOpen(false);
    setEditorOpen(false);
    setCandidate(null);
    setDraft(null);
    setComment("");
    setError("");
    setAnnouncement("");
  }
  editorOpenRef.current = editorOpen && scopeMatches;

  useLayoutEffect(() => {
    if (!buttonOpen || !focusSelectionButtonRef.current || !buttonRef.current?.isConnected) return;
    // Focus after the float commits and enters the top layer. A single frame
    // scheduled by the selection event can run before React mounts the button.
    focusSelectionButtonRef.current = false;
    buttonRef.current.focus({ preventScroll: true });
  }, [buttonOpen, candidate]);

  useLayoutEffect(() => {
    const source = buttonOpen && candidate?.anchor.kind === "diff" ? candidate.source : null;
    source?.setAttribute("data-feedback-selection-active", "");
    return () => source?.removeAttribute("data-feedback-selection-active");
  }, [buttonOpen, candidate]);

  const restoreFocus = useCallback(() => {
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, []);

  const openEditor = useCallback((next: Candidate, returnFocus: HTMLElement | null) => {
    if (returnFocus) returnFocusRef.current = returnFocus;
    setDraft((current) => ({ ...next, key: (current?.key ?? 0) + 1 }));
    setComment("");
    setError("");
    setButtonOpen(false);
    setEditorOpen(true);
  }, []);

  const registryBase = useMemo(() => ({ messages: messagesRef.current, diffs: diffsRef.current }), []);

  const openForMessage = useCallback((messageId: string, trigger: HTMLElement) => {
    const source = trigger.closest("article")?.querySelector<HTMLElement>(`[data-feedback-message]`);
    if (!source || source.getAttribute("data-feedback-message") !== messageId) return;
    const registry = { ...registryBase, enabled: true, openForMessage: () => {} };
    // A selection inside this reply wins; otherwise the whole reply is cited.
    const selection = window.getSelection();
    const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null;
    let next = range && sourceFor(range.commonAncestorContainer) === source ? candidateFromRange(registry, range, source) : null;
    if (!next) {
      const whole = document.createRange();
      whole.selectNodeContents(source);
      next = candidateFromRange(registry, whole, source);
    }
    if (next) openEditor({ ...next, rect: toFeedbackRect(trigger.getBoundingClientRect()) }, trigger);
  }, [openEditor, registryBase]);

  const registry = useMemo<FeedbackRegistry>(
    () => ({ ...registryBase, enabled, openForMessage }),
    [enabled, openForMessage, registryBase],
  );
  const registryRef = useRef(registry);
  useEffect(() => { registryRef.current = registry; });

  // Selection is read once when a gesture settles, never per frame.
  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    let pointerStartedInSource = false;
    let shiftNavigationStart: { anchorNode: Node | null; anchorOffset: number; focusNode: Node | null; focusOffset: number } | null = null;
    const selectionPosition = () => {
      const selection = window.getSelection();
      return selection ? {
        anchorNode: selection.anchorNode,
        anchorOffset: selection.anchorOffset,
        focusNode: selection.focusNode,
        focusOffset: selection.focusOffset,
      } : null;
    };
    const evaluate = (fromKeyboard: boolean) => {
      if (editorOpenRef.current) return;
      const next = selectionCandidate(registryRef.current);
      if (!next) { focusSelectionButtonRef.current = false; setButtonOpen(false); returnFocusRef.current = null; return; }
      setCandidate(next);
      setButtonOpen(true);
      if (fromKeyboard) {
        returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        focusSelectionButtonRef.current = true;
      }
    };
    const schedule = (fromKeyboard: boolean) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => evaluate(fromKeyboard), 0);
    };
    const onPointerDown = (event: PointerEvent) => {
      pointerStartedInSource = event.target instanceof Node && Boolean(sourceFor(event.target));
    };
    const onPointerUp = (event: PointerEvent) => {
      const endsInSource = event.target instanceof Node && Boolean(sourceFor(event.target));
      const wasSelectingSource = pointerStartedInSource || endsInSource;
      pointerStartedInSource = false;
      if (event.target instanceof Node && layerRef.current?.contains(event.target)) return;
      // A click in a toolbar can leave the browser's earlier text selection
      // intact. It must dismiss the old action, not offer that action again.
      if (!wasSelectingSource) return;
      schedule(false);
    };
    // Shift+Tab must never steal focus just because an old selection remains.
    // Capture the selection before a keyboard navigation gesture and require
    // its endpoints to move before handing focus to the feedback button.
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditable(event.target)) return;
      if (!event.shiftKey) { shiftNavigationStart = null; return; }
      if (/^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown)$/.test(event.key)) {
        shiftNavigationStart ??= selectionPosition();
      } else if (event.key !== "Shift") {
        shiftNavigationStart = null;
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (isEditable(event.target)) return;
      if (event.key === "Shift") {
        const before = shiftNavigationStart;
        const after = selectionPosition();
        shiftNavigationStart = null;
        if (before && after && (before.anchorNode !== after.anchorNode || before.anchorOffset !== after.anchorOffset
          || before.focusNode !== after.focusNode || before.focusOffset !== after.focusOffset)) schedule(true);
      }
      else if (event.shiftKey && /^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown)$/.test(event.key)) schedule(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [enabled]);

  useEffect(() => {
    if (enabled) return;
    focusSelectionButtonRef.current = false;
    setButtonOpen(false);
    setEditorOpen(false);
  }, [enabled]);

  // The button follows its selection: collapse, scroll or resize dismisses it.
  useEffect(() => {
    if (!buttonOpen) return;
    const hide = () => { focusSelectionButtonRef.current = false; setButtonOpen(false); returnFocusRef.current = null; };
    const onSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) hide();
    };
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("resize", hide);
    };
  }, [buttonOpen]);

  useFloatDismiss(buttonOpen, layerRef, (reason) => {
    focusSelectionButtonRef.current = false;
    setButtonOpen(false);
    if (reason === "escape") restoreFocus();
    else returnFocusRef.current = null;
  });

  const closeEditor = useCallback(() => {
    setEditorOpen(false);
    restoreFocus();
  }, [restoreFocus]);

  // A typed note is never thrown away by a stray click or scroll.
  useFloatDismiss(editorOpen, layerRef, (reason) => {
    if (reason === "scroll") return;
    if (reason === "escape" || !comment.trim()) closeEditor();
  });

  const submit = () => {
    if (!enabled || !scopeMatches || !draft || !comment.trim()) return;
    if (!onAddRef.current(draft.anchor, comment.trim())) {
      setError(`This note could not be added. Feedback holds up to ${MAX_FEEDBACK_NOTES} notes, so send or remove some first.`);
      return;
    }
    setAnnouncement(`Feedback added to the composer.`);
    window.getSelection()?.removeAllRanges();
    closeEditor();
  };

  return (
    <FeedbackContext.Provider value={registry}>
      {children}
      <div className="feedback-layer" ref={layerRef}>
        <FeedbackFloat open={enabled && scopeMatches && buttonOpen && Boolean(candidate)} rect={candidate?.rect} placement="below" align="end" className="feedback-selection-float">
          <button
            ref={buttonRef}
            type="button"
            className="feedback-selection-button"
            // Keep the reader's selection alive through the click.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => { if (candidate) openEditor(candidate, returnFocusRef.current); }}
            aria-label="Add feedback on the selection"
          >
            <MessageSquarePlus size={13} aria-hidden="true" />
            Feedback
          </button>
        </FeedbackFloat>
        <FeedbackFloat open={enabled && scopeMatches && editorOpen && Boolean(draft)} rect={draft?.rect} placement="below" align="end" className="feedback-editor-float" role="dialog" label="Add feedback">
          {draft && (
            <FeedbackNoteCard
              key={draft.key}
              anchor={draft.anchor}
              comment={comment}
              submitLabel="Add"
              error={error}
              onComment={(value) => { setComment(value); if (error) setError(""); }}
              onSubmit={submit}
              onCancel={closeEditor}
            />
          )}
        </FeedbackFloat>
        <span className="sr-only" aria-live="polite">{announcement}</span>
      </div>
    </FeedbackContext.Provider>
  );
}

/**
 * Registers a completed assistant reply as a feedback source. Returns an
 * opener for the keyboard action, or null when feedback does not apply.
 */
export function useFeedbackMessageSource(message: Pick<ChatMessage, "id" | "role" | "text" | "streaming">): ((trigger: HTMLElement) => void) | null {
  const registry = useContext(FeedbackContext);
  const eligible = Boolean(registry?.enabled) && message.role === "assistant" && !message.streaming && Boolean(message.text.trim());
  const messages = registry?.messages;
  useEffect(() => {
    if (!eligible || !messages) return;
    messages.set(message.id, message.text);
    return () => { if (messages.get(message.id) === message.text) messages.delete(message.id); };
  }, [eligible, messages, message.id, message.text]);
  const openForMessage = registry?.openForMessage;
  return useMemo(
    () => (eligible && openForMessage ? (trigger: HTMLElement) => openForMessage(message.id, trigger) : null),
    [eligible, openForMessage, message.id],
  );
}

/**
 * A ref for a Review diff `<pre>`. The latest file and diff identity are read
 * only when a selection settles; nothing is indexed during render.
 */
export function useFeedbackDiffSource(source: FeedbackDiffSource | undefined): ((node: HTMLElement | null) => void) | undefined {
  const registry = useContext(FeedbackContext);
  const sourceRef = useRef(source);
  // A refreshed diff can be selected before passive effects run. Keep the
  // source tied to the same render that replaced the visible lines.
  sourceRef.current = source;
  const diffs = registry?.diffs;
  const attach = useCallback((node: HTMLElement | null) => {
    if (node && diffs) diffs.set(node, sourceRef);
  }, [diffs]);
  return source && registry?.enabled ? attach : undefined;
}
