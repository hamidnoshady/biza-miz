/**
 * The API authorization contract — asserted against the route sources.
 *
 * ## Why source inspection rather than live requests
 *
 * The repository has no integration harness that can boot a tenant, a session
 * and Postgres for each of ~900 route files, and the property these tests guard
 * is structural rather than behavioural: *every route has a guard, and the
 * guard is the canonical one*. A route that forgets its guard entirely, or that
 * reintroduces a bespoke role comparison, is a security regression that this
 * catches at the exact moment it is written — which is the point. The
 * behaviour of the guard itself is tested directly in `src/lib/authorize.test.ts`.
 *
 * Three properties are enforced:
 *
 *   1. No route handler is unguarded.
 *   2. No route re-implements authorization inline instead of calling a guard.
 *   3. The families migrated off role-only gating stay migrated.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { globSync } from "tinyglobby";
import { roleBasePermissions } from "@/lib/permissions";

const API_DIR = join(process.cwd(), "src/app/api");
const ROUTES = globSync("**/route.ts", { cwd: API_DIR }).sort();

const read = (relative: string) => readFileSync(join(API_DIR, relative), "utf8");

/**
 * Inline role comparisons that are genuinely about role *identity*, with the
 * reason each one is not a capability in disguise. Anything not listed here
 * must go through the canonical evaluator.
 *
 * These are no longer a security problem in themselves: since the
 * consolidation, the `session` a guard hands back always carries the role the
 * *database* holds, so an inline comparison can no longer be fooled by a stale
 * token. They remain listed because a role comparison should be a deliberate,
 * justified choice rather than a habit.
 */
const JUSTIFIED_ROLE_CHECKS: Record<string, string> = {
  "ai/automations/route.ts":
    "an automation set to run without human approval acts with the tenant's authority and " +
    "nobody's supervision; committing the business to that is ownership, not a delegable capability",
  "ai/automations/[id]/route.ts": "the autonomous-approval rule of ai/automations, on one record",
  "ai/automations/[id]/run/route.ts": "the autonomous-approval rule of ai/automations, on one run",
  "ai/coworker/jobs/route.ts": "the autonomous-approval rule of ai/automations, for coworker jobs",
  "ai/coworker/jobs/[id]/route.ts": "the autonomous-approval rule of ai/automations, on one job",
  "ai/chat/route.ts":
    "selects the narrow read-only floor assistant for till roles; the role IS the product " +
    "decision about which assistant a person is given, not a permission they hold",
};

/**
 * Note: "every route has *a* guard" is already enforced, with its own
 * documented allowlist of deliberately public endpoints, by
 * `src/app/api/api-guards.test.ts`. This file does not repeat that — it asserts
 * the properties that test does not: that the guards are the canonical ones,
 * and that the migrated families stay migrated.
 */
describe("no route re-implements authorization inline", () => {
  /**
   * The pattern the refactor removed: comparing `session.role` by hand instead
   * of asking the canonical evaluator. An inline comparison reads the role from
   * the JWT, so it silently skips every membership, tenant-status and
   * revocation check the guard performs.
   */
  it("never compares session.role against a literal outside the justified list", () => {
    const offenders = ROUTES.filter(
      (relative) =>
        /session\.role\s*(===|!==)\s*["']/.test(read(relative)) &&
        !(relative in JUSTIFIED_ROLE_CHECKS),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the justified list honest — every entry still contains a role check", () => {
    // A stale allowlist is worse than none: it silently exempts a file that has
    // since grown a different, unreviewed comparison.
    const stale = Object.keys(JUSTIFIED_ROLE_CHECKS).filter(
      (relative) => !/session\.role\s*(===|!==)\s*["']/.test(read(relative)),
    );
    expect(stale).toEqual([]);
  });

  it("gives a substantive reason for every exemption", () => {
    for (const [route, reason] of Object.entries(JUSTIFIED_ROLE_CHECKS)) {
      expect(reason.length, route).toBeGreaterThan(40);
    }
  });

  it("never gates on an inline array of role names", () => {
    const offenders = ROUTES.filter((relative) =>
      /\[\s*["']owner["']\s*,\s*["']manager["']\s*\]\s*\.includes\s*\(/.test(read(relative)),
    );
    expect(offenders).toEqual([]);
  });
});

describe("payment-method authorization split", () => {
  it("keeps checkout reads operational and every configuration mutation administrative", () => {
    const runtime = read("payment-methods/route.ts");
    expect(runtime).toContain("requireAnyPermission(");
    expect(runtime).toContain("PERMISSIONS.paymentsTake");
    expect(runtime).not.toContain("requirePermission(PERMISSIONS.settingsManage)");

    for (const route of ["settings/payment-methods/route.ts", "settings/payment-methods/[id]/route.ts"]) {
      const source = read(route);
      expect(source, route).toContain("requirePermission(PERMISSIONS.settingsManage)");
      expect(source, route).not.toContain("PERMISSIONS.paymentsTake");
    }
  });
});

describe("families migrated off role-only gating stay migrated", () => {
  const family = (prefix: string) => ROUTES.filter((r) => r.startsWith(prefix));

  it("gates every website/CMS route on a website capability", () => {
    const routes = family("cms/website/");
    expect(routes.length).toBeGreaterThan(15);
    for (const relative of routes) {
      const source = read(relative);
      // The single documented exception: buying a domain is a financial
      // commitment on the tenant's account, so it stays owner-only by role.
      if (relative === "cms/website/domain/order/route.ts") {
        expect(source).toMatch(/requireRole\("owner"\)/);
        continue;
      }
      expect(source, relative).toMatch(/PERMISSIONS\.(website|cms)\w+/);
      expect(source, relative).not.toMatch(/requireRole\(/);
    }
  });

  it("gates every growth and loyalty route on a growth or loyalty capability", () => {
    const routes = [...family("growth/"), ...family("loyalty/")];
    expect(routes.length).toBeGreaterThan(8);
    for (const relative of routes) {
      const source = read(relative);
      expect(source, relative).toMatch(/PERMISSIONS\.(growth|loyalty|campaigns|marketing|storeCredit|giftCards|commission)\w+/);
      expect(source, relative).not.toMatch(/requireRole\(/);
    }
  });

  it("gates every ledger route on an accounting, finance or payroll capability", () => {
    const routes = family("ledger/");
    expect(routes.length).toBeGreaterThan(35);
    for (const relative of routes) {
      const source = read(relative);
      expect(source, relative).toMatch(
        /PERMISSIONS\.(ledger(View|Post|Approve|ClosePeriod|Propose)|accountsEdit|finance\w+|payroll(View|Manage))/,
      );
      expect(source, relative).not.toMatch(/requireRole\(/);
    }
  });

  it("keeps payroll off the ordinary ledger keys", () => {
    // The regression this exists for: a verb-aware sweep mapped every ledger
    // GET onto `ledger.view`, which silently included the two payroll reads —
    // and `ledger.view` is held by the manager and viewer presets, so a
    // refactor would have shown every manager what every colleague earns.
    // Payroll was `requireRole("owner", "accountant")`, a strictly narrower
    // audience than the ledger around it, and it now has keys of its own.
    const routes = family("ledger/payroll/");
    expect(routes.length).toBeGreaterThan(4);
    for (const relative of routes) {
      const source = read(relative);
      expect(source, relative).toMatch(/PERMISSIONS\.payroll(View|Manage)/);
      expect(source, relative).not.toMatch(
        /PERMISSIONS\.(ledger\w+|accountsEdit|finance\w+)/,
      );
    }
  });

  it("keeps operational finance separable from accounting authority", () => {
    // Recording a payment and posting a manual journal are different jobs. If
    // the finance.* writes ever collapse back onto ledger.post, the manager
    // preset loses work it has always done; if the accounting-authority keys
    // leak into the manager preset, the separation of duties is gone. Both
    // directions are asserted here rather than left to the preset test alone.
    const managerKeys = roleBasePermissions("manager");
    for (const key of ["finance.expenses_manage", "finance.receivables_manage",
      "finance.payables_manage", "finance.cheques_manage", "finance.installments_manage",
      "finance.reconciliation_manage", "finance.assets_manage", "ledger.propose"]) {
      expect(managerKeys, `manager lost ${key}`).toContain(key);
    }
    for (const key of ["ledger.post", "ledger.approve", "ledger.close_period",
      "accounts.edit", "payroll.view", "payroll.manage"]) {
      expect(managerKeys, `manager gained accounting authority: ${key}`).not.toContain(key);
    }
  });

  it("separates reading the team from administering it", () => {
    const list = read("team/route.ts");
    // The list opens for either key; the writes need the administrative one.
    expect(list).toMatch(/requireAnyPermission\(\s*PERMISSIONS\.teamView,\s*PERMISSIONS\.teamManage/);
    expect(list).toMatch(/requirePermission\(PERMISSIONS\.teamManage\)/);
  });

  /**
   * The escalation path: whoever can hand out permissions can hand themselves
   * permissions, so it is gated apart from ordinary staff administration.
   */
  it("requires the dedicated key before a role or permission change", () => {
    const source = read("team/[id]/route.ts");
    expect(source).toMatch(/PERMISSIONS\.teamPermissionsManage/);
    expect(source).toMatch(/body\.role !== undefined \|\| body\.permissions !== undefined/);
  });
});

describe("the legacy role guard is confined and shrinking", () => {
  /**
   * `requireRole` is no longer insecure — it routes through the canonical
   * evaluator like every other guard — but it is still *role*-shaped
   * authorization where a capability is usually what is meant. This test pins
   * the remaining count so the number can only go down without a deliberate,
   * visible edit here, and so no new route quietly adds one.
   *
   * The current inventory, and the justification for each remaining family, is
   * in docs/authorization/ARCHITECTURE.md.
   */
  it("does not grow the number of role-gated API routes", () => {
    const roleGated = ROUTES.filter((relative) => /requireRole\(/.test(read(relative)));
    expect(roleGated.length).toBeLessThanOrEqual(281);
  });
});
