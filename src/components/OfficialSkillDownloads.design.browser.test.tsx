import type { CSSProperties } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { SkillLibrary } from "./SkillLibrary";
import { OpenAILogo } from "./BrandLogos";
import type { LocalSkill, OfficialSkill } from "../lib/skills";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}), revealItemInDir: vi.fn(async () => {}) }));

const revision = "9d630808e4add0a7146de4af9384155d5dee350a";
const catalog: OfficialSkill[] = [
  { id: "anthropic-frontend-design", publisher: "anthropic", title: "Frontend design", description: "Design distinctive interfaces with deliberate typography, color, and layout.", repository: "anthropics/skills", path: "skills/frontend-design", revision, license: "Apache-2.0", notes: "Use with any model that can edit frontend code." },
  { id: "anthropic-webapp-testing", publisher: "anthropic", title: "Web app testing", description: "Test local web applications with Playwright and Python helpers.", repository: "anthropics/skills", path: "skills/webapp-testing", revision, license: "Apache-2.0", notes: "Published by Anthropic.", requirements: "Requires Python, Playwright, and its browser installation. These dependencies are not installed with the skill." },
  { id: "anthropic-theme-factory", publisher: "anthropic", title: "Theme factory", description: "Choose and apply coordinated color and typography themes.", repository: "anthropics/skills", path: "skills/theme-factory", revision, license: "Apache-2.0", notes: "Includes ten theme references and a PDF showcase." },
  { id: "openai-wrangler", publisher: "openai", title: "Cloudflare Wrangler", description: "Develop and manage Cloudflare Workers with Wrangler CLI guidance.", repository: "openai/plugins", path: "plugins/cloudflare/skills/wrangler", revision, license: "Apache-2.0", notes: "Authored by Cloudflare and distributed in OpenAI's public repository. Requires Node.js and Wrangler; account operations require Cloudflare authentication." },
];
const source = (entry: OfficialSkill, modified = false) => ({ catalogId: entry.id, publisher: entry.publisher, repository: entry.repository, url: `https://github.com/${entry.repository}`, revision: entry.revision, license: entry.license, modified });
const skill = (name: string, extra: Partial<LocalSkill> = {}): LocalSkill => ({ path: `/skills/${name}/SKILL.md`, relativePath: `${name}/SKILL.md`, fileName: "SKILL.md", defaultName: name, name, description: "", supportingMarkdownCount: 0, enabled: true, ...extra });
const skills = [
  skill("frontend-design", { description: catalog[0].description, supportingMarkdownCount: 1, source: source(catalog[0]) }),
  skill("theme-factory", { description: catalog[2].description, enabled: false, source: source(catalog[2], true) }),
  skill("release-check", { description: "Run the release checklist before tagging." }),
];

const wranglerSkill = skill("wrangler", { description: catalog[3].description, source: source(catalog[3]) });

function Fixture({ theme, width, scale, installed = skills, onInstall }: { theme: string; width: number; scale: number; installed?: LocalSkill[]; onInstall?: () => void }) {
  const scheme = theme === "light-mythra" || theme === "daylight" || theme === "atari" ? "light" : "dark";
  return <div className="app-shell" data-theme={theme} data-color-scheme={scheme} style={{ display: "block", width, height: "auto", minHeight: 0, padding: 16, background: "var(--panel)", zoom: scale, "--ui-scale": scale } as CSSProperties}>
    <SkillLibrary folder="/skills" skills={installed} removedSkills={[]} busy={false} error=""
      onChooseFolder={() => {}} onRefresh={() => {}} onImport={() => {}} onCreate={async () => true}
      onRead={async () => "---\nname: frontend-design\n---\n\n# Frontend design\n\nBuild a distinctive interface.\n"} onUpdate={async () => {}}
      onRename={() => true} onToggle={() => {}} onRemove={async () => true} onRestore={async () => true}
      onInstallOfficial={async () => { onInstall?.(); throw new Error("Could not download package: offline"); }} />
  </div>;
}

function expectSquircle(element: HTMLElement) {
  const style = getComputedStyle(element);
  const radius = parseFloat(style.borderTopLeftRadius);
  expect(style.borderTopLeftRadius, element.className).not.toContain("%");
  expect(radius, element.className).toBeGreaterThan(0);
  expect(radius, `${element.className}: not an oval`).toBeLessThan(Math.min(element.offsetWidth, element.offsetHeight) / 2);
}

// Counts rendered pixels that stand clearly apart from the tile's dominant
// (background) colour, from a real screenshot of the element.
async function inkPixels(element: HTMLElement) {
  const png = await page.screenshot({ element, save: false });
  const image = new Image();
  image.src = `data:image/png;base64,${png}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const luminance: number[] = [];
  for (let index = 0; index < data.length; index += 4) luminance.push((0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2]) / 255);
  const background = [...luminance].sort((a, b) => a - b)[Math.floor(luminance.length / 2)];
  return luminance.filter((value) => Math.abs(value - background) > 0.3).length;
}

afterEach(async () => { await page.viewport(1400, 900); });
describe("download library design", () => {
  it.each([
    { theme: "mythra", width: 720, scale: 1 },
    { theme: "light-mythra", width: 720, scale: 1 },
    { theme: "atari", width: 720, scale: 1 },
    { theme: "kiwi", width: 390, scale: 1 },
    { theme: "daylight", width: 390, scale: 1 },
    { theme: "synthwave", width: 390, scale: 1.5 },
  ])("fits states, origin tags and errors without overflow ($theme, $width px, $scale×)", async ({ theme, width, scale }) => {
    await page.viewport(Math.ceil(width * scale) + 40, 1100);
    invoke.mockResolvedValue(catalog);
    const view = render(<Fixture theme={theme} width={width} scale={scale} />);
    await userEvent.click(screen.getByText("Download Anthropic & OpenAI skills"));
    const list = await screen.findByRole("list", { name: "Downloadable skills" });
    expect(within(list).getByText("Installed")).toBeVisible();
    expect(within(list).getByRole("button", { name: "Install original copy of Theme factory" })).toBeEnabled();
    expect(screen.getByText("1 of 4 in your folder")).toBeVisible();
    await userEvent.click(within(list).getByRole("button", { name: "Install Cloudflare Wrangler" }));
    const wrangler = within(list).getByText("Cloudflare Wrangler").closest<HTMLElement>(".official-skill-card")!;
    expect(await within(wrangler).findByRole("alert")).toHaveTextContent("offline");
    expect(within(wrangler).getByText("OpenAI")).toHaveAttribute("title", expect.stringContaining("Distributed"));
    expect(within(wrangler).getByText(/Authored by Cloudflare/)).toBeVisible();
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    const downloads = view.container.querySelector<HTMLElement>(".official-skill-downloads")!;
    expect(downloads.scrollWidth).toBeLessThanOrEqual(downloads.clientWidth + 1);
    for (const card of view.container.querySelectorAll<HTMLElement>(".official-skill-card")) {
      expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
      expectSquircle(card);
      const tag = card.querySelector<HTMLElement>(".skill-publisher-tag")!;
      expectSquircle(tag);
      expect(getComputedStyle(tag).color).not.toBe(getComputedStyle(tag).backgroundColor);
      expect(getComputedStyle(card).backgroundImage).toBe("none");
    }
    expectSquircle(view.container.querySelector<HTMLElement>(".official-skill-library")!);
    const library = view.container.querySelector<HTMLElement>(".skill-library-section")!;
    expect(library.scrollWidth).toBeLessThanOrEqual(library.clientWidth + 1);
    await page.screenshot({ element: view.container.firstElementChild as HTMLElement, path: `../../test-results/official-skills/fixture-downloads-${theme}-${width}-${scale}.png` });
  });

  it.each(["mythra", "light-mythra", "atari", "daylight", "synthwave"])("renders visible company marks on installed rows only (%s)", async (theme) => {
    await page.viewport(900, 900);
    invoke.mockResolvedValue(catalog);
    const light = theme === "light-mythra" || theme === "daylight" || theme === "atari";
    const view = render(<>
      <Fixture theme={theme} width={720} scale={1} installed={[...skills, wranglerSkill]} />
      {/* Control: the shared OpenAI mark keeps its fixed white fill elsewhere. */}
      <div className="app-shell" data-theme={theme} data-color-scheme={light ? "light" : "dark"} style={{ display: "block", height: "auto", minHeight: 0 }}>
        <span data-testid="shared-openai" style={{ display: "inline-grid", placeItems: "center", width: 18, height: 18, background: "var(--panel)" }}><OpenAILogo size={11} /></span>
      </div>
    </>);
    const anthropic = screen.getAllByRole("img", { name: "Distributed by Anthropic" });
    const openai = screen.getByRole("img", { name: "Distributed by OpenAI" });
    expect(anthropic).toHaveLength(2);
    expect(openai).toHaveAttribute("title", "Distributed by OpenAI from openai/plugins");
    const custom = screen.getByText("@release-check").closest<HTMLElement>(".skill-card")!;
    expect(custom.querySelector(".skill-origin-mark, .skill-publisher-tag")).toBeNull();
    expect(view.container.querySelector(".skill-card-list .skill-publisher-tag")).toBeNull();

    for (const mark of [anthropic[0], openai]) {
      expectSquircle(mark);
      const glyph = mark.querySelector("svg")!;
      expect(glyph.getBoundingClientRect().width).toBeGreaterThanOrEqual(10);
      expect(getComputedStyle(glyph).fill).toBe(getComputedStyle(mark).color);
      expect(await inkPixels(mark), `${theme} ${mark.getAttribute("aria-label")}`).toBeGreaterThanOrEqual(12);
    }
    const shared = screen.getByTestId("shared-openai").querySelector("svg")!;
    expect(shared).toHaveAttribute("fill", "#fff");
    expect(getComputedStyle(shared).fill).toBe("rgb(255, 255, 255)");
    if (light) expect(await inkPixels(screen.getByTestId("shared-openai")), "white mark on a light tile is the case being fixed").toBeLessThan(12);
    const rows = view.container.querySelector<HTMLElement>(".skill-card-list")!;
    rows.scrollIntoView({ block: "start" });
    await page.screenshot({ element: rows, path: `../../test-results/official-skills/fixture-installed-marks-${theme}.png` });
  });

  it.each(["mythra", "light-mythra", "atari"])("keeps a company logo before a long skill title on the same line at 430px (%s)", async (theme) => {
    await page.viewport(430, 700);
    const longName = "chatgpt-app-submission-and-review-the-implementation";
    const managed = skill(longName, { source: source(catalog[3], true), enabled: false });
    const view = render(<Fixture theme={theme} width={390} scale={1} installed={[managed, skills[2]]} />);
    const row = view.container.querySelector<HTMLElement>(".skill-card")!;
    const mark = within(row).getByRole("img", { name: "Distributed by OpenAI" });
    const title = within(row).getByText(`@${longName}`);
    expect(mark.nextElementSibling).toBe(title);
    const markRect = mark.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    expect(Math.abs((markRect.top + markRect.bottom) / 2 - (titleRect.top + titleRect.bottom) / 2)).toBeLessThanOrEqual(1);
    expect(markRect.right).toBeLessThanOrEqual(titleRect.left);
    expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
    expect(getComputedStyle(title).textOverflow).toBe("ellipsis");
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
    for (const status of row.querySelectorAll<HTMLElement>(".skill-off-tag")) expect(status.getBoundingClientRect().right).toBeLessThanOrEqual(row.getBoundingClientRect().right);
    const custom = within(view.container).getByText("@release-check").closest<HTMLElement>(".skill-card")!;
    expect(custom.querySelector(".skill-origin-mark")).toBeNull();
  });

  it.each([
    { theme: "mythra", width: 720, scale: 1 },
    { theme: "atari", width: 390, scale: 1.5 },
  ])("explains requirements above a modal dialog without closing it ($theme, $width px, $scale×)", async ({ theme, width, scale }) => {
    await page.viewport(Math.ceil(width * scale) + 40, 760);
    invoke.mockClear();
    invoke.mockResolvedValue(catalog);
    const onInstall = vi.fn();
    // A Settings-style document Escape handler that honours defaultPrevented.
    const settingsEscape = vi.fn((event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) event.preventDefault(); });
    document.addEventListener("keydown", settingsEscape);
    function Modal() {
      return <dialog ref={(dialog) => { if (dialog && !dialog.open) dialog.showModal(); }} style={{ padding: 0, border: 0, background: "transparent", maxHeight: "calc(100vh - 16px)", maxWidth: "none", overflow: "auto" }}>
        <Fixture theme={theme} width={width} scale={scale} installed={[]} onInstall={onInstall} />
      </dialog>;
    }
    try {
      render(<Modal />);
      const dialog = document.querySelector("dialog")!;
      await userEvent.click(screen.getByText("Download Anthropic & OpenAI skills"));
      const info = await screen.findByRole("button", { name: "Requirements for Web app testing" });
      expect(screen.queryByRole("button", { name: "Requirements for Frontend design" })).toBeNull();
      expect(screen.getByText(/Authored by Cloudflare/)).toBeVisible();
      const panel = document.getElementById(info.getAttribute("aria-controls")!)!;
      expect(dialog.contains(panel)).toBe(true);

      info.scrollIntoView({ block: "center" });
      await userEvent.hover(info);
      await waitFor(() => expect(panel.matches(":popover-open")).toBe(true));
      const box = panel.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(window.innerWidth + 1);
      expect(box.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
      expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 12);
      expect(hit && panel.contains(hit)).toBe(true);
      expect(panel).toHaveTextContent(/model can install the tools it needs if your permission settings allow/);
      expect(panel).toHaveTextContent(/credentials are never set up for you/);
      await page.screenshot({ path: `../../test-results/official-skills/fixture-requirements-${theme}-${width}-${scale}.png` });

      info.focus();
      await userEvent.keyboard("{Escape}");
      expect(panel.matches(":popover-open")).toBe(false);
      expect(dialog.open).toBe(true);
      expect(settingsEscape).not.toHaveBeenCalled();
      await userEvent.keyboard("{Enter}");
      expect(info).toHaveAttribute("aria-expanded", "true");
      expect(onInstall).not.toHaveBeenCalled();
      expect(invoke.mock.calls.map(([command]) => command)).toEqual(["local_skills_catalog"]);
    } finally {
      document.removeEventListener("keydown", settingsEscape);
    }
  });

  it.each(["mythra", "light-mythra"])("presents the vendor source viewer as read-only (%s)", async (theme) => {
    await page.viewport(900, 900);
    invoke.mockResolvedValue(catalog);
    render(<Fixture theme={theme} width={720} scale={1} />);
    await userEvent.click(screen.getByRole("button", { name: "View frontend-design skill" }));
    const dialog = await screen.findByRole("dialog", { name: "View @frontend-design" });
    const field = await within(dialog).findByRole("textbox", { name: "Markdown for frontend-design" });
    await waitFor(() => expect(field).toHaveFocus());
    expect(field).toHaveAttribute("readonly");
    expect(within(dialog).getByText("Read-only")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "anthropics/skills" })).toBeVisible();
    expect(within(dialog).getByText(revision)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Save skill" })).toBeNull();
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
    await page.screenshot({ element: dialog, path: `../../test-results/official-skills/fixture-viewer-${theme}.png` });
  });
});
