import type { Activity } from "../types";

/** Native wording (`checkpoint_repo`) for a folder that is not inside any Git repository. */
const MISSING_GIT_REPOSITORY = /^Checkpoints require a Git repository$/i;
const LEGACY_WARNING_SUFFIX = ". The model can still work, but Mythra Code cannot create restorable file snapshots here.";

/** Only a folder with no Git at all can be fixed by initializing Git there.
 * A subfolder of another repository or a missing folder is a different limit. */
export function isMissingGitCheckpointError(message: string): boolean {
  return MISSING_GIT_REPOSITORY.test(message.trim());
}

/**
 * The timeline row older versions wrote at the start of every thread in a
 * folder without Git. It never cleared, even after Git was set up, and the
 * notification now replaces it. This matches that exact row only: real
 * checkpoint failures and other checkpoint limits stay visible.
 */
export function isObsoleteCheckpointGitWarning(activity: Pick<Activity, "id" | "kind" | "title" | "detail">): boolean {
  const detail = activity.detail?.trim() ?? "";
  const nativeError = detail.endsWith(LEGACY_WARNING_SUFFIX)
    ? detail.slice(0, -LEGACY_WARNING_SUFFIX.length)
    : detail;
  return activity.kind === "warning"
    && activity.id.startsWith("checkpoint-unavailable-")
    && activity.title === "Automatic checkpoints unavailable"
    && isMissingGitCheckpointError(nativeError);
}

/** Keeps the array identity when there is nothing to hide, so memoized views stay cheap. */
export function withoutObsoleteCheckpointGitWarnings<T extends Pick<Activity, "id" | "kind" | "title" | "detail">>(activities: T[]): T[] {
  return activities.some(isObsoleteCheckpointGitWarning)
    ? activities.filter((activity) => !isObsoleteCheckpointGitWarning(activity))
    : activities;
}

/** How long an untouched notification stays on screen. */
export const CHECKPOINT_GIT_NOTICE_MS = 30_000;
