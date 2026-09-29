import { describe, expect, it } from "vitest";
import { skillDependencyFixture } from "../test/skillDependencyFixtures";
import { blockedSystemPromptTargets } from "./skillPromptRepair";

const prompts = {
  global: "Use @review.",
  codex: "",
  claude: "",
  provider: "openai" as const,
};

describe("blocked system prompt repair routes", () => {
  it("opens the global prompt containing a blocked nested dependency", () => {
    expect(blockedSystemPromptTargets(skillDependencyFixture(true), prompts)).toEqual([{ layer: "global", name: "review" }]);
  });

  it("offers every active layer that actually authored the broken reference", () => {
    expect(blockedSystemPromptTargets(skillDependencyFixture(true), {
      ...prompts, provider: "claude", claude: "Check @review before answering.", project: "Use @review here too.", projectMode: "append",
    })).toEqual([
      { layer: "project", name: "review" },
      { layer: "claude", name: "review" },
      { layer: "global", name: "review" },
    ]);
  });

  it("does not route to inherited prompts suppressed by project replacement", () => {
    expect(blockedSystemPromptTargets(skillDependencyFixture(true), {
      ...prompts, codex: "Use @review.", project: "Use @review.", projectMode: "replace",
    })).toEqual([{ layer: "project", name: "review" }]);
  });

  it("does not route user-only failures or text that is not a skill mention", () => {
    const userOnly = skillDependencyFixture(true);
    userOnly.roots[0].channel = "user";
    expect(blockedSystemPromptTargets(userOnly, prompts)).toEqual([]);
    expect(blockedSystemPromptTargets(skillDependencyFixture(true), {
      ...prompts, global: "email me at person@review.test or open /tmp/@review/file",
    })).toEqual([]);
  });

  it("does not offer a prompt editor for a ready graph", () => {
    expect(blockedSystemPromptTargets(skillDependencyFixture(), prompts)).toEqual([]);
  });
});
