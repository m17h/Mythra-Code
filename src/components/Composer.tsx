import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowUp, CircleStop, CornerUpRight, FileCode2, ListPlus, LoaderCircle, Paperclip, RotateCw, Sparkles, Trash2, X } from "lucide-react";
import { loadStored, storeValue } from "../lib/storage";
import type { QueuedTurn } from "../lib/taskStore";
import type { AttachmentRecord } from "./StudioDock";

export interface ComposerHandle {
  setDraft: (text: string) => void;
  focus: () => void;
}

/**
 * Per-thread draft persistence. Drafts live outside React state so switching
 * threads never loses a half-written message; writes are debounced and the
 * map is capped so it cannot grow without bound.
 */
const DRAFTS_KEY = "kiwi.drafts";
const MAX_DRAFTS = 100;
let draftsCache: Record<string, string> | null = null;
let draftSaveTimer: number | null = null;

function drafts(): Record<string, string> {
  if (draftsCache === null) draftsCache = loadStored<Record<string, string>>(DRAFTS_KEY, {});
  return draftsCache;
}

export function draftFor(key: string): string {
  return drafts()[key] ?? "";
}

function persistDraft(key: string, text: string): void {
  const all = drafts();
  if (text) all[key] = text;
  else delete all[key];
  const keys = Object.keys(all);
  for (let index = 0; keys.length - index > MAX_DRAFTS; index += 1) delete all[keys[index]];
  if (draftSaveTimer !== null) window.clearTimeout(draftSaveTimer);
  draftSaveTimer = window.setTimeout(() => {
    draftSaveTimer = null;
    storeValue(DRAFTS_KEY, drafts());
  }, 400);
}

export function discardDraft(key: string): void {
  persistDraft(key, "");
}

export function resetDraftStoreForTests(): void {
  draftsCache = null;
  if (draftSaveTimer !== null) window.clearTimeout(draftSaveTimer);
  draftSaveTimer = null;
}

// A mention only starts a word. Without that anchor a bare `@` typed inside an
// email address opens the skill launcher, and the next Enter would insert a
// skill instead of sending the message.
const MENTION_PATTERN = /(^|\s)@([\w./-]*)$/;
const SKILL_TOKEN_PATTERN = /(^|\s)@([a-z0-9][a-z0-9-]*)/gi;

export interface ComposerSkill {
  name: string;
  description?: string;
}

type MentionResult =
  | { kind: "skill"; value: string; label: string; detail?: string }
  | { kind: "file"; value: string; label: string; detail?: undefined };

export const COMPOSER_INPUT_MIN_HEIGHT = 68;
export const COMPOSER_INPUT_MAX_HEIGHT = COMPOSER_INPUT_MIN_HEIGHT * 2;

export function resizeComposerTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  const contentHeight = textarea.scrollHeight;
  const height = Math.min(
    COMPOSER_INPUT_MAX_HEIGHT,
    Math.max(COMPOSER_INPUT_MIN_HEIGHT, contentHeight),
  );
  textarea.style.height = `${height}px`;
  textarea.style.overflowY = contentHeight > COMPOSER_INPUT_MAX_HEIGHT ? "auto" : "hidden";
}

export const Composer = forwardRef<ComposerHandle, {
  threadKey: string;
  running: boolean;
  /**
   * Children spawned by this thread are still live even though its own turn is
   * not. Stop stays offered so the crew can always be cut off from one place.
   */
  childrenRunning?: boolean;
  /**
   * True only when a started thread is running, which is the one case where a
   * plain send queues a follow-up and Steer can reach an active turn. A draft
   * thread whose first turn is still starting is `running` but not `queueing`:
   * there is no turn to steer and nothing to queue behind yet.
   */
  queueing: boolean;
  /** Queue remains available while this is false, but no message may be
   * inserted into the active turn while its user-facing response is active. */
  canSteer: boolean;
  dropActive: boolean;
  placeholder: string;
  attachments: AttachmentRecord[];
  queuedTurns?: QueuedTurn[];
  modelControls?: ReactNode;
  controls: ReactNode;
  searchFiles?: (query: string) => Promise<string[]>;
  skills?: ComposerSkill[];
  onRemoveAttachment: (path: string) => void;
  onPasteImages: (items: DataTransferItemList) => void;
  onSend: (text: string) => Promise<boolean>;
  onSteer: (text: string) => Promise<boolean>;
  onSteerQueued?: (queuedTurnId: string) => void;
  onRetryQueued?: (queuedTurnId: string) => void;
  onRemoveQueued?: (queuedTurnId: string) => void;
  onStop: () => void;
}>(function Composer(props, ref) {
  const [draft, setDraftState] = useState(() => draftFor(props.threadKey));
  const [mentions, setMentions] = useState<{ open: boolean; results: MentionResult[]; index: number }>({ open: false, results: [], index: 0 });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const threadKeyRef = useRef(props.threadKey);
  const mentionRequestRef = useRef(0);
  const mentionTimerRef = useRef<number | null>(null);
  const searchFilesRef = useRef(props.searchFiles);
  searchFilesRef.current = props.searchFiles;
  const skillsRef = useRef(props.skills ?? []);
  skillsRef.current = props.skills ?? [];
  const mentionMenuId = useId();

  useEffect(() => () => {
    if (mentionTimerRef.current !== null) window.clearTimeout(mentionTimerRef.current);
  }, []);

  useLayoutEffect(() => {
    if (textareaRef.current) resizeComposerTextarea(textareaRef.current);
  }, [draft, props.threadKey]);

  const setDraft = useCallback((text: string) => {
    setDraftState(text);
    persistDraft(threadKeyRef.current, text);
  }, []);

  // Thread switch: save-on-change already persisted the old draft; load the
  // new one during render so the previous thread's draft never flashes.
  const [renderedThreadKey, setRenderedThreadKey] = useState(props.threadKey);
  if (renderedThreadKey !== props.threadKey) {
    setRenderedThreadKey(props.threadKey);
    threadKeyRef.current = props.threadKey;
    setDraftState(draftFor(props.threadKey));
    setMentions({ open: false, results: [], index: 0 });
  }

  useImperativeHandle(ref, () => ({
    setDraft: (text: string) => {
      setDraft(text);
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    focus: () => textareaRef.current?.focus(),
  }), [setDraft]);

  // Dismissing also abandons the file lookup already in flight. Without that,
  // the debounced search from the last keystroke resolves a moment later and
  // re-opens a menu the user just escaped, or that accepting a skill closed.
  const closeMentions = useCallback(() => {
    mentionRequestRef.current += 1;
    if (mentionTimerRef.current !== null) {
      window.clearTimeout(mentionTimerRef.current);
      mentionTimerRef.current = null;
    }
    setMentions({ open: false, results: [], index: 0 });
  }, []);

  const updateMentions = useCallback((text: string, caret: number) => {
    const match = MENTION_PATTERN.exec(text.slice(0, caret));
    if (!match) {
      closeMentions();
      return;
    }
    const query = match[2];
    const normalizedQuery = query.toLowerCase();
    const skillResults: MentionResult[] = skillsRef.current
      .filter((skill) => !normalizedQuery
        || skill.name.toLowerCase().includes(normalizedQuery)
        || skill.description?.toLowerCase().includes(normalizedQuery))
      .sort((left, right) => {
        const leftStarts = left.name.toLowerCase().startsWith(normalizedQuery);
        const rightStarts = right.name.toLowerCase().startsWith(normalizedQuery);
        return Number(rightStarts) - Number(leftStarts) || left.name.localeCompare(right.name);
      })
      .slice(0, 8)
      .map((skill) => ({ kind: "skill", value: skill.name, label: skill.name, detail: skill.description }));
    const requestId = ++mentionRequestRef.current;
    if (mentionTimerRef.current !== null) window.clearTimeout(mentionTimerRef.current);
    setMentions({ open: skillResults.length > 0, results: skillResults, index: 0 });
    // An empty @ is the skill launcher. File lookup remains available once the
    // user starts typing, preserving the existing @file workflow.
    if (!query.trim() || !searchFilesRef.current) return;
    mentionTimerRef.current = window.setTimeout(() => {
      mentionTimerRef.current = null;
      if (mentionRequestRef.current !== requestId) return;
      searchFilesRef.current?.(query)
        .then((results) => {
          if (mentionRequestRef.current !== requestId) return;
          const fileResults: MentionResult[] = results.slice(0, 8).map((path) => ({ kind: "file", value: path, label: path }));
          const combined = [...skillResults, ...fileResults].slice(0, 12);
          setMentions({ open: combined.length > 0, results: combined, index: 0 });
        })
        // A failed lookup falls back to the skills alone — unless this query was
        // superseded or dismissed, in which case it must stay closed.
        .catch(() => {
          if (mentionRequestRef.current !== requestId) return;
          setMentions({ open: skillResults.length > 0, results: skillResults, index: 0 });
        });
    }, 150);
  }, [closeMentions]);

  const insertMention = useCallback((result: MentionResult) => {
    const textarea = textareaRef.current;
    const caret = textarea?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret).replace(MENTION_PATTERN, (_match, lead: string) => `${lead}@${result.value} `);
    const next = `${before}${draft.slice(caret)}`;
    setDraft(next);
    closeMentions();
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(before.length, before.length);
    });
  }, [closeMentions, draft, setDraft]);

  // Blue @skill tokens are painted by a mirror layer behind a transparent
  // textarea, so this runs on every keystroke: only recompute when the text or
  // the installed skills actually change.
  const skills = props.skills;
  const { highlightedDraft, hasSkillMentions } = useMemo(() => {
    const skillNames = new Set((skills ?? []).map((skill) => skill.name.toLowerCase()));
    const parts: ReactNode[] = [];
    let offset = 0;
    if (skillNames.size) {
      for (const match of draft.matchAll(SKILL_TOKEN_PATTERN)) {
        const index = (match.index ?? 0) + match[1].length;
        const token = `@${match[2]}`;
        if (!skillNames.has(match[2].toLowerCase())) continue;
        parts.push(draft.slice(offset, index));
        parts.push(<span className="composer-skill-token" key={`${index}:${token}`}>{token}</span>);
        offset = index + token.length;
      }
    }
    parts.push(draft.slice(offset));
    return { highlightedDraft: parts, hasSkillMentions: offset > 0 };
  }, [draft, skills]);

  const send = useCallback(async (mode: "default" | "steer" = "default") => {
    const text = draft.trim();
    // The very first thread/start has not returned an id yet, so there is no
    // durable queue to attach a second message to. Keep the draft in place
    // until that short startup window closes instead of starting a second
    // independent thread.
    if (!text || (props.running && !props.queueing)) return;
    // Capture the sending thread's key: the user may switch threads while the
    // RPC is in flight, and a failed send must restore into the ORIGINAL
    // thread's draft, not whichever thread is now visible.
    const sentFromKey = threadKeyRef.current;
    closeMentions();
    setDraft("");
    const delivered = await (mode === "steer" ? props.onSteer(text) : props.onSend(text));
    if (!delivered) {
      if (threadKeyRef.current === sentFromKey) {
        // Still on the same thread — restore the failed text ahead of anything
        // the user typed while the send was in flight, so neither is lost.
        setDraftState((current) => {
          const restored = current && current !== text ? `${text}\n\n${current}` : text;
          persistDraft(sentFromKey, restored);
          return restored;
        });
      } else {
        // Restore silently into the original thread's persisted draft,
        // keeping any draft written there since.
        const existing = draftFor(sentFromKey);
        persistDraft(sentFromKey, existing && existing !== text ? `${text}\n\n${existing}` : text);
      }
    }
  }, [closeMentions, draft, props, setDraft]);

  return (
    <div className={`composer ${props.queueing ? "queueing" : ""} ${props.dropActive ? "drop-target" : ""}`}>
      {Boolean(props.queuedTurns?.length) && (
        <div className="queued-turns">
          <div className="queued-turns-heading">
            <span><ListPlus size={12} /> Next turns</span>
            <small>{props.queuedTurns!.length} queued</small>
          </div>
          <div className="queued-turns-list" role="list" aria-label="Queued follow-up messages">
            {props.queuedTurns!.map((queuedTurn, index) => {
              // Nothing is running once a turn is stopped or fails, so a still
              // queued follow-up is waiting on the user rather than on a run.
              const stalled = queuedTurn.status === "queued" && !props.queueing && index === 0;
              const waitingBehindEarlier = queuedTurn.status === "queued" && !props.queueing && index > 0;
              return (
                <div className={`queued-turn ${queuedTurn.status}`} key={queuedTurn.id} role="listitem">
                  <span className="queued-turn-index">{index + 1}</span>
                  <span className="queued-turn-copy" title={queuedTurn.text}>
                    <strong>{queuedTurn.text}</strong>
                    <small>
                      {queuedTurn.status === "sending"
                        ? "Starting now…"
                        : queuedTurn.status === "failed"
                          ? queuedTurn.error || "Could not start"
                          : `${queuedTurn.attachments.length ? `${queuedTurn.attachments.length} attachment${queuedTurn.attachments.length === 1 ? "" : "s"} · ` : ""}${stalled ? "Waiting — start it now or remove it" : waitingBehindEarlier ? "Waiting behind an earlier message" : "Runs after the active turn"}`}
                    </small>
                  </span>
                  {queuedTurn.status === "sending" ? (
                    <LoaderCircle className="spin" size={13} aria-label="Starting queued turn" />
                  ) : (
                    <span className="queued-turn-actions">
                      {index === 0 && (queuedTurn.status === "failed" || stalled) && props.onRetryQueued && (
                        <button
                          onClick={() => props.onRetryQueued?.(queuedTurn.id)}
                          title={stalled ? "Start this queued turn now" : "Retry queued turn"}
                          aria-label={`${stalled ? "Start" : "Retry"} queued message ${index + 1}`}
                        ><RotateCw size={12} /></button>
                      )}
                      {props.queueing && props.canSteer && props.onSteerQueued && (
                        <button className="steer-queued" onClick={() => props.onSteerQueued?.(queuedTurn.id)} title="Send this into the active turn now" aria-label={`Steer queued message ${index + 1} now`}><CornerUpRight size={12} /></button>
                      )}
                      {props.onRemoveQueued && (
                        <button className="remove-queued" onClick={() => props.onRemoveQueued?.(queuedTurn.id)} title="Remove queued message" aria-label={`Remove queued message ${index + 1}`}><Trash2 size={12} /></button>
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {props.attachments.length > 0 && (
        <div className="composer-attachments" aria-label="Attached context">
          {props.attachments.map((item) => (
            <span key={item.path} className={item.kind}>
              <Paperclip size={10} />
              <em title={item.path}>{item.name}</em>
              <button onClick={() => props.onRemoveAttachment(item.path)} title={`Remove ${item.name}`} aria-label={`Remove attachment ${item.name}`}><X size={11} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-input-wrap">
        {mentions.open && (
          <div className="mention-menu" id={mentionMenuId} role="listbox" aria-label="Mention suggestions">
            {mentions.results.map((result, index) => (
              <button
                key={`${result.kind}:${result.value}`}
                id={`${mentionMenuId}-${index}`}
                role="option"
                aria-selected={index === mentions.index}
                className={`${index === mentions.index ? "active" : ""} ${result.kind}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertMention(result);
                }}
              >
                {result.kind === "skill" ? <Sparkles size={12} /> : <FileCode2 size={12} />}
                <span className="mention-result-copy">
                  <strong>{result.label}</strong>
                  {result.detail && <small>{result.detail}</small>}
                </span>
                <em>{result.kind === "skill" ? "Skill" : "File"}</em>
              </button>
            ))}
          </div>
        )}
        {hasSkillMentions && (
          <div ref={highlightRef} className="composer-input-highlight" aria-hidden="true">{highlightedDraft}</div>
        )}
        <textarea
          ref={textareaRef}
          className={hasSkillMentions ? "has-skill-mentions" : undefined}
          // The @ menu is an inline listbox the textarea drives, so the active
          // option has to be announced from here — it never takes focus itself.
          aria-autocomplete="list"
          aria-expanded={mentions.open}
          aria-controls={mentions.open ? mentionMenuId : undefined}
          aria-activedescendant={mentions.open ? `${mentionMenuId}-${mentions.index}` : undefined}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            updateMentions(event.target.value, event.target.selectionStart ?? event.target.value.length);
          }}
          onPaste={(event) => {
            if (Array.from(event.clipboardData.items).some((item) => item.type.startsWith("image/"))) {
              event.preventDefault();
              props.onPasteImages(event.clipboardData.items);
            }
          }}
          onScroll={(event) => {
            if (highlightRef.current) {
              highlightRef.current.scrollTop = event.currentTarget.scrollTop;
              highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
            }
          }}
          onKeyDown={(event) => {
            if (mentions.open) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setMentions((current) => ({
                  ...current,
                  index: (current.index + (event.key === "ArrowDown" ? 1 : current.results.length - 1)) % current.results.length,
                }));
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                insertMention(mentions.results[mentions.index]);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                closeMentions();
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send("default");
            }
          }}
          onBlur={closeMentions}
          placeholder={props.placeholder}
          rows={1}
        />
      </div>
      {props.modelControls}
      <div className="composer-toolbar">
        <div className="composer-controls">{props.controls}</div>
        <div className="composer-actions">
          {props.queueing && (
            <span className="queue-hint" title="Enter queues this message as the next turn. Use Steer to change the work already in progress."><ListPlus size={12} /> Enter queues</span>
          )}
          {(props.running || props.childrenRunning) && (
            <button
              className="stop-button"
              onClick={props.onStop}
              title={props.running ? "Stop the active task and its sub-agents (Esc)" : "Stop the sub-agents still running for this thread (Esc)"}
              aria-label={props.running ? "Stop the active task and its sub-agents" : "Stop the sub-agents still running for this thread"}
            >
              <CircleStop size={17} />
            </button>
          )}
          {props.queueing && (
            <button
              className="steer-button"
              onClick={() => void send("steer")}
              disabled={!props.canSteer || !draft.trim()}
              title={props.canSteer
                ? "Send this message into the active turn now"
                : "The model is finishing its response. Queue this message as the next turn instead."}
            >
              <CornerUpRight size={14} /> <span>Steer</span>
            </button>
          )}
          <button
            className={`send-button ${props.queueing ? "queue-button" : ""}`}
            onClick={() => void send("default")}
            disabled={!draft.trim() || (props.running && !props.queueing)}
            title={props.queueing ? "Queue as the next turn" : props.running ? "Wait for the first turn to start" : "Send"}
          >
            {props.queueing ? <><ListPlus size={14} /><span>Queue</span></> : <ArrowUp size={18} />}
          </button>
        </div>
      </div>
    </div>
  );
});
