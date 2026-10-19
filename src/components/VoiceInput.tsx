import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { CircleAlert, Info, LoaderCircle, Mic, Settings, Square, X } from "lucide-react";
import type { VoiceInputMessage, VoiceInputView } from "../hooks/useVoiceInput";
import { TRANSCRIPTION_PROVIDER_LABELS } from "../lib/transcription";
import { MAX_RECORDING_SECONDS, type VoiceRecorder } from "../lib/voiceRecorder";
import type { VoiceInteractionSession } from "../lib/voiceInputLock";
import { useModalFocus } from "../hooks/useModalFocus";
import "./VoiceInput.css";

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Composer microphone: starts a recording, or stops one to transcribe it. */
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
    return (
      <button type="button" className="voice-input-button recording" onClick={onStop} aria-label={`Stop recording and upload it to ${provider} for transcription`} title={`Stop and upload the recording to ${provider}; the text is added to your draft`}>
        <Square size={11} fill="currentColor" />
      </button>
    );
  }
  if (phase === "preparing") {
    return (
      <button type="button" className="voice-input-button busy" onClick={onCancel} aria-label="Cancel voice input" title="Cancel voice input">
        <LoaderCircle className="spin" size={14} />
      </button>
    );
  }
  if (phase !== "idle") {
    return (
      <button type="button" className="voice-input-button busy" disabled aria-label="Transcribing your recording" title="Transcribing your recording">
        <LoaderCircle className="spin" size={14} />
      </button>
    );
  }
  return (
    <button type="button" className="voice-input-button" disabled={disabled} onClick={onStart} aria-label="Start voice input" title="Voice input: record, then edit the transcribed text before you send your message">
      <Mic size={15} />
    </button>
  );
}

function RecordingClock({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = (now - startedAt) / 1000;
  const nearLimit = MAX_RECORDING_SECONDS - elapsed <= 60;
  // A timer is not announced on every tick, even inside the status region.
  return (
    <span className="voice-input-clock" role="timer" aria-live="off" aria-label={`Recording time ${formatClock(elapsed)}`}>
      {formatClock(elapsed)}
      {nearLimit && <small> · stops at {formatClock(MAX_RECORDING_SECONDS)}</small>}
    </span>
  );
}

/** Reads the recorder's level on animation frames, without re-rendering React. */
function LevelMeter({ recorder }: { recorder: VoiceRecorder }) {
  const meterRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let frame = 0;
    let shown = "";
    const tick = () => {
      // The level changes a few times a second; restyle only when it does.
      const level = recorder.level.toFixed(2);
      if (level !== shown) {
        shown = level;
        meterRef.current?.style.setProperty("--voice-level", level);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [recorder]);
  return (
    <span className="voice-input-meter" ref={meterRef} aria-hidden="true">
      {[0.55, 0.85, 1, 0.75, 0.5].map((weight, index) => <i key={index} style={{ "--voice-bar": weight } as CSSProperties} />)}
    </span>
  );
}

/** Recording, transcription and error state above the composer toolbar. */
export function VoiceInputStatus({ view, message, onStop, onCancel, onDismiss, onOpenSettings }: {
  view: VoiceInputView | null;
  message: VoiceInputMessage | null;
  onStop: () => void;
  onCancel: () => void;
  onDismiss: () => void;
  onOpenSettings: () => void;
}) {
  if (view) {
    const provider = TRANSCRIPTION_PROVIDER_LABELS[view.provider];
    if (view.phase === "recording" && view.recorder) {
      return (
        <div className="voice-input-status recording" role="status" aria-live="polite">
          <span className="voice-input-dot" aria-hidden="true" />
          <strong>Recording</strong>
          <RecordingClock startedAt={view.startedAt} />
          <LevelMeter recorder={view.recorder} />
          <span className="voice-input-actions">
            <button type="button" className="voice-input-text-button" onClick={onCancel} title="Discard this recording without uploading it">Discard</button>
            <button type="button" className="voice-input-text-button primary" onClick={onStop} title={`Upload the recording to ${provider} and add the text to your draft`}><Square size={9} fill="currentColor" /> Stop &amp; transcribe</button>
          </span>
        </div>
      );
    }
    const copy = view.phase === "preparing"
      ? "Checking voice input setup…"
      : view.phase === "finishing"
        ? "Finishing the recording…"
        : `Transcribing with ${provider}…`;
    return (
      <div className="voice-input-status working" role="status" aria-live="polite">
        <LoaderCircle className="spin" size={13} aria-hidden="true" />
        <span className="voice-input-copy">
          <strong>{copy}</strong>
          {view.phase === "transcribing" && <small>The text will be added to your draft, not sent. Finish or cancel voice input before continuing.</small>}
        </span>
        <span className="voice-input-actions">
          <button type="button" className="voice-input-text-button" onClick={onCancel}>Cancel</button>
        </span>
      </div>
    );
  }
  if (!message) return null;
  return (
    <div className={`voice-input-status ${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>
      {message.tone === "error" ? <CircleAlert size={13} aria-hidden="true" /> : <Info size={13} aria-hidden="true" />}
      <span className="voice-input-copy"><strong>{message.text}</strong></span>
      <span className="voice-input-actions">
        {message.settings && <button type="button" className="voice-input-text-button" onClick={onOpenSettings}><Settings size={11} /> Voice input settings</button>}
        <button type="button" className="voice-input-dismiss" onClick={onDismiss} aria-label="Dismiss"><X size={12} /></button>
      </span>
    </div>
  );
}

/** Keep the draft and destination fixed until voice finishes or is canceled. */
export function VoiceInputLockModal({ session }: { session: VoiceInteractionSession | null }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousPhase = useRef<string | null>(null);
  useModalFocus(dialogRef, session !== null);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const previous = previousPhase.current;
    previousPhase.current = session ? `${session.id}:${session.view.phase}` : null;
    // Stop is replaced by Cancel between phases; do not leave keyboard
    // focus on the body when the formerly focused action is removed. Initial
    // focus still belongs to useModalFocus, which captures its return target.
    // Prefer Stop & transcribe so recovered focus doesn't default to Discard.
    if (previous && session && dialog && !dialog.contains(document.activeElement)) {
      (dialog.querySelector<HTMLButtonElement>("button.primary:not([disabled])")
        ?? dialog.querySelector<HTMLButtonElement>("button:not([disabled])"))?.focus();
    }
  }, [session?.id, session?.view.phase]);
  if (!session) return null;
  return (
    <div className="modal-backdrop voice-input-lock-backdrop" data-voice-input-lock>
      <div className="confirm-dialog voice-input-lock-dialog" role="dialog" aria-modal="true" aria-labelledby="voice-input-lock-title" aria-describedby="voice-input-lock-description" ref={dialogRef}>
        <h2 id="voice-input-lock-title">Voice input</h2>
        <p id="voice-input-lock-description">Finish or cancel voice input before opening another thread or changing anything else. Your draft stays right here.</p>
        <VoiceInputStatus view={session.view} message={null} onStop={session.onStop} onCancel={session.onCancel} onDismiss={() => {}} onOpenSettings={() => {}} />
      </div>
    </div>
  );
}
