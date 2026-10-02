import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { commands } from "vitest/browser";
import { THEMES, themeColorScheme } from "../lib/appConfig";
import { AnimatedMythraLogo } from "./AnimatedMythraLogo";
import { MythraMark } from "./MythraMark";

it.each(THEMES)("keeps the static arrow white in $name without changing the animated caret", async ({ id }) => {
  await commands.setStreamTestReducedMotion(false);
  const view = render(<div className="app-shell" data-theme={id} data-color-scheme={themeColorScheme(id)} style={{ display: "block" }}>
    <MythraMark size={48} />
    <AnimatedMythraLogo />
  </div>);
  const caret = view.container.querySelector<SVGPathElement>(".mythra-mark-caret");
  expect(caret).not.toBeNull();
  expect(getComputedStyle(caret!).fill).toBe("rgb(255, 255, 255)");
  expect(getComputedStyle(caret!).opacity).toBe("1");
  expect(getComputedStyle(caret!).animationName).toBe("none");
  const shell = view.container.querySelector<HTMLElement>(".app-shell")!;
  const animated = view.container.querySelector<SVGPathElement>(".mythra-logo__cursor")!;
  await expect.poll(() => getComputedStyle(animated).animationName, { timeout: 3000 }).toBe("mythra-logo-blink");
  // The static arrow must not read the animated caret's theme token. Leave
  // that token and the animated cutout/blink path alone.
  shell.style.setProperty("--mythra-mark-caret", "#dffbfe");
  expect(getComputedStyle(animated).fill).toBe("rgb(223, 251, 254)");
  expect(getComputedStyle(caret!).fill).toBe("rgb(255, 255, 255)");
  expect(view.container.querySelector(".mythra-logo mask[id$='-caret']")).not.toBeNull();
});
