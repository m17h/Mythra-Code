import { useEffect, useMemo, useRef, useState } from "react";
import type { ChildAgentPreset, ChildAgentTarget, ProjectSubagentSettings, Provider } from "../../types";
import { hostRead } from "../../lib/remote/remoteActions";
import type { WireResourceResult } from "../../lib/remote/wire-resources";
import type { ChildAgentReadiness } from "../../lib/childAgents";
import type { HostContextResult, WireExecutionSettings, WireSubagents } from "../../lib/remote/wire";
import { PermissionPicker } from "../PermissionPicker";
import { SubAgentCommandCenter } from "../SubAgentCommandCenter";
import type { ChildAgentModelCatalogs } from "../subAgentModelOptions";

const NO_WORKERS: never[] = [];
const DEFAULT_SUBAGENTS: WireSubagents = { enabled: false, engine: "mythra", maxConcurrent: 4 };

/** The real permission and sub-agent pickers. Each choice is sent to the host,
 * which checks it against what this device has been given. */
export function RemoteComposerControls({ device, workspaceId, context, chosen, name, provider, running, threadId, scopeKey, onSettings, onNotice, onOpenSettings }: {
  device: string;
  workspaceId: string | undefined;
  context: HostContextResult | undefined;
  /** A new thread's choices, not yet saved in a thread. */
  chosen?: Pick<WireExecutionSettings, "permission" | "subagents">;
  name: string;
  provider: Provider;
  running: boolean;
  threadId: string | undefined;
  scopeKey: string;
  onSettings: (change: Pick<WireExecutionSettings, "permission" | "subagents">) => void;
  onNotice: (message: string) => void;
  onOpenSettings: () => void;
}) {
  const execution = context?.execution;
  const permission = chosen?.permission ?? execution?.permission ?? "ask";
  const subagents = chosen?.subagents ?? execution?.subagents ?? DEFAULT_SUBAGENTS;
  const fullAccess = Boolean(context?.capabilities.fullAccess);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [open]);
  const description = useMemo(() => ({
    "read-only": "Inspect without changing files",
    ask: `Work on ${name}; ask for elevated actions`,
    full: `Unrestricted access on ${name}`,
  }), [name]);
  const readiness = useMemo<ChildAgentReadiness>(() => {
    const ready = (id: Provider) => Boolean(context?.providers.some((entry) => entry.id === id && entry.ready));
    return { codexRuntimeAvailable: ready("openai"), openAiSignedIn: ready("openai"), openRouterReady: ready("openrouter"),
      lmStudioReady: ready("lmstudio"), claudeReady: ready("claude"), cursorReady: ready("cursor") };
  }, [context?.providers]);
  const policy = useMemo<ProjectSubagentSettings>(() => {
    const targets = (subagents.crew ?? []) as ChildAgentTarget[];
    return { enabled: subagents.enabled, maxConcurrent: subagents.maxConcurrent, childAgents: { enabled: targets.length > 0, targets } };
  }, [subagents]);
  const modelCatalogs = useMemo(() => Object.fromEntries((context?.providers ?? []).map((entry) => [entry.id,
    entry.models.map((model) => ({ id: model.id, name: model.name }))])) as ChildAgentModelCatalogs, [context?.providers]);
  // Saved presets belong to the other machine. Applying one is an ordinary crew change there.
  const [presets, setPresets] = useState<ChildAgentPreset[]>([]);
  useEffect(() => {
    setPresets([]);
    if (!workspaceId) return;
    let current = true;
    hostRead<WireResourceResult>(device, "agents.presets.read", { workspaceId }).then((result) => {
      if (current) setPresets((result.presets ?? []).map((preset) => ({ id: preset.id, name: preset.name,
        policy: { enabled: preset.subagents.enabled, maxConcurrent: preset.subagents.maxConcurrent, childAgents: { enabled: Boolean(preset.subagents.crew?.length), targets: (preset.subagents.crew ?? []) as ChildAgentTarget[] } } })));
    }, () => undefined);
    return () => { current = false; };
  }, [device, workspaceId]);
  const change = (next: Partial<WireSubagents>) => onSettings({ subagents: { ...subagents, ...next } });
  return <>
    <PermissionPicker value={permission} open={open} rootRef={root} description={description} onOpenChange={setOpen} onChange={(mode) => onSettings({ permission: mode })}
      disabledReason={(mode) => mode === "full" && !fullAccess ? `Full access is turned off for this device on ${name}. Turn it on in Devices on that device.` : undefined} />
    <SubAgentCommandCenter policy={policy} engine={subagents.engine} provider={provider} nativeMaxConcurrent={subagents.maxConcurrent} nativeOptions={subagents.nativeOptions}
      autoCompactTokens={subagents.autoCompactTokens} nativeDefaultModel={context?.selected.model}
      presets={presets} contextKey={threadId ?? `new:${scopeKey}`} capturedPolicy={null} mode="open" readiness={readiness} workers={NO_WORKERS} parentActive={running}
      scopeLabel={threadId ? "this thread" : "this new thread"} projectOverride={false} modelCatalogs={modelCatalogs} onUnavailable={onNotice} onOpenSettings={onOpenSettings}
      onEngineChange={(engine) => change({ engine })}
      onNativeMaxConcurrentChange={(maxConcurrent) => change({ maxConcurrent })}
      onNativeOptionsChange={(nativeOptions) => change({ nativeOptions: nativeOptions as WireSubagents["nativeOptions"] })}
      onAutoCompactTokensChange={(autoCompactTokens) => change(autoCompactTokens === undefined ? {} : { autoCompactTokens })}
      onChange={(next) => {
        change({ enabled: next.enabled, maxConcurrent: next.maxConcurrent, crew: next.childAgents.targets as WireSubagents["crew"] });
      }} />
  </>;
}
