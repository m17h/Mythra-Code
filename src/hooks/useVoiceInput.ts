import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { TauriEvent } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirmDialog } from "../lib/confirmDialog";
import { safeErrorText } from "../lib/errors";
import {
  cancelTranscription,
  refreshTranscriptionKeys,
  transcribeRecording,
  TRANSCRIPTION_PROVIDER_LABELS,
} from "../lib/transcription";
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
}

export interface VoiceInputMessage {
  text: string;
  tone: "error" | "info";
  /** Offer Voice input settings beside the message. */
  settings?: boolean;
}

interface Session {
  id: string;
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
}

/** Key check plus microphone start, including an OS permission prompt. */
const SETUP_TIMEOUT_MS = 60_000;

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
export function useVoiceInput({ threadKey, config, onTranscript }: {
  threadKey: string;
  config: VoiceInputConfig | undefined;
  onTranscript: (threadKey: string, text: string) => void;
}) {
  const sessionRef = useRef<Session | null>(null);
  const [view, setView] = useState<VoiceInputView | null>(null);
  const [message, setMessage] = useState<VoiceInputMessage | null>(null);
  const configRef = useRef(config);
  configRef.current = config;
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const threadKeyRef = useRef(threadKey);
  threadKeyRef.current = threadKey;

  const publish = useCallback((session: Session | null) => {
    setView(session ? {
      phase: session.phase,
      threadKey: session.threadKey,
      provider: session.provider,
      model: session.model,
      startedAt: session.startedAt,
      recorder: session.recorder,
    } : null);
  }, []);

  // Async completions can run after a new render but before its cancellation
  // effect. Check the current context here too, not just the session token.
  const active = (session: Session) => !session.canceled
    && sessionRef.current === session
    && session.threadKey === threadKeyRef.current
    && session.provider === configRef.current?.provider
    && session.model === configRef.current?.model.trim();

  /** Releases the microphone, the audio graph and any setup dialog. Idempotent. */
  const release = useCallback((session: Session) => {
    session.canceled = true;
    session.controller.abort();
    if (session.recorder) session.recorder.cancel();
    else if (session.context && session.context.state !== "closed") void session.context.close().catch(() => undefined);
    if (sessionRef.current === session) {
      sessionRef.current = null;
      publish(null);
    }
  }, [publish]);

  /** Ends any session, aborting a native upload too. A no-op when idle. */
  const cancel = useCallback((notice?: string) => {
    const session = sessionRef.current;
    if (!session) return;
    if (session.phase === "transcribing") cancelTranscription(session.id);
    release(session);
    setMessage(notice ? { text: notice, tone: "info" } : null);
  }, [release]);

  const fail = useCallback((session: Session, text: string, settings = false) => {
    if (!active(session)) return;
    if (session.phase === "transcribing") cancelTranscription(session.id);
    release(session);
    setMessage({ text, tone: "error", settings });
  }, [release]);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || session.phase !== "recording" || !session.recorder) return;
    session.phase = "finishing";
    publish(session);
    try {
      const recording = await session.recorder.stop();
      if (!active(session)) return;
      if (!recording || recording.seconds < MIN_RECORDING_SECONDS) {
        fail(session, "That recording was too short to transcribe. Nothing was uploaded.");
        return;
      }
      if (recording.silent) {
        fail(session, "No sound reached the microphone, so nothing was uploaded. Check your input device and try again.");
        return;
      }
      session.phase = "transcribing";
      publish(session);
      const text = await transcribeRecording(session.id, session.provider, session.model, recording.wav);
      if (!active(session)) return;
      release(session);
      onTranscriptRef.current(session.threadKey, text);
    } catch (reason) {
      if (!active(session)) return;
      if (session.phase === "transcribing") {
        const text = safeErrorText(reason, "Transcription failed.");
        fail(session, text, /Settings › Voice input/.test(text));
      } else {
        fail(session, "The recording couldn't be prepared for upload. Nothing was uploaded.");
      }
    }
  }, [fail, publish, release]);

  /** Keeps the session as the only admission while the dialog is open. */
  const askForSettings = useCallback(async (session: Session, prompt: string) => {
    if (session.context && session.context.state !== "closed") void session.context.close().catch(() => undefined);
    session.context = null;
    const confirmed = await confirmDialog(prompt, {
      confirmLabel: "Open transcription settings",
      cancelLabel: "Not now",
      inApp: true,
      signal: session.controller.signal,
    });
    const current = active(session);
    release(session);
    if (confirmed && current) configRef.current?.onOpenSettings();
  }, [release]);

  const start = useCallback(async () => {
    const current = configRef.current;
    if (sessionRef.current || !current) return;
    setMessage(null);
    if (!voiceCaptureSupported()) {
      setMessage({ text: "Voice input isn't supported in this window.", tone: "error" });
      return;
    }
    // Before any await: engines that gate audio on a user gesture see the click.
    let context: AudioContext;
    try {
      context = createVoiceAudioContext();
    } catch (reason) {
      setMessage({ text: reason instanceof VoiceCaptureError ? reason.message : "The microphone couldn't be started.", tone: "error" });
      return;
    }
    const session: Session = {
      id: newSessionId(),
      threadKey: threadKeyRef.current,
      provider: current.provider,
      model: current.model.trim(),
      phase: "preparing",
      startedAt: 0,
      context,
      recorder: null,
      canceled: false,
      controller: new AbortController(),
    };
    sessionRef.current = session;
    publish(session);
    const providerLabel = TRANSCRIPTION_PROVIDER_LABELS[session.provider];
    const setupTimer = window.setTimeout(() => {
      fail(session, "The microphone didn't start in time. Check for a permission prompt, then try again.");
    }, SETUP_TIMEOUT_MS);
    try {
      const keys = await refreshTranscriptionKeys();
      if (!active(session)) return;
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
      const recorder = new VoiceRecorder(context, {
        onLimit: () => void stop(),
        onInterrupted: () => fail(session, "Recording stopped because the microphone was disconnected or access was turned off. Nothing was uploaded."),
      });
      session.recorder = recorder;
      await recorder.start();
      if (!active(session)) return;
      session.phase = "recording";
      session.startedAt = performance.now();
      publish(session);
    } catch (reason) {
      fail(session, reason instanceof VoiceCaptureError ? reason.message : "The microphone couldn't be started.");
    } finally {
      window.clearTimeout(setupTimer);
    }
  }, [askForSettings, fail, publish, stop]);

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

  useEffect(() => {
    let disposed = false;
    let stopClose: (() => void) | undefined;
    const onHidden = () => {
      const session = sessionRef.current;
      if (document.visibilityState === "hidden" && session && session.phase !== "transcribing") {
        cancel("Recording discarded because Mythra Code was hidden.");
      }
    };
    const onPageHide = () => cancel();
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
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
  }, [cancel]);

  // Unmount releases the microphone and aborts any upload.
  useEffect(() => () => {
    const session = sessionRef.current;
    if (!session) return;
    if (session.phase === "transcribing") cancelTranscription(session.id);
    release(session);
  }, [release]);

  const dismissMessage = useCallback(() => setMessage(null), []);

  return { view, message, start, stop, cancel, dismissMessage };
}
