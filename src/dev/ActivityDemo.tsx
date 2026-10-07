import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Activity, ChatMessage, Thread } from "../types";
import type { SubAgentWorker } from "../lib/subAgentActivity";
import { ChatTimeline } from "../components/ChatTimeline";
import { SubAgentControlsProvider } from "../components/SubAgentControls";

/** Presentation fixtures only: never write task, prompt, schedule or provider stores. */
export const ACTIVITY_DEMO_LABEL = "Activity preview · simulated";
export const ACTIVITY_DEMO_THREAD: Thread = {
  id: "activity-preview-simulated",
  name: "Compact activity preview",
  preview: "A deterministic preview of the activity interface.",
  cwd: "/activity-preview",
  updatedAt: 0,
  modelProvider: "openai",
};
const QA_MARKER_KEY = "mythra.releaseQa.profile";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPLETE_MS = 24_000;
const TURN_ID = "activity-preview-live-turn";
// Match the real store's immutable transcript updates: already-settled messages
// retain their identity while the current turn changes. Rebuilding historical
// objects on every fixture tick would look like a history hydration instead.
const EARLIER_MESSAGES: ChatMessage[] = [
  { id: "preview-earlier-user", role: "user", text: "Review the activity layout. (Simulated preview)", timelineOrder: 1, turnId: "preview-earlier-turn", turnStatus: "completed" },
  { id: "preview-earlier-answer", role: "assistant", text: "The layout is ready for a compact live status and a detailed Work view.", timelineOrder: 4, turnId: "preview-earlier-turn", turnStatus: "completed", turnDurationMs: 6200 },
];
const ANSWER = [
  "## A calmer way to read the answer",
  "The complete response is ready before it appears here. Its lines settle into view quickly, while the conversation stays where you were reading. This is simulated preview content: no prompt was sent to a provider.",
  "### Keep the useful details",
  "Headings, links, code, and tables keep their original Markdown formatting. The presentation changes only how new text appears, not what the model wrote. Earlier commands, edits, and reasoning remain available in Work history.",
  "| Detail | What happens |\n| --- | --- |\n| Answer | Complete lines fade into view |\n| Tables | A whole row appears together |\n| Reading position | The chat does not jump to the answer's end |\n| Work history | Earlier activity stays available |",
  "### Stay in control",
  "You can keep reading the beginning, scroll at your own pace, or explicitly choose Latest when you want the end. Searching and copying still work with the complete answer. Reduced motion skips the decorative reveal.",
  "### A little less visual noise",
  "The small working indicator uses crisp pixels rather than a sparkle icon or a circular spinner. Its colors follow the active theme, and its animation stops when the task finishes.",
  "### Nothing hidden or discarded",
  "This preview uses the actual conversation components in an isolated development profile. It does not create scheduled prompts, queue a real task, access subscription credentials, or use your model limits. All of this text is available as soon as the response completes.",
].join("\n\n");

export interface ActivityDemoEnvironment {
  dev: boolean;
  enabled: string | undefined;
  native: () => boolean;
  readMarker: () => string | null;
  probe: (profileId: string) => Promise<unknown>;
}

/** A frontend flag alone cannot opt a user's native profile into a demo. */
export async function verifyActivityDemoProfile(options: ActivityDemoEnvironment = {
  dev: import.meta.env.DEV,
  enabled: import.meta.env.VITE_MYTHRA_ACTIVITY_DEMO,
  native: isTauri,
  readMarker: () => localStorage.getItem(QA_MARKER_KEY),
  probe: (profileId) => invoke("release_qa_renderer_probe", { profileId, previous: profileId, error: null }),
}): Promise<boolean> {
  if (!options.dev || options.enabled !== "1") return false;
  try {
    if (!options.native()) return false;
    const profileId = options.readMarker();
    if (!profileId || !UUID_V4.test(profileId)) return false;
    // The native command independently checks active QA and the full UUID.
    await options.probe(profileId);
    return true;
  } catch {
    return false;
  }
}

export type ActivityDemoPhase = "thinking" | "exploring" | "editing" | "testing" | "answering" | "completed";
export interface ActivityDemoSnapshot {
  messages: ChatMessage[];
  activities: Activity[];
  workers: SubAgentWorker[];
  running: boolean;
  thinkingLabel: string;
  provider: "openai";
  phase: ActivityDemoPhase;
  elapsedMs: number;
}

/** Pure elapsed-time replay, independent of clocks, persistence and model APIs. */
export function activityDemoSnapshot(elapsed: number, startedWallTime = 0): ActivityDemoSnapshot {
  const elapsedMs = Number.isFinite(elapsed) ? Math.max(0, Math.min(COMPLETE_MS, elapsed)) : 0;
  const phase: ActivityDemoPhase = elapsedMs < 4_000 ? "thinking"
    : elapsedMs < 9_000 ? "exploring"
      : elapsedMs < 14_000 ? "editing"
        : elapsedMs < 19_000 ? "testing"
          : elapsedMs < COMPLETE_MS ? "answering" : "completed";
  const finished = phase === "completed";
  const turnStatus = finished ? "completed" as const : "inProgress" as const;
  const live = { turnId: TURN_ID, turnStatus };
  const messages: ChatMessage[] = [
    ...EARLIER_MESSAGES,
    { id: "preview-current-user", role: "user", text: "Show how the compact activity changes as work progresses. (Simulated preview)", timelineOrder: 5, ...live },
  ];
  const activities: Activity[] = [
    { id: "preview-earlier-reasoning", kind: "reasoning", title: "Thinking", detail: "Compare the status line with the expanded work history.", status: "completed", timelineOrder: 2, turnId: "preview-earlier-turn", turnStatus: "completed", turnDurationMs: 6200 },
    { id: "preview-earlier-command", kind: "command", title: "Inspect activity components", detail: "Simulated output: inspected timeline, status, and work disclosure components.", status: "completed", timelineOrder: 3, turnId: "preview-earlier-turn", turnStatus: "completed", turnDurationMs: 6200 },
    { id: "preview-thinking", kind: "reasoning", title: "Thinking", detail: "Identify the current action while retaining the full history in Work.", status: phase === "thinking" ? "inProgress" : "completed", timelineOrder: 6, ...live },
  ];
  // Enough real production rows for scrolling the Work modal in a small window.
  for (let index = 0; index < 12; index += 1) {
    activities.splice(2 + index, 0, {
      id: `preview-earlier-check-${index}`, kind: "command",
      title: `Inspect layout boundary ${index + 1}`,
      detail: `Simulated output ${index + 1}: checked compact spacing, wrapping, keyboard focus, and retained work history.\nNo command was executed.`,
      status: "completed", timelineOrder: 3.01 + index / 100,
      turnId: "preview-earlier-turn", turnStatus: "completed", turnDurationMs: 6200,
    });
  }
  if (elapsedMs >= 4_000) {
    activities.push({ id: "preview-inspect", kind: "command", title: "rg -n 'activity' src/components", detail: "Simulated command output:\nChatTimeline.tsx\nThreadListItem.tsx\nStudioDock.tsx", status: phase === "exploring" ? "inProgress" : "completed", timelineOrder: 7, ...live });
  }
  if (elapsedMs >= 9_000) {
    activities.push({ id: "preview-edit", kind: "file", title: "Update compact activity presentation", detail: "Simulated edit: src/components/ChatTimeline.tsx", status: phase === "editing" ? "inProgress" : "completed", timelineOrder: 8, ...live });
  }
  if (elapsedMs >= 14_000) {
    activities.push({ id: "preview-test", kind: "command", title: "Run focused activity checks", detail: "Simulated output: focused activity checks passed. No command was executed.", status: phase === "testing" ? "inProgress" : "completed", timelineOrder: 9, ...live });
  }
  if (elapsedMs >= 19_000) {
    const fraction = Math.min(1, (elapsedMs - 19_000) / 4500);
    messages.push({ id: "preview-current-answer", role: "assistant", phase: "final", text: ANSWER.slice(0, Math.floor(ANSWER.length * fraction)), streaming: !finished, timelineOrder: 10, ...live, ...(finished ? { turnDurationMs: COMPLETE_MS } : {}) });
  }
  const workers: SubAgentWorker[] = elapsedMs >= 4_000 ? [{
    id: "preview-layout-reviewer", kind: "cross-provider", title: "Review compact activity spacing",
    status: elapsedMs < 19_000 ? "working" : "completed", provider: "openai", model: "gpt-6-sol",
    detail: "Simulated reviewer", createdAt: startedWallTime + 4000, ...(elapsedMs >= 19_000 ? { finishedAt: startedWallTime + 19_000 } : {}),
  }] : [];
  return { messages, activities, workers, running: !finished, thinkingLabel: "Thinking about the activity layout", provider: "openai", phase, elapsedMs };
}

/** Starts only after the native QA identity check; pauses for inspecting Work. */
export function useActivityDemo() {
  const [verified, setVerified] = useState(false);
  const [verifying, setVerifying] = useState(true);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [paused, setPaused] = useState(false);
  const [replayId, setReplayId] = useState(0);
  const startedAt = useRef(0);
  const [startedWallTime, setStartedWallTime] = useState(0);
  const elapsedRef = useRef(0);
  useEffect(() => {
    let disposed = false;
    void verifyActivityDemoProfile().then((accepted) => {
      if (disposed) return;
      startedAt.current = performance.now();
      setStartedWallTime(Date.now());
      setVerified(accepted);
      setVerifying(false);
    });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    if (!verified || paused) return;
    const timer = window.setInterval(() => {
      const next = Math.min(COMPLETE_MS, performance.now() - startedAt.current);
      elapsedRef.current = next;
      setElapsedMs(next);
      if (next >= COMPLETE_MS) window.clearInterval(timer);
    }, 200);
    return () => window.clearInterval(timer);
  }, [verified, paused, replayId]);
  const replay = useCallback(() => {
    startedAt.current = performance.now();
    setStartedWallTime(Date.now());
    elapsedRef.current = 0;
    setElapsedMs(0);
    setPaused(false);
    setReplayId((current) => current + 1);
  }, []);
  const pause = useCallback(() => { setPaused(true); }, []);
  const resume = useCallback(() => {
    startedAt.current = performance.now() - elapsedRef.current;
    setPaused(false);
  }, []);
  const snapshot = useMemo(() => verified ? activityDemoSnapshot(elapsedMs, startedWallTime) : null, [verified, elapsedMs, startedWallTime]);
  return { snapshot, verifying, blocked: !verifying && !verified, paused, replay, pause, resume };
}

const previewAction = async () => { /* Presentation-only child controls. */ };
const previewControlStyle = {
  border: "1px solid var(--line-strong)", borderRadius: 8, padding: "5px 10px",
  background: "var(--field)", color: "var(--text)", font: "inherit", cursor: "pointer",
} as const;

/** Rendered inside the actual App conversation surface by its dev-only loader. */
export default function ActivityDemo() {
  const demo = useActivityDemo();
  if (demo.verifying) return <div role="status">Checking isolated activity preview…</div>;
  if (!demo.snapshot) return <div role="status">Activity preview requires an isolated native QA profile.</div>;
  return <>
    <div role="note" aria-label={ACTIVITY_DEMO_LABEL} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 20px", borderBottom: "1px solid var(--line)", flexShrink: 0 }}>
      <span style={{ flex: 1 }}>{ACTIVITY_DEMO_LABEL}</span>
      <button type="button" style={previewControlStyle} onClick={demo.replay}>Replay preview</button>
      <button type="button" style={previewControlStyle} onClick={demo.paused ? demo.resume : demo.pause}>{demo.paused ? "Resume preview" : "Pause preview"}</button>
    </div>
    <SubAgentControlsProvider workers={demo.snapshot.workers} onOpen={previewAction} onStop={previewAction}>
      <ChatTimeline messages={demo.snapshot.messages} activities={demo.snapshot.activities} running={demo.snapshot.running} activeTurnId={demo.snapshot.running ? TURN_ID : undefined} thinkingLabel={demo.snapshot.thinkingLabel} provider={demo.snapshot.provider} />
    </SubAgentControlsProvider>
  </>;
}
