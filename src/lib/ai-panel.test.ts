import { describe, expect, it } from "vitest";
import {
  AI_PANEL_PARAM,
  AI_PANEL_SECTION_KEYS,
  AI_PANEL_SECTIONS,
  aiPanelHref,
  aiPanelSection,
  canManageAi,
  isAiPanelSectionKey,
} from "./ai-panel";
import { PERMISSIONS } from "./permissions";

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
    expect(isAiPanelSectionKey("")).toBe(false);
    expect(isAiPanelSectionKey(null)).toBe(false);
    expect(isAiPanelSectionKey(undefined)).toBe(false);
  });

  it("throws on an unknown section key", () => {
    // @ts-expect-error — deliberately wrong key
    expect(() => aiPanelSection("nope")).toThrow(/unknown/);
  });
});

describe("AI panel capability gate", () => {
  it("uses the umbrella management permission for every section", () => {
    const effective = new Set([PERMISSIONS.aiManage]);
    expect(canManageAi(effective)).toBe(true);
    for (const key of AI_PANEL_SECTION_KEYS) expect(canManageAi(effective, key)).toBe(true);
  });

  it("supports section-specific custom-role grants without widening other panels", () => {
    const effective = new Set([PERMISSIONS.aiKnowledgeManage]);
    expect(canManageAi(effective)).toBe(true);
    expect(canManageAi(effective, "knowledge")).toBe(true);
    expect(canManageAi(effective, "agents")).toBe(false);
    expect(canManageAi(effective, "usage")).toBe(false);
  });

  it("keeps a member with only ai.use out of every management section", () => {
    const effective = new Set([PERMISSIONS.aiUse]);
    expect(canManageAi(effective)).toBe(false);
    for (const key of AI_PANEL_SECTION_KEYS) expect(canManageAi(effective, key)).toBe(false);
  });
});
