export function effectiveZoom(element: HTMLElement): number {
  const current = (element as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom;
  if (typeof current === "number" && Number.isFinite(current) && current > 0) return current;
  let zoom = 1;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const value = getComputedStyle(node).zoom;
    const factor = value.endsWith("%") ? parseFloat(value) / 100 : parseFloat(value);
    if (Number.isFinite(factor) && factor > 0) zoom *= factor;
  }
  return zoom;
}

export const supportsTopLayer = () => typeof HTMLElement.prototype.showPopover === "function";

/** Older WKWebViews have no top layer. A body-portaled layer keeps the
 * source's live theme and scale while escaping transformed or clipped modals. */
export function adoptPortalTheme(layer: HTMLElement, source: HTMLElement): void {
  const style = getComputedStyle(source);
  for (let index = 0; index < style.length; index += 1) {
    const property = style[index];
    if (property.startsWith("--")) layer.style.setProperty(property, style.getPropertyValue(property));
  }
  for (const property of ["font-family", "font-size", "line-height", "letter-spacing", "color", "color-scheme", "direction"]) {
    layer.style.setProperty(property, style.getPropertyValue(property));
  }
  layer.style.zoom = String(effectiveZoom(source) / effectiveZoom(document.body));
}
