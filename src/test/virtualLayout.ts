/**
 * A deterministic layout engine for jsdom.
 *
 * react-virtuoso only does anything when the DOM reports real geometry, which
 * jsdom never does: every box is 0×0, `offsetParent` is always null, and
 * `scrollTo` throws. That makes the one part of the timeline worth regression
 * testing — how the component and the virtualizer share control of
 * `scrollTop` — untestable by default.
 *
 * This installs a fake layout: item heights come from a caller-supplied
 * function keyed on the item index, the scroller reports a fixed viewport, and
 * scroll offsets are stored per element and clamped exactly as a browser
 * clamps them. Scroll events are queued rather than dispatched from the
 * setter, matching the browser's "fire before the next paint" timing, so a
 * scroll correction issued during a frame is observed on the next one.
 */

export type VirtualLayoutOptions = {
  viewportHeight: number;
  viewportWidth?: number;
  itemHeight: (index: number) => number;
  headerHeight?: number;
  footerHeight?: number;
};

type Installed = {
  frame: () => void;
  scroller: () => HTMLElement | null;
  scrollTop: () => number;
  uninstall: () => void;
};

const SCROLL_OFFSETS = new WeakMap<Element, number>();

function scrollerOf(node: Element): HTMLElement | null {
  return node.ownerDocument.querySelector<HTMLElement>("[data-virtuoso-scroller]");
}

function isScroller(node: Element): boolean {
  return node instanceof HTMLElement && node.dataset.virtuosoScroller !== undefined;
}

function isItemList(node: Element): boolean {
  return node instanceof HTMLElement && node.dataset.testid === "virtuoso-item-list";
}

function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function installVirtualLayout(options: VirtualLayoutOptions): Installed {
  const {
    viewportHeight,
    viewportWidth = 800,
    itemHeight,
    headerHeight = 0,
    footerHeight = 0,
  } = options;

  const pendingScrollEvents = new Set<Element>();

  const heightOf = (node: Element): number => {
    if (!(node instanceof HTMLElement)) return 0;
    if (isScroller(node)) return viewportHeight;
    if (node.dataset.viewportType !== undefined) return viewportHeight;
    if (node.dataset.index !== undefined) return itemHeight(Number(node.dataset.index));
    if (isItemList(node)) {
      let total = pixels(node.style.paddingTop) + pixels(node.style.paddingBottom);
      for (const child of Array.from(node.children)) total += heightOf(child);
      return total;
    }
    if (node.querySelector(".timeline-top-space")) return headerHeight;
    if (node.querySelector(".timeline-bottom-space")) return footerHeight;
    let total = 0;
    for (const child of Array.from(node.children)) total += heightOf(child);
    return total;
  };

  const contentHeightOf = (node: Element): number => {
    if (!isScroller(node)) return heightOf(node);
    let total = 0;
    const viewport = node.firstElementChild;
    for (const child of Array.from(viewport?.children ?? [])) total += heightOf(child);
    return total;
  };

  const maxScrollOf = (node: Element): number => Math.max(0, contentHeightOf(node) - viewportHeight);

  /** Offset of a node from the top of the scroller's content box. */
  const contentOffsetOf = (node: Element): number => {
    let offset = 0;
    let current: Element | null = node;
    while (current && !isScroller(current)) {
      const parent: HTMLElement | null = current.parentElement;
      if (!parent) break;
      if (current instanceof HTMLElement) offset += pixels(current.style.marginTop);
      // The viewport is absolutely positioned at the scroller's origin, so it
      // contributes no offset of its own; everything below it stacks normally.
      if (parent.dataset.viewportType === undefined) offset += pixels(parent.style.paddingTop);
      for (const sibling of Array.from(parent.children)) {
        if (sibling === current) break;
        offset += heightOf(sibling);
      }
      current = parent;
    }
    return offset;
  };

  const screenTopOf = (node: Element): number => {
    if (isScroller(node)) return 0;
    const scroller = scrollerOf(node);
    if (!scroller || !scroller.contains(node)) return 0;
    return contentOffsetOf(node) - (SCROLL_OFFSETS.get(scroller) ?? 0);
  };

  const setScrollTop = (node: Element, value: number) => {
    const clamped = Math.max(0, Math.min(maxScrollOf(node), Math.round(value)));
    if ((SCROLL_OFFSETS.get(node) ?? 0) === clamped) return;
    SCROLL_OFFSETS.set(node, clamped);
    pendingScrollEvents.add(node);
  };

  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const originals = {
    getBoundingClientRect: Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect"),
    offsetParent: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent"),
    offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
    scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight"),
    scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop"),
    scrollTo: proto.scrollTo,
    scrollBy: proto.scrollBy,
    getComputedStyle: window.getComputedStyle,
  };

  Object.defineProperty(Element.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Element) {
      const height = heightOf(this);
      const top = screenTopOf(this);
      return {
        bottom: top + height,
        height,
        left: 0,
        right: viewportWidth,
        toJSON: () => ({}),
        top,
        width: viewportWidth,
        x: 0,
        y: top,
      } as DOMRect;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get(this: HTMLElement) {
      return this.isConnected ? this.ownerDocument.body : null;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return heightOf(this);
    },
  });
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get(this: Element) {
      return contentHeightOf(this);
    },
  });
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) {
      return SCROLL_OFFSETS.get(this) ?? 0;
    },
    set(this: Element, value: number) {
      setScrollTop(this, value);
    },
  });
  proto.scrollTo = function scrollTo(this: HTMLElement, arg?: number | ScrollToOptions, y?: number) {
    if (typeof arg === "number") setScrollTop(this, y ?? 0);
    else if (arg?.top !== undefined) setScrollTop(this, arg.top);
  };
  proto.scrollBy = function scrollBy(this: HTMLElement, arg?: number | ScrollToOptions, y?: number) {
    const current = SCROLL_OFFSETS.get(this) ?? 0;
    if (typeof arg === "number") setScrollTop(this, current + (y ?? 0));
    else if (arg?.top !== undefined) setScrollTop(this, current + arg.top);
  };
  // `row-gap` is not in jsdom's computed-style support table, and virtuoso
  // parses whatever it gets — an empty string becomes NaN and poisons every
  // size it records afterwards.
  window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
    const style = originals.getComputedStyle.call(window, element, pseudo ?? undefined);
    return new Proxy(style, {
      get(target, property, receiver) {
        if (property === "rowGap" || property === "columnGap") return "0px";
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof window.getComputedStyle;

  return {
    frame() {
      const targets = Array.from(pendingScrollEvents);
      pendingScrollEvents.clear();
      for (const target of targets) target.dispatchEvent(new Event("scroll"));
    },
    scroller: () => scrollerOf(document.documentElement),
    scrollTop: () => {
      const element = scrollerOf(document.documentElement);
      return element ? SCROLL_OFFSETS.get(element) ?? 0 : 0;
    },
    uninstall() {
      if (originals.getBoundingClientRect) Object.defineProperty(Element.prototype, "getBoundingClientRect", originals.getBoundingClientRect);
      if (originals.offsetParent) Object.defineProperty(HTMLElement.prototype, "offsetParent", originals.offsetParent);
      if (originals.offsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", originals.offsetHeight);
      if (originals.scrollHeight) Object.defineProperty(Element.prototype, "scrollHeight", originals.scrollHeight);
      if (originals.scrollTop) Object.defineProperty(Element.prototype, "scrollTop", originals.scrollTop);
      proto.scrollTo = originals.scrollTo;
      proto.scrollBy = originals.scrollBy;
      window.getComputedStyle = originals.getComputedStyle;
    },
  };
}

/**
 * A ResizeObserver that reports on demand instead of on a real layout pass.
 * Every observed element is treated as resized, which is what happens in the
 * browser the first time a virtualized row is mounted and measured.
 */
export function installResizeObservers(): { flush: () => void; uninstall: () => void } {
  const original = globalThis.ResizeObserver;
  const live = new Set<{ callback: ResizeObserverCallback; targets: Set<Element>; observer: ResizeObserver }>();

  class HarnessResizeObserver implements ResizeObserver {
    private entry: { callback: ResizeObserverCallback; targets: Set<Element>; observer: ResizeObserver };
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: new Set(), observer: this };
      live.add(this.entry);
    }
    observe(target: Element) { this.entry.targets.add(target); }
    unobserve(target: Element) { this.entry.targets.delete(target); }
    disconnect() { this.entry.targets.clear(); live.delete(this.entry); }
  }

  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: HarnessResizeObserver });

  return {
    flush() {
      for (const entry of Array.from(live)) {
        for (const target of Array.from(entry.targets)) {
          entry.callback([{ target } as ResizeObserverEntry], entry.observer);
        }
      }
    },
    uninstall() {
      Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: original });
    },
  };
}
