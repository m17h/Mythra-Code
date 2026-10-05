import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { Window } from "@tauri-apps/api/window";
import { useFlushOnClose } from "../../src/hooks/useFlushOnClose";
import { useBaselineClose } from "./baseline-hook";

// Test-only instrumentation. Production hook remains imported unchanged.
const original = Window.prototype.onCloseRequested;
Window.prototype.onCloseRequested = async function(handler) {
  const stop = await original.call(this, handler);
  await invoke("fixture_record", { kind: "close-listener-registered" });
  return stop;
};

function Shell({ baseline }: { baseline: boolean }) {
  const [mode, setMode] = useState("saved");
  const [error, setError] = useState("");
  const hook = baseline ? useBaselineClose : useFlushOnClose;
  hook(() => invoke("fixture_flush", { mode }), (message) => {
    setError(message);
    void invoke("fixture_record", { kind: "close-error" });
  });
  useEffect(() => { void invoke("fixture_record", { kind: "display-ready" }); }, []);
  return <main style={{ fontFamily: "sans-serif", padding: 28 }}>
    <h1>Native close {baseline ? "baseline" : "candidate"}</h1>
    <p>Synthetic test only. No providers, chats, credentials, or model requests.</p>
    <label>Save behavior <select value={mode} onChange={(event) => setMode(event.target.value)}>
      <option value="saved">Save successfully</option><option value="failed">Fail saving</option><option value="pending">Delay saving 60 seconds</option>
    </select></label>
    <p>Use the native title-bar Close button or Alt+F4.</p>
    <p role="status">{error || "Ready for native close test"}</p>
  </main>;
}

function StartupShell() {
  const [status, setStatus] = useState("Readiness withheld: the native warning is due once after 60 seconds.");
  useFlushOnClose(() => invoke("fixture_flush", { mode: "saved" }), setStatus);
  useEffect(() => { void invoke("fixture_record", { kind: "display-ready" }); }, []);
  return <main style={{ fontFamily: "sans-serif", padding: 28 }}>
    <h1>Native startup candidate</h1>
    <p>Synthetic test only. No providers, production database, or model requests.</p>
    <button onClick={() => {
      void invoke("startup_ready").then(() => setStatus("Readiness acknowledged. No native timeout should appear."));
    }}>Acknowledge ready</button>{" "}
    <button onClick={() => {
      // Render a useful fallback before reporting the fixed failure stage.
      setStatus("Synthetic application import failure. Close this test window and try again.");
      requestAnimationFrame(() => { void invoke("startup_failed", { stage: "app-import" }); });
    }}>Show useful failure</button>
    <p role="status">{status}</p>
    <p>Native Keep waiting/Cancel must retain the window. Explicit Close uses the normal save handshake.</p>
  </main>;
}

void invoke<{ baseline: boolean; startup: boolean }>("fixture_info").then(({ baseline, startup }) => {
  createRoot(document.getElementById("root")!).render(startup ? <StartupShell /> : <Shell baseline={baseline} />);
});
