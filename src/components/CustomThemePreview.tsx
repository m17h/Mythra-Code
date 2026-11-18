// Mini preview for gallery tiles (DESIGN §5.3): a small window drawn in the
// theme's own tokens (set as inline custom properties on the wrapper, so it
// works anywhere and never touches the shell), with CSS stand-ins for its
// effects. Moves only while `animate` is true, the tile is on screen and
// motion is allowed; otherwise it shows a still frame. customCss is never
// rendered here.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { compileThemeCss, themeVariables } from "../lib/customThemes/compile";
import { formatColor, mixColors, parseColor, withAlpha, type Rgba } from "../lib/customThemes/color";
import { blobOpacity, grainOpacity, resolveEffectParams, scanlineOpacity, starLayers, type EffectPalette } from "../lib/customThemes/effects";
import { seeThroughAlpha, type CustomThemeId, type ThemeSpec } from "../lib/customThemes/spec";
import { resolveTheme } from "../lib/customThemes/validate";
import { blobGradient } from "./ThemeEffectsLayer";

type Vars = CSSProperties & Record<`--${string}`, string | number>;

const colorsOf = (value: unknown): Rgba[] => (Array.isArray(value) ? value.map((c) => parseColor(c)).filter((c): c is Rgba => Boolean(c)) : []);

/** Stars scaled into a 200x125 tile. */
function previewStars(seed: string): string {
  const layers = starLayers(`preview:${seed}`, "sparse");
  return layers.join(", ").split(", ").filter((_, i) => i % 4 === 0).map((shadow) => {
    const [x, y, , size, ink] = shadow.split(" ");
    return `${Math.round(parseFloat(x) / 9)}px ${Math.round(parseFloat(y) / 9.6)}px 0 ${parseFloat(size) > 0 ? "0.5px" : "0"} ${ink}`;
  }).join(", ");
}

function useOnScreen(ref: RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((entry) => entry.isIntersecting)), { threshold: 0.01 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return visible;
}

export function CustomThemePreview(props: { id: CustomThemeId; spec: ThemeSpec; animate: boolean }) {
  const { id, spec, animate } = props;
  const ref = useRef<HTMLSpanElement | null>(null);
  const onScreen = useOnScreen(ref);
  const model = useMemo(() => {
    try {
      const resolved = resolveTheme(spec);
      const vars = themeVariables(spec, resolved) as Record<string, string>;
      const p = resolved.palette;
      const palette: EffectPalette = { scheme: resolved.scheme, bg: p.bg, text: p.text, accent: p.accent, fill: p.fill, onAccent: p.onAccent, info: p.info, success: p.success, danger: p.danger, warning: p.warning };
      const fx = (type: keyof ThemeSpec["effects"]) => (spec.effects[type] ? resolveEffectParams(type, spec.effects[type] as Record<string, unknown>, palette) : null);
      // Previews show backdrops a little stronger than the real window does, so a 60px tile still reads.
      const t = seeThroughAlpha(spec.surfaces.translucency);
      return { resolved, vars, palette, fx, t, compiled: compileThemeCss(spec, { id, scope: "preview", platform: "other" }) };
    } catch {
      return null;
    }
  }, [spec, id]);
  if (!model) return <span ref={ref} className="ct-preview" aria-hidden="true" />;
  const { resolved, vars, fx, t } = model;
  const dark = resolved.scheme === "dark";
  const style: Vars = { ...(vars as Vars) };
  if (t > 0) {
    style["--ct-pv-bg"] = formatColor(withAlpha(resolved.palette.bg, 1 - t));
    style["--ct-pv-sidebar"] = formatColor(withAlpha(resolved.palette.sidebar, 1 - t));
  }
  const aurora = fx("aurora");
  const mesh = fx("mesh");
  const stars = fx("starfield");
  const particles = fx("particles");
  const grid = fx("grid");
  const grain = fx("grain");
  const scan = fx("scanlines");
  const glow = fx("glow");
  const border = fx("border");
  const flow = fx("accentFlow");
  if (border) style["--ct-pv-ring"] = `conic-gradient(from 200deg, ${[...colorsOf(border.colors), colorsOf(border.colors)[0]].map(formatColor).join(", ")})`;
  if (flow) style["--ct-pv-flow"] = `linear-gradient(110deg, ${[...colorsOf(flow.colors), colorsOf(flow.colors)[0]].map(formatColor).join(", ")})`;
  if (glow) style["--ct-pv-glow"] = formatColor(withAlpha(parseColor(glow.color) ?? resolved.palette.accent, 0.5));
  if (grid) style["--ct-pv-line"] = formatColor(withAlpha(parseColor(grid.color) ?? resolved.palette.accent, 0.6));
  const moving = animate && onScreen && spec.motion.enabled && model.compiled.hasMotion;
  const blobs = aurora ?? mesh;
  const blobColors = blobs ? colorsOf(blobs.colors) : [];
  const starInk = stars ? String(stars.color) : particles ? formatColor(mixColors(colorsOf(particles.colors)[0] ?? resolved.palette.accent, resolved.palette.bg, 0.1)) : "";
  return (
    <span ref={ref} className="ct-preview" data-ct-preview={id} data-animate={moving ? "on" : "off"} data-scheme={resolved.scheme} aria-hidden="true" style={style}>
      {t > 0 && (blobs || stars || particles || grid) && (
        <span className="ct-preview-fx" data-pos={aurora ? String(aurora.position ?? "top") : "full"} style={{ opacity: blobs ? Math.min(1, blobOpacity(blobs.intensity as number, resolved.scheme, aurora ? "aurora" : "mesh") * 1.4) : 1 }}>
          {blobColors.slice(0, 4).map((color, index) => <i key={index} className={`ct-pv-blob ct-pv-blob-${index + 1}`} style={{ backgroundImage: blobGradient(color) }} />)}
          {(stars || particles) && <i className="ct-pv-stars" style={{ color: starInk, boxShadow: previewStars(id) }} />}
          {grid && <i className="ct-pv-grid" />}
        </span>
      )}
      <span className="ct-preview-ui">
        <i className="ct-pv-rail">
          <i className="ct-pv-dot" />
          <i className="ct-pv-row r1" />
          <i className="ct-pv-row r2" />
          <i className="ct-pv-row r3" />
          <i className="ct-pv-row r4" />
        </i>
        <i className="ct-pv-main">
          <i className="ct-pv-top" />
          <i className="ct-pv-bubble" />
          <i className="ct-pv-line l1" />
          <i className="ct-pv-line l2" />
          <i className="ct-pv-line l3" />
          <i className="ct-pv-code" />
          <i className="ct-pv-composer">
            {border && <i className="ct-pv-ring" />}
            <i className="ct-pv-send">{glow && <i className="ct-pv-glow" />}</i>
          </i>
        </i>
      </span>
      {grain && <span className="ct-preview-tex" data-scheme={resolved.scheme} style={{ opacity: grainOpacity(grain.amount as number) * 1.4, backgroundSize: "3px 3px, 5px 5px", backgroundPosition: "0 0, 1px 2px", backgroundImage: `radial-gradient(circle, ${dark ? "rgba(255,255,255,.55)" : "rgba(0,0,0,.4)"} 0 0.45px, transparent 0.6px), radial-gradient(circle, ${dark ? "rgba(255,255,255,.4)" : "rgba(0,0,0,.3)"} 0 0.4px, transparent 0.55px)` }} />}
      {scan && <span className="ct-preview-scan" style={{ opacity: scanlineOpacity(scan.opacity as number) * 6, backgroundImage: `repeating-linear-gradient(to bottom, ${dark ? "rgba(0,0,0,1)" : "rgba(40,30,20,1)"} 0 1px, transparent 1px ${Number(scan.spacing) || 3}px)` }} />}
    </span>
  );
}

export default CustomThemePreview;
