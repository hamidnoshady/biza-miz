import { describe, expect, it, vi } from "vitest";
import { renderMemoryForPrompt, type AiMemoryEntry } from "./ai-memory";

vi.mock("./db", () => ({ query: vi.fn() }));

function entry(content: string): AiMemoryEntry {
  return {
    id: content.slice(0, 24), businessId: "biz-1", scope: "tenant", appKey: null,
    projectId: null, createdBy: "member-1", source: "manual",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", content,
  };
}

const empty = { platform: [], tenant: [], app: [], project: [] };

describe("durable memory prompt selection", () => {
  it("ranks Persian matches within the current layer without reversing layer precedence", () => {
    const text = renderMemoryForPrompt({
      ...empty,
      platform: [entry("سیاست پلتفرم")],
      tenant: [entry("شرایط ارسال"), entry("كنترل موجودي")],
      project: [entry("موجودی پروژه بهار")],
    }, "کنترل موجودی");
    const ordered = ["سیاست پلتفرم", "كنترل موجودي", "شرایط ارسال", "موجودی پروژه بهار"].map((label) => text.indexOf(label));
    expect(ordered.every((position) => position >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
  });

  it("keeps the first layer's copy and lets identical entries release context budget", () => {
    const text = renderMemoryForPrompt({
      ...empty,
      tenant: [entry("سیاست   ارسال رایگان")],
      app: [entry("سياست ارسال رایگان"), entry("ارسال سریع")],
    });
    expect(text).toContain("سیاست   ارسال رایگان");
    expect(text).not.toContain("سياست ارسال رایگان");
    expect(text).toContain("ارسال سریع");
  });

  it("lets a later layer render a fact the earlier layer had no budget for", () => {
    const text = renderMemoryForPrompt({
      ...empty,
      platform: [entry("p".repeat(4_000)), entry("q".repeat(4_000)), entry("shared fact")],
      tenant: [entry("shared fact"), entry("tenant extra")],
    });
    // The platform copy was cut by the budget, so dropping the tenant copy
    // would remove the fact from the prompt entirely.
    expect(text).toContain("shared fact");
    expect(text).toContain("tenant extra");
  });

  it("leaves room for active project context after a large platform layer", () => {
    const text = renderMemoryForPrompt({
      ...empty,
      platform: Array.from({ length: 10 }, (_, index) => entry(index + "a".repeat(4_000))),
      project: [entry("project-specific fact")],
    });
    expect(text.length).toBeLessThan(12_400);
    expect(text).toContain("project-specific fact");
  });
});
