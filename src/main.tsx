// Keep the entry independent of React, storage and application modules. A
// rejected dependency evaluation must reach this catch before any App mount.
// Even a small static helper import can be grouped into an application shared
// chunk by the production bundler, so this entry has no runtime imports.
async function start(): Promise<void> {
  window.__MYTHRA_STARTUP__?.stage("entry");
  try {
    const { startApplication } = await import("./lib/startApplication");
    await startApplication();
  } catch {
    window.__MYTHRA_STARTUP__?.fail();
  }
}

void start();
