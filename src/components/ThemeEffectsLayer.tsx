// The custom theme's effects layers (DESIGN §5). Two absolutely positioned,
// pointer-transparent layers inside the shell (the shell becomes an isolated
// stacking context in compile.ts). Effects with area "chat" or "sidebar" sit
// in a box that follows the main panel or the left navigator, so they never
// paint the other region or the Tools panel:
//   .ct-fx-back   z-index -1: aurora, mesh, starfield, particles, grid, vignette.
//                 Visible only through the see-through window background and
//                 sidebar; panels, menus, fields and code stay solid.
//   .ct-fx-front  above the panes, below popovers: grain and scanlines.
// Motion: only transform and opacity on the layers' own nodes; every
// animation is gated by data-motion="on" on the layer and by
// prefers-reduced-motion in custom-themes.css; transient pauses use the Web
// Animations API (motion.ts). Colours come in as inline custom properties on
// these few nodes, never on the shell.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { useMediaQueryMatch } from "../hooks/useMediaQueryMatch";
import { formatColor, mixColors, parseColor, seededRandom, withAlpha, type Rgba } from "../lib/customThemes/color";
import { PARTICLE_ANGLE, PARTICLE_DEFAULT_COUNT, PARTICLE_LIMITS, PARTICLE_SPEED_PX, blobOpacity, effectArea, effectSeconds, grainOpacity, resolveEffectParams, scanlineOpacity, starLayers, vignetteAlpha, type EffectPalette, type ResolvedParams } from "../lib/customThemes/effects";
import { isThemeMotionTransientlyPaused, subscribeThemeMotion } from "../lib/customThemes/motion";
import { builtInScheme, type CustomThemeId, type EffectArea, type EffectType, type ParticleShape, type Speed, type ThemeSpec } from "../lib/customThemes/spec";
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

export async function preparePreviewGrain(spec: ThemeSpec | null): Promise<string> {
  if (!spec?.effects.grain || window.matchMedia("(forced-colors: active)").matches) return "";
  const url = await grainTile(builtInScheme(spec.base));
  if (!url) throw new Error("the grain texture could not be drawn");
  const image = new Image();
  image.src = url;
  await image.decode();
  return url;
}

export function GrainLayer({ params, scheme, preparedUrl }: { params: ResolvedParams; scheme: "light" | "dark"; preparedUrl?: string }) {
  const [loadedUrl, setUrl] = useState("");
  useEffect(() => {
    if (preparedUrl !== undefined) return;
    let live = true;
    void grainTile(scheme).then((value) => { if (live) setUrl(value); });
    return () => { live = false; };
  }, [scheme, preparedUrl]);
  const url = preparedUrl ?? loadedUrl;
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

interface Mote { x: number; y: number; vx: number; vy: number; r: number; color: number; phase: number; depth: number; rot: number; spin: number }

/** Streak depth layers (far, mid, near): speed, length and alpha scale with depth; drawn as one path per colour and layer. */
const STREAK_DEPTHS = [0.55, 0.78, 1] as const;
const PARTICLE_FRAME_MS = 1000 / 30;
const SHAPES: readonly ParticleShape[] = ["dot", "streak", "flake", "petal"];

function softSprite(color: string, stops: Array<[number, number]>): HTMLCanvasElement {
  const sprite = document.createElement("canvas");
  const s = 32;
  sprite.width = s; sprite.height = s;
  const g = sprite.getContext("2d");
  if (g) {
    const parsed = parseColor(color) ?? { r: 1, g: 1, b: 1, a: 1 };
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    for (const [at, alpha] of stops) grad.addColorStop(at, formatColor(withAlpha(parsed, alpha)));
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  }
  return sprite;
}

export function ParticlesCanvas({ params, seed, motion, scale = 1, pixelRatio, stillAtMs }: { params: ResolvedParams; seed: string; motion: "on" | "paused"; scale?: number; /** Backing-store pixels per CSS pixel (a scaled-down preview passes its own, so a still card keeps a small canvas). */ pixelRatio?: number; stillAtMs?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const colors = useMemo(() => colorsOf(params.colors).map((c) => formatColor(c)), [params.colors]);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const shell = canvas.closest(".app-shell");
    const liveShell = shell?.hasAttribute("data-ct-replica") ? null : shell;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const still = params.speed === "still" || motion !== "on" || reduced;
    const dpr = pixelRatio && pixelRatio > 0 ? Math.min(1.5, pixelRatio) : Math.min(1.5, window.devicePixelRatio || 1);
    let random = seededRandom(`particles:${seed}`);
    const shape: ParticleShape = SHAPES.includes(params.shape as ParticleShape) ? params.shape as ParticleShape : "dot";
    const links = shape === "dot" && params.links === true;
    const cap = shape === "streak" ? PARTICLE_LIMITS.maxStreaks : links ? PARTICLE_LIMITS.maxWithLinks : PARTICLE_LIMITS.max;
    const count = Math.min(cap, Number(params.count) || PARTICLE_DEFAULT_COUNT[shape]);
    const [minR, maxR] = (params.size as [number, number]) ?? [1, 2.5];
    const speedPx = PARTICLE_SPEED_PX[shape][(params.speed as Speed) ?? "slow"] ?? PARTICLE_SPEED_PX[shape].slow;
    const tilt = Math.max(PARTICLE_ANGLE.min, Math.min(PARTICLE_ANGLE.max, Number(params.angle) || 0)) * Math.PI / 180;
    // Rain is near-parallel; snow and petals wander more.
    const jitter = shape === "streak" ? 0.04 : shape === "dot" ? 0.8 : 0.5;
    let width = 0, height = 0;
    let motes: Mote[] = [];
    const sprites = colors.map((color) => shape === "flake"
      ? softSprite(color, [[0, 0.95], [0.35, 0.7], [0.7, 0.18], [1, 0]])
      : softSprite(color, [[0, 0.9], [0.25, 0.45], [1, 0]]));
    const motionAngle = (): number => {
      const dir = params.direction;
      // Screen angles: +y is down, so "fall" is +90°. A positive tilt leans the path to the right.
      if (dir === "fall") return Math.PI / 2 - tilt + (random() - 0.5) * jitter;
      if (dir === "rise") return -Math.PI / 2 + tilt + (random() - 0.5) * jitter;
      return random() * Math.PI * 2;
    };
    const spawn = (mote: Mote | null, anywhere: boolean): Mote => {
      const depth = shape === "streak" ? STREAK_DEPTHS[Math.floor(random() * STREAK_DEPTHS.length)] : 0.6 + random() * 0.4;
      const angle = motionAngle();
      const speed = speedPx * (shape === "streak" ? depth * (0.9 + random() * 0.2) : 0.5 + random() * 0.8) * scale;
      const next: Mote = mote ?? { x: 0, y: 0, vx: 0, vy: 0, r: 0, color: 0, phase: 0, depth: 1, rot: 0, spin: 0 };
      next.vx = Math.cos(angle) * speed; next.vy = Math.sin(angle) * speed;
      next.r = (minR + random() * (maxR - minR)) * scale;
      next.color = Math.floor(random() * colors.length);
      next.phase = random() * Math.PI * 2;
      next.depth = depth;
      next.rot = random() * Math.PI * 2;
      next.spin = (random() < 0.5 ? -1 : 1) * (0.5 + random() * 1.2);
      // A slant carries particles sideways, so spawn across a wider band to keep both edges filled.
      const spread = params.direction === "drift" ? 0 : Math.abs(Math.tan(tilt)) * height;
      const upwind = tilt > 0 ? -spread : 0; // positive tilt moves right for both rise and fall
      next.x = upwind + random() * (width + spread);
      next.y = anywhere ? random() * height : params.direction === "rise" ? height + 12 + random() * 40 : -12 - random() * 40;
      return next;
    };
    const seedMotes = () => { motes = Array.from({ length: count }, () => spawn(null, true)); };
    const resize = () => {
      const nextWidth = Math.max(1, canvas.clientWidth || canvas.getBoundingClientRect().width);
      const nextHeight = Math.max(1, canvas.clientHeight || canvas.getBoundingClientRect().height);
      if (stillAtMs !== undefined && motes.length && width === nextWidth && height === nextHeight) return;
      // Seeded into an empty box (an area box mounts before it is measured): seed again at the real size.
      const wasEmpty = width <= 1 || height <= 1;
      if (stillAtMs === undefined && motes.length && !wasEmpty && (Math.abs(nextWidth - width) > 1 || Math.abs(nextHeight - height) > 1)) {
        // Keep the scene, rescaled into the new box (no reseed pop on a sidebar drag).
        const sx = nextWidth / width, sy = nextHeight / height;
        for (const mote of motes) { mote.x *= sx; mote.y *= sy; }
      }
      width = nextWidth;
      height = nextHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // A snapshot is seeded against the final geometry. A resize during
      // layout draws the same moment at the new size.
      if (stillAtMs !== undefined) {
        random = seededRandom(`particles:${seed}`);
        seedMotes();
        const time = still ? 0 : stillAtMs;
        const frames = Math.ceil(time / PARTICLE_FRAME_MS);
        for (let index = 1; index <= frames; index++) advance(index * time / frames, time / frames / 1000);
        draw(time);
        return;
      }
      if (!motes.length || (wasEmpty && width > 1 && height > 1)) seedMotes();
      draw(0);
    };
    const linkDistance = 120 * scale;
    const drawDots = (time: number) => {
      if (links) {
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
    };
    const drawStreaks = () => {
      // One stroke per colour and depth layer: 160 streaks cost at most 9 draw calls.
      ctx.lineCap = "round";
      for (let c = 0; c < colors.length; c++) {
        for (const depth of STREAK_DEPTHS) {
          let thickness = 0, n = 0;
          ctx.beginPath();
          for (const mote of motes) {
            if (mote.color !== c || mote.depth !== depth) continue;
            const speed = Math.hypot(mote.vx, mote.vy) || 1;
            const length = Math.max(8, Math.min(48, speed * 0.05)) * depth;
            ctx.moveTo(mote.x, mote.y);
            ctx.lineTo(mote.x - (mote.vx / speed) * length, mote.y - (mote.vy / speed) * length);
            thickness += mote.r; n++;
          }
          if (!n) continue;
          ctx.strokeStyle = colors[c];
          ctx.lineWidth = Math.max(0.6, (thickness / n) * 0.5 * depth);
          ctx.globalAlpha = 0.22 + 0.5 * depth;
          ctx.stroke();
        }
      }
    };
    const drawFlakes = () => {
      for (const mote of motes) {
        const s = mote.r * 3.4 * mote.depth;
        ctx.globalAlpha = 0.45 + 0.5 * mote.depth;
        ctx.drawImage(sprites[mote.color], mote.x - s / 2, mote.y - s / 2, s, s);
      }
    };
    const drawPetals = (time: number) => {
      for (const mote of motes) {
        const length = mote.r * 3 * mote.depth;
        const flutter = 0.3 + 0.7 * Math.abs(Math.cos(mote.phase + time / 900));
        const cos = Math.cos(mote.rot), sin = Math.sin(mote.rot);
        // Rotate, then squash across the petal to fake a tumble in 3D.
        ctx.setTransform(dpr * cos, dpr * sin, -dpr * sin * flutter, dpr * cos * flutter, dpr * mote.x, dpr * mote.y);
        ctx.globalAlpha = 0.55 + 0.4 * mote.depth;
        ctx.fillStyle = colors[mote.color] ?? "#ffffff";
        ctx.beginPath();
        ctx.moveTo(-length, 0);
        ctx.quadraticCurveTo(-length * 0.1, -length * 0.62, length, 0);
        ctx.quadraticCurveTo(-length * 0.1, length * 0.62, -length, 0);
        ctx.fill();
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const draw = (time: number) => {
      ctx.clearRect(0, 0, width, height);
      if (shape === "streak") drawStreaks();
      else if (shape === "flake") drawFlakes();
      else if (shape === "petal") drawPetals(time);
      else drawDots(time);
      ctx.globalAlpha = 1;
    };
    let raf = 0;
    let last = 0;
    let running = false;
    const sway = shape === "flake" ? 14 : shape === "petal" ? 22 : 0;
    const margin = shape === "streak" ? 60 : 14;
    const advance = (now: number, dt: number) => {
      for (const mote of motes) {
        mote.x += mote.vx * dt; mote.y += mote.vy * dt;
        if (sway) { mote.x += Math.sin(mote.phase + now / 1300) * sway * mote.depth * scale * dt; mote.rot += mote.spin * dt; }
        if (shape === "dot" || params.direction === "drift") {
          const m = shape === "dot" ? 10 : margin;
          if (mote.x < -m) mote.x = width + m; else if (mote.x > width + m) mote.x = -m;
          if (mote.y < -m) mote.y = height + m; else if (mote.y > height + m) mote.y = -m;
        } else if (mote.y > height + margin || mote.y < -margin - 60 || mote.x < -width * 0.6 || mote.x > width * 1.6) {
          // Off the box: start again above (or below, for rise) at a fresh place, so rain never repeats a pattern.
          spawn(mote, false);
        }
      }
    };
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - last < PARTICLE_FRAME_MS) return;
      const dt = Math.min(0.1, (now - (last || now)) / 1000);
      last = now;
      advance(now, dt);
      draw(now);
    };
    const start = () => { if (!running && !still && stillAtMs === undefined) { running = true; last = 0; raf = requestAnimationFrame(frame); } };
    const stop = () => { running = false; cancelAnimationFrame(raf); };
    let resizeTimer = 0;
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
      if (stillAtMs !== undefined) resize();
      else { window.clearTimeout(resizeTimer); resizeTimer = window.setTimeout(resize, 120); }
    }) : null;
    observer?.observe(canvas);
    resize();
    const syncRunning = () => {
      if (isThemeMotionTransientlyPaused() || liveShell?.hasAttribute("data-ct-library-open")) stop();
      else start();
    };
    const modalObserver = !still && liveShell && typeof MutationObserver === "function" ? new MutationObserver(syncRunning) : null;
    if (liveShell) modalObserver?.observe(liveShell, { attributes: true, attributeFilter: ["data-ct-library-open"] });
    const unsubscribe = subscribeThemeMotion(syncRunning);
    syncRunning();
    return () => { stop(); unsubscribe(); observer?.disconnect(); modalObserver?.disconnect(); window.clearTimeout(resizeTimer); };
  }, [params, seed, motion, colors, scale, pixelRatio, stillAtMs]);
  return <canvas ref={ref} className="ct-fx-particles" />;
}

// ---- Areas ---------------------------------------------------------------------

type PaneArea = Exclude<EffectArea, "window">;
/** The shell child each pane area follows. */
const AREA_TARGET: Record<PaneArea, string> = { chat: ".main-panel", sidebar: ".sidebar" };

/**
 * A box that tracks the main panel ("chat") or the left navigator ("sidebar")
 * inside the shell and clips its effects to that region. Geometry is written
 * straight to the node (no React render), so a sidebar drag stays cheap.
 * Until it has measured, the box is empty: nothing flashes over the window.
 */
export function EffectAreaBox({ area, children }: { area: PaneArea; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = ref.current;
    const shell = node?.closest<HTMLElement>(".app-shell");
    if (!node || !shell) return;
    const find = () => Array.from(shell.children).find((child): child is HTMLElement => child instanceof HTMLElement && child.matches(AREA_TARGET[area])) ?? null;
    let target: HTMLElement | null = null;
    let frame = 0;
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => schedule()) : null;
    const measure = () => {
      frame = 0;
      const next = find();
      if (next !== target) { if (target) observer?.unobserve(target); target = next; if (target) observer?.observe(target); }
      if (!target) { node.style.width = "0px"; node.style.height = "0px"; return; }
      const s = shell.getBoundingClientRect();
      const r = target.getBoundingClientRect();
      // getBoundingClientRect is in zoomed pixels; the box is laid out in the shell's own CSS pixels.
      const k = shell.offsetWidth > 0 && s.width > 0 ? s.width / shell.offsetWidth : 1;
      node.style.left = `${Math.round((r.left - s.left) / k)}px`;
      node.style.top = `${Math.round((r.top - s.top) / k)}px`;
      node.style.width = `${Math.max(0, Math.round(r.width / k))}px`;
      node.style.height = `${Math.max(0, Math.round(r.height / k))}px`;
    };
    function schedule() { if (!frame) frame = requestAnimationFrame(measure); }
    measure();
    observer?.observe(shell);
    // Panes open, close, peek and move (the sidebar slides; the Tools panel opens beside the main panel).
    const mutations = typeof MutationObserver === "function" ? new MutationObserver(schedule) : null;
    mutations?.observe(shell, { childList: true, subtree: false });
    for (const child of Array.from(shell.children)) if (child instanceof HTMLElement && (child.matches(".sidebar") || child.matches(".studio-dock"))) {
      observer?.observe(child);
      mutations?.observe(child, { attributes: true, attributeFilter: ["class", "style"] });
    }
    const onTransition = (event: Event) => { const t = event.target; if (t instanceof HTMLElement && t.parentElement === shell) schedule(); };
    shell.addEventListener("transitionend", onTransition);
    window.addEventListener("resize", schedule);
    return () => {
      observer?.disconnect(); mutations?.disconnect();
      shell.removeEventListener("transitionend", onTransition);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [area]);
  return <div ref={ref} className="ct-fx-area" data-area={area}>{children}</div>;
}

/** Group a layer's effect nodes by area. Window effects stay direct children of the layer, exactly as before. */
function byArea(nodes: Array<[EffectArea, ReactNode]>): ReactNode[] {
  const out: ReactNode[] = [];
  const groups: Partial<Record<PaneArea, ReactNode[]>> = {};
  for (const [where, node] of nodes) {
    if (!node) continue;
    if (where === "window") out.push(node);
    else (groups[where] ??= []).push(node);
  }
  for (const where of ["chat", "sidebar"] as const) {
    const list = groups[where];
    if (list?.length) out.push(<EffectAreaBox key={`area-${where}`} area={where}>{list}</EffectAreaBox>);
  }
  return out;
}

// ---- The layer -----------------------------------------------------------------

export function ThemeEffectsLayer(props: { spec: ThemeSpec | null; id?: CustomThemeId; motion: "on" | "paused"; /** Particle canvas resolution override (theme previews). */ pixelRatio?: number; snapshot?: { time: number; grainUrl: string } }): ReactElement | null {
  const { spec, id, motion, pixelRatio, snapshot } = props;
  const forcedColors = useMediaQueryMatch("(forced-colors: active)");
  const model = useMemo(() => {
    if (!spec || !id) return null;
    try { return effectLayerModel(spec, id); } catch { return null; }
  }, [spec, id]);
  if (!model || forcedColors) return null;
  const p = model.params;
  const backVisible = model.translucency > 0 && Boolean(p.aurora || p.mesh || p.starfield || p.particles || p.grid || p.vignette);
  const frontVisible = Boolean(p.grain || p.scanlines);
  if (!backVisible && !frontVisible) return null;
  const effectiveMotion = spec?.motion.enabled === false ? "paused" : motion;
  return (
    <>
      {backVisible && (
        <div className="ct-fx-layer ct-fx-back" data-motion={effectiveMotion} data-scheme={model.scheme} aria-hidden="true">
          {byArea([
            [effectArea(p.vignette), p.vignette && <VignetteLayer key="vignette" params={p.vignette} />],
            [effectArea(p.mesh), p.mesh && <MeshLayer key="mesh" params={p.mesh} scheme={model.scheme} />],
            [effectArea(p.aurora), p.aurora && <AuroraLayer key="aurora" params={p.aurora} scheme={model.scheme} />],
            [effectArea(p.grid), p.grid && <GridLayer key="grid" params={p.grid} scheme={model.scheme} />],
            [effectArea(p.starfield), p.starfield && <StarfieldLayer key="starfield" params={p.starfield} seed={model.seed} />],
            [effectArea(p.particles), p.particles && <ParticlesCanvas key="particles" params={p.particles} seed={model.seed} motion={effectiveMotion} pixelRatio={pixelRatio} stillAtMs={snapshot?.time} />],
          ])}
        </div>
      )}
      {frontVisible && (
        <div className="ct-fx-layer ct-fx-front" data-motion={effectiveMotion} data-scheme={model.scheme} aria-hidden="true">
          {byArea([
            [effectArea(p.grain), p.grain && <GrainLayer key="grain" params={p.grain} scheme={model.scheme} preparedUrl={snapshot?.grainUrl} />],
            [effectArea(p.scanlines), p.scanlines && <ScanlinesLayer key="scanlines" params={p.scanlines} scheme={model.scheme} />],
          ])}
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
