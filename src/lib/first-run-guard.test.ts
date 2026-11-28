import { describe, expect, it } from "vitest";
import { firstRunRedirect } from "./first-run-guard";

/**
 * Issue #1239 / ESH-90 — the first-run guard's policy.
 *
 * The cases are deliberately written as the *bypasses* the epic names (direct
 * URL, `?next=`, browser Back) plus the two ways a naive guard hurts people
 * (trapping staff, trapping an owner who needs billing/help).
 */
const owner = { canManageSettings: true };

describe("firstRunRedirect", () => {
  it("sends an unfinished owner to the wizard from every guarded workspace entry", () => {
    for (const pathname of [
      "/dashboard",
      "/accounting",
      "/accounting/pos",
      "/crm",
      "/crm/deals",
      "/growth",
      "/websites/wp",
      "/workspace",
      // GitHub #1580 — the internal settings area and operational workspaces
      // are not onboarding surfaces. Direct URL, `?next=`, Back and a mobile
      // drawer all reach the same shell, so the same answer applies.
      "/settings",
      "/settings/transfer",
      "/settings/data-transfer",
      "/settings/tax",
      "/petty-cash",
      "/petty-cash/new",
    ]) {
      expect(
        firstRunRedirect({ pathname, setupComplete: false, ...owner }),
        pathname,
      ).toBe("/setup");
    }
  });

  it("keeps the wizard, its recovery surfaces and the connection return reachable", () => {
    for (const pathname of [
      "/setup",
      "/setup/business",
      "/setup/apps",
      "/setup/import",
      "/setup/menu",
      "/settings/billing",
      "/settings/security",
      "/settings/profile",
      // Provider OAuth/link returns and safe connection recovery land here; a
      // guard that blocked it would strand a callback mid-onboarding.
      "/settings/connections",
      "/settings/connections/holoo",
      "/knowledge",
      "/knowledge/a/setup-wizard",
      "/support",
    ]) {
      expect(
        firstRunRedirect({ pathname, setupComplete: false, ...owner }),
        pathname,
      ).toBeNull();
    }
  });

  it("never redirects once the canonical completion marker is set", () => {
    expect(
      firstRunRedirect({ pathname: "/dashboard", setupComplete: true, ...owner }),
    ).toBeNull();
  });

  it("never traps a member who cannot complete the wizard", () => {
    // A cashier/waiter on a brand-new business still lands on their own
    // dashboard: `/setup` would refuse them, so sending them there is a loop.
    expect(
      firstRunRedirect({
        pathname: "/dashboard",
        setupComplete: false,
        canManageSettings: false,
      }),
    ).toBeNull();
  });

  it("leaves routes outside the workspace alone", () => {
    // Login, the platform console, MFA, the public signing page: none of them
    // render the shell, and redirecting them would break a legitimate entry.
    for (const pathname of ["/login", "/admin", "/platform", "/invite", "/sign"]) {
      expect(
        firstRunRedirect({ pathname, setupComplete: false, ...owner }),
        pathname,
      ).toBeNull();
    }
  });

  it("matches whole path segments, not text prefixes", () => {
    // `/dashboards-old` and `/accountingx` are not workspace routes; a text
    // `startsWith` would send them to the wizard.
    for (const pathname of ["/dashboarding", "/accountingx", "/crminbox"]) {
      expect(
        firstRunRedirect({ pathname, setupComplete: false, ...owner }),
        pathname,
      ).toBeNull();
    }
  });

  it("fails open when the pathname was not stamped", () => {
    // Middleware stamps `x-pathname`; a runtime that did not (a bare component
    // render, a unit test) must not be answered with a global redirect.
    expect(firstRunRedirect({ pathname: "", setupComplete: false, ...owner })).toBeNull();
    expect(firstRunRedirect({ pathname: "   ", setupComplete: false, ...owner })).toBeNull();
  });
});
