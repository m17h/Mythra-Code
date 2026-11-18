import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { ChevronRight, LoaderCircle, MessageSquarePlus, Minus, Plus, Undo2, WrapText } from "lucide-react";
import { splitChangePath } from "../lib/gitChanges";
import type { DiffSection, ReviewDiff } from "../lib/gitDiff";
import { gutterDigits, highlightDiff, numberDiffLines, type DiffRowInfo } from "../lib/diffRows";
import { useFeedbackDiffSource, useFeedbackRangeOpener, type FeedbackDiffSource } from "./FeedbackProvider";
import { renderSyntaxTokens } from "./SyntaxCode";

/**
 * Lines rendered before a diff asks to be expanded further. A refactor that
 * touches a generated file can produce tens of thousands of lines, and every
 * one of them was previously a DOM node created up front — even inside a
 * collapsed file nobody opened.
 */
export const DIFF_INITIAL_LINES = 400;
/** How much more one "Show more" reveals. */
export const DIFF_LINE_STEP = 2_000;

/* ---------------------------------------------------------------------------
 * Wrap long lines: off by default (code keeps its shape and scrolls sideways),
 * remembered across launches, shared by every diff on screen.
 * ------------------------------------------------------------------------- */
const DIFF_WRAP_KEY = "kiwi.diffWrap";
const wrapListeners = new Set<() => void>();
function readDiffWrap(): boolean {
  try { return window.localStorage.getItem(DIFF_WRAP_KEY) === "1"; } catch { return false; }
}
let diffWrap: boolean | null = null;
export function getDiffWrap(): boolean {
  diffWrap ??= readDiffWrap();
  return diffWrap;
}
export function setDiffWrap(on: boolean): void {
  diffWrap = on;
  try { window.localStorage.setItem(DIFF_WRAP_KEY, on ? "1" : "0"); } catch { /* private mode: this session only */ }
  wrapListeners.forEach((listener) => listener());
}
export function useDiffWrap(): boolean {
  return useSyncExternalStore(
    (listener) => { wrapListeners.add(listener); return () => { wrapListeners.delete(listener); }; },
    getDiffWrap,
    () => false,
  );
}

/**
 * Opus R6 D6: with several long-line files open, only the first one (in
 * document order) carries the "Wrap lines" button; the others keep the edge
 * fade and the scroll cue, and the Changes toolbar toggle stays the one
 * lasting control.
 */
const overflowBodies = new Set<HTMLElement>();
const overflowListeners = new Set<() => void>();
let firstOverflowBody: HTMLElement | null = null;
function recomputeFirstOverflow(): void {
  let first: HTMLElement | null = null;
  for (const body of overflowBodies) {
    if (!first || (first.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_PRECEDING)) first = body;
  }
  if (first === firstOverflowBody) return;
  firstOverflowBody = first;
  overflowListeners.forEach((listener) => listener());
}
function useFirstOverflowBody(): HTMLElement | null {
  return useSyncExternalStore(
    (listener) => { overflowListeners.add(listener); return () => { overflowListeners.delete(listener); }; },
    () => firstOverflowBody,
    () => null,
  );
}

const ROW_CLASS: Record<DiffRowInfo["kind"], string> = {
  add: "diff-line-add",
  del: "diff-line-del",
  context: "diff-line-context",
  hunk: "diff-line-hunk",
  header: "diff-line-meta",
  note: "diff-line-note",
};

const commentable = (row: DiffRowInfo | undefined) => row?.kind === "add" || row?.kind === "del" || row?.kind === "context";

/** "line 42 added", "old line 17 removed": what a screen reader hears for a row. */
function describeRow(row: DiffRowInfo, text: string): string {
  const where = row.kind === "del" ? `Old line ${row.oldLine}, removed` : row.kind === "add" ? `Line ${row.newLine}, added` : `Line ${row.newLine}, unchanged`;
  const code = text.slice(1).trim();
  return `${where}: ${code.length > 90 ? `${code.slice(0, 88)}…` : code || "blank line"}`;
}

/**
 * A diff body that reveals progressively instead of mounting every line. The
 * full text stays reachable — nothing is truncated away, it is just not in the
 * document until asked for.
 *
 * Each line is one row (a direct child of the `<pre>`, which line feedback
 * relies on): an old/new line-number gutter drawn from data attributes (so
 * numbers are never copied with the code), the +/− sign, and the code with
 * syntax colours. Lines keep their shape and scroll sideways unless wrapping
 * is turned on; wrapped lines hang under their own code, not under the sign.
 */
export function DiffText({ text, initialLines = DIFF_INITIAL_LINES, feedback, scrollLabel, hideFileHeader, path }: {
  text: string;
  initialLines?: number;
  /** Review working-diff files only; lines stay plain spans either way. */
  feedback?: FeedbackDiffSource;
  /** Opt-in keyboard access for a capped, independently scrolling preview. */
  scrollLabel?: string;
  /**
   * One file whose name the row already shows: the `diff --git`/`index`/`---`/
   * `+++` lines are kept in the document (line feedback counts them) but not
   * displayed.
   */
  hideFileHeader?: boolean;
  /** The file this diff belongs to, for its syntax colours when the text has no header. */
  path?: string | null;
}) {
  const feedbackRef = useFeedbackDiffSource(feedback);
  const openRange = useFeedbackRangeOpener();
  const canComment = Boolean(feedbackRef && openRange);
  const wrap = useDiffWrap();
  const lines = useMemo(() => text.split("\n"), [text]);
  const rows = useMemo(() => numberDiffLines(lines), [lines]);
  const digits = useMemo(() => gutterDigits(rows), [rows]);
  const firstHunk = useMemo(() => hideFileHeader ? lines.findIndex((line) => line.startsWith("@@")) : -1, [hideFileHeader, lines]);
  const [visible, setVisible] = useState(() => Math.min(lines.length, initialLines));
  // A new diff replaces the old one during render, so a long expansion of the
  // previous file never carries over into the next one.
  const [renderedText, setRenderedText] = useState(text);
  const [cursor, setCursor] = useState<{ active: number; anchor: number } | null>(null);
  if (renderedText !== text) {
    setRenderedText(text);
    setVisible(Math.min(lines.length, initialLines));
    setCursor(null);
  }
  const tokens = useMemo(() => highlightDiff(lines.slice(0, visible), path), [lines, visible, path]);
  const hidden = lines.length - visible;
  // A text ending in a newline splits into a last empty string: it is not a line.
  const lastLine = lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : -1;

  const preRef = useRef<HTMLPreElement | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const commentRef = useRef<HTMLButtonElement>(null);
  const setPre = useCallback((node: HTMLPreElement | null) => {
    preRef.current = node;
    feedbackRef?.(node);
  }, [feedbackRef]);
  const [focused, setFocused] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  // Long lines (wrap off): an edge fade while more code sits to the right, and
  // a labeled way to see it (Sol R5 B05, Opus I6). Measured, never guessed.
  const [overflow, setOverflow] = useState<{ wide: boolean; atEnd: boolean; height: number }>({ wide: false, atEnd: true, height: 0 });
  useLayoutEffect(() => {
    const pre = preRef.current;
    if (!pre || wrap) { setOverflow((current) => current.wide ? { wide: false, atEnd: true, height: 0 } : current); return; }
    const measure = () => {
      const wide = pre.scrollWidth - pre.clientWidth > 2;
      const atEnd = !wide || pre.scrollLeft + pre.clientWidth >= pre.scrollWidth - 2;
      // The fade covers the code only, not the hint rows under it.
      const height = wide ? pre.clientHeight : 0;
      setOverflow((current) => current.wide === wide && current.atEnd === atEnd && current.height === height ? current : { wide, atEnd, height });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(pre);
    pre.addEventListener("scroll", measure, { passive: true });
    return () => { observer?.disconnect(); pre.removeEventListener("scroll", measure); };
  }, [wrap, visible, text]);
  const [buttonTop, setButtonTop] = useState<number | null>(null);
  const hintId = useId();
  const target = canComment ? (focused && cursor ? cursor.active : hover) : null;

  useLayoutEffect(() => {
    if (target === null) { setButtonTop(null); return; }
    const row = preRef.current?.children[target] as HTMLElement | undefined;
    setButtonTop(row ? row.offsetTop : null);
  }, [target, wrap, visible]);

  const stepFrom = (from: number, direction: 1 | -1): number => {
    for (let index = from + direction; index >= 0 && index < visible; index += direction) {
      if (index !== lastLine && index > firstHunk && commentable(rows[index])) return index;
    }
    return from;
  };
  const firstChange = () => {
    let fallback = -1;
    for (let index = Math.max(0, firstHunk + 1); index < visible; index += 1) {
      if (index === lastLine) continue;
      if (rows[index].kind === "add" || rows[index].kind === "del") return index;
      if (fallback < 0 && commentable(rows[index])) fallback = index;
    }
    return fallback;
  };

  const openFeedback = (from: number, to: number) => {
    const pre = preRef.current;
    if (!pre || !openRange) return;
    const start = pre.children[Math.min(from, to)] as HTMLElement | undefined;
    const end = pre.children[Math.max(from, to)] as HTMLElement | undefined;
    if (!start || !end) return;
    const range = document.createRange();
    range.setStartBefore(start.querySelector(".diff-code") ?? start);
    range.setEndAfter(end.querySelector(".diff-code") ?? end);
    // The note opens under the line, aligned with the diff's visible edge.
    const box = pre.getBoundingClientRect();
    const line = end.getBoundingClientRect();
    openRange(pre, range, { top: line.top, bottom: line.bottom, left: box.left, right: box.right }, focused ? pre : commentRef.current);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLPreElement>) => {
    if (!canComment || event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const start = cursor?.active ?? firstChange();
      if (start < 0) return;
      event.preventDefault();
      const active = cursor ? stepFrom(start, event.key === "ArrowDown" ? 1 : -1) : start;
      setCursor({ active, anchor: event.shiftKey && cursor ? cursor.anchor : active });
      (preRef.current?.children[active] as HTMLElement | undefined)?.scrollIntoView?.({ block: "nearest" });
    } else if (event.key === "Enter" && cursor) {
      event.preventDefault();
      openFeedback(cursor.anchor, cursor.active);
    } else if (event.key === "Escape" && cursor && cursor.anchor !== cursor.active) {
      event.preventDefault();
      setCursor({ active: cursor.active, anchor: cursor.active });
    }
  };

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !overflow.wide) return;
    overflowBodies.add(body);
    recomputeFirstOverflow();
    return () => { overflowBodies.delete(body); recomputeFirstOverflow(); };
  }, [overflow.wide]);
  const firstOverflow = useFirstOverflowBody();
  const leadsOverflow = overflow.wide && (firstOverflow === null || firstOverflow === bodyRef.current);
  // Sol R6 B03: the inline button disappears once lines wrap, so keyboard
  // focus moves to the code that was just wrapped (or, for a diff that isn't
  // focusable, the toolbar's wrap toggle) instead of falling to <body>.
  const wrapFromHint = () => {
    const pre = preRef.current;
    setDiffWrap(true);
    requestAnimationFrame(() => {
      if (pre?.isConnected && pre.tabIndex >= 0) pre.focus({ preventScroll: true });
      else document.querySelector<HTMLButtonElement>(".diff-wrap-toggle:not(:disabled)")?.focus({ preventScroll: true });
    });
  };

  const low = cursor ? Math.min(cursor.active, cursor.anchor) : -1;
  const high = cursor ? Math.max(cursor.active, cursor.anchor) : -1;
  const describedRow = focused && cursor ? rows[cursor.active] : undefined;

  return (
    <div className={`diff-body${canComment ? " can-comment" : ""}${overflow.wide ? " overflows" : ""}${overflow.wide && !overflow.atEnd ? " more-right" : ""}`} ref={bodyRef} onMouseLeave={() => setHover(null)}>
      <pre
        className={`diff-view numbered ${wrap ? "wrap" : "nowrap"}`}
        style={{ "--diff-digits": digits } as CSSProperties}
        ref={setPre}
        data-feedback-diff={feedbackRef ? "" : undefined}
        tabIndex={scrollLabel || canComment ? 0 : undefined}
        role={scrollLabel || canComment ? "region" : undefined}
        aria-label={scrollLabel}
        aria-describedby={canComment ? hintId : undefined}
        onKeyDown={onKeyDown}
        onFocus={(event) => {
          if (event.target !== event.currentTarget) return;
          setFocused(true);
          if (canComment && !cursor) { const first = firstChange(); if (first >= 0) setCursor({ active: first, anchor: first }); }
        }}
        onBlur={(event) => { if (event.relatedTarget !== commentRef.current) setFocused(false); }}
        onMouseMove={canComment ? (event) => {
          const row = (event.target as HTMLElement).closest?.<HTMLElement>("[data-line]");
          const index = row ? Number(row.dataset.line) : null;
          setHover(index !== null && commentable(rows[index]) && index > firstHunk ? index : null);
        } : undefined}
      >
        {lines.slice(0, visible).map((line, index) => {
          if (index < firstHunk) return <span key={index} className="diff-line-file-header">{`${line}\n`}</span>;
          if (index === lastLine) return <span key={index} className="diff-line-end" />;
          const row = rows[index];
          const code = tokens[index];
          const inCursor = focused && index >= low && index <= high;
          return (
            <span key={index} data-line={index} className={`diff-row ${ROW_CLASS[row.kind]}${inCursor ? " cursor" : ""}`}>
              <span className="diff-gutter" aria-hidden="true" data-old={row.oldLine ?? ""} data-new={row.newLine ?? ""} />
              {code
                ? <span className="diff-code"><span className="diff-sign">{line[0]}</span>{renderSyntaxTokens(code, index)}</span>
                : row.kind === "add" || row.kind === "del" || row.kind === "context"
                  ? <span className="diff-code"><span className="diff-sign">{line[0] ?? " "}</span>{line.slice(1)}</span>
                  : <span className="diff-code">{line}</span>}
            </span>
          );
        })}
      </pre>
      {canComment && buttonTop !== null && (
        <button
          ref={commentRef}
          type="button"
          className="diff-line-comment"
          style={{ top: buttonTop }}
          // Keep the reader's place: a pointer press must not move focus first.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (focused && cursor) openFeedback(cursor.anchor, cursor.active);
            else if (hover !== null) openFeedback(hover, hover);
          }}
          aria-label={`Add feedback on ${target !== null ? describeRow(rows[target], lines[target]).split(":")[0].toLowerCase() : "this line"}`}
          title="Add feedback on this line for the agent"
          tabIndex={-1}
        >
          <MessageSquarePlus size={12} aria-hidden="true" />
        </button>
      )}
      {overflow.wide && !overflow.atEnd && <span className="diff-edge-fade" aria-hidden="true" style={{ height: overflow.height }} />}
      {overflow.wide && !(canComment && focused) && (
        <p className={`diff-overflow-hint${leadsOverflow ? "" : " quiet"}`}>
          <span>Long lines{scrollLabel || canComment ? <>: <kbd>←</kbd><kbd>→</kbd> to scroll</> : ": scroll sideways"}</span>
          {leadsOverflow && <button type="button" className="diff-overflow-wrap" onClick={wrapFromHint} title="Wrap long lines in every diff. Remembered; turn off with the wrap button above."><WrapText size={12} aria-hidden="true" /> Wrap lines</button>}
        </p>
      )}
      {canComment && (
        <p className="diff-keyboard-hint" id={hintId} hidden={!focused}>
          <span><kbd>↑</kbd><kbd>↓</kbd> choose a line</span><span aria-hidden="true">·</span><span><kbd>⇧</kbd> extend</span><span aria-hidden="true">·</span><span><kbd>Return</kbd> add feedback</span>
          {overflow.wide && <><span aria-hidden="true">·</span><span><kbd>←</kbd><kbd>→</kbd> scroll sideways</span></>}
        </p>
      )}
      {canComment && <span className="sr-only" aria-live="polite">{describedRow ? describeRow(describedRow, lines[cursor!.active]) : ""}</span>}
      {hidden > 0 && (
        <div className="diff-more">
          <span>Showing {visible.toLocaleString()} of {(lines.length - (lastLine >= 0 ? 1 : 0)).toLocaleString()} lines</span>
          <button onClick={() => setVisible((current) => Math.min(lines.length, current + DIFF_LINE_STEP))}>
            Show {Math.min(hidden, DIFF_LINE_STEP).toLocaleString()} more
          </button>
          {hidden > DIFF_LINE_STEP && <button onClick={() => setVisible(lines.length)}>Show all</button>}
        </div>
      )}
    </div>
  );
}

/** Loads a new (untracked) file's contents for its preview. */
export type NewFileLoader = (path: string) => Promise<{ text: string; binary: boolean; truncated: boolean }>;

/** A new file's contents shown as one added hunk, so it reads like the rest of the diff. */
function asAddedLines(text: string): string {
  if (!text) return "";
  const lines = text.replace(/\n$/, "").split("\n");
  return [`@@ new file · ${lines.length} line${lines.length === 1 ? "" : "s"} @@`, ...lines.map((line) => `+${line}`)].join("\n");
}

/**
 * What a file's row may change from here.
 * - `full`: the uncommitted diff. Stage/Unstage and Discard act on exactly what is shown.
 * - `unstage`: the staged view. Unstage acts on exactly the staged patch shown;
 *   Discard would act on the files on disk, so it is not offered there.
 * - `none`: a comparison (since last push). Its rows mix committed lines with any
 *   current edits, so no Git action is offered: a Stage or Discard here would act on
 *   a different patch from the one shown. Files that also have current edits are
 *   tagged, and are staged or discarded from Uncommitted.
 */
export type DiffFileActions = "full" | "none" | "unstage";

/** The one name and icon for throwing away a file's uncommitted edits, in Files and in Diff. */
export const DISCARD_LABEL = "Discard local changes…";

/**
 * One file in the Changes diff. The disclosure and the file's Git actions are
 * sibling buttons (a button inside a disclosure summary is one semantic
 * control doing two jobs). The body is mounted only while open, and per-file
 * Git actions appear only when the path was recovered unambiguously — running
 * `git add --`/`git restore --` on a guessed path would stage or discard the
 * wrong file.
 */
function DiffFile({ path, displayPath, additions, deletions, isNew, body, open, onToggle, readOnly, readOnlyReason, staged, actions, liveEdits, onPathAction, onUnstage }: {
  path: string | null;
  displayPath: string;
  additions?: number;
  deletions?: number;
  /** An untracked file: no counts until read, and no discard from here. */
  isNew?: boolean;
  body: ReactNode;
  open: boolean;
  onToggle: () => void;
  readOnly: boolean;
  readOnlyReason?: string;
  staged: boolean;
  actions: DiffFileActions;
  /** A comparison row whose file also has uncommitted edits right now. */
  liveEdits?: boolean;
  onPathAction: (action: "stage" | "revert", path: string) => void;
  onUnstage?: (path: string) => void;
}) {
  const bodyId = useId();
  const { name, directory } = splitChangePath(path ?? displayPath);
  const where = directory ? ` in ${directory}` : "";
  const counts = isNew ? "new file" : `${additions ?? 0} lines added, ${deletions ?? 0} removed`;
  const live = actions === "none" && Boolean(liveEdits);
  const state = live ? ", read only here, also has uncommitted edits" : actions === "none" ? ", read only here" : "";
  return (
    <section className={`diff-file${open ? " open" : ""}${isNew ? " new" : ""}${actions === "none" ? " read-only" : ""}`} data-diff-path={path ?? undefined}>
      <div className="diff-file-head">
        <button
          type="button"
          className="diff-file-toggle"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          aria-label={`${name}${where}, ${counts}${state}`}
          title={path ?? displayPath}
          onClick={onToggle}
        >
          <ChevronRight className="diff-file-chevron" size={13} aria-hidden="true" />
          <span className="diff-file-name">{name}</span>
          {(directory || live) && <span className="diff-file-sub">
            {directory && <span className="diff-file-dir">{directory}</span>}
            {live && <em className="diff-file-live" title="This file also has edits that are not committed yet. Switch to Uncommitted to stage or discard them.">Current edits</em>}
          </span>}
        </button>
        <span className="diff-file-stats" aria-hidden="true">
          {isNew ? <em className="new">New</em> : <><em className="added">+{additions ?? 0}</em><em className="removed">−{deletions ?? 0}</em></>}
        </span>
        {path === null ? (
          <span className="diff-file-actions"><em title="Mythra Code could not decode this file's name from the diff header, so per-file Git actions are unavailable for it.">Name unavailable</em></span>
        ) : actions === "none" ? (
          <span className="diff-file-actions" aria-hidden="true"><span className="diff-file-action-slot" /><span className="diff-file-action-slot" /></span>
        ) : (
          <span className="diff-file-actions">
            {/* Staging used to be a one-way door in the UI: files could be
                staged per file and then only un-staged from a terminal, which
                left the staged-commit route a dead end. */}
            {staged && onUnstage ? (
              <button
                type="button"
                className="staged"
                onClick={() => onUnstage(path)}
                disabled={readOnly}
                title={readOnly ? readOnlyReason : `Unstage ${path} — the edits stay, they just leave the next commit`}
                aria-label={`Unstage ${path}`}
              >
                <Minus size={13} aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onPathAction("stage", path)}
                disabled={readOnly}
                title={readOnly ? readOnlyReason : `Stage ${path}`}
                aria-label={`Stage ${path}`}
              >
                <Plus size={13} aria-hidden="true" />
              </button>
            )}
            {isNew || actions === "unstage" ? <span className="diff-file-action-slot" aria-hidden="true" /> : (
              <button
                type="button"
                className="danger-action"
                onClick={() => onPathAction("revert", path)}
                disabled={readOnly}
                title={readOnly ? readOnlyReason : `${DISCARD_LABEL} Throws away the uncommitted edits to ${path}. Asks first.`}
                aria-label={`Discard local changes to ${path}…`}
              >
                <Undo2 size={12} aria-hidden="true" />
              </button>
            )}
          </span>
        )}
      </div>
      {open && <div className="diff-file-body" id={bodyId}>{body}</div>}
    </section>
  );
}

/** A new file's preview, read when first opened. */
function NewFileBody({ path, load }: { path: string; load?: NewFileLoader }) {
  const [state, setState] = useState<{ text?: string; binary?: boolean; truncated?: boolean; error?: string; loading: boolean }>({ loading: Boolean(load) });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!load) return;
    let live = true;
    setState({ loading: true });
    load(path).then(
      (result) => { if (live) setState({ loading: false, text: result.text, binary: result.binary, truncated: result.truncated }); },
      (reason) => { if (live) setState({ loading: false, error: reason instanceof Error ? reason.message : String(reason) }); },
    );
    return () => { live = false; };
  }, [load, path, attempt]);
  if (!load) return <p className="diff-file-note">New file. Select it under Files to see its contents.</p>;
  if (state.loading) return <p className="diff-file-note" role="status"><LoaderCircle className="spin" size={12} aria-hidden="true" /> Reading the new file…</p>;
  if (state.error) return (
    <div className="diff-file-note bad" role="alert">
      <span><strong>Couldn&rsquo;t read this new file.</strong> {state.error}</span>
      <button type="button" className="thread-pr-inline-button" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
    </div>
  );
  if (state.binary) return <p className="diff-file-note">Binary file — no text preview.</p>;
  if (!state.text) return <p className="diff-file-note">Empty file.</p>;
  return <>
    {state.truncated && <p className="diff-file-note warn" role="status"><strong>Partial preview:</strong> only the first 512 KiB is shown. Git stages and commits the whole file.</p>}
    <DiffText text={asAddedLines(state.text)} initialLines={300} path={path} scrollLabel={`New file contents for ${path}`} />
  </>;
}

export function DiffFileSections({ sections, readOnly, readOnlyReason, stagedPaths, feedbackDiff, onPathAction, onUnstage, newFiles, loadNewFile, selectedPath, onSelectPath, livePaths, focusRequest, fileActions }: {
  sections: DiffSection[];
  readOnly: boolean;
  readOnlyReason?: string;
  /** The working diff these sections came from. Enables line feedback; omit for history. */
  feedbackDiff?: Pick<ReviewDiff, "baseline" | "source">;
  /** Repository-relative paths currently in the index. Optional: without it
   *  every file simply offers Stage, exactly as before. */
  stagedPaths?: string[];
  onPathAction: (action: "stage" | "revert", path: string) => void;
  onUnstage?: (path: string) => void;
  /** Untracked files, listed after the diff with a preview of their contents. */
  newFiles?: string[];
  loadNewFile?: NewFileLoader;
  /** The file chosen elsewhere (Files, the transcript): opened and scrolled to. */
  selectedPath?: string | null;
  /** The person opened (or closed) a file here. */
  onSelectPath?: (path: string | null) => void;
  /**
   * Set when these sections are a *comparison* (since last push) rather than
   * the uncommitted diff: every row is read only, and files that also have
   * uncommitted edits are marked "Current edits".
   */
  livePaths?: ReadonlySet<string> | null;
  /** Move keyboard focus to one file's heading, once per nonce (a link from the conversation). */
  focusRequest?: { path: string; nonce: number } | null;
  /** What each row may change; defaults to read only for a comparison, else full. */
  fileActions?: DiffFileActions;
}) {
  const staged = useMemo(() => new Set(stagedPaths ?? []), [stagedPaths]);
  const rows = useMemo(() => [
    ...sections.map((section, index) => ({ key: `${section.path ?? section.displayPath}:${index}`, path: section.path, section })),
    ...(newFiles ?? []).filter((path) => !sections.some((section) => section.path === path))
      .map((path) => ({ key: `new:${path}`, path, section: null as DiffSection | null })),
  ], [newFiles, sections]);
  // The first file opens by default so the panel shows a diff, not a list of
  // closed rows. A file chosen elsewhere opens instead.
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => {
    const chosen = selectedPath ? rows.find((row) => row.path === selectedPath) : undefined;
    return new Set(chosen ? [chosen.key] : rows[0] ? [rows[0].key] : []);
  });
  const touched = useRef(false);
  // A different set of files (another comparison, a refreshed diff) starts
  // fresh: nothing chosen before applies to it.
  const rowSignature = rows.map((row) => row.key).join("\u0000");
  const [seenSignature, setSeenSignature] = useState(rowSignature);
  if (seenSignature !== rowSignature) {
    setSeenSignature(rowSignature);
    if (![...openKeys].some((key) => rows.some((row) => row.key === key))) touched.current = false;
  }
  // A diff that arrives after the panel opened still opens its first file.
  if (!touched.current && rows[0] && ![...openKeys].some((key) => rows.some((row) => row.key === key))) {
    const chosen = selectedPath ? rows.find((row) => row.path === selectedPath) : undefined;
    setOpenKeys(new Set([(chosen ?? rows[0]).key]));
  }
  const rootRef = useRef<HTMLDivElement>(null);
  const [handledSelection, setHandledSelection] = useState<string | null | undefined>(undefined);
  if (selectedPath !== handledSelection) {
    setHandledSelection(selectedPath);
    const chosen = selectedPath ? rows.find((row) => row.path === selectedPath) : undefined;
    if (chosen && !openKeys.has(chosen.key)) setOpenKeys(new Set([...openKeys, chosen.key]));
  }
  useEffect(() => {
    if (!selectedPath) return;
    const node = rootRef.current?.querySelector<HTMLElement>(`[data-diff-path="${CSS.escape(selectedPath)}"]`);
    node?.scrollIntoView?.({ block: "nearest" });
  }, [selectedPath]);
  // A link from the conversation lands keyboard focus on the file's heading,
  // once the diff that holds it has arrived.
  const handledFocus = useRef(0);
  useEffect(() => {
    if (!focusRequest || focusRequest.nonce <= handledFocus.current) return;
    const chosen = rows.find((row) => row.path === focusRequest.path);
    if (!chosen) return;
    if (!openKeys.has(chosen.key)) { setOpenKeys(new Set([...openKeys, chosen.key])); return; }
    const heading = rootRef.current?.querySelector<HTMLElement>(`[data-diff-path="${CSS.escape(focusRequest.path)}"] .diff-file-toggle`);
    if (!heading) return;
    handledFocus.current = focusRequest.nonce;
    heading.scrollIntoView?.({ block: "start" });
    heading.focus({ preventScroll: true });
  }, [focusRequest, rows, openKeys]);
  const toggle = (key: string, path: string | null) => {
    touched.current = true;
    const next = new Set(openKeys);
    const opening = !next.has(key);
    if (opening) next.add(key); else next.delete(key);
    setOpenKeys(next);
    if (path && onSelectPath) {
      if (opening) onSelectPath(path);
      else if (selectedPath === path) onSelectPath(null);
    }
  };
  return (
    <div className="diff-file-sections" ref={rootRef}>
      {rows.map(({ key, path, section }) => (
        <DiffFile
          key={key}
          path={path}
          displayPath={section?.displayPath ?? path ?? ""}
          additions={section?.additions}
          deletions={section?.deletions}
          isNew={!section}
          open={openKeys.has(key)}
          onToggle={() => toggle(key, path)}
          body={section
            ? <DiffText text={section.text} hideFileHeader path={section.path ?? section.displayPath} scrollLabel={`Diff of ${section.path ?? section.displayPath}`} feedback={feedbackDiff && section.path ? { section, diff: feedbackDiff } : undefined} />
            : <NewFileBody path={path!} load={loadNewFile} />}
          readOnly={readOnly}
          readOnlyReason={readOnlyReason}
          staged={!!path && staged.has(path)}
          actions={fileActions ?? (livePaths ? "none" : "full")}
          liveEdits={Boolean(livePaths && path && livePaths.has(path))}
          onPathAction={onPathAction}
          onUnstage={onUnstage}
        />
      ))}
    </div>
  );
}
