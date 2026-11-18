// The custom theme's effects layers (DESIGN §5). Two absolutely positioned,
// pointer-transparent layers inside the shell (the shell becomes an isolated
// stacking context in compile.ts):
//   .ct-fx-back   z-index -1: aurora, mesh, starfield, particles, grid, vignette.
//                 Visible only through the see-through window background and
//                 sidebar; panels, menus, fields and code stay solid.
//   .ct-fx-front  above the panes, below popovers: grain and scanlines.
// Motion: only transform and opacity on the layers' own nodes; every
// animation is gated by data-motion="on" on the layer and by
// prefers-reduced-motion in custom-themes.css; transient pauses use the Web
// Animations API (motion.ts). Colours come in as inline custom properties on
// these few nodes, never on the shell.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { formatColor, mixColors, parseColor, seededRandom, withAlpha, type Rgba } from "../lib/customThemes/color";
import { blobOpacity, effectSeconds, grainOpacity, resolveEffectParams, scanlineOpacity, starLayers, vignetteAlpha, type EffectPalette, type ResolvedParams } from "../lib/customThemes/effects";
import { isThemeMotionTransientlyPaused, subscribeThemeMotion } from "../lib/customThemes/motion";
import type { CustomThemeId, EffectType, ThemeSpec } from "../lib/customThemes/spec";
import { resolveTheme } from "../lib/customThemes/validate";

type Vars = CSSProperties & Record<`--${string}`, string | number>;

/** A soft blob: radial gradient with an eased falloff (no blur filter). */
export function blobGradient(color: Rgba): string {
  const stops: Array<[number, number]> = [[0, 1], [18, 0.82], [36, 0.56], [54, 0.3], [72, 0.12], [86, 0.04], [100, 0]];
  return `radial-gradient(closest-side, ${stops.map(([at, a]) => `${formatColor(withAlpha(color, a))} ${at}%`).join(", ")})`;
}

const colorsOf = (value: unknown): Rgba[] => (Array.isArray(value) ? value.map((c) => parseColor(c)).filter((c): c is Rgba => Boolean(c)) : []);

export interface EffectLayerModel {
  scheme: "light" | "dark";
  translucency: number;
  seed: string;
  params: Partial<Record<EffectType, ResolvedParams>>;
  palette: EffectPalette;
}

export function effectLayerModel(spec: ThemeSpec, seed: string): EffectLayerModel {
  const resolved = resolveTheme(spec);
  const p = resolved.palette;
  const palette: EffectPalette = { scheme: resolved.scheme, bg: p.bg, text: p.text, accent: p.accent, fill: p.fill, onAccent: p.onAccent, info: p.info, success: p.success, danger: p.danger, warning: p.warning };
  const params: EffectLayerModel["params"] = {};
  for (const type of Object.keys(spec.effects) as EffectType[]) {
    const raw = spec.effects[type];
    if (raw) params[type] = resolveEffectParams(type, raw as Record<string, unknown>, palette);
  }
  return { scheme: resolved.scheme, translucency: spec.surfaces.translucency, seed, params, palette };
}

const DURATION_MULTIPLIERS = [1, 1.27, 0.83, 1.11];

export function AuroraLayer({ params, scheme }: { params: ResolvedParams; scheme: "light" | "dark" }) {
  const colors = colorsOf(params.colors);
  const seconds = effectSeconds("aurora", params.speed);
  const style: Vars = { opacity: blobOpacity(params.intensity as number, scheme, "aurora") };
  return (
    <div className="ct-fx-aurora" data-pos={String(params.position ?? "top")} style={style}>
      {[0, 1, 2].map((index) => (
        <i key={index} className={`ct-fx-blob ct-fx-blob-${index + 1}`}
          style={{ backgroundImage: blobGradient(colors[index % colors.length]), ...(seconds ? { animationDuration: `${(seconds * DURATION_MULTIPLIERS[index]).toFixed(1)}s`, animationDelay: `-${(seconds * (0.21 + index * 0.29)).toFixed(1)}s` } : { animationName: "none" }) }} />
      ))}
      {colors[3] && <i className="ct-fx-blob ct-fx-blob-4" style={{ backgroundImage: blobGradient(colors[3]), ...(seconds ? { animationDuration: `${(seconds * DURATION_MULTIPLIERS[3]).toFixed(1)}s`, animationDelay: `-${(seconds * 0.6).toFixed(1)}s` } : { animationName: "none" }) }} />}
    </div>
  );
}

export function MeshLayer({ params, scheme }: { params: ResolvedParams; scheme: "light" | "dark" }) {
  const colors = colorsOf(params.colors);
  const seconds = effectSeconds("mesh", params.speed);
  return (
    <div className="ct-fx-mesh" style={{ opacity: blobOpacity(params.intensity as number, scheme, "mesh") }}>
      {[0, 1, 2, 3].map((index) => (
        <i key={index} className={`ct-fx-mesh-blob ct-fx-mesh-${index + 1}`}
          style={{ backgroundImage: blobGradient(colors[index % colors.length]), ...(seconds ? { animationDuration: `${(seconds * DURATION_MULTIPLIERS[index]).toFixed(1)}s`, animationDelay: `-${(seconds * index * 0.23).toFixed(1)}s` } : { animationName: "none" }) }} />
      ))}
    </div>
  );
}

export function StarfieldLayer({ params, seed }: { params: ResolvedParams; seed: string }) {
  const accent = typeof params.accentColor === "string" ? params.accentColor : undefined;
  const layers = useMemo(() => starLayers(seed, (params.density as "sparse" | "normal" | "dense") ?? "normal", accent), [seed, params.density, accent]);
  const style: Vars = { color: String(params.color), "--ct-fx-star": String(params.color) };
  return (
    <div className="ct-fx-stars" data-twinkle={params.twinkle === false ? "off" : "on"} data-drift={String(params.drift ?? "none")} style={style}>
      {layers.map((shadows, index) => <i key={index} className={`ct-fx-star-layer ct-fx-star-l${index + 1}`} style={{ boxShadow: shadows }} />)}
      {params.shootingStars === true && <i className="ct-fx-shoot" />}
    </div>
  );
}

export function GridLayer({ params, scheme }: { params: ResolvedParams; scheme: "light" | "dark" }) {
  const color = parseColor(params.color) ?? { r: 1, g: 0.4, b: 0.8, a: 1 };
  const seconds = effectSeconds("grid", params.speed);
  const style: Vars = {
    top: `${Math.round((params.horizon as number) * 100)}%`,
    "--ct-fx-line": formatColor(withAlpha(color, scheme === "dark" ? 0.55 : 0.4)),
    "--ct-fx-horizon": formatColor(withAlpha(color, scheme === "dark" ? 0.75 : 0.4)),
    "--ct-fx-horizon-line": formatColor(withAlpha(color, scheme === "dark" ? 0.9 : 0.6)),
  };
  return (
    <>
      {params.glow !== false && <i className="ct-fx-grid-glow" style={style} />}
      <div className="ct-fx-grid" style={style}>
        <i className="ct-fx-grid-floor" style={seconds ? { animationDuration: `${seconds}s` } : { animationName: "none" }} />
      </div>
    </>
  );
}

export function VignetteLayer({ params }: { params: ResolvedParams }) {
  const color = parseColor(params.color) ?? { r: 0, g: 0, b: 0, a: 1 };
  return <i className="ct-fx-vignette" style={{ backgroundImage: `radial-gradient(ellipse 75% 70% at 50% 45%, ${formatColor(withAlpha(color, 0))} 55%, ${formatColor(withAlpha(color, vignetteAlpha(params.strength as number) * 0.55))} 80%, ${formatColor(withAlpha(color, vignetteAlpha(params.strength as number)))} 100%)` }} />;
}

// ---- Grain: one noise tile, generated once per scheme ---------------------------------

const grainCache = new Map<string, Promise<string>>();

function grainTile(scheme: "light" | "dark"): Promise<string> {
  const hit = grainCache.get(scheme);
  if (hit) return hit;
  const promise = new Promise<string>((resolve) => {
    if (typeof document === "undefined") { resolve(""); return; }
    const size = 160;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) { resolve(""); return; }
    const image = ctx.createImageData(size, size);
    const random = seededRandom(`grain:${scheme}`);
    for (let i = 0; i < image.data.length; i += 4) {
      // Signed noise around mid-grey with a soft distribution (sum of two uniforms).
      // Dark themes: white specks (screened on); light themes: dark specks (multiplied on).
      const n = (random() + random() + random()) / 3;
      const strength = Math.min(1, Math.abs(n - 0.5) * 3.2);
      const v = scheme === "dark" ? 255 : 0;
      image.data[i] = v; image.data[i + 1] = v; image.data[i + 2] = v;
      image.data[i + 3] = Math.round(255 * strength);
    }
    ctx.putImageData(image, 0, 0);
    if (typeof canvas.toBlob === "function") canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : canvas.toDataURL()), "image/png");
    else resolve(canvas.toDataURL());
  });
  grainCache.set(scheme, promise);
  return promise;
}

export function GrainLayer({ params, scheme }: { params: ResolvedParams; scheme: "light" | "dark" }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let live = true;
    void grainTile(scheme).then((value) => { if (live) setUrl(value); });
    return () => { live = false; };
  }, [scheme]);
  if (!url) return null;
  return <i className="ct-fx-grain" data-animated={params.animated ? "on" : "off"} data-scheme={scheme} style={{ backgroundImage: `url("${url}")`, opacity: grainOpacity(params.amount as number) }} />;
}

export function ScanlinesLayer({ params, scheme }: { params: ResolvedParams; scheme: "light" | "dark" }) {
  const spacing = Number(params.spacing) || 3;
  const ink = scheme === "dark" ? "rgba(0, 0, 0, 1)" : "rgba(40, 30, 20, 1)";
  const style: Vars = {
    backgroundImage: `repeating-linear-gradient(to bottom, ${ink} 0px, ${ink} 1px, transparent 1px, transparent ${spacing}px)`,
    opacity: scanlineOpacity(params.opacity as number) * (scheme === "dark" ? 2.2 : 1.4),
    "--ct-fx-scan-step": `${spacing * 8}px`,
  };
  return <i className="ct-fx-scan" data-roll={params.roll ? "on" : "off"} style={style} />;
}

// ---- Particles (canvas) ---------------------------------------------------------

interface Mote { x: number; y: number; vx: number; vy: number; r: number; color: number; phase: number }

export function ParticlesCanvas({ params, seed, motion, scale = 1 }: { params: ResolvedParams; seed: string; motion: "on" | "paused"; scale?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const colors = useMemo(() => colorsOf(params.colors).map((c) => formatColor(c)), [params.colors]);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const still = params.speed === "still" || motion !== "on" || reduced;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const random = seededRandom(`particles:${seed}`);
    const count = Math.min(params.links ? 40 : 60, Number(params.count) || 24);
    const [minR, maxR] = (params.size as [number, number]) ?? [1, 2.5];
    const speedPx = ({ still: 0, slow: 6, medium: 12, lively: 22 } as Record<string, number>)[String(params.speed)] ?? 6;
    let width = 0, height = 0;
    let motes: Mote[] = [];
    const sprites = colors.map((color) => {
      const sprite = document.createElement("canvas");
      const s = 32;
      sprite.width = s; sprite.height = s;
      const g = sprite.getContext("2d");
      if (g) {
        const parsed = parseColor(color) ?? { r: 1, g: 1, b: 1, a: 1 };
        const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        grad.addColorStop(0, formatColor(withAlpha(parsed, 0.9)));
        grad.addColorStop(0.25, formatColor(withAlpha(parsed, 0.45)));
        grad.addColorStop(1, formatColor(withAlpha(parsed, 0)));
        g.fillStyle = grad;
        g.fillRect(0, 0, s, s);
      }
      return sprite;
    });
    const seedMotes = () => {
      motes = Array.from({ length: count }, () => {
        const dir = params.direction;
        const angle = dir === "rise" ? -Math.PI / 2 + (random() - 0.5) * 0.8 : dir === "fall" ? Math.PI / 2 + (random() - 0.5) * 0.8 : random() * Math.PI * 2;
        const speed = speedPx * (0.5 + random() * 0.8) * scale;
        return { x: random() * width, y: random() * height, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, r: (minR + random() * (maxR - minR)) * scale, color: Math.floor(random() * colors.length), phase: random() * Math.PI * 2 };
      });
    };
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!motes.length) seedMotes();
      draw(0);
    };
    const linkDistance = 120 * scale;
    const draw = (time: number) => {
      ctx.clearRect(0, 0, width, height);
      if (params.links) {
        ctx.lineWidth = 0.6 * scale;
        for (let i = 0; i < motes.length; i++) {
          for (let j = i + 1; j < motes.length; j++) {
            const dx = motes[i].x - motes[j].x, dy = motes[i].y - motes[j].y;
            const d = Math.hypot(dx, dy);
            if (d < linkDistance) {
              ctx.strokeStyle = colors[motes[i].color] ?? "#ffffff";
              ctx.globalAlpha = 0.25 * (1 - d / linkDistance);
              ctx.beginPath(); ctx.moveTo(motes[i].x, motes[i].y); ctx.lineTo(motes[j].x, motes[j].y); ctx.stroke();
            }
          }
        }
      }
      for (const mote of motes) {
        const flicker = 0.75 + 0.25 * Math.sin(mote.phase + time / 1400);
        ctx.globalAlpha = 0.85 * flicker;
        if (params.glow) {
          const s = mote.r * 7;
          ctx.drawImage(sprites[mote.color], mote.x - s / 2, mote.y - s / 2, s, s);
        } else {
          ctx.fillStyle = colors[mote.color] ?? "#ffffff";
          ctx.beginPath(); ctx.arc(mote.x, mote.y, mote.r, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    };
    let raf = 0;
    let last = 0;
    let running = false;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - last < 1000 / 30) return; // 30fps cap
      const dt = Math.min(0.1, (now - (last || now)) / 1000);
      last = now;
      for (const mote of motes) {
        mote.x += mote.vx * dt; mote.y += mote.vy * dt;
        if (mote.x < -10) mote.x = width + 10; else if (mote.x > width + 10) mote.x = -10;
        if (mote.y < -10) mote.y = height + 10; else if (mote.y > height + 10) mote.y = -10;
      }
      draw(now);
    };
    const start = () => { if (!running && !still) { running = true; last = 0; raf = requestAnimationFrame(frame); } };
    const stop = () => { running = false; cancelAnimationFrame(raf); };
    let resizeTimer = 0;
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => { window.clearTimeout(resizeTimer); resizeTimer = window.setTimeout(resize, 120); }) : null;
    observer?.observe(canvas);
    resize();
    if (!isThemeMotionTransientlyPaused()) start();
    const unsubscribe = subscribeThemeMotion((paused) => (paused ? stop() : start()));
    return () => { stop(); unsubscribe(); observer?.disconnect(); window.clearTimeout(resizeTimer); };
  }, [params, seed, motion, colors, scale]);
  return <canvas ref={ref} className="ct-fx-particles" />;
}

// ---- The layer -----------------------------------------------------------------

function forcedColors(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(forced-colors: active)").matches;
}

export function ThemeEffectsLayer(props: { spec: ThemeSpec | null; id?: CustomThemeId; motion: "on" | "paused" }): ReactElement | null {
  const { spec, id, motion } = props;
  const model = useMemo(() => {
    if (!spec || !id) return null;
    try { return effectLayerModel(spec, id); } catch { return null; }
  }, [spec, id]);
  if (!model || forcedColors()) return null;
  const p = model.params;
  const backVisible = model.translucency > 0 && Boolean(p.aurora || p.mesh || p.starfield || p.particles || p.grid || p.vignette);
  const frontVisible = Boolean(p.grain || p.scanlines);
  if (!backVisible && !frontVisible) return null;
  const effectiveMotion = spec?.motion.enabled === false ? "paused" : motion;
  return (
    <>
      {backVisible && (
        <div className="ct-fx-layer ct-fx-back" data-motion={effectiveMotion} data-scheme={model.scheme} aria-hidden="true">
          {p.vignette && <VignetteLayer params={p.vignette} />}
          {p.mesh && <MeshLayer params={p.mesh} scheme={model.scheme} />}
          {p.aurora && <AuroraLayer params={p.aurora} scheme={model.scheme} />}
          {p.grid && <GridLayer params={p.grid} scheme={model.scheme} />}
          {p.starfield && <StarfieldLayer params={p.starfield} seed={model.seed} />}
          {p.particles && <ParticlesCanvas params={p.particles} seed={model.seed} motion={effectiveMotion} />}
        </div>
      )}
      {frontVisible && (
        <div className="ct-fx-layer ct-fx-front" data-motion={effectiveMotion} data-scheme={model.scheme} aria-hidden="true">
          {p.grain && <GrainLayer params={p.grain} scheme={model.scheme} />}
          {p.scanlines && <ScanlinesLayer params={p.scanlines} scheme={model.scheme} />}
        </div>
      )}
    </>
  );
}

/** Softer star colour for previews (dark: text toward bg). */
export function previewStarColor(model: EffectLayerModel): string {
  return formatColor(mixColors(model.palette.text, model.palette.bg, 0.2));
}

export default ThemeEffectsLayer;
