/**
 * The desktop build's embedded PostgreSQL shutdown (issue #869 CI).
 *
 * Loading `embedded-postgres` registers an `exit` hook through `async-exit-hook`
 * whose shutdown cannot run on exit and fails with "done is not a function". The
 * helper the desktop backend calls right after loading the module removes exactly
 * that hook, from the same `async-exit-hook` instance the module registered with,
 * and leaves the others. This test loads the real module and checks the registration
 * before and after, rather than trusting the library's internals.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { releaseEmbeddedPostgresExitHook } from "../../electron/embedded-postgres-exit.js";

const ENTRY = path.join(process.cwd(), "node_modules", "embedded-postgres", "dist", "index.js");

describe("the embedded PostgreSQL exit hook", () => {
  it("is removed from exit, the same instance embedded-postgres registered with, and nothing else", async () => {
    await import("embedded-postgres");
    const hook = createRequire(ENTRY)("async-exit-hook") as {
      hookedEvents: () => string[];
    };
    expect(hook.hookedEvents()).toContain("exit");
    const exitListeners = process.listenerCount("exit");

    expect(releaseEmbeddedPostgresExitHook(ENTRY)).toBe(true);

    expect(hook.hookedEvents()).not.toContain("exit");
    expect(process.listenerCount("exit")).toBe(exitListeners - 1);
    // The async-capable hooks that really stop PostgreSQL stay registered.
    expect(hook.hookedEvents()).toEqual(expect.arrayContaining(["beforeExit", "SIGINT", "SIGTERM"]));
  });

  it("does nothing the second time, so loading the module again is harmless", async () => {
    await import("embedded-postgres");
    releaseEmbeddedPostgresExitHook(ENTRY);
    expect(releaseEmbeddedPostgresExitHook(ENTRY)).toBe(false);
  });
});

describe("the desktop backend's local modules are all packaged", () => {
  it("lists every ./module that backend-manager.js requires in electron/package.json's build files", async () => {
    const fs = await import("node:fs");
    const backend = fs.readFileSync(path.join(process.cwd(), "electron", "backend-manager.js"), "utf8");
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "electron", "package.json"), "utf8")) as {
      build: { files: string[] };
    };
    const required = [...backend.matchAll(/require\("\.\/([^"]+)"\)/g)].map((match) =>
      path.extname(match[1]) ? match[1] : `${match[1]}.js`,
    );
    expect(required.length).toBeGreaterThan(0);
    const missing = required.filter((file) => file !== "package.json" && !pkg.build.files.includes(file));
    expect(missing, "modules the packaged backend loads but electron-builder would leave out").toEqual([]);
  });
});
