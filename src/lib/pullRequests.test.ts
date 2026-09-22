import { describe, expect, it } from "vitest";
import { parsePullRequestReference } from "./pullRequests";

describe("pull request identities", () => {
  it("resolves numbers only in an explicit project repository", () => {
    expect(parsePullRequestReference("#42", "owner/project")).toEqual({ repository: "owner/project", number: 42 });
    expect(parsePullRequestReference("42")).toBeNull();
  });
  it("keeps the target repository of a fork PR rather than the local origin", () => {
    expect(parsePullRequestReference("https://github.com/upstream/project/pull/9/files#diff", "me/fork"))
      .toEqual({ repository: "upstream/project", number: 9 });
  });
  it.each(["0", "-1", "1.2", "#0", "9007199254740992", "--repo evil", "https://github.com.evil/a/b/pull/1", "https://github.com/a/b/issues/1", "https://github.com/a/b/pull/12oops", "https://other.test/a/b/pull/1"])("rejects ambiguous or invalid input %s", (value) => {
    expect(parsePullRequestReference(value, "owner/project")).toBeNull();
  });
});
