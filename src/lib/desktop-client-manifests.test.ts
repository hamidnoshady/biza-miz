import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { compactNextClientManifests } =
  require("../../scripts/desktop/compact-next-client-manifests.cjs") as {
    compactNextClientManifests: (runtime: string) => Promise<{
      files: number;
      bytesBefore: number;
      bytesAfter: number;
    }>;
  };
// Exercise the actual pinned Next loader, including its fresh VM and cache,
// rather than rely only on the compactor's internal equivalence check.
const { evalManifest } = require("next/dist/server/load-manifest.external") as {
  evalManifest: (filename: string, cache: boolean) => { __RSC_MANIFEST: unknown };
};
let runtime: string;
let app: string;
const manifest = {
  moduleLoading: { prefix: "/_next/", crossOrigin: null },
  clientModules: {
    "D:\\a\\biza-miz\\src\\components\\notifications\\notification-bell.tsx": {
      id: 4321,
      chunks: ["123", "static/chunks/123.js"],
      name: "*",
      async: false,
    },
  },
  ssrModuleMapping: {
    "4321": { "*": { id: 88, name: "NotificationBell", chunks: [], async: true } },
  },
  edgeSSRModuleMapping: {},
  rscModuleMapping: {},
  edgeRscModuleMapping: {},
  entryCSSFiles: { "(app)/layout": [{ path: "static/css/abc.css", inlined: false }] },
};
function source(route: string) {
  return `globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST[${JSON.stringify(route)}]=${JSON.stringify(manifest)}`;
}
const data = (filename: string) =>
  JSON.parse(JSON.stringify(evalManifest(filename, false).__RSC_MANIFEST));
beforeEach(async () => {
  runtime = await mkdtemp(path.join(os.tmpdir(), "desktop-client-manifests-"));
  app = path.join(runtime, ".next", "server", "app");
  await mkdir(app, { recursive: true });
});
afterEach(async () => {
  await rm(runtime, { recursive: true, force: true });
});

describe("desktop client-reference manifest compaction", () => {
  it("retains every API/page manifest and exact Next-loaded data while reducing bytes", async () => {
    const files = [
      [
        "api/notifications/inbox/route_client-reference-manifest.js",
        "/api/notifications/inbox/route",
      ],
      [
        "(app)/settings/notifications/page_client-reference-manifest.js",
        "/(app)/settings/notifications/page",
      ],
      ["(app)/پروژه/page_client-reference-manifest.js", "/(app)/پروژه/page"],
    ];
    let before = 0;
    for (const [relative, route] of files) {
      const filename = path.join(app, relative);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, source(route));
      before += Buffer.byteLength(source(route));
      expect(data(filename)).toEqual({ [route]: manifest });
    }
    const report = await compactNextClientManifests(runtime);
    expect(report.files).toBe(files.length);
    expect(report.bytesBefore).toBe(before);
    expect(report.bytesAfter).toBeLessThan(before);
    let after = 0;
    for (const [relative, route] of files) {
      const filename = path.join(app, relative);
      expect(data(filename)).toEqual({ [route]: manifest });
      after += (await readFile(filename)).length;
    }
    expect(report.bytesAfter).toBe(after);
    // Deterministic and safe on repeated staging, without byte growth.
    const repeated = await compactNextClientManifests(runtime);
    expect(repeated.bytesBefore).toBe(after);
    expect(repeated.bytesAfter).toBe(after);
  });

  it("does not touch route code, other manifests, dependencies, or client assets", async () => {
    const files = [
      ".next/server/app/api/example/route.js",
      ".next/server/app/other-manifest.js",
      ".next/server/app/data.json",
      ".next/static/chunks/client.js",
      "node_modules/next/server.js",
      "outside_client-reference-manifest.js",
    ];
    for (const file of files) {
      await mkdir(path.dirname(path.join(runtime, file)), { recursive: true });
      await writeFile(path.join(runtime, file), "/* keep byte-for-byte */ const runtime = true;\n");
    }
    // No matching manifests is valid for an empty fixture, not a license to
    // remove files which happen to be large or lack this exact suffix.
    const report = await compactNextClientManifests(runtime);
    expect(report).toEqual({ files: 0, bytesBefore: 0, bytesAfter: 0 });
    for (const file of files) {
      expect(await readFile(path.join(runtime, file), "utf8")).toBe(
        "/* keep byte-for-byte */ const runtime = true;\n",
      );
    }
  });

  it("fails closed on unexpected manifest format and leaves the file intact", async () => {
    const filename = path.join(app, "route_client-reference-manifest.js");
    await writeFile(filename, "globalThis.otherManifest = {};");
    await expect(compactNextClientManifests(runtime)).rejects.toThrow(
      "Unexpected Next client-reference manifest",
    );
    expect(await readFile(filename, "utf8")).toBe("globalThis.otherManifest = {};");
  });

  it("fails instead of concealing an absent staged app tree", async () => {
    await rm(app, { recursive: true });
    await expect(compactNextClientManifests(runtime)).rejects.toThrow();
  });

  it("is wired into desktop staging without relaxing main's existing release budgets", async () => {
    const builder = await readFile("scripts/build-desktop-runtime.mjs", "utf8");
    const workflow = await readFile(".github/workflows/build-desktop-installer.yml", "utf8");
    expect(builder).toContain("await compactNextClientManifests(outDir)");
    // Compaction must not relax the cap to make its own build pass. The cap moved
    // 646 -> 665 MiB on owner instruction (2026-10-24) for the merged 709-file batch.
    expect(workflow).toContain("if ($unpacked -gt 665MB)");
    expect(workflow).toContain("if ($exe.Length -gt 175MB)");
  });
});
