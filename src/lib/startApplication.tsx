import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { hydrateNativeStorage } from "./storage";
import { installContextMenuBlocker } from "./contextMenu";
import { installGlobalErrorCapture } from "./errorLog";
import { failStartup, hasStartupFailed, markStartupReady, registerStartupNotifier, setStartupStage } from "./startup";
import { isMacPlatform, isWindowsPlatform } from "./platform";
import "../styles.css";
// Bundled chat fonts. @font-face rules only download a face once text uses it.
import "@fontsource/pixelify-sans/400.css";
import "@fontsource/pixelify-sans/500.css";
import "@fontsource/pixelify-sans/600.css";
import "@fontsource/pixelify-sans/700.css";
import "@fontsource/vt323/400.css";
// The Lumen redesign must follow styles.css: same-named @keyframes and any
// equal-specificity rules resolve to whichever sheet comes last.
import "../styles/lumen/index.css";

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
  registerStartupNotifier((command, stage) => {
    void invoke(command, stage ? { stage } : undefined).catch(() => {
      // Browser previews have no native IPC. The native watchdog owns its own
      // independent deadline if an acknowledgement cannot be delivered.
    });
  });
  if (hasStartupFailed()) return;
  installContextMenuBlocker();
  installGlobalErrorCapture();
  // Platform-specific tuning in CSS (for example Windows' heavier text
  // rendering on dark themes, see lumen/tokens.css) keys off this marker.
  document.documentElement.setAttribute("data-platform", isWindowsPlatform() ? "windows" : isMacPlatform() ? "mac" : "other");

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
