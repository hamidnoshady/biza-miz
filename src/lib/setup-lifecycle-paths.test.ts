/**
 * Issue #808 §4/pairing — every way a business comes into existence must have
 * an explicit, decided completion semantics, and this pins which is which.
 *
 * The three paths are deliberately different, so a future change to any of
 * them should have to say so here:
 *
 *   - **Pairing** imports an already-configured business and stamps the marker
 *     itself (pairing-apply.ts), because the configuration the wizard would
 *     have collected is exactly what just arrived.
 *   - **Super-admin provisioning** keeps its ready-to-enter path for non-F&B
 *     trades. A food_service tenant cannot be considered ready until the
 *     persisted readiness contract (including costing and a sellable menu) is
 *     met, so the console leaves that marker unset and sends its owner through
 *     the ordinary wizard. The platform's own company remains explicitly ready.
 *   - **First-run bootstrap and public signup** are the wizard's front doors:
 *     they must NOT stamp it, or a brand-new owner would never see setup.
 *
 * Static source assertions (the same technique api-guards.test.ts uses for
 * route guards) because these are decisions about which *caller* passes what,
 * not behaviours a unit test can observe without standing up the whole
 * provisioning transaction.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("setup completion semantics per creation path", () => {
  it("leaves console-provisioned food_service businesses to the readiness-checked wizard", () => {
    const route = source("src/app/api/platform/businesses/route.ts");
    expect(route).toContain("shouldCompleteSetupForPlatformProvision(input.industry)");
    expect(route).toContain("seedChartOfAccounts: true");

    const provisioning = source("src/lib/business-provisioning.ts");
    expect(provisioning).toContain('wizardStepsForIndustry(industry ?? "food_service").includes("menu")');
  });

  it("stamps completion for the platform's own company workspace", () => {
    expect(source("src/lib/platform-company.ts")).toContain("completeSetup: true");
  });

  it("leaves first-run bootstrap and public signup to the wizard", () => {
    for (const path of [
      "src/app/api/setup/bootstrap/route.ts",
      "src/app/api/setup/signup/route.ts",
      "src/app/api/setup/pair/route.ts",
    ]) {
      expect(source(path)).not.toContain("completeSetup");
    }
  });

  it("keeps pairing's explicit completion stamp", () => {
    const pairing = source("src/lib/pairing-apply.ts");
    expect(pairing).toContain("SETTING_KEYS.wizardProgress");
    expect(pairing).toContain("completedAt: pairedAt");
  });

  it("routes the interactive Finish through the one canonical transition, audit included", () => {
    const complete = source("src/app/api/setup/complete/route.ts");
    expect(complete).toContain("markSetupComplete");
    expect(complete).toContain("setup.completed");
    // The audit insert must be conditional on *this* call having stamped, and
    // share its transaction — not a second unconditional write.
    expect(complete).toContain("if (stamped)");
    expect(complete).toContain("await client.query(\"BEGIN\")");
  });

  it("keeps the F&B-only wizard endpoints off a business whose step list omits them", () => {
    // Issue #808 §8: the pages skip themselves for the wrong industry; the
    // routes carry the same rule, so a direct POST (or a stale tab) cannot
    // write a menu into a trade-goods business whose `menu` module does not
    // exist. The guard reads the industry live (getBusinessIndustry), not the
    // session, which carries no industry at all.
    const costing = source("src/app/api/setup/costing/route.ts");
    expect(costing).toContain('requireSetupStepForIndustry(session.businessId, "costing")');

    for (const path of ["src/app/api/setup/menu/route.ts", "src/app/api/setup/menu/import/route.ts"]) {
      expect(source(path)).toContain('requireSetupStepForIndustry(session.businessId, "menu")');
    }

    // And the guard itself decides from the one step map, so the route rule and
    // the wizard's own sequence cannot drift apart.
    const state = source("src/lib/setup-state.ts");
    expect(state).toContain("wizardStepsForIndustry(industry).includes(step)");
  });

  it("routes on the formal marker alone, in both guards, with no readiness exception", () => {
    // The bug this whole issue started from: `/setup`'s layout ejected the
    // owner to /settings as soon as the *required steps were ready*, before
    // Hardware/Backup/Opening/Finish were visited. The fix is that both guards
    // ask the one canonical question — `isSetupComplete` — and neither of them
    // consults readiness to decide where the owner may go. Issue #808 forbids
    // fixing this with redirect exceptions, so a future edit that adds a
    // readiness carve-out here has to delete this assertion and say why.
    for (const path of ["src/app/setup/layout.tsx", "src/app/page.tsx"]) {
      const guard = source(path);
      expect(guard).toContain("isSetupComplete");
      expect(guard).not.toContain("readiness");
      expect(guard).not.toContain("missingForCompletion");
    }

    // The wizard layout still lets a manager through to the steps: the redirect
    // is the *only* guard there, and it is the marker's answer.
    const layout = source("src/app/setup/layout.tsx");
    expect(layout).toContain('if (await isSetupComplete(session.businessId)) redirect("/settings")');

    // The root page sends an unfinished business into the wizard, and only an
    // owner/manager (a cashier's landing page is the dashboard).
    const root = source("src/app/page.tsx");
    expect(root).toContain('redirect("/setup")');
    expect(root).toMatch(/session\.role === "owner" \|\| session\.role === "manager"/);
  });

  it("keeps provisioning's flag off by default", () => {
    const provisioning = source("src/lib/business-provisioning.ts");
    // `input.completeSetup` (no default) — an omitted flag must mean "leave it
    // to the wizard", never "complete by accident".
    expect(provisioning).toContain("if (input.completeSetup)");
    expect(provisioning).not.toMatch(/completeSetup\s*\?\?/);
    expect(provisioning).not.toMatch(/completeSetup\s*:\s*true/);
  });
});
