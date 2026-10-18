import type { Activity, ChatMessage } from "../types";

/** Structural timeline types keep presentation independent of React/UI code. */
export type CompactWorkEntry =
  | { kind: "message"; value: ChatMessage }
  | { kind: "activity"; value: Activity }
  | { kind: "commands"; value: Activity[] }
  | { kind: "files"; value: Activity[] }
  | { kind: "spawns"; value: Activity[] };

export type CompactWorkState = "running" | "completed" | "interrupted" | "failed" | "partial" | "unknown";
export type CompactPresentationEntry = CompactWorkEntry | {
  kind: "work";
  /** Original entries, in order, for the full live/historical details surface. */
  value: CompactWorkEntry[];
  state: CompactWorkState;
  turnId?: string;
  /** Stable source identity when a stopped run has no hidden output yet. */
  anchorId?: string;
  /** `partial` inferred from recorded successful work in a run whose
   * terminal outcome was never recorded; it did not confirm completion. */
  completionUnconfirmed?: boolean;
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

export function activityTurnSegments(entries: readonly CompactWorkEntry[]): CompactWorkEntry[][] {
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
    } else if (id) {
      // A paginated history slice may begin after its user prompt. Explicit
      // provider turn identities still separate each completed answer.
      if (!hasUser && segment.length && primaryTurnId && id !== primaryTurnId) {
        segments.push(segment);
        segment = [];
        hasUser = false;
      }
      if (!hasUser || !primaryTurnId) primaryTurnId = id;
    }
    segment.push(entry);
  }
  if (segment.length) segments.push(segment);
  return segments;
}

function meaningful(message: ChatMessage): boolean {
  return Boolean(message.text.trim() || message.attachments?.length || message.questions?.length);
}

/** A recorded successful concrete operation: thinking, progress text,
 * warnings and agent dispatch alone are not. */
function succeededConcreteWork(activity: Activity): boolean {
  const finishedWork = activity.kind === "command" || activity.kind === "file"
    || (activity.kind === "agent" && activity.agent?.action === "spawn" && Boolean(activity.agent.result?.trim()));
  return finishedWork && ["completed", "succeeded", "success"].includes(activity.status ?? "");
}

/** Presentation evidence, not a change to the provider's failed outcome or
 * a claim that the user's whole request succeeded. Only recorded successful
 * operations count: thinking, progress text, warnings and agent dispatch do not. */
export function failedRunPresentationState(entries: readonly CompactWorkEntry[]): "failed" | "partial" {
  const failedTurns = new Set(entries.flatMap(values)
    .filter((value) => value.turnStatus === "failed" && value.turnId)
    .map((value) => value.turnId));
  for (const entry of entries) {
    if (entry.kind === "message") continue;
    for (const activity of values(entry) as Activity[]) {
      // A separately completed provider turn is not evidence about this failure.
      if (failedTurns.size ? !activity.turnId || !failedTurns.has(activity.turnId)
        : Boolean(activity.turnId) || activity.turnStatus === "completed") continue;
      if (succeededConcreteWork(activity)) return "partial";
    }
  }
  return "failed";
}

export type RuntimeTurnOutcome = "completed" | "failed" | "interrupted" | "unknown";

/**
 * Conservative outcome from the newest runtime evidence, optionally for one
 * provider turn. Only non-user output decides: newer streaming, inProgress or
 * unsealed tagged output (Claude rows carry no status while live) is
 * unfinished and never inherits an older terminal status. Opening user echoes
 * can default to completed, so they only anchor a failed/stopped outcome
 * when no runtime output exists. Grouped rows are read item by item because
 * one group can mix turns.
 */
export function runtimeTurnOutcome(entries: readonly CompactWorkEntry[], id?: string): RuntimeTurnOutcome {
  let userOutcome: "failed" | "interrupted" | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const items = values(entry);
    for (let item = items.length - 1; item >= 0; item -= 1) {
      const value = items[item];
      if (id !== undefined && value.turnId !== id) continue;
      const status = value.turnStatus;
      if (entry.kind === "message" && entry.value.role === "user") {
        if (!userOutcome && (status === "failed" || status === "interrupted")) userOutcome = status;
        continue;
      }
      if (entry.kind === "message" && entry.value.streaming) return "unknown";
      if (status === "completed" || status === "failed" || status === "interrupted") return status;
      // Untagged statusless rows (legacy history, local diagnostics) are not runtime evidence.
      if (status === "inProgress" || value.turnId) return "unknown";
    }
  }
  return userOutcome ?? "unknown";
}

/** Every provider turn's own outcome, by the same newest-evidence rules as
 * `runtimeTurnOutcome`, in one reverse pass over the logical run. */
function turnOutcomes(segment: readonly CompactWorkEntry[]): Map<string, RuntimeTurnOutcome> {
  const decided = new Map<string, RuntimeTurnOutcome>();
  const userOutcomes = new Map<string, "failed" | "interrupted">();
  for (let index = segment.length - 1; index >= 0; index -= 1) {
    const entry = segment[index];
    const items = values(entry);
    for (let item = items.length - 1; item >= 0; item -= 1) {
      const { turnId: id, turnStatus: status } = items[item];
      if (!id || decided.has(id)) continue;
      if (entry.kind === "message" && entry.value.role === "user") {
        if (!userOutcomes.has(id) && (status === "failed" || status === "interrupted")) userOutcomes.set(id, status);
        continue;
      }
      decided.set(id, entry.kind === "message" && entry.value.streaming ? "unknown"
        : status === "completed" || status === "failed" || status === "interrupted" ? status : "unknown");
    }
  }
  for (const [id, status] of userOutcomes) if (!decided.has(id)) decided.set(id, status);
  return decided;
}

type AssistantEntry = { kind: "message"; value: ChatMessage };

/** Any meaningful assistant text other than a question, whatever its phase. */
function assistantText(entry: CompactWorkEntry): entry is AssistantEntry {
  return entry.kind === "message" && entry.value.role === "assistant"
    && !entry.value.questions?.length && meaningful(entry.value);
}

/** A settled explicit final wins. Otherwise only the turn's ACTUAL last
 * message can be its answer, and only when it is settled and unphased: an
 * explicit commentary (or still-streaming) last message means no answer,
 * rather than promoting earlier progress. */
function addAnswers(messages: AssistantEntry[], answers: Set<CompactWorkEntry>): void {
  const finals = messages.filter((entry) => entry.value.phase === "final" && !entry.value.streaming);
  if (finals.length) {
    for (const entry of finals) answers.add(entry);
    return;
  }
  const last = messages.at(-1);
  if (last && !last.value.phase && !last.value.streaming) answers.add(last);
}

function settledLegacyStatus(value: ChatMessage | Activity): boolean {
  return value.turnStatus !== "inProgress" && value.turnStatus !== "failed" && value.turnStatus !== "interrupted";
}

/**
 * Answers chosen by each message's OWN turn evidence, never by a status
 * borrowed from another turn in the same logical run.
 * - A completed provider turn (not the still-owned live turn) shows its
 *   explicit finals, or else its last message when that is settled and unphased.
 * - Weak unphased fallback is only for wholly untagged, settled legacy runs.
 *   An untagged prefix alone cannot prove historical completion: it may be
 *   progress emitted before the current provider turn acquired its identity.
 * - An untagged explicit final with its own completed metadata is preserved
 *   anywhere in the run, without borrowing another row's outcome.
 */
function segmentAnswers(
  segment: CompactWorkEntry[], outcomes: Map<string, RuntimeTurnOutcome>, live: boolean, liveTurnId?: string,
): { answers: Set<CompactWorkEntry>; legacy: boolean } {
  const answers = new Set<CompactWorkEntry>();
  const byTurn = new Map<string, AssistantEntry[]>();
  const untagged: AssistantEntry[] = [];
  let legacy = true;
  let legacySettled = true;
  for (const entry of segment) {
    if (values(entry).some((value) => value.turnId)) legacy = false;
    if ((entry.kind === "message" && entry.value.streaming) || !values(entry).every(settledLegacyStatus)) legacySettled = false;
    if (!assistantText(entry)) continue;
    const id = entry.value.turnId;
    if (id) {
      const messages = byTurn.get(id);
      if (messages) messages.push(entry);
      else byTurn.set(id, [entry]);
    } else {
      untagged.push(entry);
      if (entry.value.phase === "final" && !entry.value.streaming && entry.value.turnStatus === "completed") answers.add(entry);
    }
  }
  for (const [id, messages] of byTurn) {
    if (id !== liveTurnId && outcomes.get(id) === "completed") addAnswers(messages, answers);
  }
  // A wholly untagged run is the live run itself while it is active.
  if (legacy && legacySettled && !live) addAnswers(untagged, answers);
  return { answers, legacy };
}

function stateFor(segment: CompactWorkEntry[], active: boolean, legacyAnswered: boolean): CompactWorkState {
  if (active) return "running";
  const outcome = runtimeTurnOutcome(segment);
  if (outcome !== "unknown") return outcome;
  // Preserve legacy completed transcript behavior, but never call an
  // unfinished runtime-tagged turn complete merely because it is idle.
  return legacyAnswered ? "completed" : "unknown";
}

/** A settled run with no recorded terminal outcome (not one this renderer
 * still owns). Successful concrete work in its own unfinished provider turns
 * reads as partially completed, flagged unconfirmed; no cause or success is
 * inferred. Work from a separately completed turn is not evidence. */
function unknownRunPresentationState(segment: CompactWorkEntry[], outcomes: Map<string, RuntimeTurnOutcome>): "partial" | "unknown" {
  for (const entry of segment) {
    if (entry.kind === "message") continue;
    for (const activity of values(entry) as Activity[]) {
      if (activity.turnId && outcomes.get(activity.turnId) === "unknown" && succeededConcreteWork(activity)) return "partial";
    }
  }
  return "unknown";
}

/** The outcome a settled logical run's history opener shows, for callers
 * that render a run without folded work (skill-only openers), so it always
 * matches the work row's state. `activeTurnId` keeps an owned, unconfirmed
 * turn `unknown` exactly as the timeline does. */
export function settledRunPresentationState(
  segment: CompactWorkEntry[], activeTurnId?: string,
): { state: CompactWorkState; completionUnconfirmed: boolean } {
  const outcomes = turnOutcomes(segment);
  const { answers, legacy } = segmentAnswers(segment, outcomes, false);
  if (activeTurnId && segment.some((entry) => values(entry).some((value) => value.turnId === activeTurnId))
    && !hasTerminalTurnEvidence(segment, activeTurnId)) return { state: "unknown", completionUnconfirmed: false };
  const state = stateFor(segment, false, legacy && answers.size > 0);
  if (state === "failed") return { state: failedRunPresentationState(segment), completionUnconfirmed: false };
  if (state === "unknown") {
    const inferred = unknownRunPresentationState(segment, outcomes);
    return { state: inferred, completionUnconfirmed: inferred === "partial" };
  }
  return { state, completionUnconfirmed: false };
}

/** Non-user output seals a turn only after all of its output has settled. */
export function hasTerminalTurnEvidence(segment: CompactWorkEntry[], id?: string): boolean {
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
  // Visibility follows the activity's purpose, never its outcome. A failed
  // file edit or sub-agent operation is work history just like a failed
  // command; promoting it here splits the run and leaks tool output into chat.
  // Keep all tool output/status in details, even after recovery or reopening.
  // Explicit warnings and context boundaries remain visible. Approvals and
  // questions have their own presentation and are unaffected.
  return activity.kind === "warning" || activity.kind === "compaction";
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
 * Questions and warning activities remain actionable while work can continue.
 * Interrupted or failed output stays in one history disclosure, including
 * unfinished answers. Each logical run has at most one disclosure, placed at
 * its first hidden entry and holding every hidden entry in original order, so
 * steering, questions, warnings and answers never split it. Unknown outcomes
 * (lost terminal metadata, reopened unfinished runs) fail closed: their
 * progress stays in that disclosure rather than becoming chat messages.
 */
export function compactActivityPresentation(
  entries: readonly CompactWorkEntry[], options: CompactActivityOptions,
): CompactPresentationEntry[] {
  // Split out explicit warnings/landmarks without exposing grouped tools.
  // Original activities/history stay intact, including failed operations.
  const segments = activityTurnSegments(isolateImportantActivities(entries));
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
      && !hasTerminalTurnEvidence(segment, options.activeTurnId);
    // An idle notification can precede the terminal turn event. Retain its
    // current output in details without claiming the provider is still busy.
    // Old unknown history keeps its output in one disclosure as well.
    const unconfirmed = !active && Boolean(options.activeTurnId) && index === activeSegment
      && !hasTerminalTurnEvidence(segment, options.activeTurnId);
    // Completed answers from a separate recovered provider turn survive a
    // later live, unknown, failed or stopped turn in the same run. The
    // unfinished turn's own progress or partial final is never an answer.
    const outcomes = turnOutcomes(segment);
    const { answers, legacy } = segmentAnswers(segment, outcomes, active || unconfirmed,
      active || unconfirmed ? options.activeTurnId : undefined);
    const state = unconfirmed ? "unknown" : stateFor(segment, active, legacy && answers.size > 0);
    const stopped = state === "interrupted" || state === "failed";
    // Owned unconfirmed and live runs are never reclassified.
    const outcome = state === "failed" ? failedRunPresentationState(segment)
      : state === "unknown" && !unconfirmed ? unknownRunPresentationState(segment, outcomes) : state;
    const completionUnconfirmed = state === "unknown" && outcome === "partial";
    const output: CompactPresentationEntry[] = [];
    let work: Extract<CompactPresentationEntry, { kind: "work" }> | undefined;
    for (const entry of segment) {
      // A failed or stopped run keeps its questions and warnings with the
      // failure in details; they can no longer be acted on.
      const visible = entry.kind === "message"
        ? entry.value.role === "user" || answers.has(entry) || (!stopped && Boolean(entry.value.questions?.length))
        : !stopped && values(entry).some((value) => importantActivity(value as Activity));
      if (visible) output.push(entry);
      else {
        if (!work) {
          work = { kind: "work", value: [], state: outcome,
            turnId: stopped ? turnId(segment[0]) : options.activeTurnId && (active || unconfirmed) ? options.activeTurnId : turnId(segment[0]),
            ...(completionUnconfirmed ? { completionUnconfirmed } : {}) };
          output.push(work);
        }
        work.value.push(entry);
      }
    }
    // A failure before the first provider output still settles the existing
    // live opener. Its details contain the retained opening user prompt.
    if (stopped && !work) output.push({ kind: "work", value: [], state: outcome, turnId: turnId(segment[0]), anchorId: values(segment[0])[0]?.id });
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
