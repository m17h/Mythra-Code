import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { hydrateNativeStorage } from "./lib/storage";
import { installContextMenuBlocker } from "./lib/contextMenu";
import "./styles.css";

// This is a desktop application, not a browser surface. Prevent Chromium's
// reload/inspect context menu everywhere, including before React mounts.
installContextMenuBlocker();

void hydrateNativeStorage().finally(async () => {
  const { default: App } = await import("./App");
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
