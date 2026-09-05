import { describe, expect, it } from "vitest";
import type { Project } from "../types";
import { reorderProjects, sortProjectsByPin, toggleProjectPinned } from "./projectOrdering";

const projects: Project[] = [
  { id: "alpha", name: "Alpha", path: "/alpha" },
  { id: "beta", name: "Beta", path: "/beta" },
  { id: "gamma", name: "Gamma", path: "/gamma" },
];

/** Two pinned, three unpinned, already in pinned-first order. */
const mixed: Project[] = [
  { id: "pin-1", name: "Pin one", path: "/pin-1", pinned: true },
  { id: "pin-2", name: "Pin two", path: "/pin-2", pinned: true },
  { id: "free-1", name: "Free one", path: "/free-1" },
  { id: "free-2", name: "Free two", path: "/free-2" },
  { id: "free-3", name: "Free three", path: "/free-3" },
];

const ids = (list: Project[]) => list.map((project) => project.id);

describe("sortProjectsByPin", () => {
  it("lifts pinned projects above unpinned ones without shuffling either group", () => {
    expect(ids(sortProjectsByPin([
      { id: "free-1", name: "Free one", path: "/free-1" },
      { id: "pin-1", name: "Pin one", path: "/pin-1", pinned: true },
      { id: "free-2", name: "Free two", path: "/free-2" },
      { id: "pin-2", name: "Pin two", path: "/pin-2", pinned: true },
    ]))).toEqual(["pin-1", "pin-2", "free-1", "free-2"]);
  });

  it("keeps the same list when the order already holds", () => {
    expect(sortProjectsByPin(mixed)).toBe(mixed);
    expect(sortProjectsByPin(projects)).toBe(projects);
  });
});

describe("reorderProjects", () => {
  it("moves a project before or after another project", () => {
    expect(ids(reorderProjects(projects, "alpha", "gamma", "after"))).toEqual(["beta", "gamma", "alpha"]);
    expect(ids(reorderProjects(projects, "gamma", "alpha", "before"))).toEqual(["gamma", "alpha", "beta"]);
  });

  it("leaves the list unchanged for invalid, self-targeted, or no-op moves", () => {
    expect(reorderProjects(projects, "alpha", "alpha", "after")).toBe(projects);
    expect(reorderProjects(projects, "missing", "alpha", "before")).toBe(projects);
    expect(reorderProjects(projects, "alpha", "missing", "before")).toBe(projects);
    expect(reorderProjects(projects, "alpha", "beta", "before")).toBe(projects);
  });

  it("reorders within the pinned group", () => {
    expect(ids(reorderProjects(mixed, "pin-2", "pin-1", "before")))
      .toEqual(["pin-2", "pin-1", "free-1", "free-2", "free-3"]);
  });

  it("reorders within the unpinned group", () => {
    expect(ids(reorderProjects(mixed, "free-3", "free-1", "before")))
      .toEqual(["pin-1", "pin-2", "free-3", "free-1", "free-2"]);
  });

  it("never lets an unpinned project be dragged above a pinned one", () => {
    for (const [target, position] of [["pin-1", "before"], ["pin-1", "after"], ["pin-2", "before"]] as const) {
      expect(ids(reorderProjects(mixed, "free-3", target, position)))
        .toEqual(["pin-1", "pin-2", "free-3", "free-1", "free-2"]);
    }
  });

  it("never lets a pinned project be dragged below an unpinned one", () => {
    for (const [target, position] of [["free-3", "after"], ["free-1", "before"], ["free-2", "after"]] as const) {
      expect(ids(reorderProjects(mixed, "pin-1", target, position)))
        .toEqual(["pin-2", "pin-1", "free-1", "free-2", "free-3"]);
    }
  });

  it("repairs a list saved before pinned-first ordering existed", () => {
    const legacy: Project[] = [
      { id: "free-1", name: "Free one", path: "/free-1" },
      { id: "pin-1", name: "Pin one", path: "/pin-1", pinned: true },
      { id: "free-2", name: "Free two", path: "/free-2" },
    ];
    expect(ids(reorderProjects(legacy, "free-2", "free-1", "before")))
      .toEqual(["pin-1", "free-2", "free-1"]);
  });
});

describe("toggleProjectPinned", () => {
  it("pins a project onto the end of the pinned group, a hop across the boundary", () => {
    expect(ids(toggleProjectPinned(mixed, "free-2")))
      .toEqual(["pin-1", "pin-2", "free-2", "free-1", "free-3"]);
    expect(toggleProjectPinned(mixed, "free-2").find((project) => project.id === "free-2")?.pinned).toBe(true);
  });

  it("unpins a project to the top of the unpinned group", () => {
    expect(ids(toggleProjectPinned(mixed, "pin-1")))
      .toEqual(["pin-2", "pin-1", "free-1", "free-2", "free-3"]);
    expect(toggleProjectPinned(mixed, "pin-1").find((project) => project.id === "pin-1")?.pinned).toBe(false);
  });

  it("ignores an unknown project", () => {
    expect(toggleProjectPinned(mixed, "missing")).toBe(mixed);
  });
});
