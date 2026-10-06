/**
 * The CRM is written for a right-to-left document.
 *
 * `<html lang="fa" dir="rtl">` is the app's premise (`src/app/layout.tsx`), so
 * the properties it depends on are not preferences — they are what keeps a
 * Persian screen from ending up with its rule on the wrong edge and its
 * timestamps in the wrong calendar.
 *
 * This suite greps the sources, the approach `design-lint.test.ts` and
 * `accounting-nav-rtl.test.ts` already use, because the CRM's screens are client
 * components that a Node-only vitest cannot mount. That is a real limit, so it
 * pins only what is checkable from the text: the direction utilities, the
 * absence of a second date formatter, and the document direction the rest of the
 * rules silently assume.
 *
 * What was actually wrong when this was written: four `mr-2` insets and one
 * `text-right` title — physically correct under RTL by accident, and wrong the
 * moment the same component renders in the other direction. The insets became
 * `ms-2` (identical in RTL, correct in LTR) and the title `text-start` (the
 * default for Persian text, said out loud).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const CRM_DIR = fileURLToPath(new URL(".", import.meta.url));
const LAYOUT = readFileSync(
  fileURLToPath(new URL("../../../app/layout.tsx", import.meta.url)),
  "utf8",
);

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (extname(path) === ".tsx" && !entry.endsWith(".test.tsx")) out.push(path);
  }
  return out;
}

/** Physical-direction utilities, which mirror wrongly under `dir="rtl"`. */
const PHYSICAL_CLASSES =
  /(?<![\w-])(?:ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|text-left|text-right)-[\w./[\]]+/g;
const PHYSICAL_BARE = /(?<![\w-])(?:text-left|text-right)(?![\w-])/g;

function physicalClassesIn(source: string): string[] {
  return [...(source.match(PHYSICAL_CLASSES) ?? []), ...(source.match(PHYSICAL_BARE) ?? [])];
}

/** Date formatting that does not know the app renders Shamsi. */
const NON_SHAMSI_DATES = /toLocaleDateString|toLocaleString|Intl\.DateTimeFormat/g;

const CRM_FILES = sources(CRM_DIR);

describe("the CRM is written for RTL", () => {
  it("scans the screens (guards against a broken walk)", () => {
    // A walk that silently finds nothing would pass every rule below.
    expect(CRM_FILES.length).toBeGreaterThan(20);
    expect(CRM_FILES.some((path) => path.endsWith("crm-section.tsx"))).toBe(true);
  });

  it("has a document direction to be right about", () => {
    // The premise, asserted rather than assumed: every rule here is only
    // correct while the app is a Persian RTL document.
    expect(LAYOUT).toMatch(/dir="rtl"/);
    expect(LAYOUT).toMatch(/lang="fa"/);
  });

  it("uses logical insets, never physical left/right ones", () => {
    // `ms`/`me`/`ps`/`pe`/`border-s`/`text-start` flip with the document
    // direction; `ml`/`pr`/`text-left` do not.
    const offenders: Record<string, string[]> = {};
    for (const path of CRM_FILES) {
      const hits = physicalClassesIn(readFileSync(path, "utf8"));
      if (hits.length > 0) offenders[path.slice(CRM_DIR.length)] = hits;
    }
    expect(offenders).toEqual({});
  });

  it("keeps every timestamp on the Shamsi calendar", () => {
    // One Jalali formatter for the whole app (`@/lib/jalali`). A screen that
    // reaches for the browser's own formatter renders Gregorian dates in a
    // Persian product — silently, and only for some locales.
    const offenders: Record<string, string[]> = {};
    for (const path of CRM_FILES) {
      const hits = readFileSync(path, "utf8").match(NON_SHAMSI_DATES);
      if (hits) offenders[path.slice(CRM_DIR.length)] = [...new Set(hits)];
    }
    expect(offenders).toEqual({});
  });
});
