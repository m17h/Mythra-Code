export type StartupStage = "bootstrap" | "entry" | "hydration" | "app-import" | "mount" | "render";
type StartupCommand = "startup_ready" | "startup_failed";
type StartupNotifier = (command: StartupCommand, stage?: StartupStage) => void;
let fallbackNotifier: StartupNotifier | undefined;
let fallbackOutcomeSent = false;
let fallbackFailed = false;
let fallbackStage: StartupStage = "entry";
let fallbackOutcome: { command: StartupCommand; stage?: StartupStage } | undefined;

function sendFallbackOutcome(): void {
  if (fallbackOutcomeSent || !fallbackNotifier || !fallbackOutcome) return;
  fallbackOutcomeSent = true;
  fallbackNotifier(fallbackOutcome.command, fallbackOutcome.stage);
}

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
  if (window.__MYTHRA_STARTUP__) window.__MYTHRA_STARTUP__.stage(stage);
  else if (!fallbackOutcome) fallbackStage = stage;
}

export function failStartup(stage?: StartupStage): void {
  if (window.__MYTHRA_STARTUP__) {
    window.__MYTHRA_STARTUP__.fail(stage);
    return;
  }
  fallbackFailed = true;
  fallbackStage = stage ?? fallbackStage;
  const surface = document.getElementById("startup-status");
  if (surface) surface.hidden = false;
  const detail = document.getElementById("startup-stage");
  if (detail) detail.textContent = `Startup stage: ${fallbackStage}`;
  if (fallbackStage === "hydration") {
    const description = document.getElementById("startup-description");
    if (description) description.textContent = "Mythra Code couldn’t load your saved app data safely. Close the app and try again. If this continues, contact support before deleting or resetting any app data.";
  }
  fallbackOutcome ??= { command: "startup_failed", stage: fallbackStage };
  sendFallbackOutcome();
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
  fallbackOutcome ??= { command: "startup_ready" };
  sendFallbackOutcome();
}

export function registerStartupNotifier(notify: StartupNotifier): void {
  if (window.__MYTHRA_STARTUP__) window.__MYTHRA_STARTUP__.registerNotifier(notify);
  else {
    fallbackNotifier ??= notify;
    sendFallbackOutcome();
  }
}
