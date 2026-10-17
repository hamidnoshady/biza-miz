import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DASHBOARD_HOME } from "@/lib/app-routes";

/**
 * Issue #905 (2026-10-17 owner UX correction) — Workspace rail navigation.
 *
 * `WorkspaceRail` renders the global platform navigation (`DASHBOARD_HOME`,
 * `WORKSPACE_MODULE_HOME`, and the four app launchers). Private conversation
 * history and «گفت‌وگوی جدید» live in the assistant's own collapsible left
 * history panel rather than duplicating inside the right-side platform rail.
 */
describe("WorkspaceRail — platform navigation without duplicated chat history", () => {
  const sidebar = readFileSync("src/app/dashboard/dashboard-sidebar.tsx", "utf8");
  const railStart = sidebar.indexOf("function WorkspaceRail");
  const railEnd = sidebar.indexOf("\nfunction SidebarBrand", railStart);
  const rail = sidebar.slice(railStart, railEnd);

  it("links the assistant launcher to DASHBOARD_HOME (/dashboard), never /ai", () => {
    expect(DASHBOARD_HOME).toBe("/dashboard");
    expect(rail).toContain("href={DASHBOARD_HOME}");
    expect(rail).toContain("دستیار هوشمند");
    expect(rail).not.toContain('"/ai"');
    expect(rail).not.toContain("'/ai'");
    expect(rail).not.toContain("href={`/ai");
  });

  it("does not duplicate conversation history or New Chat inside the right-side workspace rail", () => {
    expect(rail).not.toContain("AiConversationsSidebar");
    expect(rail).not.toContain("گفت‌وگوی جدید");
    expect(rail).not.toContain("/api/ai/conversations");
  });

  it("keeps only the four business apps under برنامه‌ها", () => {
    const appsBlock = sidebar.slice(
      sidebar.indexOf("const WORKSPACE_APP_LAUNCHERS"),
      sidebar.indexOf("function WorkspaceRail"),
    );
    const keys = Array.from(appsBlock.matchAll(/key:\s*"([^"]+)"/g), (m) => m[1]);
    expect(keys).toEqual(["accounting", "crm", "growth", "website"]);
  });
});
