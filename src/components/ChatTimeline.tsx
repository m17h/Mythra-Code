import { AsyncAgentQuestions } from "./AsyncAgentQuestions";
import { Children, createContext, isValidElement, memo, useCallback, useContext, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode, type Ref } from "react";
import { flushSync } from "react-dom";
import { Check, ChevronDown, ChevronRight, CircleDot, Clipboard, CornerUpRight, FileCode2, FoldVertical, MessageSquarePlus, Pencil, TerminalSquare, UsersRound } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import Markdown, { type Options as MarkdownOptions } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { Element } from "hast";
import type { LocalSkill } from "../lib/skills";
import { remarkSkillMentions } from "../lib/skillMentionMarkdown";
import type { Activity, ChatMessage, PendingApproval, Provider, SkillReference } from "../types";
import type { JsonObject } from "../lib/codex";
import { InlineApprovalCard } from "./ApprovalCenter";
import { SubAgentControls } from "./SubAgentControls";
import { compactActivityPresentation, type CompactWorkState } from "../lib/compactActivity";
import { ActivityStatus, describeLiveActivity, type LiveActivityDescriptor } from "./ActivityStatus";
import { ActivityDetailsModal, workEntrySearchText, type ActivityDetailsRun } from "./ActivityDetailsModal";
import { useFeedbackMessageSource } from "./FeedbackProvider";
import { useTaskStore } from "../lib/taskStore";
import { ProviderLogo } from "./BrandLogos";
import { decodeHtmlEntities } from "../lib/text";
import { providerDisplayName } from "../lib/childAgents";
import { compactionState, compactionTitle } from "../lib/contextCompaction";
import { describeSubAgentActivity, subAgentStatusLabel, workerStatusFromAgentRecord, type SubAgentCounts, type SubAgentWorker } from "../lib/subAgentActivity";
import type { ThreadHistoryState } from "../lib/threadHistory";
import { createStreamingTextFade, type StreamingTextFade } from "../lib/streamingTextFade";
import "./ChatTimeline.compaction.css";
import "./ChatTimeline.skills.css";
import { SkillDependencyDetails } from "./SkillDependencyDetails";
import { createStreamingTextPacer, type StreamingTextPacer } from "../lib/streamingTextPacer";
import { MessageImagePreview } from "./MessageImagePreview";

export type WorkItemEntry =
  | { kind: "message"; value: ChatMessage }
  | { kind: "activity"; value: Activity }
  | { kind: "commands"; value: Activity[] }
  | { kind: "files"; value: Activity[] }
  | { kind: "spawns"; value: Activity[] };

/** Routine work folded behind one quiet status line. `runKey` names the
 * logical run (user direction plus everything it caused) so its details
 * window survives row compaction, remounts and turn completion. */
export type WorkTimelineEntry = {
  kind: "work";
  value: WorkItemEntry[];
  state?: CompactWorkState;
  runKey?: string;
  /** Runtime turn the group belongs to, when the provider tagged one. */
  turnId?: string;
  /** Idle without terminal evidence for the current turn: neither live nor done. */
  unconfirmed?: boolean;
  live?: LiveActivityDescriptor;
};

export type TimelineEntry =
  | WorkItemEntry
  | WorkTimelineEntry
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

/** Where the provider folded its own history is a landmark, not a work step,
 * so it survives completed-turn compaction the way user direction does. */
function isCompactionMarker(entry: WorkItemEntry): boolean {
  return entry.kind === "activity" && entry.value.kind === "compaction";
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
    const staysVisible = entry === finalAssistant
      || isCompactionMarker(entry)
      || (entry.kind === "message" && Boolean(entry.value.questions?.length))
      || (entry.kind === "message" && entry.value.role === "user");
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

function workItemIds(entry: WorkItemEntry): string[] {
  return entry.kind === "message" || entry.kind === "activity" ? [entry.value.id] : entry.value.map((activity) => activity.id);
}

export interface TimelineRun { key: string; entries: WorkItemEntry[] }
interface TimelineRuns { list: TimelineRun[]; byKey: Map<string, TimelineRun>; keyById: Map<string, string> }

/** Key for a running turn that has not produced a transcript entry yet. */
const LIVE_RUN_KEY = "live";

interface ActivitySelection {
  runKey: string;
  memberIds: string[];
  /** Actual runtime turn, so the run survives re-keyed or replaced entries. */
  turnId?: string;
  /** Opened from the live line; may adopt the current run until it resolves. */
  live: boolean;
  focusId?: string;
}

function selectionMembers(entries: WorkItemEntry[]): string[] {
  const ids = entries.flatMap(workItemIds);
  // A few member ids re-find the run if its first entry is re-keyed
  // (optimistic prompt ids) or older history is prepended.
  return ids.length <= 8 ? ids : [...ids.slice(0, 4), ...ids.slice(-4)];
}

function entryHasTurn(entry: WorkItemEntry, turnId: string): boolean {
  return entry.kind === "message" || entry.kind === "activity"
    ? entry.value.turnId === turnId
    : entry.value.some((activity) => activity.turnId === turnId);
}

function runForTurn(runs: TimelineRuns, turnId: string | undefined): TimelineRun | undefined {
  if (!turnId) return undefined;
  for (let index = runs.list.length - 1; index >= 0; index -= 1) {
    if (runs.list[index].entries.some((entry) => entryHasTurn(entry, turnId))) return runs.list[index];
  }
  return undefined;
}

function untagged(entry: WorkItemEntry): boolean {
  return entry.kind === "message" || entry.kind === "activity" ? !entry.value.turnId : entry.value.every((activity) => !activity.turnId);
}

/** Starting a new request can precede its optimistic prompt/runtime id. A
 * completed prior run must not become that new request's activity window. */
function canBeStartingRun(run: TimelineRun): boolean {
  const values = run.entries.flatMap((entry) => entry.kind === "message" || entry.kind === "activity" ? [entry.value] : entry.value);
  // Child work may outlive its parent and stale tool statuses can survive
  // hydration. Neither reopens an explicitly terminal parent turn.
  if (runOutcome(run.entries) !== "unknown") return false;
  if (values.some((value) => ("role" in value && value.streaming) || value.turnStatus === "inProgress"
    || ("kind" in value && ["inProgress", "running", "started", "starting", "pending"].includes(value.status ?? "")))) return true;
  return !values.some((value) => "role" in value && value.role === "assistant"
    && Boolean(value.text.trim() || value.attachments?.length || value.questions?.length));
}

/**
 * The run a live line belongs to. With a known turn, only that turn's run or
 * a still-untagged (optimistic) last run qualifies; a previous turn's
 * history is never relabeled as current work.
 */
function liveRunFor(runs: TimelineRuns, activeTurnId: string | undefined): TimelineRun | undefined {
  const last = runs.list.at(-1);
  const starting = last && canBeStartingRun(last) ? last : undefined;
  if (!activeTurnId) return starting;
  return runForTurn(runs, activeTurnId) ?? (starting?.entries.every(untagged) ? starting : undefined);
}

/** `navigate`: another surface (question, Settings, child thread) owns focus next. */
type ActivityCloseReason = "user" | "approval" | "navigate";

/**
 * Logical runs in original order, segmented exactly like the presentation
 * helper: user direction starts a run; same-turn steering stays inside it.
 * The details window reads these, so hidden work that crossed a visible
 * steer is shown back in its true chronology.
 */
export function timelineRuns(entries: WorkItemEntry[]): TimelineRuns {
  const list: TimelineRun[] = [];
  let current: WorkItemEntry[] = [];
  let hasUser = false;
  let primaryTurnId: string | undefined;
  const flush = () => {
    const first = current[0];
    if (first) list.push({ key: workItemId(first) ?? `run-${list.length}`, entries: current });
    current = [];
  };
  for (const entry of entries) {
    const turnId = workItemTurnId(entry);
    if (entry.kind === "message" && entry.value.role === "user") {
      if (current.length && (!hasUser || !turnId || turnId !== primaryTurnId)) flush();
      hasUser = true;
      primaryTurnId = turnId;
    } else if (hasUser && !primaryTurnId && turnId) primaryTurnId = turnId;
    current.push(entry);
  }
  flush();
  const byKey = new Map<string, TimelineRun>();
  const keyById = new Map<string, string>();
  for (const run of list) {
    byKey.set(run.key, run);
    for (const entry of run.entries) for (const id of workItemIds(entry)) keyById.set(id, run.key);
  }
  return { list, byKey, keyById };
}

/**
 * Chat presentation: user direction, answers and safety stay in chat while
 * each run's routine work folds behind one status line. The live line always
 * sits at the end of the conversation, even before the run has any output.
 */
function presentTimeline(
  ordered: WorkItemEntry[], runs: TimelineRuns, running: boolean, awaiting: "approval" | "input" | null, activeTurnId?: string,
): TimelineEntry[] {
  const output: TimelineEntry[] = [];
  let liveWork: WorkTimelineEntry | undefined;
  for (const entry of compactActivityPresentation(ordered, { running, activeTurnId })) {
    if (entry.kind !== "work") {
      output.push(entry);
      continue;
    }
    const firstId = entry.value[0] ? workItemId(entry.value[0]) : undefined;
    const runKey = (firstId && runs.keyById.get(firstId)) || runs.list.at(-1)?.key || LIVE_RUN_KEY;
    // The helper keeps an idle-but-unfinished current turn as `unknown`
    // work tagged with the actual turn; older unknown history is untagged
    // by that identity and reads as plain settled activity.
    const unconfirmed = !running && entry.state === "unknown" && Boolean(activeTurnId) && entry.turnId === activeTurnId;
    const work: WorkTimelineEntry = { kind: "work", value: entry.value, state: entry.state, runKey, turnId: entry.turnId, unconfirmed };
    if (entry.state === "running" && running) liveWork = work;
    else output.push(work);
  }
  if (running) {
    const run = liveWork?.runKey ? runs.byKey.get(liveWork.runKey) : liveRunFor(runs, activeTurnId);
    const live: WorkTimelineEntry = liveWork ?? { kind: "work", value: [], state: "running", runKey: run?.key ?? LIVE_RUN_KEY, turnId: activeTurnId };
    live.live = describeLiveActivity(run?.entries ?? [], { awaiting, activeTurnId });
    output.push(live);
  }
  return output;
}

function countWorkItems(entries: WorkItemEntry[]): number {
  return entries.reduce((total, entry) => total + (entry.kind === "message" || entry.kind === "activity" ? 1 : entry.value.length), 0);
}

function workSummary(entries: WorkItemEntry[]): string {
  const parts = completedWorkParts(entries);
  const durationMs = completedWorkDuration(entries);
  return (durationMs === undefined ? parts : [`Worked for ${formatCompletedDuration(durationMs)}`, ...parts]).join(" · ");
}

function stepCountLabel(count: number): string {
  return count ? `${count} step${count === 1 ? "" : "s"}` : "";
}

/** Outcome of a run with no folded work, from its own runtime metadata. */
function runOutcome(entries: WorkItemEntry[]): CompactWorkState {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const status = workItemTurnStatus(entries[index]);
    if (status === "completed" || status === "failed" || status === "interrupted") return status;
  }
  return "unknown";
}

const QUESTION_APPROVAL_METHODS = new Set(["item/tool/requestUserInput", "cursor/ask_question", "mcpServer/elicitation/request"]);

/** Whether this thread is blocked on the user, so status never implies progress. */
function awaitingUser(approvals: PendingApproval[] | undefined): "approval" | "input" | null {
  let input = false;
  for (const approval of approvals ?? []) {
    if (approval.method === "item/tool/requestUserInput" && approval.params.isBlocking === false) continue;
    const question = QUESTION_APPROVAL_METHODS.has(approval.method)
      || (approval.method === "claude/can_use_tool" && approval.params.tool_name === "AskUserQuestion");
    if (!question) return "approval";
    input = true;
  }
  return input ? "input" : null;
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
function MarkdownLink({ href, children, node }: { href?: string; children?: ReactNode; node?: Element }) {
  const skillNavigation = useContext(SkillNavigation);
  const path = node?.properties["data-skill-path"];
  const name = node?.properties["data-skill-name"];
  const disabled = node?.properties["data-skill-disabled"];
  const missing = node?.properties["data-skill-missing"];
  if (typeof path === "string" && typeof name === "string") {
    if (missing) return <span className="message-skill-mention unavailable" title={`@${name} is unavailable in the selected skills folder`}>{children}</span>;
    return <a href="#skills" className="message-skill-mention"
      title={`Open @${name} in Settings · Skills${disabled ? " (disabled)" : ""}`}
      onClick={(event) => { event.preventDefault(); skillNavigation?.onOpenSkill?.(path); }}
    >{children}</a>;
  }
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

const FlushStreamingDisplay = createContext<(() => void) | undefined>(undefined);
const SkillNavigation = createContext<{ skills: LocalSkill[]; onOpenSkill?: (path: string) => void } | undefined>(undefined);
const NO_SKILLS: LocalSkill[] = [];

function CodePre({ children }: { children?: ReactNode }) {
  const [copied, copy] = useCopyFeedback();
  const text = textFromCodeNode(children);
  const preRef = useRef<HTMLPreElement>(null);
  const flushDisplay = useContext(FlushStreamingDisplay);
  return (
    <div className="code-block">
      <button
        className="code-copy"
        onClick={() => {
          flushDisplay?.();
          // A completed response may still have a short presentation tail.
          // Copy all received code, not an artificially shortened snapshot.
          copy(preRef.current?.textContent?.replace(/\n$/, "") ?? text);
        }}
        title="Copy code"
      >
        {copied ? <Check size={12} /> : <Clipboard size={12} />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}

const MARKDOWN_COMPONENTS = { pre: CodePre, a: MarkdownLink };
const REASONING_MARKDOWN_COMPONENTS = { a: MarkdownLink };
const DEFAULT_MARKDOWN_PLUGINS = [remarkGfm];
// Model-authored soft newlines are intentional line breaks (for example, poetry).
const ASSISTANT_MARKDOWN_PLUGINS = [remarkGfm, remarkBreaks];

const MessageMarkdown = memo(function MessageMarkdown({ text, rootRef, assistant = false }: { text: string; rootRef?: Ref<HTMLDivElement>; assistant?: boolean }) {
  return (
    <div className="message-text rich-markdown" ref={rootRef}>
      <Markdown remarkPlugins={assistant ? ASSISTANT_MARKDOWN_PLUGINS : DEFAULT_MARKDOWN_PLUGINS} components={MARKDOWN_COMPONENTS}>{text}</Markdown>
    </div>
  );
});

const UserMessageMarkdown = memo(function UserMessageMarkdown({ text, references }: { text: string; references?: SkillReference[] }) {
  const navigation = useContext(SkillNavigation);
  const plugins = useMemo<NonNullable<MarkdownOptions["remarkPlugins"]>>(() => navigation?.skills.length || references !== undefined
    ? [...DEFAULT_MARKDOWN_PLUGINS, [remarkSkillMentions, { text, skills: navigation?.skills ?? NO_SKILLS, references }]]
    : DEFAULT_MARKDOWN_PLUGINS, [text, navigation?.skills, references]);
  return <div className="message-text rich-markdown"><Markdown remarkPlugins={plugins} components={MARKDOWN_COMPONENTS}>{text}</Markdown></div>;
});

/**
 * Format assistant output while it is arriving. Deferring the accumulated
 * text lets React abandon obsolete intermediate parses when tokens arrive
 * faster than the Markdown tree can be built, while still presenting the
 * newest completed render instead of falling back to plain text until the
 * whole response finishes.
 */
export function AssistantMessageMarkdown({ text, streaming }: { text: string; streaming: boolean }) {
  const [pacedText, setPacedText] = useState<string | null>(null);
  const [immediateText, setImmediateText] = useState<string | null>(null);
  const deferredText = useDeferredValue(pacedText ?? text);
  const presenting = streaming || pacedText !== null;
  const shownText = immediateText === text ? text : presenting ? deferredText : text;
  const rootRef = useRef<HTMLDivElement>(null);
  const pacerRef = useRef<StreamingTextPacer | null>(null);
  const fadeRef = useRef<StreamingTextFade | null>(null);
  const wasStreaming = useRef(false);
  const wasReceiving = useRef(false);
  useLayoutEffect(() => () => {
    pacerRef.current?.dispose();
    pacerRef.current = null;
    fadeRef.current?.dispose();
    fadeRef.current = null;
    wasStreaming.current = false;
    wasReceiving.current = false;
  }, []);
  useLayoutEffect(() => {
    if (streaming && rootRef.current) {
      if (!wasReceiving.current) {
        pacerRef.current?.dispose();
        setPacedText(text);
        pacerRef.current = createStreamingTextPacer(rootRef.current, text, setPacedText, () => setPacedText(null));
      } else pacerRef.current?.update(text);
    } else if (wasReceiving.current) {
      // The provider/task is already finished. Let only its bounded visual
      // tail drain, avoiding a final block-sized jump; stored/copy text is full.
      pacerRef.current?.update(text);
      pacerRef.current?.finish();
    } else {
      pacerRef.current?.dispose();
      pacerRef.current = null;
      setPacedText(null);
    }
    wasReceiving.current = streaming;
  }, [text, streaming]);
  useLayoutEffect(() => {
    if (presenting && !wasStreaming.current && rootRef.current) {
      fadeRef.current?.dispose();
      fadeRef.current = createStreamingTextFade(rootRef.current);
    }
    wasStreaming.current = presenting;
    fadeRef.current?.update(shownText);
    if (!presenting) fadeRef.current?.finish();
  }, [shownText, presenting]);
  const flushForCopy = useCallback(() => {
    flushSync(() => {
      pacerRef.current?.flush();
      setPacedText(streaming ? text : null);
      setImmediateText(text);
    });
  }, [text, streaming]);
  // Keep the same Markdown DOM through the bounded completion tail. History
  // mounts create no controllers and show their complete text immediately.
  return <FlushStreamingDisplay.Provider value={presenting ? flushForCopy : undefined}>
    <MessageMarkdown text={shownText} rootRef={rootRef} assistant />
  </FlushStreamingDisplay.Provider>;
}

export const MessageRow = memo(function MessageRow({ message, provider, onEdit }: { message: ChatMessage; provider: Provider; onEdit?: (text: string) => void }) {
  const skillNavigation = useContext(SkillNavigation);
  const dependencies = message.role === "user" && <SkillDependencyDetails report={message.skillDependencies} skills={skillNavigation?.skills} onOpenSkill={skillNavigation?.onOpenSkill} mode="history" />;
  const [copied, copy] = useCopyFeedback();
  const openFeedback = useFeedbackMessageSource(message);
  const attachments = message.role === "user" ? message.attachments ?? [] : [];
  const actions = !message.streaming && (
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
      {openFeedback && (
        <button
          // Keep a selection inside this reply so the note cites just that part.
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => openFeedback(event.currentTarget)}
          title="Add feedback on the selected text, or on this whole reply"
        >
          <MessageSquarePlus size={11} />
          Feedback
        </button>
      )}
    </div>
  );
  const steerStatus = message.role === "user" && message.steerStatus && (
    <div className={`message-steer-status ${message.steerStatus}`} role="status">
      {message.steerStatus === "accepted" ? <Check size={11} /> : <CornerUpRight size={11} />}
      {message.steerStatus === "accepted" ? "Steer accepted by active turn" : "Sending steer…"}
    </div>
  );
  const avatar = (
    <div className={`message-avatar ${message.role === "assistant" ? `provider-${provider}` : ""}`}>
      {message.role === "assistant" ? <ProviderLogo provider={provider} size={14} /> : <span>You</span>}
    </div>
  );
  if (attachments.length > 0) {
    // A prompt sent with images: the photos share one bubble and the typed
    // text follows in its own bubble underneath, so the images read as a
    // distinct item rather than a footnote to the prose.
    return (
      <article className={`message ${message.role} with-attachments`}>
        {avatar}
        <div className="message-stack">
          {actions}
          <div className="message-body message-attachments" data-count={attachments.length}>
            <div className="message-image-previews" aria-label="Attached images">
              {attachments.map((attachment) => (
                <MessageImagePreview key={attachment.path} path={attachment.path} name={attachment.name} />
              ))}
            </div>
          </div>
          {message.text.trim() !== "" && (
            <div className="message-body">
              <UserMessageMarkdown text={message.text} references={message.skillReferences} />
            </div>
          )}
          {steerStatus}
          {dependencies}
        </div>
      </article>
    );
  }
  return (
    <article className={`message ${message.role}`}>
      {avatar}
      <div className="message-body">
        {actions}
        {message.role === "assistant"
          // One stable wrapper keeps the Markdown DOM (and its completion tail)
          // intact when a finished reply becomes a feedback source.
          ? <div className="message-feedback-source" data-feedback-message={openFeedback ? message.id : undefined}>
            <AssistantMessageMarkdown text={message.text} streaming={Boolean(message.streaming)} />
          </div>
          : <UserMessageMarkdown text={message.text} references={message.skillReferences} />}
        {message.role === "assistant" && message.questions?.length ? <AsyncAgentQuestions message={message} /> : null}
        {steerStatus}
        {dependencies}
        {message.streaming && <span className="stream-caret" />}
      </div>
    </article>
  );
});

/**
 * Provider-native context compaction, drawn as a fold in the transcript. The
 * seam only marks where the provider summarised its own history; nothing the
 * reader has already seen is removed or rewritten.
 */
export const ContextCompactionMarker = memo(function ContextCompactionMarker({ activity }: { activity: Activity }) {
  // The heading is recomputed rather than read from the stored title: a turn
  // that ends before its compaction reports completion has the status settled
  // underneath us, and a stale "Compacting context" would keep implying work.
  const state = compactionState(activity.status);
  const heading = compactionTitle(activity.status);
  return (
    <div
      className={`context-compaction ${state}`}
      role={state === "active" ? "status" : "group"}
    >
      <span className="context-compaction-seam" aria-hidden="true" />
      <span className="context-compaction-pill">
        <span className="context-compaction-glyph" aria-hidden="true"><FoldVertical size={12} /></span>
        <strong>{heading}</strong>
        {activity.detail && <small>{activity.detail}</small>}
      </span>
      <span className="context-compaction-seam" aria-hidden="true" />
    </div>
  );
});

export const ActivityRow = memo(function ActivityRow({ activity }: { activity: Activity }) {
  const [expanded, setExpanded] = useState(false);
  if (activity.kind === "compaction") {
    return <ContextCompactionMarker activity={activity} />;
  }
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
    if (status !== "idle" && status !== "unknown") counts[status] += count;
  }
  return counts;
}

export const SubAgentRelayCard = memo(function SubAgentRelayCard({ activity, dealIndex }: { activity: Activity; dealIndex?: number }) {
  const metadata = activity.agent;
  const controls = useContext(SubAgentControls);
  const childId = metadata?.threadIds?.length === 1 ? metadata.threadIds[0] : undefined;
  const worker = controls?.workers.find((entry) => entry.id === childId);
  const failure = useTaskStore((state) => childId ? state.tasks[childId]?.error : undefined);
  const [action, setAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const active = worker?.status === "starting" || worker?.status === "working";
  const elapsed = worker && worker.createdAt > 0 && (active || worker.finishedAt)
    ? Math.max(0, Math.floor(((worker.finishedAt ?? controls!.now) - worker.createdAt) / 1000)) : null;
  const runAction = async (kind: "open" | "stop") => {
    if (!worker || !controls || action) return;
    setAction(kind);
    setActionError(null);
    try { await (kind === "open" ? controls.onOpen(worker) : controls.onStop(worker)); }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { setAction(null); }
  };
  const provider = metadata?.provider;
  const status = worker?.status ?? workerStatusFromAgentRecord(activity.status ?? "");
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
        </span>
      </div>
      <div className="subagent-relay-copy">
        <div className="subagent-relay-identity">
          <span>{providerLabel} sub-agent{count > 1 ? ` wave · ${count}` : ""}</span>
          {model && <code>{model}</code>}
        </div>
        <strong>{task}</strong>
        {elapsed !== null && <small>{Math.floor(elapsed / 60)}m {elapsed % 60}s{active ? " elapsed" : " total"}</small>}
        {status === "failed" && failure && <small role="status">{failure}</small>}
        {worker && <div className="subagent-relay-actions">
          <button type="button" disabled={Boolean(action)} onClick={() => void runAction("open")}>Open sub-agent</button>
          {active && <button type="button" disabled={Boolean(action)} onClick={() => void runAction("stop")}>Stop sub-agent</button>}
        </div>}
        {actionError && <small role="alert">{actionError}</small>}
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

/** Details-window renderers: chat-quality Markdown (including working skill
 * mentions) and sub-agent relay cards with their Open/Stop controls. */
function renderActivityMessage(message: ChatMessage): ReactNode {
  return message.role === "user"
    ? <UserMessageMarkdown text={message.text} references={message.skillReferences} />
    : <AssistantMessageMarkdown text={message.text} streaming={Boolean(message.streaming)} />;
}

function renderActivitySubAgents(activities: Activity[]): ReactNode {
  return activities.length === 1 ? <SubAgentRelayCard activity={activities[0]} /> : <SubAgentRelayManifest activities={activities} />;
}

/**
 * Compatibility wrapper for a standalone completed-work group. The quiet line
 * opens the details window; it never expands work inline in chat.
 */
export const CompletedWorkDisclosure = memo(function CompletedWorkDisclosure({ entries, reveal = false, skills, onOpenSkill }: { entries: WorkItemEntry[]; reveal?: boolean; skills?: LocalSkill[]; onOpenSkill?: (path: string) => void }) {
  const parentNavigation = useContext(SkillNavigation);
  const navigation = useMemo(() => skills ? { skills, onOpenSkill } : parentNavigation, [skills, onOpenSkill, parentNavigation]);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (reveal) setOpen(true);
  }, [reveal]);
  const close = useCallback(() => setOpen(false), []);
  const summary = workSummary(entries) || stepCountLabel(countWorkItems(entries));
  const run = useMemo<ActivityDetailsRun>(() => ({ entries, state: "completed", summary }), [entries, summary]);
  return (
    <SkillNavigation.Provider value={navigation}>
      <span ref={anchorRef} hidden />
      <ActivityStatus state="completed" summary={summary} open={open} onOpen={() => setOpen(true)} />
      {open && <ActivityDetailsModal run={run} sourceRef={anchorRef} renderMessage={renderActivityMessage} renderSubAgents={renderActivitySubAgents} onClose={close} />}
    </SkillNavigation.Provider>
  );
}, (previous, next) => previous.skills === next.skills && previous.onOpenSkill === next.onOpenSkill && (previous.reveal ?? false) === (next.reveal ?? false) && sameWorkItems(previous.entries, next.entries));

const WorkStatusRow = memo(function WorkStatusRow({ entry, open, searchMatches, onOpenActivity }: {
  entry: WorkTimelineEntry;
  open: boolean;
  searchMatches: number;
  onOpenActivity: (entry: WorkTimelineEntry, opener: HTMLElement | null) => void;
}) {
  const state = entry.state ?? "completed";
  const live = state === "running";
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const onOpen = useCallback((opener: HTMLButtonElement) => onOpenActivity(entryRef.current, opener), [onOpenActivity]);
  const summary = live ? stepCountLabel(countWorkItems(entry.value)) : workSummary(entry.value) || stepCountLabel(countWorkItems(entry.value));
  return <ActivityStatus
    state={state}
    label={live ? entry.live?.label : undefined}
    category={entry.live?.category}
    playful={entry.live?.playful}
    unconfirmed={entry.unconfirmed}
    seed={entry.runKey}
    summary={summary}
    searchMatches={searchMatches}
    runKey={entry.runKey}
    open={open}
    onOpen={onOpen}
  />;
}, (previous, next) => previous.open === next.open && previous.searchMatches === next.searchMatches
  && previous.onOpenActivity === next.onOpenActivity && previous.entry.state === next.entry.state
  && previous.entry.unconfirmed === next.entry.unconfirmed && previous.entry.runKey === next.entry.runKey && previous.entry.live?.label === next.entry.live?.label
  && previous.entry.live?.category === next.entry.live?.category && previous.entry.live?.playful === next.entry.live?.playful
  && sameWorkItems(previous.entry.value, next.entry.value));

export const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40;
export const TIMELINE_MOUNT_ROWS = 40;

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

/** A request to mount, scroll to and focus one exact row (by entry key). */
interface TimelineReveal { key: string; token: number }

/** Timeline-scoped details selection, threaded to the virtualized rows. */
interface ActivityRowControls {
  openRunKey: string | null;
  onOpen: (entry: WorkTimelineEntry, opener: HTMLElement | null) => void;
}

function matchingWorkItems(entries: WorkItemEntry[], query: string): number {
  return entries.reduce((total, entry) => {
    if (entry.kind === "message" || entry.kind === "activity") return total + (workEntrySearchText(entry).toLowerCase().includes(query) ? 1 : 0);
    return total + entry.value.filter((activity) => `${activity.title} ${activity.detail ?? ""}`.toLowerCase().includes(query)).length;
  }, 0);
}

function TimelineEntryContent({
  activeEntryIndex,
  activity,
  entry,
  index,
  onApprovalRespond,
  onEditMessage,
  provider,
  searchQuery,
}: {
  activeEntryIndex: number;
  activity: ActivityRowControls;
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
    const query = index === activeEntryIndex ? searchQuery?.trim().toLowerCase() : "";
    return row(`timeline-entry timeline-entry-status${hitClass}`, <WorkStatusRow
      entry={entry}
      open={Boolean(entry.runKey) && activity.openRunKey === entry.runKey}
      searchMatches={query ? matchingWorkItems(entry.value, query) : 0}
      onOpenActivity={activity.onOpen}
    />);
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
  // One live line keeps its DOM through every status change of the run.
  if (entry.kind === "work" && entry.state === "running") return "work-live";
  if (entry.kind === "work") return `work-${(entry.value[0] && workItemId(entry.value[0])) ?? index}`;
  if (entry.kind === "commands" || entry.kind === "files" || entry.kind === "spawns") return `${entry.kind}-${entry.value[0]?.id ?? index}`;
  return `${entry.kind}-${entry.value.id}`;
}

type PrependAnchor =
  | { kind: "local"; scrollHeight: number; scrollTop: number; element: HTMLElement | null; elementTop: number | null; expectHiddenPrefix: number }
  | { kind: "server"; scrollHeight: number; scrollTop: number; element: HTMLElement | null; elementTop: number | null; previousFirstKey: string | null; sawLoading: boolean };

/**
 * Rows stay in ordinary document flow because absolute virtualization can
 * retain stale heights in WKWebView while streaming. Only a bounded suffix is
 * mounted initially; readers can reveal older in-memory rows in anchored
 * chunks, preserving normal layout without paying to parse the whole DOM.
 */
function FlowTimeline({
  activeEntryIndex,
  activity,
  entries,
  liveSubAgentSummary,
  history,
  onLoadEarlier,
  onApprovalRespond,
  onEditMessage,
  provider,
  reveal,
  searchQuery,
}: {
  activeEntryIndex: number;
  activity: ActivityRowControls;
  entries: TimelineEntry[];
  reveal?: TimelineReveal | null;
  liveSubAgentSummary: string;
  history?: ThreadHistoryState;
  onLoadEarlier?: () => void;
  onApprovalRespond?: (approval: PendingApproval, result: JsonObject) => void | Promise<void>;
  onEditMessage?: (text: string) => void;
  provider: Provider;
  searchQuery?: string;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const revealPendingRef = useRef<string | null>(null);
  const revealFocusRef = useRef<(() => void) | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingEndRef = useRef(true);
  const searchWasActiveRef = useRef(false);
  const smoothScrollPendingRef = useRef(false);
  const pointerNavigationPendingRef = useRef(false);
  const prependAnchorRef = useRef<PrependAnchor | null>(null);
  const restoringPrependScrollRef = useRef(false);
  const restoredPrependScrollPendingRef = useRef(false);
  const restoredPrependScrollTopRef = useRef<number | null>(null);
  const restoredPrependScrollUserIntentRef = useRef(false);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const [hiddenPrefixOverride, setHiddenPrefixOverride] = useState<number | null>(null);
  const [anchoring, setAnchoring] = useState(false);
  const [windowAnnouncement, setWindowAnnouncement] = useState("");
  const automaticHiddenPrefix = Math.max(0, entries.length - TIMELINE_MOUNT_ROWS);
  const hiddenPrefixCount = hiddenPrefixOverride === null
    ? automaticHiddenPrefix
    : Math.min(Math.max(0, hiddenPrefixOverride), automaticHiddenPrefix);
  const suffixEntries = entries.slice(hiddenPrefixCount);
  const searching = Boolean(searchQuery?.trim()) && activeEntryIndex >= 0;
  const searchWindowStart = searching && activeEntryIndex < hiddenPrefixCount
    ? Math.max(0, activeEntryIndex - Math.floor(TIMELINE_MOUNT_ROWS / 2))
    : null;
  const searchWindowEnd = searchWindowStart === null
    ? null
    : Math.min(hiddenPrefixCount, searchWindowStart + TIMELINE_MOUNT_ROWS);
  const hiddenSearchGap = searchWindowEnd === null ? 0 : hiddenPrefixCount - searchWindowEnd;
  const firstEntryKey = entries[0] ? timelineEntryKey(entries[0], 0) : null;

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
    setHiddenPrefixOverride((current) => current ?? hiddenPrefixCount);
    setShowScrollToLatest(true);
  }, [hiddenPrefixCount]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const anchor = prependAnchorRef.current;
    if (anchor?.kind === "server" && history?.loading) anchor.sawLoading = true;
    const localReady = anchor?.kind === "local" && hiddenPrefixCount <= anchor.expectHiddenPrefix;
    const serverReady = anchor?.kind === "server"
      && !history?.loading
      && (anchor.sawLoading || anchor.previousFirstKey !== firstEntryKey);
    if (anchor && scroller && (localReady || serverReady)) {
      const serverPrepended = anchor.kind !== "server" || anchor.previousFirstKey !== firstEntryKey;
      if (serverPrepended) {
        const nextTop = anchor.element?.isConnected ? anchor.element.getBoundingClientRect().top : null;
        const visualDelta = nextTop !== null && anchor.elementTop !== null ? nextTop - anchor.elementTop : null;
        // WebKit may dispatch the scroll event caused by this restoration after
        // the next animation frame. Keep it from looking like manual navigation
        // until a new user gesture actually moves the scroll position.
        restoredPrependScrollPendingRef.current = true;
        restoredPrependScrollTopRef.current = null;
        restoredPrependScrollUserIntentRef.current = false;
        // The measured rectangle already includes any native/focus scroll
        // correction. Applying its remaining delta to the old scrollTop would
        // undo that correction and jump by the height of the inserted rows.
        scroller.scrollTop = visualDelta === null
          ? anchor.scrollTop + (scroller.scrollHeight - anchor.scrollHeight)
          : scroller.scrollTop + visualDelta;
        restoredPrependScrollTopRef.current = scroller.scrollTop;
      }
      if (scroller.scrollHeight <= scroller.clientHeight + 1) {
        followingEndRef.current = true;
        setShowScrollToLatest(false);
      }
      prependAnchorRef.current = null;
      setAnchoring(false);
      if (restoringPrependScrollRef.current) {
        requestAnimationFrame(() => { restoringPrependScrollRef.current = false; });
      }
      return;
    }
    if (anchor) return;
    if (followingEndRef.current && !smoothScrollPendingRef.current) scrollToLatest();
  }, [entries, firstEntryKey, hiddenPrefixCount, history?.loading, scrollToLatest]);

  const revealEarlier = useCallback(() => {
    const scroller = scrollerRef.current;
    const nextHiddenPrefix = Math.max(0, hiddenPrefixCount - TIMELINE_MOUNT_ROWS);
    restoringPrependScrollRef.current = true;
    if (scroller) {
      const element = contentRef.current?.querySelector<HTMLElement>(`[data-entry-index="${hiddenPrefixCount}"]`) ?? null;
      prependAnchorRef.current = {
        kind: "local",
        scrollHeight: scroller.scrollHeight,
        scrollTop: scroller.scrollTop,
        element,
        elementTop: element?.getBoundingClientRect().top ?? null,
        expectHiddenPrefix: nextHiddenPrefix,
      };
    }
    followingEndRef.current = false;
    setShowScrollToLatest(true);
    setAnchoring(true);
    setHiddenPrefixOverride(nextHiddenPrefix);
    setWindowAnnouncement(`Showing ${entries.length - nextHiddenPrefix} of ${entries.length} loaded timeline entries.`);
  }, [entries.length, hiddenPrefixCount]);

  const loadEarlierFromServer = useCallback(() => {
    const scroller = scrollerRef.current;
    if (scroller) {
      const anchor = prependAnchorRef.current;
      if (!anchor) {
        const element = contentRef.current?.querySelector<HTMLElement>('[data-entry-index="0"]') ?? null;
        prependAnchorRef.current = {
          kind: "server",
          scrollHeight: scroller.scrollHeight,
          scrollTop: scroller.scrollTop,
          element,
          elementTop: element?.getBoundingClientRect().top ?? null,
          previousFirstKey: firstEntryKey,
          sawLoading: Boolean(history?.loading),
        };
      }
    }
    followingEndRef.current = false;
    setHiddenPrefixOverride(0);
    setShowScrollToLatest(true);
    onLoadEarlier?.();
  }, [firstEntryKey, history?.loading, onLoadEarlier]);

  const activateHistoryControl = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    if (hiddenPrefixCount > 0) {
      // WebKit can deliver a deferred focus reveal after keyboard activation.
      // Move focus to the scroll region so it cannot reset scrollTop after the
      // local prepend anchor has been restored. Server pagination keeps the
      // loading control focused while its request is in flight.
      if (event.detail === 0) scrollerRef.current?.focus({ preventScroll: true });
      revealEarlier();
      return;
    }
    loadEarlierFromServer();
  }, [hiddenPrefixCount, loadEarlierFromServer, revealEarlier]);

  // Mount the requested row if it lies above the bounded suffix, without
  // letting live follow pull the reader away from it.
  useLayoutEffect(() => {
    if (!reveal) return;
    const index = entries.findIndex((entry, position) => timelineEntryKey(entry, position) === reveal.key);
    if (index < 0) return;
    revealPendingRef.current = reveal.key;
    followingEndRef.current = false;
    setShowScrollToLatest(true);
    if (index < hiddenPrefixCount) setHiddenPrefixOverride(index);
    else setHiddenPrefixOverride((current) => current ?? hiddenPrefixCount);
    // Only a new request reveals; later entry changes must not re-scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);
  useLayoutEffect(() => {
    const key = revealPendingRef.current;
    if (!key) return;
    const row = Array.from(contentRef.current?.querySelectorAll<HTMLElement>("[data-entry-key]") ?? [])
      .find((element) => element.dataset.entryKey === key);
    if (!row) return;
    revealPendingRef.current = null;
    revealFocusRef.current?.();
    row.scrollIntoView?.({ block: "center" });
    const findField = () => row.querySelector<HTMLElement>(".agent-question-form input, .agent-question-form textarea, .agent-question-form button");
    const field = findField();
    if (field) {
      field.focus({ preventScroll: true });
      return;
    }
    // A freshly mounted question loads its form lazily. Hold focus on the
    // timeline (never an unrelated control) and hand it over on arrival,
    // unless the user has moved focus meanwhile.
    const scroller = scrollerRef.current;
    scroller?.focus({ preventScroll: true });
    const observer = new MutationObserver(() => {
      const next = findField();
      if (!next) return;
      stop();
      if (document.activeElement === scroller || document.activeElement === document.body) next.focus({ preventScroll: true });
    });
    const timer = window.setTimeout(() => stop(), 5_000);
    const stop = () => {
      observer.disconnect();
      window.clearTimeout(timer);
      revealFocusRef.current = null;
    };
    revealFocusRef.current = stop;
    observer.observe(row, { childList: true, subtree: true });
  });
  useEffect(() => () => revealFocusRef.current?.(), []);

  const jumpToLatest = useCallback(() => {
    restoredPrependScrollPendingRef.current = false;
    restoredPrependScrollTopRef.current = null;
    restoredPrependScrollUserIntentRef.current = false;
    followingEndRef.current = true;
    smoothScrollPendingRef.current = true;
    setHiddenPrefixOverride(null);
    setShowScrollToLatest(false);
    requestAnimationFrame(() => {
      scrollToLatest("smooth");
      smoothScrollPendingRef.current = false;
    });
  }, [scrollToLatest]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followingEndRef.current && !smoothScrollPendingRef.current) scrollToLatest();
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
    if (activeEntryIndex >= 0) {
      searchWasActiveRef.current = true;
      followingEndRef.current = false;
      setShowScrollToLatest(true);
      contentRef.current
        ?.querySelector<HTMLElement>(`[data-entry-index="${activeEntryIndex}"]`)
        ?.scrollIntoView?.({ block: "center" });
      return;
    }
    if (!searchWasActiveRef.current) return;
    searchWasActiveRef.current = false;
    const scroller = scrollerRef.current;
    if (scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX) {
      followingEndRef.current = true;
      setHiddenPrefixOverride(null);
      setShowScrollToLatest(false);
    }
  }, [activeEntryIndex]);

  return (
    <div className="timeline-shell" data-scroll-mode={followingEndRef.current ? "following-end" : "free-scrolling"}>
      <span className="sr-only" role="status">{[liveSubAgentSummary, windowAnnouncement].filter(Boolean).join(" ")}</span>
      <div
        ref={scrollerRef}
        className="timeline flow-timeline"
        role="region"
        aria-label="Conversation timeline"
        data-flow-timeline="true"
        data-testid="timeline-scroller"
        tabIndex={0}
        onFocusCapture={(event) => {
          if (event.target.closest(".timeline-history-control")) {
            // Focusing the history control scrolls it into view. Stop live
            // following before ResizeObserver can pull keyboard readers back
            // to the newest message.
            stopFollowing();
            return;
          }
          if (!event.target.closest(".agent-question-form")) return;
          // Keep the question in place while the user answers, even as new
          // output grows below it or the transcript window advances.
          followingEndRef.current = false;
          setHiddenPrefixOverride((current) => current ?? hiddenPrefixCount);
          setShowScrollToLatest(true);
        }}
        onScroll={(event) => {
          // Revealing older rows adjusts scrollTop to preserve the reader's
          // position. That programmatic scroll must not re-arm live following
          // and immediately discard the newly revealed window.
          if (anchoring || prependAnchorRef.current || restoringPrependScrollRef.current) return;
          const scroller = event.currentTarget;
          if (restoredPrependScrollPendingRef.current) {
            const restoredTop = restoredPrependScrollTopRef.current;
            const movedAfterIntent = restoredPrependScrollUserIntentRef.current
              && restoredTop !== null
              && Math.abs(scroller.scrollTop - restoredTop) > 0.5;
            if (!movedAfterIntent) return;
            restoredPrependScrollPendingRef.current = false;
            restoredPrependScrollTopRef.current = null;
            restoredPrependScrollUserIntentRef.current = false;
          }
          const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
          const answeringQuestion = scroller.contains(document.activeElement) && document.activeElement?.closest(".agent-question-form");
          if (atEnd && !answeringQuestion) {
            followingEndRef.current = true;
            setHiddenPrefixOverride(null);
            setShowScrollToLatest(false);
          } else if (pointerNavigationPendingRef.current) {
            stopFollowing();
          } else if (!followingEndRef.current) {
            setShowScrollToLatest(true);
          }
        }}
        onWheel={(event) => {
          restoredPrependScrollUserIntentRef.current = true;
          if (shouldCancelTimelineFollowForWheel(event.deltaY, event.currentTarget.scrollHeight > event.currentTarget.clientHeight + 1)) stopFollowing();
        }}
        onTouchMove={() => {
          restoredPrependScrollUserIntentRef.current = true;
          stopFollowing();
        }}
        onPointerDown={(event) => {
          // Child pointer input (copy buttons, links, selection) is not a new
          // scroll gesture and must not expose a delayed restoration event.
          if (event.target === event.currentTarget) restoredPrependScrollUserIntentRef.current = true;
          if (event.button === 0 && event.currentTarget.scrollHeight > event.currentTarget.clientHeight + 1) {
            pointerNavigationPendingRef.current = true;
          }
        }}
        onKeyDown={(event) => {
          const targetIsControl = event.target instanceof Element
            && Boolean(event.target.closest("button, input, select, textarea, [role=button]"));
          if (
            event.key === "PageUp"
            || event.key === "PageDown"
            || event.key === "Home"
            || event.key === "End"
            || event.key === "ArrowUp"
            || event.key === "ArrowDown"
            || event.key === "Tab"
            || ((event.key === " " || event.key === "Spacebar") && !targetIsControl)
          ) {
            restoredPrependScrollUserIntentRef.current = true;
          }
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
        {(hiddenPrefixCount > 0 || (history?.paginated && history.hasMore)) && !searching && (
          <div className="timeline-history-control">
            <button
              type="button"
              data-testid={hiddenPrefixCount > 0 ? "reveal-earlier" : "load-earlier"}
              disabled={anchoring || (hiddenPrefixCount === 0 && (history?.loading || !onLoadEarlier))}
              aria-busy={anchoring || (hiddenPrefixCount === 0 && history?.loading)}
              onClick={activateHistoryControl}
            >
              {hiddenPrefixCount > 0
                ? `Show ${Math.min(TIMELINE_MOUNT_ROWS, hiddenPrefixCount)} earlier messages`
                : history?.loading
                  ? "Loading earlier messages…"
                  : "Load earlier messages"}
            </button>
          </div>
        )}
        <TimelineHeader />
        <div ref={contentRef} className="flow-timeline-list">
          {searchWindowStart !== null && searchWindowEnd !== null && entries.slice(searchWindowStart, searchWindowEnd).map((entry, offset) => {
            const index = searchWindowStart + offset;
            return <div data-entry-index={index} data-entry-kind={entry.kind} data-entry-key={timelineEntryKey(entry, index)} key={timelineEntryKey(entry, index)}>
              <TimelineEntryContent
                activeEntryIndex={activeEntryIndex}
                activity={activity}
                entry={entry}
                index={index}
                onApprovalRespond={onApprovalRespond}
                onEditMessage={onEditMessage}
                provider={provider}
                searchQuery={searchQuery}
              />
            </div>;
          })}
          {searchWindowEnd !== null && hiddenSearchGap > 0 && (
            <div className="timeline-window-gap" role="note">{hiddenSearchGap} entries between this result and the latest conversation</div>
          )}
          {suffixEntries.map((entry, offset) => {
            const index = hiddenPrefixCount + offset;
            return <div data-entry-index={index} data-entry-kind={entry.kind} data-entry-key={timelineEntryKey(entry, index)} key={timelineEntryKey(entry, index)}>
              <TimelineEntryContent
                activeEntryIndex={activeEntryIndex}
                activity={activity}
                entry={entry}
                index={index}
                onApprovalRespond={onApprovalRespond}
                onEditMessage={onEditMessage}
                provider={provider}
                searchQuery={searchQuery}
              />
            </div>;
          })}
        </div>
        <TimelineFooter />
      </div>
      {showScrollToLatest && (
        <button
          type="button"
          className="timeline-scroll-latest"
          onClick={jumpToLatest}
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
  activeTurnId,
  approval,
  provider = "openai",
  searchQuery,
  searchActiveMatch,
  onSearchMatches,
  history,
  onLoadEarlier,
  onEditMessage,
  onApprovalRespond,
  skills = NO_SKILLS,
  onOpenSkill,
}: {
  messages: ChatMessage[];
  activities: Activity[];
  running: boolean;
  /** The task store's actual current turn; idle notifications may precede its end. */
  activeTurnId?: string;
  /** Retained for callers; the live status line now names concrete activity. */
  thinkingLabel: string;
  approval?: PendingApproval | null;
  provider?: Provider;
  searchQuery?: string;
  searchActiveMatch?: number;
  onSearchMatches?: (count: number) => void;
  history?: ThreadHistoryState;
  onLoadEarlier?: () => void;
  onEditMessage?: (text: string) => void;
  onApprovalRespond?: (approval: PendingApproval, result: JsonObject) => void | Promise<void>;
  skills?: LocalSkill[];
  onOpenSkill?: (path: string) => void;
}) {
  const skillNavigation = useMemo(() => ({ skills, onOpenSkill }), [skills, onOpenSkill]);
  const storeAwaiting = useTaskStore((state) => {
    const threadId = state.activeThreadId;
    return threadId ? awaitingUser(state.tasks[threadId]?.approvals) : null;
  });
  const awaiting = storeAwaiting ?? (approval ? "approval" : null);
  const ordered = useMemo(() => orderedTimelineEntries(messages, activities), [messages, activities]);
  const runs = useMemo(() => timelineRuns(ordered), [ordered]);
  const presented = useMemo(() => presentTimeline(ordered, runs, running, awaiting, activeTurnId), [activeTurnId, awaiting, ordered, runs, running]);
  const entries = useMemo<TimelineEntry[]>(() => approval ? [...presented, { kind: "approval", value: approval }] : presented, [approval, presented]);

  const matchIndices = useMemo(() => {
    const query = searchQuery?.trim().toLowerCase();
    if (!query) return NO_SEARCH_MATCHES;
    const hits: number[] = [];
    entries.forEach((entry, index) => {
      const haystack = entry.kind === "work"
        ? entry.value.map(workEntrySearchText).join(" ")
        : entry.kind === "thinking" || entry.kind === "approval" ? "" : workEntrySearchText(entry);
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

  // ---- Activity details: owned here, never by a (virtualized) row ----
  const [selection, setSelection] = useState<ActivitySelection | null>(null);
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const openerRef = useRef<HTMLElement | null>(null);
  const closeReasonRef = useRef<ActivityCloseReason>("user");
  const lastRunKeyRef = useRef<string | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const openActivity = useCallback((entry: WorkTimelineEntry, opener: HTMLElement | null, focusId?: string) => {
    const runKey = entry.runKey ?? LIVE_RUN_KEY;
    const run = runsRef.current.byKey.get(runKey);
    openerRef.current = opener;
    closeReasonRef.current = "user";
    lastRunKeyRef.current = runKey;
    setSelection({
      runKey,
      memberIds: selectionMembers(run ? run.entries : entry.value),
      turnId: entry.turnId,
      live: entry.state === "running",
      focusId: focusId ?? (entry.state === "running" || !entry.value[0] ? undefined : workItemId(entry.value[0])),
    });
  }, []);
  const closeActivity = useCallback((reason: ActivityCloseReason = "user") => {
    closeReasonRef.current = reason;
    setSelection(null);
  }, []);
  const activityControls = useMemo<ActivityRowControls>(() => ({ openRunKey: selection?.runKey ?? null, onOpen: openActivity }), [openActivity, selection?.runKey]);

  const selectedRun = useMemo<TimelineRun | undefined>(() => {
    if (!selection) return undefined;
    const direct = runs.byKey.get(selection.runKey);
    if (direct) return direct;
    for (const id of selection.memberIds) {
      const key = runs.keyById.get(id);
      if (key) return runs.byKey.get(key);
    }
    const byTurn = runForTurn(runs, selection.turnId);
    if (byTurn) return byTurn;
    // Opened before the run had (stable) entries: adopt the current run.
    if (selection.live && running) return liveRunFor(runs, activeTurnId) ?? { key: LIVE_RUN_KEY, entries: [] };
    return undefined;
  }, [activeTurnId, running, runs, selection]);
  // Latch the resolved run's identity as entries arrive, so completion (which
  // ends the live fallback) or a re-keyed prompt never loses the window.
  useEffect(() => {
    if (!selection || !selectedRun || selectedRun.key === LIVE_RUN_KEY) return;
    const memberIds = selectionMembers(selectedRun.entries);
    const turnId = selection.turnId ?? (selection.live ? activeTurnId : undefined)
      ?? selectedRun.entries.map(workItemTurnId).find(Boolean);
    if (selectedRun.key === selection.runKey && turnId === selection.turnId
      && memberIds.length === selection.memberIds.length && memberIds.every((id, index) => id === selection.memberIds[index])) return;
    lastRunKeyRef.current = selectedRun.key;
    setSelection((current) => current && { ...current, runKey: selectedRun.key, memberIds, turnId });
  }, [activeTurnId, selectedRun, selection]);
  // A run that no longer exists (thread history replaced) closes cleanly.
  useEffect(() => {
    if (selection && !selectedRun) closeActivity();
  }, [closeActivity, selectedRun, selection]);

  const details = useMemo(() => {
    if (!selectedRun) return undefined;
    const groups = presented.filter((entry): entry is WorkTimelineEntry => entry.kind === "work" && entry.runKey === selectedRun.key);
    const hidden = groups.flatMap((group) => group.value);
    const hiddenIds = new Set(hidden.flatMap(workItemIds));
    const visibleIds = new Set(selectedRun.entries.flatMap(workItemIds).filter((id) => !hiddenIds.has(id)));
    const liveGroup = groups.find((group) => group.state === "running");
    const run: ActivityDetailsRun = liveGroup
      ? { entries: selectedRun.entries, state: "running", label: liveGroup.live?.label, category: liveGroup.live?.category }
      : {
        entries: selectedRun.entries,
        state: groups[0]?.state ?? runOutcome(selectedRun.entries),
        summary: workSummary(hidden),
        unconfirmed: groups.some((group) => group.unconfirmed),
      };
    return { run, visibleIds };
  }, [presented, selectedRun]);

  // A blocking approval outranks reading: close so its own surface is usable.
  useEffect(() => {
    if (approval) closeActivity("approval");
  }, [approval, closeActivity]);
  const isOpen = selection !== null;
  useEffect(() => {
    if (!isOpen) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      if (document.querySelector("[data-approval-modal]")) closeActivity("approval");
    };
    check();
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(check); });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [closeActivity, isOpen]);

  // After closing, return focus only if nothing else has claimed it. The
  // opener may have remounted (the live line became a settled row).
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen) {
      wasOpenRef.current = true;
      return;
    }
    if (!wasOpenRef.current) return;
    wasOpenRef.current = false;
    const reason = closeReasonRef.current;
    closeReasonRef.current = "user";
    if (reason === "navigate") return;
    if (reason === "approval") {
      const modal = document.querySelector<HTMLElement>("[data-approval-modal]");
      if (modal) {
        (modal.querySelector<HTMLElement>("input, select, textarea") ?? modal).focus();
        return;
      }
    }
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const opener = openerRef.current;
    const replacement = Array.from(document.querySelectorAll<HTMLElement>("[data-activity-run]"))
      .find((element) => element.dataset.activityRun === lastRunKeyRef.current);
    const target = opener?.isConnected ? opener : replacement ?? document.querySelector<HTMLElement>("[data-testid='timeline-scroller']");
    target?.focus({ preventScroll: true });
  }, [isOpen]);

  // Navigating search results onto folded work opens it at the match.
  // Typing never opens the window; only explicit next/previous navigation.
  const searchNavRef = useRef({ query: searchQuery?.trim() ?? "", match: searchActiveMatch ?? 0 });
  useEffect(() => {
    const previous = searchNavRef.current;
    const query = searchQuery?.trim() ?? "";
    const match = searchActiveMatch ?? 0;
    searchNavRef.current = { query, match };
    if (!query || previous.query !== query || previous.match === match) return;
    const entry = entries[activeEntryIndex];
    if (entry?.kind !== "work") return;
    const needle = query.toLowerCase();
    const hit = entry.value
      .flatMap((item): Array<{ kind: "message"; value: ChatMessage } | { kind: "activity"; value: Activity }> => item.kind === "message" || item.kind === "activity"
        ? [item] : item.value.map((value) => ({ kind: "activity" as const, value })))
      .find((item) => workEntrySearchText(item).toLowerCase().includes(needle));
    openActivity(entry, null, hit?.value.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchActiveMatch, searchQuery]);

  // The question may sit above the mounted suffix of rows; the timeline
  // mounts that exact row before scrolling to and focusing it.
  const [reveal, setReveal] = useState<TimelineReveal | null>(null);
  const answerQuestion = useCallback((message: ChatMessage) => {
    closeActivity("navigate");
    setReveal((current) => ({ key: `message-${message.id}`, token: (current?.token ?? 0) + 1 }));
  }, [closeActivity]);
  // Leaving for Settings or a child thread closes the window first so no
  // native modal outlives its timeline or covers the destination.
  const modalSkillNavigation = useMemo(() => ({
    skills,
    onOpenSkill: onOpenSkill && ((path: string) => { closeActivity("navigate"); onOpenSkill(path); }),
  }), [closeActivity, onOpenSkill, skills]);
  const subAgentControls = useContext(SubAgentControls);
  const modalSubAgentControls = useMemo(() => subAgentControls && {
    ...subAgentControls,
    // Stay open until the child actually opens: a rejected open (for
    // example an unresolved child conversation) reports in its relay card.
    onOpen: async (worker: SubAgentWorker) => {
      await subAgentControls.onOpen(worker);
      closeActivity("navigate");
    },
  }, [closeActivity, subAgentControls]);

  return (
    <SkillNavigation.Provider value={skillNavigation}><FlowTimeline
      activeEntryIndex={activeEntryIndex}
      activity={activityControls}
      entries={entries}
      reveal={reveal}
      liveSubAgentSummary={liveSubAgentSummary}
      history={history}
      onLoadEarlier={onLoadEarlier}
      onApprovalRespond={onApprovalRespond}
      onEditMessage={onEditMessage}
      provider={provider}
      searchQuery={searchQuery}
    />
    {selection && details && <>
      <span ref={anchorRef} hidden />
      <SkillNavigation.Provider value={modalSkillNavigation}>
        <SubAgentControls.Provider value={modalSubAgentControls}>
          <ActivityDetailsModal
            run={details.run}
            visibleIds={details.visibleIds}
            focusId={selection.focusId}
            searchQuery={searchQuery}
            sourceRef={anchorRef}
            renderMessage={renderActivityMessage}
            renderSubAgents={renderActivitySubAgents}
            onAnswerQuestion={answerQuestion}
            onClose={closeActivity}
          />
        </SubAgentControls.Provider>
      </SkillNavigation.Provider>
    </>}
    </SkillNavigation.Provider>
  );
}
