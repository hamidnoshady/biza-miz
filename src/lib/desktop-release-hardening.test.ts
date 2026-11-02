/**
 * Issue #1194 — the desktop payload's hardening is tested against the bytes
 * that ship, not against a promise in a comment.
 *
 * Four contracts, each covering a different layer of the same guarantee:
 *
 *  1. every file in `electron/package.json`'s `build.files` is free of the
 *     removed test-bootstrap markers and Central route shapes;
 *  2. `scripts/desktop/central-route-exclusions.cjs` removes the platform
 *     realm from a staged runtime and fails when one survives;
 *  3. `scripts/desktop/release-scan-rules.cjs` + `scripts/scan-desktop-release.mjs`
 *     detect the markers in a real (fixture) payload and read `app.asar` by
 *     its header;
 *  4. the CI-only acceptance harness can read a desktop profile, refuses a
 *     payload that still contains the markers, and writes the storage marker
 *     that keeps a first launch unattended;
 *  5. the release workflows actually run that gate on the signed bytes, and
 *     production promotion refuses a scan report that was not produced for the
 *     installer being promoted.
 */
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = process.cwd();
const rules = require("../../scripts/desktop/release-scan-rules.cjs") as {
  FORBIDDEN_TEXT_MARKERS: Array<{ id: string; marker?: string }>;
  TEXT_RULES: Array<{ id: string }>;
  scanTextBuffer: (buffer: Buffer, payloadPath: string) => Array<{ id: string; path: string }>;
  scanPath: (relativePath: string) => Array<{ id: string; path: string }>;
  isAllowedKeyFile: (relativePath: string) => boolean;
};
const exclusions = require("../../scripts/desktop/central-route-exclusions.cjs") as {
  removeCentralRoutes: (root: string) => Promise<{
    removed: Array<{ path: string; files?: number; manifestEntries?: number }>;
    filesRemoved: number;
    manifestEntriesRemoved: number;
  }>;
  centralRouteSurvivors: (root: string) => Promise<string[]>;
  assertNoCentralRoutes: (root: string) => Promise<{ survivors: number }>;
};
const harness = require("../../electron/scripts/smoke-packaged.js") as {
  appOrigin: (config: { appPort?: number } | null) => string | null;
  readDesktopConfig: (userDataDir: string) => Record<string, unknown> | null;
  legacyBypassEnvironment: (markerPath: string) => Record<string, string>;
  scanShippedPayload: (options: { resourcesDir: string }) => Array<{ id: string; path: string }>;
  prepareProfile: (userDataDir: string) => void;
  PLATFORM_DENIAL_PATHS: Array<{ method: string; path: string }>;
};

const temporaryDirs: string[] = [];
function temporaryDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desktop-release-hardening-"));
  temporaryDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(file: string, contents: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

describe("the packaged file list carries no test bootstrap", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "electron", "package.json"), "utf8")) as {
    build: { files: string[] };
  };

  it("lists only files that exist and pass the release-scan path rules", () => {
    for (const file of manifest.build.files) {
      const absolute = path.join(root, "electron", file);
      expect(existsSync(absolute), file).toBe(true);
      expect(rules.scanPath(file), file).toEqual([]);
      if (rules.isAllowedKeyFile(file)) continue;
      expect(rules.scanTextBuffer(readFileSync(absolute), file), file).toEqual([]);
    }
  });

  it("contains no shipped credential, probe or mock activation literal", () => {
    const shipped = manifest.build.files
      .map((file) => readFileSync(path.join(root, "electron", file), "utf8"))
      .join("\n");
    for (const literal of [
      "DESKTOP_SMOKE_",
      "runSmokeProbe",
      "startMockCloudActivation",
      "Packaged-Test-Password",
      "smoke-probe",
      "PLATFORM_ADMIN_PASSWORD",
    ]) {
      expect(shipped).not.toContain(literal);
    }
  });

  it("keeps the public release key and nothing private", () => {
    expect(manifest.build.files).toContain("desktop-release-public-key.pem");
    // The checked-in file is a placeholder (CI injects the real public key from
    // DESKTOP_RELEASE_PUBLIC_KEY_PEM), but it must never be private material.
    const pem = readFileSync(path.join(root, "electron", "desktop-release-public-key.pem"), "utf8");
    expect(pem).not.toContain("PRIVATE KEY");
    expect(rules.scanTextBuffer(Buffer.from(pem), "desktop-release-public-key.pem")).toEqual([]);
  });
});

describe("central-route exclusions", () => {
  function fixtureRuntime(): string {
    const dir = temporaryDir();
    write(path.join(dir, ".next", "server", "app", "platform", "login", "page.js"), "module.exports = {};\n");
    write(path.join(dir, ".next", "server", "app", "api", "platform", "auth", "login", "route.js"), "exports.POST=1;\n");
    write(path.join(dir, ".next", "server", "app", "dashboard", "page.js"), "module.exports = {};\n");
    write(path.join(dir, ".next", "server", "app", "api", "setup", "state", "route.js"), "exports.GET=1;\n");
    write(
      path.join(dir, ".next", "server", "app-paths-manifest.json"),
      JSON.stringify({
        "/dashboard/page": "./app/dashboard/page.js",
        "/api/setup/state/route": "./app/api/setup/state/route.js",
        "/api/platform/auth/login/route": "./app/api/platform/auth/login/route.js",
        "/platform/login/page": "./app/platform/login/page.js",
      }),
    );
    write(
      path.join(dir, ".next", "app-build-manifest.json"),
      JSON.stringify({
        pages: {
          "/dashboard/page": ["static/chunks/app/dashboard/page-1.js"],
          "/platform/login/page": ["static/chunks/app/platform/login/page-2.js"],
        },
      }),
    );
    return dir;
  }

  it("removes the console from the runtime and keeps tenant routes", async () => {
    const dir = fixtureRuntime();
    const report = await exclusions.removeCentralRoutes(dir);
    expect(report.filesRemoved).toBe(2);
    // Two app-path entries plus one app-build-manifest page.
    expect(report.manifestEntriesRemoved).toBe(3);
    expect(existsSync(path.join(dir, ".next", "server", "app", "platform"))).toBe(false);
    expect(existsSync(path.join(dir, ".next", "server", "app", "api", "platform"))).toBe(false);
    expect(existsSync(path.join(dir, ".next", "server", "app", "api", "setup", "state", "route.js"))).toBe(true);

    const appPaths = JSON.parse(
      readFileSync(path.join(dir, ".next", "server", "app-paths-manifest.json"), "utf8"),
    ) as Record<string, string>;
    expect(Object.keys(appPaths).sort()).toEqual(["/api/setup/state/route", "/dashboard/page"]);
    const buildManifest = JSON.parse(readFileSync(path.join(dir, ".next", "app-build-manifest.json"), "utf8")) as {
      pages: Record<string, string[]>;
    };
    expect(Object.keys(buildManifest.pages)).toEqual(["/dashboard/page"]);

    await expect(exclusions.assertNoCentralRoutes(dir)).resolves.toEqual({ survivors: 0 });
    expect(await exclusions.centralRouteSurvivors(dir)).toEqual([]);

    // Idempotent: a second pass has nothing left to remove.
    const second = await exclusions.removeCentralRoutes(dir);
    expect(second.filesRemoved).toBe(0);
    expect(second.manifestEntriesRemoved).toBe(0);
  });

  it("fails the build when a platform route survives", async () => {
    const dir = fixtureRuntime();
    await expect(exclusions.assertNoCentralRoutes(dir)).rejects.toThrow(/Central Superadmin routes survived/);
  });
});

describe("release-scan rules", () => {
  it("flags every removed test-bootstrap literal and leaves clean text alone", () => {
    for (const marker of [
      "DESKTOP_SMOKE_BOOTSTRAP",
      "require('./smoke-probe')",
      "runSmokeProbe({",
      "startMockCloudActivation({",
      "packaged-runtime@example.invalid:Packaged-Test-Password-2026",
      "PLATFORM_ADMIN_PASSWORD=secret",
      "scripts/seed-platform-admin.ts",
    ]) {
      expect(rules.scanTextBuffer(Buffer.from(`...${marker}...`), "fixture"), marker).not.toEqual([]);
    }
    expect(rules.scanTextBuffer(Buffer.from("a normal tenant route"), "fixture")).toEqual([]);
    // A public key is not private material.
    expect(rules.scanTextBuffer(Buffer.from("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----"), "x")).toEqual([]);
  });

  it("flags Central routes and protected file shapes, not tenant paths", () => {
    for (const forbidden of [
      ".next/server/app/platform/login/page.js",
      ".next/server/app/api/platform/auth/login/route.js",
      ".next/static/chunks/app/platform/login/page-abc.js",
      "resources/app.asar.unpacked/smoke-probe.js",
      "scripts/seed-platform-admin.ts",
      "electron/dist/win-unpacked/resources/cert.pfx",
      "some/__tests__/route.test.ts",
      "Configuration/.env",
    ]) {
      expect(rules.scanPath(forbidden), forbidden).not.toEqual([]);
    }
    for (const allowed of [
      ".next/server/app/dashboard/page.js",
      ".next/server/app/api/setup/state/route.js",
      ".next/server/app/api/local-activation/cloud/route.js",
      "desktop-release-public-key.pem",
      "Configuration/.env.example",
    ]) {
      expect(rules.scanPath(allowed), allowed).toEqual([]);
    }
  });
});

describe("scan-desktop-release", () => {
  /** Build a real one-file asar so the header reader is exercised, not mocked. */
  function asarBuffer(files: Array<{ path: string; contents: string }>): Buffer {
    const tree: Record<string, unknown> = {};
    let offset = 0;
    for (const file of files) {
      const parts = file.path.split("/");
      let node = tree;
      for (const part of parts.slice(0, -1)) {
        node[part] = (node[part] as Record<string, unknown>) ?? { files: {} };
        node = (node[part] as { files: Record<string, unknown> }).files;
      }
      node[parts[parts.length - 1]] = {
        size: Buffer.byteLength(file.contents),
        offset: String(offset),
      };
      offset += Buffer.byteLength(file.contents);
    }
    const json = Buffer.from(JSON.stringify({ files: tree }));
    const headerPayloadLength = 4 + json.length + ((4 - ((4 + json.length) % 4)) % 4);
    const header = Buffer.alloc(headerPayloadLength);
    header.writeUInt32LE(json.length, 0);
    json.copy(header, 4);
    const prefix = Buffer.alloc(8);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(header.length, 4);
    const data = Buffer.concat(files.map((file) => Buffer.from(file.contents)));
    return Buffer.concat([prefix, header, data]);
  }

  it("reads asar entries and their bytes from the real header layout", async () => {
    const module = (await import("../../scripts/scan-desktop-release.mjs")) as unknown as {
      readAsarHeader: (buffer: Buffer) => { header: unknown; dataOffset: number };
      asarEntries: (header: unknown) => Array<{ path: string; size: number; offset: number }>;
    };
    const archive = asarBuffer([
      { path: "smoke-probe.js", contents: "DESKTOP_SMOKE_BOOTSTRAP=1" },
      { path: "main.js", contents: "console.log('clean')" },
    ]);
    const { header, dataOffset } = module.readAsarHeader(archive);
    const entries = module.asarEntries(header);
    expect(entries.map((entry) => entry.path)).toEqual(["smoke-probe.js", "main.js"]);
    const smoke = entries[0];
    expect(archive.subarray(dataOffset + smoke.offset, dataOffset + smoke.offset + smoke.size).toString()).toContain(
      "DESKTOP_SMOKE_BOOTSTRAP",
    );
  });

  it("fails a fixture payload that still contains the probe and passes a clean one", async () => {
    const module = (await import("../../scripts/scan-desktop-release.mjs")) as unknown as {
      runScan: (options: { payload?: string; installer?: string }) => Promise<{
        ok: boolean;
        findings: Array<{ id: string; path: string }>;
        payload: { files: number } | null;
      }>;
    };
    const payload = temporaryDir();
    write(path.join(payload, "resources", "app.asar"), asarBuffer([{ path: "main.js", contents: "clean" }]));
    write(path.join(payload, "resources", "desktop-runtime", "bin", "server.cjs"), "module.exports = 1;\n");
    write(path.join(payload, "resources", "desktop-runtime", ".next", "BUILD_ID"), "build-1\n");
    await expect(module.runScan({ payload })).resolves.toMatchObject({ ok: true, findings: [] });

    write(
      path.join(payload, "resources", "desktop-runtime", ".next", "server", "app", "api", "platform", "auth", "route.js"),
      "exports.POST = (req) => req;\n",
    );
    const failing = await module.runScan({ payload });
    expect(failing.ok).toBe(false);
    expect(failing.findings.map((finding) => finding.id)).toContain("central-platform-api");

    rmSync(path.join(payload, "resources", "desktop-runtime", ".next", "server", "app", "api", "platform"), {
      recursive: true,
      force: true,
    });
    write(path.join(payload, "resources", "desktop-runtime", "smoke-probe.js"), "DESKTOP_SMOKE_BOOTSTRAP=1\n");
    const probe = await module.runScan({ payload });
    expect(probe.findings.map((finding) => finding.id)).toEqual(
      expect.arrayContaining(["smoke-probe-file", "desktop-smoke-environment"]),
    );
  });
});

describe("packaged acceptance harness", () => {
  it("reads the desktop profile and derives the loopback origin", () => {
    const profile = temporaryDir();
    expect(harness.readDesktopConfig(profile)).toBeNull();
    write(path.join(profile, "Configuration", "config.json"), JSON.stringify({ appPort: 3077, instanceId: "i-1" }));
    expect(harness.readDesktopConfig(profile)).toMatchObject({ appPort: 3077 });
    expect(harness.appOrigin({ appPort: 3077 })).toBe("http://127.0.0.1:3077");
    expect(harness.appOrigin({})).toBeNull();
    expect(harness.appOrigin(null)).toBeNull();
  });

  it("exercises the legacy bypass switches without granting anything", () => {
    const env = harness.legacyBypassEnvironment("/tmp/marker.json");
    expect(env).toEqual({
      DESKTOP_SMOKE_MARKER: "/tmp/marker.json",
      DESKTOP_SMOKE_BOOTSTRAP: "1",
      DESKTOP_SMOKE_PACKAGED_PROBE: "1",
      LOCAL_ACTIVATION_ALLOW_TEST_HTTP_LOOPBACK: "1",
    });
    // The probe used to write this marker; the release must not honour any of it.
    expect(JSON.stringify(env)).toContain("DESKTOP_SMOKE_MARKER");
  });

  it("writes the ordinary storage marker so a first launch never prompts", () => {
    const profile = temporaryDir();
    harness.prepareProfile(profile);
    const marker = JSON.parse(readFileSync(path.join(profile, "storage-location.json"), "utf8")) as {
      root: string;
    };
    expect(marker.root).toBe(profile);
    expect(existsSync(path.join(profile, "acceptance"))).toBe(true);
    // Idempotent, and it never overwrites an owner's recorded choice.
    writeFileSync(path.join(profile, "storage-location.json"), JSON.stringify({ root: "/elsewhere" }));
    harness.prepareProfile(profile);
    expect(JSON.parse(readFileSync(path.join(profile, "storage-location.json"), "utf8")).root).toBe("/elsewhere");
  });

  it("refuses an installed payload that still carries the markers", () => {
    const resources = temporaryDir();
    write(path.join(resources, "app.asar"), "clean archive bytes");
    write(path.join(resources, "desktop-runtime", "bin", "server.cjs"), "module.exports = 1;\n");
    expect(harness.scanShippedPayload({ resourcesDir: resources })).toEqual([]);

    write(
      path.join(resources, "desktop-runtime", ".next", "server", "app", "platform", "login", "page.js"),
      "module.exports = {};\n",
    );
    write(path.join(resources, "desktop-runtime", "bin", "smoke-probe.js"), "DESKTOP_SMOKE_BOOTSTRAP=1\n");
    const findings = harness.scanShippedPayload({ resourcesDir: resources });
    expect(findings.map((finding) => finding.id)).toEqual(
      expect.arrayContaining(["central-platform-pages", "smoke-probe-file", "desktop-smoke-environment"]),
    );
  });

  it("probes the platform realm with the methods that would mutate", () => {
    const paths = harness.PLATFORM_DENIAL_PATHS.map((probe) => `${probe.method} ${probe.path}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        "GET /platform",
        "GET /platform/login",
        "POST /api/platform/auth/login",
        "GET /api/platform/auth/me",
        "POST /api/platform/mcp",
      ]),
    );
    expect(rules.TEXT_RULES.length).toBeGreaterThan(0);
  });
});

describe("release workflow wiring", () => {
  const workflow = (name: string) => readFileSync(path.join(root, ".github", "workflows", name), "utf8");

  it("scans the signed candidate payload and installer, and keeps the report", () => {
    const candidate = workflow("windows-signed-candidate.yml");
    expect(candidate).toContain("scan-desktop-release.mjs");
    expect(candidate).toContain("--installer=");
    expect(candidate).toContain("--require-installer-extraction");
    expect(candidate).toContain("--output=desktop-release-scan.json");
    // The report has to survive the job twice: as an artifact for promotion and
    // in the failure diagnostics that explain a rejected candidate.
    expect(candidate.match(/desktop-release-scan\.json/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("promotes only a scan report that covers the accepted installer", () => {
    const production = workflow("windows-production-release.yml");
    expect(production).toContain("Require-One 'desktop-release-scan.json'");
    expect(production).toContain("if (-not $releaseScan.ok)");
    expect(production).toContain("$releaseScan.installer.sha256 -cne $installerHash");
    expect(production).toContain("-not $releaseScan.installer");
  });

  it("fails the shippables build when the package shape regresses", () => {
    const shippables = workflow("verify-shippables.yml");
    for (const suite of [
      "src/lib/desktop-shell-hardening.test.ts",
      "src/lib/desktop-release-hardening.test.ts",
      "src/lib/platform-realm-isolation.test.ts",
      "src/middleware.issue-1194.test.ts",
    ]) {
      expect(shippables).toContain(suite);
    }
    expect(shippables).toContain("FORBIDDEN_TEXT_MARKERS");
    expect(shippables).toContain("FORBIDDEN_PATH_RULES");
  });

  it("gates the unsigned payload before a signed candidate is even built", () => {
    const installer = workflow("build-desktop-installer.yml");
    expect(installer).toContain("scan-desktop-release.mjs");
    expect(installer).toContain("--require-installer-extraction");
    expect(installer).toContain("desktop-release-scan.json");
  });
});
