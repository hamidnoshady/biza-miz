import { describe, expect, it } from "vitest";
import { INDUSTRIES } from "./industries";
import { PERMISSIONS, roleBasePermissions } from "./permissions";
import { SETTINGS_TABS, visibleSettingsTabs } from "./settings-tabs";

describe("visibleSettingsTabs", () => {
  it("does not return unavailable settings sections", () => {
    // `notifications` is here for every caller by design — see the ungated tab
    // test below.
    expect(visibleSettingsTabs([PERMISSIONS.accountsEdit]).map((tab) => tab.key)).toEqual([
      "accounts",
      "notifications",
    ]);
  });

  it("offers the notifications tab to everyone, whatever they may otherwise do (Phase 35)", () => {
    // The tab edits only the caller's OWN devices and rules (requireMember in
    // auth.ts), so there is nothing for a permission to gate: a کارمند آشپزخانه
    // choosing which of their own alerts reach their own phone is not a
    // manager-level act. Pinned as a test because the natural thing to do when
    // adding a tab is to copy the neighbouring `requiredAnyPermission`, and that
    // would silently take notifications away from most of the staff.
    for (const role of ["owner", "manager", "accountant", "cashier", "waiter", "kitchen"] as const) {
      expect(visibleSettingsTabs([], { role }).map((tab) => tab.key)).toContain("notifications");
    }
  });

  it("returns administration sections for settings managers", () => {
    expect(visibleSettingsTabs([PERMISSIONS.settingsManage]).map((tab) => tab.key)).toEqual([
      "business",
      "tax",
      "pricing",
      "online-platforms",
      "payment-methods",
      "menu",
      "printers",
      "cloud-sync",
      "devices",
      "notifications",
      "logs",
    ]);
  });

  it("shows team management, shift history, the audit trail, and the security center together, gated on team.manage (Phase 20 Waves 5-7)", () => {
    expect(visibleSettingsTabs([PERMISSIONS.teamManage]).map((tab) => tab.key)).toEqual([
      "team",
      "notifications",
      "shifts",
      "audit-log",
      "security-center",
    ]);
  });

  it("returns tabs that can cross the server/client boundary", () => {
    // /dashboard/settings is a server component handing these straight to
    // <SettingsManager>, a client one. React refuses to serialize a function
    // prop ("Functions cannot be passed directly to Client Components"), and it
    // refuses at render time — a 500 on the page, with nothing to catch it at
    // build time or in a type check. `industryText` is the only function a tab
    // carries, and both of the paths through the resolver used to let it
    // through: the tab whose rewrite returns {} was passed along untouched, and
    // the tab whose rewrite returns a description was spread, function and all.
    const everyPermission = Object.values(PERMISSIONS);
    for (const industry of INDUSTRIES) {
      const tabs = visibleSettingsTabs(everyPermission, {
        role: "owner",
        features: Object.fromEntries(SETTINGS_TABS.flatMap((tab) => [
          ...(tab.feature ? [[tab.feature, true]] : []),
          ...(tab.requiredAnyFeature ?? []).map((flag) => [flag, true]),
        ])),
        industry,
      });
      expect(tabs.length).toBeGreaterThan(0);
      for (const tab of tabs) {
        expect(JSON.parse(JSON.stringify(tab))).toEqual(tab);
        for (const [key, value] of Object.entries(tab)) {
          expect(`${industry}.${tab.key}.${key}: ${typeof value}`).not.toContain("function");
        }
      }
    }
  });

  it("rewrites shared wording per industry and hides menu-only pricing from retail", () => {
    const foodService = visibleSettingsTabs([PERMISSIONS.settingsManage], { industry: "food_service" });
    const jewelry = visibleSettingsTabs([PERMISSIONS.settingsManage], { industry: "jewelry" });

    // The tab whose rewrite returns {} for F&B — the "unchanged" path.
    expect(foodService.find((tab) => tab.key === "tax")?.description).toBe("نرخ پیش‌فرض و نرخ هر دسته از منو");
    expect(jewelry.find((tab) => tab.key === "tax")?.description).toBe("نرخ پیش‌فرض مالیات بر ارزش افزوده");

    // Cost-plus pricing reads recipes/menu_items only. Retail's trade-specific
    // pricing engines do not read this policy, so promising it there is worse
    // than using a less-specific label.
    expect(foodService.find((tab) => tab.key === "pricing")?.description).toContain("آیتم‌های منو");
    expect(jewelry.some((tab) => tab.key === "pricing")).toBe(false);

    // A caller with no industry still gets the F&B defaults, and still no callback.
    const noIndustry = visibleSettingsTabs([PERMISSIONS.settingsManage]);
    expect(noIndustry.find((tab) => tab.key === "tax")?.description).toBe("نرخ پیش‌فرض و نرخ هر دسته از منو");
    expect(noIndustry.every((tab) => !("industryText" in tab))).toBe(true);
  });

  it("preserves the former role and feature gates for operational settings", () => {
    expect(
      visibleSettingsTabs([], {
        role: "manager",
        features: { backup: true, site_cloud_sync: true },
      }).map((tab) => tab.key),
    ).toEqual(["notifications", "backup"]);

    expect(
      visibleSettingsTabs([PERMISSIONS.locationsManage], {
        role: "owner",
        features: { backup: true, site_cloud_sync: true },
      }).map((tab) => tab.key),
      // No `server-sync`: remote-server sync is a technical connection and
      // lives in the «اتصال‌های فنی» hub now, not among the settings tabs.
    ).toEqual(["branch-management", "desktop", "notifications", "backup"]);

    expect(
      visibleSettingsTabs([PERMISSIONS.locationsManage], {
        role: "owner",
        features: { backup: false, site_cloud_sync: false },
      }).map((tab) => tab.key),
    ).toEqual(["desktop", "notifications"]);

    expect(
      visibleSettingsTabs([PERMISSIONS.locationsManage], {
        role: "owner",
        features: { backup: false, site_cloud_sync: false, multi_location: true },
      }).map((tab) => tab.key),
    ).toEqual(["branch-management", "desktop", "notifications"]);
  });

  it("gates branch management on locations.manage, the permission its API checks", () => {
    // The tab used to be `allowedRoles: ["owner"]` while /api/branches asked
    // for PERMISSIONS.locationsManage. The two disagreed in both directions:
    // an owner who delegated locations.manage to a manager handed over a
    // permission with no reachable screen, and the tab claimed an authority
    // the routes behind it did not actually require of the caller.
    const features = { multi_location: true };

    expect(
      visibleSettingsTabs([], { role: "owner", features }).map((tab) => tab.key),
    ).not.toContain("branch-management");

    expect(
      visibleSettingsTabs([PERMISSIONS.locationsManage], { role: "manager", features }).map(
        (tab) => tab.key,
      ),
    ).toContain("branch-management");

    // Still owner-only out of the box: locations.manage is in no role preset,
    // so a manager only sees it once an owner deliberately grants it.
    expect(roleBasePermissions("manager")).not.toContain(PERMISSIONS.locationsManage);
    expect(roleBasePermissions("owner")).toContain(PERMISSIONS.locationsManage);
  });
});
