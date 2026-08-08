import { describe, expect, it } from "vitest";
import {
  OPENKIWI_COMPLETION_INSTRUCTIONS,
  OPENKIWI_DELEGATION_INSTRUCTIONS,
  OPENKIWI_SKILL_MENTION_INSTRUCTIONS,
  OPENKIWI_SUBAGENT_SETTINGS_INSTRUCTIONS,
  openKiwiDeveloperInstructions,
  withOpenKiwiCompletionInstructions,
} from "./completionPrompt";

const ALWAYS_ON = `${OPENKIWI_SKILL_MENTION_INSTRUCTIONS}\n\n${OPENKIWI_COMPLETION_INSTRUCTIONS}`;

describe("OpenKiwi completion instructions", () => {
  it("provides a useful completion summary even without a user system prompt", () => {
    expect(withOpenKiwiCompletionInstructions("")).toBe(ALWAYS_ON);
  });

  it("preserves the user system prompt before the internal completion guidance", () => {
    expect(withOpenKiwiCompletionInstructions("  Follow the project style.  ")).toBe(
      `Follow the project style.\n\n${ALWAYS_ON}`,
    );
  });

  it("makes OpenKiwi the authoritative sub-agent route when its bridge is active", () => {
    expect(openKiwiDeveloperInstructions(true)).toBe(
      `${ALWAYS_ON}\n\n${OPENKIWI_DELEGATION_INSTRUCTIONS}`,
    );
    expect(withOpenKiwiCompletionInstructions("Follow the project style.", true)).toBe(
      `Follow the project style.\n\n${ALWAYS_ON}\n\n${OPENKIWI_DELEGATION_INSTRUCTIONS}`,
    );
    expect(OPENKIWI_DELEGATION_INSTRUCTIONS).toContain("Always interpret a user request");
    expect(OPENKIWI_DELEGATION_INSTRUCTIONS).toContain("use only the delegation tools provided by the OpenKiwi agent bridge");
  });

  it("treats exact @skill tokens as explicit skill requests, and other @words as text", () => {
    // Read at the top of every turn, not buried in the how-to-finish block.
    expect(openKiwiDeveloperInstructions(false).indexOf("exact @name token"))
      .toBeLessThan(openKiwiDeveloperInstructions(false).indexOf("finish completed coding tasks"));
    expect(OPENKIWI_SKILL_MENTION_INSTRUCTIONS).toContain("load and follow that skill");
    expect(OPENKIWI_SKILL_MENTION_INSTRUCTIONS).toContain("never invent a skill");
    expect(OPENKIWI_COMPLETION_INSTRUCTIONS).not.toContain("@name");
  });

  it("does not mention delegation when no OpenKiwi bridge is available", () => {
    expect(openKiwiDeveloperInstructions(false)).not.toContain(OPENKIWI_DELEGATION_INSTRUCTIONS);
  });

  it("can expose project settings proposals without claiming delegation is active", () => {
    const instructions = openKiwiDeveloperInstructions(false, true);
    expect(instructions).toContain(OPENKIWI_SUBAGENT_SETTINGS_INSTRUCTIONS);
    expect(instructions).not.toContain(OPENKIWI_DELEGATION_INSTRUCTIONS);
  });
});
