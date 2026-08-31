import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_INITIAL_TURN_LIMIT,
  MAX_THREAD_PREVIEW_CHARACTERS,
  projectThreadPreviews,
  summarizeMeasurements,
} from "./benchmark-thread-loading.mjs";

describe("thread loading benchmark", () => {
  it("tracks the production bridge and initial-page limits", () => {
    const root = resolve(import.meta.dirname, "..");
    const history = readFileSync(resolve(root, "src/lib/threadHistory.ts"), "utf8");
    const preview = readFileSync(resolve(root, "src/lib/threadPreview.ts"), "utf8");
    const bridge = readFileSync(resolve(root, "src-tauri/src/lib.rs"), "utf8");

    expect(history).toContain(`INITIAL_THREAD_TURN_LIMIT = ${DEFAULT_INITIAL_TURN_LIMIT}`);
    expect(preview).toContain(`MAX_THREAD_PREVIEW_CHARACTERS = ${MAX_THREAD_PREVIEW_CHARACTERS}`);
    expect(bridge).toContain(`MAX_THREAD_PREVIEW_CHARACTERS: usize = ${MAX_THREAD_PREVIEW_CHARACTERS}`);
  });

  it("models the native bridge preview projection without changing canonical messages", () => {
    const grapheme = "👨‍👩‍👧";
    const preview = grapheme.repeat(MAX_THREAD_PREVIEW_CHARACTERS + 5);
    const result = { thread: { preview, turns: [{ items: [{ text: preview }] }] } };

    const projected = projectThreadPreviews("thread/resume", result);

    expect(Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(projected.thread.preview)))
      .toHaveLength(MAX_THREAD_PREVIEW_CHARACTERS);
    expect(projected.thread.preview.endsWith(grapheme)).toBe(true);
    expect(projected.thread.turns[0].items[0].text).toBe(preview);
    expect(result.thread.preview).toBe(preview);
  });

  it("models nested search results and removes excerpts the client does not use", () => {
    const projected = projectThreadPreviews("thread/search", {
      data: [{
        thread: { preview: "x".repeat(MAX_THREAD_PREVIEW_CHARACTERS + 5) },
        snippet: "unused full-text excerpt",
      }],
    });

    expect(projected.data[0].thread.preview).toHaveLength(MAX_THREAD_PREVIEW_CHARACTERS);
    expect(projected.data[0]).not.toHaveProperty("snippet");
  });

  it("reports percentile and 40 KiB regressions from projected initial bytes", () => {
    const summary = summarizeMeasurements([
      { threadId: "small", initialProjectedBytes: 1_000, initialRawResultBytes: 2_000, rolloutBytes: 100_000 },
      { threadId: "middle", initialProjectedBytes: 10_000, initialRawResultBytes: 12_000, rolloutBytes: 200_000 },
      { threadId: "large", initialProjectedBytes: 50_000, initialRawResultBytes: 60_000, rolloutBytes: 300_000 },
    ]);

    expect(summary).toMatchObject({
      measuredThreads: 3,
      p50InitialProjectedBytes: 10_000,
      p95InitialProjectedBytes: 10_000,
      p95InitialRawResultBytes: 12_000,
      maximumProjected: { threadId: "large", initialProjectedBytes: 50_000 },
      maximumRawResult: { threadId: "large", initialRawResultBytes: 60_000 },
      largestRollout: { threadId: "large", rolloutBytes: 300_000 },
      threadsOver40KiB: 1,
    });
  });
});
