import { describe, expect, it } from "vitest";
import {
  basename,
  isAbsolutePath,
  joinPath,
  normalizedProjectPath,
  parentPath,
  pathSegments,
  pathSeparator,
  relativeDisplayPath,
  stripTrailingSeparator,
} from "./paths";

describe("path helpers", () => {
  it("reads the last segment on both platforms", () => {
    expect(basename("/src/app/main.ts")).toBe("main.ts");
    expect(basename("C:\\src\\app\\main.ts")).toBe("main.ts");
  });

  it("keeps each path's own separator", () => {
    expect(pathSeparator("/src/app")).toBe("/");
    expect(pathSeparator("C:\\src\\app")).toBe("\\");
    // A mixed path is already POSIX-normalized somewhere upstream; adding
    // another backslash to it would only deepen the inconsistency.
    expect(pathSeparator("C:\\src/app")).toBe("/");
  });

  it("joins without inventing a foreign separator", () => {
    expect(joinPath("/src/app", "main.ts")).toBe("/src/app/main.ts");
    expect(joinPath("/src/app/", "main.ts")).toBe("/src/app/main.ts");
    expect(joinPath("C:\\src\\app", "main.ts")).toBe("C:\\src\\app\\main.ts");
    expect(joinPath("C:\\", "src")).toBe("C:\\src");
    expect(joinPath("/", "src")).toBe("/src");
  });

  it("strips trailing separators without emptying a root", () => {
    expect(stripTrailingSeparator("/src/app/")).toBe("/src/app");
    expect(stripTrailingSeparator("C:\\src\\app\\")).toBe("C:\\src\\app");
    expect(stripTrailingSeparator("/")).toBe("/");
    expect(stripTrailingSeparator("C:\\")).toBe("C:\\");
  });

  it("recognizes absolute paths from either platform", () => {
    expect(isAbsolutePath("/src/app")).toBe(true);
    expect(isAbsolutePath("C:\\src\\app")).toBe(true);
    expect(isAbsolutePath("c:/src/app")).toBe(true);
    expect(isAbsolutePath("\\\\server\\share")).toBe(true);
    expect(isAbsolutePath("src/app")).toBe(false);
  });

  it("splits segments regardless of separator", () => {
    expect(pathSegments("lib/nested/file.ts")).toEqual(["lib", "nested", "file.ts"]);
    expect(pathSegments("lib\\nested\\file.ts")).toEqual(["lib", "nested", "file.ts"]);
  });

  it("shows a path relative to its root in the root's own style", () => {
    expect(relativeDisplayPath("/src/app", "/src/app/lib/main.ts")).toBe("lib/main.ts");
    expect(relativeDisplayPath("C:\\src\\app", "C:\\src\\app\\lib\\main.ts")).toBe("lib\\main.ts");
    expect(relativeDisplayPath("/src/app", "/src/app")).toBe("");
  });

  it("returns the full path when it is not inside the root", () => {
    // Slicing by root length would otherwise render `/src/apples/x` as a
    // plausible-looking `s/x` inside the project.
    expect(relativeDisplayPath("/src/app", "/src/apples/x.ts")).toBe("/src/apples/x.ts");
  });

  it("walks up to — but never above — a root", () => {
    expect(parentPath("/src/app/lib")).toBe("/src/app");
    expect(parentPath("/src")).toBe("/");
    expect(parentPath("/")).toBeNull();
    expect(parentPath("C:\\src\\app")).toBe("C:\\src");
    expect(parentPath("C:\\src")).toBe("C:\\");
    expect(parentPath("C:\\")).toBeNull();
  });

  it("still normalizes project identity to one canonical form", () => {
    expect(normalizedProjectPath("C:\\src\\app\\")).toBe("C:/src/app");
    expect(normalizedProjectPath("/src/app/")).toBe("/src/app");
  });
});
