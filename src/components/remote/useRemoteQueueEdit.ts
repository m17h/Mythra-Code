import { useCallback, useEffect } from "react";
import { create } from "zustand";
import { hostRead, hostRows, hostWrite } from "../../lib/remote/remoteActions";
import type { WireParityReadResult } from "../../lib/remote/wire";
import { discardQueuedEditDraft } from "../Composer";

interface Hold { handle: string; generation: number }
/** In memory, so a paused message can still be finished after a machine switch. */
const useHolds = create<{ holds: Record<string, Hold> }>(() => ({ holds: {} }));
const beginning = new Set<string>();
const finishing = new Set<string>();
let generation = 0;
function setHold(key: string, hold: Hold | null) {
  useHolds.setState(({ holds: { [key]: _previous, ...rest } }) => ({ holds: hold ? { ...rest, [key]: hold } : rest }));
}

interface QueueEditOptions {
  device: string; name: string; threadId?: string; workspaceId?: string; draftScope: string;
  /** What the host currently lists. `null` while the view isn't current. */
  rowIds: readonly string[] | null;
  onNotice: (message: string) => void;
}

/**
 * An edit of a queued message exists only once the host has granted the hold,
 * so nothing can be saved before that. The text stays until the host confirms
 * the edit ended: a reply can be lost, and the editor is the only copy.
 */
export function useRemoteQueueEdit({ device, name, threadId, workspaceId, draftScope, rowIds, onNotice }: QueueEditOptions) {
  const prefix = `${draftScope}/`;
  const holdIds = useHolds((state) => Object.keys(state.holds).filter((key) => key.startsWith(prefix)).join("\n"));
  const read = useCallback(() => hostRead<WireParityReadResult>(device, "queue.read", { workspaceId, threadId }), [device, threadId, workspaceId]);
  const end = useCallback((id: string) => {
    setHold(`${prefix}${id}`, null);
    discardQueuedEditDraft(id, draftScope);
  }, [draftScope, prefix]);

  const begin = useCallback((id: string) => {
    const key = `${prefix}${id}`;
    if (!threadId || !workspaceId || useHolds.getState().holds[key] || beginning.has(key)) return true;
    beginning.add(key);
    void (async () => {
      try {
        const { revision } = await read();
        const outcome = await hostWrite<{ editHandle?: string }>(device, name, "queue.edit.begin", { workspaceId, threadId, revision, queueId: id });
        const handle = outcome.result?.editHandle;
        if (outcome.ok && handle) setHold(key, { handle, generation: ++generation });
        else onNotice(outcome.message || `${name} didn't let this message be edited.`);
      } catch { onNotice(`Mythra Code couldn't reach ${name}. Try again.`); }
      finally { beginning.delete(key); }
    })();
    return true;
  }, [device, name, onNotice, prefix, read, threadId, workspaceId]);

  /** Whether the host shows this edit as over, whatever became of the reply. */
  const settled = useCallback(async (id: string, text: string | undefined) => {
    const row = hostRows(await read()).find((entry) => entry.queueId === id || entry.id === id);
    if (!row) return true;
    return !row.editing && (text === undefined || row.text === text);
  }, [read]);

  const finish = useCallback((id: string, text?: string) => {
    const key = `${prefix}${id}`;
    const hold = useHolds.getState().holds[key];
    if (!hold || finishing.has(key)) return false;
    finishing.add(key);
    const stillThisEdit = () => useHolds.getState().holds[key]?.generation === hold.generation;
    const attempt = async (editHandle: string) => {
      const { revision } = await read();
      return hostWrite(device, name, "queue.edit.finish", { workspaceId, threadId, revision, queueId: id, editHandle, ...(text === undefined ? { cancel: true } : { text }) });
    };
    void (async () => {
      try {
        let outcome = await attempt(hold.handle);
        if (!stillThisEdit()) return;
        if (outcome.ok || await settled(id, text)) { if (stillThisEdit()) end(id); return; }
        // Holds expire, and a host restart ends them. The row is still there, so ask
        // for it again: the host decides who owns it, and the text waits here meanwhile.
        if (outcome.code === "stale_target") {
          const { revision } = await read();
          const renewed = await hostWrite<{ editHandle?: string }>(device, name, "queue.edit.begin", { workspaceId, threadId, revision, queueId: id });
          const editHandle = renewed.result?.editHandle;
          if (!stillThisEdit()) return;
          if (renewed.ok && editHandle) {
            setHold(key, { handle: editHandle, generation: hold.generation });
            outcome = await attempt(editHandle);
            if (!stillThisEdit()) return;
            if (outcome.ok || await settled(id, text)) { if (stillThisEdit()) end(id); return; }
          } else { onNotice(`Someone else may be editing this message on ${name}. Your text is still here.`); return; }
        }
        onNotice(outcome.message || `${name} didn't save that edit. Your text is still here.`);
      } catch { if (stillThisEdit()) onNotice(`Mythra Code couldn't confirm that with ${name}. Your text is still here.`); }
      finally { finishing.delete(key); }
    })();
    // The editor stays, with its text, until the host answers.
    return false;
  }, [device, end, name, onNotice, prefix, read, settled, threadId, workspaceId]);

  // A row that has gone took its edit with it, delivered or removed on the host.
  useEffect(() => {
    if (!rowIds) return;
    for (const key of holdIds ? holdIds.split("\n") : []) {
      const id = key.slice(prefix.length);
      if (!rowIds.includes(id) && !finishing.has(key)) end(id);
    }
  }, [end, holdIds, prefix, rowIds]);
  const isEditing = useCallback((id: string) => holdIds.split("\n").includes(`${prefix}${id}`), [holdIds, prefix]);
  return { isEditing, begin, finish };
}
