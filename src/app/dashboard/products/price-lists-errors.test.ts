/**
 * Every refusal the price-matrix routes can answer with, against the sentence
 * the screen shows for it.
 *
 * Issue #924 F03/F08/F10 ship whole families of new rejections (a malformed
 * scope, an empty selection, an over-range amount, a purchase cost locked by
 * stock). `errorMessage()` falls back to «خطای غیرمنتظره» for an unmapped code,
 * so a refusal added without a sentence would reach the operator as a shrug —
 * exactly the "silently did nothing" complaint this issue is about.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { errorMessage } from "../ui";

const ROOT = process.cwd();
const ROUTES = join(ROOT, "src/app/api/products/price-lists");
const HISTORY_ROUTE = join(ROOT, "src/app/api/products/price-history/route.ts");
/**
 * The scope validators live in the service and return their codes through a
 * variable, so scanning only the routes missed every one of them.
 */
const SERVICE = join(ROOT, "src/lib/price-lists-service.ts");

/** Every `.ts` route file under the price-lists tree, recursively. */
function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

/** Comments removed: a code quoted in prose is not one the API raises. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The `error:` codes a route answers with. */
function errorCodes(path: string): string[] {
  const source = stripComments(readFileSync(path, "utf8"));
  return [...source.matchAll(/error:\s*"([a-z0-9_]+)"/g)].map((match) => match[1]);
}

const CODED = [...routeFiles(ROUTES), HISTORY_ROUTE, SERVICE].flatMap(errorCodes);

describe("price-matrix route refusals have Persian sentences", () => {
  it("finds the refusals it is meant to check", () => {
    // A silent vacuity check: the scan must actually see the codes, or this
    // test would pass on an empty set.
    expect(CODED.length).toBeGreaterThan(5);
    expect(CODED).toContain("invalid_quick_update_value");
    expect(CODED).toContain("scope_items_not_in_branch");
    // The scope family arrives through a variable, not a literal in the route.
    expect(CODED).toContain("selected_scope_too_large");
    expect(CODED).toContain("duplicate_item_id");
  });

  it("maps every code a route can answer with", () => {
    const unworded = [...new Set(CODED)].filter(
      (code) => errorMessage(code) === "خطای غیرمنتظره. دوباره تلاش کنید.",
    );
    expect(unworded).toEqual([]);
  });
});
