import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "./appConfig.ts";
import { appearanceDiffers, onboardingHandoff, settingsWithAppearance, settingsWithDefaultProvider } from "./onboardingSettings.ts";

const saved = { ...DEFAULT_SETTINGS, provider: "openai", model: "gpt-5.6-sol", defaultModelExplicit: true, theme: "mythra", chatFont: "system", effortSlider: "codex" };

// Settings autosaves whenever its draft differs from the saved settings, so a
// handoff that writes nothing must start from exactly the saved settings.
test("opening an account from the tour leaves the default provider and model untouched", () => {
  const handoff = onboardingHandoff(saved, { account: "claude" });
  assert.equal(handoff.local, saved);
  assert.equal(JSON.stringify(handoff.local), JSON.stringify(saved));
  assert.equal(handoff.local.provider, "openai");
  assert.equal(handoff.local.model, "gpt-5.6-sol");
  assert.equal(handoff.accountProvider, "claude");
  assert.equal(handoff.accountExpanded, true);
});

test("a look carried from the tour is a preview, not an edit", () => {
  const look = { theme: "synthwave", chatFont: "serif", effortSlider: "studio" };
  const handoff = onboardingHandoff(saved, { appearance: look });
  assert.equal(handoff.local, saved);
  assert.deepEqual(handoff.appearancePreview, look);
  assert.equal(handoff.accountProvider, "openai");
  assert.equal(handoff.accountExpanded, false);
});

test("the same look as saved needs no preview", () => {
  const handoff = onboardingHandoff(saved, { appearance: { theme: saved.theme, chatFont: saved.chatFont, effortSlider: saved.effortSlider } });
  assert.equal(handoff.appearancePreview, null);
  assert.equal(appearanceDiffers(saved, undefined), false);
});

test("plain Settings opens collapsed on the default provider", () => {
  const handoff = onboardingHandoff(saved, undefined);
  assert.equal(handoff.local, saved);
  assert.equal(handoff.accountProvider, "openai");
  assert.equal(handoff.accountExpanded, false);
  assert.equal(handoff.appearancePreview, null);
});

test("only the explicit actions change what is saved", () => {
  const asDefault = settingsWithDefaultProvider(saved, "claude");
  assert.equal(asDefault.provider, "claude");
  assert.notEqual(asDefault.model, saved.model);
  assert.equal(asDefault.defaultModelExplicit, false);
  const applied = settingsWithAppearance(saved, { theme: "synthwave", chatFont: "serif", effortSlider: "studio" });
  assert.equal(applied.theme, "synthwave");
  assert.equal(applied.provider, "openai");
  assert.equal(applied.model, saved.model);
});
