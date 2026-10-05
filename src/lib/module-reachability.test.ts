/**
 * Every module under `src/` must be reachable from a real entry point.
 *
 * ## Why this exists
 *
 * The 2026-09 dead-code audit found a handful of modules that nothing could
 * ever load: a floating chat window and its three subcomponents, orphaned when
 * the assistant became the dashboard itself, plus the wizard wrapper that was
 * their only mount point. None of it was a type error, none of it failed a
 * test, and none of it showed up in a diff — an orphaned island compiles
 * perfectly, and the only thing wrong with it is that it is not there. So this
 * test walks the import graph the way the bundler does and fails when a module
 * has drifted off it.
 *
 * ## What counts as an entry point
 *
 * The things a runtime actually starts from, not "anything that looks used":
 *
 *  - Next.js App Router special files (`page`, `layout`, `route`, `loading`,
 *    `error`, `not-found`, `template`, `default`, metadata routes) anywhere in
 *    `src/app`. These are entry points by filename — the framework loads them,
 *    nothing imports them.
 *  - `src/middleware.ts`, the Edge entry.
 *  - Every `*.test.ts(x)`. A test is a real consumer: it is how the contract
 *    modules (`crm-deal-handoff.ts` and friends) are exercised.
 *  - `server.ts` and the repo's config files, which pull in the custom server,
 *    WebSocket handlers and background wiring.
 *  - `scripts/` and `integration/`, invoked from npm scripts, CI and the
 *    desktop/release packaging.
 *
 * ## Why an allowlist rather than a bare assertion
 *
 * A zero-reference result is a *candidate*, not proof — and this repository has
 * two legitimate shapes that a static walk cannot see. Ambient declarations
 * (`.d.ts`) are loaded by the compiler via `tsconfig`, never imported; and a
 * module may be consumed only through a string (a registry key, a dynamic
 * `import()` built at runtime). Both are listed below **with the evidence that
 * keeps them**, so adding a name here is a deliberate, reviewable act rather
 * than a way to silence the test.
 *
 * If this test fails for a file you just added, the question to answer is
 * "what loads this?" — and if the honest answer is "nothing yet", the file is
 * not ready to be committed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const LIB_DIR = fileURLToPath(new URL("./", import.meta.url));
const SRC_DIR = resolve(LIB_DIR, "..");
const REPO_DIR = resolve(SRC_DIR, "..");

const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

/**
 * Modules that nothing imports, and the reason each one stays anyway.
 *
 * Every entry needs evidence a reviewer can check, not an assertion that it is
 * probably fine.
 */
const REACHABLE_BY_OTHER_MEANS: Record<string, string> = {
  // Ambient module declaration. The compiler loads it through `tsconfig.json`'s
  // `include`, so no file ever imports it — but deleting it breaks the build:
  // `mssql` ships no types, and `holoo/client.ts` plus `scripts/holoo-probe.ts`
  // fail with TS7016 without it. Verified by deleting it and running tsc.
  "types/mssql.d.ts":
    "ambient .d.ts for the untyped `mssql` driver; tsconfig loads it, the Holoo client needs it",

  // The platform-support assistant's two read-only health tools. `ai.ts`
  // already advertises both to the model for `mode: "platform"`, and
  // `ai-service.test.ts` / `ai.test.ts` pin the realm separation. No route
  // passes that mode today, so `runPlatformReadTool` is not reached at
  // runtime — but deleting the executor while `ai.ts` still declares the
  // tools would leave the model able to call two tools nothing can answer.
  // Retained deliberately; see docs/engineering/dead-code-cleanup.md.
  "lib/ai-platform-tools.ts":
    "executor for the platform-support tools ai.ts declares; removing it alone would orphan those declarations",

  // The pinned-report widget grid. Nothing mounts it since `/dashboard`
  // became the assistant chat, but the other half of the feature is still
  // live: «سنجاق به داشبورد» (reports/pin-button.tsx) writes to
  // /api/dashboard/widgets, and getDashboardWidgets still serves them.
  // Deleting the renderer would make a working, reachable control write to
  // nothing forever — a product decision, not a cleanup one.
  "app/dashboard/dashboard-grid.tsx":
    "renderer half of the still-live pinned-widget feature (pin-button.tsx + /api/dashboard/widgets)",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (CODE_EXTENSIONS.includes(extname(path))) out.push(path);
  }
  return out;
}

function safeWalk(dir: string): string[] {
  try {
    return walk(dir);
  } catch {
    return [];
  }
}

const sourceFiles = walk(SRC_DIR);
const outerFiles = [
  ...safeWalk(join(REPO_DIR, "scripts")),
  ...safeWalk(join(REPO_DIR, "integration")),
  ...["server.ts", "vitest.setup.ts", "vitest.config.ts", "vitest.db.config.ts", "next.config.ts"]
    .map((name) => join(REPO_DIR, name))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    }),
];

const allFiles = [...sourceFiles, ...outerFiles];
const known = new Set(allFiles);

/** Resolves an import specifier the way the bundler's `@/` alias and Node do. */
function resolveSpecifier(specifier: string, importer: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(SRC_DIR, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(importer), specifier);
  else return null; // a package, not a file in this repo

  for (const extension of CODE_EXTENSIONS) {
    if (known.has(base + extension)) return base + extension;
  }
  if (known.has(base)) return base;
  for (const extension of CODE_EXTENSIONS) {
    const index = join(base, `index${extension}`);
    if (known.has(index)) return index;
  }
  return null;
}

/** Static imports, re-exports, dynamic `import()` and CommonJS `require()`. */
const SPECIFIER_PATTERN =
  /(?:from\s+|import\s+|require\(\s*|import\(\s*)["']([^"']+)["']/g;

const imports = new Map<string, string[]>();
for (const file of allFiles) {
  const source = readFileSync(file, "utf8");
  const resolved = new Set<string>();
  for (const match of source.matchAll(SPECIFIER_PATTERN)) {
    const target = resolveSpecifier(match[1], file);
    if (target) resolved.add(target);
  }
  imports.set(file, [...resolved]);
}

/**
 * App Router files the framework loads by name rather than by import.
 *
 * Matched against a `/`-normalised path. `node:path` emits `\` on Windows and
 * CI runs the unit suite on `windows-latest`, so a pattern anchored on `/`
 * would match nothing there — every page would stop counting as an entry
 * point and the whole graph would look orphaned. `posix()` below is what
 * keeps this test platform-independent; `separatorAgnostic` pins it.
 */
const NEXT_SPECIAL_FILE =
  /(?:^|\/)(page|layout|template|loading|error|global-error|not-found|route|default|sitemap|robots|manifest|opengraph-image|twitter-image|icon|apple-icon|instrumentation)\.(?:ts|tsx|js|jsx)$/;

/** A path with `/` separators, whatever platform produced it. */
function posix(path: string): string {
  return path.split("\\").join("/");
}

const APP_DIR = join(SRC_DIR, "app");

function isEntryPoint(file: string): boolean {
  if (file.startsWith(APP_DIR) && NEXT_SPECIAL_FILE.test(posix(file))) return true;
  if (file === join(SRC_DIR, "middleware.ts")) return true;
  if (/\.test\.(ts|tsx)$/.test(posix(file))) return true;
  return outerFiles.includes(file);
}

/** Everything the entry points can reach, transitively. */
function reachableFrom(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const dependency of imports.get(file) ?? []) stack.push(dependency);
  }
  return seen;
}

const reachable = reachableFrom(allFiles.filter(isEntryPoint));

describe("every module is reachable from a real entry point", () => {
  it("has no orphaned modules under src/", () => {
    const orphans = sourceFiles
      .filter((file) => !reachable.has(file))
      .map((file) => posix(relative(SRC_DIR, file)))
      .filter((path) => !(path in REACHABLE_BY_OTHER_MEANS))
      .sort();

    expect(
      orphans,
      "these modules are imported by nothing and loaded by no framework " +
        "convention. Either wire them up, delete them, or — if a runtime " +
        "really does reach them by a means a static walk cannot see — add " +
        "them to REACHABLE_BY_OTHER_MEANS with the evidence.",
    ).toEqual([]);
  });

  it("keeps the allowlist honest — every entry still exists", () => {
    // An allowlist that outlives its file is how the next orphan hides.
    for (const path of Object.keys(REACHABLE_BY_OTHER_MEANS)) {
      expect(known.has(join(SRC_DIR, path)), `${path} is allowlisted but missing`).toBe(
        true,
      );
    }
  });

  it("keeps the allowlist minimal — no entry that is genuinely imported", () => {
    // If a file becomes normally reachable, its exemption must go, or it will
    // still be exempt on the day it stops being reachable again.
    for (const path of Object.keys(REACHABLE_BY_OTHER_MEANS)) {
      const file = join(SRC_DIR, path);
      // `.d.ts` files are never "reached" by the walk by design.
      if (path.endsWith(".d.ts")) continue;
      expect(
        reachable.has(file),
        `${path} is reachable now — remove it from REACHABLE_BY_OTHER_MEANS`,
      ).toBe(false);
    }
  });

  it("recognises App Router entry points with either path separator", () => {
    // CI runs the unit suite on windows-latest, where `node:path` emits `\`.
    // The first version of this test anchored its special-file pattern on `/`
    // only, so on Windows NO page matched, every page stopped being an entry
    // point, and the orphan list exploded. Pin both spellings.
    for (const spelling of [
      "src/app/dashboard/page.tsx",
      "src\\app\\dashboard\\page.tsx",
      "src/app/api/health/route.ts",
      "src\\app\\api\\health\\route.ts",
      "src/app/(app)/layout.tsx",
      "src\\app\\(app)\\layout.tsx",
    ]) {
      expect(
        NEXT_SPECIAL_FILE.test(posix(spelling)),
        `${spelling} should be recognised as an App Router entry point`,
      ).toBe(true);
    }
    // A component that merely lives beside a page is not one.
    expect(NEXT_SPECIAL_FILE.test(posix("src/app/dashboard/data-table.tsx"))).toBe(
      false,
    );
  });

  it("finds the entry points it claims to — the walk is not vacuously green", () => {
    // A resolver bug that silently matched nothing would make the orphan check
    // pass by finding no imports at all. These anchor it.
    const entries = allFiles.filter(isEntryPoint);
    expect(entries.length).toBeGreaterThan(100);
    expect(reachable.has(join(SRC_DIR, "middleware.ts"))).toBe(true);
    expect(reachable.has(join(SRC_DIR, "lib", "app-routes.ts"))).toBe(true);
    expect(reachable.has(join(SRC_DIR, "lib", "ai-panel.ts"))).toBe(true);
  });
});
