import { describe, expect, it } from "vitest";
import { clipboardImages, createAttachmentPreparationTracker, imageBase64 } from "./clipboardImages";

describe("clipboard image preparation", () => {
  it("captures every image handle before the clipboard becomes inaccessible", async () => {
    let sealed = false;
    const files = [new File(["one"], "one.png", { type: "image/png" }), new File(["two"], "two.png", { type: "image/png" })];
    const items = files.map((file) => ({ type: file.type, getAsFile: () => sealed ? null : file })) as unknown as DataTransferItemList;
    const captured = clipboardImages(items);
    sealed = true;
    expect(await Promise.all(captured.map(imageBase64))).toEqual([btoa("one"), btoa("two")]);
  });
  it("rejects oversized clipboard files before encoding or sending their bytes", async () => {
    const file = new File(["small fixture"], "huge.png", { type: "image/png" });
    Object.defineProperty(file, "size", { value: 51 * 1024 * 1024 });
    await expect(imageBase64(file)).rejects.toThrow("exceeds 50 MB");
  });
  it("waits for all of one draft's images without blocking another draft", async () => {
    const tracker = createAttachmentPreparationTracker();
    let finish!: () => void;
    const image = new Promise<void>((resolve) => { finish = resolve; });
    tracker.track("first", image);
    await tracker.wait("second");
    let delivered = false;
    const waiting = tracker.wait("first").then(() => { delivered = true; });
    await Promise.resolve();
    expect(delivered).toBe(false);
    finish();
    await waiting;
    expect(delivered).toBe(true);
  });
});
