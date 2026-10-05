import { describe, expect, it } from "vitest";
import { formatGitError, formatSkillFileError, friendlyError, GIT_ERROR_MAX_LENGTH, isAuthenticationError, safeErrorText } from "./errors";
import { SKILL_DEPENDENCY_LIMITS, SkillDependencyError } from "./skillDependencies";

it("formats unreadable thrown values without failing the recovery surface", () => {
  const unreadableError = Object.defineProperty(new Error(), "message", { get() { throw new Error("message getter failed"); } });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const reason of [null, undefined, { toString() { throw new Error("coercion failed"); } }, unreadableError, revoked.proxy]) {
    expect(safeErrorText(reason)).toBe("Unknown error");
    expect(friendlyError(reason)).toBe("Unknown error");
    expect(formatGitError(reason)).toMatch(/Git operation failed without details/);
    expect(formatSkillFileError(reason)).toMatch(/skill file operation failed without details/);
    expect(isAuthenticationError(reason)).toBe(false);
  }
  expect(safeErrorText("start\n" + "x".repeat(40_000) + "\nrecovery instructions").length).toBeLessThanOrEqual(GIT_ERROR_MAX_LENGTH);
});

describe("friendlyError", () => {
  it.each(["permission denied", "no such file or directory", "operation timed out"])("preserves the dependency reason chain for %s", (message) => {
    const error = new SkillDependencyError({
      version: 1,
      limits: { ...SKILL_DEPENDENCY_LIMITS },
      roots: [],
      nodes: [],
      edges: [],
      issues: [{ code: "read-failed", message, chain: ["review", "guide.md"] }],
    });

    expect(friendlyError(error)).toBe(error.message);
    expect(friendlyError(error)).toContain("review → guide.md");
    expect(friendlyError(error)).toContain("Skills were not loaded and the model was not started.");
  });

  it("turns protocol capability failures into recovery guidance", () => {
    expect(friendlyError("thread/resume.runtimeWorkspaceRoots requires experimentalApi capability"))
      .toMatch(/reconnect.*Restart the runtime/i);
  });

  it("turns missing runtime failures into setup guidance", () => {
    expect(friendlyError("Could not start codex app-server: No such file or directory"))
      .toBe("The Codex runtime could not be found. Install the official Codex CLI, then try again.");
  });

  it("keeps a missing skill path instead of calling it a missing Codex runtime", () => {
    expect(friendlyError("Could not prepare Codex skill @tests: references/checklist.txt: No such file or directory"))
      .toBe("Could not prepare Codex skill @tests: references/checklist.txt: No such file or directory");
  });

  it("removes noisy transport prefixes from unknown errors", () => {
    expect(friendlyError("App Server error: useful detail")).toBe("useful detail");
  });
});

describe("formatGitError", () => {
  it.each([
    ["commit timeout", "Git operation timed out\n\nHEAD is now abc1234. A commit may already have been saved. Refresh and inspect it before trying another commit."],
    ["repository creation timeout", "GitHub repository creation timed out. It may have completed on GitHub; check your account before trying Create again."],
    ["created but not attached", "GitHub repository created at https://github.com/owner/name.git, but it could not be attached to this project. error: could not lock config file .git/config: Permission denied Use Attach remote with this URL to finish connecting it. No commits were uploaded."],
    ["push rejection", "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository."],
    ["not a repository", "fatal: not a git repository (or any of the parent directories): .git"],
  ])("keeps native recovery guidance for %s", (_label, message) => {
    // The runtime-oriented mapping would replace each of these with unrelated advice.
    expect(friendlyError(new Error(message))).not.toBe(message);
    expect(formatGitError(new Error(message))).toBe(message);
    expect(formatGitError(message)).toBe(message);
  });

  it("keeps the exact missing project folder path", () => {
    const message = "Could not open the project folder: No such file or directory (os error 2)";
    expect(formatGitError(new Error(message))).toBe(message);
  });

  it("drops only a transport prefix and falls back for empty failures", () => {
    expect(formatGitError(new Error("Error: fatal: bad revision"))).toBe("fatal: bad revision");
    for (const empty of [new Error(""), "   ", null, undefined]) expect(formatGitError(empty)).toMatch(/Git operation failed.*Refresh/);
  });

  // Mirrors native errors: up to 512 KiB of hook/Git stderr, then the footer
  // `commit_sync_with_timeout` or `github_creation_attachment_error` appends.
  const hookOutput = (lines: number) => Array.from({ length: lines }, (_, index) =>
    `src/module-${index}.ts:${index + 1}:7  error  'value' is assigned a value but never used  @typescript-eslint/no-unused-vars`).join("\n");
  const unpaired = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it("keeps a saved-commit recovery footer after long hook stderr", () => {
    const footer = `HEAD is now ${"b".repeat(40)}. A commit may already have been saved. Refresh and inspect it before trying another commit.`;
    const native = `husky - pre-commit hook output follows\n${hookOutput(4_000)}\nGit output was truncated.\n\n\n${footer}`;
    expect(native.length).toBeGreaterThan(300_000);
    const formatted = formatGitError(new Error(native));
    expect(formatted.length).toBeLessThanOrEqual(GIT_ERROR_MAX_LENGTH);
    expect(formatted.startsWith("husky - pre-commit hook output follows")).toBe(true);
    expect(formatted.endsWith(footer)).toBe(true);
    expect(formatted).toMatch(/\[\d[\d,]* characters of Git output omitted\]/);
  });

  it("keeps both a created repository URL and its attach instruction around long detail", () => {
    const native = `GitHub repository created at https://github.com/owner/fresh.git, but it could not be attached to this project. ${hookOutput(3_000)} Use Attach remote with this URL to finish connecting it. No commits were uploaded.`;
    const formatted = formatGitError(native);
    expect(formatted.length).toBeLessThanOrEqual(GIT_ERROR_MAX_LENGTH);
    expect(formatted).toContain("GitHub repository created at https://github.com/owner/fresh.git, but it could not be attached");
    expect(formatted).toContain("Use Attach remote with this URL to finish connecting it. No commits were uploaded.");
  });

  it("never splits a surrogate pair at either cut", () => {
    for (let shift = 0; shift < 4; shift += 1) {
      const formatted = formatGitError(`${"x".repeat(shift)}${"😀".repeat(20_000)}${"y".repeat(shift)}`);
      expect(formatted.length).toBeLessThanOrEqual(GIT_ERROR_MAX_LENGTH);
      expect(formatted).not.toMatch(unpaired);
    }
  });
});

describe("formatSkillFileError", () => {
  it.each([
    "Could not import /private/source.md: Permission denied. The new file /skills/source-2.md may be incomplete; existing files were not changed.",
    "The source skill uses Windows EFS encryption. The new empty file /skills/source.md was kept; no source contents were written.",
  ])("preserves file-operation recovery details", (message) => {
    expect(formatSkillFileError(new Error(message))).toBe(message);
  });

  it("bounds long failures without losing the recovery tail or giving Git advice", () => {
    const footer = "The new file /skills/source.md may be incomplete; existing files were not changed.";
    const formatted = formatSkillFileError(`Could not import skill: ${"detail\n".repeat(10_000)}${footer}`);
    expect(formatted.length).toBeLessThanOrEqual(GIT_ERROR_MAX_LENGTH);
    expect(formatted).toContain("file-operation output omitted");
    expect(formatted.endsWith(footer)).toBe(true);
    expect(formatSkillFileError(undefined)).toMatch(/Rescan and inspect the skills folder/);
  });
});

it.each(["401 Unauthorized", "refresh_token_reused", "Your token has expired", "Please sign in again"])("recognizes auth rejection: %s", (message) => {
  expect(isAuthenticationError(new Error(message))).toBe(true);
});
it.each(["500 Internal Server Error", "Timed out contacting OAuth server", "Network offline"])("does not sign out on transient failure: %s", (message) => {
  expect(isAuthenticationError(new Error(message))).toBe(false);
});
