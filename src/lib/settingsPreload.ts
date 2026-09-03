/** Warm only the Settings module/CSS, never mount its UI or run its effects.
 * Keep import/evaluation off launch and wait for idle without forcing a busy
 * renderer to meet a timeout. Older WebKit gets a deferred task fallback. */
export function scheduleSettingsPreload(preload: () => void): () => void {
  let cancelled = false;
  let timer: number | null = null;
  let idle: number | null = null;
  const run = () => {
    timer = idle = null;
    if (cancelled) return;
    // Visibility can change after the idle request was queued.
    if (document.hidden) { document.addEventListener("visibilitychange", resume); return; }
    cancelled = true;
    document.removeEventListener("visibilitychange", resume);
    preload();
  };
  const queue = () => {
    timer = null;
    if (cancelled) return;
    if (document.hidden) { document.addEventListener("visibilitychange", resume); return; }
    if (window.requestIdleCallback) idle = window.requestIdleCallback(run);
    else timer = window.setTimeout(run, 300);
  };
  const resume = () => {
    if (document.hidden || cancelled) return;
    document.removeEventListener("visibilitychange", resume);
    queue();
  };
  timer = window.setTimeout(queue, 2_000);
  return () => {
    cancelled = true;
    if (timer !== null) window.clearTimeout(timer);
    if (idle !== null) window.cancelIdleCallback(idle);
    document.removeEventListener("visibilitychange", resume);
  };
}
