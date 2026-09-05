import { useEffect, useRef } from "react";
import { createTranscriptSaveScheduler } from "../lib/transcriptSaveScheduler";
import { useTaskStore } from "../lib/taskStore";
import { recordError } from "../lib/errorLog";

export function useTranscriptSaves(save: (threadId: string) => Promise<boolean>) {
  const saveRef = useRef(save);
  saveRef.current = save;
  const scheduler = useRef<ReturnType<typeof createTranscriptSaveScheduler> | null>(null);
  if (!scheduler.current) scheduler.current = createTranscriptSaveScheduler({
    save: (id) => saveRef.current(id),
    dirty: (id, dirty) => useTaskStore.getState().setTranscriptDirty(id, dirty),
    onError: (error) => recordError(`Transcript save failed: ${String(error)}`),
  });
  const instance = scheduler.current;
  useEffect(() => () => instance.dispose(), [instance]);
  return instance;
}
