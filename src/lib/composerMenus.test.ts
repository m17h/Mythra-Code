import { afterEach, describe, expect, it } from "vitest";
import { closesModelMenu } from "./composerMenus";

function closesDuringDispatch(node: Node, type: string, control: HTMLElement, beforeBubble?: () => void): boolean {
  let result: boolean | null = null;
  if (beforeBubble) node.addEventListener(type, beforeBubble, { once: true });
  const listener = (event: Event) => { result = closesModelMenu(event, control); };
  document.addEventListener(type, listener, { once: true });
  node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  document.removeEventListener(type, listener);
  if (result === null) throw new Error(`${type} did not reach the document listener`);
  return result;
}

let root: HTMLDivElement | null = null;

function mountControl(): { root: HTMLDivElement; option: HTMLButtonElement; providerPill: HTMLButtonElement } {
  const control = document.createElement("div");
  control.className = "openrouter-control";
  control.innerHTML = `
    <div class="thread-provider-control"><button class="provider-pill"></button></div>
    <div class="openrouter-menu"><button class="option"></button></div>
  `;
  document.body.append(control);
  root = control;
  return {
    root: control,
    option: control.querySelector<HTMLButtonElement>(".option")!,
    providerPill: control.querySelector<HTMLButtonElement>(".provider-pill")!,
  };
}

afterEach(() => {
  root?.remove();
  root = null;
});

describe("closesModelMenu", () => {
  it("closes on a pointer press outside the control", () => {
    const { root: control } = mountControl();
    const outside = document.createElement("button");
    document.body.append(outside);

    expect(closesDuringDispatch(outside, "pointerdown", control)).toBe(true);
    expect(closesDuringDispatch(outside, "click", control)).toBe(true);
    outside.remove();
  });

  it("keeps the menu open for a press on its own options", () => {
    const { root: control, option } = mountControl();

    expect(closesDuringDispatch(option, "pointerdown", control)).toBe(false);
    expect(closesDuringDispatch(option, "click", control)).toBe(false);
  });

  it("closes for the nested provider pill on both pointer and keyboard activation", () => {
    const { root: control, providerPill } = mountControl();

    expect(closesDuringDispatch(providerPill, "pointerdown", control)).toBe(true);
    // Enter/Space on the pill emits a click and no pointer event.
    expect(closesDuringDispatch(providerPill, "click", control)).toBe(true);
  });

  it("keeps a click inside when its target is removed before document dismissal", () => {
    const { root: control, option } = mountControl();

    expect(closesDuringDispatch(option, "click", control, () => option.remove())).toBe(false);
    expect(control.contains(option)).toBe(false);
  });

  it("still closes on a pointer press once the control has unmounted", () => {
    mountControl();
    const event = new MouseEvent("pointerdown", { bubbles: true });
    expect(closesModelMenu(event, null)).toBe(true);
  });
});
