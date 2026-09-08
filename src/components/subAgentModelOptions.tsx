import { ProviderLogo } from "./BrandLogos";
import type { AppSelectOption } from "./AppSelectMenu";
import type { Provider } from "../types";
import { CHILD_AGENT_REASONING_EFFORTS } from "../lib/childAgents";

export interface ChildAgentModelOption {
  id: string;
  label: string;
  detail?: string;
  keywords?: string;
}
const BUILTIN_MODEL_CATALOGS: Record<Provider, ChildAgentModelOption[]> = {
  openai: [
    { id: "gpt-6-astra", label: "Astra", detail: "gpt-6-astra · frontier intelligence" },
    { id: "gpt-5.6-sol", label: "Sol", detail: "gpt-5.6-sol · detail & polish" },
    { id: "gpt-5.6-terra", label: "Terra", detail: "gpt-5.6-terra · everyday power" },
    { id: "gpt-5.6-luna", label: "Luna", detail: "gpt-5.6-luna · fast & focused" },
  ],
  claude: [
    { id: "claude-fable-5", label: "Fable 5", detail: "Frontier coding" },
    { id: "claude-opus-5", label: "Opus 5", detail: "Deepest reasoning" },
    { id: "claude-sonnet-5", label: "Sonnet 5", detail: "Balanced power" },
    { id: "claude-haiku-4-5", label: "Haiku 4.5", detail: "Fast and efficient" },
  ],
  cursor: [{ id: "auto", label: "Auto", detail: "Cursor recommended" }],
  openrouter: [],
  lmstudio: [],
};

const REASONING_LABELS: Record<(typeof CHILD_AGENT_REASONING_EFFORTS)[number], string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
  ultra: "Ultra",
};

export const REASONING_OPTIONS: AppSelectOption[] = CHILD_AGENT_REASONING_EFFORTS.map((effort) => ({
  value: effort,
  label: REASONING_LABELS[effort],
}));

export function modelOptionsFor(
  provider: Provider,
  catalogs: Partial<Record<Provider, ChildAgentModelOption[]>> | undefined,
  selectedModel?: string,
): AppSelectOption[] {
  const supplied = catalogs?.[provider];
  const catalog = supplied?.length ? supplied : BUILTIN_MODEL_CATALOGS[provider];
  const options: AppSelectOption[] = catalog.map((entry) => ({
    value: entry.id,
    label: entry.label,
    detail: entry.detail ?? entry.id,
    keywords: entry.keywords,
    icon: <ProviderLogo provider={provider} size={11} />,
  }));
  if (selectedModel && !options.some((option) => option.value === selectedModel)) {
    options.unshift({
      value: selectedModel,
      label: selectedModel,
      detail: "Previously configured model",
      icon: <ProviderLogo provider={provider} size={11} />,
    });
  }
  return options;
}
