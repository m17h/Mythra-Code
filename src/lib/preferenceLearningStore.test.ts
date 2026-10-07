import { describe, expect, it } from "vitest";
import { defaultPreferenceLearningScope } from "./preferenceLearning";
import { createPreferenceLearningStore, type PreferenceLearningTransport } from "./preferenceLearningStore";
import type { PreferenceLearningScopeState, PreferenceLearningValue } from "./preferenceLearningTypes";

function fixture(initial: PreferenceLearningScopeState = { ...defaultPreferenceLearningScope("app"), revision: 1, enabled: true, enabledAt: 1 }) {
  let native = initial;
  let writes = 0;
  const transport: PreferenceLearningTransport = {
    list: async () => [native],
    save: async (scopeKey, revision, value) => {
      if (revision !== native.revision) throw new Error("Revision conflict");
      writes += 1;
      native = { scopeKey, revision: revision + 1, ...value };
      return native;
    },
  };
  return { store: createPreferenceLearningStore(transport), writes: () => writes, external: (patch: Partial<PreferenceLearningScopeState>) => { native = { ...native, ...patch, revision: native.revision + 1 }; }, native: () => native };
}
const preferences = [{ instruction: "Keep replies concise.", evidenceIds: ["u1"] }];
function removableFixture() {
  const initial = { ...defaultPreferenceLearningScope("project:removed"), revision: 7, enabled: true, enabledAt: 1, markdown: "Keep this until removal succeeds" };
  let native: PreferenceLearningScopeState | null = initial;
  let highWater = initial.revision;
  let fail: Error | null = null;
  let saves = 0;
  const transport: PreferenceLearningTransport = {
    list: async () => native ? [native] : [],
    save: async (scopeKey, revision, value) => {
      if (revision !== (native?.revision ?? 0)) throw new Error("Revision conflict");
      saves += 1;
      const nextRevision = revision === 0 ? highWater + 1 : revision + 1;
      highWater = Math.max(highWater, nextRevision);
      native = { scopeKey, revision: nextRevision, ...value }; return native;
    },
    forget: async (scopeKey, revision) => {
      if (fail) throw fail;
      if (native?.scopeKey !== scopeKey || native.revision !== revision) throw new Error("Revision conflict");
      highWater = Math.max(highWater, revision); native = null;
    },
  };
  return { initial, transport, store: createPreferenceLearningStore(transport), native: () => native,
    fail: (error: Error | null) => { fail = error; }, saves: () => saves,
    external: (state: PreferenceLearningScopeState | null) => { native = state; if (state) highWater = Math.max(highWater, state.revision); } };
}
describe("native preference learning store", () => {
  it("exposes stable disabled snapshots before hydration and makes no writes", async () => {
    const { store, writes } = fixture();
    expect(store.get("app")).toBe(store.get("app"));
    expect(store.get("app").enabled).toBe(false);
    expect(store.isHydrated()).toBe(false);
    expect(await store.commit("app", 0, preferences, {})).toMatchObject({ committed: false });
    await store.load();
    expect(store.get("app").enabled).toBe(true);
    expect(writes()).toBe(0);
  });
  it("applies only changed documents, while accepted no-op analysis advances checkpoints", async () => {
    const { store } = fixture(); await store.load();
    expect(await store.commit("app", 1, preferences, { thread: "u1" })).toMatchObject({ committed: true, changed: true });
    expect(await store.commit("app", 2, preferences, { thread: "u2" })).toMatchObject({ committed: true, changed: false });
    expect(store.get("app").checkpoints).toEqual({ thread: "u2" });
  });
  it("invalidates a late analysis after disabling, editing, or selecting another model", async () => {
    for (const action of ["disable", "edit", "model"] as const) {
      const { store } = fixture(); await store.load();
      if (action === "disable") await store.configure("app", { enabled: false });
      if (action === "edit") await store.edit("app", "User authored content");
      if (action === "model") await store.configure("app", { model: "chosen" });
      expect(await store.commit("app", 1, preferences, { thread: "u1" })).toMatchObject({ committed: false, changed: false });
      expect(store.get("app").checkpoints).toEqual({});
    }
  });
  it("refreshes a revision conflict and preserves the external document", async () => {
    const { store, external } = fixture(); await store.load();
    external({ markdown: "External edit" });
    expect(await store.commit("app", 1, preferences, {})).toMatchObject({ committed: false });
    expect(store.get("app").markdown).toBe("External edit");
  });
  it("keeps a newer loaded revision when an earlier successful save returns late", async () => {
    let native: PreferenceLearningScopeState = { ...defaultPreferenceLearningScope("app"), revision: 1, enabled: true, enabledAt: 1 };
    let release!: () => void;
    let saved!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const began = new Promise<void>((resolve) => { saved = resolve; });
    const store = createPreferenceLearningStore({
      list: async () => [native],
      save: async (scopeKey, revision, value) => {
        const result = { scopeKey, revision: revision + 1, ...value };
        native = result;
        saved();
        await blocked;
        return result;
      },
    });
    await store.load();
    const committed = store.commit("app", 1, preferences, {});
    await began;
    native = { ...native, revision: 3, enabled: false, markdown: "External correction" };
    await store.load();
    release();
    expect(await committed).toMatchObject({ saved: true, committed: false, changed: true });
    expect(store.get("app")).toMatchObject({ revision: 3, enabled: false, markdown: "External correction" });
  });
  it("clears with tombstones and preserves checkpoints preventing immediate relearning", async () => {
    const { store } = fixture(); await store.load(); await store.commit("app", 1, preferences, { thread: "u1" });
    await store.clear("app");
    expect(store.get("app")).toMatchObject({ markdown: "", checkpoints: { thread: "u1" }, rejectedInstructions: ["keep replies concise."] });
    expect(store.get("app").clearedAt).toBeGreaterThan(0);
    expect(await store.commit("app", 3, preferences, {})).toMatchObject({ committed: true, changed: false });
    await store.edit("app", "- Keep replies concise.");
    await store.edit("app", "Manual content");
    expect(store.get("app").rejectedInstructions).toContain("keep replies concise.");
  });
  it("persists a bounded request budget before analysis and rolls it over after a day", async () => {
    const { store } = fixture(); await store.load();
    for (let n = 0; n < 12; n += 1) expect(await store.reserve("app", n + 1, 100_000)).not.toBeNull();
    expect(await store.reserve("app", 13, 100_000)).toBeNull();
    expect(await store.reserve("app", 13, 100_000 + 86_400_001)).not.toBeNull();
    expect(store.get("app").analysisRequestsAt).toHaveLength(1);
  });
  it("leaves failed startup disabled and a failed save preserves known data", async () => {
    const broken = createPreferenceLearningStore({ list: async () => { throw new Error("Corrupt registry"); }, save: async () => { throw new Error("Unavailable"); } });
    await expect(broken.load()).rejects.toThrow("Corrupt");
    expect(broken.get("app").enabled).toBe(false);
    expect(broken.isHydrated()).toBe(false);
    const state = { ...defaultPreferenceLearningScope("app"), enabled: true, enabledAt: 1, revision: 1, markdown: "Existing" };
    const store = createPreferenceLearningStore({ list: async () => [state], save: async () => { throw new Error("Disk full"); } });
    await store.load();
    expect(await store.commit("app", 1, preferences, {})).toMatchObject({ saved: false, committed: false, changed: false });
    expect(store.get("app").markdown).toBe("Existing");
  });
  it("does not lose two queued manual changes", async () => {
    let state = { ...defaultPreferenceLearningScope("app"), revision: 1 };
    const revisions: number[] = [];
    const store = createPreferenceLearningStore({ list: async () => [state], save: async (scopeKey: string, expectedRevision: number, value: PreferenceLearningValue) => {
      revisions.push(expectedRevision);
      state = { scopeKey, revision: expectedRevision + 1, ...value };
      return state;
    } });
    await store.load();
    await Promise.all([store.configure("app", { enabled: true }), store.configure("app", { model: "chosen" })]);
    expect(revisions).toEqual([1, 2]);
    expect(store.get("app")).toMatchObject({ enabled: true, model: "chosen" });
  });
  it("suppresses learned instructions immediately and rejects toast from an invalidated in-flight save", async () => {
    let state: PreferenceLearningScopeState = { ...defaultPreferenceLearningScope("app"), revision: 1, enabled: true, enabledAt: 1, markdown: "- Existing preference" };
    let release: (() => void) | undefined;
    let saving: (() => void) | undefined;
    const began = new Promise<void>((resolve) => { saving = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const store = createPreferenceLearningStore({ list: async () => [state], save: async (scopeKey, expectedRevision, value) => {
      calls += 1;
      if (calls === 1) { saving!(); await blocked; }
      state = { scopeKey, revision: expectedRevision + 1, ...value };
      return state;
    } });
    await store.load();
    const result = store.commit("app", 1, preferences, {});
    await began;
    const disable = store.configure("app", { enabled: false });
    expect(store.get("app").enabled).toBe(false);
    release!();
    expect(await result).toMatchObject({ saved: true, committed: false, changed: true });
    await disable;
    expect(store.get("app").enabled).toBe(false);
    expect(store.get("app").revision).toBe(3);
  });
  it("rejects a stale edit baseline rather than overwriting unseen updates", async () => {
    const { store } = fixture(); await store.load();
    await store.commit("app", 1, preferences, {});
    await expect(store.edit("app", "Outdated edit", 1)).rejects.toThrow("changed");
    expect(store.get("app").markdown).toBe("- Keep replies concise.");
  });
  it("rejects a confirmed clear of an older revision, including queued changes", async () => {
    const { store } = fixture(); await store.load();
    const baseline = store.get("app").revision;
    const edit = store.edit("app", "New manual preferences", baseline);
    const clear = store.clear("app", baseline);
    await edit;
    await expect(clear).rejects.toThrow("changed");
    expect(store.get("app")).toMatchObject({ revision: 2, enabled: true, markdown: "New manual preferences" });
    expect(store.get("app").clearedAt).toBeUndefined();
    await store.clear("app", 2);
    expect(store.get("app").markdown).toBe("");
  });
  it("does not dispatch analysis after disabling during an in-flight budget reservation", async () => {
    let state: PreferenceLearningScopeState = { ...defaultPreferenceLearningScope("app"), revision: 1, enabled: true, enabledAt: 1 };
    let release: (() => void) | undefined;
    let saving: (() => void) | undefined;
    const began = new Promise<void>((resolve) => { saving = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const store = createPreferenceLearningStore({ list: async () => [state], save: async (scopeKey, expectedRevision, value) => {
      calls += 1;
      if (calls === 1) { saving!(); await blocked; }
      state = { scopeKey, revision: expectedRevision + 1, ...value };
      return state;
    } });
    await store.load();
    const reserved = store.reserve("app", 1, 100_000);
    await began;
    const disable = store.configure("app", { enabled: false });
    release!();
    expect(await reserved).toBeNull();
    await disable;
    expect(store.get("app").enabled).toBe(false);
  });
  it("normalizes a synchronous bridge failure into a rejected load without crashing the caller", async () => {
    const store = createPreferenceLearningStore({ list: () => { throw new Error("Bridge missing"); }, save: async () => { throw new Error("unused"); } });
    let request: Promise<void> | undefined;
    expect(() => { request = store.load(); }).not.toThrow();
    await expect(request).rejects.toThrow("Bridge missing");
    expect(store.getError()).toBe("Bridge missing");
    expect(store.get("app").enabled).toBe(false);
    expect(store.isHydrated()).toBe(false);
  });
  it("rejects malformed or legacy bridge responses atomically without enabling an earlier valid row", async () => {
    const valid = { ...defaultPreferenceLearningScope("app"), enabled: true, enabledAt: 1, revision: 1 };
    for (const payload of [undefined, null, {}, [{ ...valid, value: {} }], [{ ...valid, model: 5 }], [valid, { scopeKey: "project:bad", enabled: true }], [{ ...valid, analysisRequestsAt: [NaN] }]]) {
      const store = createPreferenceLearningStore({ list: () => payload as unknown as Promise<PreferenceLearningScopeState[]>, save: async () => { throw new Error("unused"); } });
      await expect(store.load()).rejects.toThrow("Invalid preference");
      expect(store.get("app").enabled).toBe(false);
      expect(store.isHydrated()).toBe(false);
      expect(store.getError()).toMatch(/Invalid preference/);
    }
  });
  it("bounds checkpoint retention while always keeping the current accepted batch", async () => {
    const checkpoints = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`openai:old${index}`, "seen"]));
    const { store } = fixture({ ...defaultPreferenceLearningScope("app"), enabled: true, enabledAt: 1, revision: 1, checkpoints });
    await store.load();
    expect(await store.commit("app", 1, preferences, { "openai:new": "fresh" })).toMatchObject({ committed: true });
    expect(Object.keys(store.get("app").checkpoints)).toHaveLength(1000);
    expect(store.get("app").checkpoints["openai:new"]).toBe("fresh");
    expect(await store.commit("app", 2, [], Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`openai:replacement${index}`, "seen"])))).toMatchObject({ committed: true });
    expect(Object.keys(store.get("app").checkpoints)).toHaveLength(1000);
    expect(store.get("app").checkpoints["openai:new"]).toBeUndefined();
    const overflow = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`openai:overflow${index}`, "seen"]));
    expect(await store.commit("app", 3, [], overflow)).toMatchObject({ committed: false });
    expect(store.get("app").revision).toBe(3);
  });
  it("offers stable saved scope keys and removes only explicitly confirmed project scopes", async () => {
    const { store, native, initial } = removableFixture();
    const empty = store.getSavedScopeKeys(); expect(store.getSavedScopeKeys()).toBe(empty);
    await store.load();
    const keys = store.getSavedScopeKeys(); expect(keys).toEqual([initial.scopeKey]);
    store.setJob(initial.scopeKey, { status: "running" }); expect(store.getSavedScopeKeys()).toBe(keys);
    await expect(store.forget("app", 7)).rejects.toThrow("Only saved project");
    await expect(store.forget(initial.scopeKey, 6)).rejects.toThrow("changed");
    expect(native()).toEqual(initial);
    const forgotten = store.forget(initial.scopeKey, 7);
    expect(store.get(initial.scopeKey).enabled).toBe(false);
    expect(store.getSavedScopeKeys()).toBe(keys);
    await forgotten;
    expect(native()).toBeNull(); expect(store.getSavedScopeKeys()).toEqual([]);
    expect(store.get(initial.scopeKey)).toMatchObject({ revision: 0, enabled: false, markdown: "" });
    expect(store.getJob(initial.scopeKey)).toEqual({ status: "idle" });
    expect(store.get(initial.scopeKey)).toBe(store.get(initial.scopeKey));
  });
  it("preserves documents and restores the latest revision on failed or conflicting removal", async () => {
    const { store, initial, fail, external } = removableFixture(); await store.load();
    fail(new Error("Disk full"));
    await expect(store.forget(initial.scopeKey, 7)).rejects.toThrow("Disk full");
    expect(store.get(initial.scopeKey)).toMatchObject(initial);
    fail(null); external({ ...initial, revision: 8, markdown: "External edit" });
    await expect(store.forget(initial.scopeKey, 7)).rejects.toThrow("conflict");
    expect(store.get(initial.scopeKey)).toMatchObject({ revision: 8, enabled: true, markdown: "External edit" });
    expect(store.getSavedScopeKeys()).toEqual([initial.scopeKey]);
  });
  it("cancels queued manual and analysis writes when removal is requested", async () => {
    const { store, initial, saves } = removableFixture(); await store.load();
    const edit = store.edit(initial.scopeKey, "Queued document");
    const configured = store.configure(initial.scopeKey, { model: "queued-model" });
    const commit = store.commit(initial.scopeKey, 7, preferences, {});
    const reserved = store.reserve(initial.scopeKey, 7);
    const forgotten = store.forget(initial.scopeKey, 7);
    await expect(edit).rejects.toThrow("removed");
    await expect(configured).rejects.toThrow("removed");
    expect(await commit).toMatchObject({ committed: false }); expect(await reserved).toBeNull();
    await forgotten; expect(saves()).toBe(0); expect(store.getSavedScopeKeys()).toEqual([]);
  });
  it("prevents delayed and stale list rows from resurrecting a forgotten scope", async () => {
    const { transport, initial } = removableFixture();
    let release!: () => void;
    let stale = false;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const store = createPreferenceLearningStore({ ...transport, list: async () => {
      if (!stale) return transport.list();
      await blocked; return [initial];
    } });
    await store.load(); stale = true;
    const oldList = store.load();
    await store.forget(initial.scopeKey, 7);
    release(); await oldList;
    expect(store.getSavedScopeKeys()).toEqual([]); expect(store.get(initial.scopeKey).enabled).toBe(false);
    await store.load(); // Even an incorrectly repeated old revision is ignored.
    expect(store.getSavedScopeKeys()).toEqual([]);
  });
  it("allows explicit recreation with a higher native revision and rejects old analysis", async () => {
    const { store, initial } = removableFixture(); await store.load();
    await store.forget(initial.scopeKey, 7);
    const recreated = await store.configure(initial.scopeKey, { enabled: true });
    expect(recreated.revision).toBe(8);
    expect(store.getSavedScopeKeys()).toEqual([initial.scopeKey]);
    expect(await store.commit(initial.scopeKey, 7, preferences, {})).toMatchObject({ committed: false });
    expect(store.get(initial.scopeKey).markdown).toBe("");
  });
  it("observes external removal without erasing a successful save made after a list starts", async () => {
    const { store, initial, external } = removableFixture(); await store.load();
    external(null); await store.load();
    expect(store.getSavedScopeKeys()).toEqual([]); expect(store.get(initial.scopeKey).enabled).toBe(false);
    let release!: () => void;
    let blocked = false;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const { transport } = removableFixture();
    const guarded = createPreferenceLearningStore({ ...transport, list: async () => { if (blocked) { await waiting; return []; } return transport.list(); } });
    await guarded.load(); blocked = true;
    const list = guarded.load();
    await guarded.edit(initial.scopeKey, "New saved document");
    release(); await list;
    expect(guarded.get(initial.scopeKey)).toMatchObject({ revision: 8, markdown: "New saved document" });
    expect(guarded.getSavedScopeKeys()).toEqual([initial.scopeKey]);
  });
  it("rejects a delayed save acknowledgement after an external removal was observed", async () => {
    const { transport, initial, external } = removableFixture();
    let release!: () => void;
    let saved!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const began = new Promise<void>((resolve) => { saved = resolve; });
    const store = createPreferenceLearningStore({ ...transport, save: async (...args) => {
      const result = await transport.save(...args); saved(); await waiting; return result;
    } });
    await store.load();
    const edited = store.edit(initial.scopeKey, "Old delayed acknowledgement");
    await began; external(null); await store.load();
    expect(store.getSavedScopeKeys()).toEqual([]);
    release(); await expect(edited).rejects.toThrow("removed");
    expect(store.getSavedScopeKeys()).toEqual([]); expect(store.get(initial.scopeKey).enabled).toBe(false);
  });
  it("preserves optional transports without permitting an unsupported deletion", async () => {
    const { store } = fixture(); await store.load();
    await expect(store.forget("project:removed", 1)).rejects.toThrow("unavailable");
    expect(store.get("app").enabled).toBe(true);
  });
});
