import test from "node:test";
import assert from "node:assert/strict";
import { PANE_BOUNDS, STAGE_MIN_WIDTH, dockFitMax, fittedDockWidth, reviewWideFit, sidebarCrowdsDock } from "./usePaneResize.ts";

// Sol R5 B02: 1280x800 at 125% with the sidebar open and a saved 650px Tools.
const crowded = { windowWidth: 1280, scale: 1.25, sidebarWidth: 260 };

test("a saved Tools width is drawn narrower so the chat keeps its minimum", () => {
  const drawn = fittedDockWidth(650, crowded);
  const shell = 1280 / 1.25;
  assert.ok(drawn < 650);
  assert.ok(shell - 260 - drawn >= STAGE_MIN_WIDTH, `chat ${shell - 260 - drawn}`);
  assert.ok(drawn >= PANE_BOUNDS.dock.min);
});

test("the saved width comes back on a window with room for it", () => {
  assert.equal(fittedDockWidth(650, { windowWidth: 1920, scale: 1, sidebarWidth: 260 }), 650);
  assert.equal(fittedDockWidth(650, { windowWidth: 1440, scale: 1, sidebarWidth: 260 }), 650);
});

test("every supported window and scale keeps the chat usable or tucks the sidebar", () => {
  for (const windowWidth of [980, 1024, 1280, 1440, 1920]) {
    for (const scale of [0.8, 1, 1.25, 1.5]) {
      for (const saved of [340, 430, 650, 760]) {
        const shell = windowWidth / scale;
        const tuck = sidebarCrowdsDock({ windowWidth, scale, sidebarWidth: 260 });
        const sidebarWidth = tuck ? 0 : 260;
        const drawn = fittedDockWidth(saved, { windowWidth, scale, sidebarWidth });
        // Where even the narrowest dock can't leave the minimum, the chat still
        // gets everything beyond that narrowest dock.
        const chat = shell - sidebarWidth - drawn;
        assert.ok(chat >= Math.min(STAGE_MIN_WIDTH, shell - PANE_BOUNDS.dock.min), `${windowWidth}@${scale} saved ${saved}: chat ${chat}`);
        assert.ok(drawn <= saved);
      }
    }
  }
});

test("the sidebar tucks only when the narrowest dock beside it would crowd the chat", () => {
  assert.equal(sidebarCrowdsDock({ windowWidth: 1280, scale: 1.5, sidebarWidth: 260 }), true);
  assert.equal(sidebarCrowdsDock(crowded), false);
  assert.equal(sidebarCrowdsDock({ windowWidth: 1440, scale: 1, sidebarWidth: 420 }), false);
  // A floating sheet (900px and below) covers the chat by design.
  assert.equal(sidebarCrowdsDock({ windowWidth: 880, scale: 1.25, sidebarWidth: 260 }), false);
  assert.equal(dockFitMax({ windowWidth: 880, scale: 1.25, sidebarWidth: 260 }), PANE_BOUNDS.dock.max);
});

test("wide review leaves a strip of chat sized to the window", () => {
  const roomy = reviewWideFit({ shellWidth: 1440, mainLeft: 260, mainWidth: 1180 });
  assert.equal(roomy.strip, 240);
  assert.equal(roomy.width, 940);
  const small = reviewWideFit({ shellWidth: 1024, mainLeft: 260, mainWidth: 764 });
  assert.ok(small.strip < 240 && small.strip >= 96);
  assert.equal(small.width, 1024 - 260 - small.strip);
  assert.equal(reviewWideFit({ shellWidth: 2560, mainLeft: 260, mainWidth: 2300 }).width, 1180);
});
