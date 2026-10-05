export type StartupStage = "bootstrap" | "entry" | "hydration" | "app-import" | "mount" | "render";
type StartupCommand = "startup_ready" | "startup_failed";
type StartupNotifier = (command: StartupCommand, stage?: StartupStage) => void;
let fallbackNotifier: StartupNotifier | undefined;
let fallbackOutcomeSent = false;
let fallbackFailed = false;

interface StartupController {
  stage: (stage: StartupStage) => void;
  failed: () => boolean;
  fail: (stage?: StartupStage) => void;
  ready: () => void;
  registerNotifier: (notify: StartupNotifier) => void;
}

declare global {
  interface Window {
    __MYTHRA_STARTUP__?: StartupController;
  }
}

export function setStartupStage(stage: StartupStage): void {
  window.__MYTHRA_STARTUP__?.stage(stage);
}

export function failStartup(stage?: StartupStage): void {
  if (window.__MYTHRA_STARTUP__) {
    window.__MYTHRA_STARTUP__.fail(stage);
    return;
  }
  fallbackFailed = true;
  const surface = document.getElementById("startup-status");
  if (surface) surface.hidden = false;
  if (!fallbackOutcomeSent && fallbackNotifier) {
    fallbackOutcomeSent = true;
    fallbackNotifier("startup_failed", stage ?? "render");
  }
}

export function hasStartupFailed(): boolean {
  return window.__MYTHRA_STARTUP__?.failed() ?? fallbackFailed;
}

export function markStartupReady(): void {
  if (window.__MYTHRA_STARTUP__) {
    window.__MYTHRA_STARTUP__.ready();
    return;
  }
  if (fallbackFailed) return;
  // A blocked optional bootstrap asset must not cover a healthy committed App.
  const surface = document.getElementById("startup-status");
  if (surface) surface.hidden = true;
  if (!fallbackOutcomeSent && fallbackNotifier) {
    fallbackOutcomeSent = true;
    fallbackNotifier("startup_ready");
  }
}

export function registerStartupNotifier(notify: StartupNotifier): void {
  if (window.__MYTHRA_STARTUP__) window.__MYTHRA_STARTUP__.registerNotifier(notify);
  else fallbackNotifier ??= notify;
}
