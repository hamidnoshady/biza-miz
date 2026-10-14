/**
 * Issue #799 §25/Wave 11 — the client/server bundle boundary, enforced.
 *
 * `"use client"` marks a module that webpack compiles for the browser. If it
 * imports a *runtime* value from a server module, the whole chain that module
 * imports comes with it — `src/lib/db.ts`'s pool, `pg`, and the node builtins
 * under them. That is not a slow page: it is a build failure in
 * `next build` that type-check, ESLint and the unit suite all pass straight
 * through, because under vitest the same import resolves perfectly well.
 *
 * This is how Wave 10's field screen shipped broken: it imported
 * `AEC_FIELD_ACTIONS` from `aec-field.ts`, which composes its board out of the
 * services and therefore imports the pool. The fixes are cheap and local —
 * put the data in its own module (`aec-field-catalogue.ts`) and import the
 * *type* from the server module when that is all you need — so this test exists
 * to make the next one visible before CI does.
 *
 * The rule is deliberately narrow, so it cannot be papered over: a client file
 * may not reach, through value imports only, either
 *
 *   * `src/lib/db.ts` — the database pool, or
 *   * a module that imports a `node:`-prefixed builtin.
 *
 * `import type { … }` is erased by the compiler and is always allowed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..");
const SRC = join(ROOT, "src");
const DB_MODULE = join(SRC, "lib", "db.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

/** The file a specifier points at, or null for a package or a missing file. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(fromFile), specifier)
      : null;
  if (!base) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not this one */
    }
  }
  return null;
}

/**
 * Every module a file pulls in for its *values*. `import type …` and the
 * `import { type X }` form are erased and therefore ignored; a mixed
 * `import { type X, y }` keeps the module, because `y` survives.
 */
function valueImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const specs: string[] = [];
  for (const match of source.matchAll(/^import\s+(?!type\b)([^;]*?)\s+from\s+"([^"]+)";?$/gm)) {
    const clause = match[1];
    const named = clause.match(/\{([^}]*)\}/);
    if (named && named[1].trim().length > 0) {
      const kept = named[1]
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && !/^type\s/.test(part));
      const hasDefault = /^[A-Za-z0-9_$]+,?\s*$/.test(clause.replace(/\{[^}]*\}/, "").trim());
      if (kept.length === 0 && !hasDefault) continue;
    }
    specs.push(match[2]);
  }
  for (const match of source.matchAll(/^import\s+"([^"]+)";?$/gm)) specs.push(match[1]);
  return specs;
}

function importsNodeBuiltin(file: string): boolean {
  return /from\s+"node:[a-z_/]+"/.test(readFileSync(file, "utf8"));
}

/** The offending path from `start` to a forbidden module, or null. */
function forbiddenPath(start: string, seen = new Set<string>()): string[] | null {
  if (seen.has(start)) return null;
  seen.add(start);
  if (start === DB_MODULE) return [relative(ROOT, start)];
  if (importsNodeBuiltin(start)) return [relative(ROOT, start)];
  for (const specifier of valueImports(start)) {
    const target = resolveSpecifier(start, specifier);
    if (!target) continue;
    const deeper = forbiddenPath(target, seen);
    if (deeper) return [relative(ROOT, start), ...deeper];
  }
  return null;
}

describe("a client component never pulls the server layer into the browser bundle", () => {
  const clientFiles = walk(SRC).filter((file) => {
    if (/\.test\.tsx?$/.test(file)) return false;
    const head = readFileSync(file, "utf8").slice(0, 400);
    return /^\s*"use client";?/m.test(head);
  });

  it("finds the client components at all", () => {
    // A scan that silently stops matching would pass forever.
    expect(clientFiles.length).toBeGreaterThan(50);
  });

  it("reaches no database pool and no node builtin from any of them", () => {
    const offenders = clientFiles
      .map((file) => ({ file, path: forbiddenPath(file) }))
      .filter((found): found is { file: string; path: string[] } => found.path !== null)
      .map((found) => `${relative(ROOT, found.file)} -> ${found.path.join(" -> ")}`);
    expect(offenders).toEqual([]);
  });
});
