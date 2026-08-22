import type { ClaudeRuntimeStatus } from "./claude";
import type { CursorRuntimeStatus } from "./cursor";
import type { Provider, UsageDisplayMode } from "../types";

export interface AccountUsageView {
  label: string;
  summary: string;
  planLabel?: string;
  windows?: AccountUsageWindowView[];
}

/** Presentation-ready quota data kept structured for an at-a-glance card. */
export interface AccountUsageWindowView {
  label: string;
  percent: number;
  percentLabel: string;
  resetLabel: string;
}

/**
 * People who watch a subscription quota tend to think in one of two ways:
 * "how much is left" or "how much have I burned". Providers only ever report
 * the consumed side, so OpenKiwi normalizes once here and every quota surface
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
  return limits.windows.map((window, index) => {
    const reset = formatResetTime(window.resetsAt, now) || window.resetLabel || "";
    return {
      label: window.label || (limits.windows.length === 1 ? "Current window" : `Window ${index + 1}`),
      percent: displayedPercent(window.usedPercent, mode),
      percentLabel: usagePercentLabel(window.usedPercent, mode),
      resetLabel: compactResetLabel(reset),
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
  if (record.usedPercent === undefined || record.usedPercent === null) return null;
  const resetsAt = Number(record.resetsAt);
  return {
    label: formatWindowLabel(record.windowMinutes) || fallbackLabel,
    usedPercent: clampUsedPercent(record.usedPercent),
    resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : null,
  };
}

/**
 * Reads the Codex app-server `account/rateLimits/read` payload. Returns null
 * when the runtime reports no active window, which is different from "we could
 * not reach the runtime" and reads differently in the UI.
 */
export function parseCodexRateLimits(value: unknown): ProviderRateLimits | null {
  if (!value || typeof value !== "object") return null;
  const limits = (value as Record<string, unknown>).rateLimits;
  if (!limits || typeof limits !== "object") return null;
  const record = limits as Record<string, unknown>;
  const windows = [readWindow(record.primary, ""), readWindow(record.secondary, "")].filter(
    (window): window is RateLimitWindow => window !== null,
  );
  return windows.length ? { windows } : null;
}

export function providerAccountUsage(
  provider: Provider,
  options: {
    openAiRateLimits: ProviderRateLimits | null;
    /** True once a rate-limit read succeeded, even if it reported no window. */
    openAiRateLimitsRead?: boolean;
    claudeStatus: ClaudeRuntimeStatus | null;
    claudeRateLimits?: ProviderRateLimits | null;
    cursorStatus?: CursorRuntimeStatus | null;
    openRouterReady: boolean;
    lmStudioReady?: boolean;
    usageDisplay?: UsageDisplayMode;
    now?: number;
  },
): AccountUsageView {
  const mode = options.usageDisplay ?? DEFAULT_USAGE_DISPLAY;
  const now = options.now ?? Date.now();
  if (provider === "claude") {
    if (!options.claudeStatus) return { label: "Claude subscription", summary: "Checking Claude Code…" };
    if (!options.claudeStatus.available) return { label: "Claude subscription", summary: "Install Claude Code to view this account" };
    if (!options.claudeStatus.loggedIn) return { label: "Claude subscription", summary: "Sign in to Claude Code to view this account" };
    const plan = options.claudeStatus.subscriptionType || options.claudeStatus.authMethod || "Claude";
    const planLabel = `${plan.charAt(0).toUpperCase()}${plan.slice(1)}`;
    const limits = formatRateLimits(options.claudeRateLimits, mode, now);
    return {
      label: "Claude subscription",
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
  if (provider === "cursor") {
    if (!options.cursorStatus) return { label: "Cursor subscription", summary: "Checking Cursor Agent…" };
    if (!options.cursorStatus.available) return { label: "Cursor subscription", summary: "Install Cursor Agent to view this account" };
    if (!options.cursorStatus.loggedIn) return { label: "Cursor subscription", summary: "Sign in to Cursor Agent to view this account" };
    const plan = options.cursorStatus.subscriptionType || "Cursor";
    return { label: "Cursor subscription", summary: `${plan} connected · live usage and limits are managed by Cursor` };
  }
  if (provider === "openrouter") {
    return {
      label: "OpenRouter usage",
      summary: options.openRouterReady ? "Pay as you go · tracked spend appears below" : "Add an OpenRouter API key to track spend",
    };
  }
  if (provider === "lmstudio") {
    return {
      label: "LM Studio local inference",
      summary: options.lmStudioReady ? "Connected locally · inference runs on your computer with no provider billing" : "Start LM Studio and load a model",
    };
  }
  const openAi = formatRateLimits(options.openAiRateLimits, mode, now);
  if (openAi && options.openAiRateLimits) return {
    label: "OpenAI subscription",
    summary: openAi,
    windows: accountUsageWindows(options.openAiRateLimits, mode, now),
  };
  return {
    label: "OpenAI subscription",
    summary: options.openAiRateLimitsRead ? "No active limit window" : "Sign in to view live limits",
  };
}
