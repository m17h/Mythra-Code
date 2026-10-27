import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { TranscriptionProvider } from "../types";

export type LiveTranscriptionEvent =
  | { type: "transcript"; id: string; text: string; provisional: boolean }
  | { type: "error"; id: string; message: string };

export async function startLiveTranscription(id: string, provider: TranscriptionProvider, model: string, receive: (event: LiveTranscriptionEvent) => void, signal: AbortSignal): Promise<void> {
  const unlisten = await getCurrentWindow().listen<LiveTranscriptionEvent>("transcription-live-event", ({ payload }) => {
    if (!signal.aborted && payload.id === id) receive(payload);
  });
  let listening = true;
  const cleanup = () => {
    if (!listening) return;
    listening = false;
    signal.removeEventListener("abort", cleanup);
    unlisten();
  };
  if (signal.aborted) { cleanup(); return; }
  signal.addEventListener("abort", cleanup, { once: true });
  try { await invoke("transcription_live_start", { id, provider, model }); }
  catch (error) { cleanup(); throw error; }
}

export function appendLiveAudio(id: string, sequence: number, bytes: Uint8Array, commit: boolean): Promise<void> {
  return invoke("transcription_live_append", bytes, { headers: {
    "Mythra-Transcription-Id": id,
    "Mythra-Audio-Sequence": String(sequence),
    "Mythra-Audio-Commit": commit ? "1" : "0",
  } });
}

export const finishLiveTranscription = (id: string) => invoke<string>("transcription_live_finish", { id });
