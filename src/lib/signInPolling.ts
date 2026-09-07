export interface SignInWatchOptions {
  /** Delay between probes. */
  intervalMs?: number;
  /** Give up after this long without observing a signed-in state. */
  timeoutMs?: number;
  /** Aborting stops the watch; the promise then resolves to false. */
  signal?: AbortSignal;
}

const DEFAULT_INTERVAL_MS = 4_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * Re-probes a provider's sign-in state after an external login was launched
 * (Claude Code and Cursor Agent both sign in through a terminal and the
 * browser, so the app never sees the moment the flow completes). Resolves
 * true the first time `check` reports signed in, false once the deadline
 * passes or the watch is aborted. A probe that throws counts as "not yet".
 */
export async function waitForSignIn(
  check: () => Promise<boolean>,
  { intervalMs = DEFAULT_INTERVAL_MS, timeoutMs = DEFAULT_TIMEOUT_MS, signal }: SignInWatchOptions = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!signal?.aborted) {
    const signedIn = await check().catch(() => false);
    if (signal?.aborted) return false;
    if (signedIn) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const aborted = await sleep(Math.min(intervalMs, remaining), signal);
    if (aborted) return false;
  }
  return false;
}

/** Resolves true when aborted before the delay elapsed. */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
