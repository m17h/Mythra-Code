import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { hydrateNativeStorage } from "./lib/storage";
import { installContextMenuBlocker } from "./lib/contextMenu";
import { installGlobalErrorCapture } from "./lib/errorLog";
import "./styles.css";

// This is a desktop application, not a browser surface. Prevent Chromium's
// reload/inspect context menu everywhere, including before React mounts.
installContextMenuBlocker();
installGlobalErrorCapture();

void hydrateNativeStorage().finally(async () => {
  const { default: App } = await import("./App");
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      {/* Last-resort boundary: a crash anywhere in App shows a recoverable
          fallback instead of a blank window. */}
      <ErrorBoundary label="application">
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
});
