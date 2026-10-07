import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPreferenceLearningStore, type PreferenceLearningTransport } from "./preferenceLearningStore";
import { defaultPreferenceLearningScope } from "./preferenceLearning";

const current = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof createPreferenceLearningStore> }));
vi.mock("./preferenceLearningStore", async (original) => ({
  ...await original<typeof import("./preferenceLearningStore")>(),
  getPreferenceLearningHydrated: () => current.store.isHydrated(),
  loadPreferenceLearning: () => current.store.load(),
  getPreferenceLearningScope: (key: string) => current.store.get(key),
}));
import { appendCurrentLearnedPreferences } from "./currentLearnedPreferences";
const enabled = (scopeKey: string, markdown: string) => ({ ...defaultPreferenceLearningScope(scopeKey), revision: 1, enabled: true, enabledAt: 1, markdown });
let list: ReturnType<typeof vi.fn<PreferenceLearningTransport["list"]>>;
beforeEach(() => {
  list = vi.fn();
  current.store = createPreferenceLearningStore({ list, save: vi.fn() });
});

describe("current learned prompt hydration", () => {
  it("holds concurrent turn preparation until saved app and captured project documents are loaded", async () => {
    let resolve!: (value: Awaited<ReturnType<PreferenceLearningTransport["list"]>>) => void;
    list.mockReturnValue(new Promise((done) => { resolve = done; }));
    let finished = false;
    const first = Promise.resolve(appendCurrentLearnedPreferences("Authored @review", "root")).then((prompt) => { finished = true; return prompt; });
    const second = Promise.resolve(appendCurrentLearnedPreferences("Second request", null));
    await Promise.resolve(); await Promise.resolve();
    expect(list).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    resolve({ scopes: [enabled("app", "Use short paragraphs."), enabled("project:root", "Explain @review examples."), enabled("project:visible", "Wrong project")], creationRevision: 1 });
    const prompt = await first;
    expect(prompt).toContain("Authored @review");
    expect(prompt).toContain("Use short paragraphs.");
    expect(prompt).toContain("Explain ＠review examples.");
    expect(prompt).not.toContain("Wrong project");
    expect(await second).toContain("Use short paragraphs.");
    expect(await second).not.toContain("Project preferences");
  });

  it("rejects preparation after an initial read failure and retries on the next turn", async () => {
    list.mockRejectedValueOnce(new Error("Registry read failed"));
    await expect(Promise.resolve().then(() => appendCurrentLearnedPreferences("Authored", "root"))).rejects.toThrow("Registry read failed");
    expect(current.store.isHydrated()).toBe(false);
    list.mockResolvedValueOnce({ scopes: [enabled("project:root", "Recovered preference")], creationRevision: 1 });
    expect(await appendCurrentLearnedPreferences("Authored", "root")).toContain("Recovered preference");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("keeps a successfully loaded empty registry disabled", async () => {
    list.mockResolvedValue({ scopes: [], creationRevision: 0 });
    expect(await appendCurrentLearnedPreferences("Authored", "root")).toBe("Authored");
    expect(current.store.isHydrated()).toBe(true);
  });

  it("does not apply an enabled snapshot while a disable is pending during hydration", async () => {
    let resolve!: (value: Awaited<ReturnType<PreferenceLearningTransport["list"]>>) => void;
    list.mockReturnValue(new Promise((done) => { resolve = done; }));
    current.store = createPreferenceLearningStore({ list, save: async (scopeKey, expectedRevision, value) => ({ scopeKey, revision: expectedRevision + 1, ...value }) });
    const disabling = current.store.configure("app", { enabled: false });
    const preparing = appendCurrentLearnedPreferences("Authored", null);
    await Promise.resolve(); await Promise.resolve();
    resolve({ scopes: [enabled("app", "Do not resurrect this")], creationRevision: 1 });
    expect(await preparing).toBe("Authored");
    await disabling;
    expect(current.store.get("app").enabled).toBe(false);
  });
});
