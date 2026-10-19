// Voice input capture. Runs on the audio rendering thread and forwards mono
// float samples in batches; the page resamples and encodes them. Served from
// the app's own origin so it satisfies `script-src 'self'`.
const BATCH_FRAMES = 4096;

class MythraVoiceCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const maxSeconds = options.processorOptions?.maxSeconds;
    const maxFrames = Math.ceil(sampleRate * maxSeconds);
    if (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || !Number.isSafeInteger(maxFrames)) {
      throw new RangeError("A finite recording limit is required.");
    }
    this.remainingFrames = maxFrames;
    this.batch = new Float32Array(BATCH_FRAMES);
    this.length = 0;
    this.active = true;
    this.port.onmessage = (event) => {
      if (event.data === "flush") {
        // Freeze capture before the final batch and marker. No audio may be
        // posted after that marker while the page is releasing the graph.
        this.active = false;
        this.post();
        this.port.postMessage({ type: "flushed" });
      } else if (event.data === "stop") {
        this.active = false;
        this.length = 0;
      }
    };
  }

  post() {
    if (!this.length) return;
    const samples = this.batch.slice(0, this.length);
    this.length = 0;
    this.port.postMessage({ type: "audio", samples }, [samples.buffer]);
  }

  process(inputs) {
    if (!this.active) return false;
    // Bound audio-thread message storage even if the page stops handling its
    // port or timers. Keep the processor alive to acknowledge a later flush.
    if (this.remainingFrames === 0) return true;
    const channels = inputs[0];
    if (channels && channels.length > 0) {
      const frames = Math.min(channels[0].length, this.remainingFrames);
      const count = channels.length;
      for (let frame = 0; frame < frames; frame += 1) {
        let sum = 0;
        for (let channel = 0; channel < count; channel += 1) sum += channels[channel][frame];
        this.batch[this.length] = sum / count;
        this.length += 1;
        if (this.length === BATCH_FRAMES) this.post();
      }
      this.remainingFrames -= frames;
      if (this.remainingFrames === 0) {
        this.post();
        this.port.postMessage({ type: "limit" });
      }
    }
    return true;
  }
}

registerProcessor("mythra-voice-capture", MythraVoiceCapture);
