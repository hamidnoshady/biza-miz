/**
 * Issue #910 — the menu-management surface's contract, asserted from source
 * rather than by rendering a server page.
 *
 * Three things kept going wrong in this workflow, and none of them is visible
 * from a type signature:
 *
 *  - a write route silently dropping its `menu.edit` gate (or a read route
 *    demanding more than `menu.view`);
 *  - the item sheet offering edit affordances to a `menu.view` member and
 *    reordering its links with two non-atomic PATCHes;
 *  - the legacy menu URLs drifting back into the app as real pages instead of
 *    the one permanent redirect table.
 *
 * The assertions below are the screen's half of the server rules, in the
 * style `admin-screen-contracts.test.ts` established.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCOUNTING_WORKSPACE_HREFS,
  canonicalPathForLegacy,
} from "@/lib/app-routes";

const ROOT = join(__dirname, "..", "..", "..", "..");
const API = join(ROOT, "app/api/menu");
const MENU = join(ROOT, "app/(app)/accounting/menu");

const read = (path: string) => readFileSync(path, "utf8");

/** Every route module under src/app/api/menu, relative to that folder. */
function routeModules(dir = API, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return routeModules(join(dir, entry.name), relative);
    return entry.name === "route.ts" ? [relative] : [];
  });
}

const ROUTES: readonly {
  file: string;
  methods: readonly string[];
  permission: "menuEdit" | "menuView";
}[] = [
  { file: "route.ts", methods: ["GET"], permission: "menuView" },
  { file: "categories/route.ts", methods: ["POST"], permission: "menuEdit" },
  { file: "categories/[id]/route.ts", methods: ["PATCH", "DELETE"], permission: "menuEdit" },
  { file: "items/route.ts", methods: ["POST"], permission: "menuEdit" },
  { file: "items/[id]/route.ts", methods: ["PATCH", "DELETE"], permission: "menuEdit" },
  { file: "items/[id]/price-change/route.ts", methods: ["POST"], permission: "menuEdit" },
  { file: "items/[id]/suggested-price/route.ts", methods: ["GET", "POST"], permission: "menuEdit" },
  { file: "modifier-groups/route.ts", methods: ["POST"], permission: "menuEdit" },
  { file: "modifier-groups/[id]/route.ts", methods: ["PATCH", "DELETE"], permission: "menuEdit" },
  { file: "modifiers/route.ts", methods: ["POST"], permission: "menuEdit" },
  { file: "modifiers/[id]/route.ts", methods: ["PATCH", "DELETE"], permission: "menuEdit" },
  {
    file: "item-modifier-groups/route.ts",
    methods: ["POST", "PATCH", "DELETE"],
    permission: "menuEdit",
  },
  {
    file: "item-modifier-groups/reorder/route.ts",
    methods: ["POST"],
    permission: "menuEdit",
  },
  { file: "reorder/route.ts", methods: ["POST"], permission: "menuEdit" },
  { file: "price-history/route.ts", methods: ["GET"], permission: "menuView" },
];

describe("menu API routes — present, guarded and tenant-scoped", () => {
  it("ships every route the menu screens call, so none can 404", () => {
    for (const route of ROUTES) {
      expect(existsSync(join(API, route.file)), route.file).toBe(true);
    }
  });

  it("has no untracked add-on route that this contract does not name", () => {
    expect(new Set(routeModules())).toEqual(
      new Set(ROUTES.map((route) => route.file)),
    );
  });

  it("exports the expected HTTP methods", () => {
    for (const route of ROUTES) {
      const source = read(join(API, route.file));
      for (const method of route.methods) {
        expect(source, `${route.file} must export ${method}`).toContain(
          `export const ${method} = withTenantScope(`,
        );
      }
    }
  });

  it("gates reads with menu.view and every mutation with menu.edit", () => {
    for (const route of ROUTES) {
      const source = read(join(API, route.file));
      expect(source, route.file).toContain(
        `PERMISSIONS.${route.permission}`,
      );
      // A mutation that forgot its permission would show up as the route
      // being the only one in this table without a requirePermission call.
      expect(source, route.file).toMatch(/requirePermissions?\(/);
    }
  });

  it("resolves the active branch on every route that touches rows", () => {
    for (const route of ROUTES) {
      const source = read(join(API, route.file));
      expect(source, route.file).toContain("resolveActiveLocation(session)");
    }
  });
});

describe("item sheet — atomic ordering and a real view-only mode", () => {
  const sheet = read(join(MENU, "item-sheet.tsx"));
  const workspace = read(join(MENU, "menu-workspace.tsx"));
  it("reorders attachments with one complete, atomic request", () => {
    expect(sheet).toContain('"/api/menu/item-modifier-groups/reorder"');
    expect(sheet).toContain("groupIds");
    // The old two-PATCH swap must not creep back in.
    expect(sheet).not.toMatch(/neighbour\.sortOrder/);
  });

  it("is genuinely read-only for menu.view members", () => {
    expect(workspace).toContain("canEdit={canEdit}");
    expect(sheet).toContain("canEdit: boolean");
    expect(sheet).toContain("readOnly={readOnly}");
    expect(sheet).toMatch(/if \(!canEdit\) return;/);
    // The save affordance is replaced by a plain close.
    expect(sheet).toMatch(/\{canEdit \? \(/);
  });

  it("confirms detaching a group and serialises reorder presses", () => {
    expect(sheet).toContain("confirmDetach");
    expect(sheet).toContain("قطع کن");
    expect(sheet).toContain("سفارش‌های قبلی");
    expect(sheet).toContain("setMoveBusy(true)");
    expect(sheet).toContain("disabled={index === 0 || moveBusy}");
  });

  it("shows inactive groups in the attach picker instead of hiding them", () => {
    expect(sheet).toContain("غیرفعال (در صندلی نمایش داده نمی‌شود)");
    expect(sheet).toContain("گزینهٔ فعال");
    expect(sheet).toContain("قابل فروش در صندلی");
  });
});

describe("modifier panel — confirmations and no dead edit branch", () => {
  const panel = read(join(MENU, "modifiers-panel.tsx"));

  it("confirms an option deletion and explains deactivate-instead", () => {
    expect(panel).toContain("confirmDeleteOption");
    expect(panel).toContain("دستور پخت");
    expect(panel).toContain("غیرفعال");
  });

  it("has one create form and one real edit path, with no unreachable edit state", () => {
    expect(panel).toContain("groupFormOpen");
    expect(panel).not.toContain("setGroupForm(");
    expect(panel).not.toContain('{ mode: "edit"; groupId: string }');
    expect(panel).not.toMatch(/state\.mode !== "create"/);
    expect(panel).toContain("GroupDetailSheet");
  });
});

describe("legacy menu URLs — redirects only", () => {
  it("keeps /dashboard/menu and /settings/menu pointing at the canonical page", () => {
    expect(canonicalPathForLegacy("/dashboard/menu")).toBe(
      ACCOUNTING_WORKSPACE_HREFS.menu,
    );
    expect(canonicalPathForLegacy("/settings/menu")).toBe(
      ACCOUNTING_WORKSPACE_HREFS.menu,
    );
  });

  it("ships no page modules at the retired addresses", () => {
    expect(existsSync(join(ROOT, "app/dashboard/menu"))).toBe(false);
    expect(existsSync(join(ROOT, "app/settings/menu"))).toBe(false);
    expect(existsSync(join(MENU, "page.tsx"))).toBe(true);
  });

  it("does not present the retired address as the active menu management route", () => {
    const readme = read(join(ROOT, "..", "README.md"));
    expect(readme).not.toMatch(/- \*\*`\/dashboard\/menu`\*\*/);
    expect(readme).toContain("/accounting/menu");
  });
});
