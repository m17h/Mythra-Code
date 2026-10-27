import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Check, CircleAlert, Info, LoaderCircle, Mic, Settings, Square, X } from "lucide-react";
import type { VoiceInputMessage, VoiceInputView } from "../hooks/useVoiceInput";
import { TRANSCRIPTION_PROVIDER_LABELS } from "../lib/transcription";
import { MAX_RECORDING_SECONDS, type VoiceRecorder } from "../lib/voiceRecorder";
import "./VoiceInput.css";

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * Composer microphone: starts dictation, or stops one in progress. While a
 * session holds the app lock, its stop/cancel state is admitted as a pointer
 * shortcut (`data-voice-input-lock="control"`); keyboard focus and Tab stay
 * with the recorder panel (`"panel"`), which App queries explicitly.
 */
export function VoiceInputButton({ view, disabled = false, onStart, onStop, onCancel }: {
  view: VoiceInputView | null;
  disabled?: boolean;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
}) {
  const phase = view?.phase ?? "idle";
  if (view && phase === "recording") {
    const provider = TRANSCRIPTION_PROVIDER_LABELS[view.provider];
    const label = view.mode === "live" ? "Finish dictation and keep the text" : `Stop recording and transcribe it with ${provider}`;
    return (
      <button type="button" className="voice-input-button recording" data-voice-input-lock="control" tabIndex={-1} onClick={onStop} aria-label={label} title={label}>
        <Square size={10} fill="currentColor" />
      </button>
    );
  }
  if (phase === "preparing") {
    return (
      <button type="button" className="voice-input-button busy" data-voice-input-lock="control" tabIndex={-1} onClick={onCancel} aria-label="Cancel voice input" title="Cancel voice input">
        <LoaderCircle className="spin" size={14} />
      </button>
    );
  }
  if (phase !== "idle") {
    const label = view?.mode === "live" ? "Finishing your dictation" : "Transcribing your recording";
    return (
      <button type="button" className="voice-input-button busy" disabled aria-label={label} title={label}>
        <LoaderCircle className="spin" size={14} />
      </button>
    );
  }
  return (
    <button type="button" className="voice-input-button" disabled={disabled} onClick={onStart} aria-label="Start voice input" title="Voice input: speak, then edit the text in your draft before you send it">
      <Mic size={15} />
    </button>
  );
}

/** Ticks only while running; when stopped it keeps the last time shown. */
function RecordingClock({ startedAt, running }: { startedAt: number; running: boolean }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    // Capture the final elapsed time on Stop as well as every visible tick.
    setNow(performance.now());
    if (!running) return;
    const timer = window.setInterval(() => setNow(performance.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);
  const elapsed = (now - startedAt) / 1000;
  // A timer is not announced on every tick.
  return <span className="voice-rec-clock" role="timer" aria-live="off" aria-label={`Recording time ${formatClock(elapsed)}`}>{formatClock(elapsed)}</span>;
}

const WAVE_BARS = 30;
const WAVE_SAMPLE_MS = 55;
const WAVE_REST = 0.1;

/**
 * Scrolling waveform of the recorder's level, drawn on animation frames
 * without re-rendering React. Silence stays flat; nothing here is decorative
 * noise. Once `recorder` is gone or `frozen`, the loop stops and CSS settles
 * the bars for the current phase.
 */
function VoiceWave({ recorder, frozen }: { recorder: VoiceRecorder | null; frozen: boolean }) {
  const waveRef = useRef<HTMLSpanElement>(null);
  const historyRef = useRef<number[]>(Array.from({ length: WAVE_BARS }, () => 0));
  const sampleRef = useRef(0);
  const historyOwnerRef = useRef<VoiceRecorder | null>(null);
  useEffect(() => {
    const wave = waveRef.current;
    if (!recorder || frozen || !wave) return;
    // Speech remains visible through the recording indicator and clock. A
    // reduced-motion preference also stops the scrolling meter, not only its
    // CSS easing, and changing that preference takes effect immediately.
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    // A new recording never starts with the previous one's waveform.
    if (historyOwnerRef.current !== recorder) {
      historyOwnerRef.current = recorder;
      historyRef.current.fill(0);
    }
    const bars = Array.from(wave.children) as HTMLElement[];
    const history = historyRef.current;
    let frame = 0;
    let last = 0;
    let smoothed = history[history.length - 1] ?? 0;
    let shownLevel = "";
    const tick = (time: number) => {
      frame = requestAnimationFrame(tick);
      if (time - last < WAVE_SAMPLE_MS) return;
      last = time;
      const level = Math.min(1, Math.max(0, recorder.level));
      smoothed = smoothed * 0.45 + level * 0.55;
      // A fixed, gentle shape per sample keeps speech from reading as a block
      // without inventing movement in silence.
      const sample = ++sampleRef.current;
      history.push(smoothed * (0.72 + 0.28 * Math.abs(Math.sin(sample * 1.93))));
      history.shift();
      for (let index = 0; index < bars.length; index += 1) {
        bars[index].style.transform = `scaleY(${(WAVE_REST + history[index] * (1 - WAVE_REST)).toFixed(3)})`;
      }
      const rounded = level.toFixed(2);
      if (rounded !== shownLevel) {
        shownLevel = rounded;
        wave.parentElement?.style.setProperty("--voice-level", rounded);
      }
    };
    const syncMotion = () => {
      cancelAnimationFrame(frame);
      if (motion.matches) {
        wave.parentElement?.style.setProperty("--voice-level", "0");
        for (const bar of bars) bar.style.transform = "";
      } else {
        frame = requestAnimationFrame(tick);
      }
    };
    syncMotion();
    motion.addEventListener("change", syncMotion);
    return () => {
      cancelAnimationFrame(frame);
      motion.removeEventListener("change", syncMotion);
    };
  }, [recorder, frozen]);
  // Without a running loop the inline heights are cleared so the phase's CSS
  // (flatline, preparing shimmer) takes over with a transition.
  useLayoutEffect(() => {
    if (recorder && !frozen) return;
    const wave = waveRef.current;
    wave?.parentElement?.style.setProperty("--voice-level", "0");
    for (const bar of Array.from(wave?.children ?? []) as HTMLElement[]) bar.style.transform = "";
  }, [recorder, frozen]);
  return (
    <span className="voice-rec-wave" ref={waveRef} aria-hidden="true">
      {Array.from({ length: WAVE_BARS }, (_, index) => <i key={index} style={{ "--voice-i": index } as CSSProperties} />)}
    </span>
  );
}

type Stage = "closed" | "enter" | "open" | "exit";

/** Matches the longest closing transition in VoiceInput.css. */
const EXIT_MS = 300;
const REDUCED_EXIT_MS = 140;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function focusIsLost(panel: HTMLElement | null): boolean {
  const active = document.activeElement;
  return !active || active === document.body || Boolean(panel?.contains(active)) || Boolean(active.closest("[inert]"));
}

/**
 * The composer's voice recorder: one panel attached to the composer that opens
 * when voice input starts, follows it through each phase, then shows any
 * message and closes. While a session exists it carries
 * `data-voice-input-lock="panel"`, so the app admits its Cancel and Done and
 * keeps Tab and recovered focus inside it.
 *
 * On close the last content stays mounted only for the closing animation; it
 * is inert, hidden from assistive technology and frozen (no meter loop, no
 * ticking clock) from the same commit that removed the view or message.
 */
export function VoiceInputStatus({ view, message, onStop, onCancel, onDismiss, onOpenSettings }: {
  view: VoiceInputView | null;
  message: VoiceInputMessage | null;
  onStop: () => void;
  onCancel: () => void;
  onDismiss: () => void;
  onOpenSettings: () => void;
}) {
  const active = Boolean(view || message);
  const [stage, setStage] = useState<Stage>(active ? "enter" : "closed");
  // Derived during render so the commit that removes the view is already the
  // inert closing frame, and a restart during closing reverses it in place.
  if (active && stage === "closed") setStage("enter");
  else if (active && stage === "exit") setStage("open");
  else if (!active && (stage === "enter" || stage === "open")) setStage("exit");

  const snapshotRef = useRef<{ view: VoiceInputView | null; message: VoiceInputMessage | null }>({ view, message });
  if (active) snapshotRef.current = { view, message };
  else if (stage === "closed") snapshotRef.current = { view: null, message: null };
  const shown = active ? { view, message } : snapshotRef.current;
  const exiting = !active;

  // The clock belongs to one recording. startedAt is only meaningful while
  // recording, so remember it and keep showing the final time afterwards.
  const clockRef = useRef<number | null>(null);
  if (view?.phase === "preparing") clockRef.current = null;
  else if (view?.phase === "recording") clockRef.current = view.startedAt;

  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const hintId = useId();

  useLayoutEffect(() => {
    if (stage !== "enter") return;
    // Commit the closed geometry before opening so the transition runs.
    panelRef.current?.getBoundingClientRect();
    const frame = requestAnimationFrame(() => setStage((current) => current === "enter" ? "open" : current));
    return () => cancelAnimationFrame(frame);
  }, [stage]);

  useEffect(() => {
    if (stage !== "exit") return;
    const timer = window.setTimeout(() => setStage((current) => current === "exit" ? "closed" : current), prefersReducedMotion() ? REDUCED_EXIT_MS : EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [stage]);

  // Focus: the recorder's primary action on open and whenever a phase removes
  // the focused control; back to the draft once the session releases its lock.
  const phaseKey = view ? view.phase : null;
  const previousPhase = useRef<string | null>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const previous = previousPhase.current;
    previousPhase.current = phaseKey;
    if (phaseKey && panel) {
      const focused = document.activeElement;
      const holdsFocus = focused instanceof HTMLElement && panel.contains(focused) && !(focused as HTMLButtonElement).disabled;
      if (!previous || !holdsFocus) {
        (panel.querySelector<HTMLElement>("button.primary:not([disabled])")
          ?? panel.querySelector<HTMLElement>("button:not([disabled])"))?.focus({ preventScroll: true });
      }
      return;
    }
    if (!previous) return;
    // The app removes its lock (and `inert`) in its own render; retry for a
    // few frames rather than racing it, and never take focus the user moved.
    // The panel may unmount before the lock is gone; find the draft now.
    const composer = panel?.closest(".composer");
    let frame = 0;
    let attempts = 0;
    const restore = () => {
      if (!focusIsLost(panelRef.current)) return;
      const draft = composer?.querySelector<HTMLTextAreaElement>("textarea:not([disabled])");
      if (draft && !draft.closest("[inert]")) {
        draft.focus({ preventScroll: true });
        if (document.activeElement === draft) {
          draft.setSelectionRange(draft.value.length, draft.value.length);
          return;
        }
      }
      if (++attempts < 12) frame = requestAnimationFrame(restore);
    };
    frame = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(frame);
  }, [phaseKey]);

  if (stage === "closed") return null;

  const shownView = shown.view;
  const shownMessage = shown.message;
  return (
    <div
      ref={panelRef}
      className={`voice-rec ${stage === "open" ? "is-open" : "is-closed"}${exiting ? " is-exiting" : ""}${shownView ? ` phase-${shownView.phase} mode-${shownView.mode}` : shownMessage ? ` message ${shownMessage.tone}` : ""}`}
      data-voice-input-lock={view ? "panel" : undefined}
      role={shownView ? "group" : undefined}
      aria-labelledby={shownView ? titleId : undefined}
      aria-describedby={shownView ? hintId : undefined}
      aria-hidden={exiting || undefined}
      inert={exiting || undefined}
    >
      <div className="voice-rec-clip">
        <div className="voice-rec-card">
          {shownView
            ? <RecorderBody view={shownView} frozen={exiting} clockStart={clockRef.current} titleId={titleId} hintId={hintId} onStop={onStop} onCancel={onCancel} />
            : shownMessage && <MessageBody message={shownMessage} onDismiss={onDismiss} onOpenSettings={onOpenSettings} />}
        </div>
      </div>
    </div>
  );
}

function recorderCopy(view: VoiceInputView, nearLimit: boolean): { title: string; hint: string; announce: string } {
  const provider = TRANSCRIPTION_PROVIDER_LABELS[view.provider];
  const live = view.mode === "live";
  switch (view.phase) {
    case "preparing":
      return { title: "Getting ready", hint: `Checking your ${provider} key and microphone`, announce: "Getting voice input ready." };
    case "recording": {
      const hint = nearLimit
        ? `Stops automatically at ${formatClock(MAX_RECORDING_SECONDS)}`
        : live ? `Audio streams to ${provider} as words appear` : "Text appears in your message when you finish";
      return { title: live ? "Listening" : "Recording", hint, announce: live ? `Listening. Audio streams to ${provider} and words appear in your message as you speak.` : "Recording. Text appears in your message when you finish." };
    }
    case "finishing":
      return live
        ? { title: "Finishing", hint: "Adding your last words", announce: "Finishing your last words." }
        : { title: "Finishing", hint: "Wrapping up the recording", announce: "Finishing the recording." };
    default:
      return live
        ? { title: "Finishing", hint: `Waiting for your final words from ${provider}`, announce: `Waiting for your final words from ${provider}.` }
        : { title: "Transcribing", hint: `${provider} is turning your recording into text`, announce: `Transcribing with ${provider}.` };
  }
}

function RecorderBody({ view, frozen, clockStart, titleId, hintId, onStop, onCancel }: {
  view: VoiceInputView;
  frozen: boolean;
  clockStart: number | null;
  titleId: string;
  hintId: string;
  onStop: () => void;
  onCancel: () => void;
}) {
  const recording = view.phase === "recording";
  const live = view.mode === "live";
  const provider = TRANSCRIPTION_PROVIDER_LABELS[view.provider];
  const [nearLimitStart, setNearLimitStart] = useState<number | null>(null);
  useEffect(() => {
    if (!recording || frozen || clockStart === null) return;
    const remaining = (MAX_RECORDING_SECONDS - 60) * 1000 - (performance.now() - clockStart);
    if (remaining <= 0) {
      setNearLimitStart(clockStart);
      return;
    }
    const timer = window.setTimeout(() => setNearLimitStart(clockStart), remaining);
    return () => window.clearTimeout(timer);
  }, [clockStart, frozen, recording]);
  const copy = recorderCopy(view, recording && clockStart !== null && nearLimitStart === clockStart);
  // Phase announcements are queued after the panel exists so they are read.
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (frozen) return;
    const timer = window.setTimeout(() => setAnnouncement(copy.announce), 60);
    return () => window.clearTimeout(timer);
  }, [copy.announce, frozen]);
  const cancelTitle = live
    ? "Stop and remove the text from this dictation. Your earlier draft stays as it was. Audio already sent can't be recalled."
    : view.phase === "transcribing"
      ? "Stop transcribing and discard this recording. Your draft stays as it was."
      : "Discard this recording. Your draft stays as it was.";
  const doneLabel = live ? "Done: stop the microphone and keep the text to edit" : `Done: stop recording and transcribe it with ${provider}`;
  return (
    <>
      <span className="voice-rec-orb" aria-hidden="true">
        <span className="voice-rec-halo" />
        {view.phase === "preparing" || view.phase === "transcribing"
          ? <LoaderCircle className={frozen ? undefined : "spin"} size={14} />
          : <Mic size={14} />}
      </span>
      <span className="voice-rec-copy">
        <span className="voice-rec-titleline">
          <strong id={titleId} key={copy.title}>{copy.title}</strong>
          {live && <span className="voice-rec-badge" title="This model writes as you speak">Live</span>}
          {clockStart !== null
            ? <RecordingClock key={clockStart} startedAt={clockStart} running={recording && !frozen} />
            : <span className="voice-rec-clock placeholder" aria-hidden="true">0:00</span>}
        </span>
        <small id={hintId} key={copy.hint} title={copy.hint}>{copy.hint}</small>
      </span>
      <VoiceWave recorder={recording ? view.recorder : null} frozen={frozen} />
      <span className="voice-rec-actions">
        <button type="button" className="voice-rec-button" onClick={onCancel} title={cancelTitle}>
          {recording ? <><X size={12} aria-hidden="true" /> Cancel</> : "Cancel"}
        </button>
        {recording && (
          <button type="button" className="voice-rec-button primary" onClick={onStop} aria-label={doneLabel} title={doneLabel}>
            <Check size={13} aria-hidden="true" /> Done
          </button>
        )}
      </span>
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    </>
  );
}

function MessageBody({ message, onDismiss, onOpenSettings }: {
  message: VoiceInputMessage;
  onDismiss: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <>
      <span className="voice-rec-orb" aria-hidden="true">
        {message.tone === "error" ? <CircleAlert size={14} /> : <Info size={14} />}
      </span>
      <span className="voice-rec-copy" role={message.tone === "error" ? "alert" : "status"} key={message.text}>
        <span className="voice-rec-message">{message.text}</span>
      </span>
      <span className="voice-rec-actions">
        {message.settings && <button type="button" className="voice-rec-button" onClick={onOpenSettings}><Settings size={12} aria-hidden="true" /> Voice input settings</button>}
        <button type="button" className="voice-rec-dismiss" onClick={onDismiss} aria-label="Dismiss" title="Dismiss"><X size={13} /></button>
      </span>
    </>
  );
}
