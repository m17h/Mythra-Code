import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowUp, CircleStop, FileCode2, Paperclip, X } from "lucide-react";
import { loadStored, storeValue } from "../lib/storage";
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

export function resetDraftStoreForTests(): void {
  draftsCache = null;
  if (draftSaveTimer !== null) window.clearTimeout(draftSaveTimer);
  draftSaveTimer = null;
}

const MENTION_PATTERN = /@([\w./-]*)$/;

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
  steering: boolean;
  dropActive: boolean;
  placeholder: string;
  attachments: AttachmentRecord[];
  modelControls?: ReactNode;
  controls: ReactNode;
  searchFiles?: (query: string) => Promise<string[]>;
  onRemoveAttachment: (path: string) => void;
  onPasteImages: (items: DataTransferItemList) => void;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
}>(function Composer(props, ref) {
  const [draft, setDraftState] = useState(() => draftFor(props.threadKey));
  const [mentions, setMentions] = useState<{ open: boolean; results: string[]; index: number }>({ open: false, results: [], index: 0 });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const threadKeyRef = useRef(props.threadKey);
  const mentionRequestRef = useRef(0);
  const searchFilesRef = useRef(props.searchFiles);
  searchFilesRef.current = props.searchFiles;

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

  const closeMentions = useCallback(() => setMentions({ open: false, results: [], index: 0 }), []);

  const updateMentions = useCallback((text: string, caret: number) => {
    const match = MENTION_PATTERN.exec(text.slice(0, caret));
    if (!match || !searchFilesRef.current) {
      closeMentions();
      return;
    }
    const query = match[1];
    const requestId = ++mentionRequestRef.current;
    window.setTimeout(() => {
      if (mentionRequestRef.current !== requestId) return;
      searchFilesRef.current?.(query)
        .then((results) => {
          if (mentionRequestRef.current !== requestId) return;
          setMentions({ open: results.length > 0, results: results.slice(0, 8), index: 0 });
        })
        .catch(() => closeMentions());
    }, 150);
  }, [closeMentions]);

  const insertMention = useCallback((path: string) => {
    const textarea = textareaRef.current;
    const caret = textarea?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret).replace(MENTION_PATTERN, `@${path} `);
    const next = `${before}${draft.slice(caret)}`;
    setDraft(next);
    closeMentions();
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(before.length, before.length);
    });
  }, [closeMentions, draft, setDraft]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    // Capture the sending thread's key: the user may switch threads while the
    // RPC is in flight, and a failed send must restore into the ORIGINAL
    // thread's draft, not whichever thread is now visible.
    const sentFromKey = threadKeyRef.current;
    closeMentions();
    setDraft("");
    const delivered = await props.onSend(text);
    if (!delivered) {
      if (threadKeyRef.current === sentFromKey) {
        // Still on the same thread — restore visibly unless the user typed.
        setDraftState((current) => {
          const restored = current || text;
          persistDraft(sentFromKey, restored);
          return restored;
        });
      } else if (!draftFor(sentFromKey)) {
        // Restore silently into the original thread's persisted draft.
        persistDraft(sentFromKey, text);
      }
    }
  }, [closeMentions, draft, props, setDraft]);

  return (
    <div className={`composer ${props.steering ? "steering" : ""} ${props.dropActive ? "drop-target" : ""}`}>
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
          <div className="mention-menu" role="listbox" aria-label="File suggestions">
            {mentions.results.map((path, index) => (
              <button
                key={path}
                role="option"
                aria-selected={index === mentions.index}
                className={index === mentions.index ? "active" : ""}
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertMention(path);
                }}
              >
                <FileCode2 size={12} />
                <span>{path}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
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
              void send();
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
          {props.steering && (
            <span className="steer-hint" title="The task is running — Enter sends this message as direction to it, not as a new question.">Steering active task</span>
          )}
          {props.running && (
            <button className="stop-button" onClick={props.onStop} title="Stop the active task (Esc)" aria-label="Stop the active task">
              <CircleStop size={17} />
            </button>
          )}
          <button className="send-button" onClick={() => void send()} disabled={!draft.trim()} title={props.steering ? "Add direction to the active task" : "Send"}>
            <ArrowUp size={18} />
          </button>
        </div>
      </div>
    </div>
  );
});
