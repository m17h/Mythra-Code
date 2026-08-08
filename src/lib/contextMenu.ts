/** Disable Chromium's browser context menu for the desktop application. */
export function installContextMenuBlocker(target: Document = document): () => void {
  const prevent = (event: Event) => event.preventDefault();
  target.addEventListener("contextmenu", prevent, { capture: true });
  return () => target.removeEventListener("contextmenu", prevent, { capture: true });
}
