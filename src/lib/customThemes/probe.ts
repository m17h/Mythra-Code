// Runtime readability probe (DESIGN §4.2). After a theme is applied, sample
// the real computed text colour and the effective background on fixed
// landmarks. If something is below 4.5:1, check whether the theme's customCss
// is the cause by measuring again with that stylesheet disabled.

import { composite, contrastRatio, formatColor, parseColor, type Rgba } from "./color";

export const CUSTOM_THEME_STYLE_ID = "mythra-custom-theme";
export const CUSTOM_CSS_STYLE_ID = "mythra-custom-theme-css";

export interface ProbeFailure { landmark: string; ratio: number; fg: string; bg: string; selectorHint?: string; causedByCustomCss?: boolean }
export interface ProbeResult { ok: boolean; failures: ProbeFailure[]; /** At least one failure goes away without customCss. */ customCssCulprit: boolean; checked: number }

interface Landmark { name: string; selector: string; placeholder?: boolean; min?: number }

export const LANDMARKS: readonly Landmark[] = [
  { name: "transcript prose", selector: ".rich-markdown p" },
  { name: "transcript list", selector: ".rich-markdown li" },
  { name: "composer text", selector: ".composer textarea" },
  { name: "composer placeholder", selector: ".composer textarea", placeholder: true },
  { name: "sidebar row title", selector: ".thread-card-title" },
  { name: "sidebar row meta", selector: ".thread-card-workspace" },
  { name: "selected row title", selector: ".thread-row-wrap.active .thread-card-title" },
  { name: "top bar title", selector: ".topbar .project-heading" },
  { name: "menu item", selector: '[role="menu"] [role^="menuitem"]' },
  { name: "settings copy", selector: ".settings-pane p" },
  { name: "settings row", selector: ".set-row" },
  { name: "send button", selector: ".send-button:not(:disabled)" },
  { name: "landing title", selector: ".thread-empty-state h1" },
];

const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

function visible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

/** Colours a computed background-image may paint (gradient stops). */
function gradientStops(value: string): Rgba[] {
  if (!value || value === "none") return [];
  const out: Rgba[] = [];
  for (const match of value.matchAll(/rgba?\([^)]*\)|#[0-9a-f]{3,8}\b/gi)) {
    const color = parseColor(match[0]);
    if (color) out.push(color);
  }
  return out;
}

/** Effective backgrounds behind `el`: composite translucent layers up to the first opaque one; gradients add worst cases. */
function backgrounds(el: Element): Rgba[] {
  const layers: Rgba[][] = [];
  let node: Element | null = el;
  while (node) {
    const style = getComputedStyle(node);
    const color = parseColor(style.backgroundColor) ?? TRANSPARENT;
    const stops = gradientStops(style.backgroundImage);
    layers.push(stops.length ? stops.map((stop) => composite(stop, color)) : [color]);
    if (color.a >= 0.999 && !stops.some((stop) => stop.a < 0.999)) break;
    if (node.classList?.contains("app-shell")) break;
    node = node.parentElement;
  }
  // Fold from the bottom (outermost) layer up.
  let results: Rgba[] = [{ r: 0, g: 0, b: 0, a: 1 }];
  const outer = layers[layers.length - 1];
  if (outer.every((c) => c.a >= 0.999)) results = outer.map((c) => ({ ...c, a: 1 }));
  else results = outer.map((c) => ({ ...composite(c, { r: 0, g: 0, b: 0, a: 1 }), a: 1 }));
  for (let i = layers.length - 2; i >= 0; i--) {
    const next: Rgba[] = [];
    for (const top of layers[i]) for (const below of results) next.push({ ...composite(top, below), a: 1 });
    results = next.slice(0, 16);
  }
  return results;
}

function inkOf(el: Element, placeholder: boolean): Rgba | null {
  const style = placeholder ? getComputedStyle(el, "::placeholder") : getComputedStyle(el);
  const fill = style.getPropertyValue("-webkit-text-fill-color");
  const raw = fill && !/currentcolor/i.test(fill) ? fill : style.color;
  const color = parseColor(raw);
  if (!color) return null;
  const clip = style.getPropertyValue("-webkit-background-clip") || style.getPropertyValue("background-clip");
  if (color.a === 0 && /text/.test(clip)) return null; // gradient-clipped text (e.g. the shimmer title) is skipped
  let opacity = 1;
  for (let node: Element | null = el; node; node = node.parentElement) {
    const value = Number(getComputedStyle(node).opacity);
    if (Number.isFinite(value)) opacity *= value;
    if (node.classList?.contains("app-shell")) break;
  }
  return { ...color, a: color.a * opacity };
}

function measure(shell: HTMLElement): { failures: ProbeFailure[]; checked: number } {
  const failures: ProbeFailure[] = [];
  let checked = 0;
  for (const landmark of LANDMARKS) {
    const el = Array.from(shell.querySelectorAll(landmark.selector)).find(visible);
    if (!el) continue;
    if (landmark.placeholder && (el as HTMLTextAreaElement).value) continue;
    const ink = inkOf(el, Boolean(landmark.placeholder));
    if (!ink) continue;
    checked++;
    let worst = Infinity;
    let worstBg: Rgba | null = null;
    for (const bg of backgrounds(el)) {
      const ratio = contrastRatio(ink, bg);
      if (ratio < worst) { worst = ratio; worstBg = bg; }
    }
    const min = landmark.min ?? 4.5;
    if (worst < min && worstBg) {
      failures.push({ landmark: landmark.name, ratio: Math.round(worst * 10) / 10, fg: formatColor(ink.a < 1 ? composite(ink, worstBg) : ink), bg: formatColor(worstBg), selectorHint: landmark.selector });
    }
  }
  return { failures, checked };
}

const nextFrame = () => new Promise<void>((resolve) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => resolve()) : setTimeout(resolve, 16)));

/**
 * Measure landmark contrast on the shell. Resolves within a frame or two.
 * Failures caused by customCss are marked (they pass with it disabled).
 */
export async function probeReadability(shell: HTMLElement): Promise<ProbeResult> {
  await nextFrame();
  // Colour transitions from the previous theme are still running for a few
  // hundred ms, and computed styles report their in-between values (a dark
  // composer on a light theme). Measure the settled look: with transitions
  // off, running ones jump to their end and none start when customCss is
  // toggled below. Removing the rule afterwards changes no colour, so it
  // starts no transition either.
  const freeze = document.createElement("style");
  freeze.textContent = ".app-shell, .app-shell *, .app-shell *::before, .app-shell *::after, .app-shell *::placeholder { transition: none !important; }";
  document.head.appendChild(freeze);
  try {
    void getComputedStyle(shell).color;
    const first = measure(shell);
    if (!first.failures.length) return { ok: true, failures: [], customCssCulprit: false, checked: first.checked };
    const sheet = (document.getElementById(CUSTOM_CSS_STYLE_ID) as HTMLStyleElement | null)?.sheet ?? null;
    let culprit = false;
    if (sheet && !sheet.disabled) {
      sheet.disabled = true;
      try {
        const without = measure(shell);
        for (const failure of first.failures) {
          const still = without.failures.some((other) => other.landmark === failure.landmark);
          failure.causedByCustomCss = !still;
          if (!still) culprit = true;
        }
      } finally {
        sheet.disabled = false;
      }
    }
    return { ok: false, failures: first.failures, customCssCulprit: culprit, checked: first.checked };
  } finally {
    freeze.remove();
  }
}

/** One line per failure, for tool results: `customCss disabled: ".thread-card-title" #6a6a70 on #26272b (2.9:1)`. */
export function describeProbeFailures(failures: ProbeFailure[]): string[] {
  return failures.map((failure) => `${failure.landmark}${failure.selectorHint ? ` (${failure.selectorHint})` : ""}: ${failure.fg} on ${failure.bg} (${failure.ratio}:1)`);
}
