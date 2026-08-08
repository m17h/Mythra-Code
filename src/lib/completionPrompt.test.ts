import { describe, expect, it } from "vitest";
import {
  OPENKIWI_COMPLETION_INSTRUCTIONS,
  OPENKIWI_DELEGATION_INSTRUCTIONS,
  OPENKIWI_SUBAGENT_SETTINGS_INSTRUCTIONS,
  openKiwiDeveloperInstructions,
  withOpenKiwiCompletionInstructions,
} from "./completionPrompt";

describe("OpenKiwi completion instructions", () => {
  it("provides a useful completion summary even without a user system prompt", () => {
    expect(withOpenKiwiCompletionInstructions("")).toBe(OPENKIWI_COMPLETION_INSTRUCTIONS);
  });

  it("preserves the user system prompt before the internal completion guidance", () => {
    expect(withOpenKiwiCompletionInstructions("  Follow the project style.  ")).toBe(
      `Follow the project style.\n\n${OPENKIWI_COMPLETION_INSTRUCTIONS}`,
    );
  });

  it("makes OpenKiwi the authoritative sub-agent route when its bridge is active", () => {
    expect(openKiwiDeveloperInstructions(true)).toBe(
      `${OPENKIWI_COMPLETION_INSTRUCTIONS}\n\n${OPENKIWI_DELEGATION_INSTRUCTIONS}`,
    );
    expect(withOpenKiwiCompletionInstructions("Follow the project style.", true)).toBe(
      `Follow the project style.\n\n${OPENKIWI_COMPLETION_INSTRUCTIONS}\n\n${OPENKIWI_DELEGATION_INSTRUCTIONS}`,
    );
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
