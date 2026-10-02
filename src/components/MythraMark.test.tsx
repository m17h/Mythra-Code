// @ts-expect-error Node built-in types are unavailable to the frontend compiler.
import { readFileSync } from "node:fs";
import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { MythraMark } from "./MythraMark";

const CARET = "M463 560 548 638 463 716v-56l24-22-24-22Z";

it("paints a white static arrow instead of cutting through to the background", () => {
  const view = render(<MythraMark title="Mythra Code" />);
  const caret = view.container.querySelector(".mythra-mark-caret");
  expect(caret).toHaveAttribute("d", CARET);
  expect(caret).toHaveAttribute("fill", "#fff");
  expect(view.container.querySelector("mask")).toBeNull();
});

it.each([
  "public/mythra-code-glyph.svg",
  "public/mythra-code-logo.svg",
  "src-tauri/icons/mythra-code-glyph.svg",
  "src-tauri/icons/mythra-code-master.svg",
])("keeps the bundled static %s arrow white", (path) => {
  const svg = new DOMParser().parseFromString(readFileSync(path, "utf8"), "image/svg+xml");
  expect(svg.querySelector("parsererror")).toBeNull();
  expect(svg.querySelector('path[data-mythra-caret]')?.getAttribute("fill")).toBe("#fff");
  expect(svg.querySelector("mask")).toBeNull();
});

it("gives the app icon a dark-gray tile without changing the colored rim", () => {
  const svg = new DOMParser().parseFromString(readFileSync("src-tauri/icons/mythra-code-master.svg", "utf8"), "image/svg+xml");
  expect([...svg.querySelectorAll("#tile stop")].map((stop) => stop.getAttribute("stop-color")))
    .toEqual(["#303236", "#27292D", "#202226"]);
  expect(svg.querySelector("#rim stop")?.getAttribute("stop-color")).toBe("#38E6F4");
});

it("keeps the app tile free of the decorative arc above the logo", () => {
  const svg = new DOMParser().parseFromString(readFileSync("src-tauri/icons/mythra-code-master.svg", "utf8"), "image/svg+xml");
  expect(svg.querySelector("svg > path")).toBeNull();
  expect(svg.querySelectorAll("svg > g > path")).toHaveLength(7);
});

it.each(["public/mythra-code-logo.svg", "src-tauri/icons/mythra-code-master.svg"])("keeps the rear blue highlight behind the front cyan piece in %s", (path) => {
  const svg = new DOMParser().parseFromString(readFileSync(path, "utf8"), "image/svg+xml");
  const pieces = [...svg.querySelectorAll("svg > g > path")];
  const highlight = pieces.findIndex((piece) => piece.getAttribute("stroke") === "#3A9CFF");
  const front = pieces.findIndex((piece) => piece.getAttribute("d")?.startsWith("M190 159q15-9 30 0l395 235q"));
  expect(highlight).toBeGreaterThanOrEqual(0);
  expect(front).toBeGreaterThan(highlight);
});

it("dithers only the app tile gradient before applying its shadow", () => {
  const svg = new DOMParser().parseFromString(readFileSync("src-tauri/icons/mythra-code-master.svg", "utf8"), "image/svg+xml");
  const filter = svg.querySelector("#tile-shadow")!;
  expect(filter.getAttribute("color-interpolation-filters")).toBe("sRGB");
  expect(filter.querySelector("feTurbulence")?.getAttribute("seed")).toBe("17");
  expect(filter.querySelector('feComposite[result="tile-dithered"]')?.getAttribute("in")).toBe("SourceGraphic");
  expect(filter.querySelector('feComposite[result="tile-smooth"]')?.getAttribute("in2")).toBe("SourceAlpha");
  expect(filter.querySelector("feDropShadow")?.getAttribute("in")).toBe("tile-smooth");
  expect(svg.querySelector("svg > g")?.getAttribute("filter")).toBe("url(#mark-lift)");
});
