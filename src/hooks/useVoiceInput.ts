import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { TauriEvent } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirmDialog } from "../lib/confirmDialog";
import { safeErrorText } from "../lib/errors";
import {
  cancelTranscription,
  createTranscriptionRequestId,
  refreshTranscriptionKeys,
  transcribeRecording,
  TRANSCRIPTION_PROVIDER_LABELS,
  transcriptionModeFor,
  type TranscriptionMode,
} from "../lib/transcription";
import { appendLiveAudio, finishLiveTranscription, startLiveTranscription } from "../lib/liveTranscription";
import { clearVoiceInputSession, isVoiceInputLocked, publishVoiceInputSession } from "../lib/voiceInputLock";
import {
  createVoiceAudioContext,
  MIN_RECORDING_SECONDS,
  VoiceCaptureError,
  VoiceRecorder,
  voiceCaptureSupported,
} from "../lib/voiceRecorder";
import type { TranscriptionProvider } from "../types";

/** Saved voice input choices plus the way into its settings. */
export interface VoiceInputConfig {
  provider: TranscriptionProvider;
  model: string;
  onOpenSettings: () => void;
}

export type VoicePhase = "idle" | "preparing" | "recording" | "finishing" | "transcribing";

export interface VoiceInputView {
  phase: VoicePhase;
  /** The thread the recording belongs to; its transcript only ever goes there. */
  threadKey: string;
  provider: TranscriptionProvider;
  model: string;
  startedAt: number;
  recorder: VoiceRecorder | null;
  mode: TranscriptionMode;
}

export interface VoiceInputMessage {
  text: string;
  tone: "error" | "info";
  /** Offer Voice input settings beside the message. */
  settings?: boolean;
}

interface Session {
  id: string;
  requestId: string | null;
  threadKey: string;
  provider: TranscriptionProvider;
  model: string;
  phase: VoicePhase;
  startedAt: number;
  context: AudioContext | null;
  recorder: VoiceRecorder | null;
  canceled: boolean;
  /** Aborts a setup dialog still open for this session. */
  controller: AbortController;
  mode: TranscriptionMode;
  liveStarted: boolean;
  liveText: string;
  provisional: boolean;
  previewTimer?: number;
  audioQueue: Promise<void>;
  queuedBytes: number;
  sequence: number;
  segmentSeconds: number;
  silenceSeconds: number;
  segmentSpeech: boolean;
}

/** Key check plus microphone start, including an OS permission prompt. */
const SETUP_TIMEOUT_MS = 60_000;
const HIDDEN_NOTICE = "Voice input discarded because Mythra Code was hidden. Nothing was uploaded.";

function newSessionId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * One voice input session at a time for the composer.
 *
 * - The microphone opens only after the key and model checks pass. The audio
 *   context is created inside the click (some engines require the gesture);
 *   that does not open the microphone.
 * - A session belongs to one thread and one saved provider and model. A thread
 *   switch, a provider or model change, or `cancel` from the composer before
 *   it sends, schedules or replaces the draft, ends the session: recording is
 *   discarded, the microphone released and an upload aborted natively. So a
 *   late transcript never lands in a consumed or different draft, and audio
 *   is never rerouted to a newly chosen provider.
 * - Hiding the window discards a recording in progress. An upload continues,
 *   because its transcript still goes to the open thread. A native close
 *   request cancels either phase before the close guard finishes saving.
 * - The transcript is added to the draft and never sent.
 */
export function useVoiceInput({ threadKey, config, onTranscript, onPreview, onPreviewEnd }: {
  threadKey: string;
  config: VoiceInputConfig | undefined;
  onTranscript: (threadKey: string, text: string) => void;
  onPreview: (threadKey: string, sessionId: string, text: string, provisional: boolean) => boolean;
  onPreviewEnd: (threadKey: string, sessionId: string, keep: boolean) => void;
}) {
  const sessionRef = useRef<Session | null>(null);
  const [view, setView] = useState<VoiceInputView | null>(null);
  const [message, setMessage] = useState<VoiceInputMessage | null>(null);
  const configRef = useRef(config);
  configRef.current = config;
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const previewCallbacks = useRef({ onPreview, onPreviewEnd });
  previewCallbacks.current = { onPreview, onPreviewEnd };
  const threadKeyRef = useRef(threadKey);
  threadKeyRef.current = threadKey;
  const controlsRef = useRef({ onStop: () => {}, onCancel: () => {} });

  const publish = useCallback((session: Session | null) => {
    const next = session ? {
      phase: session.phase,
      threadKey: session.threadKey,
      provider: session.provider,
      model: session.model,
      startedAt: session.startedAt,
      recorder: session.recorder,
      mode: session.mode,
    } : null;
    setView(next);
    if (session && next) publishVoiceInputSession({
      id: session.id,
      view: next,
      onStop: () => controlsRef.current.onStop(),
      onCancel: () => controlsRef.current.onCancel(),
    });
  }, []);

  // Async completions can run after a new render but before its cancellation
  // effect. Check the current context here too, not just the session token.
  const active = (session: Session) => !session.canceled
    && sessionRef.current === session
    && session.threadKey === threadKeyRef.current
    && session.provider === configRef.current?.provider
    && session.model === configRef.current?.model.trim();

  /** Releases the microphone, the audio graph and any setup dialog. Idempotent. */
  const release = useCallback((session: Session, keepLiveText = false) => {
    if (session.canceled) return;
    // Invalidate callbacks before releasing capture or updating the draft.
    // A pending permission/socket completion can no longer regain ownership.
    session.canceled = true;
    if (session.previewTimer !== undefined) window.clearTimeout(session.previewTimer);
    session.previewTimer = undefined;
    session.controller.abort();
    clearVoiceInputSession(session.id);
    if (session.recorder) session.recorder.cancel();
    else if (session.context && session.context.state !== "closed") void session.context.close().catch(() => undefined);
    if (sessionRef.current === session) {
      sessionRef.current = null;
      publish(null);
    }
    if (session.mode === "live") {
      // An empty final result must also replace a pending provisional preview.
      // If the draft no longer accepts our preview, do not commit stale text.
      const keep = keepLiveText && previewCallbacks.current.onPreview(session.threadKey, session.id, session.liveText, session.provisional);
      previewCallbacks.current.onPreviewEnd(session.threadKey, session.id, keep);
    }
  }, [publish]);

  /** Ends any session, aborting a native upload too. A no-op when idle. */
  const cancel = useCallback((notice?: string, keepLiveText = false) => {
    const session = sessionRef.current;
    if (!session) return;
    if ((session.phase === "transcribing" || session.liveStarted) && session.requestId) cancelTranscription(session.requestId);
    release(session, keepLiveText);
    setMessage(notice ? { text: notice, tone: "info" } : null);
  }, [release]);

  // Visibility can change before its event is dispatched, or before the
  // session's listener mounts. Recheck after local awaits before opening the
  // microphone or submitting audio; an existing upload may still finish.
  const cancelIfHidden = useCallback((session: Session) => {
    if (document.visibilityState !== "hidden" || session.phase === "transcribing") return false;
    if (sessionRef.current === session) cancel(session.mode === "live"
      ? "Live dictation stopped because Mythra Code was hidden. Text already received has been kept."
      : HIDDEN_NOTICE, session.mode === "live");
    return true;
  }, [cancel]);

  const fail = useCallback((session: Session, text: string, settings = false) => {
    if (!active(session)) return;
    if ((session.phase === "transcribing" || session.liveStarted) && session.requestId) cancelTranscription(session.requestId);
    release(session, session.mode === "live");
    setMessage({ text, tone: "error", settings });
  }, [release]);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || session.phase !== "recording" || !session.recorder) return;
    if (cancelIfHidden(session)) return;
    session.phase = "finishing";
    publish(session);
    try {
      const recording = await session.recorder.stop();
      if (!active(session) || cancelIfHidden(session)) return;
      // Live audio has already been submitted. Always finalize it, even for
      // a quick or quiet utterance; the provider owns its recognition result.
      if (session.mode === "recorded" && (!recording || recording.seconds < MIN_RECORDING_SECONDS)) {
        fail(session, "That recording was too short to transcribe. Nothing was uploaded.");
        return;
      }
      if (session.mode === "recorded" && recording?.silent) {
        fail(session, "No sound reached the microphone, so nothing was uploaded. Check your input device and try again.");
        return;
      }
      session.phase = "transcribing";
      publish(session);
      if (!active(session)) return;
      if (!session.requestId) throw new Error("Could not prepare the transcription request. Start a new recording.");
      if (session.mode === "live") {
        await session.audioQueue;
        if (!active(session)) return;
        const text = await finishLiveTranscription(session.requestId);
        if (!active(session)) return;
        session.liveText = text;
        session.provisional = false;
        release(session, true);
        if (!text.trim()) setMessage({ text: "No speech was recognized. Your original draft has been kept.", tone: "info" });
        return;
      }
      if (!recording) throw new Error("The recording couldn't be prepared for upload. Nothing was uploaded.");
      const text = await transcribeRecording(session.requestId, session.provider, session.model, recording.wav);
      if (!active(session)) return;
      release(session);
      onTranscriptRef.current(session.threadKey, text);
    } catch (reason) {
      if (!active(session)) return;
      if (session.phase === "transcribing") {
        const text = safeErrorText(reason, "Transcription failed.");
        fail(session, text, /Settings › Voice input/.test(text));
      } else {
        fail(session, session.mode === "live" ? "Live dictation stopped. Text already received has been kept." : "The recording couldn't be prepared for upload. Nothing was uploaded.");
      }
    }
  }, [cancelIfHidden, fail, publish, release]);

  /** Keeps the session as the only admission while the dialog is open. */
  const askForSettings = useCallback(async (session: Session, prompt: string) => {
    if (session.context && session.context.state !== "closed") void session.context.close().catch(() => undefined);
    session.context = null;
    // No microphone is open. Let the setup confirmation own focus instead
    // of trapping it behind the voice interaction dialog.
    clearVoiceInputSession(session.id);
    const confirmed = await confirmDialog(prompt, {
      confirmLabel: "Open transcription settings",
      cancelLabel: "Not now",
      inApp: true,
      signal: session.controller.signal,
    });
    const current = active(session) && !cancelIfHidden(session);
    release(session);
    if (confirmed && current) configRef.current?.onOpenSettings();
  }, [cancelIfHidden, release]);

  const start = useCallback(async () => {
    const current = configRef.current;
    if (sessionRef.current || !current || isVoiceInputLocked() || document.visibilityState === "hidden") return;
    setMessage(null);
    if (!voiceCaptureSupported()) {
      setMessage({ text: "Voice input isn't supported in this window.", tone: "error" });
      return;
    }
    // Before any await: engines that gate audio on a user gesture see the click.
    let context: AudioContext;
    try {
      context = createVoiceAudioContext(transcriptionModeFor(current.provider, current.model) === "live" ? 24000 : undefined);
    } catch (reason) {
      setMessage({ text: reason instanceof VoiceCaptureError ? reason.message : "The microphone couldn't be started.", tone: "error" });
      return;
    }
    const session: Session = {
      id: newSessionId(),
      requestId: null,
      threadKey: threadKeyRef.current,
      provider: current.provider,
      model: current.model.trim(),
      phase: "preparing",
      startedAt: 0,
      context,
      recorder: null,
      canceled: false,
      controller: new AbortController(),
      mode: transcriptionModeFor(current.provider, current.model),
      liveStarted: false,
      liveText: "",
      provisional: true,
      audioQueue: Promise.resolve(),
      queuedBytes: 0,
      sequence: 0,
      segmentSeconds: 0,
      silenceSeconds: 0,
      segmentSpeech: false,
    };
    sessionRef.current = session;
    publish(session);
    const providerLabel = TRANSCRIPTION_PROVIDER_LABELS[session.provider];
    const setupTimer = window.setTimeout(() => {
      fail(session, "The microphone didn't start in time. Check for a permission prompt, then try again.");
    }, SETUP_TIMEOUT_MS);
    try {
      const keys = await refreshTranscriptionKeys();
      if (!active(session) || cancelIfHidden(session)) return;
      if (keys[session.provider] === "missing") {
        window.clearTimeout(setupTimer);
        await askForSettings(session, `No transcription API key\n\nNo API key is set for transcription. Voice input uses its own ${providerLabel} API key, separate from your chat accounts and subscriptions.`);
        return;
      }
      if (keys[session.provider] !== "saved") {
        fail(session, "The transcription key couldn't be read from the OS credential store. Check for a system prompt, then try again.");
        return;
      }
      if (!session.model) {
        window.clearTimeout(setupTimer);
        await askForSettings(session, `Choose a transcription model\n\nPick which ${providerLabel} model turns your recordings into text.`);
        return;
      }
      const requestId = await createTranscriptionRequestId();
      session.requestId = requestId;
      if (!active(session)) {
        // No audio request was submitted. Leave this unused ticket alone:
        // an IPC retry can mint it after a newer recording obtained its ID.
        // Consuming it would incorrectly invalidate that newer recording.
        return;
      }
      if (cancelIfHidden(session)) return;
      if (session.mode === "live") {
        session.liveStarted = true;
        await startLiveTranscription(requestId, session.provider, session.model, (event) => {
          if (!active(session) || event.id !== session.requestId) return;
          if (event.type === "error") { fail(session, event.message, /Settings › Voice input/.test(event.message)); return; }
          session.liveText = event.text;
          session.provisional = event.provisional;
          if (session.previewTimer !== undefined) return;
          session.previewTimer = window.setTimeout(() => {
            session.previewTimer = undefined;
            if (active(session) && !previewCallbacks.current.onPreview(session.threadKey, session.id, session.liveText, session.provisional)) {
              fail(session, "Dictation stopped because the destination draft changed. Your existing draft has been kept.");
            }
          }, 60);
        }, session.controller.signal);
        if (!active(session) || cancelIfHidden(session)) return;
      }
      const recorder = new VoiceRecorder(context, {
        onLimit: () => void stop(),
        onInterrupted: () => fail(session, session.mode === "live"
          ? "The microphone stopped. Text already received has been kept."
          : "Recording stopped because the microphone was disconnected or access was turned off. Nothing was uploaded."),
      }, session.mode === "live" ? { sampleRate: 24000, onPcm: (bytes, seconds, speaking) => {
        if (!active(session) || !session.requestId) return;
        session.queuedBytes += bytes.length;
        if (session.queuedBytes > 192_000) { fail(session, "Live dictation could not keep up with the audio. Text already received has been kept."); return; }
        session.segmentSeconds += seconds;
        if (speaking) { session.silenceSeconds = 0; session.segmentSpeech = true; }
        else session.silenceSeconds += seconds;
        const commit = (session.segmentSpeech && session.silenceSeconds >= 0.7 && session.segmentSeconds >= 1.2) || session.segmentSeconds >= 25;
        if (commit) { session.segmentSeconds = 0; session.silenceSeconds = 0; session.segmentSpeech = false; }
        const sequence = session.sequence++;
        session.audioQueue = session.audioQueue.then(async () => {
          if (active(session) && session.requestId) await appendLiveAudio(session.requestId, sequence, bytes, commit);
        }).catch((reason) => { fail(session, safeErrorText(reason, "Live dictation stopped. Text already received has been kept.")); })
          .finally(() => { session.queuedBytes -= bytes.length; });
      } } : undefined);
      session.recorder = recorder;
      await recorder.start();
      if (!active(session) || cancelIfHidden(session)) return;
      session.phase = "recording";
      session.startedAt = performance.now();
      publish(session);
    } catch (reason) {
      fail(session, reason instanceof VoiceCaptureError ? reason.message
        : session.mode === "live" ? safeErrorText(reason, "Live dictation could not start. Check your connection and selected model.")
        : session.recorder ? "The microphone couldn't be started."
          : "Voice input couldn't be prepared. Nothing was recorded.");
    } finally {
      window.clearTimeout(setupTimer);
    }
  }, [askForSettings, cancelIfHidden, fail, publish, stop]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session) setMessage(null);
    else if (session.threadKey !== threadKey) cancel("Voice input canceled because you switched threads.");
  }, [cancel, threadKey]);

  // Audio recorded for one provider and model is never sent to another.
  const configProvider = config?.provider;
  const configModel = config?.model.trim();
  useEffect(() => {
    const session = sessionRef.current;
    if (session && (session.provider !== configProvider || session.model !== configModel)) {
      cancel("Voice input canceled because the transcription settings changed.");
    }
  }, [cancel, configModel, configProvider]);

  // Listen only while a session exists: an idle composer must not hold a
  // close-requested listener, which would make Tauri wait on the close guard.
  const hasSession = view !== null;
  useEffect(() => {
    if (!hasSession) return;
    let disposed = false;
    let stopClose: (() => void) | undefined;
    const onHidden = () => {
      const session = sessionRef.current;
      if (document.visibilityState !== "hidden" || !session) return;
      // Hiding must not turn an unsent recording into a paid upload. Discard
      // setup, recording, and the local flush; a submitted upload may finish.
      cancelIfHidden(session);
    };
    const onPageHide = () => cancel();
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    onHidden();
    if (isTauri()) {
      // App's close guard keeps the WebView alive while saves or a native
      // consent dialog are pending. pagehide happens too late to release the
      // microphone (and could allow a transcript to land after that save).
      // Listen directly: onCloseRequested's wrapper can destroy the window,
      // but only useFlushOnClose / Rust may decide when it is safe to close.
      void getCurrentWindow().listen(TauriEvent.WINDOW_CLOSE_REQUESTED, () => {
        if (!disposed) cancel("Voice input canceled because the window is closing.");
      }).then((unlisten) => {
        if (disposed) unlisten();
        else stopClose = unlisten;
      }).catch(() => { /* Visibility and pagehide cleanup remain available. */ });
    }
    return () => {
      disposed = true;
      stopClose?.();
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [cancel, cancelIfHidden, hasSession]);

  // Unmount releases the microphone and aborts any upload.
  useEffect(() => () => {
    const session = sessionRef.current;
    if (!session) return;
    if ((session.phase === "transcribing" || session.liveStarted) && session.requestId) cancelTranscription(session.requestId);
    release(session);
  }, [release]);

  const dismissMessage = useCallback(() => setMessage(null), []);
  controlsRef.current = { onStop: () => void stop(), onCancel: () => cancel() };

  return { view, message, start, stop, cancel, dismissMessage };
}
