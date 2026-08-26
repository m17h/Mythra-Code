import { describe, expect, it } from "vitest";
import {
  favoriteCount,
  favoriteModels,
  isFavoriteModel,
  sanitizeModelFavorites,
  sortByFavorites,
  toggleFavoriteModel,
} from "./modelFavorites";

describe("sanitizeModelFavorites", () => {
  it("keeps only known providers and non-empty string ids", () => {
    expect(sanitizeModelFavorites({
      openai: ["gpt-5.6-sol", "  ", 7, "gpt-5.6-terra"],
      claude: "not-an-array",
      mystery: ["x"],
      openrouter: [],
    })).toEqual({ openai: ["gpt-5.6-sol", "gpt-5.6-terra"] });
  });

  it("trims and de-duplicates ids", () => {
    expect(sanitizeModelFavorites({ cursor: [" auto ", "auto", "composer"] }))
      .toEqual({ cursor: ["auto", "composer"] });
  });

  it("returns an empty record for anything that is not an object", () => {
    for (const value of [null, undefined, 4, "x", ["a"]]) {
      expect(sanitizeModelFavorites(value)).toEqual({});
    }
  });
});

describe("toggleFavoriteModel", () => {
  it("stars a model and unstars it again", () => {
    const starred = toggleFavoriteModel({}, "openrouter", "moonshotai/kimi-k2");
    expect(favoriteModels(starred, "openrouter")).toEqual(["moonshotai/kimi-k2"]);
    expect(isFavoriteModel(starred, "openrouter", "moonshotai/kimi-k2")).toBe(true);
    expect(toggleFavoriteModel(starred, "openrouter", "moonshotai/kimi-k2")).toEqual({});
  });

  it("keeps providers independent", () => {
    const first = toggleFavoriteModel({}, "claude", "opus");
    const both = toggleFavoriteModel(first, "cursor", "auto");
    expect(both).toEqual({ claude: ["opus"], cursor: ["auto"] });
    expect(isFavoriteModel(both, "claude", "auto")).toBe(false);
  });

  it("ignores blank identifiers rather than storing an unusable star", () => {
    expect(toggleFavoriteModel({}, "openai", "   ")).toEqual({});
  });

  it("does not mutate the record it was given", () => {
    const original = { openai: ["a"] };
    toggleFavoriteModel(original, "openai", "b");
    expect(original).toEqual({ openai: ["a"] });
  });
});

describe("sortByFavorites", () => {
  const models = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const key = (model: { id: string }) => model.id;

  it("floats starred entries while preserving relative order in both groups", () => {
    expect(sortByFavorites(models, ["c", "b"], key).map(key)).toEqual(["b", "c", "a", "d"]);
  });

  it("returns the original array when nothing is starred", () => {
    expect(sortByFavorites(models, [], key)).toBe(models);
  });

  it("ignores stars for models that are not in the list", () => {
    expect(sortByFavorites(models, ["zzz"], key).map(key)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("favoriteCount", () => {
  const key = (model: { id: string }) => model.id;

  it("counts the leading run of starred entries", () => {
    const sorted = sortByFavorites([{ id: "a" }, { id: "b" }, { id: "c" }], ["b", "c"], key);
    expect(favoriteCount(sorted, ["b", "c"], key)).toBe(2);
  });

  it("is zero when the first entry is not starred", () => {
    expect(favoriteCount([{ id: "a" }, { id: "b" }], ["b"], key)).toBe(0);
  });
});
