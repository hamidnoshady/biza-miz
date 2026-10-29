/**
 * Issue #902 §0 — the inventory has to be true, and the tenant vocabulary has to
 * stay first-party.
 *
 * Two kinds of check live here, and they answer different questions:
 *
 *   1. **Is the table honest?** Every path it names exists, every maturity is
 *      the one the code actually shows, and a `vendor_visible` entry carries the
 *      issue that changes it. A roadmap that says "all managed" while three
 *      screens name a supplier is the exact failure this inventory exists to
 *      prevent, so the table is tested like code rather than trusted like prose.
 *   2. **Does the product keep the rule?** Every tenant-facing screen in
 *      `src/app/(app)` is read, comments stripped, and searched for a supplier
 *      name — with one documented exception, `settings/connections/mcp-panel.tsx`,
 *      where Claude and ChatGPT are the tenant's *own* clients being connected,
 *      not a supplier Bizamiz resells.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MANAGED_SERVICES } from "./contract";
import {
  MANAGED_SERVICE_INVENTORY,
  SUPPLIER_NAME_PATTERN,
  managedInventoryEntry,
} from "./inventory";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Strip comments: the inventory's own explanations must not trip the guard. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

function tenantScreens(): { name: string; source: string }[] {
  const found: { name: string; source: string }[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(`${ROOT}src/app/(app)/${relative}`, { withFileTypes: true })) {
      const path = `${relative}${entry.name}`;
      if (entry.isDirectory()) walk(`${path}/`);
      else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
        if (entry.name.includes(".test.")) continue;
        found.push({
          name: `src/app/(app)/${path}`,
          source: code(readFileSync(`${ROOT}src/app/(app)/${path}`, "utf8")),
        });
      }
    }
  };
  walk("");
  return found;
}

describe("the managed-service inventory is honest", () => {
  it("covers every service the tenant contract knows about", () => {
    for (const definition of Object.values(MANAGED_SERVICES)) {
      const entry = managedInventoryEntry(definition.key);
      expect(entry, `${definition.key} is in MANAGED_SERVICES but not in the inventory`).toBeDefined();
      // The two must agree on the fields both carry, or a tenant screen and the
      // audit would describe the same service differently.
      expect(entry!.tenantLabel).toBe(definition.tenantLabel);
      expect(entry!.capability).toBe(definition.capability);
      expect(entry!.owningApp).toBe(definition.owningApp);
    }
  });

  it("has unique keys and a first-party label for each", () => {
    const keys = MANAGED_SERVICE_INVENTORY.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of MANAGED_SERVICE_INVENTORY) {
      expect(entry.tenantLabel.trim().length).toBeGreaterThan(0);
      expect(
        SUPPLIER_NAME_PATTERN.test(entry.tenantLabel),
        `${entry.key}'s tenant label names its supplier: ${entry.tenantLabel}`,
      ).toBe(false);
    }
  });

  it("names files that exist, so the table cannot rot", () => {
    for (const entry of MANAGED_SERVICE_INVENTORY) {
      for (const surface of [entry.consoleSurface, ...entry.tenantSurfaces]) {
        expect(existsSync(`${ROOT}${surface}`), `${entry.key} points at a missing path: ${surface}`).toBe(true);
      }
    }
  });

  it("gives every unmanaged service the issue that finishes it", () => {
    for (const entry of MANAGED_SERVICE_INVENTORY) {
      if (entry.maturity === "managed") continue;
      expect(entry.note.length, `${entry.key} has no note`).toBeGreaterThan(0);
      if (entry.maturity === "vendor_visible") {
        if (entry.credentialStore === "not_yet_managed") {
          // Not built yet: the follow-up issue *is* the migration.
          expect(entry.followUpIssue, `${entry.key} is vendor_visible with no issue to fix it`).not.toBeNull();
        } else {
          // Built and leaking: there must be a named screen to fix.
          expect(entry.tenantSurfaces.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("states where each credential lives", () => {
    // "Where does the key live" has four answers in this codebase, and the
    // epic's §1 finding was that two configurations could disagree about which
    // account paid. An entry with no answer would hide that.
    for (const entry of MANAGED_SERVICE_INVENTORY) {
      expect(["platform_singleton", "per_business_child", "per_business_settings", "not_yet_managed"]).toContain(
        entry.credentialStore,
      );
      if (entry.credentialStore === "not_yet_managed") expect(entry.supplier).not.toBeNull();
    }
  });
});

describe("the supplier pattern is the one the payload guard uses", () => {
  it("matches what it must, and not ordinary Persian", () => {
    // A positive control: the sentence this slice removed, and a payload key
    // from the console's own view, must both be caught — otherwise the guard
    // above passes for the wrong reason.
    for (const leak of ["سرویس پیامک (کاوه‌نگار)", "Kavenegar", "kaveh-negar", "Parspack", "zarinpal"]) {
      expect(SUPPLIER_NAME_PATTERN.test(leak), `${leak} should be caught`).toBe(true);
    }
    // And the words that are also ordinary Persian stay clean: «دیوار حائل» is a
    // retaining wall, and a guard that cried wolf on it would be deleted.
    for (const fine of ["دیوار حائل محور B", "تربچه", "زرین‌شهر"]) {
      expect(SUPPLIER_NAME_PATTERN.test(fine), `${fine} should not be caught`).toBe(false);
    }
  });
});

describe("no tenant screen names a supplier Bizamiz resells", () => {
  /**
   * The one documented exception.
   *
   * The MCP panel connects the *tenant's own* AI client — Claude, ChatGPT, Codex
   * — to our MCP server. Those names are the feature, not a leak of our
   * supplier: a screen that said «دستیار هوشمند» and refused to say which one
   * would be useless.
   */
  const ALLOWED = new Set(["src/app/(app)/settings/connections/mcp-panel.tsx"]);

  it("reads the screens it is checking", () => {
    const screens = tenantScreens();
    expect(screens.length).toBeGreaterThan(100);
    expect(screens.map((file) => file.name)).toContain("src/app/(app)/growth/messaging-section.tsx");
  });

  it("finds no supplier name anywhere else", () => {
    const offenders = tenantScreens()
      .filter((file) => !ALLOWED.has(file.name))
      .filter((file) => SUPPLIER_NAME_PATTERN.test(file.source))
      .map((file) => file.name);
    expect(
      offenders,
      `tenant screens naming a managed service's supplier: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps the supplier name out of a screen that shows messaging readiness", () => {
    // The concrete regression this file was written for: the security centre's
    // "SMS is not configured yet" sentence used to read «سرویس پیامک
    // (کاوه‌نگار)», which told every owner who their SMS provider is.
    const source = code(
      readFileSync(`${ROOT}src/app/(app)/settings/security-center-settings.tsx`, "utf8"),
    );
    expect(SUPPLIER_NAME_PATTERN.test(source)).toBe(false);
    expect(source).toContain("سرویس پیامک");
  });
});
