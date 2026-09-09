import type { ClaudeRuntimeStatus } from "./claude";
import type { OpenRouterCreditBalance } from "./codex";
import type { CursorRuntimeStatus } from "./cursor";
import type { Provider, UsageDisplayMode } from "../types";

export interface AccountUsageView {
  label: string;
  summary: string;
  planLabel?: string;
  windows?: AccountUsageWindowView[];
  /** Wall-clock time of the last provider-confirmed reading. */
  updatedAt?: number;
}

/** Presentation-ready quota data kept structured for an at-a-glance card. */
export interface AccountUsageWindowView {
  label: string;
  percent: number;
  percentLabel: string;
  resetLabel: string;
  /** Unix seconds; resolved once when reading the provider, never from display copy. */
  resetsAt?: number | null;
}

export interface ProviderHeaderUsageView {
  text: string;
  title: string;
  needsConnection?: boolean;
}

export type HeaderUsageWindows = Partial<Record<"openai" | "claude", string>>;

/** Keep independent provider choices; missing/obsolete windows fall back at render time. */
export function sanitizeHeaderUsageWindows(value: unknown): HeaderUsageWindows {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: HeaderUsageWindows = {};
  for (const provider of ["openai", "claude"] as const) {
    const label = (value as Record<string, unknown>)[provider];
    if (typeof label === "string" && label.trim() && label.length <= 120) result[provider] = label.trim();
  }
  return result;
}

export function selectedUsageWindow(windows: AccountUsageWindowView[], label?: string): AccountUsageWindowView | undefined {
  return windows.find((window) => window.label === label) ?? windows[0];
}

export function hasUsageCountdown(window: AccountUsageWindowView): boolean {
  return /^5h(?: \(\d+\))?$/.test(window.label) && typeof window.resetsAt === "number"
    && window.resetsAt > 0 && Number.isFinite(new Date(window.resetsAt * 1000).getTime());
}

export function usageResetText(window: AccountUsageWindowView, now: number): string {
  if (hasUsageCountdown(window) && Number.isFinite(now)) {
    const remaining = window.resetsAt! * 1000 - now;
    if (remaining <= 0) return "Awaiting usage update";
    const minutes = Math.ceil(remaining / 60_000);
    const hours = Math.floor(minutes / 60);
    return `Resets in ${hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`}`;
  }
  return window.resetLabel ? `Resets ${window.resetLabel}` : "Reset time unavailable";
}

export function formatCreditAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  return value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

/** One quota in the persistent header; the popover and Usage panel show the rest. */
export function providerHeaderUsage(
  provider: Provider,
  accountUsage: AccountUsageView,
  options: {
    selectedWindow?: string;
    openRouterReady?: boolean;
    openRouterCredits?: OpenRouterCreditBalance | null;
    openRouterCreditsRead?: boolean;
    openRouterCreditsError?: string;
  } = {},
): ProviderHeaderUsageView | null {
  if (provider === "openrouter") {
    const balance = options.openRouterCredits;
    if (balance) {
      const amount = formatCreditAmount(balance.remaining);
      return balance.source === "account"
        ? { text: `${amount} credits left`, title: `OpenRouter account · ${amount} credits left` }
        : { text: `${amount} key limit left`, title: `OpenRouter API key · ${amount} spending limit left` };
    }
    if (!options.openRouterReady) {
      return { text: "Add API key", title: "Add an OpenRouter API key to view credits", needsConnection: true };
    }
    return options.openRouterCreditsRead
      ? {
          text: "Credits unavailable",
          title: options.openRouterCreditsError?.toLowerCase().includes("does not expose")
            ? "This key exposes no balance or spending limit"
            : "OpenRouter credits unavailable. Try refreshing.",
        }
      : { text: "Checking credits…", title: "Checking OpenRouter credits" };
  }
  if (provider !== "openai" && provider !== "claude") return null;
  const title = `${accountUsage.label} · ${accountUsage.summary}`;
  const windows = accountUsage.windows ?? [];
  if (!windows.length) {
    const summary = accountUsage.summary.toLowerCase();
    const signIn = summary.includes("sign in");
    const install = summary.includes("install");
    return {
      text: summary.includes("checking") ? "Checking usage…" : signIn ? "Sign in for usage"
        : install ? provider === "claude" ? "Connect Claude" : "Connect provider"
        : summary.includes("no active limit") ? "No active limit" : "Usage unavailable",
      title,
      ...(signIn || install ? { needsConnection: true } : {}),
    };
  }
  const window = selectedUsageWindow(windows, options.selectedWindow)!;
  return { text: `${window.label} ${window.percentLabel}`, title };
}

/**
 * People who watch a subscription quota tend to think in one of two ways:
 * "how much is left" or "how much have I burned". Providers only ever report
 * the consumed side, so Mythra Code normalizes once here and every quota surface
 * reads the same direction.
 */
export const DEFAULT_USAGE_DISPLAY: UsageDisplayMode = "remaining";

/**
 * Settings written before this preference existed have no value at all, and a
 * hand-edited store can hold anything. Only the explicit opt-in switches away
 * from the default.
 */
export function sanitizeUsageDisplay(value: unknown): UsageDisplayMode {
  return value === "consumed" ? "consumed" : DEFAULT_USAGE_DISPLAY;
}

/** One quota window as a provider reports it, normalized to consumed percent. */
export interface RateLimitWindow {
  /** Short window name ("5h", "Weekly"). Empty when the provider names none. */
  label: string;
  /** Share of this window's quota already consumed, 0–100. */
  usedPercent: number;
  /** Unix seconds when the window rolls over, when the provider reports one. */
  resetsAt: number | null;
  /** Provider-formatted reset text when only a localized display is available. */
  resetLabel?: string | null;
}

/** A provider's live quota, ordered shortest window first. */
export interface ProviderRateLimits {
  windows: RateLimitWindow[];
}

/** Claude itself keeps a failed `/usage` snapshot for at most an hour. */
export const USAGE_SNAPSHOT_MAX_AGE_MS = 60 * 60_000;

/** A quota reading is owned by one account and must never cross that boundary. */
export interface AccountUsageSnapshot {
  accountKey: string;
  limits: ProviderRateLimits | null;
  updatedAt: number;
}

export function currentAccountUsageSnapshot(
  snapshot: AccountUsageSnapshot | null | undefined,
  accountKey: string,
  now = Date.now(),
  maxAgeMs = USAGE_SNAPSHOT_MAX_AGE_MS,
): AccountUsageSnapshot | null {
  if (!snapshot || !accountKey || snapshot.accountKey !== accountKey) return null;
  if (!Number.isFinite(snapshot.updatedAt) || now - snapshot.updatedAt > maxAgeMs) return null;
  return snapshot;
}

export function usageFreshnessText(updatedAt: number | null | undefined, now = Date.now()): string {
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt <= 0) return "";
  const elapsed = Math.max(0, now - updatedAt);
  if (elapsed < 60_000) return "Updated just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `Last updated ${hours}h ago`;
}

export type UsageReadFailureKind = "timeout" | "authentication" | "invalid-response" | "unavailable";

/** Reduce provider errors to supportable categories without putting raw output in the UI or audit log. */
export function usageReadFailureKind(reason: unknown): UsageReadFailureKind {
  const message = String(reason).toLowerCase();
  if (/usage_timeout|timed?\s*out|timeout/.test(message)) return "timeout";
  if (/usage_auth_required|authentication|not logged|sign[ -]?in|unauthorized|\b401\b/.test(message)) return "authentication";
  if (/usage_(unsupported|empty|parse_failed)|invalid usage data|unsupported usage response|no active usage windows/.test(message)) return "invalid-response";
  return "unavailable";
}

export function usageReadFailureStatus(kind: UsageReadFailureKind, hasLastReading: boolean): string {
  const suffix = hasLastReading ? " · last reading retained" : "";
  if (kind === "timeout") return `Usage refresh timed out${suffix}`;
  if (kind === "authentication") return `Usage auth unverified${suffix}`;
  if (kind === "invalid-response") return `Provider usage format changed${suffix}`;
  return `Usage refresh unavailable${suffix}`;
}

/** Keep only a harmless semantic version in diagnostics, never raw CLI output. */
export function sanitizedUsageProviderVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0];
}

/** Merge a structured provider event without erasing windows it did not carry. */
export function mergeProviderRateLimits(
  current: ProviderRateLimits | null | undefined,
  update: ProviderRateLimits,
): ProviderRateLimits {
  const windows = [...(current?.windows ?? [])];
  for (const incoming of update.windows) {
    const index = windows.findIndex((window) => window.label === incoming.label);
    if (index === -1) windows.push(incoming);
    else windows[index] = incoming;
  }
  return { windows };
}

/**
 * Folds a structured provider event into the account's stored snapshot.
 *
 * A `rate_limit_event` carries one window, so every other window on the card is
 * still the previous reading. Stamping the whole snapshot with the event's
 * arrival time would both label those as freshly confirmed and restart the
 * one-hour cap on them, so a snapshot that carries anything over ages from the
 * older reading instead. Windows already past the cap are dropped rather than
 * merged forward.
 */
export function mergeAccountUsageSnapshot(
  current: AccountUsageSnapshot | null | undefined,
  accountKey: string,
  update: ProviderRateLimits,
  now = Date.now(),
  maxAgeMs = USAGE_SNAPSHOT_MAX_AGE_MS,
): AccountUsageSnapshot {
  const retained = currentAccountUsageSnapshot(current, accountKey, now, maxAgeMs);
  const limits = mergeProviderRateLimits(retained?.limits, update);
  const carriedOver = limits.windows.some(
    (window) => !update.windows.some((incoming) => incoming.label === window.label),
  );
  return { accountKey, limits, updatedAt: retained && carriedOver ? retained.updatedAt : now };
}

/**
 * Providers send percentages as numbers, numeric strings, and occasionally
 * values slightly outside 0–100 after their own rounding. Clamp rather than
 * reject, so a live quota never renders as a negative or >100% bar.
 */
export function clampUsedPercent(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  // NaN carries no direction, so it reads as "nothing known yet"; an infinity
  // is at least unambiguously outside the range and clamps like any overshoot.
  if (Number.isNaN(numeric)) return 0;
  return Math.min(100, Math.max(0, numeric));
}

/**
 * Round the consumed side once and derive the remaining side from it, so the
 * two directions of the same window always add up to 100 and a user switching
 * the setting never sees the numbers disagree.
 */
export function displayedPercent(usedPercent: unknown, mode: UsageDisplayMode): number {
  const used = Math.round(clampUsedPercent(usedPercent));
  return mode === "consumed" ? used : 100 - used;
}

export function usagePercentLabel(usedPercent: unknown, mode: UsageDisplayMode): string {
  return `${displayedPercent(usedPercent, mode)}% ${mode === "consumed" ? "used" : "left"}`;
}

/** Turns a provider's window length in minutes into a short human label. */
export function formatWindowLabel(minutes: unknown): string {
  const numeric = typeof minutes === "number" ? minutes : Number(minutes);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  const whole = Math.round(numeric);
  if (whole % 10080 === 0) return whole === 10080 ? "Weekly" : `${whole / 10080}w`;
  if (whole % 1440 === 0) return whole === 1440 ? "Daily" : `${whole / 1440}d`;
  if (whole % 60 === 0) return `${whole / 60}h`;
  return `${whole}m`;
}

/**
 * Weekly windows reset days out, so a bare clock time would be ambiguous. Show
 * the weekday too once the reset falls outside the current local day.
 */
export function formatResetTime(resetsAt: number | null | undefined, now = Date.now()): string {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) return "";
  const reset = new Date(resetsAt * 1000);
  if (Number.isNaN(reset.getTime())) return "";
  const today = new Date(now);
  const sameDay =
    reset.getFullYear() === today.getFullYear() &&
    reset.getMonth() === today.getMonth() &&
    reset.getDate() === today.getDate();
  return sameDay
    ? reset.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : reset.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/**
 * Claude's terminal-friendly reset labels include a repeated IANA timezone and
 * compact lowercase meridiem. The dock already runs in the user's local
 * context, so keep the full date and time while removing that visual noise.
 */
export function compactResetLabel(value: string): string {
  return value
    .trim()
    .replace(/\s+\((?:[A-Za-z_+-]+\/)+[A-Za-z_+-]+\)\s*$/, "")
    .replace(/\s+at\s+/i, " · ")
    .replace(/(\d)\s*(am|pm)\b/gi, (_, digit: string, period: string) => `${digit} ${period.toUpperCase()}`);
}

function accountUsageWindows(
  limits: ProviderRateLimits,
  mode: UsageDisplayMode,
  now: number,
): AccountUsageWindowView[] {
  const usedLabels = new Set<string>();
  return limits.windows.map((window, index) => {
    const base = window.label || (limits.windows.length === 1 ? "Current window" : `Window ${index + 1}`);
    let label = base;
    for (let suffix = 2; usedLabels.has(label); suffix++) label = `${base} (${suffix})`;
    usedLabels.add(label);
    const reset = formatResetTime(window.resetsAt, now) || window.resetLabel || "";
    return {
      label,
      percent: displayedPercent(window.usedPercent, mode),
      percentLabel: usagePercentLabel(window.usedPercent, mode),
      resetLabel: compactResetLabel(reset),
      resetsAt: window.resetsAt,
    };
  });
}

export function formatRateLimitWindow(
  window: RateLimitWindow,
  mode: UsageDisplayMode,
  options: { includeLabel?: boolean; now?: number } = {},
): string {
  const prefix = options.includeLabel && window.label ? `${window.label} ` : "";
  const reset = formatResetTime(window.resetsAt, options.now ?? Date.now()) || window.resetLabel || "";
  return `${prefix}${usagePercentLabel(window.usedPercent, mode)}${reset ? ` · resets ${reset}` : ""}`;
}

/**
 * Joins every reported window into one line. Window labels only appear when
 * there is more than one, so the common single-window case stays terse.
 */
export function formatRateLimits(
  limits: ProviderRateLimits | null | undefined,
  mode: UsageDisplayMode,
  now = Date.now(),
): string {
  const windows = limits?.windows ?? [];
  if (!windows.length) return "";
  const includeLabel = windows.length > 1;
  return windows.map((window) => formatRateLimitWindow(window, mode, { includeLabel, now })).join(" · ");
}

function readWindow(value: unknown, fallbackLabel: string): RateLimitWindow | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const percent = record.usedPercent;
  if ((typeof percent !== "number" && typeof percent !== "string")
    || (typeof percent === "string" && !percent.trim()) || !Number.isFinite(Number(percent))) return null;
  const resetsAt = Number(record.resetsAt);
  return {
    // `windowDurationMins` is the current app-server field. Keep the older
    // alias for runtimes released before the field was documented.
    label: formatWindowLabel(record.windowDurationMins ?? record.windowMinutes) || fallbackLabel,
    usedPercent: clampUsedPercent(record.usedPercent),
    resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : null,
  };
}

function bucketLabel(value: unknown, fallback: string): string {
  const label = typeof value === "string" ? value.trim() : "";
  const source = (label || fallback).slice(0, 120).replaceAll("_", " ");
  return source ? `${source.charAt(0).toUpperCase()}${source.slice(1)}` : "";
}

function readRateLimitBucket(value: unknown, fallbackName: string, showBucket: boolean): RateLimitWindow[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid usage data");
  const record = value as Record<string, unknown>;
  const name = bucketLabel(record.limitName, fallbackName);
  return [record.primary, record.secondary].map((entry) => {
    const window = readWindow(entry, "");
    if (entry != null && !window) throw new Error("Invalid usage data");
    if (!window) return null;
    return showBucket && name ? { ...window, label: `${name}${window.label ? ` ${window.label}` : ""}` } : window;
  }).filter((window): window is RateLimitWindow => window !== null);
}

/**
 * Reads the Codex app-server `account/rateLimits/read` payload. Returns null
 * when the runtime reports no active window, which is different from "we could
 * not reach the runtime" and reads differently in the UI.
 */
export function parseCodexRateLimits(value: unknown): ProviderRateLimits | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  const byId = payload.rateLimitsByLimitId;
  if (byId && typeof byId === "object" && !Array.isArray(byId)) {
    const entries = Object.entries(byId as Record<string, unknown>).filter(([, bucket]) => bucket != null);
    const multiple = entries.length > 1;
    const windows = entries.flatMap(([id, bucket]) => {
      const record = bucket && typeof bucket === "object" && !Array.isArray(bucket)
        ? bucket as Record<string, unknown>
        : null;
      const explicitName = record && typeof record.limitName === "string" && record.limitName.trim();
      const showBucket = multiple || Boolean(explicitName) || id !== "codex";
      return readRateLimitBucket(bucket, id, showBucket);
    });
    // A map that is absent, empty, or carries no window is not the runtime
    // reporting "no limits": the legacy bucket in the same payload still holds
    // its own answer, so fall through rather than blanking the card.
    if (windows.length) return { windows };
  }
  const limits = payload.rateLimits;
  // An array reaches `readRateLimitBucket` as malformed; the legacy shape has
  // always been tolerated as "nothing to report" instead.
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) return null;
  const windows = readRateLimitBucket(limits, "", false);
  return windows.length ? { windows } : null;
}

export function providerAccountUsage(
  provider: Provider,
  options: {
    openAiRateLimits: ProviderRateLimits | null;
    /** True once a rate-limit read succeeded, even if it reported no window. */
    openAiRateLimitsRead?: boolean;
    openAiUpdatedAt?: number;
    /** Distinguishes a connected account with a transient read failure from no account. */
    openAiConnected?: boolean;
    claudeStatus: ClaudeRuntimeStatus | null;
    claudeRateLimits?: ProviderRateLimits | null;
    claudeUpdatedAt?: number;
    cursorStatus?: CursorRuntimeStatus | null;
    openRouterReady: boolean;
    openRouterCredits?: OpenRouterCreditBalance | null;
    openRouterCreditsRead?: boolean;
    openRouterCreditsError?: string;
    lmStudioReady?: boolean;
    usageDisplay?: UsageDisplayMode;
    now?: number;
  },
): AccountUsageView {
  const mode = options.usageDisplay ?? DEFAULT_USAGE_DISPLAY;
  const now = options.now ?? Date.now();
  const label = `${provider === "claude" ? "Claude" : provider === "cursor" ? "Cursor" : "OpenAI"} subscription`;
  if (provider === "claude" || provider === "cursor") {
    const status = provider === "claude" ? options.claudeStatus : options.cursorStatus;
    const name = provider === "claude" ? "Claude Code" : "Cursor Agent";
    const summary = !status ? `Checking ${name}…` : !status.available
      ? `Install ${name} to view this account` : !status.loggedIn ? `Sign in to ${name} to view this account` : "";
    if (summary) return { label, summary };
  }
  if (provider === "claude" && options.claudeStatus) {
    const plan = options.claudeStatus.subscriptionType || options.claudeStatus.authMethod || "Claude";
    const planLabel = `${plan.charAt(0).toUpperCase()}${plan.slice(1)}`;
    const limits = formatRateLimits(options.claudeRateLimits, mode, now);
    return {
      label,
      ...(options.claudeUpdatedAt ? { updatedAt: options.claudeUpdatedAt } : {}),
      summary: limits
        ? `${planLabel} plan · ${limits}`
        : `${planLabel} plan connected · live limits are managed by Claude Code`,
      ...(options.claudeRateLimits?.windows.length
        ? {
            planLabel: `${planLabel} plan`,
            windows: accountUsageWindows(options.claudeRateLimits, mode, now),
          }
        : {}),
    };
  }
  if (provider === "cursor" && options.cursorStatus) {
    const plan = options.cursorStatus.subscriptionType || "Cursor";
    return { label, summary: `${plan} connected · live usage and limits are managed by Cursor` };
  }
  if (provider === "openrouter") {
    const balance = options.openRouterCredits;
    if (balance) {
      const amount = formatCreditAmount(balance.remaining);
      return {
        label: balance.source === "account" ? "OpenRouter credits" : "OpenRouter API key",
        summary: balance.source === "account"
          ? `${amount} credits left`
          : `${amount} spending limit left on this key`,
      };
    }
    if (options.openRouterCreditsRead) {
      return {
        label: "OpenRouter credits",
        summary: options.openRouterReady
          ? options.openRouterCreditsError?.toLowerCase().includes("does not expose")
            ? "This API key exposes no balance or spending limit"
            : "Credits are temporarily unavailable · try refreshing usage"
          : "Add an OpenRouter API key to track credits",
      };
    }
    return {
      label: "OpenRouter usage",
      summary: options.openRouterReady ? "Pay as you go · tracked spend below" : "Add an OpenRouter API key to track spend",
    };
  }
  if (provider === "lmstudio") {
    return {
      label: "LM Studio local inference",
      summary: options.lmStudioReady ? "Connected locally · inference runs here with no provider billing" : "Start LM Studio and load a model",
    };
  }
  const openAi = formatRateLimits(options.openAiRateLimits, mode, now);
  if (openAi && options.openAiRateLimits) return {
    label,
    summary: openAi,
    windows: accountUsageWindows(options.openAiRateLimits, mode, now),
    ...(options.openAiUpdatedAt ? { updatedAt: options.openAiUpdatedAt } : {}),
  };
  return {
    label,
    ...(options.openAiUpdatedAt ? { updatedAt: options.openAiUpdatedAt } : {}),
    summary: options.openAiRateLimitsRead
      ? "No active limit window"
      : options.openAiConnected
        ? "Live usage is temporarily unavailable"
        : "Sign in to view live limits",
  };
}
