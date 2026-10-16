import { describe, expect, it } from "vitest";
import {
  AI_PANEL_PARAM,
  AI_PANEL_SECTION_KEYS,
  AI_PANEL_SECTIONS,
  aiPanelHref,
  aiPanelSection,
  canManageAi,
  isAiPanelSectionKey,
  resolveAllowedAiPanelSections,
} from "./ai-panel";

describe("AI panel section registry", () => {
  it("lists every declared section exactly once, in key order", () => {
    expect(AI_PANEL_SECTIONS.map((s) => s.key)).toEqual([...AI_PANEL_SECTION_KEYS]);
    const keys = new Set(AI_PANEL_SECTIONS.map((s) => s.key));
    expect(keys.size).toBe(AI_PANEL_SECTIONS.length);
  });

  it("gives every section a label, a description and an icon", () => {
    for (const section of AI_PANEL_SECTIONS) {
      expect(section.label.length).toBeGreaterThan(0);
      expect(section.description.length).toBeGreaterThan(0);
      expect(section.icon.length).toBeGreaterThan(0);
    }
  });

  it("addresses every section on the chat home, never at a second AI application", () => {
    for (const section of AI_PANEL_SECTIONS) {
      expect(aiPanelHref(section.key)).toBe(`/dashboard?${AI_PANEL_PARAM}=${section.key}`);
      expect(aiPanelHref(section.key).startsWith("/ai")).toBe(false);
    }
  });

  it("parses only real section keys from the URL", () => {
    for (const key of AI_PANEL_SECTION_KEYS) {
      expect(isAiPanelSectionKey(key)).toBe(true);
    }
    expect(isAiPanelSectionKey("chat")).toBe(false);
    expect(isAiPanelSectionKey("overview")).toBe(false);
    expect(isAiPanelSectionKey("agents")).toBe(false);
    expect(isAiPanelSectionKey("knowledge")).toBe(false);
    expect(isAiPanelSectionKey("")).toBe(false);
    expect(isAiPanelSectionKey(null)).toBe(false);
    expect(isAiPanelSectionKey(undefined)).toBe(false);
  });

  it("throws on an unknown section key", () => {
    // @ts-expect-error — deliberately wrong key
    expect(() => aiPanelSection("nope")).toThrow(/unknown/);
  });
});

describe("AI panel role gate", () => {
  it("admits owner and manager", () => {
    expect(canManageAi("owner")).toBe(true);
    expect(canManageAi("manager")).toBe(true);
    for (const key of AI_PANEL_SECTION_KEYS) {
      expect(canManageAi("owner", key)).toBe(true);
      expect(canManageAi("manager", key)).toBe(true);
    }
  });

  it("keeps cashier, waiter, kitchen and accountant out", () => {
    for (const role of ["cashier", "waiter", "kitchen", "accountant"]) {
      expect(canManageAi(role)).toBe(false);
      for (const key of AI_PANEL_SECTION_KEYS) {
        expect(canManageAi(role, key)).toBe(false);
      }
    }
  });

  it("evaluates per-section capabilities from effective permission sets", () => {
    const usageOnly = new Set(["ai.use", "ai.usage.view"]);
    expect(canManageAi(usageOnly)).toBe(true);
    expect(canManageAi(usageOnly, "usage")).toBe(true);
    expect(canManageAi(usageOnly, "memory")).toBe(false);
    expect(canManageAi(usageOnly, "automations")).toBe(false);
    expect(resolveAllowedAiPanelSections(usageOnly, { deepResearchEnabled: false })).toEqual([
      "usage",
    ]);
    expect(resolveAllowedAiPanelSections(usageOnly, { deepResearchEnabled: true })).toEqual([
      "research",
      "usage",
    ]);

    const automationsOnly = new Set(["ai.use", "ai.automations.manage"]);
    expect(
      resolveAllowedAiPanelSections(automationsOnly, { deepResearchEnabled: false }),
    ).toEqual(["automations"]);

    const fullManage = new Set(["ai.use", "ai.manage"]);
    expect(resolveAllowedAiPanelSections(fullManage)).toEqual([...AI_PANEL_SECTION_KEYS]);
  });
});
