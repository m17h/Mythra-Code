import { create } from "zustand";
import type { VoiceInputView } from "../hooks/useVoiceInput";

export interface VoiceInteractionSession {
  id: string;
  view: VoiceInputView;
  onStop: () => void;
  onCancel: () => void;
}

/** Synchronous admission also covers shortcuts before React has committed. */
export const useVoiceInputLock = create<{ session: VoiceInteractionSession | null }>(() => ({ session: null }));
let generation = 0;

export function isVoiceInputLocked(): boolean {
  return useVoiceInputLock.getState().session !== null;
}

/** Pending navigation cannot regain ownership after a voice session ends. */
export function voiceInputLockGeneration(): number {
  return generation;
}

export function publishVoiceInputSession(session: VoiceInteractionSession): void {
  const current = useVoiceInputLock.getState().session;
  if (current && current.id !== session.id) return;
  if (!current) generation += 1;
  useVoiceInputLock.setState({ session });
}

export function clearVoiceInputSession(id: string): void {
  if (useVoiceInputLock.getState().session?.id === id) useVoiceInputLock.setState({ session: null });
}
