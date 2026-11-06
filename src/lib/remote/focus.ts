let releaseEscape: (() => void) | null = null;

/** Dismissing a remote surface must not turn the same held key into the
 * application's Stop shortcut after that surface has unmounted. */
export function consumeEscapeUntilRelease(): void {
  if (releaseEscape) return;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const release = () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", release);
    releaseEscape = null;
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === "Escape") release();
  };
  releaseEscape = release;
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", release);
}
