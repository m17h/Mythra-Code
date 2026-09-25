import { useEffect, useState } from "react";
import { CircleArrowUp, Download, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { updateProgress, type AppUpdatePhase, type AppUpdateState } from "../lib/appUpdater";
import { isUpdateNoticePreviewScenario, playUpdateNoticePreview, type UpdateNoticePreviewScenario } from "./updateNoticePreview";

/** The slice of the updater the notice reads; the real updater satisfies it. */
export type UpdateNoticeState = Pick<AppUpdateState, "phase" | "availableVersion" | "downloadedBytes" | "totalBytes" | "error">;

declare global {
  interface Window {
    /** Development builds only: play a preview scenario for a version, or hide it (null). */
    __mythraPreviewUpdateNotice?: (version: string | null, scenario?: UpdateNoticePreviewScenario) => void;
  }
}

// Long enough after launch that the entrance is watched rather than missed.
export const UPDATE_NOTICE_PREVIEW_DELAY_MS = 1_500;

/**
 * Development-only stand-in states for previewing the notice in the native dev
 * build. It never touches the updater: Settings keeps showing the real update
 * state, and production bundles compile the whole hook away.
 *
 *   VITE_PREVIEW_UPDATE_NOTICE=9.9.9 npm run desktop
 *   VITE_PREVIEW_UPDATE_NOTICE=9.9.9 VITE_PREVIEW_UPDATE_SCENARIO=install npm run desktop
 *   window.__mythraPreviewUpdateNotice("9.9.9", "install")  // or null to hide
 *
 * Scenarios: available (default), install, install-unknown-size, failure.
 *
 * Chosen once at module load: in a production build the condition is the
 * constant `false`, so the hook and the scripted driver are dropped entirely.
 */
export const useUpdateNoticePreview: () => UpdateNoticeState | null = import.meta.env.DEV
  ? useDevelopmentUpdateNoticePreview
  : () => null;

function useDevelopmentUpdateNoticePreview(): UpdateNoticeState | null {
  const [state, setState] = useState<UpdateNoticeState | null>(null);
  useEffect(() => {
    let stop: (() => void) | null = null;
    const play = (version: string | null | undefined, scenario: string | undefined) => {
      stop?.();
      stop = null;
      const trimmed = version?.trim();
      if (!trimmed) {
        setState(null);
        return;
      }
      const requested = scenario?.trim() || "available";
      if (!isUpdateNoticePreviewScenario(requested)) console.warn(`Unknown update notice preview scenario "${requested}"; showing "available".`);
      stop = playUpdateNoticePreview(trimmed, isUpdateNoticePreviewScenario(requested) ? requested : "available", setState);
    };
    const initial = import.meta.env.VITE_PREVIEW_UPDATE_NOTICE?.trim();
    const timer = initial
      ? window.setTimeout(() => play(initial, import.meta.env.VITE_PREVIEW_UPDATE_SCENARIO), UPDATE_NOTICE_PREVIEW_DELAY_MS)
      : undefined;
    window.__mythraPreviewUpdateNotice = play;
    return () => {
      window.clearTimeout(timer);
      stop?.();
      delete window.__mythraPreviewUpdateNotice;
    };
  }, []);
  return state;
}

const ACTIVE_PHASES: ReadonlySet<AppUpdatePhase> = new Set(["downloading", "installing", "restarting"]);

// Decimal megabytes, like the Finder and Explorer report file sizes.
function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

/**
 * Floats beneath the top bar instead of taking a row, so its arrival never
 * shifts the thread. One card carries the update from "available" through
 * download, install, and restart, so the progress appears exactly where the
 * user was already looking. The live region stays mounted so screen readers
 * hear each stage; the fast-changing byte counts sit outside the announced
 * text, and the progressbar carries them instead.
 */
export function UpdateNotice({ update, onOpen }: { update: UpdateNoticeState; onOpen: () => void }) {
  const { phase, availableVersion: version } = update;
  // Dismissing availability lasts for this session and this version; a newer
  // release returns. It never hides an install in progress: the app is about
  // to restart, and that should not come as a surprise.
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  // A failure is only shown when this notice watched the install fail. Errors
  // from a manual check in Settings stay in Settings.
  const [previousPhase, setPreviousPhase] = useState(phase);
  const [failureShown, setFailureShown] = useState(false);
  if (phase !== previousPhase) {
    setPreviousPhase(phase);
    setFailureShown(phase === "error" && ACTIVE_PHASES.has(previousPhase));
  }

  const stage = phase === "available" ? (version && version !== dismissedVersion ? "available" : null)
    : ACTIVE_PHASES.has(phase) ? phase
      : phase === "error" && failureShown ? "failed"
        : null;
  const name = version ? `Mythra Code ${version}` : "the update";
  const progress = updateProgress(update.downloadedBytes, update.totalBytes);
  const known = progress !== null;
  const displayedBytes = known ? Math.min(update.downloadedBytes, update.totalBytes!) : update.downloadedBytes;

  let icon = <CircleArrowUp size={15} />;
  let title = `Mythra Code ${version} is available`;
  let detail = "Update and restart from Settings.";
  if (stage === "downloading") {
    icon = <Download size={15} />;
    title = `Downloading ${name}`;
    detail = "Restarts once installed.";
  } else if (stage === "installing") {
    icon = <LoaderCircle className="spin" size={15} />;
    title = `Installing ${name}`;
    detail = "Verifying the signed update.";
  } else if (stage === "restarting") {
    icon = <LoaderCircle className="spin" size={15} />;
    title = "Restarting Mythra Code";
    detail = version ? `Version ${version} is installed.` : "The update is installed.";
  } else if (stage === "failed") {
    icon = <TriangleAlert size={15} />;
    title = "The update didn’t finish";
    detail = update.error || "The update could not be completed.";
  }

  const bytes = stage !== "downloading" ? null
    : known ? `${megabytes(displayedBytes)} of ${megabytes(update.totalBytes!)} MB`
      : update.downloadedBytes > 0 ? `${megabytes(update.downloadedBytes)} MB` : "Starting…";
  const showProgress = stage === "downloading" || stage === "installing";
  const determinate = stage === "downloading" && known;
  const progressText = stage !== "downloading" ? undefined
    : known ? `${progress}%, ${bytes}` : update.downloadedBytes > 0 ? `${bytes} downloaded` : undefined;

  return (
    // A bare polite live region rather than role="status": it is always
    // mounted, and must not compete with the app's transient status messages.
    <div className="app-update-notice-region" aria-live="polite">
      {stage && (
        <div className={`app-update-notice ${stage}`} data-stage={stage}>
          <span className="app-update-notice-icon" aria-hidden="true">{icon}</span>
          <span className="app-update-notice-copy">
            <strong>{title}</strong>
            <small title={stage === "failed" ? detail : undefined}>{detail}</small>
          </span>
          {bytes && (
            // Changes on every chunk, so it stays out of the announcements;
            // the progressbar below exposes the same numbers on demand.
            <span className="app-update-notice-meter" aria-hidden="true">
              <span className="app-update-notice-bytes">
                <span>{bytes}</span>
                {known && <span className="app-update-notice-sizer">{megabytes(update.totalBytes!)} of {megabytes(update.totalBytes!)} MB</span>}
              </span>
              {known && (
                <span className="app-update-notice-percent">
                  <span>{progress}%</span>
                  <span className="app-update-notice-sizer">100%</span>
                </span>
              )}
            </span>
          )}
          {stage !== "restarting" && (
            <button type="button" className="app-update-notice-action" onClick={onOpen}>
              {stage === "available" ? "View update" : stage === "failed" ? "View details" : "Details"}
            </button>
          )}
          {(stage === "available" || stage === "failed") && (
            <button
              type="button"
              className="app-update-notice-dismiss"
              aria-label={stage === "failed" ? "Dismiss update error" : "Dismiss update notice"}
              title="Dismiss"
              onClick={() => (stage === "failed" ? setFailureShown(false) : setDismissedVersion(version))}
            >
              <X size={13} />
            </button>
          )}
          {showProgress && (
            <span
              className={`app-update-notice-progress ${determinate ? "" : "indeterminate"}`}
              role="progressbar"
              aria-label={title}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={determinate ? progress ?? undefined : undefined}
              aria-valuetext={progressText}
            >
              <span style={determinate ? { width: `${progress}%` } : undefined} />
            </span>
          )}
        </div>
      )}
    </div>
  );
}
