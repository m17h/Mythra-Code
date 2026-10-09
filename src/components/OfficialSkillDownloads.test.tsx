import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OfficialSkillDownloads } from "./OfficialSkillDownloads";
import { SkillLibrary } from "./SkillLibrary";
import type { LocalSkill, OfficialSkill } from "../lib/skills";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}), revealItemInDir: vi.fn(async () => {}) }));
const entry: OfficialSkill = { id: "anthropic-design", publisher: "anthropic", title: "Frontend design", description: "Build polished interfaces", repository: "anthropics/skills", path: "skills/frontend-design", revision: "abc123", license: "Apache-2.0", notes: "Requires code editing tools." };
const managed: LocalSkill = { path: "/skills/anthropic-design/SKILL.md", relativePath: "anthropic-design/SKILL.md", fileName: "SKILL.md", defaultName: "design", name: "design", description: entry.description, supportingMarkdownCount: 0, enabled: true, source: { catalogId: entry.id, publisher: entry.publisher, repository: entry.repository, url: "https://github.com/anthropics/skills", revision: entry.revision, license: entry.license, modified: false } };
function downloads(overrides: Partial<Parameters<typeof OfficialSkillDownloads>[0]> = {}) {
  const props = { folder: "/skills", skills: [] as LocalSkill[], removedSkills: [] as LocalSkill[], busy: false, onChooseFolder: vi.fn(), onInstall: vi.fn(async () => managed.path), onRestore: vi.fn(async () => true), ...overrides };
  return { props, ...render(<OfficialSkillDownloads {...props} />) };
}
function library(overrides: Partial<Parameters<typeof SkillLibrary>[0]> = {}) {
  const props = { folder: "/skills", skills: [managed], removedSkills: [], busy: false, error: "", onChooseFolder: vi.fn(), onRefresh: vi.fn(), onImport: vi.fn(), onCreate: vi.fn(async () => true), onRead: vi.fn(async () => "# Design\n"), onUpdate: vi.fn(async () => {}), onRename: vi.fn(() => true), onToggle: vi.fn(), onRemove: vi.fn(async () => true), onRestore: vi.fn(async () => true), onInstallOfficial: vi.fn(async () => managed.path), ...overrides };
  return { props, ...render(<SkillLibrary {...props} />) };
}
beforeEach(() => invoke.mockReset().mockResolvedValue([entry]));
describe("publisher skill downloads", () => {
  it("recovers a catalog load failure through its explicit retry", async () => {
    invoke.mockRejectedValueOnce(new Error("Catalog unavailable"));
    downloads();
    expect(await screen.findByRole("alert")).toHaveTextContent("Catalog unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry skill catalog" }));
    expect(await screen.findByRole("button", { name: "Install Frontend design" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("reports a failed restoration on its card without falsely changing scan state", async () => {
    downloads({ removedSkills: [managed], onRestore: vi.fn(async () => false) });
    fireEvent.click(await screen.findByRole("button", { name: "Restore skill" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not restore this skill");
    expect(screen.getByRole("button", { name: "Restore skill" })).toBeEnabled();
    expect(screen.queryByText("Installed")).toBeNull();
  });

  it("ignores a read-only viewer completion after settings become inactive", async () => {
    let finish!: (content: string) => void;
    const view = library({ onRead: vi.fn(() => new Promise<string>((resolve) => { finish = resolve; })) });
    fireEvent.click(screen.getByRole("button", { name: "View design skill" }));
    expect(screen.getByRole("dialog", { name: "View @design" })).toBeInTheDocument();
    view.rerender(<SkillLibrary {...view.props} active={false} />);
    finish("# Late read\n");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    view.rerender(<SkillLibrary {...view.props} active />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("only loads catalog after explicitly expanding downloads while settings are open", async () => {
    const view = library({ active: false });
    fireEvent.click(screen.getByText("Download Anthropic & OpenAI skills"));
    await waitFor(() => expect(view.container.querySelector("details.official-skill-library")).toHaveAttribute("open"));
    expect(invoke).not.toHaveBeenCalled();
    view.rerender(<SkillLibrary {...view.props} active />);
    expect(await screen.findByRole("textbox", { name: "Search downloadable skills" })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("local_skills_catalog");
  });
  it("installs into the selected folder and derives installed/removed state from the live scan", async () => {
    const view = downloads();
    fireEvent.click(await screen.findByRole("button", { name: "Install Frontend design" }));
    await waitFor(() => expect(view.props.onInstall).toHaveBeenCalledExactlyOnceWith(entry.id, "/skills"));
    view.rerender(<OfficialSkillDownloads {...view.props} skills={[managed]} />);
    expect(screen.getByText("Installed")).toBeInTheDocument();
    view.rerender(<OfficialSkillDownloads {...view.props} removedSkills={[managed]} />);
    expect(screen.queryByText("Installed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restore skill" }));
    await waitFor(() => expect(view.props.onRestore).toHaveBeenCalledWith(managed.path));
    view.rerender(<OfficialSkillDownloads {...view.props} />);
    expect(screen.getByRole("button", { name: "Install Frontend design" })).toBeEnabled();
  });
  it("preserves visible failure and allows retry without marking the skill installed", async () => {
    const view = downloads({ onInstall: vi.fn(async () => { throw new Error("Download failed"); }) });
    fireEvent.click(await screen.findByRole("button", { name: "Install Frontend design" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Download failed");
    expect(screen.getByRole("button", { name: "Install Frontend design" })).toBeEnabled();
    expect(view.props.onInstall).toHaveBeenCalledTimes(1);
  });
  it("keeps an install failure on the card that failed and names the distributing repository", async () => {
    const wrangler: OfficialSkill = { ...entry, id: "openai-wrangler", publisher: "openai", title: "Cloudflare Wrangler", repository: "openai/plugins", notes: "Authored by Cloudflare and distributed in OpenAI's public repository." };
    invoke.mockResolvedValue([entry, wrangler]);
    downloads({ onInstall: vi.fn(async () => { throw new Error("Download failed"); }) });
    fireEvent.click(await screen.findByRole("button", { name: "Install Cloudflare Wrangler" }));
    const alert = await screen.findByRole("alert");
    const card = alert.closest("li")!;
    expect(card).toHaveTextContent("Cloudflare Wrangler");
    expect(card).toHaveTextContent("Authored by Cloudflare");
    expect(screen.getByText("OpenAI")).toHaveAttribute("title", "Distributed in OpenAI's public repository openai/plugins");
    expect(screen.getByRole("button", { name: "openai/plugins source for Cloudflare Wrangler" })).toBeInTheDocument();
    expect(screen.getByText("Frontend design").closest("li")).not.toContainElement(alert);
  });
  it("explains requirements only for skills that declare them, without installing anything", async () => {
    const testing: OfficialSkill = { ...entry, id: "anthropic-webapp-testing", title: "Web app testing", notes: "Published by Anthropic.", requirements: "Requires Python and Playwright with its browser installation." };
    invoke.mockResolvedValue([entry, testing]);
    const view = downloads();
    const info = await screen.findByRole("button", { name: "Requirements for Web app testing" });
    expect(screen.queryByRole("button", { name: "Requirements for Frontend design" })).toBeNull();
    expect(screen.getByText("Published by Anthropic.")).toBeVisible();
    expect(info).toHaveAttribute("aria-expanded", "false");
    fireEvent.focus(info);
    const panel = screen.getByRole("tooltip");
    expect(panel).toBeVisible();
    expect(panel).toHaveTextContent("Requires Python and Playwright");
    expect(panel).toHaveTextContent(/not its tools.*model can install the tools it needs if your permission settings allow/);
    expect(panel).toHaveTextContent(/API keys and other credentials are never set up for you\. Connect them yourself\./);
    expect(info).toHaveAccessibleDescription(expect.stringContaining("Requires Python and Playwright"));
    fireEvent.click(info);
    fireEvent.keyDown(info, { key: "Escape" });
    expect(panel).not.toBeVisible();
    expect(view.props.onInstall).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("textbox", { name: "Search downloadable skills" }), { target: { value: "playwright" } });
    expect(screen.getByRole("button", { name: "Install Web app testing" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install Frontend design" })).toBeNull();
  });
  it("counts installed packages and clears the download search", async () => {
    downloads({ skills: [managed] });
    expect(await screen.findByText("1 of 1 in your folder")).toBeInTheDocument();
    const search = screen.getByRole("textbox", { name: "Search downloadable skills" });
    fireEvent.change(search, { target: { value: "missing" } });
    expect(screen.getByText("0 of 1 shown")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear downloadable skill search" }));
    expect(search).toHaveValue("");
    expect(screen.getByText("Installed")).toBeInTheDocument();
  });
  it("offers an original copy for modified packages and switches to installed only after a healthy scan", async () => {
    const modified = { ...managed, source: { ...managed.source!, modified: true } };
    const view = downloads({ skills: [modified] });
    const install = await screen.findByRole("button", { name: "Install original copy of Frontend design" });
    expect(screen.queryByText("Installed")).toBeNull();
    fireEvent.click(install);
    await waitFor(() => expect(view.props.onInstall).toHaveBeenCalledWith(entry.id, "/skills"));
    view.rerender(<OfficialSkillDownloads {...view.props} skills={[{ ...modified, enabled: false }, { ...managed, path: "/skills/design-2/SKILL.md" }]} />);
    expect(screen.getByText("Installed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install original copy of Frontend design" })).toBeNull();
  });
  it("requires an explicit folder selection and supports search", async () => {
    const view = downloads({ folder: "" });
    expect(await screen.findByRole("button", { name: "Install Frontend design" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Choose folder to install skills" }));
    expect(view.props.onChooseFolder).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("textbox", { name: "Search downloadable skills" }), { target: { value: "missing" } });
    expect(screen.getByText("No downloadable skills match your search.")).toBeInTheDocument();
  });
  it("ignores install errors after switching folders", async () => {
    let fail!: (reason: Error) => void;
    const view = downloads({ onInstall: vi.fn(() => new Promise<string>((_resolve, reject) => { fail = reject; })) });
    fireEvent.click(await screen.findByRole("button", { name: "Install Frontend design" }));
    view.rerender(<OfficialSkillDownloads {...view.props} folder="/different" />);
    fail(new Error("Old folder download failed"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Install Frontend design" })).toBeEnabled());
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("opens publisher skills read-only with source details and no save action", async () => {
    const view = library();
    fireEvent.click(screen.getByRole("button", { name: "View design skill" }));
    const field = await screen.findByRole("textbox", { name: "Markdown for design" });
    await waitFor(() => expect(field).toHaveValue("# Design\n"));
    expect(field).toHaveAttribute("readonly");
    expect(screen.getByRole("dialog", { name: "View @design" })).toHaveTextContent("Apache-2.0");
    expect(screen.getByRole("dialog")).toHaveTextContent("abc123");
    expect(screen.queryByRole("button", { name: "Save skill" })).toBeNull();
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true, metaKey: true });
    expect(view.props.onUpdate).not.toHaveBeenCalled();
  });
  it("keeps custom skills editable and closes stale source previews on folder change", async () => {
    const custom = { ...managed, source: undefined };
    const view = library({ skills: [custom] });
    fireEvent.click(screen.getByRole("button", { name: "Edit design skill" }));
    const field = await screen.findByRole("textbox", { name: "Markdown for design" });
    await waitFor(() => expect(field).toHaveValue("# Design\n"));
    expect(field).not.toHaveAttribute("readonly");
    fireEvent.change(field, { target: { value: "# Custom revision\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save skill" }));
    await waitFor(() => expect(view.props.onUpdate).toHaveBeenCalledWith(custom.path, "# Custom revision\n", "# Design\n"));
    fireEvent.click(screen.getByRole("button", { name: "Edit design skill" }));
    view.rerender(<SkillLibrary {...view.props} folder="/different" skills={[]} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
