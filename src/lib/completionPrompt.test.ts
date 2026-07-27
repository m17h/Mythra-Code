import { describe, expect, it } from "vitest";
import { OPENKIWI_COMPLETION_INSTRUCTIONS, withOpenKiwiCompletionInstructions } from "./completionPrompt";

describe("OpenKiwi completion instructions", () => {
  it("provides a useful completion summary even without a user system prompt", () => {
    expect(withOpenKiwiCompletionInstructions("")).toBe(OPENKIWI_COMPLETION_INSTRUCTIONS);
  });

  it("preserves the user system prompt before the internal completion guidance", () => {
    expect(withOpenKiwiCompletionInstructions("  Follow the project style.  ")).toBe(
      `Follow the project style.\n\n${OPENKIWI_COMPLETION_INSTRUCTIONS}`,
    );
  });
});
