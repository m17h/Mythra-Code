import { loadStored } from "../../storage";
import { RUN_DISCOVERY_PREFERENCES_KEY, sanitizeRunDiscoveryPreferences, type RunDiscoveryPreferences } from "../../runDiscovery";
import type { HostContextSources } from "./hostContext";
import { HostReadError } from "./scope";
import { commitHostState } from "./stateCommit";
import type { HostMutationContext } from "./workActions";

export function hostDiscoveryPreferences(): RunDiscoveryPreferences {
  return sanitizeRunDiscoveryPreferences(loadStored<unknown>(RUN_DISCOVERY_PREFERENCES_KEY, null));
}
/** Resolve only host catalog entries. Discovery has its own saved choice, not
 * the model/effort of whichever thread happens to be visible on either device. */
export function resolveDiscoverySettings(sources: HostContextSources, raw: unknown, args: Readonly<Record<string, unknown>>): RunDiscoveryPreferences {
  const previous = sanitizeRunDiscoveryPreferences(raw);
  const provider = sources.getProviderCatalog().find((entry) => entry.id === (args.provider ?? previous.provider));
  if (!provider) throw new HostReadError("unsupported", "Choose a provider from the host catalog.");
  const changedProvider = provider.id !== previous.provider;
  const selected = args.model ?? (changedProvider ? previous.models?.[provider.id] : previous.model);
  const model = provider.models.find((entry) => entry.id === selected) ?? (args.model === undefined && changedProvider ? provider.models[0] : undefined);
  if (!model) throw new HostReadError("unsupported", "Choose a model from the host catalog.");
  const preferredEffort = args.effort ?? (changedProvider ? previous.efforts?.[provider.id] : previous.effort);
  const effort = model.efforts.find((value) => value === preferredEffort) ?? (args.effort === undefined ? model.defaultEffort ?? model.efforts[0] ?? "default" : undefined);
  if (!effort) throw new HostReadError("unsupported", "Choose a reasoning level supported by this host model.");
  return { ...previous, provider: provider.id, model: model.id, effort,
    models: { ...previous.models, [previous.provider]: previous.model, [provider.id]: model.id },
    efforts: { ...previous.efforts, [previous.provider]: previous.effort, [provider.id]: effort } };
}
export async function setHostDiscoverySettings(sources: HostContextSources, args: Readonly<Record<string, unknown>>, operation: HostMutationContext): Promise<void> {
  await commitHostState(operation, [RUN_DISCOVERY_PREFERENCES_KEY], (rows) => ({
    [RUN_DISCOVERY_PREFERENCES_KEY]: resolveDiscoverySettings(sources, rows[0].value, args),
  }));
}
