import { isMacPlatform, isWindowsPlatform } from "./platform";

/**
 * Microphone capture for voice input. Recorded mode retains mono PCM for a
 * bounded 16 kHz WAV upload. Live mode emits 24 kHz PCM packets immediately
 * without retaining a second recording in memory.
 */

const WORKLET_URL = "/voice-capture-worklet.js";
const WORKLET_NAME = "mythra-voice-capture";
const TARGET_SAMPLE_RATE = 16_000;
export const MAX_RECORDING_SECONDS = 10 * 60;
export const MIN_RECORDING_SECONDS = 0.5;
/** Peak amplitude below which a whole recording counts as silence. */
const SILENCE_PEAK = 0.005;
const FLUSH_TIMEOUT_MS = 400;
const FALLBACK_BUFFER_FRAMES = 4096;

export type VoiceCaptureErrorKind = "unsupported" | "permission" | "no-device" | "busy" | "failed";

export class VoiceCaptureError extends Error {
  constructor(readonly kind: VoiceCaptureErrorKind, message: string) {
    super(message);
    this.name = "VoiceCaptureError";
  }
}

export interface VoiceRecording {
  wav: Uint8Array;
  seconds: number;
  silent: boolean;
}

export interface VoiceRecorderEvents {
  /** The duration limit was reached; the owner should stop and transcribe. */
  onLimit: () => void;
  /** The input device disappeared or access was revoked mid-recording. */
  onInterrupted: () => void;
}

export interface VoiceRecorderOptions {
  sampleRate?: number;
  /** Stream raw little-endian PCM16 as it arrives, without retaining the clip. */
  onPcm?: (bytes: Uint8Array, seconds: number, speaking: boolean) => void;
}

type AudioContextConstructor = typeof AudioContext;

function audioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") return null;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext ?? null;
}

export function voiceCaptureSupported(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && audioContextConstructor() !== null;
}

/**
 * Create (and start) the audio graph's context synchronously inside the click
 * that started recording, so engines that require a user gesture for audio
 * allow it. Creating a context does not open the microphone.
 */
export function createVoiceAudioContext(sampleRate?: number): AudioContext {
  const Context = audioContextConstructor();
  if (!Context) throw new VoiceCaptureError("unsupported", "Voice input isn't supported in this window.");
  const context = new Context({ latencyHint: "interactive", ...(sampleRate ? { sampleRate } : {}) });
  void context.resume().catch(() => undefined);
  return context;
}

function permissionMessage(): string {
  if (isMacPlatform()) return "Microphone access is off for Mythra Code. Turn it on in System Settings › Privacy & Security › Microphone, then try again.";
  if (isWindowsPlatform()) return "Microphone access is blocked. Allow it when Mythra Code asks, and check Settings › Privacy & security › Microphone, then try again.";
  return "Microphone access was denied. Allow microphone access for Mythra Code, then try again.";
}

function captureError(reason: unknown): VoiceCaptureError {
  if (reason instanceof VoiceCaptureError) return reason;
  const name = reason instanceof DOMException || reason instanceof Error ? reason.name : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return new VoiceCaptureError("permission", permissionMessage());
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return new VoiceCaptureError("no-device", "No microphone was found. Connect one and try again.");
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return new VoiceCaptureError("busy", "The microphone couldn't be started. Another app may be using it.");
  return new VoiceCaptureError("failed", "The microphone couldn't be started.");
}

/** Box-filter decimation: averaging each output window is a cheap low-pass for speech. */
class Downsampler {
  private sum = 0;
  private count = 0;
  private consumed = 0;
  private next: number;

  constructor(private readonly ratio: number) {
    this.next = ratio;
  }

  push(input: Float32Array, room: number): Int16Array {
    const output = new Int16Array(Math.min(room, Math.ceil(input.length / this.ratio) + 1));
    let written = 0;
    for (let index = 0; index < input.length && written < output.length; index += 1) {
      this.sum += input[index];
      this.count += 1;
      this.consumed += 1;
      if (this.consumed >= this.next) {
        const sample = Math.max(-1, Math.min(1, this.sum / this.count));
        output[written] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        written += 1;
        this.sum = 0;
        this.count = 0;
        this.next += this.ratio;
      }
    }
    return output.subarray(0, written);
  }
}

function encodeWav(chunks: Int16Array[], samples: number, sampleRate: number): Uint8Array {
  const dataBytes = samples * 2;
  const wav = new Uint8Array(44 + dataBytes);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) wav[offset + index] = text.charCodeAt(index);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      view.setInt16(offset, chunk[index], true);
      offset += 2;
    }
  }
  return wav;
}

/**
 * One recording. The owner creates the context in the user's click, calls
 * `start`, then exactly one of `stop` or `cancel`. Every path releases the
 * microphone, the audio graph and the context.
 */
export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private fallback: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private downsampler: Downsampler | null = null;
  private chunks: Int16Array[] = [];
  private samples = 0;
  private maxSamples = 0;
  private peak = 0;
  private released = false;
  private stopping = false;
  private limitReported = false;
  /** Wall-clock cap, so a graph that stops delivering frames can't hold the microphone. */
  private deadline: number | undefined;
  private flushed: (() => void) | null = null;
  /** Recent input level (0–1) for the meter; read on animation frames, not pushed. */
  level = 0;
  sampleRate = TARGET_SAMPLE_RATE;

  constructor(private readonly context: AudioContext, private readonly events: VoiceRecorderEvents, private readonly options: VoiceRecorderOptions = {}) {}

  private readonly onContextStateChange = () => {
    if (this.context.state !== "running") this.interrupt();
  };

  private interrupt(): void {
    if (this.released) return;
    this.cancel();
    this.events.onInterrupted();
  }

  get seconds(): number {
    return this.samples / this.sampleRate;
  }

  async start(): Promise<void> {
    if (this.released) throw new VoiceCaptureError("failed", "Recording was canceled.");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (reason) {
      this.release();
      throw captureError(reason);
    }
    // Canceled while the permission prompt was open: close what just opened.
    if (this.released) {
      for (const track of stream.getTracks()) track.stop();
      throw new VoiceCaptureError("failed", "Recording was canceled.");
    }
    this.stream = stream;
    try {
      const track = stream.getAudioTracks()[0];
      if (!track) throw new VoiceCaptureError("no-device", "No microphone was found. Connect one and try again.");
      track.addEventListener("ended", () => this.interrupt(), { once: true });
      if (track.readyState !== "live") throw new VoiceCaptureError("no-device", "The microphone was disconnected. Connect it and try again.");
      const rate = this.context.sampleRate;
      const target = this.options.sampleRate ?? TARGET_SAMPLE_RATE;
      if (this.options.onPcm && rate < target) throw new VoiceCaptureError("unsupported", "This audio device cannot provide the sample rate for live dictation. Choose an After recording model.");
      this.sampleRate = Math.min(target, Math.round(rate));
      this.maxSamples = this.sampleRate * MAX_RECORDING_SECONDS;
      this.downsampler = new Downsampler(rate / this.sampleRate);
      this.source = this.context.createMediaStreamSource(stream);
      // A muted sink keeps the capture node in the rendering graph without
      // playing the microphone back.
      this.sink = this.context.createGain();
      this.sink.gain.value = 0;
      this.sink.connect(this.context.destination);
      if (!await this.connectWorklet()) this.connectFallback();
      if (this.released) throw new VoiceCaptureError("failed", "Recording was canceled.");
      if (this.context.state !== "running") await this.context.resume();
      if (this.released) throw new VoiceCaptureError("failed", "Recording was canceled.");
      if (track.readyState !== "live" || this.context.state !== "running") {
        throw new VoiceCaptureError("failed", "The microphone stopped before recording could start. Try again.");
      }
      this.context.addEventListener("statechange", this.onContextStateChange);
      this.deadline = window.setTimeout(() => this.reportLimit(), (MAX_RECORDING_SECONDS + 1) * 1000);
    } catch (reason) {
      this.release();
      throw captureError(reason);
    }
  }

  private async connectWorklet(): Promise<boolean> {
    if (!this.context.audioWorklet || typeof AudioWorkletNode === "undefined") return false;
    let node: AudioWorkletNode | null = null;
    try {
      await this.context.audioWorklet.addModule(WORKLET_URL);
      if (this.released || !this.source || !this.sink) return true;
      node = new AudioWorkletNode(this.context, WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
        processorOptions: { maxSeconds: MAX_RECORDING_SECONDS },
      });
      node.port.onmessage = (event: MessageEvent<{ type: string; samples?: Float32Array }>) => {
        if (event.data.type === "audio" && event.data.samples) this.accept(event.data.samples);
        else if (event.data.type === "flushed") this.flushed?.();
        else if (event.data.type === "limit") this.reportLimit();
      };
      node.onprocessorerror = () => this.interrupt();
      this.source.connect(node);
      node.connect(this.sink);
      this.worklet = node;
      return true;
    } catch {
      if (node) {
        try { this.source?.disconnect(node); } catch { /* not connected */ }
        try { node.disconnect(); } catch { /* not connected */ }
        node.onprocessorerror = null;
        node.port.onmessage = null;
        node.port.close();
      }
      // Engines that cannot load the module still have the older processor.
      return false;
    }
  }

  private connectFallback(): void {
    if (!this.source || !this.sink) return;
    const node = this.context.createScriptProcessor(FALLBACK_BUFFER_FRAMES, 1, 1);
    node.onaudioprocess = (event) => {
      // getChannelData returns a view the engine reuses; copy it.
      this.accept(new Float32Array(event.inputBuffer.getChannelData(0)));
      // Unlike a worklet, ScriptProcessor cannot flush a partial input buffer.
      // Stop keeps exactly one final callback so the buffered speech tail is
      // retained; resolving the flush also freezes further fallback capture.
      if (this.stopping) this.flushed?.();
    };
    this.source.connect(node);
    node.connect(this.sink);
    this.fallback = node;
  }

  private accept(input: Float32Array): void {
    if (this.released || !this.downsampler) return;
    let peak = 0;
    let energy = 0;
    for (let index = 0; index < input.length; index += 1) {
      const sample = Math.abs(input[index]);
      if (sample > peak) peak = sample;
      energy += sample * sample;
    }
    this.level = Math.min(1, Math.sqrt(energy / Math.max(1, input.length)) * 4);
    const room = this.maxSamples - this.samples;
    if (room <= 0) return;
    if (peak > this.peak) this.peak = peak;
    const chunk = this.downsampler.push(input, room);
    if (chunk.length) {
      if (this.options.onPcm) {
        const bytes = new Uint8Array(chunk.length * 2);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < chunk.length; i += 1) view.setInt16(i * 2, chunk[i], true);
        this.options.onPcm(bytes, chunk.length / this.sampleRate, peak > SILENCE_PEAK);
      } else this.chunks.push(chunk);
      this.samples += chunk.length;
    }
    if (this.samples >= this.maxSamples) this.reportLimit();
  }

  private reportLimit(): void {
    if (this.released || this.stopping || this.limitReported) return;
    this.limitReported = true;
    this.events.onLimit();
  }

  /** Collects the last rendered frames, releases the microphone and encodes. */
  async stop(): Promise<VoiceRecording | null> {
    if (this.released || this.stopping) return null;
    this.stopping = true;
    if (this.deadline !== undefined) window.clearTimeout(this.deadline);
    this.deadline = undefined;
    if (this.worklet || this.fallback) {
      const worklet = this.worklet;
      const fallback = this.fallback;
      // At 8 kHz a 4096-frame fallback buffer takes 512 ms, so a fixed
      // 400 ms timeout can drop its tail even on a healthy audio graph.
      // Allow one buffer plus scheduling room, but never wait indefinitely.
      const flushTimeout = fallback
        ? Math.min(1_000, Math.max(FLUSH_TIMEOUT_MS, Math.ceil(FALLBACK_BUFFER_FRAMES * 1000 / this.context.sampleRate) + 100))
        : FLUSH_TIMEOUT_MS;
      await new Promise<void>((resolve) => {
        const finish = () => {
          if (this.flushed !== finish) return;
          window.clearTimeout(timer);
          this.flushed = null;
          if (fallback) fallback.onaudioprocess = null;
          resolve();
        };
        const timer = window.setTimeout(finish, flushTimeout);
        this.flushed = finish;
        if (worklet) {
          try { worklet.port.postMessage("flush"); }
          catch { finish(); }
        }
      });
    }
    if (this.released) return null;
    const { chunks, samples, sampleRate } = this;
    const silent = this.peak < SILENCE_PEAK;
    this.chunks = [];
    this.release();
    if (!samples) return null;
    return { wav: this.options.onPcm ? new Uint8Array(0) : encodeWav(chunks, samples, sampleRate), seconds: samples / sampleRate, silent };
  }

  /** Discards everything recorded and releases the microphone immediately. */
  cancel(): void {
    this.chunks = [];
    this.samples = 0;
    this.release();
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    this.level = 0;
    this.context.removeEventListener("statechange", this.onContextStateChange);
    if (this.deadline !== undefined) window.clearTimeout(this.deadline);
    this.deadline = undefined;
    this.flushed?.();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    try { this.source?.disconnect(); } catch { /* already disconnected */ }
    if (this.worklet) {
      try { this.worklet.port.postMessage("stop"); } catch { /* port closed */ }
      this.worklet.port.onmessage = null;
      this.worklet.onprocessorerror = null;
      this.worklet.port.close();
      try { this.worklet.disconnect(); } catch { /* already disconnected */ }
    }
    if (this.fallback) {
      this.fallback.onaudioprocess = null;
      try { this.fallback.disconnect(); } catch { /* already disconnected */ }
    }
    try { this.sink?.disconnect(); } catch { /* already disconnected */ }
    this.source = null;
    this.worklet = null;
    this.fallback = null;
    this.sink = null;
    this.downsampler = null;
    if (this.context.state !== "closed") void this.context.close().catch(() => undefined);
  }
}
