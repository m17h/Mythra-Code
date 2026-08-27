import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENT_DRAFTS,
  attachmentsFor,
  forgetAttachmentDraft,
  withAttachmentDraft,
  type AttachmentDrafts,
} from "./attachmentDrafts";

const attachment = (path: string) => ({ path, name: path, kind: "file" as const });

describe("attachment drafts", () => {
  it("keeps attachments isolated by draft key", () => {
    const drafts = withAttachmentDraft({}, "thread-a", [attachment("a.txt")]);
    expect(attachmentsFor(drafts, "thread-a")).toEqual([attachment("a.txt")]);
    expect(attachmentsFor(drafts, "thread-b")).toEqual([]);
  });

  it("removes empty and explicitly forgotten drafts", () => {
    const drafts = withAttachmentDraft({}, "thread-a", [attachment("a.txt")]);
    expect(withAttachmentDraft(drafts, "thread-a", [])).toEqual({});
    expect(forgetAttachmentDraft(drafts, "thread-a")).toEqual({});
  });

  it("enforces the cap even when the refreshed key is the oldest property", () => {
    let drafts: AttachmentDrafts = {};
    for (let index = 0; index < MAX_ATTACHMENT_DRAFTS; index += 1) {
      drafts = withAttachmentDraft(drafts, `thread-${index}`, [attachment(`${index}.txt`)]);
    }

    const capped = withAttachmentDraft(drafts, "thread-0", [attachment("refreshed.txt")]);
    const overflowed = withAttachmentDraft(capped, "thread-new", [attachment("new.txt")]);

    expect(Object.keys(overflowed)).toHaveLength(MAX_ATTACHMENT_DRAFTS);
    expect(attachmentsFor(overflowed, "thread-new")).toEqual([attachment("new.txt")]);
    expect(attachmentsFor(overflowed, "thread-0")).toEqual([attachment("refreshed.txt")]);
    expect(attachmentsFor(overflowed, "thread-1")).toEqual([]);
  });
});
