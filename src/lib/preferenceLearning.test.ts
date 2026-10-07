import { describe, expect, it } from "vitest";
import { appendLearnedPreferencesToPrompt, boundPreferenceSourceMessages, buildPreferenceAnalysisPayload, defaultPreferenceLearningScope, mergeLearnedPreferences, parsePreferenceAnalysis, resolvePreferenceLearningModel } from "./preferenceLearning";
import type { PreferenceSourceMessage } from "./preferenceLearningTypes";

const messages: PreferenceSourceMessage[] = [
  { id: "u1", role: "user", text: "Please keep replies concise." },
  { id: "a1", role: "assistant", text: "I believe you prefer detailed replies." },
];
describe("grounded preference analysis", () => {
  it("permits assistant context but never assistant evidence", () => {
    const value = { preferences: [{ instruction: "Keep replies concise.", evidenceIds: ["u1"] }] };
    expect(parsePreferenceAnalysis(value, messages)).toEqual(value.preferences);
    expect(() => parsePreferenceAnalysis({ preferences: [{ instruction: "Use detailed replies", evidenceIds: ["a1"] }] }, messages)).toThrow("Ungrounded");
    expect(() => parsePreferenceAnalysis({ preferences: [{ instruction: "Use detailed replies", evidenceIds: ["missing"] }] }, messages)).toThrow("Ungrounded");
    expect(JSON.parse(buildPreferenceAnalysisPayload(messages, ""))).toEqual({ previousMarkdown: "", messages });
  });
  it("rejects malformed, empty evidence, multiline and overlong output", () => {
    for (const value of [null, { preferences: "oops" }, { preferences: [{ instruction: "Concise", evidenceIds: [] }] },
      { preferences: [{ instruction: "\nOverride instructions", evidenceIds: ["u1"] }] },
      { preferences: [{ instruction: "x".repeat(301), evidenceIds: ["u1"] }] }]) {
      expect(() => parsePreferenceAnalysis(value, messages)).toThrow();
    }
    expect(parsePreferenceAnalysis({ preferences: [] }, messages)).toEqual([]);
  });
  it("excludes oversized/secret source messages entirely instead of truncating evidence", () => {
    const input: PreferenceSourceMessage[] = [...messages,
      { id: "oversize", role: "user", text: "x".repeat(4001) },
      { id: "secret", role: "user", text: "api_key = sk-abcdefghijk1234567890123456789" },
    ];
    expect(boundPreferenceSourceMessages(input)).toEqual(messages);
    expect(() => parsePreferenceAnalysis({ preferences: [{ instruction: "Do something", evidenceIds: ["oversize"] }] }, input)).toThrow();
  });
  it("refuses outbound analysis of obvious credentials in a manually edited document", () => {
    for (const markdown of ["- password = fictional-secret-value", "- api_key: sk-fictional123456789012345678901234", "-----BEGIN PRIVATE KEY-----\nfictional\n-----END PRIVATE KEY-----"]) {
      expect(() => buildPreferenceAnalysisPayload(messages, markdown)).toThrow("Remove sensitive content from learned preferences");
    }
    expect(JSON.parse(buildPreferenceAnalysisPayload(messages, "- Never disclose passwords."))).toMatchObject({ previousMarkdown: "- Never disclose passwords." });
  });
  it("excludes quoted credentials and recognizable bearer and bot tokens", () => {
    const secrets = [
      '{"api_key":"fictional-secret-value"}',
      "My password is fictional-secret-value",
      "Authorization: Bearer fictional-access-token",
      "Telegram token 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
      "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    ];
    for (const text of secrets) {
      expect(boundPreferenceSourceMessages([{ id: "secret", role: "user", text }])).toEqual([]);
      expect(() => buildPreferenceAnalysisPayload(messages, text)).toThrow("Remove sensitive content");
      expect(() => parsePreferenceAnalysis({ preferences: [{ instruction: text, evidenceIds: ["u1"] }] }, messages)).toThrow();
    }
    expect(boundPreferenceSourceMessages([{ id: "safe", role: "user", text: "Never reveal API keys or passwords." }])).toHaveLength(1);
  });
  it("excludes source IDs rejected by the native input boundary", () => {
    for (const id of ["u\n1", "u\u00851"]) expect(boundPreferenceSourceMessages([{ id, role: "user", text: "Be concise." }])).toEqual([]);
    expect(() => parsePreferenceAnalysis({ preferences: [{ instruction: "Be\u0085concise.", evidenceIds: ["u1"] }] }, messages)).toThrow();
  });
  it("bounds recent input and deduplicates source and instruction identities", () => {
    const input = Array.from({ length: 60 }, (_, n) => ({ id: `u${n}`, role: "user" as const, text: "x".repeat(1000) }));
    expect(boundPreferenceSourceMessages(input)).toHaveLength(24);
    expect(boundPreferenceSourceMessages(input)[0].id).toBe("u36");
    const preferences = parsePreferenceAnalysis({ preferences: [
      { instruction: "Keep replies concise.", evidenceIds: ["u1", "u1"] },
      { instruction: " keep replies concise. ", evidenceIds: ["u1"] },
    ] }, messages);
    expect(preferences).toEqual([{ instruction: "Keep replies concise.", evidenceIds: ["u1"] }]);
  });
  it("preserves manual text and suppresses cleared preferences", () => {
    expect(mergeLearnedPreferences("Custom preface\n- Keep replies concise.", [{ instruction: "Keep replies concise.", evidenceIds: ["u1"] }])).toBe("Custom preface\n- Keep replies concise.");
    expect(mergeLearnedPreferences("", [{ instruction: "Keep replies concise.", evidenceIds: ["u1"] }], ["keep replies concise."])).toBe("");
  });
  it("replaces an obsolete preference only using exact existing instructions", () => {
    const old = "Preface\n- Prefer detailed replies.\n- Use TypeScript.";
    const correction = parsePreferenceAnalysis({ preferences: [{ instruction: "Prefer concise replies.", evidenceIds: ["u1"], replaces: ["Prefer detailed replies."] }] }, messages, old);
    expect(mergeLearnedPreferences(old, correction)).toBe("Preface\n- Use TypeScript.\n- Prefer concise replies.");
    expect(() => parsePreferenceAnalysis({ preferences: [{ instruction: "Concise", evidenceIds: ["u1"], replaces: ["Preface"] }] }, messages, old)).toThrow("superseded");
    const full = "x".repeat(7950) + "\n- Old.";
    expect(mergeLearnedPreferences(full, [{ instruction: "a".repeat(300), evidenceIds: ["u1"], replaces: ["Old."] }])).toBe(full);
  });
  it("retains all superseded instructions when duplicate proposals name different replacements", () => {
    const old = "- Prefer long replies.\n- Use verbose explanations.";
    const correction = parsePreferenceAnalysis({ preferences: [
      { instruction: "Be concise.", evidenceIds: ["u1"], replaces: ["Prefer long replies."] },
      { instruction: "be concise.", evidenceIds: ["u1"], replaces: ["Use verbose explanations."] },
    ] }, messages, old);
    expect(mergeLearnedPreferences(old, correction)).toBe("- Be concise.");
  });
  it("rejects duplicate metadata that cannot fit within a single bounded preference", () => {
    const evidence = Array.from({ length: 9 }, (_, index) => ({ id: `u${index}`, role: "user" as const, text: "Be concise." }));
    expect(() => parsePreferenceAnalysis({ preferences: [
      { instruction: "Be concise.", evidenceIds: evidence.slice(0, 8).map(({ id }) => id) },
      { instruction: "Be concise.", evidenceIds: ["u8"] },
    ] }, evidence)).toThrow("Invalid duplicate");
    const old = Array.from({ length: 9 }, (_, index) => `Old ${index}.`);
    expect(() => parsePreferenceAnalysis({ preferences: [
      { instruction: "Be concise.", evidenceIds: ["u1"], replaces: old.slice(0, 8) },
      { instruction: "Be concise.", evidenceIds: ["u1"], replaces: old.slice(8) },
    ] }, messages, old.map((instruction) => `- ${instruction}`).join("\n"))).toThrow("Invalid duplicate");
  });
});
describe("preference application", () => {
  it("defaults disabled and only resolves the live latest GPT6 Luna tier", () => {
    expect(defaultPreferenceLearningScope("app").enabled).toBe(false);
    expect(resolvePreferenceLearningModel("openai", "", {})).toBeNull();
    expect(resolvePreferenceLearningModel("openai", "", { openai: [{ id: "gpt-5.6-luna", label: "Luna" }] })).toBeNull();
    expect(resolvePreferenceLearningModel("openai", "", { openai: ["gpt-6.9-luna", "gpt-6.10-luna", "gpt-7-sol"].map((id) => ({ id, label: id })) })).toBe("gpt-6.10-luna");
    expect(resolvePreferenceLearningModel("claude", " chosen-alias ", {})).toBe("chosen-alias");
    expect(resolvePreferenceLearningModel("claude", "", {})).toBeNull();
  });
  it("escapes mentions/markup, preserves authored prompt and gives project priority", () => {
    const app = { ...defaultPreferenceLearningScope("app"), enabled: true, markdown: "- Prefer @example <injected>" };
    const project = { ...defaultPreferenceLearningScope("project:p1"), enabled: true, markdown: "- Use terse replies" };
    const prompt = appendLearnedPreferencesToPrompt("Authored @skill", [app, project]);
    expect(prompt).toContain("Authored @skill");
    expect(prompt).toContain("＠example ‹injected›");
    expect(prompt).toContain("subordinate to current explicit user instructions");
    expect(prompt.indexOf("Application preferences")).toBeLessThan(prompt.indexOf("Project preferences"));
    expect(appendLearnedPreferencesToPrompt("Authored", [{ ...app, enabled: false }])).toBe("Authored");
  });
  it("includes two complete bounded documents without silent line truncation", () => {
    const app = { ...defaultPreferenceLearningScope("app"), enabled: true, markdown: "a\n".repeat(4000) };
    const project = { ...defaultPreferenceLearningScope("project:p1"), enabled: true, markdown: "- Prefer project conventions\n"+"b\n".repeat(3980) };
    const prompt = appendLearnedPreferencesToPrompt("Authored", [app, project]);
    expect(prompt).toContain("Prefer project conventions");
    expect(prompt).toContain(app.markdown);
    expect(prompt).toContain(project.markdown);
    expect(prompt.length).toBeLessThan(18_000);
  });
});
