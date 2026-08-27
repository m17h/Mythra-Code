import { describe, expect, it } from "vitest";
import { attachmentKind, attachmentRecord, withAttachedPaths } from "./attachments";
import { attachmentsFor, forgetAttachmentDraft, MAX_ATTACHMENT_DRAFTS, withAttachmentDraft } from "./attachmentDrafts";

describe("attachment classification", () => {
  it("treats every supported image extension as a native image input", () => {
    for (const path of [
      "/p/shot.png",
      "/p/shot.PNG",
      "/p/photo.jpg",
      "/p/photo.jpeg",
      "/p/loop.gif",
      "/p/art.webp",
      "/p/live.heic",
      "C:\\p\\shot.png",
    ]) {
      expect(attachmentKind(path)).toBe("image");
    }
  });

  it("treats everything else as a file reference", () => {
    expect(attachmentKind("/p/notes.md")).toBe("file");
    expect(attachmentKind("/p/png")).toBe("file");
    expect(attachmentKind("/p/image.png.txt")).toBe("file");
  });

  it("names records from the last path segment on both platforms", () => {
    expect(attachmentRecord("/p/dir/shot.png")).toEqual({ path: "/p/dir/shot.png", name: "shot.png", kind: "image" });
    expect(attachmentRecord("C:\\p\\dir\\notes.md")).toEqual({ path: "C:\\p\\dir\\notes.md", name: "notes.md", kind: "file" });
  });

  it("adds only new paths and never duplicates within one batch", () => {
    const first = withAttachedPaths([], ["/p/a.png", "/p/a.png", "/p/b.md"]);
    expect(first.map((item) => item.path)).toEqual(["/p/a.png", "/p/b.md"]);
    expect(withAttachedPaths(first, ["/p/a.png"])).toBe(first);
  });
});

describe("attachment drafts", () => {
  it("keeps each thread's attachments separate", () => {
    let drafts = withAttachmentDraft({}, "thread-a", [attachmentRecord("/p/a.png")]);
    drafts = withAttachmentDraft(drafts, "thread-b", [attachmentRecord("/p/b.md")]);
    expect(attachmentsFor(drafts, "thread-a").map((item) => item.path)).toEqual(["/p/a.png"]);
    expect(attachmentsFor(drafts, "thread-b").map((item) => item.path)).toEqual(["/p/b.md"]);
    expect(attachmentsFor(drafts, "thread-c")).toEqual([]);
  });

  it("drops a draft once its last attachment is removed", () => {
    const drafts = withAttachmentDraft({ "thread-a": [attachmentRecord("/p/a.png")] }, "thread-a", []);
    expect(drafts).toEqual({});
  });

  it("forgets a deleted thread's draft", () => {
    const drafts = { "thread-a": [attachmentRecord("/p/a.png")] };
    expect(forgetAttachmentDraft(drafts, "thread-a")).toEqual({});
    expect(forgetAttachmentDraft(drafts, "thread-z")).toBe(drafts);
  });

  it("caps growth without evicting the draft being written", () => {
    let drafts = {};
    for (let index = 0; index < MAX_ATTACHMENT_DRAFTS + 5; index += 1) {
      drafts = withAttachmentDraft(drafts, `thread-${index}`, [attachmentRecord(`/p/${index}.md`)]);
    }
    const keys = Object.keys(drafts);
    expect(keys).toHaveLength(MAX_ATTACHMENT_DRAFTS);
    expect(keys).toContain(`thread-${MAX_ATTACHMENT_DRAFTS + 4}`);
    expect(keys).not.toContain("thread-0");
  });
});
