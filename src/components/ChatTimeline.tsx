import { Children, isValidElement, memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { Check, ChevronRight, Clipboard, FileCode2, ListChecks, Pencil, Sparkles, TerminalSquare, UsersRound } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import Markdown from "react-markdown";
import { Virtuoso } from "react-virtuoso";
import remarkGfm from "remark-gfm";
import type { Activity, ChatMessage, PendingApproval, Provider } from "../types";
import type { JsonObject } from "../lib/codex";
import { InlineApprovalCard } from "./ApprovalCenter";
import { ProviderLogo } from "./BrandLogos";

export type WorkItemEntry =
  | { kind: "message"; value: ChatMessage }
  | { kind: "activity"; value: Activity }
  | { kind: "commands"; value: Activity[] }
  | { kind: "files"; value: Activity[] };

export type TimelineEntry =
  | WorkItemEntry
  | { kind: "work"; value: WorkItemEntry[] }
  | { kind: "thinking"; label: string }
  | { kind: "approval"; value: PendingApproval };

function entryOrder(entry: TimelineEntry): number {
  if (entry.kind === "thinking" || entry.kind === "approval") return Number.MAX_SAFE_INTEGER;
  if (entry.kind === "commands" || entry.kind === "files") return entry.value[0]?.timelineOrder ?? Number.MAX_SAFE_INTEGER;
  if (entry.kind === "work") return entry.value[0] ? entryOrder(entry.value[0]) : Number.MAX_SAFE_INTEGER;
  return entry.value.timelineOrder ?? Number.MAX_SAFE_INTEGER;
}

function workItemId(entry: WorkItemEntry): string | undefined {
  if (entry.kind === "commands" || entry.kind === "files") return entry.value[0]?.id;
  return entry.value.id;
}

/**
 * Every delta flush rebuilds the timeline entry list, so the grouped arrays
 * handed to the disclosures are new objects on every streamed frame even when
 * nothing inside them changed. The underlying activity and message objects do
 * keep their identity, so comparing element-wise lets `memo` actually hold and
 * stops expanded panels from re-rendering (and re-parsing Markdown) at 60fps.
 */
function sameActivities(left: Activity[], right: Activity[]): boolean {
  return left.length === right.length && left.every((activity, index) => activity === right[index]);
}

function sameWorkItem(left: WorkItemEntry, right: WorkItemEntry): boolean {
  if (left === right) return true;
  if (left.kind !== right.kind) return false;
  if (left.kind === "commands" || left.kind === "files") {
    return sameActivities(left.value, (right as typeof left).value);
  }
  return left.value === (right as typeof left).value;
}

function sameWorkItems(left: WorkItemEntry[], right: WorkItemEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => sameWorkItem(entry, right[index]));
}

function workItemTurnId(entry: WorkItemEntry): string | undefined {
  if (entry.kind === "commands" || entry.kind === "files") {
    const turnId = entry.value[0]?.turnId;
    return turnId && entry.value.every((activity) => activity.turnId === turnId) ? turnId : undefined;
  }
  return entry.value.turnId;
}

function workItemTurnStatus(entry: WorkItemEntry): ChatMessage["turnStatus"] {
  if (entry.kind === "commands" || entry.kind === "files") {
    return entry.value.find((activity) => activity.turnStatus)?.turnStatus;
  }
  return entry.value.turnStatus;
}

function groupToolRuns(entries: WorkItemEntry[]): WorkItemEntry[] {
  const grouped: WorkItemEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== "activity" || (entry.value.kind !== "command" && entry.value.kind !== "file")) {
      grouped.push(entry);
      continue;
    }
    const previous = grouped.at(-1);
    if (entry.value.kind === "command") {
      if (previous?.kind === "commands") previous.value.push(entry.value);
      else grouped.push({ kind: "commands", value: [entry.value] });
    } else if (previous?.kind === "files") {
      previous.value.push(entry.value);
    } else {
      grouped.push({ kind: "files", value: [entry.value] });
    }
  }
  return grouped;
}

export function orderedTimelineEntries(messages: ChatMessage[], activities: Activity[]): WorkItemEntry[] {
  // Messages and activities each arrive in ascending timelineOrder, so a
  // linear two-pointer merge replaces an O(n log n) sort on every delta flush.
  // If either input turns out unsorted, fall back to a full sort.
  const entries: WorkItemEntry[] = [];
  let sorted = true;
  let messageIndex = 0;
  let activityIndex = 0;
  let previousOrder = Number.MIN_SAFE_INTEGER;
  while (messageIndex < messages.length || activityIndex < activities.length) {
    const messageOrder = messageIndex < messages.length ? messages[messageIndex].timelineOrder ?? Number.MAX_SAFE_INTEGER : Infinity;
    const activityOrder = activityIndex < activities.length ? activities[activityIndex].timelineOrder ?? Number.MAX_SAFE_INTEGER : Infinity;
    let next: WorkItemEntry;
    if (messageOrder <= activityOrder) {
      next = { kind: "message", value: messages[messageIndex] };
      messageIndex += 1;
    } else {
      next = { kind: "activity", value: activities[activityIndex] };
      activityIndex += 1;
    }
    const order = entryOrder(next);
    if (order < previousOrder) sorted = false;
    previousOrder = Math.max(previousOrder, order);
    entries.push(next);
  }
  return groupToolRuns(sorted ? entries : entries.sort((left, right) => entryOrder(left) - entryOrder(right)));
}

function compactTurnSegment(segment: WorkItemEntry[], compact: boolean): TimelineEntry[] {
  if (!compact) return segment;
  const users = segment.filter((entry) => entry.kind === "message" && entry.value.role === "user");
  const assistants = segment.filter((entry) => entry.kind === "message" && entry.value.role === "assistant" && !entry.value.streaming);
  // Incomplete turns stay chronological. Steered user messages remain visible,
  // with the work on either side compacted independently in place.
  if (!users.length || !assistants.length) return segment;
  const finalAssistant = assistants.at(-1)!;
  const output: TimelineEntry[] = [];
  let work: WorkItemEntry[] = [];
  const flushWork = () => {
    if (work.length) output.push({ kind: "work", value: work });
    work = [];
  };
  for (const entry of segment) {
    const staysVisible = entry === finalAssistant || (entry.kind === "message" && entry.value.role === "user");
    if (staysVisible) {
      flushWork();
      output.push(entry);
    } else {
      work.push(entry);
    }
  }
  flushWork();
  return output;
}

/**
 * Completed turns retain user direction and the final assistant answer while
 * compacting intervening work. Active, interrupted, and failed turns remain
 * fully chronological.
 */
export function compactCompletedTurns(entries: WorkItemEntry[], running: boolean): TimelineEntry[] {
  const segments: Array<{ entries: WorkItemEntry[]; turnId?: string }> = [];
  let segment: WorkItemEntry[] = [];
  let segmentTurnId: string | undefined;
  const flushSegment = () => {
    if (segment.length) segments.push({ entries: segment, turnId: segmentTurnId });
    segment = [];
    segmentTurnId = undefined;
  };
  for (const entry of entries) {
    const turnId = workItemTurnId(entry);
    if (turnId) {
      // Early/legacy saves can contain the optimistic user prompt just before
      // the runtime-tagged entries without copying the returned turn id onto
      // that prompt. Treat a prompt-only prefix as part of the tagged turn so
      // a successfully completed run can still collapse as one unit.
      const isOrphanedPromptPrefix = !segmentTurnId
        && segment.length > 0
        && segment.every((candidate) => candidate.kind === "message" && candidate.value.role === "user");
      if (segment.length && segmentTurnId !== turnId && !isOrphanedPromptPrefix) flushSegment();
      segmentTurnId = turnId;
      segment.push(entry);
      continue;
    }
    if (segmentTurnId) flushSegment();
    const startsNextLegacyTurn = entry.kind === "message"
      && entry.value.role === "user"
      && segment.some((candidate) => candidate.kind === "message" && candidate.value.role === "user");
    if (startsNextLegacyTurn) flushSegment();
    segment.push(entry);
  }
  flushSegment();

  return segments.flatMap(({ entries: turnEntries, turnId }, index) => {
    const status = turnEntries.map(workItemTurnStatus).find(Boolean);
    // Runtime-tagged turns compact only after an explicit successful
    // completion. Legacy transcripts retain the previous last-turn fallback.
    const compact = turnId
      ? status === "completed"
      : index < segments.length - 1 || !running;
    return compactTurnSegment(turnEntries, compact);
  });
}

function textFromCodeNode(node: ReactNode): string {
  const child = Children.toArray(node)[0];
  if (!isValidElement<{ children?: ReactNode }>(child)) return String(node ?? "");
  return String(child.props.children ?? "").replace(/\n$/, "");
}

/**
 * "Copied" only appears once the clipboard write actually resolved — a failed
 * write shows nothing rather than a false confirmation. The reset timer is
 * cleared on unmount so it cannot fire into an unmounted row.
 */
function useCopyFeedback(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);
  const copy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  }, []);
  return [copied, copy];
}

/**
 * Markdown links must never navigate the webview itself away from the app.
 * http(s) destinations open in the system browser; anything else is inert.
 */
function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const external = Boolean(href && /^https?:\/\//i.test(href));
  return (
    <a
      href={href}
      title={external ? href : undefined}
      onClick={(event) => {
        event.preventDefault();
        if (external && href) void openUrl(href);
      }}
    >
      {children}
    </a>
  );
}

function CodePre({ children }: { children?: ReactNode }) {
  const [copied, copy] = useCopyFeedback();
  const text = textFromCodeNode(children);
  return (
    <div className="code-block">
      <button
        className="code-copy"
        onClick={() => copy(text)}
        title="Copy code"
      >
        {copied ? <Check size={12} /> : <Clipboard size={12} />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

const MARKDOWN_COMPONENTS = { pre: CodePre, a: MarkdownLink };
const REASONING_MARKDOWN_COMPONENTS = { a: MarkdownLink };

const MessageMarkdown = memo(function MessageMarkdown({ text }: { text: string }) {
  return (
    <div className="message-text rich-markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{text}</Markdown>
    </div>
  );
});

/**
 * Format assistant output while it is arriving. Deferring the accumulated
 * text lets React abandon obsolete intermediate parses when tokens arrive
 * faster than the Markdown tree can be built, while still presenting the
 * newest completed render instead of falling back to plain text until the
 * whole response finishes.
 */
function StreamingMessageMarkdown({ text }: { text: string }) {
  const deferredText = useDeferredValue(text);
  return <MessageMarkdown text={deferredText} />;
}

const MessageRow = memo(function MessageRow({ message, provider, onEdit }: { message: ChatMessage; provider: Provider; onEdit?: (text: string) => void }) {
  const [copied, copy] = useCopyFeedback();
  return (
    <article className={`message ${message.role}`}>
      <div className={`message-avatar ${message.role === "assistant" ? `provider-${provider}` : ""}`}>
        {message.role === "assistant" ? <ProviderLogo provider={provider} size={14} /> : <span>You</span>}
      </div>
      <div className="message-body">
        {!message.streaming && (
          <div className="message-actions">
            <button
              onClick={() => copy(message.text)}
              title="Copy message"
            >
              {copied ? <Check size={11} /> : <Clipboard size={11} />}
              {copied ? "Copied" : "Copy"}
            </button>
            {message.role === "user" && onEdit && (
              <button onClick={() => onEdit(message.text)} title="Put this message back in the composer to edit and resend">
                <Pencil size={11} />
                Edit
              </button>
            )}
          </div>
        )}
        {message.streaming
          ? <StreamingMessageMarkdown text={message.text} />
          : <MessageMarkdown text={message.text} />}
        {message.streaming && <span className="stream-caret" />}
      </div>
    </article>
  );
});

export const ActivityRow = memo(function ActivityRow({ activity }: { activity: Activity }) {
  const [expanded, setExpanded] = useState(false);
  if (activity.kind === "reasoning") {
    return <ReasoningDisclosure detail={activity.detail ?? ""} inProgress={activity.status === "inProgress"} />;
  }

  const expandable = Boolean(activity.detail) && activity.kind === "command";
  const Icon = activity.kind === "command"
    ? TerminalSquare
    : activity.kind === "file"
      ? FileCode2
      : activity.kind === "agent"
        ? UsersRound
        : Sparkles;
  return (
    <div className={`activity-row ${activity.kind === "command" ? "command-activity" : ""} ${expanded ? "expanded" : "collapsed"}`}>
      <div className={`activity-icon ${activity.kind}`}><Icon size={14} /></div>
      <div className="activity-copy">
        {expandable ? (
          <button
            className="activity-toggle"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
          >
            <ChevronRight className="activity-chevron" size={12} />
            <span>{activity.title}</span>
          </button>
        ) : <span>{activity.title}</span>}
        {activity.detail && (!expandable || expanded) && <pre>{activity.detail.slice(-1200)}</pre>}
      </div>
      {activity.status && <small>{activity.status}</small>}
    </div>
  );
});

export const ReasoningDisclosure = memo(function ReasoningDisclosure({
  detail,
  inProgress,
  label,
}: {
  detail: string;
  inProgress: boolean;
  label?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`reasoning-disclosure ${expanded ? "expanded" : "collapsed"} ${inProgress ? "active" : "complete"}`}>
      <button
        type="button"
        className="reasoning-toggle"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Hide" : "Show"} thinking`}
      >
        <ChevronRight className="reasoning-chevron" size={13} />
        <span>{label || "Thinking"}</span>
        {inProgress && <i className="reasoning-live-dot" aria-label="Thinking in progress" />}
      </button>
      <div className="reasoning-panel" aria-hidden={!expanded}>
        <div className="reasoning-panel-inner">
          {/* The panel is only materialized when open: reasoning deltas stream
              constantly, and parsing Markdown per frame for a collapsed panel
              is the single largest hidden CPU cost during a turn. While the
              stream is live the text renders plain; Markdown renders once the
              item completes. */}
          {expanded && (
            <div className="reasoning-text rich-markdown">
              {inProgress
                ? <div className="plain-stream">{detail || "Waiting for the model’s thoughts…"}</div>
                : <Markdown remarkPlugins={[remarkGfm]} components={REASONING_MARKDOWN_COMPONENTS}>{detail || "Waiting for the model’s thoughts…"}</Markdown>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

const ToolDisclosure = memo(function ToolDisclosure({
  activities,
  type,
}: {
  activities: Activity[];
  type: "command" | "file";
}) {
  const [expanded, setExpanded] = useState(false);
  const inProgress = activities.some((activity) => activity.status === "inProgress");
  const isCommand = type === "command";
  const count = isCommand
    ? activities.length
    : activities.reduce((total, activity) => total + (activity.itemCount ?? 1), 0);
  const noun = isCommand ? (count === 1 ? "command" : "commands") : (count === 1 ? "file change" : "file changes");
  const label = isCommand ? `Executed ${count} ${noun}` : `Made ${count} ${noun}`;
  const Icon = isCommand ? TerminalSquare : FileCode2;
  return (
    <div className={`reasoning-disclosure tool-disclosure ${isCommand ? "command-disclosure" : "file-disclosure"} ${expanded ? "expanded" : "collapsed"} ${inProgress ? "active" : "complete"}`}>
      <button
        type="button"
        className={`reasoning-toggle ${isCommand ? "command-toggle" : "file-toggle"}`}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Hide" : "Show"} ${count} ${isCommand ? `executed ${noun}` : noun}`}
      >
        <ChevronRight className="reasoning-chevron" size={13} />
        <span>{label}</span>
        {inProgress && <i className="reasoning-live-dot" aria-label={`${isCommand ? "Command" : "File change"} in progress`} />}
      </button>
      <div className={`reasoning-panel ${isCommand ? "command-panel" : "file-panel"}`} aria-hidden={!expanded}>
        <div className="reasoning-panel-inner">
          {expanded && (
            <div className="command-list">
              {activities.map((activity) => (
                <div className="command-list-item" key={activity.id}>
                  <div className="command-list-title">
                    <Icon size={12} />
                    <code>{activity.title}</code>
                    {activity.status && <small>{activity.status}</small>}
                  </div>
                  {activity.detail && <pre>{activity.detail.slice(-1200)}</pre>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

export const CommandDisclosure = memo(
  function CommandDisclosure({ commands }: { commands: Activity[] }) {
    return <ToolDisclosure activities={commands} type="command" />;
  },
  (previous, next) => sameActivities(previous.commands, next.commands),
);

export const FileDisclosure = memo(
  function FileDisclosure({ files }: { files: Activity[] }) {
    return <ToolDisclosure activities={files} type="file" />;
  },
  (previous, next) => sameActivities(previous.files, next.files),
);

function completedWorkParts(entries: WorkItemEntry[]): string[] {
  let commands = 0;
  let files = 0;
  let otherSteps = 0;
  for (const entry of entries) {
    if (entry.kind === "commands") commands += entry.value.length;
    else if (entry.kind === "files") files += entry.value.reduce((total, activity) => total + (activity.itemCount ?? 1), 0);
    else if (entry.kind === "activity" && entry.value.kind === "command") commands += 1;
    else if (entry.kind === "activity" && entry.value.kind === "file") files += entry.value.itemCount ?? 1;
    else otherSteps += 1;
  }
  const parts: string[] = [];
  if (commands) parts.push(`${commands} command${commands === 1 ? "" : "s"}`);
  if (files) parts.push(`${files} file change${files === 1 ? "" : "s"}`);
  if (otherSteps) parts.push(`${otherSteps} other step${otherSteps === 1 ? "" : "s"}`);
  return parts;
}

function completedWorkDuration(entries: WorkItemEntry[]): number | undefined {
  for (const entry of entries) {
    if (entry.kind === "commands" || entry.kind === "files") {
      const duration = entry.value.find((activity) => activity.turnDurationMs !== undefined)?.turnDurationMs;
      if (duration !== undefined) return duration;
      continue;
    }
    if (entry.value.turnDurationMs !== undefined) return entry.value.turnDurationMs;
  }
  return undefined;
}

export function formatCompletedDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1_000));
  if (totalSeconds < 60) {
    return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    const minutes = `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
    return seconds ? `${minutes} ${seconds} second${seconds === 1 ? "" : "s"}` : minutes;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const hourPart = `${hours} hour${hours === 1 ? "" : "s"}`;
  return minutes ? `${hourPart} ${minutes} minute${minutes === 1 ? "" : "s"}` : hourPart;
}

export const CompletedWorkDisclosure = memo(function CompletedWorkDisclosure({ entries, reveal = false }: { entries: WorkItemEntry[]; reveal?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (reveal) setExpanded(true);
  }, [reveal]);
  const parts = completedWorkParts(entries);
  const durationMs = completedWorkDuration(entries);
  const summaryParts = durationMs === undefined
    ? parts
    : [`Worked for ${formatCompletedDuration(durationMs)}`, ...parts];
  const description = summaryParts.join(", ") || `${entries.length} step${entries.length === 1 ? "" : "s"}`;
  return (
    <div className={`reasoning-disclosure completed-work-disclosure ${expanded ? "expanded" : "collapsed"} complete`}>
      <button
        type="button"
        className="reasoning-toggle completed-work-toggle"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Hide" : "Show"} completed work: ${description}`}
      >
        <ChevronRight className="reasoning-chevron" size={13} />
        <ListChecks size={13} />
        <span>Work completed</span>
        <small>{summaryParts.join(" · ")}</small>
      </button>
      <div className="reasoning-panel completed-work-panel" aria-hidden={!expanded}>
        <div className="reasoning-panel-inner">
          {expanded && (
            <div className="completed-work-list">
              {entries.flatMap((entry) => {
                if (entry.kind === "message") {
                  return [(
                    <div className="completed-work-update" key={`update-${entry.value.id}`}>
                      <Sparkles size={13} />
                      <div className="rich-markdown">
                        <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{entry.value.text}</Markdown>
                      </div>
                    </div>
                  )];
                }
                const activities = entry.kind === "activity" ? [entry.value] : entry.value;
                return activities.map((activity) => <ActivityRow activity={activity} key={activity.id} />);
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}, (previous, next) => (previous.reveal ?? false) === (next.reveal ?? false) && sameWorkItems(previous.entries, next.entries));

export function followTimelineOutput(atBottom: boolean): "auto" | false {
  return atBottom ? "auto" : false;
}

export const INITIAL_TIMELINE_POSITION = { index: "LAST", align: "end" } as const;

function TimelineFooter() {
  return <div className="timeline-bottom-space" aria-hidden="true" />;
}

/**
 * Top inset must be a real header item: Virtuoso positions its item list with
 * inline padding for virtualization, which overrides any CSS padding — so a
 * stylesheet inset silently never applied and the first message sat flush
 * against the top edge.
 */
function TimelineHeader() {
  return <div className="timeline-top-space" aria-hidden="true" />;
}

const VIRTUOSO_COMPONENTS = { Header: TimelineHeader, Footer: TimelineFooter };

const NO_SEARCH_MATCHES: number[] = [];

export function ChatTimeline({
  messages,
  activities,
  running,
  thinkingLabel,
  approval,
  provider = "openai",
  searchQuery,
  searchActiveMatch,
  onSearchMatches,
  onEditMessage,
  onApprovalRespond,
}: {
  messages: ChatMessage[];
  activities: Activity[];
  running: boolean;
  thinkingLabel: string;
  approval?: PendingApproval | null;
  provider?: Provider;
  searchQuery?: string;
  searchActiveMatch?: number;
  onSearchMatches?: (count: number) => void;
  onEditMessage?: (text: string) => void;
  onApprovalRespond?: (approval: PendingApproval, result: JsonObject) => void;
}) {
  const entries = useMemo<TimelineEntry[]>(() => {
    const next = compactCompletedTurns(orderedTimelineEntries(messages, activities), running);
    if (running && !approval && !messages.some((message) => message.streaming) && !activities.some((activity) => activity.kind === "reasoning" && activity.status === "inProgress")) {
      next.push({ kind: "thinking", label: thinkingLabel });
    }
    if (approval) next.push({ kind: "approval", value: approval });
    return next;
  }, [activities, approval, messages, running, thinkingLabel]);

  // In-conversation search: matches are entry indices; the active match is
  // scrolled into view and highlighted.
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  // A resumed thread can mount while its transcript RPC is still empty. In
  // that case Virtuoso consumes initialTopMostItemIndex before there is an
  // item to position. Markdown and virtualization measurements can also make
  // a tall final answer grow over several layout passes, so keep restoring the
  // bottom across the layout passes that follow the first rendered entry.
  const initialPositionPendingRef = useRef(true);
  const initialPositionSettleTimerRef = useRef<number | null>(null);
  const endInitialPositioning = useCallback(() => {
    initialPositionPendingRef.current = false;
    if (initialPositionSettleTimerRef.current !== null) {
      window.clearTimeout(initialPositionSettleTimerRef.current);
      initialPositionSettleTimerRef.current = null;
    }
  }, []);
  const restoreInitialBottom = useCallback(() => {
    if (!initialPositionPendingRef.current || entries.length === 0) return;
    // A final Markdown message can be taller than the viewport. Scrolling to
    // its item index may align its top while it is still being measured;
    // scrolling the scroller itself to an intentionally oversized offset
    // clamps to the true bottom regardless of the final item's height.
    virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: "auto" });
    // The settle window is armed once, from the first restore, and is never
    // extended. Restarting it per call kept it open for the whole of a
    // streaming turn — deltas flush every animation frame, so the list height
    // never stayed still for long enough to close it — and every one of those
    // height changes then forced the scroller back to the bottom, overriding
    // followOutput's decision not to follow and pinning the user there.
    if (initialPositionSettleTimerRef.current === null) {
      initialPositionSettleTimerRef.current = window.setTimeout(endInitialPositioning, 300);
    }
  }, [endInitialPositioning, entries.length]);
  useEffect(restoreInitialBottom, [restoreInitialBottom]);
  // Any deliberate scroll gesture ends the initial positioning immediately, so
  // a user who reaches for the transcript inside the settle window is not
  // pulled back down by the next measurement pass.
  const detachScrollIntentRef = useRef<(() => void) | null>(null);
  const attachScrollIntent = useCallback((scroller: HTMLElement | Window | null) => {
    detachScrollIntentRef.current?.();
    detachScrollIntentRef.current = null;
    if (!scroller) return;
    const cancel = () => endInitialPositioning();
    scroller.addEventListener("wheel", cancel, { passive: true });
    scroller.addEventListener("touchmove", cancel, { passive: true });
    detachScrollIntentRef.current = () => {
      scroller.removeEventListener("wheel", cancel);
      scroller.removeEventListener("touchmove", cancel);
    };
  }, [endInitialPositioning]);
  useEffect(
    () => () => {
      detachScrollIntentRef.current?.();
      detachScrollIntentRef.current = null;
      if (initialPositionSettleTimerRef.current !== null) {
        window.clearTimeout(initialPositionSettleTimerRef.current);
      }
    },
    [],
  );
  const matchIndices = useMemo(() => {
    const query = searchQuery?.trim().toLowerCase();
    // A shared constant, not a fresh literal: with no active search this memo
    // re-runs on every streamed frame, and a new array each time would re-fire
    // the onSearchMatches effect below for the whole turn.
    if (!query) return NO_SEARCH_MATCHES;
    const hits: number[] = [];
    entries.forEach((entry, index) => {
      const haystack = entry.kind === "message"
        ? entry.value.text
        : entry.kind === "activity"
          ? `${entry.value.title} ${entry.value.detail ?? ""}`
          : entry.kind === "commands"
            ? entry.value.map((command) => `${command.title} ${command.detail ?? ""}`).join(" ")
            : entry.kind === "files"
              ? entry.value.map((file) => `${file.title} ${file.detail ?? ""}`).join(" ")
              : entry.kind === "work"
                ? entry.value.map((item) => item.kind === "message"
                  ? item.value.text
                  : item.kind === "activity"
                    ? `${item.value.title} ${item.value.detail ?? ""}`
                    : item.value.map((activity) => `${activity.title} ${activity.detail ?? ""}`).join(" ")).join(" ")
                : "";
      if (haystack.toLowerCase().includes(query)) hits.push(index);
    });
    return hits;
  }, [entries, searchQuery]);
  useEffect(() => {
    onSearchMatches?.(matchIndices.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchIndices]);
  const activeEntryIndex = matchIndices.length
    ? matchIndices[((searchActiveMatch ?? 0) % matchIndices.length + matchIndices.length) % matchIndices.length]
    : -1;
  useEffect(() => {
    if (activeEntryIndex >= 0) virtuosoRef.current?.scrollToIndex({ index: activeEntryIndex, align: "center" });
  }, [activeEntryIndex]);
  return (
    <Virtuoso
      ref={virtuosoRef}
      className="timeline virtual-timeline"
      scrollerRef={attachScrollIntent}
      data={entries}
      components={VIRTUOSO_COMPONENTS}
      initialTopMostItemIndex={INITIAL_TIMELINE_POSITION}
      followOutput={followTimelineOutput}
      totalListHeightChanged={restoreInitialBottom}
      increaseViewportBy={{ top: 500, bottom: 800 }}
      // Keys are derived from item ids, never from the row index: the thinking
      // row sits last and its index shifts as work arrives, and two compacted
      // turns whose first item carries no timelineOrder used to collide on
      // Number.MAX_SAFE_INTEGER. Either one makes Virtuoso remount a row and
      // re-measure it from zero height mid-scroll.
      computeItemKey={(index, entry) => entry.kind === "thinking"
        ? "thinking"
        : entry.kind === "work"
          ? `work-${(entry.value[0] && workItemId(entry.value[0])) ?? index}`
        : entry.kind === "commands" || entry.kind === "files"
          ? `${entry.kind}-${entry.value[0]?.id ?? index}`
          : `${entry.kind}-${entry.value.id}`}
      itemContent={(index, entry) => {
        const hitClass = index === activeEntryIndex ? " search-hit" : "";
        if (entry.kind === "message") {
          return <div className={`timeline-entry timeline-entry-message${hitClass}`}><MessageRow message={entry.value} provider={provider} onEdit={onEditMessage} /></div>;
        }
        if (entry.kind === "activity") {
          return <div className={`timeline-entry timeline-entry-activity${hitClass}`}><ActivityRow activity={entry.value} /></div>;
        }
        if (entry.kind === "commands") {
          return <div className={`timeline-entry timeline-entry-disclosure${hitClass}`}><CommandDisclosure commands={entry.value} /></div>;
        }
        if (entry.kind === "files") {
          return <div className={`timeline-entry timeline-entry-disclosure${hitClass}`}><FileDisclosure files={entry.value} /></div>;
        }
        if (entry.kind === "work") {
          return <div className={`timeline-entry timeline-entry-disclosure${hitClass}`}><CompletedWorkDisclosure entries={entry.value} reveal={index === activeEntryIndex && Boolean(searchQuery?.trim())} /></div>;
        }
        if (entry.kind === "approval") {
          return (
            <div className="timeline-entry timeline-entry-approval">
              <InlineApprovalCard approval={entry.value} onRespond={(result) => onApprovalRespond?.(entry.value, result)} />
            </div>
          );
        }
        return (
          <div className="timeline-entry timeline-entry-disclosure">
            <ReasoningDisclosure detail="" inProgress label={entry.label} />
          </div>
        );
      }}
    />
  );
}
