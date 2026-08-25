import { Children, isValidElement, memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, CircleDot, Clipboard, FileCode2, ImageIcon, ListChecks, MessageSquare, Pencil, TerminalSquare, UsersRound } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Activity, ChatMessage, PendingApproval, Provider } from "../types";
import type { JsonObject } from "../lib/codex";
import { InlineApprovalCard } from "./ApprovalCenter";
import { ProviderLogo } from "./BrandLogos";
import { decodeHtmlEntities } from "../lib/text";
import { providerDisplayName } from "../lib/childAgents";
import { describeSubAgentActivity, subAgentStatusLabel, workerStatusFromAgentRecord, type SubAgentCounts } from "../lib/subAgentActivity";

export type WorkItemEntry =
  | { kind: "message"; value: ChatMessage }
  | { kind: "activity"; value: Activity }
  | { kind: "commands"; value: Activity[] }
  | { kind: "files"; value: Activity[] }
  | { kind: "spawns"; value: Activity[] };

export type TimelineEntry =
  | WorkItemEntry
  | { kind: "work"; value: WorkItemEntry[] }
  | { kind: "thinking"; label: string }
  | { kind: "approval"; value: PendingApproval };

function entryOrder(entry: TimelineEntry): number {
  if (entry.kind === "thinking" || entry.kind === "approval") return Number.MAX_SAFE_INTEGER;
  if (entry.kind === "commands" || entry.kind === "files" || entry.kind === "spawns") return entry.value[0]?.timelineOrder ?? Number.MAX_SAFE_INTEGER;
  if (entry.kind === "work") return entry.value[0] ? entryOrder(entry.value[0]) : Number.MAX_SAFE_INTEGER;
  return entry.value.timelineOrder ?? Number.MAX_SAFE_INTEGER;
}

function workItemId(entry: WorkItemEntry): string | undefined {
  if (entry.kind === "commands" || entry.kind === "files" || entry.kind === "spawns") return entry.value[0]?.id;
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
  if (left.kind === "commands" || left.kind === "files" || left.kind === "spawns") {
    return sameActivities(left.value, (right as typeof left).value);
  }
  return left.value === (right as typeof left).value;
}

function sameWorkItems(left: WorkItemEntry[], right: WorkItemEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => sameWorkItem(entry, right[index]));
}

function workItemTurnId(entry: WorkItemEntry): string | undefined {
  if (entry.kind === "commands" || entry.kind === "files" || entry.kind === "spawns") {
    const turnId = entry.value[0]?.turnId;
    return turnId && entry.value.every((activity) => activity.turnId === turnId) ? turnId : undefined;
  }
  return entry.value.turnId;
}

function workItemTurnStatus(entry: WorkItemEntry): ChatMessage["turnStatus"] {
  if (entry.kind === "commands" || entry.kind === "files" || entry.kind === "spawns") {
    return entry.value.find((activity) => activity.turnStatus)?.turnStatus;
  }
  return entry.value.turnStatus;
}

function groupToolRuns(entries: WorkItemEntry[]): WorkItemEntry[] {
  const grouped: WorkItemEntry[] = [];
  for (const entry of entries) {
    const isSpawn = entry.kind === "activity" && entry.value.kind === "agent" && entry.value.agent?.action === "spawn";
    if (isSpawn) {
      const previous = grouped.at(-1);
      const sameTurn = previous && Boolean(entry.value.turnId) && workItemTurnId(previous) === entry.value.turnId;
      if (sameTurn && previous.kind === "spawns") {
        previous.value.push(entry.value);
      } else if (sameTurn && previous.kind === "activity" && previous.value.kind === "agent" && previous.value.agent?.action === "spawn") {
        grouped[grouped.length - 1] = { kind: "spawns", value: [previous.value, entry.value] };
      } else {
        grouped.push(entry);
      }
      continue;
    }
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
  const segments: WorkItemEntry[][] = [];
  let segment: WorkItemEntry[] = [];
  let hasUser = false;
  let primaryTurnId: string | undefined;
  const flushSegment = () => {
    if (segment.length) segments.push(segment);
    segment = [];
    hasUser = false;
    primaryTurnId = undefined;
  };
  for (const entry of entries) {
    const turnId = workItemTurnId(entry);
    const isUser = entry.kind === "message" && entry.value.role === "user";
    if (isUser) {
      // User messages are the durable logical boundary. Provider turn ids are
      // normally identical within that boundary, but recovered local-provider
      // processes from older versions can write several ids into one visible
      // run. Splitting on every id leaves all of that completed work expanded.
      // A same-id user message is steering and remains inside the current run.
      const sameRuntimeTurn = hasUser && Boolean(turnId) && turnId === primaryTurnId;
      if (segment.length && (!hasUser || !sameRuntimeTurn)) flushSegment();
      hasUser = true;
      primaryTurnId = turnId;
      segment.push(entry);
      continue;
    }
    // The optimistic opening prompt can be saved just before the runtime turn
    // id returns. Adopt the first tagged work item as this logical run's id so
    // a later steering message still stays in the same segment.
    if (hasUser && !primaryTurnId && turnId) primaryTurnId = turnId;
    segment.push(entry);
  }
  flushSegment();

  return segments.flatMap((turnEntries, index) => {
    let finalAssistant: WorkItemEntry | undefined;
    for (let entryIndex = turnEntries.length - 1; entryIndex >= 0; entryIndex -= 1) {
      const entry = turnEntries[entryIndex];
      if (entry.kind === "message" && entry.value.role === "assistant" && !entry.value.streaming) {
        finalAssistant = entry;
        break;
      }
    }
    const finalStatus = finalAssistant ? workItemTurnStatus(finalAssistant) : undefined;
    const isLastRunningSegment = running && index === segments.length - 1;
    // Runtime-tagged turns compact only around a successful final assistant
    // message. Legacy transcripts retain the prior idle/older-turn fallback.
    // Looking at the final output rather than the first turn id also repairs a
    // saved transcript whose now-retired provider processes interleaved ids.
    const compact = !isLastRunningSegment && Boolean(finalAssistant) && (
      finalStatus === "completed"
      || (!workItemTurnId(finalAssistant!) && !finalStatus)
    );
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

function imagePreviewUrl(path: string): string {
  if (/^(?:asset:|https?:|data:|blob:)/i.test(path)) return path;
  try {
    return convertFileSrc(path);
  } catch {
    // Browser previews do not have the Tauri bridge. Keeping the path makes
    // component tests and browser development degrade without crashing.
    return path;
  }
}

function MessageImagePreview({ path, name }: { path: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="message-image-preview unavailable" title={name}>
        <ImageIcon size={16} aria-hidden="true" />
        <span>{name}</span>
      </span>
    );
  }
  return (
    <img
      className="message-image-preview"
      src={imagePreviewUrl(path)}
      alt={`Attached image: ${name}`}
      title={name}
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
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
        {message.role === "user" && Boolean(message.attachments?.length) && (
          <div className="message-image-previews" aria-label="Attached images">
            {message.attachments?.map((attachment) => (
              <MessageImagePreview key={attachment.path} path={attachment.path} name={attachment.name} />
            ))}
          </div>
        )}
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
  if (activity.kind === "agent" && activity.agent?.action === "spawn") {
    return <SubAgentRelayCard activity={activity} />;
  }

  const expandable = Boolean(activity.detail) && activity.kind === "command";
  const displayTitle = activity.kind === "agent" ? decodeHtmlEntities(activity.title) : activity.title;
  const displayDetail = activity.kind === "agent" && activity.detail ? decodeHtmlEntities(activity.detail) : activity.detail;
  const Icon = activity.kind === "command"
    ? TerminalSquare
    : activity.kind === "file"
      ? FileCode2
      : activity.kind === "agent"
        ? UsersRound
        : CircleDot;
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
            <span>{displayTitle}</span>
          </button>
        ) : <span>{displayTitle}</span>}
        {displayDetail && (!expandable || expanded) && <pre>{displayDetail.slice(-1200)}</pre>}
      </div>
      {activity.status && <small>{activity.status}</small>}
    </div>
  );
});

function subAgentCountsFromActivities(activities: Activity[]): SubAgentCounts {
  const counts: SubAgentCounts = { total: 0, active: 0, starting: 0, working: 0, completed: 0, cancelled: 0, failed: 0 };
  for (const activity of activities) {
    const count = Math.max(1, activity.agent?.count ?? 1);
    const status = workerStatusFromAgentRecord(activity.status ?? "");
    counts.total += count;
    if (status === "starting" || status === "working") counts.active += count;
    if (status !== "idle") counts[status] += count;
  }
  return counts;
}

export const SubAgentRelayCard = memo(function SubAgentRelayCard({ activity, dealIndex }: { activity: Activity; dealIndex?: number }) {
  const metadata = activity.agent;
  const provider = metadata?.provider;
  const status = workerStatusFromAgentRecord(activity.status ?? "");
  const statusLabel = subAgentStatusLabel(status);
  const providerLabel = provider ? providerDisplayName(provider) : "Mythra Code";
  const task = decodeHtmlEntities(metadata?.task?.trim() || activity.title || "Delegated task");
  const model = decodeHtmlEntities(metadata?.model?.trim() || "");
  const count = Math.max(1, metadata?.count ?? 1);

  return (
    <article
      className={`subagent-relay-card provider-${provider ?? "unknown"} status-${status}`}
      // Crew launches deal cards in one-by-one; the delay caps so a large
      // wave (or reopening an old transcript) never feels sluggish.
      style={dealIndex !== undefined ? { "--deal-delay": `${Math.min(dealIndex, 8) * 65}ms` } as CSSProperties : undefined}
      aria-label={`${providerLabel} sub-agent ${statusLabel.toLowerCase()}: ${task}`}
    >
      <div className="subagent-relay-emblem" aria-hidden="true">
        <span className="subagent-relay-avatar">
          {provider ? <ProviderLogo provider={provider} size={15} /> : <UsersRound size={15} />}
          <svg className="sa-avatar-trace" viewBox="0 0 34 34" focusable="false">
            <rect className="sa-avatar-trace-rail" x="1.5" y="1.5" width="31" height="31" rx="8" pathLength="100" />
            <rect className="sa-avatar-trace-runner" x="1.5" y="1.5" width="31" height="31" rx="8" pathLength="100" />
          </svg>
        </span>
      </div>
      <div className="subagent-relay-copy">
        <div className="subagent-relay-identity">
          <span>{providerLabel} sub-agent{count > 1 ? ` wave · ${count}` : ""}</span>
          {model && <code>{model}</code>}
        </div>
        <strong>{task}</strong>
      </div>
      <span className="subagent-relay-status">
        <i aria-hidden="true" />
        {statusLabel}
      </span>
    </article>
  );
});

export const SubAgentRelayManifest = memo(function SubAgentRelayManifest({ activities }: { activities: Activity[] }) {
  const counts = subAgentCountsFromActivities(activities);
  return (
    <section className={`subagent-relay-manifest ${counts.active > 0 ? "live" : ""}`} aria-label={`Sub-agent wave: ${describeSubAgentActivity(counts)}`}>
      <header>
        <UsersRound size={14} aria-hidden="true" />
        <strong>Dispatched {counts.total} sub-agents</strong>
        <small>{describeSubAgentActivity(counts)}</small>
      </header>
      <div className="subagent-relay-list">
        {activities.map((activity, index) => <SubAgentRelayCard activity={activity} dealIndex={index} key={activity.id} />)}
      </div>
    </section>
  );
}, (previous, next) => sameActivities(previous.activities, next.activities));

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
    else if (entry.kind === "spawns") otherSteps += entry.value.length;
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
    if (entry.kind === "commands" || entry.kind === "files" || entry.kind === "spawns") {
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
                      <MessageSquare size={13} />
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

export const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40;

export function shouldCancelTimelineFollowForWheel(deltaY: number, contentOverflows: boolean): boolean {
  return deltaY < 0 && contentOverflows;
}

function TimelineFooter() {
  return <div className="timeline-bottom-space" aria-hidden="true" />;
}

/** The top inset keeps the first message clear of the window edge. */
function TimelineHeader() {
  return <div className="timeline-top-space" aria-hidden="true" />;
}

const NO_SEARCH_MATCHES: number[] = [];

function TimelineEntryContent({
  activeEntryIndex,
  entry,
  index,
  onApprovalRespond,
  onEditMessage,
  provider,
  searchQuery,
}: {
  activeEntryIndex: number;
  entry: TimelineEntry;
  index: number;
  onApprovalRespond?: (approval: PendingApproval, result: JsonObject) => void | Promise<void>;
  onEditMessage?: (text: string) => void;
  provider: Provider;
  searchQuery?: string;
}) {
  const hitClass = index === activeEntryIndex ? " search-hit" : "";
  const row = (className: string, content: ReactNode) => <div className={className}>{content}</div>;
  if (entry.kind === "message") {
    return row(`timeline-entry timeline-entry-message${hitClass}`, <MessageRow message={entry.value} provider={provider} onEdit={onEditMessage} />);
  }
  if (entry.kind === "activity") {
    return row(`timeline-entry timeline-entry-activity${hitClass}`, <ActivityRow activity={entry.value} />);
  }
  if (entry.kind === "commands") {
    return row(`timeline-entry timeline-entry-disclosure${hitClass}`, <CommandDisclosure commands={entry.value} />);
  }
  if (entry.kind === "files") {
    return row(`timeline-entry timeline-entry-disclosure${hitClass}`, <FileDisclosure files={entry.value} />);
  }
  if (entry.kind === "spawns") {
    return row(`timeline-entry timeline-entry-activity${hitClass}`, <SubAgentRelayManifest activities={entry.value} />);
  }
  if (entry.kind === "work") {
    return row(`timeline-entry timeline-entry-disclosure${hitClass}`, <CompletedWorkDisclosure entries={entry.value} reveal={index === activeEntryIndex && Boolean(searchQuery?.trim())} />);
  }
  if (entry.kind === "approval") {
    return row(
      "timeline-entry timeline-entry-approval",
      <InlineApprovalCard approval={entry.value} onRespond={(result) => onApprovalRespond?.(entry.value, result)} />,
    );
  }
  return row("timeline-entry timeline-entry-disclosure", <ReasoningDisclosure detail="" inProgress label={entry.label} />);
}

export function timelineEntryKey(entry: TimelineEntry, index: number): string {
  if (entry.kind === "thinking") return "thinking";
  if (entry.kind === "work") return `work-${(entry.value[0] && workItemId(entry.value[0])) ?? index}`;
  if (entry.kind === "commands" || entry.kind === "files" || entry.kind === "spawns") return `${entry.kind}-${entry.value[0]?.id ?? index}`;
  return `${entry.kind}-${entry.value.id}`;
}

/**
 * The complete transcript is deliberately rendered in ordinary document flow.
 *
 * Absolute virtualized rows can retain a stale height in WKWebView both while
 * streaming and while hydrating an existing thread. A following prompt then
 * paints through the previous answer. Compaction reduces even the historical
 * 2,089-record fixture to 69 rows, so normal flow is fast enough and removes
 * the stale-coordinate failure mode instead of trying to time measurements.
 */
function FlowTimeline({
  activeEntryIndex,
  entries,
  liveSubAgentSummary,
  onApprovalRespond,
  onEditMessage,
  provider,
  searchQuery,
}: {
  activeEntryIndex: number;
  entries: TimelineEntry[];
  liveSubAgentSummary: string;
  onApprovalRespond?: (approval: PendingApproval, result: JsonObject) => void | Promise<void>;
  onEditMessage?: (text: string) => void;
  provider: Provider;
  searchQuery?: string;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingEndRef = useRef(true);
  const pointerNavigationPendingRef = useRef(false);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "auto") => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    followingEndRef.current = true;
    setShowScrollToLatest(false);
    if (typeof scroller.scrollTo === "function") {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior });
    } else {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, []);

  const stopFollowing = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 1) return;
    followingEndRef.current = false;
    setShowScrollToLatest(true);
  }, []);

  useLayoutEffect(() => {
    if (followingEndRef.current) scrollToLatest();
  }, [entries, scrollToLatest]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followingEndRef.current) scrollToLatest();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToLatest]);

  useEffect(() => {
    const clearPointerNavigation = () => {
      pointerNavigationPendingRef.current = false;
    };
    document.addEventListener("pointerup", clearPointerNavigation);
    document.addEventListener("pointercancel", clearPointerNavigation);
    document.addEventListener("touchend", clearPointerNavigation);
    document.addEventListener("touchcancel", clearPointerNavigation);
    return () => {
      document.removeEventListener("pointerup", clearPointerNavigation);
      document.removeEventListener("pointercancel", clearPointerNavigation);
      document.removeEventListener("touchend", clearPointerNavigation);
      document.removeEventListener("touchcancel", clearPointerNavigation);
    };
  }, []);

  useEffect(() => {
    if (activeEntryIndex < 0) return;
    followingEndRef.current = false;
    setShowScrollToLatest(true);
    contentRef.current
      ?.querySelector<HTMLElement>(`[data-entry-index="${activeEntryIndex}"]`)
      ?.scrollIntoView?.({ block: "center" });
  }, [activeEntryIndex]);

  return (
    <div className="timeline-shell" data-scroll-mode={followingEndRef.current ? "following-end" : "free-scrolling"}>
      <span className="sr-only" role="status">{liveSubAgentSummary}</span>
      <div
        ref={scrollerRef}
        className="timeline flow-timeline"
        data-flow-timeline="true"
        data-testid="timeline-scroller"
        tabIndex={0}
        onScroll={(event) => {
          const scroller = event.currentTarget;
          const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
          if (atEnd) {
            followingEndRef.current = true;
            setShowScrollToLatest(false);
          } else if (pointerNavigationPendingRef.current) {
            stopFollowing();
          } else if (!followingEndRef.current) {
            setShowScrollToLatest(true);
          }
        }}
        onWheel={(event) => {
          if (shouldCancelTimelineFollowForWheel(event.deltaY, event.currentTarget.scrollHeight > event.currentTarget.clientHeight + 1)) stopFollowing();
        }}
        onTouchMove={stopFollowing}
        onPointerDown={(event) => {
          if (event.button === 0 && event.currentTarget.scrollHeight > event.currentTarget.clientHeight + 1) {
            pointerNavigationPendingRef.current = true;
          }
        }}
        onKeyDown={(event) => {
          if (
            event.key === "PageUp"
            || event.key === "Home"
            || event.key === "ArrowUp"
            || (event.shiftKey && (event.key === " " || event.key === "Spacebar"))
          ) {
            stopFollowing();
          }
        }}
      >
        <TimelineHeader />
        <div ref={contentRef} className="flow-timeline-list">
          {entries.map((entry, index) => (
            <div data-entry-index={index} key={timelineEntryKey(entry, index)}>
              <TimelineEntryContent
                activeEntryIndex={activeEntryIndex}
                entry={entry}
                index={index}
                onApprovalRespond={onApprovalRespond}
                onEditMessage={onEditMessage}
                provider={provider}
                searchQuery={searchQuery}
              />
            </div>
          ))}
        </div>
        <TimelineFooter />
      </div>
      {showScrollToLatest && (
        <button
          type="button"
          className="timeline-scroll-latest"
          onClick={() => scrollToLatest("smooth")}
          aria-label="Scroll to latest message"
        >
          <ChevronDown size={14} />
          Scroll to latest
        </button>
      )}
    </div>
  );
}

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
  onApprovalRespond?: (approval: PendingApproval, result: JsonObject) => void | Promise<void>;
}) {
  const entries = useMemo<TimelineEntry[]>(() => {
    const next = compactCompletedTurns(orderedTimelineEntries(messages, activities), running);
    if (running && !approval && !messages.some((message) => message.streaming) && !activities.some((activity) => activity.kind === "reasoning" && activity.status === "inProgress")) {
      next.push({ kind: "thinking", label: thinkingLabel });
    }
    if (approval) next.push({ kind: "approval", value: approval });
    return next;
  }, [activities, approval, messages, running, thinkingLabel]);

  const matchIndices = useMemo(() => {
    const query = searchQuery?.trim().toLowerCase();
    if (!query) return NO_SEARCH_MATCHES;
    const hits: number[] = [];
    entries.forEach((entry, index) => {
      const haystack = entry.kind === "message"
        ? entry.value.text
        : entry.kind === "activity"
          ? `${entry.value.title} ${entry.value.detail ?? ""}`
          : entry.kind === "commands"
            ? entry.value.map((command) => `${command.title} ${command.detail ?? ""}`).join(" ")
            : entry.kind === "files" || entry.kind === "spawns"
              ? entry.value.map((activity) => `${activity.title} ${activity.detail ?? ""}`).join(" ")
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
  const liveSubAgentSummary = useMemo(() => {
    const spawns = activities.filter((activity) => activity.kind === "agent" && activity.agent?.action === "spawn");
    return spawns.length ? `Sub-agents: ${describeSubAgentActivity(subAgentCountsFromActivities(spawns))}` : "";
  }, [activities]);
  return (
    <FlowTimeline
      activeEntryIndex={activeEntryIndex}
      entries={entries}
      liveSubAgentSummary={liveSubAgentSummary}
      onApprovalRespond={onApprovalRespond}
      onEditMessage={onEditMessage}
      provider={provider}
      searchQuery={searchQuery}
    />
  );
}
