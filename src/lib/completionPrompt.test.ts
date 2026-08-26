import { describe, expect, it } from "vitest";
import {
  MYTHRA_CODE_COMPLETION_INSTRUCTIONS,
  MYTHRA_CODE_DELEGATION_INSTRUCTIONS,
  MYTHRA_CODE_SKILL_MENTION_INSTRUCTIONS,
  MYTHRA_CODE_SUBAGENT_SETTINGS_INSTRUCTIONS,
  mythraCodeDeveloperInstructions,
  withMythraCodeCompletionInstructions,
} from "./completionPrompt";

const ALWAYS_ON = `${MYTHRA_CODE_SKILL_MENTION_INSTRUCTIONS}\n\n${MYTHRA_CODE_COMPLETION_INSTRUCTIONS}`;

describe("Mythra Code completion instructions", () => {
  it("provides a useful completion summary even without a user system prompt", () => {
    expect(withMythraCodeCompletionInstructions("")).toBe(ALWAYS_ON);
  });

  it("preserves the user system prompt before the internal completion guidance", () => {
    expect(withMythraCodeCompletionInstructions("  Follow the project style.  ")).toBe(
      `Follow the project style.\n\n${ALWAYS_ON}`,
    );
  });

  it("makes Mythra Code the authoritative sub-agent route when its bridge is active", () => {
    expect(mythraCodeDeveloperInstructions(true)).toBe(
      `${ALWAYS_ON}\n\n${MYTHRA_CODE_DELEGATION_INSTRUCTIONS}`,
    );
    expect(withMythraCodeCompletionInstructions("Follow the project style.", true)).toBe(
      `Follow the project style.\n\n${ALWAYS_ON}\n\n${MYTHRA_CODE_DELEGATION_INSTRUCTIONS}`,
    );
    expect(MYTHRA_CODE_DELEGATION_INSTRUCTIONS).toContain("Always interpret a user request");
    expect(MYTHRA_CODE_DELEGATION_INSTRUCTIONS).toContain("use only the mythra_agents MCP bridge tools");
    expect(MYTHRA_CODE_DELEGATION_INSTRUCTIONS).toContain("spawn_mythra_agent");
    expect(MYTHRA_CODE_DELEGATION_INSTRUCTIONS).toContain("mcp__mythra_agents__<tool>");
    expect(MYTHRA_CODE_DELEGATION_INSTRUCTIONS).toContain("Provider-native task, team, and agent-spawning features are not allowed");
  });

  it("treats exact @skill tokens as explicit skill requests, and other @words as text", () => {
    // Read at the top of every turn, not buried in the how-to-finish block.
    expect(mythraCodeDeveloperInstructions(false).indexOf("exact @name token"))
      .toBeLessThan(mythraCodeDeveloperInstructions(false).indexOf("finish completed coding tasks"));
    expect(MYTHRA_CODE_SKILL_MENTION_INSTRUCTIONS).toContain("load and follow that skill");
    expect(MYTHRA_CODE_SKILL_MENTION_INSTRUCTIONS).toContain("never invent a skill");
    expect(MYTHRA_CODE_COMPLETION_INSTRUCTIONS).not.toContain("@name");
  });

  it("does not mention delegation when no Mythra Code bridge is available", () => {
    expect(mythraCodeDeveloperInstructions(false)).not.toContain(MYTHRA_CODE_DELEGATION_INSTRUCTIONS);
  });

  it("can expose project settings proposals without claiming delegation is active", () => {
    const instructions = mythraCodeDeveloperInstructions(false, true);
    expect(instructions).toContain(MYTHRA_CODE_SUBAGENT_SETTINGS_INSTRUCTIONS);
    expect(instructions).not.toContain(MYTHRA_CODE_DELEGATION_INSTRUCTIONS);
  });
});
