/**
 * Issue #1194 — the desktop runtime must not ship raw TypeScript source.
 *
 * Next's node-file-trace follows a dynamically imported module and can copy
 * the original `.ts` file into the standalone tree even though the compiled
 * server chunk is what executes. The 1.0.202 installer was built with
 * `src/lib/billing/entitlement/outbox-service.ts` inside
 * `resources/desktop-runtime/src/`; this test pins the removal and the
 * fail-closed check that stops a future trace from shipping source again.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const traced = require("../../scripts/desktop/traced-source-exclusions.cjs") as {
  RAW_TYPESCRIPT: RegExp;
  removeTracedSourceCopies: (root: string) => Promise<{
    filesRemoved: number;
    bytesRemoved: number;
    removed: Array<{ path: string; bytes: number }>;
  }>;
  rawTypeScriptSurvivors: (root: string) => Promise<string[]>;
  assertNoRawTypeScript: (root: string) => Promise<{ survivors: number }>;
};

const temporaryDirs: string[] = [];
function temporaryDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desktop-traced-source-"));
  temporaryDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

describe("traced TypeScript source", () => {
  it("removes our traced source and keeps runtime assets", async () => {
    const dir = temporaryDir();
    write(path.join(dir, "src", "lib", "billing", "entitlement", "outbox-service.ts"), "export const x = 1;\n");
    write(path.join(dir, "src", "app", "fonts", "Vazirmatn-Variable.woff2"), "font-bytes");
    write(path.join(dir, "node_modules", "typescript", "lib", "lib.dom.d.ts"), "declare const x: 1;\n");
    write(path.join(dir, ".next", "server", "app", "dashboard", "page.js"), "module.exports = {};\n");

    const report = await traced.removeTracedSourceCopies(dir);
    expect(report.filesRemoved).toBe(1);
    expect(report.removed.map((entry) => entry.path)).toEqual([
      "src/lib/billing/entitlement/outbox-service.ts",
    ]);

    expect(existsSync(path.join(dir, "src", "lib", "billing", "entitlement", "outbox-service.ts"))).toBe(false);
    expect(existsSync(path.join(dir, "src", "app", "fonts", "Vazirmatn-Variable.woff2"))).toBe(true);
    expect(existsSync(path.join(dir, "node_modules", "typescript", "lib", "lib.dom.d.ts"))).toBe(true);
    expect(existsSync(path.join(dir, ".next", "server", "app", "dashboard", "page.js"))).toBe(true);

    await expect(traced.assertNoRawTypeScript(dir)).resolves.toEqual({ survivors: 0 });
    expect(await traced.rawTypeScriptSurvivors(dir)).toEqual([]);

    // Idempotent: a second pass has nothing left to remove.
    const second = await traced.removeTracedSourceCopies(dir);
    expect(second.filesRemoved).toBe(0);
  });

  it("fails the build when raw TypeScript survives outside node_modules", async () => {
    const dir = temporaryDir();
    write(path.join(dir, ".next", "server", "app", "leak.ts"), "export const leaked = true;\n");
    await expect(traced.assertNoRawTypeScript(dir)).rejects.toThrow(/Raw TypeScript source survived/);
    expect(await traced.rawTypeScriptSurvivors(dir)).toEqual([".next/server/app/leak.ts"]);
  });

  it("does not treat a declaration file inside a dependency as our source", async () => {
    const dir = temporaryDir();
    write(path.join(dir, "node_modules", "pkg", "index.d.ts"), "declare const x: 1;\n");
    await expect(traced.assertNoRawTypeScript(dir)).resolves.toEqual({ survivors: 0 });
  });
});
