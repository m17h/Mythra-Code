import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const {
  fetchOpenRouterCatalog,
  filterOpenRouterModels,
  looksLikeModelSlug,
  matchesOpenRouterQuery,
  mergeOpenRouterModels,
  parseOpenRouterCatalog,
  parseOpenRouterSlugResponse,
  resolveOpenRouterSlug,
} = await import("./openRouterCatalog");

const model = (id: string, name = id, description = "") => ({ id, name, description });

beforeEach(() => {
  invoke.mockReset();
});

describe("looksLikeModelSlug", () => {
  it("accepts author/slug with an optional variant suffix", () => {
    expect(looksLikeModelSlug("moonshotai/kimi-k2")).toBe(true);
    expect(looksLikeModelSlug("z-ai/glm-5.2:free")).toBe(true);
  });

  it("rejects bare words and partial paths", () => {
    for (const value of ["kimi", "moonshotai/", "/kimi", "a b/c", "a/b/c", ""]) {
      expect(looksLikeModelSlug(value)).toBe(false);
    }
  });
});

describe("matchesOpenRouterQuery", () => {
  const entry = model("anthropic/claude-sonnet-5", "Anthropic: Claude Sonnet 5", "Efficient for routine tasks");

  it("requires every token, across name, id, and description", () => {
    expect(matchesOpenRouterQuery(entry, "anthropic sonnet")).toBe(true);
    expect(matchesOpenRouterQuery(entry, "sonnet routine")).toBe(true);
    expect(matchesOpenRouterQuery(entry, "sonnet opus")).toBe(false);
  });

  it("matches everything for an empty query", () => {
    expect(matchesOpenRouterQuery(entry, "   ")).toBe(true);
  });
});

describe("filterOpenRouterModels", () => {
  // A truncated result list is indistinguishable from a missing model, which
  // is the one failure the picker must not have.
  it("never truncates its matches", () => {
    const many = Array.from({ length: 250 }, (_, index) => model(`vendor/model-${index}`));
    expect(filterOpenRouterModels(many, "vendor")).toHaveLength(250);
  });

  it("finds a model far down a large catalog", () => {
    const many = Array.from({ length: 400 }, (_, index) => model(`vendor/model-${index}`));
    expect(filterOpenRouterModels(many, "model-399").map((entry) => entry.id)).toEqual(["vendor/model-399"]);
  });

  it("promotes an exact slug match to the front", () => {
    const models = [model("vendor/kimi-k2-thinking"), model("vendor/kimi-k2")];
    expect(filterOpenRouterModels(models, "vendor/kimi-k2")[0].id).toBe("vendor/kimi-k2");
  });

  it("returns the original list for an empty query", () => {
    const models = [model("a/b")];
    expect(filterOpenRouterModels(models, "  ")).toBe(models);
  });
});

describe("mergeOpenRouterModels", () => {
  it("adds unknown models and keeps existing ones", () => {
    const merged = mergeOpenRouterModels([model("a/one", "One")], [model("a/one", "Renamed"), model("b/two", "Two")]);
    expect(merged.map((entry) => entry.id)).toEqual(["a/one", "b/two"]);
    expect(merged.find((entry) => entry.id === "a/one")?.name).toBe("One");
  });

  it("returns the same array when there is nothing new", () => {
    const base = [model("a/one")];
    expect(mergeOpenRouterModels(base, [model("a/one")])).toBe(base);
  });
});

describe("parseOpenRouterCatalog", () => {
  it("drops entries without an id and sorts by display name", () => {
    expect(parseOpenRouterCatalog({
      data: [{ id: "", name: "Nameless" }, { id: "z/one", name: "Zeta" }, { id: "a/two", name: "Alpha" }],
    }).map((entry) => entry.id)).toEqual(["a/two", "z/one"]);
  });

  it("falls back to the id when a model has no name", () => {
    expect(parseOpenRouterCatalog({ data: [{ id: "a/two" }] })[0].name).toBe("a/two");
  });

  it("returns an empty list for a malformed payload", () => {
    expect(parseOpenRouterCatalog({ data: "nope" })).toEqual([]);
    expect(parseOpenRouterCatalog(null)).toEqual([]);
  });
});

describe("parseOpenRouterSlugResponse", () => {
  it("takes the widest context length the endpoints report", () => {
    const parsed = parseOpenRouterSlugResponse({
      data: {
        id: "moonshotai/kimi-k2",
        name: "Kimi K2",
        endpoints: [
          { context_length: 63_000, supported_parameters: ["tools"] },
          { context_length: 131_072, supported_parameters: ["reasoning"] },
        ],
      },
    });
    expect(parsed?.context_length).toBe(131_072);
    expect(parsed?.supported_parameters).toEqual(expect.arrayContaining(["tools", "reasoning"]));
  });

  it("returns null when the response carries no model", () => {
    expect(parseOpenRouterSlugResponse({ data: {} })).toBeNull();
  });
});

describe("fetchOpenRouterCatalog", () => {
  it("requests the complete account catalog without a client-side limit", async () => {
    invoke.mockResolvedValue({ data: [{ id: "a/one", name: "One" }] });
    await fetchOpenRouterCatalog();
    expect(invoke).toHaveBeenCalledWith("list_openrouter_models");
  });
});

describe("resolveOpenRouterSlug", () => {
  it("returns a verified model when OpenRouter knows the slug", async () => {
    invoke.mockResolvedValue({ data: { id: "moonshotai/kimi-k2", name: "Kimi K2" } });
    await expect(resolveOpenRouterSlug("moonshotai/kimi-k2")).resolves.toEqual({
      model: { id: "moonshotai/kimi-k2", name: "Kimi K2" },
      verified: true,
    });
  });

  // OpenRouter can route to models its catalog endpoints do not describe, so a
  // failed lookup must not block the user from using the slug.
  it("still yields an unverified entry when the lookup fails", async () => {
    invoke.mockRejectedValue(new Error("404"));
    await expect(resolveOpenRouterSlug("vendor/unlisted")).resolves.toEqual({
      model: { id: "vendor/unlisted", name: "vendor/unlisted" },
      verified: false,
    });
  });

  it("ignores anything that is not a slug", async () => {
    await expect(resolveOpenRouterSlug("kimi")).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});
