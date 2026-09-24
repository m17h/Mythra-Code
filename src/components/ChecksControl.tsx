import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, CircleCheck, CircleSlash, CircleX, ListChecks, LoaderCircle, MessageSquarePlus, Sparkles, Square, TriangleAlert, X } from "lucide-react";
import { MAX_CHECK_COMMAND_LENGTH, type ProjectCheckResult } from "../lib/projectChecks";
import type { RunDiscoveryCatalogs } from "../lib/runDiscovery";
import RunCommandDiscovery, { useDiscoveryPreferences, type CommandDiscoveryState } from "./RunCommandDiscovery";
import { FeedbackFloat, toFeedbackRect, useFloatDismiss, type FeedbackRect } from "./FeedbackNoteCard";
import "./ChecksControl.css";

/** Matches the collapse transition in ChecksControl.css. */
const REVEAL_EXIT_MS = 260;

/** Height-and-fade reveal that keeps its content mounted and inert while it closes. */
function Reveal({ open, className, children }: { open: boolean; className: string; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) { setMounted(true); return; }
    const timer = window.setTimeout(() => setMounted(false), REVEAL_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open]);
  if (!open && !mounted) return null;
  return (
    <div className={`checks-reveal ${className}`} data-open={open || undefined} aria-hidden={!open || undefined} inert={!open || undefined}>
      <div className="checks-reveal-clip">{children}</div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function formatAge(ms: number): string {
  if (ms < 45_000) return "just now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function resultHeading(result: ProjectCheckResult): { icon: ReactNode; title: string } {
  if (result.status === "passed") return { icon: <CircleCheck size={14} aria-hidden="true" />, title: "Checks passed" };
  if (result.status === "failed") return { icon: <CircleX size={14} aria-hidden="true" />, title: `Checks failed${result.exitCode === null ? "" : ` · exit ${result.exitCode}`}` };
  if (result.status === "cancelled") return { icon: <CircleSlash size={14} aria-hidden="true" />, title: "Checks stopped" };
  return { icon: <TriangleAlert size={14} aria-hidden="true" />, title: "Checks couldn’t run" };
}

/** What the compact discovery card shows while the popover is closed. */
type DiscoveryCard =
  | { kind: "finding"; summary: string }
  | { kind: "found"; command: string; explanation: string; warning?: string }
  | { kind: "none"; explanation: string }
  | { kind: "error"; error: string };

/**
 * Run checks, beside AI review. One saved command per project, run only on an
 * explicit click, with a bounded result. With no command, the main button
 * finds one (an invisible worker using the shared discovery model) and saves
 * it without running it. The caret opens a popover to edit the command by
 * hand or change the discovery model. "Ask agent to fix" stages the failure
 * as feedback in the composer; it never sends anything by itself.
 */
export function ChecksControl({
  command, running, runningCommand, startedAt, result, stagedResultId, disabledReason,
  discovery, discoveryCatalogs, onDiscoveryAccounts,
  onRun, onStop, onSave, onDiscovered, onAddFeedback,
}: {
  command?: string;
  running: boolean;
  /** Captured command for the live process, even if the saved recipe changes. */
  runningCommand?: string;
  /** Captured launch time so reopening Review does not restart the timer. */
  startedAt?: number | null;
  result: ProjectCheckResult | null;
  /** Result currently present in the composer's feedback tray. */
  stagedResultId?: string | null;
  /** Why checks cannot run right now (no project, no thread…). Stop stays available. */
  disabledReason?: string;
  /** `useCheckCommandDiscovery(projectPath, lmStudioBaseUrl)`. Omit to offer only manual setup. */
  discovery?: CommandDiscoveryState;
  discoveryCatalogs?: RunDiscoveryCatalogs;
  onDiscoveryAccounts?: () => void;
  onRun: () => void;
  onStop: () => void;
  /** Saves the project's check command; an empty string clears it. */
  onSave: (command: string) => void;
  /**
   * Saves a discovered command. Captured when discovery starts, so bind it to
   * that project: the worker can finish after the user switches projects.
   * Defaults to `onSave`.
   */
  onDiscovered?: (command: string) => void;
  /** Stage a failed check or run error as a feedback note. Return false if refused. */
  onAddFeedback: (result: ProjectCheckResult) => boolean | void;
}) {
  const saved = command?.trim() ?? "";
  const formId = useId();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorRect, setEditorRect] = useState<FeedbackRect | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [draft, setDraft] = useState(saved);
  const [outputOpen, setOutputOpen] = useState(false);
  const [refusedId, setRefusedId] = useState<string | null>(null);
  const [dismissedError, setDismissedError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const dismissedAtRef = useRef(0);
  const prefs = useDiscoveryPreferences(discoveryCatalogs);

  // The last result stays on screen while the card closes, and a new result
  // starts with its output folded.
  const [shown, setShown] = useState(result);
  if (result && result !== shown) {
    setShown(result);
    setOutputOpen(false);
  }

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  useEffect(() => {
    if (running || !result) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [running, result]);

  useEffect(() => {
    if (!editorOpen) return;
    setDraft(saved);
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  }, [editorOpen, saved]);

  const openEditor = (opener: HTMLElement | null) => {
    const split = splitRef.current;
    if (!split) return;
    openerRef.current = opener;
    setEditorRect(toFeedbackRect(split.getBoundingClientRect()));
    // The Review action row restyles every descendant button, so the popover
    // (with its model menus) mounts beside it, still inside the themed dock.
    setPortalTarget(split.closest<HTMLElement>(".studio-panel") ?? split.closest<HTMLElement>(".app-shell"));
    setEditorOpen(true);
  };
  const closeEditor = (refocus = true) => {
    setEditorOpen(false);
    dismissedAtRef.current = performance.now();
    if (refocus) (openerRef.current ?? triggerRef.current)?.focus({ preventScroll: true });
  };
  const toggleEditor = (opener: HTMLElement) => {
    // A pointerdown outside already closed it; this click must not reopen it.
    if (performance.now() - dismissedAtRef.current < 250) return;
    if (editorOpen) closeEditor();
    else openEditor(opener);
  };
  useFloatDismiss(editorOpen, popoverRef, (reason) => {
    if (reason === "escape") closeEditor();
    else if (draft.trim() === saved) closeEditor(false);
  });
  const save = (value: string) => {
    onSave(value.trim());
    discovery?.clearSuggestion();
    closeEditor();
  };

  const findChecks = () => {
    if (!discovery || discovery.pending) return;
    // A missing or unavailable model is explained next to its settings.
    if (prefs.blockedReason) { openEditor(triggerRef.current); return; }
    setDismissedError("");
    const saveFound = onDiscovered ?? onSave;
    void discovery.discover({ ...prefs.preferences, effort: prefs.effort }, (found) => {
      const next = found.command.trim();
      if (next) saveFound(next);
    });
  };

  // Saving a command never needs a thread; only running it can be blocked.
  const blocked = Boolean(disabledReason) && !running && Boolean(saved);
  const finding = Boolean(discovery?.pending);
  const state = running ? "running" : saved ? "ready" : finding ? "finding" : discovery ? "discover" : "unset";
  const label = running ? "Stop checks" : saved ? "Run checks" : finding ? "Finding checks…" : discovery ? "Find checks" : "Set up checks";
  const activeCommand = runningCommand || saved;
  const title = running
    ? `Stop ${activeCommand}`
    : saved ? disabledReason || `Run ${saved}`
      : finding ? `Finding this project’s check command with ${prefs.summary}`
        : discovery ? `Find and save this project’s check command with ${prefs.summary}. Nothing runs until you press Run checks.`
          : "Save a check command for this project, like npm test";

  const heading = shown ? resultHeading(shown) : null;
  const staged = shown !== null && stagedResultId === shown.id;
  const actionable = shown?.status === "failed" || shown?.status === "error";
  const cardOpen = running || Boolean(result);

  // Compact discovery status, only while the popover (which shows its own) is closed.
  const suggestion = discovery?.suggestion ?? null;
  // Any new attempt (here or in the popover) makes a later error visible again.
  if (discovery?.pending && dismissedError) setDismissedError("");
  const visibleError = discovery?.error && discovery.error !== dismissedError ? discovery.error : "";
  const currentCard: DiscoveryCard | null = !discovery ? null
    : discovery.pending ? { kind: "finding", summary: prefs.summary }
      : visibleError ? { kind: "error", error: visibleError }
        : suggestion && !suggestion.command.trim() ? { kind: "none", explanation: suggestion.explanation }
          : suggestion && !running && !result ? { kind: "found", command: suggestion.command.trim(), explanation: suggestion.explanation, warning: suggestion.warning }
            : null;
  const [card, setCard] = useState<DiscoveryCard | null>(currentCard);
  if (currentCard && JSON.stringify(currentCard) !== JSON.stringify(card)) setCard(currentCard);
  const discoveryCardOpen = Boolean(currentCard) && !editorOpen;
  const dismissCard = () => {
    if (card?.kind === "error") setDismissedError(card.error);
    else discovery?.clearSuggestion();
  };

  const dismissButton = (
    <button type="button" className="checks-dismiss" onClick={dismissCard} aria-label="Dismiss"><X size={11} aria-hidden="true" /></button>
  );

  const editor = (
    <FeedbackFloat open={editorOpen && !running} rect={editorRect} placement="below" align="end" className="checks-popover-float" role="dialog" label="Check command">
      <div className="checks-popover" ref={popoverRef}>
        <div className="project-prompt-heading">
          <span className="project-prompt-icon"><ListChecks size={15} aria-hidden="true" /></span>
          <div>
            <strong>Run checks</strong>
            <small>Saved for this project. Runs only when you press Run checks.</small>
          </div>
        </div>
        <form
          id={formId}
          className="checks-editor"
          onSubmit={(event) => { event.preventDefault(); if (draft.trim() && draft.trim() !== saved) save(draft); }}
        >
          <label>
            <span>Check command</span>
            <input
              ref={inputRef}
              value={draft}
              maxLength={MAX_CHECK_COMMAND_LENGTH}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="npm test"
              aria-label="Check command"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
        </form>
        {discovery && (
          <RunCommandDiscovery
            purpose="checks"
            discovery={discovery}
            catalogs={discoveryCatalogs}
            onAccounts={onDiscoveryAccounts}
            onFound={({ command: found }) => (onDiscovered ?? onSave)(found.trim())}
          />
        )}
        <div className="project-prompt-actions">
          {saved && <button type="button" className="secondary-button project-run-clear" onClick={() => save("")}>Clear</button>}
          <button type="button" className="secondary-button" onClick={() => closeEditor()}>Cancel</button>
          <button type="submit" form={formId} className="primary-button" disabled={!draft.trim() || draft.trim() === saved}>Save</button>
        </div>
      </div>
    </FeedbackFloat>
  );

  return (
    <div className="checks-control">
      <div className={`checks-split ${state}`} ref={splitRef}>
        <button
          ref={triggerRef}
          type="button"
          className="checks-run"
          disabled={blocked}
          title={title}
          aria-busy={finding && !saved && !running ? true : undefined}
          onClick={(event) => {
            if (running) onStop();
            else if (saved) { discovery?.clearSuggestion(); onRun(); }
            else if (finding) return;
            else if (discovery) findChecks();
            else toggleEditor(event.currentTarget);
          }}
        >
          {running ? <Square size={10} aria-hidden="true" />
            : saved ? <ListChecks size={13} aria-hidden="true" />
              : finding ? <LoaderCircle size={13} className="spin" aria-hidden="true" />
                : discovery ? <Sparkles size={13} aria-hidden="true" />
                  : <ListChecks size={13} aria-hidden="true" />}
          {label}
        </button>
        {(saved || discovery) && (
          <button
            type="button"
            className="checks-edit"
            disabled={running}
            onClick={(event) => toggleEditor(event.currentTarget)}
            aria-label="Edit check command"
            aria-haspopup="dialog"
            aria-expanded={editorOpen}
            title="Edit the check command or the discovery model"
          >
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        )}
      </div>

      {portalTarget ? createPortal(editor, portalTarget) : editor}

      <Reveal open={discoveryCardOpen} className="checks-discovery-reveal">
        {card?.kind === "finding" ? (
          <div className="checks-card discovering">
            <div className="checks-card-head">
              <LoaderCircle size={14} className="spin" aria-hidden="true" />
              <strong role="status">Finding checks</strong>
              <small title={card.summary}>{card.summary}</small>
            </div>
            <div className="checks-card-actions">
              <button type="button" onClick={() => void discovery?.cancel()}>Stop</button>
            </div>
          </div>
        ) : card?.kind === "found" ? (
          <div className="checks-card found">
            <div className="checks-card-head">
              <CircleCheck size={14} aria-hidden="true" />
              <strong role="status">Check command saved</strong>
              {dismissButton}
            </div>
            <code className="checks-command" title={card.command}>{card.command}</code>
            {card.explanation && <p className="checks-note">{card.explanation}</p>}
            {card.warning && <p className="checks-error">{card.warning}</p>}
            <small className="checks-hint">Nothing ran yet. Press Run checks to try it.</small>
          </div>
        ) : card?.kind === "none" ? (
          <div className="checks-card none">
            <div className="checks-card-head">
              <CircleSlash size={14} aria-hidden="true" />
              <strong role="status">No check command found</strong>
              {dismissButton}
            </div>
            {card.explanation && <p className="checks-note">{card.explanation}</p>}
            <div className="checks-card-actions">
              <button type="button" onClick={() => openEditor(triggerRef.current)}>Set one manually</button>
            </div>
          </div>
        ) : card?.kind === "error" ? (
          <div className="checks-card error">
            <div className="checks-card-head">
              <TriangleAlert size={14} aria-hidden="true" />
              <strong role="status">Couldn’t find checks</strong>
              {dismissButton}
            </div>
            <p className="checks-error">{card.error}</p>
            <div className="checks-card-actions">
              <button type="button" onClick={findChecks}>Try again</button>
              <button type="button" onClick={() => openEditor(triggerRef.current)}>Settings</button>
            </div>
          </div>
        ) : null}
      </Reveal>

      <Reveal open={cardOpen} className="checks-result-reveal">
        {running ? (
          <div className="checks-card running">
            <div className="checks-card-head">
              <LoaderCircle size={14} className="spin" aria-hidden="true" />
              {/* Only the stable heading is live; the ticking timer is not. */}
              <strong role="status">Running checks</strong>
              <small>{startedAt == null ? "" : formatDuration(now - startedAt)}</small>
            </div>
            <code className="checks-command" title={activeCommand}>{activeCommand}</code>
          </div>
        ) : shown && heading ? (
          <div className={`checks-card ${shown.status}`}>
            <div className="checks-card-head" title={`${shown.command}\n${shown.cwd}${shown.head ? `\nHEAD ${shown.head.slice(0, 12)}` : ""}`}>
              {heading.icon}
              <strong role="status">{heading.title}</strong>
              <small>Last run · {formatDuration(shown.finishedAt - shown.startedAt)} · {formatAge(now - shown.finishedAt)}</small>
            </div>
            {shown.error && <p className="checks-error">{shown.error}</p>}
            {(shown.output || actionable) && (
              <div className="checks-card-actions">
                {shown.output && (
                  <button type="button" className="checks-output-toggle" aria-expanded={outputOpen} onClick={() => setOutputOpen((open) => !open)}>
                    <ChevronDown size={11} aria-hidden="true" /> Output
                  </button>
                )}
                {actionable && (
                  <button
                    type="button"
                    className={`checks-fix ${staged ? "staged" : ""}`}
                    disabled={staged}
                    title={staged ? "Added to feedback in the composer" : "Add this check problem to the feedback in your composer. Nothing is sent until you press Send."}
                    onClick={() => {
                      const accepted = onAddFeedback(shown) !== false;
                      setRefusedId(accepted ? null : shown.id);
                    }}
                  >
                    {staged ? <Check size={12} aria-hidden="true" /> : <MessageSquarePlus size={12} aria-hidden="true" />}
                    {staged ? "Added to feedback" : "Ask agent to fix"}
                  </button>
                )}
              </div>
            )}
            {refusedId === shown.id && <p className="checks-error">Couldn’t add feedback. Try again, or send or remove a note if the tray is full.</p>}
            {shown.output && (
              <Reveal open={outputOpen} className="checks-output-reveal">
                <pre className="checks-output" tabIndex={0} aria-label="Check output">
                  {shown.outputTruncated && <span className="checks-output-note">Bounded output excerpt; some lines were omitted{"\n"}</span>}
                  {shown.output}
                </pre>
              </Reveal>
            )}
          </div>
        ) : null}
      </Reveal>
    </div>
  );
}
