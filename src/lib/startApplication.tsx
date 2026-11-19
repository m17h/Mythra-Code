import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { hydrateNativeStorage } from "./storage";
import { installContextMenuBlocker } from "./contextMenu";
import { installGlobalErrorCapture } from "./errorLog";
import { failStartup, hasStartupFailed, markStartupReady, registerStartupNotifier, setStartupStage } from "./startup";
import { markDocumentPlatform } from "./platform";
// Global stylesheets in cascade order (shared with the hidden theme preview).
import "./appStyles";

function StartupCommitted() {
  // This acknowledges a committed React tree, not painted pixels or the
  // completion of deferred provider discovery. A failed render never mounts it.
  useEffect(() => {
    // Let sibling effects finish first. Their errors can be caught by the root
    // boundary during this flush; that terminal failure must beat readiness.
    queueMicrotask(markStartupReady);
  }, []);
  return null;
}

export async function startApplication(): Promise<void> {
  // Tauri can serve index.html when a packaged HTML entry is missing. The
  // hidden preview must never mount the live app from that fallback.
  if (window.location.pathname === "/theme-preview.html") return;
  registerStartupNotifier((command, stage) => {
    void invoke(command, stage ? { stage } : undefined).catch(() => {
      // Browser previews have no native IPC. The native watchdog owns its own
      // independent deadline if an acknowledgement cannot be delivered.
    });
  });
  if (hasStartupFailed()) return;
  try {
    await mountApplication();
  } catch (reason) {
    // The classic bootstrap asset can be unavailable independently of the
    // application graph. Its absence must not drop a hydration/import failure
    // or leave the native watchdog waiting after the fallback is visible.
    failStartup();
    throw reason;
  }
}

async function mountApplication(): Promise<void> {
  installContextMenuBlocker();
  installGlobalErrorCapture();
  // Platform-specific tuning in CSS (for example Windows' heavier text
  // rendering on dark themes, see lumen/tokens.css) keys off this marker.
  markDocumentPlatform();

  setStartupStage("hydration");
  await hydrateNativeStorage();
  if (hasStartupFailed()) return;
  setStartupStage("app-import");
  const { default: App } = await import("../App");
  if (hasStartupFailed()) return;
  setStartupStage("mount");
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing application root");
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary label="application" onError={() => failStartup("render")}>
        <App />
        <StartupCommitted />
      </ErrorBoundary>
    </StrictMode>,
  );
}
