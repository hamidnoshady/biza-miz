/**
 * Issue #902 §9 item 6 — the follow-up audit, as a rule rather than a memory.
 *
 * `resolveBusinessCapability` compared an app's availability state to
 * `"enabled"`. That value has never existed in the vocabulary migration 0128
 * introduced (`available` / `beta` / `coming_soon` / `maintenance` /
 * `disabled`), so every app whose row said `available` was denied as
 * `platform_unavailable` — the platform refused capabilities it had switched
 * on, and nothing failed, because the comparison was type-correct and the
 * tests only ever drove the resolver with the string it expected.
 *
 * The fix was one line, but the *class* of bug is what needs guarding: a second
 * copy of the vocabulary, anywhere, can drift from the registry the same way.
 * This file therefore does three things:
 *
 *   1. sweeps the source for the state strings used in a comparison or a list
 *      outside the registry, so a new hand-rolled check fails here;
 *   2. pins the places that legitimately *name* a state (display code that
 *      needs a colour or an icon) to an explicit allowlist, so the sweep stays
 *      meaningful instead of being widened until it passes;
 *   3. reconciles the TypeScript vocabulary with the SQL CHECK, because the two
 *      have to agree and a migration is where they would silently diverge.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_AVAILABILITY_STATES } from "./app-availability";
import {
  InvalidAppAvailabilityStateError,
  setBusinessAppAvailability,
  setPlatformAppAvailability,
} from "./app-availability-service";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Strip comments and module specifiers: a rule's own prose must not trip it. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/\bfrom\s+"[^"]*"/g, " ")
    .replace(/\bimport\s*\("[^"]*"\)/g, " ");
}

function sources(dir: string, filter: (name: string) => boolean): { name: string; source: string }[] {
  const found: { name: string; source: string }[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(`${ROOT}${dir}${relative}`, { withFileTypes: true })) {
      const path = `${relative}${entry.name}`;
      if (entry.isDirectory()) walk(`${path}/`);
      else if (filter(entry.name)) {
        found.push({ name: `${dir}${path}`, source: code(readFileSync(`${ROOT}${dir}${path}`, "utf8")) });
      }
    }
  };
  walk("");
  return found;
}

const APP_SOURCES = [
  ...sources("src/lib/", (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")),
  ...sources("src/app/", (name) => (name.endsWith(".ts") || name.endsWith(".tsx")) && !name.endsWith(".test.ts")),
];

/**
 * Files allowed to name a state directly, and why.
 *
 * Every entry is *presentation*: a badge needs a colour, a gate needs an icon,
 * the console's editor needs a toggle label. None of them decides whether an app
 * is usable — that question is answered by `usable` in the registry, and the
 * sweep below is what keeps it that way.
 */
const PRESENTATION_ONLY = new Set([
  // The vocabulary itself.
  "src/lib/app-availability.ts",
  // The explanation screen and its badge (icon + tone per state).
  "src/app/dashboard/app-availability-gate.tsx",
  // The console editor's enable/disable button and per-state colours.
  "src/app/platform/app-availability-editor.tsx",
  // The sidebar's badge type.
  "src/app/dashboard/dashboard-sidebar.tsx",
]);

/**
 * `state === "beta"`, `"disabled" !== state`, `["available"].includes(state)`, …
 *
 * The `state|availability` half of the pattern matters: `"disabled"` is also
 * the word an installation, an upload and a service activation use for
 * themselves, and those are different vocabularies with their own registries.
 * The rule is about comparisons that name *this* state.
 */
const STATE_IN_A_DECISION =
  /[=!]==?\s*["'](available|beta|coming_soon|maintenance|disabled)["']|["'](available|beta|coming_soon|maintenance|disabled)["']\s*[=!]==?|\[\s*["'](available|beta|coming_soon|maintenance|disabled)["']/;

function decidesStateByHand(source: string): boolean {
  return source
    .split("\n")
    .some((line) => STATE_IN_A_DECISION.test(line) && /state|availability/i.test(line));
}

describe("the app-availability vocabulary is defined once", () => {
  it("is not re-compared by hand outside the registry and its presentation code", () => {
    const offenders = APP_SOURCES.filter(
      (file) =>
        !PRESENTATION_ONLY.has(file.name) &&
        // Only files that are about *app* availability: `available` is also an
        // ordinary word for a vehicle, an upload and a Telegram bot.
        /app_availability|appAvailability|AppAvailability/.test(file.source) &&
        decidesStateByHand(file.source),
    ).map((file) => file.name);

    expect(
      offenders,
      `files deciding app availability from a hand-written state string: ${offenders.join(", ")} — ` +
        "use APP_AVAILABILITY_META[...].usable or isAppUsable()",
    ).toEqual([]);
  });

  it("keeps every allowlisted file readable, so the list cannot rot into a no-op", () => {
    for (const name of PRESENTATION_ONLY) {
      expect(APP_SOURCES.map((file) => file.name), name).toContain(name);
    }
  });

  it("decides usability through the registry, in the resolver §9 was about", () => {
    const resolver = readFileSync(`${ROOT}src/lib/entitlement-service.ts`, "utf8");
    // The bug, verbatim: a comparison against a state that does not exist.
    expect(code(resolver)).not.toMatch(/["']enabled["']/);
    // And the rule that replaced it, validated rather than cast.
    expect(code(resolver)).toContain("isAppAvailabilityState(state)");
    expect(code(resolver)).toContain("APP_AVAILABILITY_META[state].usable");
    expect(code(resolver)).not.toContain("state as AppAvailabilityState");
  });

  it("validates at the write, the one place every caller passes through", () => {
    const service = code(readFileSync(`${ROOT}src/lib/app-availability-service.ts`, "utf8"));
    // Both writers — platform-wide and per-business — go through the guard.
    expect(service.match(/assertWritable\(/g)?.length).toBeGreaterThanOrEqual(3);
    // The local-activation importer used to carry its own copy of the five
    // strings; it now asks the registry.
    const activation = code(readFileSync(`${ROOT}src/lib/local-activation-site-service.ts`, "utf8"));
    expect(activation).toContain("isAppAvailabilityState(app.state)");
    expect(activation).not.toMatch(/["']coming_soon["']/);
  });

  it("matches the SQL CHECK, so a state cannot exist in one half only", () => {
    const migration = readFileSync(`${ROOT}migrations/0128_app_availability.sql`, "utf8");
    const declared = [...migration.matchAll(/CHECK \(state IN \(([^)]*)\)\)/g)].flatMap((match) =>
      [...match[1].matchAll(/'([a-z_]+)'/g)].map((inner) => inner[1]),
    );
    // Two tables, one vocabulary.
    expect(declared.length).toBe(APP_AVAILABILITY_STATES.length * 2);
    expect([...new Set(declared)].sort()).toEqual([...APP_AVAILABILITY_STATES].sort());
  });
});

describe("an unknown state is refused at the write, not by the database", () => {
  const BUSINESS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it.each(["enabled", "off", "", null, 3])("rejects %s before any query runs", async (state) => {
    // The guard runs before `withoutTenantScope`, so this needs no connection:
    // the point is that the answer does not depend on the database's CHECK.
    await expect(
      setBusinessAppAvailability(
        BUSINESS,
        "growth",
        { state } as unknown as Parameters<typeof setBusinessAppAvailability>[2],
        null,
      ),
    ).rejects.toBeInstanceOf(InvalidAppAvailabilityStateError);
    await expect(
      setPlatformAppAvailability(
        "growth",
        { state } as unknown as Parameters<typeof setPlatformAppAvailability>[1],
        null,
      ),
    ).rejects.toBeInstanceOf(InvalidAppAvailabilityStateError);
  });

  it("names the value it refused, so the caller's log says what was wrong", async () => {
    const error: unknown = await setBusinessAppAvailability(
      BUSINESS,
      "growth",
      { state: "enabled" } as never,
      null,
    ).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(InvalidAppAvailabilityStateError);
    expect((error as InvalidAppAvailabilityStateError).value).toBe("enabled");
  });
});
