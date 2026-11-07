import test from "node:test";
import assert from "node:assert/strict";
import { formatFeedbackPrompt } from "../../reviewFeedback.ts";
import { promptInvocationText } from "./promptText.ts";
const note = { id: "note", createdAt: 1, anchor: { kind: "assistant", messageId: "m", messageFingerprint: "fingerprint", quote: "Use @quoted-skill" }, comment: "@note-skill is quoted, not selected" };
for (const typed of ["Review with @authored-skill", "", "  Check these @authored-skill  "]) {
  test(`feedback invokes skills only from authored prefix ${JSON.stringify(typed)}`, () => {
    const body = formatFeedbackPrompt(typed, [note]);
    assert.ok(body.includes("@quoted-skill"));
    assert.ok(body.includes("@note-skill"));
    assert.equal(promptInvocationText(body), typed.trim() ? typed : "");
    assert.equal(promptInvocationText(body.trim(), typed), typed);
  });
}
test("ordinary authored skill invocations remain byte-for-byte unchanged", () => {
  const body = "Use @skill to inspect a header: Review feedback (1):";
  assert.equal(promptInvocationText(body), body);
});
test("an explicit authored source can include note comments, but must be a bounded string", () => {
  // Local feedbackSkillInvocationText deliberately includes authored comments,
  // which are not a contiguous prefix of the formatted evidence body.
  assert.equal(promptInvocationText("Formatted feedback", "Typed\n\n@authored-comment"), "Typed\n\n@authored-comment");
  assert.throws(() => promptInvocationText("Plain message", "x".repeat(65537)));
  assert.throws(() => promptInvocationText("Plain message", {}));
  assert.equal(promptInvocationText("Plain message", ""), "");
});
