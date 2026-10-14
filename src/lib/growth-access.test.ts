/**
 * The Growth capability contract (issue #764), asserted against the code that
 * actually enforces it.
 *
 * The bug this file exists to prevent is drift: a page gated on one key whose
 * data endpoint checks another, a launcher that admits a member to an app with
 * no section for them, a cashier reaching compensation data through an API
 * whose page they cannot see. So rather than restating the matrix, the tests
 * read the route handlers' source and compare it with `GROWTH_API_PERMISSIONS`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import type { Role } from "./auth-edge";
import { appForApiPath, appForPagePath } from "./app-availability";
import { canOpenApp, appForKey } from "./apps";
import { AI_ACTION_PERMISSION_MAP, AI_TOOL_PERMISSION_MAP } from "./ai-capabilities";
import { CAPABILITY_REGISTRY } from "./capabilities";
import {
  canOpenGrowth,
  canViewGrowthSection,
  GROWTH_API_PERMISSIONS,
  GROWTH_APP_PERMISSIONS,
  GROWTH_SECTION_KEYS,
  GROWTH_SECTION_PERMISSION,
  GROWTH_SECTION_READS,
  growthAbilities,
  growthApiPermission,
  redactGrowthOverview,
  type HttpMethod,
} from "./growth-access";
import type { GrowthOverview } from "./growth-overview";
import { moduleForApiPath, moduleForPagePath } from "./industry-profile";
import { ALL_PERMISSIONS, effectivePermissions, PERMISSIONS, type Permission } from "./permissions";

const ROOT = join(__dirname, "..", "..");
const API_ROOT = join(ROOT, "src", "app", "api");
/** Every API prefix the Growth app owns. A route under one of these must be declared. */
const GROWTH_API_PREFIXES = ["growth", "promotions", "loyalty", "commission", "messaging"];
const METHODS: HttpMethod[] = ["GET", "POST", "PATCH", "PUT", "DELETE"];
const KEY_BY_CONST = new Map<string, Permission>(Object.entries(PERMISSIONS) as [string, Permission][]);

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return entry === "route.ts" ? [full] : [];
  });
}

/** `/api/promotions/gift-cards` — always forward slashes, so the CI's Windows runner reads the same key. */
function apiPathOf(file: string): string {
  return `/api/${relative(API_ROOT, file).split(sep).join("/").replace(/\/route\.ts$/, "")}`;
}

/** The PERMISSIONS.* keys each exported handler names, by method. */
function guardsBySource(source: string): Partial<Record<HttpMethod, Permission[]>> {
  const result: Partial<Record<HttpMethod, Permission[]>> = {};
  const starts = METHODS.map((method) => ({ method, index: source.indexOf(`export const ${method} =`) }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index);
  starts.forEach((entry, i) => {
    const body = source.slice(entry.index, starts[i + 1]?.index ?? source.length);
    const keys = [...body.matchAll(/PERMISSIONS\.(\w+)/g)].map((match) => {
      const key = KEY_BY_CONST.get(match[1]);
      if (!key) throw new Error(`unknown PERMISSIONS.${match[1]}`);
      return key;
    });
    result[entry.method] = [...new Set(keys)].sort();
  });
  return result;
}

const growthRouteFiles = GROWTH_API_PREFIXES.flatMap((prefix) => routeFiles(join(API_ROOT, prefix)));

describe("GROWTH_API_PERMISSIONS matches the route handlers", () => {
  it("declares every Growth-owned API route, and nothing that does not exist", () => {
    const onDisk = growthRouteFiles.map(apiPathOf).sort();
    expect(Object.keys(GROWTH_API_PERMISSIONS).sort()).toEqual(onDisk);
  });

  for (const file of growthRouteFiles) {
    const path = apiPathOf(file);
    it(`${path} checks exactly the declared permission per method`, () => {
      const actual = guardsBySource(readFileSync(file, "utf8"));
      const declared = GROWTH_API_PERMISSIONS[path] ?? {};
      expect(Object.keys(actual).sort(), "exported methods").toEqual(Object.keys(declared).sort());
      for (const method of Object.keys(declared) as HttpMethod[]) {
        expect(actual[method], `${method} ${path}`).toEqual([...growthApiPermission(path, method)].sort());
      }
    });
  }

  it("never guards a Growth API on the old catch-all keys", () => {
    // growth.view is the dashboard's read and loyalty.manage is program
    // configuration — neither may gate a gift card, store credit or commission.
    for (const [path, methods] of Object.entries(GROWTH_API_PERMISSIONS)) {
      if (!/gift-cards|store-credit|commission/.test(path)) continue;
      for (const method of Object.keys(methods) as HttpMethod[]) {
        for (const key of growthApiPermission(path, method)) {
          expect([PERMISSIONS.growthView, PERMISSIONS.loyaltyManage], `${method} ${path}`).not.toContain(key);
        }
      }
    }
  });
});

describe("page ↔ API parity", () => {
  it("guards every read a section loads with that section's own permission", () => {
    for (const key of GROWTH_SECTION_KEYS) {
      for (const read of GROWTH_SECTION_READS[key]) {
        const [method, path] = read.split(" ") as [HttpMethod, string];
        expect(growthApiPermission(path, method), `${key}: ${read}`).toEqual([GROWTH_SECTION_PERMISSION[key]]);
      }
    }
  });

  it("gates every section page through the contract, on its own key", () => {
    for (const key of GROWTH_SECTION_KEYS) {
      const page = readFileSync(join(ROOT, "src", "app", "(app)", "growth", key, "page.tsx"), "utf8");
      expect(page, key).toContain(`canViewGrowthSection(permissions, "${key}")`);
    }
  });

  it("lists, as section reads, only routes the client actually calls", () => {
    const clientSource = readdirSync(join(ROOT, "src", "app", "(app)", "growth"))
      .filter((name) => name.endsWith(".tsx"))
      .map((name) => readFileSync(join(ROOT, "src", "app", "(app)", "growth", name), "utf8"))
      .join("\n");
    for (const key of GROWTH_SECTION_KEYS) {
      for (const read of GROWTH_SECTION_READS[key]) {
        const path = read.split(" ")[1];
        const probe = path.includes("[id]") ? path.slice(0, path.indexOf("[id]")) : path;
        expect(clientSource, read).toContain(probe);
      }
    }
  });
});

const ROLES: Role[] = ["owner", "admin", "manager", "accountant", "cashier", "waiter", "kitchen"];
const sections = (role: Role) =>
  GROWTH_SECTION_KEYS.filter((key) => canViewGrowthSection(effectivePermissions(role, {}), key));

describe("built-in role matrix", () => {
  it("opens exactly these sections per role", () => {
    expect(sections("owner")).toEqual([...GROWTH_SECTION_KEYS]);
    expect(sections("admin")).toEqual([...GROWTH_SECTION_KEYS]);
    expect(sections("manager")).toEqual([...GROWTH_SECTION_KEYS]);
    expect(sections("accountant")).toEqual(["overview", "customers", "commission"]);
    expect(sections("cashier")).toEqual(["gift-cards", "loyalty"]);
    expect(sections("waiter")).toEqual([]);
    expect(sections("kitchen")).toEqual([]);
  });

  it("refuses the cashier every management and compensation API", () => {
    const cashier = effectivePermissions("cashier", {});
    const refused = [
      ["/api/growth/overview", "GET"], ["/api/growth/accounting", "GET"], ["/api/growth/customers", "GET"],
      ["/api/commission/rules", "GET"], ["/api/commission/report", "GET"], ["/api/commission/rules", "POST"],
      ["/api/promotions", "POST"], ["/api/promotions/gift-cards", "POST"], ["/api/promotions/gift-cards/redeem", "POST"],
      ["/api/loyalty/programs", "POST"], ["/api/messaging", "GET"], ["/api/growth/settings", "GET"],
    ] as const;
    for (const [path, method] of refused) {
      expect(growthApiPermission(path, method).some((key) => cashier.has(key)), `${method} ${path}`).toBe(false);
    }
    // Store credit: neither issuing nor paying out.
    expect(cashier.has(PERMISSIONS.storeCreditIssue)).toBe(false);
    expect(cashier.has(PERMISSIONS.storeCreditPayout)).toBe(false);
    // What the till keeps.
    for (const [path, method] of [["/api/loyalty/customers/[id]/redeem", "POST"], ["/api/promotions/gift-cards", "GET"]] as const) {
      expect(growthApiPermission(path, method).every((key) => cashier.has(key)), `${method} ${path}`).toBe(true);
    }
  });

  it("lets the accountant read compensation but never write it", () => {
    const accountant = effectivePermissions("accountant", {});
    expect(accountant.has(PERMISSIONS.commissionView)).toBe(true);
    expect(accountant.has(PERMISSIONS.commissionManage)).toBe(false);
  });
});

describe("the launcher", () => {
  it("is derived from the section gates, in every place that admits a member to the app", () => {
    expect([...GROWTH_APP_PERMISSIONS].sort()).toEqual([...new Set(Object.values(GROWTH_SECTION_PERMISSION))].sort());
    expect(appForKey("growth").requiredAnyPermission).toBe(GROWTH_APP_PERMISSIONS);
    expect(CAPABILITY_REGISTRY["app.growth"].requiredAnyPermission).toBe(GROWTH_APP_PERMISSIONS);
  });

  it("agrees with canOpenGrowth for every built-in role", () => {
    for (const role of ROLES) {
      const permissions = effectivePermissions(role, {});
      expect(canOpenApp("growth", permissions), role).toBe(canOpenGrowth(permissions));
      expect(canOpenGrowth(permissions), role).toBe(sections(role).length > 0);
    }
  });

  it("agrees with canOpenGrowth for custom roles holding any single permission", () => {
    for (const key of ALL_PERMISSIONS) {
      const permissions = effectivePermissions("waiter", {}, [key]);
      const someSection = GROWTH_SECTION_KEYS.some((section) => canViewGrowthSection(permissions, section));
      expect(canOpenApp("growth", permissions), key).toBe(someSection);
      expect(canOpenGrowth(permissions), key).toBe(someSection);
    }
  });

  it("agrees for delegated overrides: revoking every section key closes the app", () => {
    const revoked = effectivePermissions("manager", { revoked: [...GROWTH_APP_PERMISSIONS] });
    expect(canOpenGrowth(revoked)).toBe(false);
    expect(canOpenApp("growth", revoked)).toBe(false);
    const onlyCommission = effectivePermissions("waiter", { granted: [PERMISSIONS.commissionView] });
    expect(canOpenGrowth(onlyCommission)).toBe(true);
    expect(GROWTH_SECTION_KEYS.filter((key) => canViewGrowthSection(onlyCommission, key))).toEqual(["commission"]);
  });
});

describe("button abilities", () => {
  it("map each button to the exact key its endpoint checks", () => {
    const owner = growthAbilities(effectivePermissions("owner", {}));
    expect(Object.values(owner).every(Boolean)).toBe(true);
    expect(growthAbilities(effectivePermissions("cashier", {}))).toEqual({
      manageCampaigns: false,
      manageLoyaltyPrograms: false,
      redeemPoints: true,
      issueStoreCredit: false,
      payOutStoreCredit: false,
      issueGiftCards: false,
      redeemGiftCards: false,
      manageCommission: false,
      viewCommission: false,
    });
    expect(growthApiPermission("/api/promotions/gift-cards", "POST")).toEqual([PERMISSIONS.giftCardsIssue]);
    expect(growthApiPermission("/api/promotions/gift-cards/redeem", "POST")).toEqual([PERMISSIONS.giftCardsRedeem]);
    expect(growthApiPermission("/api/loyalty/customers/[id]/store-credit", "POST")).toEqual([
      PERMISSIONS.storeCreditIssue, PERMISSIONS.storeCreditPayout,
    ]);
  });
});

describe("the assistant obeys the same contract", () => {
  it("guards its messaging reads and writes with the campaign keys", () => {
    expect(AI_TOOL_PERMISSION_MAP.list_message_templates).toBe(PERMISSIONS.campaignsView);
    expect(AI_TOOL_PERMISSION_MAP.list_message_campaigns).toBe(PERMISSIONS.campaignsView);
    expect(AI_ACTION_PERMISSION_MAP["messaging.campaign.create"]).toBe(growthApiPermission("/api/messaging", "POST")[0]);
  });

  it("uses CMS access for website content and website access for connection status", () => {
    expect(AI_TOOL_PERMISSION_MAP.list_website_posts).toBe(PERMISSIONS.cmsView);
    expect(AI_TOOL_PERMISSION_MAP.list_website_products).toBe(PERMISSIONS.cmsView);
    expect(AI_TOOL_PERMISSION_MAP.get_website_status).toBe(PERMISSIONS.websiteView);
  });

  it("uses the commission screen's dedicated permission for the assistant leaderboard", () => {
    expect(AI_TOOL_PERMISSION_MAP.get_staff_commission).toBe(PERMISSIONS.commissionView);
  });

  it("routes /api/messaging through the Growth app's availability", () => {
    expect(appForApiPath("/api/messaging")).toBe("growth");
  });
});

describe("messaging is a registered Growth module", () => {
  it("resolves the page and API to the messaging module and the Growth app", () => {
    expect(moduleForPagePath("/growth/messaging")).toBe("messaging");
    expect(moduleForApiPath("/api/messaging")).toBe("messaging");
    expect(moduleForApiPath("/api/messaging/preview")).toBe("messaging");
    expect(appForPagePath("/growth/messaging")).toBe("growth");
    expect(appForApiPath("/api/messaging/preview")).toBe("growth");
  });
});

describe("redactGrowthOverview", () => {
  const overview = {
    window: { from: "2026-09-01", to: "2026-09-30" },
    hasLocation: true,
    commission: { accrued30d: 25_000, top: [{ employeeId: "e1", employeeName: "Akbar", amount: 25_000 }] },
    bridge: [
      { code: "2410", name: "store credit", type: "liability", balance: 10_000 },
      { code: "2300", name: "salaries payable", type: "liability", balance: 25_000 },
      { code: "5210", name: "commission expense", type: "expense", balance: 25_000 },
    ],
    activity: [
      { at: "2026-09-30T10:00:00.000Z", kind: "commission", subject: "Akbar", amount: 25_000, sourceType: null },
      { at: "2026-09-30T09:00:00.000Z", kind: "points", subject: "Sara", amount: 10, sourceType: null },
    ],
  } as unknown as GrowthOverview;

  it("strips every compensation figure without commission.view", () => {
    const redacted = redactGrowthOverview(overview, new Set([PERMISSIONS.growthView]));
    expect(redacted.commission).toBeNull();
    expect(redacted.bridge.map((row) => row.code)).toEqual(["2410"]);
    expect(redacted.activity.map((row) => row.kind)).toEqual(["points"]);
  });

  it("leaves the overview whole for a member who may read compensation", () => {
    expect(redactGrowthOverview(overview, new Set([PERMISSIONS.growthView, PERMISSIONS.commissionView]))).toBe(overview);
  });
});
