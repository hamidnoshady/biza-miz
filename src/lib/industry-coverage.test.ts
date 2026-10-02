/**
 * Issue #799 — the CI guard for "a future industry cannot silently be missed".
 *
 * Adding a business type to `industries.ts` used to be a compile error in some
 * places and a silent omission in others. `Record<Industry, …>` is checked by
 * `tsc`, so a missing key there fails the type check (that is how this issue's
 * own implementation found all nine of them). What the compiler cannot see is
 * everything *outside* TypeScript's exhaustiveness rules:
 *
 *   * the SQL `businesses_industry_check` constraint — a migration list that
 *     must name every industry or provisioning fails at runtime with a
 *     constraint violation, long after typecheck passed;
 *   * `Partial<Record<Industry, …>>` and hand-written arrays — a UI list, a
 *     report's `requires.industries` — where a missing entry is legitimate for
 *     some trades and a bug for others, so the compiler stays silent;
 *   * the cross-cutting registries (chart of accounts, wizard steps, module
 *     sets) which each have a "must answer for every trade" contract;
 *   * test fixtures restating the list by hand, which is exactly how the
 *     industry-picker tests broke when this industry was added.
 *
 * This file asserts those contracts directly. Three kinds of check live here:
 *
 *   1. per-industry contracts — every industry answers, and its answers are
 *      structurally sound (unique label, valid chart, a wizard that starts at
 *      the beginning);
 *   2. the database constraint — the newest `businesses_industry_check` in
 *      `migrations/` names every industry exactly once;
 *   3. a source scan — a hard-coded list of three or more industry keys in
 *      non-test source must be one of the exported registry sets. Restating a
 *      list is then a *decision* (add an export, or extend the allowlist with
 *      a note) rather than an accident.
 *
 * Deliberately not a snapshot of file contents: it asserts properties, so
 * refactors stay free and only genuine omissions fail.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { inventoryCodeForIndustry, postingRulesFor } from "./accounting-posting-rules";
import { appForModule, APPS } from "./apps";
import {
  coaTemplateForIndustry,
  costOfSalesCodesForIndustry,
  validateAccounts,
} from "./coa-template";
import { ENABLED_INDUSTRIES, INDUSTRIES, INDUSTRY_LABELS } from "./industries";
import { INDUSTRY_PROFILES, MODULE_KEYS } from "./industry-profile";
import { PRODUCT_WORKSPACE_INDUSTRIES } from "./product-workspace";
import { TRADE_GOODS_INDUSTRIES } from "./trade-goods";
import { wizardStepsForIndustry } from "./wizard-steps";

const SRC_ROOT = join(process.cwd(), "src");
const MIGRATIONS_ROOT = join(process.cwd(), "migrations");

/**
 * Modules no app owns, on purpose: the assistant is the chat home, settings
 * and the technical-connections hub are shell infrastructure, the media
 * library is a shared picker every app reads from, and `messaging` is a
 * declared-but-unwired key. See the notes in `apps.ts` and
 * `industry-profile.ts` — a *new* module with no app and no note here would
 * otherwise look like a wiring mistake.
 */
const MODULES_WITHOUT_AN_APP: readonly string[] = [
  "messaging",
  "connections",
  "media",
  "ai",
  "settings",
];

/**
 * The exported sets a hard-coded industry array is allowed to be. Each is a
 * real category with its own meaning; a list that is none of them is either a
 * duplicate of one (import it instead) or a new category (export it and add
 * it here with a note).
 */
const REGISTRY_SETS: readonly (readonly string[])[] = [
  INDUSTRIES,
  PRODUCT_WORKSPACE_INDUSTRIES,
  TRADE_GOODS_INDUSTRIES,
];

/**
 * Files allowed to contain a hard-coded list that is not one of the sets
 * above, with the reason. Keep this list short: it is the escape hatch, not
 * the mechanism.
 */
const SOURCE_SCAN_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  // Declares INDUSTRIES itself — the registry the scan is anchored on.
  ["src/lib/industries.ts", "declares the industry registry"],
  // The accounting app's module list: these are ModuleKeys that happen to
  // share their names with the retail industries they gate.
  ["src/lib/apps.ts", "a ModuleKey list, not an industry list"],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules") continue;
      walk(path, out);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(path);
    }
  }
  return out;
}

const isTestFile = (file: string) => /\.test\.tsx?$/.test(file);

/** Every industry key as a quoted string literal, matching the scan below. */
const KEY_PATTERN = new RegExp(`"(${INDUSTRIES.join("|")})"`, "g");

function hardCodedIndustryLists(): { file: string; line: number; keys: string[] }[] {
  const found: { file: string; line: number; keys: string[] }[] = [];
  for (const file of walk(SRC_ROOT)) {
    if (isTestFile(file)) continue;
    const source = readFileSync(file, "utf8");
    // Array literals only, and only ones that hold a handful of quoted keys —
    // a 2 KB bound keeps a giant unrelated block from ever being scanned as
    // one "list", which is what makes this check readable when it fails.
    for (const match of source.matchAll(/\[[^[\]]{0,2000}?\]/gs)) {
      const keys = [...new Set(match[0].match(KEY_PATTERN) ?? [])].map((k) => k.slice(1, -1));
      if (keys.length < 3) continue;
      const line = source.slice(0, match.index).split("\n").length;
      found.push({ file: relative(process.cwd(), file).split(sep).join("/"), line, keys });
    }
  }
  return found;
}

describe("every industry is wired end to end", () => {
  it("has a label of its own, and no two industries share one", () => {
    const labels = INDUSTRIES.map((industry) => INDUSTRY_LABELS[industry]);
    for (const label of labels) expect(label.trim().length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("is offered by the setup wizard", () => {
    // `ENABLED_INDUSTRIES` is the switch that decides whether `/welcome` and
    // the platform picker offer a trade or badge it «به‌زودی». An industry
    // added to `INDUSTRIES` but left out of it is invisible to every customer
    // while looking complete in the registry — so that state must be a
    // deliberate edit to this test, not an omission.
    expect([...ENABLED_INDUSTRIES].sort()).toEqual([...INDUSTRIES].sort());
  });

  it("gets a profile with a brand of its own", () => {
    const titles = INDUSTRIES.map((industry) => INDUSTRY_PROFILES[industry].brandTitle);
    for (const title of titles) expect(title.trim().length).toBeGreaterThan(0);
    expect(new Set(titles).size).toBe(titles.length);
    for (const industry of INDUSTRIES) {
      expect(INDUSTRY_PROFILES[industry].brandSubtitle.trim().length).toBeGreaterThan(0);
    }
  });

  it("declares real modules, no duplicates, and every module a home or a note", () => {
    for (const industry of INDUSTRIES) {
      const modules = INDUSTRY_PROFILES[industry].modules;
      expect(modules.length, industry).toBeGreaterThan(0);
      expect(new Set(modules).size, industry).toBe(modules.length);
      for (const module of modules) {
        expect(MODULE_KEYS, `${industry}/${module}`).toContain(module);
        if (appForModule(module) === null) {
          expect(MODULES_WITHOUT_AN_APP, `${industry}/${module}`).toContain(module);
        }
      }
    }
  });

  it("has a valid chart of accounts with a non-empty cost-of-sales list inside it", () => {
    for (const industry of INDUSTRIES) {
      const template = coaTemplateForIndustry(industry);
      const errors = validateAccounts([...template]);
      expect(errors, `${industry}: ${errors.join("; ")}`).toEqual([]);
      const codes = new Set(template.map((account) => account.code));
      const costOfSales = costOfSalesCodesForIndustry(industry);
      expect(costOfSales.length, industry).toBeGreaterThan(0);
      for (const code of costOfSales) expect(codes.has(code), `${industry}/${code}`).toBe(true);
      expect(codes.has(inventoryCodeForIndustry(industry)), industry).toBe(true);
    }
  });

  it("posts only to accounts its own chart carries", () => {
    for (const industry of INDUSTRIES) {
      const codes = new Set(coaTemplateForIndustry(industry).map((account) => account.code));
      for (const rule of postingRulesFor({ industry })) {
        for (const line of rule.lines) {
          for (const code of line.code.split("/").map((part) => part.trim())) {
            if (!/^\d{4}$/.test(code)) continue;
            expect(codes.has(code), `${industry}: rule «${rule.label}» names ${code}`).toBe(true);
          }
        }
      }
    }
  });

  it("walks a wizard sequence that starts at the beginning", () => {
    for (const industry of INDUSTRIES) {
      const steps = wizardStepsForIndustry(industry);
      expect(steps[0], industry).toBe("business");
      expect(steps, industry).toContain("accounts");
      expect(new Set(steps).size, industry).toBe(steps.length);
    }
  });

  it("is reachable by at least one app in the rail", () => {
    for (const industry of INDUSTRIES) {
      const modules = INDUSTRY_PROFILES[industry].modules;
      expect(
        APPS.some((app) => app.modules.some((module) => modules.includes(module))),
        industry,
      ).toBe(true);
    }
  });
});

describe("the database admits every industry", () => {
  /**
   * The `businesses_industry_check` constraint, as the newest migration
   * defines it. Widening it is a required step of adding an industry and the
   * one whose omission only shows up at runtime — in production, on the first
   * provisioning — so it is asserted here from the SQL itself.
   */
  /**
   * The industry list inside a migration's `industry IN ( … )` clause, or null
   * when the file does not carry one.
   *
   * Detection is on the *clause*, not on the string `businesses_industry_check`:
   * a later migration that merely mentions the constraint in a comment — 0194
   * does, explaining why it adds no new industry — is not a migration that
   * defines it, and treating it as one made this guard fail on prose.
   */
  function industryCheckClause(sql: string): string[] | null {
    const clause = sql.match(
      /businesses_industry_check[\s\S]*?CHECK\s*\(\s*industry IN\s*\(([\s\S]*?)\)\s*\)/i,
    );
    if (!clause) return null;
    return [...clause[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  }

  function newestIndustryCheck(): { file: string; industries: string[] } {
    const candidates = readdirSync(MIGRATIONS_ROOT)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .filter((name) => industryCheckClause(readFileSync(join(MIGRATIONS_ROOT, name), "utf8")) !== null);
    expect(candidates.length, "no migration defines businesses_industry_check").toBeGreaterThan(0);
    const file = candidates[candidates.length - 1];
    const industries = industryCheckClause(readFileSync(join(MIGRATIONS_ROOT, file), "utf8"));
    expect(industries, `${file}: no industry IN (...) list found`).not.toBeNull();
    return { file, industries: industries! };
  }

  it("names every industry exactly once", () => {
    const { file, industries } = newestIndustryCheck();
    expect(new Set(industries).size, `${file}: duplicate industries`).toBe(industries.length);
    expect([...industries].sort()).toEqual([...INDUSTRIES].sort());
  });

  it("is the last migration that touches the constraint", () => {
    // Not a style rule: the *newest* file is what a fresh database applies
    // last, so if an older migration were somehow the widest, a fresh install
    // would fail to provision every later industry.
    const { file, industries } = newestIndustryCheck();
    expect(file.length).toBeGreaterThan(0);
    for (const industry of industries) expect(INDUSTRIES as readonly string[]).toContain(industry);
  });
});

describe("industry lists are declared once, not restated", () => {
  it("finds no hard-coded industry list outside the declared registry sets", () => {
    const offenders = hardCodedIndustryLists().filter(({ file, keys }) => {
      if (SOURCE_SCAN_ALLOWLIST.has(file)) return false;
      return !REGISTRY_SETS.some((set) => {
        const known = new Set<string>(set);
        return keys.length === known.size && keys.every((key) => known.has(key));
      });
    });

    // Joined into one string so the failure message *names the file and
    // line*: a diff of an object array prints as `[Array(1)]`, which tells the
    // author nothing about where to look.
    expect(
      offenders.map((o) => `${o.file}:${o.line} → [${o.keys.join(", ")}]`).join("\n"),
      "restated industry list: import the registry set (INDUSTRIES, PRODUCT_WORKSPACE_INDUSTRIES, "
        + "TRADE_GOODS_INDUSTRIES) or export a new one and add it to REGISTRY_SETS with a note",
    ).toBe("");
  });

  it("scans the tree it thinks it scans", () => {
    // A guard against the guard: if the walker ever stops finding files (a
    // moved root, a renamed extension), the assertions above would pass
    // vacuously.
    const files = walk(SRC_ROOT).filter((file) => !isTestFile(file));
    expect(files.length).toBeGreaterThan(500);
  });
});
