import type { Activity, ChatMessage } from "../types";

/** Structural timeline types keep presentation independent of React/UI code. */
export type CompactWorkEntry =
  | { kind: "message"; value: ChatMessage }
  | { kind: "activity"; value: Activity }
  | { kind: "commands"; value: Activity[] }
  | { kind: "files"; value: Activity[] }
  | { kind: "spawns"; value: Activity[] };

export type CompactWorkState = "running" | "completed" | "interrupted" | "failed" | "unknown";
export type CompactPresentationEntry = CompactWorkEntry | {
  kind: "work";
  /** Original entries, in order, for the full live/historical details surface. */
  value: CompactWorkEntry[];
  state: CompactWorkState;
  turnId?: string;
};

export interface CompactActivityOptions {
  running: boolean;
  activeTurnId?: string;
}

function values(entry: CompactWorkEntry): Array<ChatMessage | Activity> {
  return entry.kind === "message" || entry.kind === "activity" ? [entry.value] : entry.value;
}

function turnId(entry: CompactWorkEntry): string | undefined {
  const items = values(entry);
  const id = items[0]?.turnId;
  return id && items.every((item) => item.turnId === id) ? id : undefined;
}

function segmentsFor(entries: readonly CompactWorkEntry[]): CompactWorkEntry[][] {
  const segments: CompactWorkEntry[][] = [];
  let segment: CompactWorkEntry[] = [];
  let hasUser = false;
  let primaryTurnId: string | undefined;
  for (const entry of entries) {
    const id = turnId(entry);
    if (entry.kind === "message" && entry.value.role === "user") {
      // Runtime-bound steering belongs to its opening prompt. Untagged user
      // input remains a boundary rather than being guessed into an old turn.
      if (segment.length && (!hasUser || !id || id !== primaryTurnId)) {
        segments.push(segment);
        segment = [];
      }
      hasUser = true;
      primaryTurnId = id;
    } else if (hasUser && !primaryTurnId && id) {
      primaryTurnId = id;
    }
    segment.push(entry);
  }
  if (segment.length) segments.push(segment);
  return segments;
}

function meaningful(message: ChatMessage): boolean {
  return Boolean(message.text.trim() || message.attachments?.length || message.questions?.length);
}

function stateFor(segment: CompactWorkEntry[], active: boolean): CompactWorkState {
  if (active) return "running";
  for (let index = segment.length - 1; index >= 0; index -= 1) {
    const status = values(segment[index]).find((value) => value.turnStatus)?.turnStatus;
    if (status === "failed" || status === "interrupted" || status === "completed") return status;
  }
  // Preserve legacy completed transcript behavior, but never call an
  // unfinished runtime-tagged turn complete merely because it is idle.
  const legacyAnswer = segment.some((entry) => entry.kind === "message" && entry.value.role === "assistant"
    && !entry.value.streaming && meaningful(entry.value));
  return legacyAnswer && segment.every((entry) => values(entry).every((value) => !value.turnId)) ? "completed" : "unknown";
}

function hasTerminalTurnEvidence(segment: CompactWorkEntry[], id?: string): boolean {
  let terminal = false;
  for (const entry of segment) {
    // Runtime user echoes can default to completed without sealing the turn.
    if (entry.kind === "message" && entry.value.role === "user") continue;
    for (const value of values(entry)) {
      if (id && value.turnId !== id) continue;
      if (value.turnStatus === "inProgress" || (entry.kind === "message" && entry.value.streaming)) return false;
      if (value.turnStatus === "completed" || value.turnStatus === "failed" || value.turnStatus === "interrupted") terminal = true;
    }
  }
  return terminal;
}

function importantActivity(activity: Activity): boolean {
  return activity.kind === "warning" || activity.kind === "compaction"
    || ["failed", "error", "interrupted", "cancelled"].includes(activity.status ?? "");
}

function isolateImportantActivities(entries: readonly CompactWorkEntry[]): CompactWorkEntry[] {
  return entries.flatMap((entry) => {
    if (entry.kind === "message" || entry.kind === "activity" || !entry.value.some(importantActivity)) return [entry];
    const output: CompactWorkEntry[] = [];
    let routine: Activity[] = [];
    const flush = () => {
      if (routine.length) output.push({ kind: entry.kind, value: routine });
      routine = [];
    };
    for (const activity of entry.value) {
      if (importantActivity(activity)) {
        flush();
        output.push({ kind: "activity", value: activity });
      } else routine.push(activity);
    }
    flush();
    return output;
  });
}

/**
 * Presentation only: never modifies or discards transcript data. All routine
 * assistant text, including a native final channel, waits for turn completion.
 * Questions/errors and stopped output remain actionable in chat.
 */
export function compactActivityPresentation(
  entries: readonly CompactWorkEntry[], options: CompactActivityOptions,
): CompactPresentationEntry[] {
  // A failed member must not expose hundreds of unrelated grouped operations.
  // Split presentation groups only; original activities/history stay intact.
  const segments = segmentsFor(isolateImportantActivities(entries));
  let activeSegment = -1;
  if (options.activeTurnId) {
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      if (segments[index].some((entry) => values(entry).some((value) => value.turnId === options.activeTurnId))) {
        activeSegment = index;
        break;
      }
    }
  }
  return segments.flatMap((segment, index) => {
    const activeIndex = activeSegment >= 0 ? activeSegment : options.activeTurnId ? -1 : segments.length - 1;
    const active = options.running && index === activeIndex
      && (Boolean(options.activeTurnId) || !hasTerminalTurnEvidence(segment));
    // An idle notification can precede the terminal turn event. Retain its
    // current output in details without claiming the provider is still busy.
    // Old unknown history and explicitly stopped/failed output stay readable.
    const unconfirmed = !active && Boolean(options.activeTurnId) && index === activeSegment
      && !hasTerminalTurnEvidence(segment, options.activeTurnId);
    const state = unconfirmed ? "unknown" : stateFor(segment, active);
    const assistants = segment.filter((entry) => entry.kind === "message" && entry.value.role === "assistant"
      && !entry.value.questions?.length && meaningful(entry.value));
    const lastAssistant = assistants.at(-1);
    // Completion seals all messages, not only the answer. Promote ONLY the
    // terminal unphased message; an explicit commentary row is never an answer.
    const fallback = state === "completed" && lastAssistant?.kind === "message"
      && !lastAssistant.value.phase && !lastAssistant.value.streaming ? lastAssistant : undefined;
    const output: CompactPresentationEntry[] = [];
    let work: CompactWorkEntry[] = [];
    const flush = () => {
      if (work.length) output.push({ kind: "work", value: work, state,
        turnId: options.activeTurnId && (active || unconfirmed) ? options.activeTurnId : turnId(segment[0]) });
      work = [];
    };
    let liveWork: Extract<CompactPresentationEntry, { kind: "work" }> | undefined;
    for (const entry of segment) {
      const visible = entry.kind === "message"
        ? entry.value.role === "user" || Boolean(entry.value.questions?.length)
          || (meaningful(entry.value) && ((!active && !unconfirmed && entry.value.phase === "final") || entry === fallback
            || (!unconfirmed && (state === "failed" || state === "interrupted" || state === "unknown"))
            || entry.value.turnStatus === "failed" || entry.value.turnStatus === "interrupted"))
        : values(entry).some((value) => importantActivity(value as Activity));
      if (active || unconfirmed) {
        // A steer/question/warning must not create a second live status line.
        // Source history retains the full interleaving; this single disclosure
        // retains hidden entries in their original relative order.
        if (visible) output.push(entry);
        else {
          if (!liveWork) {
            liveWork = { kind: "work", value: [], state, turnId: options.activeTurnId ?? turnId(segment[0]) };
            output.push(liveWork);
          }
          liveWork.value.push(entry);
        }
      } else if (visible) { flush(); output.push(entry); }
      else work.push(entry);
    }
    flush();
    return output;
  });
}

export interface CompactActivityStatus {
  category: "research" | "files" | "commands" | "thinking";
  label: string;
  activity?: Activity;
}

function categoryFor(activity: Activity): CompactActivityStatus["category"] {
  // A provider's concrete operation type takes priority over legacy kind/title
  // guesses (Claude Read, for example, is historically stored as a command).
  if (activity.workType) return activity.workType;
  if (activity.kind === "file") return "files";
  if (activity.kind !== "command") return "thinking";
  // Match actual tool/command names, never arbitrary prose such as an agent
  // task titled 'research the command failures'. Unknown tools stay commands.
  if (/^(?:Web Search|Web Fetch|WebSearch|WebFetch|Grep|Glob|Read)$/i.test(activity.title.trim())
    || /^(?:rg|grep|find|cat|sed|head|tail)(?:\s|$)/.test(activity.title.trim())
    || /^web(?:\.|__)run(?:\s|$)/.test(activity.title.trim())) return "research";
  return "commands";
}

/** Latest still-active operation wins; finished/stale tools never imply work. */
export function latestCompactActivity(
  entries: readonly CompactWorkEntry[], options: { activeTurnId?: string } = {},
): CompactActivityStatus {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.kind === "message") continue;
    const activities = values(entry) as Activity[];
    for (let item = activities.length - 1; item >= 0; item -= 1) {
      const activity = activities[item];
      if (options.activeTurnId && activity.turnId && activity.turnId !== options.activeTurnId) continue;
      if (activity.turnStatus && activity.turnStatus !== "inProgress") continue;
      if (!["inProgress", "running", "starting", "started", "pending"].includes(activity.status ?? "")) continue;
      if (activity.kind === "warning") continue;
      const category = categoryFor(activity);
      const labels = { research: "Researching", files: "Editing files", commands: "Executing commands", thinking: "Thinking" };
      return { category, label: labels[category], activity };
    }
  }
  return { category: "thinking", label: "Thinking" };
}
