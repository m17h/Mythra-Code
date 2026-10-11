import { describe, expect, it } from "vitest";
import { pendingFirstPromptForView, type PendingFirstPrompt } from "./pendingFirstPrompt";

const draft: PendingFirstPrompt = { id: "attempt", workspacePath: "C:/projects/alpha", text: "Start work", status: "starting", provider: "openai", model: "fixture", isolated: false };

describe("pending first prompt view ownership", () => {
  it("shows an unbound prompt only in its originating draft workspace", () => {
    expect(pendingFirstPromptForView([draft], null, "C:\\projects\\alpha", draft.id)).toBe(draft);
    expect(pendingFirstPromptForView([draft], null, "C:\\projects\\alpha")).toBeUndefined();
    expect(pendingFirstPromptForView([draft], null, "C:\\projects\\alpha", "another-attempt")).toBeUndefined();
    expect(pendingFirstPromptForView([draft], null, "C:\\projects\\beta")).toBeUndefined();
    expect(pendingFirstPromptForView([draft], "unrelated", "C:\\projects\\alpha")).toBeUndefined();
  });

  it("follows the assigned conversation identity and never replaces another draft or conversation", () => {
    const created = { ...draft, threadId: "created" };
    expect(pendingFirstPromptForView([created], "created", "C:\\projects\\alpha")).toBe(created);
    expect(pendingFirstPromptForView([created], "created", "C:\\projects\\beta")).toBeUndefined();
    expect(pendingFirstPromptForView([created], null, "C:\\projects\\alpha")).toBeUndefined();
    expect(pendingFirstPromptForView([created], "unrelated", "C:\\projects\\alpha")).toBeUndefined();
  });
});
