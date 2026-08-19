import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";

/**
 * Legend List positions every timeline row as an absolutely positioned box, so
 * a stale size in its cache becomes a visible overlap rather than a harmless
 * gap. Versions up to and including 3.3.6 seeded a newly appended row with the
 * average size for its item type and never corrected the rows below it once the
 * real height was measured. In the timeline that placed the row after a new
 * prompt roughly 158px too high, painting it over the previous answer.
 *
 * 3.3.7 fixes the underlying recycling bug, which is why `ChatTimeline` can keep
 * `maintainVisibleContentPosition: { data: true, size: true }`. Dropping `data`
 * also hides the overlap, but it gives up anchoring when completed turns compact
 * and when activities merge into the middle of the list, so the version floor is
 * the real fix. `ChatTimeline.layout.browser.test.tsx` proves the behaviour;
 * this guard stops a downgrade from silently reintroducing it.
 */
const MINIMUM_LEGEND_LIST = [3, 3, 7];

function parseVersion(version: string): number[] {
  return version.replace(/^\D*/, "").split(".").map((part) => Number.parseInt(part, 10));
}

function isAtLeast(actual: number[], minimum: number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    const left = actual[index] ?? 0;
    const right = minimum[index];
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

describe("timeline virtualization dependency", () => {
  it("pins @legendapp/list to a release that positions appended rows correctly", () => {
    const declared = packageJson.dependencies["@legendapp/list"];
    const actual = parseVersion(declared);

    expect(actual).toHaveLength(3);
    expect(actual.every((part) => Number.isInteger(part))).toBe(true);
    expect(
      isAtLeast(actual, MINIMUM_LEGEND_LIST),
      `@legendapp/list is pinned to ${declared}, which is older than the required ${MINIMUM_LEGEND_LIST.join(".")}`,
    ).toBe(true);
  });
});
