(function () {
  "use strict";

  // Deliberately classic, dependency-free syntax for the oldest supported
  // webviews. Do not put exception text, URLs or saved data in this surface.
  var stages = ["bootstrap", "entry", "hydration", "app-import", "mount", "render"];
  var stage = "bootstrap";
  var state = "pending";
  var notify = null;
  var nativeOutcome = null;
  var notified = false;
  var deadline;
  var html = document.documentElement;

  function sendOutcome() {
    if (!notify || !nativeOutcome || notified) return;
    notified = true;
    // Notification never gates rendering and is never retried.
    try { notify(nativeOutcome.command, nativeOutcome.stage); } catch (_) { /* Native watchdog remains available. */ }
  }

  function updateSurface() {
    var title = document.getElementById("startup-title");
    var description = document.getElementById("startup-description");
    var detail = document.getElementById("startup-stage");
    if (!title || !description || !detail) return;
    if (state === "waiting") {
      title.textContent = "Mythra Code is still starting";
      description.textContent = "Startup is taking longer than expected. You can keep waiting, or close the app and open it again. Your saved data has not been reset.";
    } else if (state === "failed") {
      title.textContent = "Mythra Code couldn’t finish starting";
      description.textContent = stage === "hydration"
        ? "Mythra Code couldn’t load your saved app data safely. Close the app and try again. If this continues, contact support before deleting or resetting any app data."
        : "Close the app and open it again. If this continues, reinstall the latest version or contact support. Your saved data has not been reset.";
    }
    detail.textContent = "Startup stage: " + stage;
  }

  function fail(nextStage) {
    if (state === "failed") return;
    if (stages.indexOf(nextStage) !== -1) stage = nextStage;
    state = "failed";
    clearTimeout(deadline);
    html.classList.remove("startup-pending", "startup-ready");
    var surface = document.getElementById("startup-status");
    if (surface) surface.hidden = false;
    updateSurface();
    // One native outcome per document. A later render crash still reveals the
    // independent surface, but does not send a second startup acknowledgement.
    if (!nativeOutcome) nativeOutcome = { command: "startup_failed", stage: stage };
    sendOutcome();
  }

  window.__MYTHRA_STARTUP__ = {
    stage: function (nextStage) {
      if (state === "failed" || state === "ready") return;
      if (stages.indexOf(nextStage) !== -1) stage = nextStage;
      updateSurface();
    },
    failed: function () { return state === "failed"; },
    fail: fail,
    ready: function () {
      if (state === "failed" || state === "ready") return;
      state = "ready";
      clearTimeout(deadline);
      html.classList.remove("startup-pending");
      html.classList.add("startup-ready");
      var surface = document.getElementById("startup-status");
      if (surface) surface.hidden = true;
      nativeOutcome = { command: "startup_ready" };
      sendOutcome();
    },
    registerNotifier: function (callback) {
      if (notify) return;
      notify = callback;
      sendOutcome();
    }
  };

  html.classList.add("startup-pending");
  document.addEventListener("DOMContentLoaded", updateSurface, { once: true });
  window.addEventListener("error", function (event) {
    if (state === "ready" || (stage !== "bootstrap" && stage !== "entry")) return;
    // Failed images/styles are not failed application startup. Once the
    // loader is available, its explicit catch and root boundary own failure.
    if (event.target && event.target !== window && event.target.tagName !== "SCRIPT") return;
    fail();
  }, true);
  // This deadline only reveals status. The single startup attempt remains
  // blocked on its original hydration promise; it never mounts partial data.
  deadline = setTimeout(function () {
    if (state !== "pending") return;
    state = "waiting";
    html.classList.remove("startup-pending");
    updateSurface();
  }, 10000);
}());
