import { describe, expect, it } from "vitest";
import { createPullRequestCreationDraftStore, emptyPullRequestCreationDraft } from "./pullRequestCreationDrafts";

describe("session-owned pull request creation drafts", () => {
  it("bounds the store and isolates independent owners", () => {
    const owner = createPullRequestCreationDraftStore(2);
    const draft = { ...emptyPullRequestCreationDraft(), title: "One" };
    owner.write("alpha\0checkout\0first", draft);
    draft.title = "Changed outside the store";
    expect(owner.read("alpha\0checkout\0first")?.title).toBe("One");
    owner.write("alpha\0checkout\0second", emptyPullRequestCreationDraft());
    owner.write("beta\0checkout\0third", emptyPullRequestCreationDraft());
    expect(owner.read("alpha\0checkout\0first")).toBeUndefined();
    expect(createPullRequestCreationDraftStore().read("beta\0checkout\0third")).toBeUndefined();
    owner.forgetThread("alpha");
    expect(owner.read("alpha\0checkout\0second")).toBeUndefined();
    expect(owner.read("beta\0checkout\0third")).toBeDefined();
    owner.clear("beta\0checkout\0third");
    expect(owner.read("beta\0checkout\0third")).toBeUndefined();
  });
});
