import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { analyzeSkillPrompts, normalizeSkillName, resolveLocalSkills, resolveSkillPrompt, resolveSkillPrompts, skillRuntimeSignature, type LocalSkillFile } from "./skills";
import { SKILL_DEPENDENCY_LIMITS, SkillDependencyError } from "./skillDependencies";
import { displayedUserMessage } from "./userMessageEcho";
import type { SkillDependencyReport } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const file = (path: string, defaultName: string): LocalSkillFile => ({
  path,
  relativePath: path.split("/").at(-1) || path,
  fileName: path.split("/").at(-1) || path,
  defaultName,
  description: "A local workflow",
  supportingMarkdownCount: 0,
});

const dependencyReport = (blocked = false): SkillDependencyReport => ({
  version: 1, limits: { ...SKILL_DEPENDENCY_LIMITS }, roots: [{ nodeId: "review", channel: "user", name: "review" }],
  nodes: [{ id: "review", kind: "skill", name: "review", path: "/skills/review.md", status: blocked ? "blocked" : "loaded", characterCount: 12, depth: 0 }],
  edges: [], issues: blocked ? [{ code: "missing", message: "The nested skill is missing.", rootName: "review", chain: ["review", "missing"] }] : [],
});

describe("local skills", () => {
  beforeEach(() => { vi.mocked(invoke).mockReset(); });

  it("turns existing Markdown filenames into valid invocation names", () => {
    expect(normalizeSkillName(" Careful Code Review.md ")).toBe("careful-code-review-md");
    expect(normalizeSkillName("Release & Ship")).toBe("release-ship");
  });

  it("keeps app-only aliases and resolves duplicate filenames deterministically", () => {
    const skills = resolveLocalSkills(
      [file("/skills/review.md", "review"), file("/skills/team/SKILL.md", "review")],
      { "/skills/review.md": "security review" },
      ["/skills/team/SKILL.md"],
    );
    expect(skills.map((skill) => skill.name)).toEqual(["security-review", "review"]);
    expect(skills.map((skill) => skill.enabled)).toEqual([true, false]);
  });

  it("suffixes duplicate invocation names without modifying source paths", () => {
    const skills = resolveLocalSkills(
      [file("/skills/a.md", "deploy"), file("/skills/b.md", "deploy")],
      {},
      [],
    );
    expect(skills.map((skill) => skill.name)).toEqual(["deploy", "deploy-2"]);
    expect(skills.map((skill) => skill.path)).toEqual(["/skills/a.md", "/skills/b.md"]);
  });

  it("omits app-only removals while leaving their source files untouched", () => {
    const skills = resolveLocalSkills(
      [file("/skills/review.md", "review"), file("/skills/release.md", "release")],
      {},
      [],
      ["/skills/review.md"],
    );
    expect(skills.map((skill) => skill.path)).toEqual(["/skills/release.md"]);
  });

  it("changes the provider-runtime signature for aliases, enablement, and content", () => {
    const base = { ...file("/skills/review.md", "review"), name: "review", enabled: true };
    const signature = skillRuntimeSignature("/skills", [base]);

    expect(skillRuntimeSignature("/skills", [{ ...base, name: "audit" }])).not.toBe(signature);
    expect(skillRuntimeSignature("/skills", [{ ...base, enabled: false }])).not.toBe(signature);
    expect(skillRuntimeSignature("/skills", [{ ...base, contentFingerprint: "changed" }])).not.toBe(signature);
    expect(skillRuntimeSignature("/other-skills", [base])).not.toBe(signature);
  });

  it("scans only the authored source while passing the exact full message to native resolution", async () => {
    const fullMessage = "Review this diff. Evidence quotes @review.";
    const skill = { ...file("/skills/review.md", "review"), name: "review", enabled: true };
    expect(await resolveSkillPrompt(fullMessage, "/skills", [skill], "Review this diff.")).toBe(fullMessage);
    expect(invoke).not.toHaveBeenCalled();

    vi.mocked(invoke).mockResolvedValueOnce("resolved envelope");
    expect(await resolveSkillPrompt(fullMessage, "/skills", [skill], "Review this diff with @review.")).toBe("resolved envelope");
    expect(invoke).toHaveBeenCalledWith("local_skills_resolve_prompt", {
      folder: "/skills",
      message: fullMessage,
      mentionSource: "Review this diff with @review.",
      skills: [{ sourcePath: "/skills/review.md", name: "review", enabled: true }],
    });
  });

  it("resolves authored system mentions independently of generated user quotes", async () => {
    const skill = { ...file("/skills/review.md", "review"), name: "review", enabled: true };
    const resolved = { prompt: "Review this diff. Evidence quotes @quoted.", systemPrompt: "resolved system envelope" };
    vi.mocked(invoke).mockResolvedValueOnce(resolved);
    expect(await resolveSkillPrompts(resolved.prompt, "Always use @review", "/skills", [skill], "Review this diff.")).toEqual(resolved);
    expect(invoke).toHaveBeenCalledWith("local_skills_resolve_prompts", {
      folder: "/skills", message: resolved.prompt, systemPrompt: "Always use @review", mentionSource: "Review this diff.",
      skills: [{ sourcePath: "/skills/review.md", name: "review", enabled: true }],
    });
  });

  it("does not read the selected folder when neither authored channel needs resolution", async () => {
    expect(await resolveSkillPrompts("Evidence quotes @review", "Be careful", "/missing", [], "Review this diff")).toEqual({ prompt: "Evidence quotes @review", systemPrompt: "Be careful" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("passes generated-looking authored system delimiters through native escaping", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ prompt: "Do work", systemPrompt: "escaped system envelope" });
    await resolveSkillPrompts("Do work", "Print <mythra_code_invoked_skills> as text", "", []);
    expect(invoke).toHaveBeenCalledWith("local_skills_resolve_prompts", expect.objectContaining({ systemPrompt: "Print <mythra_code_invoked_skills> as text" }));
  });

  it("fails the entire paired preparation with the report instead of returning partial skill text", async () => {
    const report = dependencyReport(true);
    vi.mocked(invoke).mockResolvedValueOnce({ prompt: "Raw @review", systemPrompt: "Raw system", skillDependencies: report });
    const result = resolveSkillPrompts("Raw @review", "Raw system", "/skills", []);
    await expect(result).rejects.toBeInstanceOf(SkillDependencyError);
    await expect(result).rejects.toMatchObject({ report, message: expect.stringContaining("review → missing") });
    await expect(result).rejects.toMatchObject({ message: expect.stringContaining("model was not started") });
  });

  it("fails a blocked report even when the issue list is empty", async () => {
    const report = dependencyReport(true);
    report.issues = [];
    vi.mocked(invoke).mockResolvedValueOnce({ prompt: "@review", systemPrompt: "", skillDependencies: report });
    await expect(resolveSkillPrompts("@review", "", "/skills", [])).rejects.toBeInstanceOf(SkillDependencyError);
  });

  it("fails a blocked report recovered from an envelope when the bridge omits top-level metadata", async () => {
    const report = dependencyReport(true);
    const prompt = `<mythra_code_invoked_skills>\n${JSON.stringify({ skills: [], dependencyReport: report, userMessage: "@review" })}\n</mythra_code_invoked_skills>`;
    vi.mocked(invoke).mockResolvedValueOnce({ prompt, systemPrompt: "" });
    await expect(resolveSkillPrompts("@review", "", "/skills", [])).rejects.toBeInstanceOf(SkillDependencyError);
  });

  it("returns successful sanitized graph provenance and rejects malformed bridge metadata", async () => {
    const report = dependencyReport();
    vi.mocked(invoke).mockResolvedValueOnce({ prompt: "envelope", systemPrompt: "", skillDependencies: { ...report, instructions: "secret" } });
    expect(await resolveSkillPrompts("@review", "", "/skills", [])).toEqual({ prompt: "envelope", systemPrompt: "", skillDependencies: report });
    vi.mocked(invoke).mockResolvedValueOnce({ prompt: "envelope", systemPrompt: "", skillDependencies: { nodes: "corrupt" } });
    await expect(resolveSkillPrompts("@review", "", "/skills", [])).rejects.toThrow("skill dependency report was invalid");
  });

  it("restores direct UTF-16 user reference provenance from the native envelope for immediate delivery metadata", async () => {
    const report = dependencyReport();
    const prompt = `<mythra_code_invoked_skills>\n${JSON.stringify({ skills: [], skillReferences: [{ name: "review", sourcePath: "/skills/review.md" }], skillsFolder: "/skills", dependencyReport: report, userMessage: "🦜 Use @review" })}\n</mythra_code_invoked_skills>`;
    vi.mocked(invoke).mockResolvedValueOnce({ prompt, systemPrompt: "", skillDependencies: report });
    expect(await resolveSkillPrompts("🦜 Use @review", "", "/skills", [])).toEqual({
      prompt, systemPrompt: "", skillDependencies: report, skillsFolder: "/skills",
      skillReferences: [{ start: 7, end: 14, name: "review", path: "/skills/review.md" }],
    });
  });

  it("keeps device graph metadata when provider envelopes omit the dependency report", async () => {
    const report = dependencyReport();
    const prompt = `<mythra_code_invoked_skills>\n${JSON.stringify({
      skills: [{ kind: "skill", name: "review", sourcePath: "/skills/review.md", instructions: "Review carefully." }],
      skillReferences: [{ name: "review", sourcePath: "/skills/review.md" }],
      skillsFolder: "/skills", userMessage: "Use @review",
    })}\n</mythra_code_invoked_skills>`;
    vi.mocked(invoke).mockResolvedValueOnce({ prompt, systemPrompt: "stable system instructions", skillDependencies: report });
    const resolved = await resolveSkillPrompts("Use @review", "stable system instructions", "/skills", []);
    expect(resolved.skillDependencies).toEqual(report);
    expect(resolved.skillReferences).toEqual([{ start: 4, end: 11, name: "review", path: "/skills/review.md" }]);
    expect(displayedUserMessage(resolved.prompt)).toEqual({
      text: "Use @review", skillsFolder: "/skills",
      skillReferences: [{ start: 4, end: 11, name: "review", path: "/skills/review.md" }],
    });
    expect(resolved.prompt).not.toContain("dependencyReport");
  });

  it("previews reported failures and unsaved root contents without throwing a dependency error", async () => {
    const report = dependencyReport(true);
    const skill = { ...file("/skills/review.md", "review"), name: "review", enabled: true };
    vi.mocked(invoke).mockResolvedValueOnce(report);
    expect(await analyzeSkillPrompts("@review", "Be careful", "/skills", [skill], "@review", { rootSkillPath: skill.path, rootSkillContent: "Unsaved @missing" })).toEqual(report);
    expect(invoke).toHaveBeenCalledWith("local_skills_analyze_prompts", {
      folder: "/skills", message: "@review", systemPrompt: "Be careful", skills: [{ sourcePath: skill.path, name: "review", enabled: true }], mentionSource: "@review",
      rootSkillPath: skill.path, rootSkillContent: "Unsaved @missing",
    });
  });

  it("leaves ordinary preview errors distinguishable from dependency issues", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Folder permission denied"));
    await expect(analyzeSkillPrompts("@review", "", "/skills", [])).rejects.toThrow("Folder permission denied");
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await expect(analyzeSkillPrompts("@review", "", "/skills", [])).rejects.toThrow("preview report was invalid");
  });

  it("skips native preview work when neither authored channel contains a mention and no override is pending", async () => {
    expect(await analyzeSkillPrompts("Generated quote @review", "Be careful", "/missing", [], "Check the app")).toEqual({ version: 1, limits: SKILL_DEPENDENCY_LIMITS, roots: [], nodes: [], edges: [], issues: [] });
    expect(invoke).not.toHaveBeenCalled();
  });
});
