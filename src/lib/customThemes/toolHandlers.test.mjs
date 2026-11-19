import test from "node:test";
import assert from "node:assert/strict";
import { THEME_TOOLS, ThemeToolRefusal, createThemeToolHandler, isThemeTool, providerTakesImages } from "./toolHandlerCore.ts";
import { libraryCommit, libraryCreate, librarySetDisabled, librarySetFocus, libraryUndo } from "./store.ts";

const BUILT_INS = [
  { id: "mythra", name: "Mythra" }, { id: "light-mythra", name: "Light Mythra" }, { id: "kiwi", name: "Kiwi" },
  { id: "daylight", name: "Light Kiwi" }, { id: "synthwave", name: "Synthwave" }, { id: "atari", name: "Atari" },
];

/** A small stand-in for the engine: required fields, defaults, one contrast fix. */
function normalize(input) {
  const errors = [];
  if (!input.name) errors.push({ path: "name", message: "name is required." });
  if (!BUILT_INS.some((theme) => theme.id === input.base)) errors.push({ path: "base", message: "base must be a built-in theme." });
  for (const key of ["bg", "text", "accent"]) if (!input.tokens?.[key]) errors.push({ path: `tokens.${key}`, message: `${key} is required.` });
  if (input.tokens?.mutedText) errors.push({ path: "tokens.mutedText", message: "`mutedText` is not a token. Did you mean `muted`?" });
  if (errors.length) return { ok: false, errors };
  const tokens = { ...input.tokens };
  const adjustments = [];
  if (tokens.muted === "#555555") {
    tokens.muted = "#8a8a8a";
    adjustments.push({ token: "muted", from: "#555555", to: "#8a8a8a", reason: "4.5:1 on panel (was 2.6:1)" });
  }
  return {
    ok: true,
    adjustments,
    warnings: input.customCss?.includes("position: fixed") ? ["customCss: dropped `position: fixed` (overlays are not allowed)"] : [],
    spec: {
      schema: "mythra.theme/1", name: input.name, description: input.description ?? "", base: input.base, tokens,
      shape: input.shape ?? "standard", elevation: input.elevation ?? "soft", typography: input.typography ?? {},
      surfaces: input.surfaces ?? { translucency: 0 }, effects: input.effects ?? {}, motion: input.motion ?? { enabled: true },
      customCss: input.customCss ?? "",
    },
  };
}

function applyPatch(current, patch) {
  if (!patch || typeof patch !== "object" || !Object.keys(patch).length) return { ok: false, errors: [{ path: "patch", message: "The patch is empty." }] };
  const next = JSON.parse(JSON.stringify(current));
  for (const [key, value] of Object.entries(patch)) {
    if (key === "tokens" || key === "effects") {
      for (const [sub, subValue] of Object.entries(value)) {
        if (subValue === null) delete next[key][sub];
        else next[key][sub] = key === "effects" && typeof subValue === "object" ? { ...next[key][sub], ...subValue } : subValue;
      }
    } else next[key] = value;
  }
  return normalize(next);
}

function diff(before, after) {
  const out = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    if (key === "tokens" || key === "effects") {
      for (const sub of new Set([...Object.keys(before[key]), ...Object.keys(after[key])])) {
        if (JSON.stringify(before[key][sub]) !== JSON.stringify(after[key][sub])) out.push(`${key}.${sub}`);
      }
    } else out.push(key);
  }
  return out;
}

function setup({ toolsEnabled = true, provider = "claude", sessionThreads = {}, probe = async () => ({ ok: true, failures: [] }), shell = {}, motion = { paused: false, reducedMotion: false }, screenshotsEnabled, deps: extraDeps = {} } = {}) {
  let library = { version: 1, themes: [], threadFocus: {} };
  let now = 1_000;
  let ids = 0;
  const makeId = () => `ct_${String(++ids).padStart(10, "0")}`;
  let active = "mythra";
  const applied = [];
  const host = {
    toolsEnabled: () => toolsEnabled,
    screenshotsEnabled: () => screenshotsEnabled !== false,
    previewEnvironment: () => ENVIRONMENT,
    activeThemeId: () => active,
    applyTheme: (theme, ctx) => { applied.push({ theme, ...ctx }); active = theme; return { appliedTo: "app" }; },
    threadForSession: () => ({ provider, model: "opus" }),
    waitForApplied: async () => shell,
    motionState: () => motion,
    isThemePainted: (theme) => theme === active,
  };
  const deps = {
    normalize, applyPatch, diff,
    designKit: () => ({ schema: "mythra.theme/1", tokens: [{ key: "bg" }] }),
    probe,
    library: () => library,
    create: (spec, meta) => { const out = libraryCreate(library, spec, meta, ++now, makeId); library = out.library; return out.result; },
    commit: (id, spec, meta) => { const out = libraryCommit(library, id, spec, meta, ++now); library = out.library; return out.result; },
    undo: (id, options) => { const out = libraryUndo(library, id, options, ++now); library = out.library; return out.result; },
    setFocus: (threadId, id) => { library = librarySetFocus(library, threadId, id); },
    focus: (threadId) => library.threadFocus[threadId],
    sessionThread: (sessionId) => sessionThreads[sessionId],
    host: () => host,
    builtInThemes: BUILT_INS,
    applyWaitMs: 50,
    ...extraDeps,
  };
  const handle = createThemeToolHandler(deps);
  const call = (tool, args = {}, context = { policyThreadId: "thread-1" }, sessionId = "session-1") =>
    handle({ sessionId, tool, arguments: args, provider }, context);
  return {
    call, applied, host,
    library: () => library,
    disable: (id, reason) => { library = librarySetDisabled(library, id, reason); },
    setActive: (theme) => { active = theme; },
  };
}

const NEBULA = { name: "Nebula", base: "mythra", tokens: { bg: "#16131f", text: "#ece8f6", accent: "#b794ff" } };

test("exposes exactly the eight tools", () => {
  assert.deepEqual([...THEME_TOOLS], ["get_theme_design_kit", "list_custom_themes", "get_custom_theme", "create_custom_theme", "update_custom_theme", "undo_custom_theme", "apply_custom_theme", "capture_app_screenshot"]);
  assert.equal(isThemeTool("undo_custom_theme"), true);
  assert.equal(isThemeTool("delete_custom_theme"), false);
});

test("refuses when tools are off or the host is not ready", async () => {
  const off = setup({ toolsEnabled: false });
  await assert.rejects(off.call("list_custom_themes"), /turned off theme tools/);
  const handle = createThemeToolHandler({ host: () => null });
  await assert.rejects(handle({ sessionId: "s", tool: "list_custom_themes", arguments: {} }), ThemeToolRefusal);
});

test("design kit carries the engine kit plus the workflow guide", async () => {
  const { call } = setup();
  const kit = await call("get_theme_design_kit");
  assert.equal(kit.schema, "mythra.theme/1");
  assert.ok(kit.guide.workflow.some((line) => line.includes("update_custom_theme")));
  assert.ok(kit.guide.workflow.some((line) => line.includes("undo_custom_theme")));
  assert.ok(kit.guide.examples.length >= 3);
  assert.doesNotThrow(() => JSON.stringify(kit));
});

test("create saves revision 1, applies it, focuses the conversation and reports adjustments", async () => {
  const { call, applied, library } = setup();
  const result = await call("create_custom_theme", { ...NEBULA, tokens: { ...NEBULA.tokens, muted: "#555555" }, summary: "First version" });
  assert.match(result.themeId, /^ct_\d{10}$/);
  assert.equal(result.revision, 1);
  assert.equal(result.applied, true);
  assert.equal(result.appliedTo, "app");
  assert.deepEqual(result.adjustments.map((entry) => entry.token), ["muted"]);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].theme, `custom:${result.themeId}`);
  assert.equal(applied[0].previous.theme, "mythra");
  assert.deepEqual(applied[0].by, { kind: "model", provider: "claude", model: "opus", threadId: "thread-1" });
  assert.equal(library().threadFocus["thread-1"], result.themeId);
  assert.equal(library().themes[0].revisions[0].summary, "First version");
});

test("create reports every validation problem and saves nothing", async () => {
  const { call, library } = setup();
  await assert.rejects(call("create_custom_theme", { name: "Bad", base: "mythra", tokens: { bg: "#000", mutedText: "#999" } }), (error) => {
    assert.match(error.message, /tokens\.text: text is required/);
    assert.match(error.message, /Did you mean `muted`/);
    return true;
  });
  assert.equal(library().themes.length, 0);
});

test("a conversation adjusts its theme instead of duplicating it", async () => {
  const { call, library } = setup();
  const first = await call("create_custom_theme", NEBULA);
  await assert.rejects(call("create_custom_theme", { ...NEBULA, name: "Nebula 2" }), (error) => {
    assert.match(error.message, /already made “Nebula”/);
    assert.match(error.message, /update_custom_theme/);
    assert.match(error.message, /asNewTheme: true/);
    return true;
  });
  const second = await call("create_custom_theme", { ...NEBULA, name: "Ember", asNewTheme: true });
  assert.notEqual(second.themeId, first.themeId);
  assert.equal(library().threadFocus["thread-1"], second.themeId);
  // Another conversation may create freely.
  await call("create_custom_theme", { ...NEBULA, name: "Paper" }, { policyThreadId: "thread-2" });
  assert.equal(library().themes.length, 3);
});

test("update targets the focused theme, saves a new revision and reports what changed", async () => {
  const { call, applied, library } = setup();
  const created = await call("create_custom_theme", { ...NEBULA, effects: { aurora: { intensity: 0.35 } } });
  const updated = await call("update_custom_theme", { patch: { tokens: { accent: "#ff8fd1" }, effects: { aurora: { intensity: 0.2 } } }, summary: "Pinker accent" });
  assert.equal(updated.themeId, created.themeId);
  assert.equal(updated.revision, 2);
  assert.deepEqual(updated.changed.sort(), ["effects.aurora", "tokens.accent"]);
  assert.equal(library().themes.length, 1);
  assert.equal(library().themes[0].revisions[1].summary, "Pinker accent");
  // The toast's Undo can restore the exact earlier revision.
  assert.deepEqual(applied.at(-1).previous, { theme: `custom:${created.themeId}`, revision: { id: created.themeId, n: 1 } });
});

test("update with an identical patch saves nothing", async () => {
  const { call, library } = setup();
  await call("create_custom_theme", NEBULA);
  const result = await call("update_custom_theme", { patch: { tokens: { accent: "#b794ff" } }, summary: "Same" });
  assert.equal(result.unchanged, true);
  assert.equal(library().themes[0].revisions.length, 1);
});

test("update refuses a stale expectedRevision and an unknown target", async () => {
  const { call } = setup();
  const created = await call("create_custom_theme", NEBULA);
  await call("update_custom_theme", { patch: { tokens: { accent: "#ff8fd1" } }, summary: "Pink" });
  await assert.rejects(call("update_custom_theme", { patch: { tokens: { accent: "#00ff00" } }, summary: "Green", expectedRevision: 1 }), /changed since you read it \(now r2/);
  await assert.rejects(call("update_custom_theme", { themeId: "ct_zzzzzzzzzz", patch: { name: "X" }, summary: "x" }), /No custom theme ct_zzzzzzzzzz exists/);
  assert.ok(created.themeId);
});

test("without a focus, update falls back to the active custom theme, else asks which", async () => {
  const fresh = setup();
  await assert.rejects(fresh.call("update_custom_theme", { patch: { name: "X" }, summary: "x" }), /Which theme\? .*built-in \(Mythra\)/);
  const { call, library } = setup();
  const created = await call("create_custom_theme", NEBULA, { policyThreadId: "other" });
  const result = await call("update_custom_theme", { patch: { name: "Nebula Night" }, summary: "Rename" }, { policyThreadId: "thread-9" });
  assert.equal(result.themeId, created.themeId);
  assert.equal(library().threadFocus["thread-9"], created.themeId);
});

test("the conversation resolves through the session map before the policy knows it", async () => {
  const { call, library } = setup({ sessionThreads: { "session-1": "thread-late" } });
  const created = await call("create_custom_theme", NEBULA, {});
  assert.equal(library().threadFocus["thread-late"], created.themeId);
});

test("undo walks back and toRevision restores, both as new revisions", async () => {
  const { call, library } = setup();
  const created = await call("create_custom_theme", NEBULA);
  await call("update_custom_theme", { patch: { tokens: { accent: "#ff8fd1" } }, summary: "Pink" });
  const undone = await call("undo_custom_theme", {});
  assert.equal(undone.revision, 3);
  assert.equal(undone.restoredFrom, 1);
  assert.deepEqual(undone.changed, ["tokens.accent"]);
  assert.equal(library().themes[0].revisions.at(-1).spec.tokens.accent, "#b794ff");
  const redone = await call("undo_custom_theme", { toRevision: 2 });
  assert.equal(redone.revision, 4);
  assert.equal(library().themes[0].revisions.at(-1).spec.tokens.accent, "#ff8fd1");
  assert.ok(created.themeId);
  // A brand-new theme has nothing earlier: the store's refusal reaches the model.
  const fresh = setup();
  await fresh.call("create_custom_theme", NEBULA);
  await assert.rejects(fresh.call("undo_custom_theme", {}), /Nothing earlier to undo/);
});

test("get and list report focus, history and the delete rule", async () => {
  const { call } = setup();
  const created = await call("create_custom_theme", NEBULA);
  await call("update_custom_theme", { patch: { tokens: { accent: "#ff8fd1" } }, summary: "Pink" });
  const read = await call("get_custom_theme", { includeHistory: true });
  assert.equal(read.themeId, created.themeId);
  assert.equal(read.revision, 2);
  assert.equal(read.canUndo, true);
  assert.deepEqual(read.history.map((entry) => [entry.revision, entry.summary]), [[2, "Pink"], [1, "Created “Nebula”"]]);
  assert.match(read.history[0].by, /Claude/);
  const listed = await call("list_custom_themes");
  assert.equal(listed.activeTheme, `custom:${created.themeId}`);
  assert.equal(listed.focusedInThisConversation, created.themeId);
  assert.equal(listed.custom[0].active, true);
  assert.equal(listed.custom[0].scheme, "dark");
  assert.equal(listed.builtIn.length, 6);
  assert.match(listed.note, /Only the user can delete/);
});

test("apply switches to built-ins and custom themes but not to a turned-off theme", async () => {
  const { call, applied, disable } = setup();
  const created = await call("create_custom_theme", NEBULA);
  const builtIn = await call("apply_custom_theme", { builtInTheme: "synthwave" });
  assert.equal(builtIn.theme, "synthwave");
  assert.deepEqual(applied.at(-1).previous, { theme: `custom:${created.themeId}`, revision: { id: created.themeId, n: 1 } });
  const back = await call("apply_custom_theme", { themeId: created.themeId });
  assert.equal(back.applied, true);
  assert.equal(applied.at(-1).theme, `custom:${created.themeId}`);
  disable(created.themeId, "boot-failure");
  await assert.rejects(call("apply_custom_theme", { themeId: created.themeId }), /turned off because Mythra Code didn't start cleanly/);
});

test("apply false saves without switching the look", async () => {
  const { call, applied } = setup();
  const result = await call("create_custom_theme", { ...NEBULA, apply: false });
  assert.equal(result.applied, false);
  assert.equal(applied.length, 0);
});

test("unreadable customCss on screen is switched off with an undoable revision", async () => {
  let probes = 0;
  const probe = async () => (++probes === 1
    ? { ok: false, failures: [{ landmark: "sidebar row title", ratio: 2.9, fg: "#6a6a70", bg: "#26272b", selectorHint: ".sidebar .row-title" }] }
    : { ok: true, failures: [] });
  const { call, library } = setup({ probe });
  const result = await call("create_custom_theme", { ...NEBULA, customCss: ".sidebar .row-title { color: var(--muted-2); }" });
  assert.equal(result.revision, 2);
  assert.match(result.warnings.join(" "), /customCss disabled: \.sidebar \.row-title color resolves to #6a6a70 on #26272b \(2\.9:1\)/);
  const record = library().themes[0];
  assert.equal(record.revisions.at(-1).spec.customCss, "");
  assert.equal(record.revisions.at(-1).summary, "Turned off custom CSS that made text hard to read");
  assert.equal(record.revisions[0].spec.customCss, ".sidebar .row-title { color: var(--muted-2); }");
});

test("a failure customCss did not cause keeps the stylesheet and asks for token fixes", async () => {
  const probe = async () => ({ ok: false, customCssCulprit: false, failures: [{ landmark: "transcript prose", ratio: 3.1, fg: "#777777", bg: "#222222", causedByCustomCss: false }] });
  const { call, library } = setup({ probe });
  const result = await call("create_custom_theme", { ...NEBULA, customCss: ".composer { border-color: var(--accent-line); }" });
  assert.equal(result.revision, 1);
  assert.match(result.warnings.join(" "), /hard to read on screen: transcript prose/);
  assert.equal(library().themes[0].revisions.length, 1);
});

test("an off-screen apply is saved and says readability was not checked", async () => {
  const { call } = setup({ shell: null });
  const result = await call("create_custom_theme", NEBULA);
  assert.match(result.warnings.join(" "), /isn't on screen right now/);
});

test("paused motion is mentioned for animated themes", async () => {
  const { call } = setup({ motion: { paused: true, reducedMotion: false } });
  const result = await call("create_custom_theme", { ...NEBULA, effects: { aurora: { intensity: 0.3 } } });
  assert.match(result.warnings.join(" "), /paused theme animations/);
});

test("sanitizer warnings from the engine reach the model", async () => {
  const { call } = setup();
  const result = await call("create_custom_theme", { ...NEBULA, customCss: ".composer::after { position: fixed; }" });
  assert.match(result.warnings.join(" "), /position: fixed/);
});

// ---- Layout report and screenshots ----------------------------------------------

const LAYOUT = { window: { w: 1440, h: 900 }, regions: [{ region: ".sidebar", name: "sidebar", x: 0, y: 0, w: 300, h: 900 }] };
const ENVIRONMENT = {
  viewport: { width: 1440, height: 900 }, uiScale: 1, panes: { sidebar: 260, dock: 430, dockAuto: true, sidebarOpen: true },
  chatFont: "system", effortSlider: "studio", logos: { openai: "openai", claude: "claude", cursor: "cube" },
  motion: { animate: true, paused: false, reducedMotion: false },
};
/** A hidden preview that draws every job at its requested size. */
const PREVIEW = async (job) => ({ ok: true, result: {
  layout: LAYOUT, viewport: job.viewport,
  ...(job.capture ? { image: { mimeType: "image/png", data: "iVBORw0KGgo=", width: 1280, height: 800 } } : {}),
} });

test("every applied change carries the layout report for the theme as drawn", async () => {
  const seen = [];
  const inspect = (shell, theme, motion) => { seen.push({ shell, theme, motion }); return LAYOUT; };
  const { call, setActive } = setup({ deps: { inspect } });
  const created = await call("create_custom_theme", { ...NEBULA, customCss: ".sidebar { border-color: var(--line); }" });
  assert.deepEqual(created.layout, LAYOUT);
  assert.equal(seen[0].theme.id, created.themeId);
  assert.equal(seen[0].theme.spec.customCss, ".sidebar { border-color: var(--line); }");
  assert.deepEqual(seen[0].motion, { paused: false, reducedMotion: false });
  const updated = await call("update_custom_theme", { patch: { tokens: { accent: "#ff8fd1" } }, summary: "Pink" });
  assert.deepEqual(updated.layout, LAYOUT);
  const undone = await call("undo_custom_theme", {});
  assert.deepEqual(undone.layout, LAYOUT);
  const applied = await call("apply_custom_theme", { themeId: created.themeId });
  assert.deepEqual(applied.layout, LAYOUT);
  // Not applied: nothing on screen to measure.
  setActive("mythra");
  const quiet = await call("update_custom_theme", { patch: { tokens: { accent: "#00aa88" } }, summary: "Teal", apply: false });
  assert.equal(quiet.layout, undefined);
});

test("a failing inspector never breaks a theme change", async () => {
  const { call } = setup({ deps: { inspect: () => { throw new Error("boom"); } } });
  const created = await call("create_custom_theme", NEBULA);
  assert.equal(created.applied, true);
  assert.equal(created.layout, undefined);
});

test("stripped customCss is measured again without the stylesheet", async () => {
  const specs = [];
  const probe = async () => ({ ok: false, failures: [{ landmark: "sidebar row title", ratio: 2.1, fg: "#333", bg: "#222", selectorHint: ".thread-card-title", causedByCustomCss: true }], customCssCulprit: true });
  const { call } = setup({ probe, deps: { inspect: (_shell, theme) => { specs.push(theme.spec.customCss); return LAYOUT; } } });
  const created = await call("create_custom_theme", { ...NEBULA, customCss: ".thread-card-title { color: #333; }" });
  assert.equal(created.revision, 2);
  assert.deepEqual(specs, [""]);
  assert.deepEqual(created.layout, LAYOUT);
});

test("capture draws the conversation's exact revision in a hidden preview and returns its picture and layout", async () => {
  const jobs = [];
  const { call } = setup({ deps: { preview: async (job) => { jobs.push(job); return PREVIEW(job); } } });
  const created = await call("create_custom_theme", NEBULA);
  const shot = await call("capture_app_screenshot");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].capture, true);
  assert.equal(jobs[0].view, "conversation");
  assert.equal(jobs[0].theme.custom.id, created.themeId);
  assert.equal(jobs[0].theme.custom.revision, created.revision);
  assert.deepEqual(jobs[0].viewport, ENVIRONMENT.viewport);
  assert.equal(shot.captured, true);
  assert.deepEqual(shot.image, { data: "iVBORw0KGgo=", mimeType: "image/png" });
  assert.equal(shot.width, 1280);
  assert.equal(shot.themeId, created.themeId);
  assert.equal(shot.revision, created.revision);
  assert.equal(shot.layoutAvailable, true);
  assert.deepEqual(shot.layout, LAYOUT);
  assert.deepEqual(shot.dimensions.window, ENVIRONMENT.viewport);
  assert.equal(shot.scenario.view, "conversation");
  assert.match(shot.note, /hidden preview of Mythra Code/);
});

test("capture refuses when the user doesn't let models see the app, or theme tools are off", async () => {
  let previews = 0;
  const preview = async (job) => { previews++; return PREVIEW(job); };
  const off = setup({ screenshotsEnabled: false, deps: { preview } });
  await assert.rejects(off.call("capture_app_screenshot"), /Let models see theme previews/);
  const toolsOff = setup({ toolsEnabled: false, deps: { preview } });
  await assert.rejects(toolsOff.call("capture_app_screenshot"), /turned off theme tools/);
  assert.equal(previews, 0);
});

test("capture asks for no picture for a runtime that drops tool images, but still measures", async () => {
  const jobs = [];
  const { call } = setup({ provider: "cursor", deps: { preview: async (job) => { jobs.push(job); return PREVIEW(job); } } });
  const shot = await call("capture_app_screenshot");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].capture, false);
  assert.equal(jobs[0].theme.custom, null);
  assert.equal(shot.captured, false);
  assert.equal(shot.image, undefined);
  assert.deepEqual(shot.layout, LAYOUT);
  assert.match(shot.note, /supports text results/);
  assert.equal(providerTakesImages("claude"), true);
  assert.equal(providerTakesImages("openai"), true);
  assert.equal(providerTakesImages("openrouter", true), true);
  assert.equal(providerTakesImages("cursor"), false);
});

test("capture falls back to text when the preview can't be drawn, never to the app window", async () => {
  const unavailable = setup({ deps: { preview: async () => ({ ok: false, unavailable: true, error: "Previews are not available on this system." }) } });
  const shot = await unavailable.call("capture_app_screenshot");
  assert.equal(shot.captured, false);
  assert.match(shot.note, /not available on this system/);
  assert.match(shot.note, /layout report from your last theme change/);
  const missing = setup();
  assert.match((await missing.call("capture_app_screenshot")).note, /not available here/);
  const slow = setup({ deps: { preview: () => new Promise(() => {}), previewWaitMs: 20 } });
  assert.match((await slow.call("capture_app_screenshot")).note, /did not answer in time/);
});
