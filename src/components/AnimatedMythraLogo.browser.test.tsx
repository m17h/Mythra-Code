import { StrictMode } from "react";
import { fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { AnimatedMythraLogo } from "./AnimatedMythraLogo";

afterEach(async () => {
  await commands.setStreamTestReducedMotion(false);
  await page.viewport(1400, 900);
});

it("keeps the logo compact in short windows without clipping separated pieces", async () => {
  await page.viewport(980, 680);
  const view = render(<AnimatedMythraLogo />);
  const button = view.getByRole("button");
  expect(button.getBoundingClientRect().width).toBe(96);
  expect(view.container.querySelector(".mythra-logo")!.getBoundingClientRect().height).toBe(120);
  expect(getComputedStyle(button.querySelector("svg")!).overflow).toBe("visible");
  await page.viewport(1400, 900);
  expect(button.getBoundingClientRect().width).toBe(168);
});

it("transitions from the scattered pose instead of snapping into view", async () => {
  const view = render(<AnimatedMythraLogo />);
  const button = view.getByRole("button");
  const left = button.querySelector(".mythra-logo__piece--left")!;
  expect(getComputedStyle(left).opacity).toBe("0");
  await expect.poll(() => {
    const opacity = Number(getComputedStyle(left).opacity);
    return opacity > 0 && opacity < 1;
  }).toBe(true);
  await expect.poll(() => getComputedStyle(left).opacity).toBe("1");
});

it("assembles in Strict Mode and preserves the website's hover geometry", async () => {
  const view = render(<StrictMode><AnimatedMythraLogo /></StrictMode>);
  const button = view.getByRole("button");
  await expect.poll(() => button.hasAttribute("data-idle"), { timeout: 3000 }).toBe(true);
  expect(button.hasAttribute("data-scattered")).toBe(false);
  expect(button.getBoundingClientRect().width).toBe(168);
  fireEvent.pointerEnter(button, { pointerType: "mouse" });
  expect(button).toHaveAttribute("aria-pressed", "true");
  const fold = button.querySelector(".mythra-logo__piece--fold")!;
  await expect.poll(() => getComputedStyle(fold).transform).toBe("matrix(1, 0, 0, 1, 40, -70)");
  const ghost = button.querySelector(".mythra-logo__ghost path")!;
  await expect.poll(() => getComputedStyle(ghost).opacity).toBe("0.6");
  fireEvent.pointerLeave(button, { pointerType: "mouse" });
  expect(button).toHaveAttribute("aria-pressed", "false");
  expect(button.style.getPropertyValue("--mythra-logo-rx")).toBe("0deg");
  // macOS WebKit's Tab traversal depends on the OS full-keyboard-access
  // preference. Focus explicitly to test activation, not that preference.
  button.focus();
  expect(document.activeElement).toBe(button);
  await userEvent.keyboard("{Enter}");
  expect(button).toHaveAttribute("aria-pressed", "true");
  await userEvent.keyboard(" ");
  expect(button).toHaveAttribute("aria-pressed", "false");
});

it("uses instance-local SVG references for gradients, masks and clipped sheen", () => {
  const view = render(<><AnimatedMythraLogo /><AnimatedMythraLogo /></>);
  const ids = [...view.container.querySelectorAll("[id]")].map((node) => node.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const svg of view.container.querySelectorAll("svg")) {
    const localIds = new Set([...svg.querySelectorAll("[id]")].map((node) => node.id));
    for (const node of svg.querySelectorAll("[fill], [mask], [clip-path], [href]")) {
      for (const attr of ["fill", "mask", "clip-path", "href"]) {
        const value = node.getAttribute(attr);
        const id = value?.match(attr === "href" ? /^#(.+)$/ : /^url\(#([^)]*)\)$/);
        if (id) expect(localIds.has(id[1])).toBe(true);
      }
    }
  }
});

it("responds to live reduced-motion changes without hiding the logo or leaving loops running", async () => {
  const view = render(<AnimatedMythraLogo />);
  const button = view.getByRole("button");
  await expect.poll(() => button.hasAttribute("data-idle"), { timeout: 3000 }).toBe(true);
  await commands.setStreamTestReducedMotion(true);
  expect(button.hasAttribute("data-idle")).toBe(false);
  expect(button.hasAttribute("data-scattered")).toBe(false);
  const piece = button.querySelector(".mythra-logo__piece")!;
  expect(getComputedStyle(piece).opacity).toBe("1");
  expect(getComputedStyle(button.querySelector(".mythra-logo__bob")!).animationName).toBe("none");
  fireEvent.pointerMove(button, { pointerType: "mouse", clientX: 50, clientY: 50 });
  expect(button.style.getPropertyValue("--mythra-logo-rx")).toBe("0deg");
  fireEvent.pointerEnter(button, { pointerType: "mouse" });
  expect(button).toHaveAttribute("aria-pressed", "true");
  await commands.setStreamTestReducedMotion(false);
  await expect.poll(() => button.hasAttribute("data-idle"), { timeout: 3000 }).toBe(true);
  view.unmount();
  expect(button.hasAttribute("data-idle")).toBe(false);
});

it("stops an in-flight entrance immediately when reduced motion is enabled", async () => {
  const view = render(<AnimatedMythraLogo />);
  const button = view.getByRole("button");
  const left = button.querySelector(".mythra-logo__piece--left")!;
  await expect.poll(() => {
    const opacity = Number(getComputedStyle(left).opacity);
    return opacity > 0 && opacity < 1;
  }).toBe(true);
  await commands.setStreamTestReducedMotion(true);
  expect(getComputedStyle(left).opacity).toBe("1");
  expect(getComputedStyle(left).transform).toBe("none");
  expect(button.querySelector("svg")!.getAnimations({ subtree: true })
    .filter((animation) => animation.playState === "running")).toHaveLength(0);
});

it("settles active hover and tilt transitions immediately when reduced motion is enabled", async () => {
  const view = render(<AnimatedMythraLogo />);
  const button = view.getByRole("button");
  const svg = button.querySelector("svg")!;
  const fold = button.querySelector(".mythra-logo__piece--fold")!;
  await expect.poll(() => button.hasAttribute("data-idle"), { timeout: 3000 }).toBe(true);
  fireEvent.pointerEnter(button, { pointerType: "mouse" });
  const rect = button.getBoundingClientRect();
  fireEvent.pointerMove(button, {
    pointerType: "mouse", clientX: rect.right, clientY: rect.top,
  });
  await expect.poll(() => button.style.getPropertyValue("--mythra-logo-rx")).toBe("6.00deg");
  expect(button.style.getPropertyValue("--mythra-logo-ry")).toBe("8.00deg");
  expect(svg.getAnimations({ subtree: true }).some((animation) => animation.playState === "running")).toBe(true);
  await commands.setStreamTestReducedMotion(true);
  expect(button).toHaveAttribute("aria-pressed", "true");
  expect(getComputedStyle(fold).transform).toBe("matrix(1, 0, 0, 1, 40, -70)");
  expect(button.style.getPropertyValue("--mythra-logo-rx")).toBe("0deg");
  expect(button.style.getPropertyValue("--mythra-logo-ry")).toBe("0deg");
  expect(svg.getAnimations({ subtree: true })).toHaveLength(0);
  fireEvent.pointerLeave(button, { pointerType: "mouse" });
  expect(getComputedStyle(fold).transform).toBe("none");
});

it("stops idle work when scrolled offscreen and resumes on return", async () => {
  const view = render(<AnimatedMythraLogo />);
  const button = view.getByRole("button");
  await expect.poll(() => button.hasAttribute("data-idle"), { timeout: 3000 }).toBe(true);
  button.style.position = "fixed";
  button.style.top = "-1000px";
  await expect.poll(() => button.hasAttribute("data-idle")).toBe(false);
  button.style.top = "0px";
  await expect.poll(() => button.hasAttribute("data-idle")).toBe(true);
});

it("pauses in hidden documents and supports tap without mouse-hover behavior", async () => {
  const view = render(<AnimatedMythraLogo />);
  const button = view.getByRole("button");
  await expect.poll(() => button.hasAttribute("data-idle"), { timeout: 3000 }).toBe(true);
  const visibility = vi.spyOn(document, "visibilityState", "get");
  visibility.mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(button.hasAttribute("data-idle")).toBe(false);
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(button.hasAttribute("data-idle")).toBe(true);
  fireEvent.pointerEnter(button, { pointerType: "touch" });
  expect(button).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(button);
  fireEvent.pointerLeave(button, { pointerType: "touch" });
  expect(button).toHaveAttribute("aria-pressed", "true");
  visibility.mockRestore();
});
