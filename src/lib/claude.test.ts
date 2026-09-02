import { describe, expect, it } from "vitest";
import { isClaudeModelSuperseded, parseClaudeModelCatalog, parseClaudeUsageLimits, visibleClaudeModels } from "./claude";

describe("Claude subscription usage", () => {
  it("normalizes Claude's structured usage windows", () => {
    expect(parseClaudeUsageLimits({
      windows: [
        { label: "5h", usedPercent: 5, resetLabel: "Aug 21 at 11:29pm (America/New_York)" },
        { label: "Weekly", usedPercent: 29, resetLabel: "Aug 23 at 5:59pm (America/New_York)" },
      ],
    })).toEqual({
      windows: [
        { label: "5h", usedPercent: 5, resetsAt: null, resetLabel: "Aug 21 at 11:29pm (America/New_York)" },
        { label: "Weekly", usedPercent: 29, resetsAt: null, resetLabel: "Aug 23 at 5:59pm (America/New_York)" },
      ],
    });
  });

  it("drops malformed windows and invalid reset timestamps", () => {
    expect(parseClaudeUsageLimits({
      windows: [
        { label: "5h", usedPercent: 125, resetLabel: "" },
        { label: null, usedPercent: 10, resetLabel: null },
      ],
    })).toEqual({
      windows: [{ label: "5h", usedPercent: 100, resetsAt: null, resetLabel: null }],
    });
    expect(parseClaudeUsageLimits({ windows: [] })).toBeNull();
  });
});

describe("Claude model catalog", () => {
  // Shape verified against a real `list_models` control response from the
  // Claude Code CLI; the CLI has no `models` subcommand.
  const payload = {
    models: [
      {
        value: "default",
        resolvedModel: "claude-opus-5[1m]",
        displayName: "Default (recommended)",
        description: "Opus 5 with 1M context",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "Efficient for routine tasks" },
      { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku" },
    ],
  };

  it("normalizes a list_models response", () => {
    expect(parseClaudeModelCatalog(payload)).toEqual([
      {
        id: "default",
        displayName: "Default (recommended)",
        description: "Opus 5 with 1M context",
        resolvedModel: "claude-opus-5[1m]",
        disabled: false,
        unavailableReason: null,
        requiredVersion: null,
        supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        id: "sonnet",
        displayName: "Sonnet",
        description: "Efficient for routine tasks",
        resolvedModel: "claude-sonnet-5",
        disabled: false,
        unavailableReason: null,
        requiredVersion: null,
        supportedEfforts: [],
      },
      {
        id: "haiku",
        displayName: "Haiku",
        description: "",
        resolvedModel: "claude-haiku-4-5-20251001",
        disabled: false,
        unavailableReason: null,
        requiredVersion: null,
        supportedEfforts: [],
      },
    ]);
  });

  it("keeps disabled rows so the picker can grey them out", () => {
    expect(parseClaudeModelCatalog({
      models: [{ value: "opus", displayName: "Opus", isDisabled: true }],
    })).toEqual([
      { id: "opus", displayName: "Opus", description: "", resolvedModel: "opus", disabled: true, unavailableReason: "unavailable", requiredVersion: null, supportedEfforts: [] },
    ]);
  });

  it("recognizes an update-required sentinel and removes its disabled suffix", () => {
    expect(parseClaudeModelCatalog({
      models: [{
        value: "cc-update-required-1",
        displayName: "Fable 5.1 (disabled)",
        description: "Update to 2.1.255+ to use Fable 5.1",
        disabled: true,
      }],
    })).toEqual([expect.objectContaining({
      id: "cc-update-required-1",
      displayName: "Fable 5.1",
      disabled: true,
      unavailableReason: "update-required",
      requiredVersion: "2.1.255",
    })]);
  });

  it("recognizes the stable update-required id when the CLI changes its prose", () => {
    expect(parseClaudeModelCatalog({
      models: [{
        value: "cc-update-required-2",
        displayName: "Fable 5.1 (disabled)",
        description: "Requires a newer Claude Code release",
        disabled: true,
      }],
    })).toEqual([expect.objectContaining({
      id: "cc-update-required-2",
      unavailableReason: "update-required",
      requiredVersion: null,
    })]);
  });

  it("keeps an update-required successor while hiding only older models in its family", () => {
    const catalog = parseClaudeModelCatalog({
      models: [
        { value: "default", displayName: "Default (recommended)", description: "Opus 5" },
        { value: "claude-fable-5[1m]", displayName: "Fable", description: "Fable 5 · Most capable" },
        { value: "sonnet", displayName: "Sonnet", description: "Sonnet 5 · Efficient" },
        { value: "cc-update-required-1", displayName: "Fable 5.1 (disabled)", description: "Update to 2.1.255+ to use Fable 5.1", disabled: true },
      ],
    });

    expect(visibleClaudeModels(catalog).map((entry) => entry.id)).toEqual([
      "default",
      "sonnet",
      "cc-update-required-1",
    ]);
  });

  it("keeps the older family row hidden after its successor becomes available", () => {
    const catalog = parseClaudeModelCatalog({
      models: [
        { value: "claude-fable-5[1m]", displayName: "Fable", description: "Fable 5 · Most capable" },
        { value: "claude-fable-5-1[1m]", displayName: "Fable 5.1", description: "Fable 5.1 · Most capable" },
        { value: "sonnet", displayName: "Sonnet", description: "Sonnet 5 · Efficient" },
      ],
    });

    expect(visibleClaudeModels(catalog).map((entry) => entry.id)).toEqual([
      "claude-fable-5-1[1m]",
      "sonnet",
    ]);
    expect(isClaudeModelSuperseded(catalog, "claude-fable-5[1m]")).toBe(true);
  });

  it("drops entries without a model value and de-duplicates the rest", () => {
    expect(parseClaudeModelCatalog({
      models: [{ displayName: "Nameless" }, { value: "opus" }, { value: "opus" }, null, "opus"],
    }).map((entry) => entry.id)).toEqual(["opus"]);
  });

  it("returns an empty catalog for a CLI that does not answer the request", () => {
    for (const value of [null, undefined, {}, { models: "nope" }]) {
      expect(parseClaudeModelCatalog(value)).toEqual([]);
    }
  });
});
