import { describe, expect, it } from "vitest";
import { installContextMenuBlocker } from "./contextMenu";

describe("desktop context menu", () => {
  it("prevents right-click menus everywhere and can be cleanly removed", () => {
    const dispose = installContextMenuBlocker(document);
    const blocked = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);

    dispose();
    const restored = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(restored);
    expect(restored.defaultPrevented).toBe(false);
  });
});
