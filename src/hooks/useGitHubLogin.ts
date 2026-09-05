import { useEffect, useRef } from "react";
import { getGitHubStatus, type GitHubAccountStatus } from "../lib/github";
import { friendlyError } from "../lib/errors";

export function useGitHubLogin(options: {
  pending: boolean;
  onStatus: (status: GitHubAccountStatus) => void;
  onDone: () => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
}): void {
  const current = useRef(options);
  current.current = options;
  // Retained across effect restarts so toggling the surface cannot launch a
  // second native probe while the previous one is still winding down.
  const inFlight = useRef(false);
  useEffect(() => {
    if (!options.pending) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let lastError = "";
    const deadline = window.setTimeout(() => {
      disposed = true;
      clearTimeout(timer);
      current.current.onDone();
      current.current.onError(lastError || "GitHub sign-in was not detected. Finish `gh auth login`, then use Refresh in GitHub settings.");
    }, 90_000);
    const check = async () => {
      if (disposed) return;
      if (inFlight.current) {
        timer = setTimeout(() => void check(), 2_000);
        return;
      }
      inFlight.current = true;
      try {
        const next = await getGitHubStatus();
        if (disposed) return;
        current.current.onStatus(next);
        if (next.authenticated) {
          disposed = true;
          window.clearTimeout(deadline);
          current.current.onDone();
          current.current.onSuccess(`GitHub connected${next.login ? ` as @${next.login}` : ""}`);
        } else {
          failures = next.error ? failures + 1 : 0;
        }
      } catch (reason) {
        failures += 1;
        lastError = `Could not verify GitHub sign-in: ${friendlyError(reason)}`;
      } finally {
        inFlight.current = false;
        if (!disposed) timer = setTimeout(() => void check(), Math.min(15_000, 2_000 * 2 ** Math.min(failures, 3)));
      }
    };
    void check();
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.clearTimeout(deadline);
    };
  }, [options.pending]);
}
