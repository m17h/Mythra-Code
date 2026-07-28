import { describe, expect, it } from "vitest";
import type { Project } from "../types";
import { reorderProjects } from "./projectOrdering";

const projects: Project[] = [
  { id: "alpha", name: "Alpha", path: "/alpha" },
  { id: "beta", name: "Beta", path: "/beta" },
  { id: "gamma", name: "Gamma", path: "/gamma" },
];

describe("reorderProjects", () => {
  it("moves a project before or after another project", () => {
    expect(reorderProjects(projects, "alpha", "gamma", "after").map((project) => project.id))
      .toEqual(["beta", "gamma", "alpha"]);
    expect(reorderProjects(projects, "gamma", "alpha", "before").map((project) => project.id))
      .toEqual(["gamma", "alpha", "beta"]);
  });

  it("leaves the list unchanged for invalid or self-targeted moves", () => {
    expect(reorderProjects(projects, "alpha", "alpha", "after")).toBe(projects);
    expect(reorderProjects(projects, "missing", "alpha", "before")).toBe(projects);
  });
});
