import { describe, expect, it } from "vitest";
import {
  buildEditorialUserPrompt,
  EDITORIAL_ACTIONS,
  EDITORIAL_LIMITS,
  EDITORIAL_SYSTEM_PROMPT,
  isEditorialAction,
  isEditorialLanguage,
  isEditorialTone,
  parseEditorialReply,
} from "./editorial-ai";

describe("editorial prompt", () => {
  it("forbids invented facts and HTML", () => {
    expect(EDITORIAL_SYSTEM_PROMPT).toContain("واقعیت تازه");
    expect(EDITORIAL_SYSTEM_PROMPT).toContain("بدون HTML");
    expect(EDITORIAL_SYSTEM_PROMPT).toContain('{"text"');
  });

  it("carries the editor's own unsaved text", () => {
    const prompt = buildEditorialUserPrompt({
      action: "shorten",
      title: "نگهداری فرش",
      content: "<p>متن بلند</p>",
      excerpt: "خلاصه",
    });

    expect(prompt).toContain("کوتاه‌تر");
    expect(prompt).toContain("عنوان فعلی: نگهداری فرش");
    expect(prompt).toContain("متن فعلی: <p>متن بلند</p>");
    expect(prompt).toContain("خلاصهٔ فعلی: خلاصه");
  });

  it("names the tone and the target language it was asked for", () => {
    expect(buildEditorialUserPrompt({ action: "tone", tone: "formal" })).toContain("لحن «رسمی»");
    expect(buildEditorialUserPrompt({ action: "translate", language: "ar" })).toContain("به عربی");
  });

  it("bounds every field so one page cannot outgrow the request", () => {
    const prompt = buildEditorialUserPrompt({
      action: "rewrite",
      content: "x".repeat(EDITORIAL_LIMITS.content + 5000),
      instruction: "ب".repeat(EDITORIAL_LIMITS.instruction),
    });

    expect(prompt.length).toBeLessThan(EDITORIAL_LIMITS.content + EDITORIAL_LIMITS.instruction + 1000);
  });

  it("skips empty material instead of writing an empty label", () => {
    const prompt = buildEditorialUserPrompt({ action: "title", title: "   ", content: null });

    expect(prompt).not.toContain("عنوان فعلی");
    expect(prompt).not.toContain("متن فعلی");
  });
});

describe("editorial reply", () => {
  it("reads the documented object, even fenced", () => {
    expect(parseEditorialReply('```json\n{"text":"  پیش‌نویس  "}\n```')).toEqual({ text: "پیش‌نویس" });
  });

  it("accepts a bare plain-text answer", () => {
    expect(parseEditorialReply("  یک عنوان کوتاه  ")).toEqual({ text: "یک عنوان کوتاه" });
  });

  it("refuses a malformed object rather than showing raw fragments as a draft", () => {
    expect(parseEditorialReply('{"text":')).toBeNull();
    expect(parseEditorialReply('{"text": 5}')).toBeNull();
    expect(parseEditorialReply('{"body":"x"}')).toBeNull();
    expect(parseEditorialReply('{"text":"   "}')).toBeNull();
    expect(parseEditorialReply("")).toBeNull();
  });
});

describe("editorial vocabulary", () => {
  it("recognises exactly the actions, tones and languages it offers", () => {
    expect(isEditorialAction("rewrite")).toBe(true);
    expect(isEditorialAction("Rewrite")).toBe(false);
    expect(isEditorialTone("story")).toBe(true);
    expect(isEditorialTone("")).toBe(false);
    expect(isEditorialLanguage("en")).toBe(true);
    expect(isEditorialLanguage("de")).toBe(false);
    expect(EDITORIAL_ACTIONS).toHaveLength(9);
  });
});
