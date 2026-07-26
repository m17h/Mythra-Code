import { Children, isValidElement, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { Check, ChevronRight, Clipboard, FileCode2, Pencil, Sparkles, TerminalSquare, UsersRound } from "lucide-react";
import Markdown from "react-markdown";
import { Virtuoso } from "react-virtuoso";
import remarkGfm from "remark-gfm";
import type { Activity, ChatMessage, PendingApproval, Provider } from "../types";
import type { JsonObject } from "../lib/codex";
import { InlineApprovalCard } from "./ApprovalCenter";
import { ProviderLogo } from "./BrandLogos";

type TimelineEntry =
  | { kind: "message"; value: ChatMessage }
  | { kind: "activity"; value: Activity }
  | { kind: "commands"; value: Activity[] }
  | { kind: "files"; value: Activity[] }
  | { kind: "thinking"; label: string }
  | { kind: "approval"; value: PendingApproval };

function entryOrder(entry: TimelineEntry): number {
  if (entry.kind === "thinking" || entry.kind === "approval") return Number.MAX_SAFE_INTEGER;
  if (entry.kind === "commands" || entry.kind === "files") return entry.value[0]?.timelineOrder ?? Number.MAX_SAFE_INTEGER;
  return entry.value.timelineOrder ?? Number.MAX_SAFE_INTEGER;
}

function groupToolRuns(entries: TimelineEntry[]): TimelineEntry[] {
  const grouped: TimelineEntry[] = [];
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

export function orderedTimelineEntries(messages: ChatMessage[], activities: Activity[]): TimelineEntry[] {
  // Messages and activities each arrive in ascending timelineOrder, so a
  // linear two-pointer merge replaces an O(n log n) sort on every delta flush.
  // If either input turns out unsorted, fall back to a full sort.
  const entries: TimelineEntry[] = [];
  let sorted = true;
  let messageIndex = 0;
  let activityIndex = 0;
  let previousOrder = Number.MIN_SAFE_INTEGER;
  while (messageIndex < messages.length || activityIndex < activities.length) {
    const messageOrder = messageIndex < messages.length ? messages[messageIndex].timelineOrder ?? Number.MAX_SAFE_INTEGER : Infinity;
    const activityOrder = activityIndex < activities.length ? activities[activityIndex].timelineOrder ?? Number.MAX_SAFE_INTEGER : Infinity;
    let next: TimelineEntry;
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

function textFromCodeNode(node: ReactNode): string {
  const child = Children.toArray(node)[0];
  if (!isValidElement<{ children?: ReactNode }>(child)) return String(node ?? "");
  return String(child.props.children ?? "").replace(/\n$/, "");
}

function CodePre({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = textFromCodeNode(children);
  return (
    <div className="code-block">
      <button
        className="code-copy"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        }}
        title="Copy code"
      >
        {copied ? <Check size={12} /> : <Clipboard size={12} />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

const MessageRow = memo(function MessageRow({ message, provider, onEdit }: { message: ChatMessage; provider: Provider; onEdit?: (text: string) => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <article className={`message ${message.role}`}>
      <div className={`message-avatar ${message.role === "assistant" ? `provider-${provider}` : ""}`}>
        {message.role === "assistant" ? <ProviderLogo provider={provider} size={14} /> : <span>You</span>}
      </div>
      <div className="message-body">
        {!message.streaming && (
          <div className="message-actions">
            <button
              onClick={() => {
                void navigator.clipboard.writeText(message.text);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              }}
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
        {message.streaming ? (
          // Re-parsing Markdown over the whole accumulated text on every delta
          // flush is O(length) per frame; stream as plain text and parse once
          // on completion instead.
          <div className="message-text plain-stream">{message.text}</div>
        ) : (
          <div className="message-text rich-markdown">
            <Markdown remarkPlugins={[remarkGfm]} components={{ pre: CodePre }}>{message.text}</Markdown>
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
                : <Markdown remarkPlugins={[remarkGfm]}>{detail || "Waiting for the model’s thoughts…"}</Markdown>}
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
  const count = activities.length;
  const inProgress = activities.some((activity) => activity.status === "inProgress");
  const isCommand = type === "command";
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

export const CommandDisclosure = memo(function CommandDisclosure({ commands }: { commands: Activity[] }) {
  return <ToolDisclosure activities={commands} type="command" />;
});

export const FileDisclosure = memo(function FileDisclosure({ files }: { files: Activity[] }) {
  return <ToolDisclosure activities={files} type="file" />;
});

export function followTimelineOutput(atBottom: boolean): "auto" | false {
  return atBottom ? "auto" : false;
}

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
    const next = orderedTimelineEntries(messages, activities);
    if (running && !approval && !messages.some((message) => message.streaming) && !activities.some((activity) => activity.kind === "reasoning" && activity.status === "inProgress")) {
      next.push({ kind: "thinking", label: thinkingLabel });
    }
    if (approval) next.push({ kind: "approval", value: approval });
    return next;
  }, [activities, approval, messages, running, thinkingLabel]);

  // In-conversation search: matches are entry indices; the active match is
  // scrolled into view and highlighted.
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const matchIndices = useMemo(() => {
    const query = searchQuery?.trim().toLowerCase();
    if (!query) return [];
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
      data={entries}
      components={VIRTUOSO_COMPONENTS}
      followOutput={followTimelineOutput}
      increaseViewportBy={{ top: 500, bottom: 800 }}
      computeItemKey={(index, entry) => entry.kind === "thinking"
        ? `thinking-${index}`
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
