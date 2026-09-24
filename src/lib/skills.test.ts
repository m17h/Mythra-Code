import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { normalizeSkillName, resolveLocalSkills, resolveSkillPrompt, skillRuntimeSignature, type LocalSkillFile } from "./skills";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const file = (path: string, defaultName: string): LocalSkillFile => ({
  path,
  relativePath: path.split("/").at(-1) || path,
  fileName: path.split("/").at(-1) || path,
  defaultName,
  description: "A local workflow",
  supportingMarkdownCount: 0,
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
});
