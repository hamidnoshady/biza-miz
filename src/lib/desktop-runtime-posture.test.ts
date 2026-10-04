import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertSecurePosture } from "./deployment-posture";

const require = createRequire(import.meta.url);
const { desktopServerEnvironment, postgresStartStrategy, pgCtlStartArguments } = require(
  "../../electron/backend-manager.js",
) as {
  desktopServerEnvironment: (
    config: { jwtSecret: string; appPort: number; instanceId: string },
    runtimeUrl: string,
    superuserUrl: string,
  ) => Record<string, string>;
  postgresStartStrategy: (platform?: string) => "pg_ctl" | "embedded";
  pgCtlStartArguments: (dataDir: string, logPath: string, port: number) => string[];
};
const writeSigningStatus = require("../../electron/scripts/write-signing-status.js") as (result: {
  outDir: string;
  artifactPaths: string[];
}) => Promise<void>;
const windowsSigningConfig = require("../../electron/scripts/windows-signing-config.js") as {
  afterAllArtifactBuild?: string;
  artifactBuildCompleted?: string;
};

describe("packaged desktop production posture", () => {
  it("pins a supported Node.js 24 Electron runtime and build target", () => {
    const rootManifest = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));
    const desktopManifest = JSON.parse(readFileSync(path.resolve("electron/package.json"), "utf8"));
    const desktopLock = JSON.parse(readFileSync(path.resolve("electron/package-lock.json"), "utf8"));
    const runtimeBuilder = readFileSync(path.resolve("scripts/build-desktop-runtime.mjs"), "utf8");
    const electronVersion = desktopManifest.devDependencies.electron as string;

    expect(rootManifest.engines.node).toBe(">=24");
    expect(desktopManifest.engines.node).toBe(">=24");
    expect(desktopManifest.build.electronLanguages).toEqual(["en-US", "fa"]);
    expect(electronVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Number.parseInt(electronVersion.split(".")[0], 10)).toBeGreaterThanOrEqual(44);
    expect(desktopLock.packages["node_modules/electron"].version).toBe(electronVersion);
    expect(desktopManifest.build.extraResources).toContainEqual({
      from: "../.desktop-runtime/node_modules",
      to: "desktop-runtime/node_modules",
      filter: ["**/*"],
    });
    expect(runtimeBuilder).toContain('target: "node24"');
    expect(runtimeBuilder).toContain('engines: { node: ">=24" }');
  });

  it("keeps component-generation tooling out of the production dependency graph", () => {
    const rootManifest = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));
    const rootLock = JSON.parse(readFileSync(path.resolve("package-lock.json"), "utf8"));

    // The shadcn CLI generates source and supplies a build-time CSS import;
    // neither the application server nor the packaged desktop runs it. Keeping
    // it in dependencies also misclassifies its glob/code-generation tooling
    // as shipped code and fails both production dependency audit gates.
    expect(rootManifest.dependencies).not.toHaveProperty("shadcn");
    expect(rootManifest.devDependencies.shadcn).toBeTruthy();
    expect(rootLock.packages[""].dependencies).not.toHaveProperty("shadcn");
    expect(rootLock.packages[""].devDependencies.shadcn).toBe(rootManifest.devDependencies.shadcn);
    for (const name of ["shadcn", "ts-morph", "@ts-morph/common", "fast-glob", "micromatch", "braces"]) {
      expect(rootLock.packages[`node_modules/${name}`], `${name} must remain development-only`).toMatchObject({
        dev: true,
      });
    }
  });

  it("checks stable tag collisions only for releases, not unique CI previews", () => {
    const workflow = readFileSync(path.resolve(".github/workflows/build-desktop-installer.yml"), "utf8");
    expect(workflow).toContain('if ($env:RELEASE_BUILD -eq "true" -and (git tag --list "desktop-v$next")) {');
    expect(workflow).not.toContain('if (git tag --list "desktop-v$next") {');
    expect(workflow).toContain('$version = if ($env:RELEASE_BUILD -eq "true") { $next } else { "$next-ci.$env:GITHUB_RUN_NUMBER" }');
  });

  it("always launches the internal server as a loopback-only production site", () => {
    const env = desktopServerEnvironment(
      { jwtSecret: "test", appPort: 3042, instanceId: "instance" },
      "postgres://pos_app:test@127.0.0.1:5544/pos",
      "postgres://postgres:test@127.0.0.1:5544/pos",
    );
    expect(env).toMatchObject({
      NODE_ENV: "production",
      DEPLOYMENT_ROLE: "site",
      BIND_ADDR: "127.0.0.1",
      PORT: "3042",
    });
    expect(env.ALLOW_INSECURE_LAN).toBeUndefined();
  });

  it("starts Windows PostgreSQL through pg_ctl's restricted-token path", () => {
    expect(postgresStartStrategy("win32")).toBe("pg_ctl");
    expect(postgresStartStrategy("linux")).toBe("embedded");
    const args = pgCtlStartArguments(
      "C:\\Users\\owner\\AppData\\Roaming\\Business Suite\\pgdata",
      "C:\\Users\\owner\\AppData\\Roaming\\Business Suite\\logs\\postgres.log",
      5544,
    );
    expect(args).toEqual([
      "start", "-D", "C:\\Users\\owner\\AppData\\Roaming\\Business Suite\\pgdata",
      "-l", "C:\\Users\\owner\\AppData\\Roaming\\Business Suite\\logs\\postgres.log",
      "-w", "-t", "90", "-o", "-p 5544 -c listen_addresses=127.0.0.1",
    ]);
    expect(args.join(" ")).not.toContain("0.0.0.0");
    expect(() => pgCtlStartArguments("data", "postgres.log", 0)).toThrow(/Invalid PostgreSQL port/);
  });

  it("writes one package-level signing status from electron-builder's BuildResult", async () => {
    expect(windowsSigningConfig.afterAllArtifactBuild).toBe("scripts/write-signing-status.js");
    expect(windowsSigningConfig.artifactBuildCompleted).toBeUndefined();
    const outDir = mkdtempSync(path.join(os.tmpdir(), "desktop-signing-status-"));
    const prior = process.env.WINDOWS_SIGNING_PROVIDER;
    const priorCandidate = process.env.CANDIDATE_COMMIT;
    process.env.WINDOWS_SIGNING_PROVIDER = "unsigned";
    process.env.CANDIDATE_COMMIT = "a".repeat(40);
    try {
      await writeSigningStatus({
        outDir,
        artifactPaths: [path.join(outDir, "Business Suite Setup.exe"), path.join(outDir, "latest.yml")],
      });
      const report = JSON.parse(readFileSync(path.join(outDir, "windows-signing-status.json"), "utf8"));
      expect(report).toMatchObject({
        status: "UNSIGNED DEVELOPMENT",
        provider: "unsigned",
        artifacts: ["Business Suite Setup.exe", "latest.yml"],
        commit: "a".repeat(40),
      });
    } finally {
      if (prior === undefined) delete process.env.WINDOWS_SIGNING_PROVIDER;
      else process.env.WINDOWS_SIGNING_PROVIDER = prior;
      if (priorCandidate === undefined) delete process.env.CANDIDATE_COMMIT;
      else process.env.CANDIDATE_COMMIT = priorCandidate;
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("passes secure posture without an insecure-LAN bypass", () => {
    const previous = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    try {
      expect(() => assertSecurePosture("site", "127.0.0.1", false)).not.toThrow();
      expect(() => assertSecurePosture("site", "0.0.0.0", false)).toThrow(/Production site deployment/);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = previous;
    }
  });

  /**
   * `playwright-core` ships a prebuilt `coreBundle.js` that requires
   * `chromium-bidi` subpaths which are not present in the npm tree, so esbuild
   * cannot resolve them and fails the entire desktop bundle. It stays external.
   *
   * This is a regression test with a real history: adding a background tick to
   * `server.ts` that reached the PDF export path pulled `playwright-core` into
   * the bundle for the first time and broke `npm run desktop:runtime`, taking
   * both the `verify-shippables` and `build-desktop-installer` workflows with
   * it — while every other gate stayed green, because nothing else compiles
   * `server.ts` with esbuild. Marking it external is safe precisely because
   * Next's standalone trace already stages the real package into the runtime's
   * `node_modules`, so the unbundled `require` resolves at run time.
   */
  it("keeps playwright-core out of the esbuild bundle", () => {
    const builder = readFileSync(
      path.join(process.cwd(), "scripts", "build-desktop-runtime.mjs"),
      "utf8",
    );
    const external = builder.match(/external:\s*\[([\s\S]*?)\]/)?.[1] ?? "";
    expect(external).toContain('"playwright-core"');
    // The natives that were already unbundleable must not be dropped while
    // editing that list.
    for (const dependency of ['"pg-native"', '"bufferutil"', '"utf-8-validate"']) {
      expect(external).toContain(dependency);
    }
  });
});
