// Injects the active custom theme's compiled CSS into <head>:
//   <style id="mythra-custom-theme">      tokens, see-through surfaces, accent effects, typography
//   <style id="mythra-custom-theme-css">  the theme's sanitized customCss (separate, so the
//                                         readability probe and safe mode can switch it off)
// Removed on unmount or when no custom theme is active. Renders nothing.

import { useLayoutEffect, useMemo } from "react";
import { useMediaQueryMatch } from "../hooks/useMediaQueryMatch";
import { compileThemeCss } from "../lib/customThemes/compile";
import { CUSTOM_CSS_STYLE_ID, CUSTOM_THEME_STYLE_ID } from "../lib/customThemes/probe";
import type { CustomThemeId, ThemeSpec } from "../lib/customThemes/spec";

function platform(): "mac" | "windows" | "other" {
  if (typeof document === "undefined") return "other";
  const value = document.documentElement.getAttribute("data-platform");
  return value === "windows" || value === "mac" ? value : "other";
}

function upsert(id: string, css: string, attrs: Record<string, string>): void {
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!css) { el?.remove(); return; }
  if (!el) {
    el = document.createElement("style");
    el.id = id;
    document.head.appendChild(el);
  }
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  if (el.textContent !== css) el.textContent = css;
}

export function CustomThemeStyle(props: { spec: ThemeSpec | null; id?: CustomThemeId; revision?: number; customCssEnabled?: boolean }): null {
  const { spec, id, revision, customCssEnabled } = props;
  const forcedColors = useMediaQueryMatch("(forced-colors: active)");
  const compiled = useMemo(() => {
    if (!spec || !id) return null;
    try {
      // Forced colours (Windows high contrast): tokens only; no customCss.
      return compileThemeCss(spec, { id, scope: "app", platform: platform(), customCssEnabled, forcedColors });
    } catch (error) {
      console.error("Custom theme failed to compile", error);
      return null;
    }
  }, [spec, id, customCssEnabled, forcedColors]);

  useLayoutEffect(() => {
    if (typeof document === "undefined") return;
    const attrs = { "data-theme-id": id ?? "", "data-revision": String(revision ?? "") };
    upsert(CUSTOM_THEME_STYLE_ID, compiled?.tokenCss ?? "", attrs);
    upsert(CUSTOM_CSS_STYLE_ID, compiled?.customCss ?? "", attrs);
  }, [compiled, id, revision]);

  useLayoutEffect(() => () => {
    document.getElementById(CUSTOM_THEME_STYLE_ID)?.remove();
    document.getElementById(CUSTOM_CSS_STYLE_ID)?.remove();
  }, []);

  return null;
}

export default CustomThemeStyle;
