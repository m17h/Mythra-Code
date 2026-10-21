import { useEffect } from "react";

/** Presentation only: focus still moves normally for scrolling and accessibility.
 * WebKit can keep :focus-visible on a programmatically focused dialog region or
 * restored button after a click. Only explicitly opted-in surfaces use this
 * marker; keyboard input immediately restores their normal focus indicators. */
export function useInputModality(): void {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute("data-input-modality");
    const setMode = (mode: "pointer" | "keyboard") => {
      if (root.getAttribute("data-input-modality") !== mode) root.setAttribute("data-input-modality", mode);
    };
    setMode("keyboard");
    const onPointerDown = () => setMode("pointer");
    const onKeyDown = (event: KeyboardEvent) => {
      if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)) return;
      setMode("keyboard");
    };
    // Window capture runs before dialog/shortcut handlers can consume an event.
    window.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      if (previous === null) root.removeAttribute("data-input-modality");
      else root.setAttribute("data-input-modality", previous);
    };
  }, []);
}
