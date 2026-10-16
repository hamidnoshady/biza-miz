import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DASHBOARD_HOME } from "@/lib/app-routes";

/**
 * Issue #905 — Unified contextual sidebar on the assistant route (`/dashboard`).
 *
 * `WorkspaceRail` renders the global platform navigation (`DASHBOARD_HOME`,
 * `WORKSPACE_MODULE_HOME`, and the four app launchers) and, when
 * `isAssistantSurface(pathname)` is true, integrates the «گفت‌وگوی جدید» action
 * and private «گفتگوهای اخیر» history group (`AiConversationsSidebar`) into the
 * single canonical sidebar instead of mounting a second permanent rail on the
 * chat page.
 */
describe("WorkspaceRail — unified contextual assistant navigation", () => {
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

  it("integrates New Chat and private conversation history into the single contextual rail on the assistant route", () => {
    expect(rail).toContain("isAssistantSurface(pathname)");
    expect(rail).toContain("گفت‌وگوی جدید");
    expect(rail).toContain("AiConversationsSidebar");
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
