// Interaction states for the hidden theme preview, by selector rewriting.
//
// The preview page gets no input and its window is never focused, so
// dispatching pointer or focus events would not make :hover, :active or
// :focus-visible match. Instead every style rule on the page (the app's own
// styles and the theme's sanitized customCss alike) has its interaction
// states rewritten in place, token by token (rewriteSelectorStates):
// `:hover` becomes `:is(:hover, [data-preview-hover])`, also inside :not(),
// so `.x:not(:hover)` stops matching a control drawn as hovered. Same rule,
// same place in the cascade, same specificity, same @media/@supports.
// States after a pseudo-element (`::-webkit-scrollbar:hover`) are left as
// they are. Setting the marker on one chosen control (and, as the browser
// does for hover and press, its ancestors) then draws those CSS rules without
// sending input or calling event handlers. Nothing here runs outside the
// preview page, and customCss cannot name these attributes.

import { CONTROL_ATTRIBUTE, controlAttribute, controlTarget, type ControlTargetId, type PreviewInteraction } from "../lib/customThemes/previewScenes";
import { rewriteSelectorStates, withFixtureHitTesting } from "../lib/customThemes/inspect";

const ATTRIBUTE: Record<string, string> = {
  hover: "data-preview-hover",
  active: "data-preview-active",
  "focus-visible": "data-preview-focus-visible",
  "focus-within": "data-preview-focus-within",
  focus: "data-preview-focus",
};

function mirrored(selector: string): string {
  return rewriteSelectorStates(selector, (state, _depth, afterPseudoElement) => {
    const attribute = ATTRIBUTE[state];
    return attribute && !afterPseudoElement ? `:is(:${state}, [${attribute}])` : null;
  });
}

/** Rewrite every state selector on the page once, in place. Returns how many rules changed. */
export function mirrorInteractionRules(doc: Document = document): number {
  let count = 0;
  const visited = new Set<{ cssRules?: CSSRuleList }>();
  const walk = (parent: { cssRules?: CSSRuleList }) => {
    if (visited.has(parent)) return;
    visited.add(parent);
    let rules: CSSRuleList | undefined;
    try { rules = parent.cssRules; } catch { return; }
    if (!rules) return;
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        const before = rule.selectorText;
        const after = mirrored(before);
        if (after !== before) {
          // An engine that can't parse the rewrite keeps the original selector.
          try { rule.selectorText = after; } catch { /* kept */ }
          if (rule.selectorText !== before) count++;
        }
      }
      // Walk nested style rules and grouping rules without moving them in the cascade.
      if ("cssRules" in rule) walk(rule as CSSRule & { cssRules: CSSRuleList });
      if (typeof CSSImportRule !== "undefined" && rule instanceof CSSImportRule && rule.styleSheet) walk(rule.styleSheet);
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) walk(sheet);
  for (const sheet of doc.adoptedStyleSheets ?? []) walk(sheet);
  return count;
}

const COMPARED = [
  "background-color", "background-image", "color", "box-shadow", "text-shadow", "border-radius",
  "border-top", "border-right", "border-bottom", "border-left", "outline-style", "outline-color", "outline-width",
  "outline-offset", "transform", "scale", "filter", "text-decoration-color", "text-decoration-style",
] as const;

interface Box { x: number; y: number; width: number; height: number }
type Visibility = { visible: true; clippedBox?: Box } | { visible: false; why: string };

/** Approximate visibility from geometry and actual hit tests. The caller lifts only the fixture shell's inert flag. */
function visibility(element: Element, hitTarget: Element = element): Visibility {
  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return { visible: false, why: "it has no size here" };
  const style = getComputedStyle(element);
  if (style.visibility !== "visible" || hitTarget.closest("[inert], [hidden]")) return { visible: false, why: "it is in a hidden or covered part of the window" };
  let left = Math.max(rect.left, 0), right = Math.min(rect.right, window.innerWidth);
  let top = Math.max(rect.top, 0), bottom = Math.min(rect.bottom, window.innerHeight);
  let opacity = 1;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const ancestorStyle = node === element ? style : getComputedStyle(node);
    const alpha = parseFloat(ancestorStyle.opacity);
    if (Number.isFinite(alpha)) opacity *= alpha;
    if (node === element || (ancestorStyle.overflowX === "visible" && ancestorStyle.overflowY === "visible")) continue;
    const clip = node.getBoundingClientRect();
    if (ancestorStyle.overflowX !== "visible") {
      left = Math.max(left, clip.left);
      right = Math.min(right, clip.right);
    }
    if (ancestorStyle.overflowY !== "visible") {
      top = Math.max(top, clip.top);
      bottom = Math.min(bottom, clip.bottom);
    }
  }
  if (opacity < 0.05) return { visible: false, why: "it is nearly transparent here" };
  const width = Math.max(0, right - left), height = Math.max(0, bottom - top);
  const shownArea = width * height;
  if (shownArea < rect.width * rect.height * 0.5) return { visible: false, why: "most of it is scrolled, clipped or pushed out of view at this window size" };
  const fractions = [0.2, 0.5, 0.8];
  let hits = 0;
  for (const x of fractions) for (const y of fractions) {
    const hit = document.elementFromPoint(left + x * width, top + y * height);
    if (hit && hitTarget.contains(hit)) hits++;
  }
  if (shownArea * hits / 9 < rect.width * rect.height * 0.5) {
    return { visible: false, why: "most of it is clipped or covered at this window size" };
  }
  const clipped = width < rect.width || height < rect.height;
  return { visible: true, ...(clipped ? { clippedBox: roundedBox(left, top, width, height) } : {}) };
}

function describe(element: HTMLElement) {
  const label = (element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
  return {
    ...(label ? { label } : {}),
    classes: Array.from(element.classList).slice(0, 4),
    motionOptIn: element.hasAttribute(CONTROL_ATTRIBUTE),
  };
}

/** The search root: the open overlay when the scene has one, else the window. */
function rootFor(shell: HTMLElement, overlay: boolean): HTMLElement | undefined {
  if (!overlay) return shell;
  const layers = Array.from(shell.querySelectorAll<HTMLElement>(".modal-backdrop")).filter((layer) => layer.getAttribute("aria-hidden") !== "true");
  return layers[layers.length - 1];
}

function pickControl(shell: HTMLElement, control: ControlTargetId, state: PreviewInteraction, overlay: boolean): { element: HTMLElement } | { why: string } {
  const target = controlTarget(control)!;
  const root = rootFor(shell, overlay);
  if (!root) return { why: "The requested scene's dialog did not open." };
  const optedIn = Array.from(root.querySelectorAll<HTMLElement>(controlAttribute(control)));
  const all = optedIn.length ? optedIn : Array.from(root.querySelectorAll<HTMLElement>(target.selector));
  if (!all.length) return { why: `${target.label} (${target.selector}) is not in this scene${overlay ? "'s open dialog" : ""}.` };
  const seen = all
    .filter((element) => !element.closest("[aria-hidden='true']"))
    .map((element) => ({ element, view: visibility(element) }));
  const shown = seen.filter((entry) => entry.view.visible).map((entry) => entry.element);
  if (!shown.length) {
    const view = seen[0]?.view;
    const why = view && !view.visible ? view.why : "it is in a hidden part of the window";
    return { why: `${target.label} cannot be shown here because ${why}.` };
  }
  const enabled = shown.filter((element) => !element.matches(":disabled, [aria-disabled='true']"));
  const selected = (element: HTMLElement) => element.matches(".active, [aria-selected='true'], [aria-pressed='true']");
  // Keyboard focus lands on a roving tab stop (the selected tab); hover and
  // press show most clearly on a resting, unselected control.
  if (state === "focus") {
    const element = enabled.find((candidate) => candidate.tabIndex >= 0);
    return element ? { element } : { why: `No visible, enabled ${target.label} is a keyboard tab stop here.` };
  }
  if (state === "press" && !enabled.length) return { why: `${target.label} is disabled in this scene.` };
  return { element: enabled.find((element) => !selected(element)) ?? enabled[0] ?? shown[0] };
}

function lineage(element: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let node: HTMLElement | null = element; node; node = node.parentElement) out.push(node);
  return out;
}

function roundedBox(x: number, y: number, width: number, height: number): Box {
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function boxOf(element: Element): Box {
  const rect = element.getBoundingClientRect();
  return roundedBox(rect.x, rect.y, rect.width, rect.height);
}

function styleExcerpt(value: string): string {
  return value.length > 512 ? `${value.slice(0, 512)}…` : value;
}

export interface InteractionFacts {
  control: ControlTargetId;
  label: string;
  selector: string;
  state: PreviewInteraction;
  drawn: boolean;
  how: string;
  /** The element actually drawn (several share some classes). */
  actual?: ReturnType<typeof describe>;
  /** Control bounds at rest and, when a state is applied, at capture time. */
  box?: Box;
  stateBox?: Box;
  disabled?: boolean;
  /** Computed values that differ between rest and this state. */
  changed?: Record<string, { rest: string; state: string }>;
  transition?: { property: string; duration: string };
  focusIndicator?: { outline: string; outlineOffset: string; boxShadow: string };
  why?: string;
}

/**
 * Draw one control in `state`. `settle` runs after the markers are set (it
 * should stop transitions and animations at their end), before the state is
 * read. `overlay`: the scene has an open dialog the control must be in.
 */
export function applyInteraction(shell: HTMLElement, control: ControlTargetId, state: PreviewInteraction, settle: () => void, overlay = false): InteractionFacts {
  const target = controlTarget(control)!;
  const base = { control, label: target.label, selector: target.selector, state };
  const picked = withFixtureHitTesting(shell, () => pickControl(shell, control, state, overlay));
  if (!("element" in picked)) return { ...base, drawn: false, how: "not drawn", why: picked.why };
  const element = picked.element;
  const box = boxOf(element);
  const actual = describe(element);
  const disabled = element.matches(":disabled, [aria-disabled='true']");
  const read = () => {
    const style = getComputedStyle(element);
    return Object.fromEntries(COMPARED.map((name) => [name, style.getPropertyValue(name)])) as Record<(typeof COMPARED)[number], string>;
  };
  const rest = read();
  if (state === "rest") return { ...base, drawn: true, how: "at rest (no state applied)", actual, box, ...(disabled ? { disabled } : {}) };
  const chain = lineage(element);
  const mark = (nodes: HTMLElement[], name: string) => { for (const node of nodes) node.setAttribute(name, ""); };
  if (state === "hover" || state === "press") mark(chain, ATTRIBUTE.hover);
  if (state === "press") {
    document.documentElement.setAttribute("data-input-modality", "pointer");
    mark(chain, ATTRIBUTE.active);
  }
  if (state === "focus") {
    // Keyboard modality, as after a Tab press (useInputModality).
    document.documentElement.setAttribute("data-input-modality", "keyboard");
    mark([element], ATTRIBUTE.focus);
    mark([element], ATTRIBUTE["focus-visible"]);
    mark(chain, ATTRIBUTE["focus-within"]);
  }
  getComputedStyle(element).getPropertyValue("color"); // start any transitions now, so settle can end them
  settle();
  const after = read();
  const changed = Object.fromEntries(COMPARED.filter((name) => rest[name] !== after[name])
    .map((name) => [name, { rest: styleExcerpt(rest[name]), state: styleExcerpt(after[name]) }]));
  const style = getComputedStyle(element);
  const view = withFixtureHitTesting(shell, () => visibility(element));
  const how = state === "hover" ? "with mirrored CSS hover on it and its ancestors"
    : state === "press" ? "with mirrored CSS hover and active on it and its ancestors"
      : "with mirrored CSS keyboard focus on it and focus-within on it and its ancestors";
  const focusIndicator = state === "focus" ? {
    outline: `${after["outline-width"]} ${after["outline-style"]} ${after["outline-color"]}`,
    outlineOffset: after["outline-offset"],
    boxShadow: styleExcerpt(after["box-shadow"]),
  } : undefined;
  const why = !view.visible ? `${target.label} has this state applied, but ${view.why}.`
    : disabled ? "This control is disabled in this scene, so rules guarded by :not(:disabled) do not apply." : undefined;
  return {
    ...base, drawn: view.visible, how, actual, box, stateBox: boxOf(element), changed,
    transition: { property: style.transitionProperty, duration: style.transitionDuration },
    ...(focusIndicator ? { focusIndicator } : {}),
    ...(disabled ? { disabled } : {}),
    ...(why ? { why } : {}),
  };
}

export interface LandmarkFact { name: string; selector: string; box: Box; clippedBox?: Box; drawn: boolean; state?: string; colors?: Record<string, string>; why?: string }

function logoColors(svg: Element): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const piece of ["cyan", "blue", "fold"]) for (const stop of ["A", "B"]) {
    const node = svg.querySelector(`.mythra-mark-stop--${piece}-${stop.toLowerCase()}`);
    if (node) colors[`mark.${piece}${stop}`] = getComputedStyle(node).getPropertyValue("stop-color");
  }
  const caret = svg.querySelector(".mythra-logo__cursor");
  if (caret) colors["mark.caret"] = getComputedStyle(caret).getPropertyValue("fill");
  return colors;
}

/** The landings' marks, measured on their visible square rather than the padded wrapper. */
export function measureLandmarks(shell: HTMLElement): LandmarkFact[] {
  const marks = [
    { name: "Animated Mythra logo SVG square", selector: ".thread-empty-state .mythra-logo__svg", colors: true },
    { name: "Logo button around it (hover and click target)", selector: ".thread-empty-state .mythra-logo__button" },
    { name: "Welcome screen mark", selector: ".welcome-screen .welcome-orbit" },
  ];
  return withFixtureHitTesting(shell, () => {
    const out: LandmarkFact[] = [];
    for (const { name, selector, colors } of marks) {
      const element = shell.querySelector(selector);
      if (!element) continue;
      const button = element.closest(".mythra-logo__button");
      // SVG paths leave gaps within the square. Hit-test against their button,
      // but measure the SVG's own box and gradients.
      const view = visibility(element, button ?? element);
      const state = button ? (button.hasAttribute("data-idle") ? "idle (assembled, idle effects frozen at one moment)" : "assembled and still") : undefined;
      const visibilityFacts = view.visible ? { clippedBox: view.clippedBox } : { why: view.why };
      out.push({
        name, selector, drawn: view.visible, box: boxOf(element),
        ...(colors ? { colors: logoColors(element) } : {}),
        ...(state ? { state } : {}),
        ...visibilityFacts,
      });
    }
    return out;
  });
}
