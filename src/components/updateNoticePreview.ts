import type { UpdateNoticeState } from "./UpdateNotice";

/**
 * Development-only scripted update states for demonstrating the update notice
 * in the native dev build. It only ever emits plain state objects: nothing here
 * checks for, downloads, installs, or relaunches anything, and the only caller
 * sits behind `import.meta.env.DEV`, so production bundles never include it.
 */
export const UPDATE_NOTICE_PREVIEW_SCENARIOS = ["available", "install", "install-unknown-size", "failure"] as const;
export type UpdateNoticePreviewScenario = (typeof UPDATE_NOTICE_PREVIEW_SCENARIOS)[number];

export const PREVIEW_AVAILABLE_HOLD_MS = 2_500;
export const PREVIEW_DOWNLOAD_MS = 5_200;
export const PREVIEW_INSTALL_MS = 2_200;
export const PREVIEW_TICK_MS = 130;
// A plausible signed bundle size so the byte counter reads like a real one.
export const PREVIEW_TOTAL_BYTES = 18_437_120;
const FAILURE_AT = 0.62;
const PREVIEW_FAILURE_MESSAGE = "The update download was interrupted. Check your connection and try again.";

export function isUpdateNoticePreviewScenario(value: string): value is UpdateNoticePreviewScenario {
  return (UPDATE_NOTICE_PREVIEW_SCENARIOS as readonly string[]).includes(value);
}

/** Plays a scenario through `emit` and returns a function that stops it. */
export function playUpdateNoticePreview(
  version: string,
  scenario: UpdateNoticePreviewScenario,
  emit: (state: UpdateNoticeState) => void,
): () => void {
  const timers: number[] = [];
  const base: UpdateNoticeState = { phase: "available", availableVersion: version, downloadedBytes: 0, totalBytes: null, error: null };
  emit(base);
  if (scenario === "available") return () => undefined;

  const knownSize = scenario !== "install-unknown-size";
  const stopAt = scenario === "failure" ? FAILURE_AT : 1;
  const downloading = (fraction: number): UpdateNoticeState => ({
    ...base,
    phase: "downloading",
    downloadedBytes: Math.round(PREVIEW_TOTAL_BYTES * fraction),
    totalBytes: knownSize ? PREVIEW_TOTAL_BYTES : null,
  });

  let interval: number | undefined;
  timers.push(window.setTimeout(() => {
    emit(downloading(0));
    let ticks = 0;
    interval = window.setInterval(() => {
      ticks += 1;
      // Ease out so the bar reads like a real transfer rather than a metronome.
      const elapsed = Math.min(1, (ticks * PREVIEW_TICK_MS) / PREVIEW_DOWNLOAD_MS);
      const fraction = Math.min(stopAt, 1 - (1 - elapsed) ** 1.6);
      emit(downloading(fraction));
      if (fraction < stopAt) return;
      window.clearInterval(interval);
      interval = undefined;
      if (scenario === "failure") {
        emit({ ...downloading(fraction), phase: "error", error: PREVIEW_FAILURE_MESSAGE });
        return;
      }
      emit({ ...downloading(1), phase: "installing" });
      // "restarting" then holds: the preview never relaunches the app.
      timers.push(window.setTimeout(() => emit({ ...downloading(1), phase: "restarting" }), PREVIEW_INSTALL_MS));
    }, PREVIEW_TICK_MS);
  }, PREVIEW_AVAILABLE_HOLD_MS));

  return () => {
    for (const timer of timers) window.clearTimeout(timer);
    window.clearInterval(interval);
  };
}
