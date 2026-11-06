import { useMemo } from "react";
import type { Provider } from "../../types";
import type { HostContextResult, WireEffort, WireHostModel } from "../../lib/remote/wire";
import { ClaudeModelControl } from "../ClaudeModelControl";
import { CursorModelControl } from "../CursorModelControl";
import { LMStudioModelControl } from "../LMStudioModelControl";
import { ModelPowerControl, type ReasoningEffort, type RuntimeModel } from "../ModelPowerControl";
import { OpenRouterModelControl } from "../OpenRouterModelControl";
import { ThreadProviderControl } from "../ThreadProviderControl";

const NO_MODELS: WireHostModel[] = [];
const hostEffort = (effort: ReasoningEffort): WireEffort => effort === "ultra" ? "max" : effort;
const noRefresh = () => undefined;

/** The real pickers, filled with what the host offers. The host checks every
 * change, so nothing here decides what is allowed. */
export function RemoteModelControls({ context, chosen, name, provider, running, threadStarted, onSettings, onDefaults, onNotice }: {
  context: HostContextResult | undefined;
  /** A new thread's choices, not yet saved in a thread. */
  chosen?: { model?: string; effort?: WireEffort };
  name: string;
  provider: Provider;
  running: boolean;
  threadStarted: boolean;
  onSettings: (change: { provider?: Provider; model?: string; effort?: WireEffort }) => void;
  onDefaults: () => void;
  onNotice: (message: string) => void;
}) {
  const models = context?.providers.find((entry) => entry.id === provider)?.models ?? NO_MODELS;
  const unavailable = useMemo(() => Object.fromEntries((context?.providers ?? []).filter((entry) => !entry.ready)
    .map((entry) => [entry.id, `${entry.name} isn't signed in on ${name}. Sign in on that device first.`])) as Partial<Record<Provider, string>>, [context?.providers, name]);
  const model = chosen?.model ?? context?.selected.model ?? "";
  const effort: ReasoningEffort = chosen?.effort ?? context?.selected.effort ?? "medium";
  const changeModel = (next: string) => onSettings({ model: next });
  const changeEffort = (next: ReasoningEffort) => onSettings({ effort: hostEffort(next) });
  const shared = { model, effort, loading: !context, error: "", onModel: changeModel, onEffort: changeEffort, onRefresh: noRefresh };
  const providerControl = <ThreadProviderControl
    provider={provider}
    defaultProvider={context?.selected.provider ?? provider}
    threadStarted={threadStarted}
    disabled={running || !context}
    unavailable={unavailable}
    onUnavailable={onNotice}
    onProvider={(next) => onSettings({ provider: next })}
    onDefaultSettings={onDefaults}
  />;
  if (provider === "openai") {
    const runtimeModels: RuntimeModel[] = models.map((entry) => ({
      id: entry.id, model: entry.id, displayName: entry.name, description: "",
      supportedReasoningEfforts: entry.efforts.map((reasoningEffort) => ({ reasoningEffort, description: "" })),
      defaultReasoningEffort: entry.defaultEffort ?? entry.efforts[0] ?? "medium",
      isDefault: false,
    }));
    return <ModelPowerControl {...shared} providerControl={providerControl} fast={false} runtimeModels={runtimeModels} onFast={() => onNotice(`Fast mode is set on ${name}.`)} />;
  }
  if (provider === "claude") {
    return <ClaudeModelControl {...shared} providerControl={providerControl} models={models.map((entry) => ({
      id: entry.id, displayName: entry.name, description: "", resolvedModel: entry.id, disabled: false, supportedEfforts: entry.efforts,
    }))} />;
  }
  if (provider === "cursor") {
    return <CursorModelControl {...shared} providerControl={providerControl} models={models.map((entry) => ({ id: entry.id, name: entry.name, configOptions: [] }))} />;
  }
  if (provider === "lmstudio") {
    return <LMStudioModelControl {...shared} providerControl={providerControl} models={models.map((entry) => ({
      id: entry.id, displayName: entry.name, publisher: "", trainedForToolUse: false,
      reasoningEfforts: entry.efforts, ...(entry.defaultEffort ? { defaultReasoningEffort: entry.defaultEffort } : {}),
    }))} />;
  }
  return <OpenRouterModelControl {...shared} providerControl={providerControl} models={models.map((entry) => ({ id: entry.id, name: entry.name }))} />;
}
