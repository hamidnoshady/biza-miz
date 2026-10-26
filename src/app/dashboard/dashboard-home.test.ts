/**
 * `/dashboard` is the assistant chat home — always, for every tenant.
 *
 * The old dashboard had two homes and a flag to pick between them: the
 * `workspace` feature decided whether the business got the chat home or the
 * quick-report dashboard, and off meant a data-heavy backup-health/setup-
 * state/industry load just to draw cards a report renders better. Both homes
 * are retired as options: the chat hub is the page, unconditionally, and the
 * flag's data plumbing is gone with the old surface. This grep-based contract
 * (the same source-of-truth approach `design-lint.test.ts` uses) keeps it
 * that way: the page mounts exactly one surface, behind the one entitlement
 * that still applies.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PAGE_SOURCE = readFileSync(
  fileURLToPath(new URL("./page.tsx", import.meta.url)),
  "utf8",
);
const SHELL_SOURCE = readFileSync(
  fileURLToPath(new URL("./workspace-shell.tsx", import.meta.url)),
  "utf8",
);
const SIDEBAR_SOURCE = readFileSync(
  fileURLToPath(new URL("./dashboard-sidebar.tsx", import.meta.url)),
  "utf8",
);
const MAIN_SOURCE = readFileSync(
  fileURLToPath(new URL("./dashboard-main.tsx", import.meta.url)),
  "utf8",
);
const GATE_SOURCE = readFileSync(
  fileURLToPath(new URL("./app-availability-gate.tsx", import.meta.url)),
  "utf8",
);

/** Strip comments so assertions apply to code, not to explanations. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the dashboard page — always the AI chat home", () => {
  it("mounts exactly one shared AI chat workspace in the shell", () => {
    const src = code(PAGE_SOURCE);
    expect(src).not.toContain("<AiChatHub");
    expect(code(SHELL_SOURCE)).toContain("<TenantAssistantFrame");
    // Never the retired quick-report dashboard or a shell switch.
    expect(src).not.toContain("DashboardOverview");
    expect(src).not.toContain("OperationsOverview");
    expect(src).not.toContain("RetailOverview");
  });

  it("keeps the ai_assistant entitlement — locked tenants get the FeatureLock, nothing lost", () => {
    const src = code(PAGE_SOURCE);
    expect(src).toContain('featureLockedForPage(session.businessId, "ai_assistant")');
    expect(src).toContain("FeatureLock");
    // The role gates that decide who manages the assistant still arrive from
    // the session, not from a client heuristic.
    expect(code(SHELL_SOURCE)).toContain("canManageAi(permissions");
    expect(code(SHELL_SOURCE)).toContain('member.role === "owner"');
  });

  it("does not load the old dashboard's data or branch on the retired shell flag", () => {
    const src = code(PAGE_SOURCE);
    expect(src).not.toContain("getBackupHealth");
    expect(src).not.toContain("SETUP_STATE");
    expect(src).not.toContain("features.workspace");
    expect(src).not.toContain('features["workspace"]');
  });
});

describe("no `features.workspace` runtime checks anywhere in the shell", () => {
  it("the chrome reads no workspace shell variant or flag", () => {
    for (const [name, source] of [
      ["workspace-shell.tsx", SHELL_SOURCE],
      ["dashboard-sidebar.tsx", SIDEBAR_SOURCE],
      ["dashboard-main.tsx", MAIN_SOURCE],
      ["app-availability-gate.tsx", GATE_SOURCE],
    ] as const) {
      const src = code(source);
      expect(src, name).not.toContain("workspaceEnabled");
      expect(src, name).not.toContain("features.workspace");
      expect(src, name).not.toContain('"classic"');
      expect(src, name).not.toContain('"workspace"');
      expect(src, name).not.toContain("variant");
    }
  });
});
