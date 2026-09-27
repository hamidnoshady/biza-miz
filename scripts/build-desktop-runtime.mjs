#!/usr/bin/env node
/**
 * Builds the positively selected runtime consumed by the Electron installer.
 *
 * The old installer copied the repository's entire root node_modules, raw src,
 * TypeScript scripts and build cache. This builder starts from Next's traced
 * standalone server and adds only the custom WebSocket/background server,
 * compiled provisioning helpers, migrations and public assets.
 */
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextDir = path.join(root, ".next");
const standaloneDir = path.join(nextDir, "standalone");
const outDir = path.join(root, ".desktop-runtime");
const require = createRequire(import.meta.url);
const { nodeFileTrace } = require("next/dist/compiled/@vercel/nft");

function required(relativePath, explanation) {
  const absolute = path.join(root, relativePath);
  if (!existsSync(absolute)) {
    throw new Error(`${relativePath} is missing (${explanation})`);
  }
  return absolute;
}

async function directoryBytes(directory) {
  let total = 0;
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(full);
    else if (entry.isFile()) total += (await stat(full)).size;
  }
  return total;
}

async function compile(entryPoint, outfile, extraDefine = {}) {
  return build({
    absWorkingDir: root,
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    sourcemap: false,
    legalComments: "none",
    // Imported CLI modules contain direct-execution guards. In CJS output an
    // unbound import.meta.url becomes undefined and fileURLToPath throws before
    // our compiled entry can call main(). A stable non-entry URL keeps every
    // imported guard false without retaining a TypeScript loader. It includes a
    // drive letter because Node's Windows fileURLToPath rejects POSIX-only
    // file:/// paths; POSIX accepts this as /C:/..., so one value is portable.
    define: {
      "import.meta.url": JSON.stringify("file:///C:/__desktop_bundle_dependency__.ts"),
      ...extraDefine,
    },
    metafile: true,
    // `playwright-core` joins the other unbundleable natives: its prebuilt
    // `coreBundle.js` requires `chromium-bidi` subpaths that are not installed
    // (they ship inside the browser driver, not the npm tree), so esbuild
    // cannot resolve them and fails the whole build. It is reachable from the
    // custom server through the PDF export path, and Next's standalone trace
    // already stages the real package into the runtime's node_modules — so
    // leaving the require unbundled resolves correctly at run time, which is
    // exactly how the reports PDF route has always used it.
    external: [
      "next",
      "next/*",
      "pg-native",
      "bufferutil",
      "utf-8-validate",
      "playwright-core",
    ],
    logLevel: "warning",
    logOverride: { "empty-import-meta": "silent" },
  });
}

async function stageExternalNextEntrypoints(serverBundlePath) {
  const bundle = await readFile(serverBundlePath, "utf8");
  const specifiers = [
    ...new Set(
      [...bundle.matchAll(/require\(["'](next\/[A-Za-z0-9._/-]+)["']\)/g)].map((match) => match[1]),
    ),
  ].sort();
  if (specifiers.length === 0) return;

  // These package subpaths originate in the separately bundled custom server,
  // so Next's standalone trace does not always include their package-root
  // shims and transitive targets. A development checkout masks the omission by
  // falling through to its parent node_modules; packaged resources cannot.
  // Trace only the concrete external subpaths emitted by esbuild, then overlay
  // their positively selected Next files on the standalone runtime.
  const traceEntry = path.join(outDir, "bin", ".next-runtime-entry.cjs");
  await writeFile(traceEntry, `${specifiers.map((specifier) => `require(${JSON.stringify(specifier)});`).join("\n")}\n`);
  try {
    const trace = await nodeFileTrace([path.relative(root, traceEntry)], {
      base: root,
      processCwd: root,
      mixedModules: true,
    });
    if (trace.warnings.size > 0) {
      throw new Error(`Next runtime entry trace warnings: ${[...trace.warnings].map(String).join("; ")}`);
    }
    for (const tracedPath of trace.fileList) {
      // @vercel/nft returns native separators, so Windows traces use `\\`.
      // Normalize before applying the allowlist and joining the staged path.
      const relative = tracedPath.replace(/\\/g, "/");
      if (!relative.startsWith("node_modules/next/")) continue;
      const destination = path.join(outDir, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(root, relative), destination);
    }
  } finally {
    await rm(traceEntry, { force: true });
  }
}

async function main() {
  required(".next/BUILD_ID", "run npm run build first");
  required(".next/standalone", "next.config.ts must keep output: standalone");
  required(".next/static", "production client assets were not built");
  required("public/windows/cafe-pos-print-connector.ps1", "the Windows print connector is a shipped capability");
  required("public/favicon.ico", "the canonical Windows installer icon is generated from public/icon.svg");

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // Next's node-file-traced server dependency graph. This contains only the
  // runtime node_modules files reached by production routes, not root deps.
  await cp(standaloneDir, outDir, { recursive: true });
  await mkdir(path.join(outDir, ".next"), { recursive: true });
  await cp(path.join(nextDir, "static"), path.join(outDir, ".next", "static"), { recursive: true });
  await cp(path.join(root, "public"), path.join(outDir, "public"), { recursive: true });
  await cp(path.join(root, "migrations"), path.join(outDir, "migrations"), { recursive: true });

  // Next's conservative package-level trace reaches its optional TypeScript
  // config loader even though this staged runtime has no TS config or source.
  // Remove only top-level development packages; never use recursive globs that
  // could strip next/dist/lib/typescript or another nested production file.
  for (const packagePath of [
    "node_modules/typescript",
    "node_modules/tsx",
    "node_modules/vitest",
    "node_modules/@vitest",
    "node_modules/@types",
    "node_modules/tailwindcss",
    "node_modules/@tailwindcss",
  ]) {
    await rm(path.join(outDir, packagePath), { recursive: true, force: true });
  }

  // Never inherit a cache from standalone output if Next starts tracing one in
  // a future release. Static/server output is retained; only rebuildable cache
  // is forbidden.
  await rm(path.join(outDir, ".next", "cache"), { recursive: true, force: true });

  const binDir = path.join(outDir, "bin");
  await mkdir(binDir, { recursive: true });
  const serverBundlePath = path.join(binDir, "server.cjs");
  const [serverBuild, migrateBuild, deriveBuild] = await Promise.all([
    compile("server.ts", serverBundlePath, {
      "process.env.DEPLOYMENT_ROLE": JSON.stringify("site"),
    }),
    compile("scripts/desktop/migrate-entry.ts", path.join(binDir, "migrate.cjs")),
    compile(
      "scripts/desktop/derive-runtime-database-url-entry.ts",
      path.join(binDir, "derive-runtime-database-url.cjs"),
    ),
  ]);
  await stageExternalNextEntrypoints(serverBundlePath);

  const sourcePackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const manifest = {
    name: "business-suite-desktop-runtime",
    private: true,
    version: sourcePackage.version,
    engines: { node: ">=24" },
    desktopRuntime: {
      format: 1,
      server: "bin/server.cjs",
      migrate: "bin/migrate.cjs",
      deriveDatabaseUrl: "bin/derive-runtime-database-url.cjs",
      nextBuildId: (await readFile(path.join(nextDir, "BUILD_ID"), "utf8")).trim(),
    },
  };
  await writeFile(path.join(outDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const forbidden = [
    "scripts",
    "tsconfig.json",
    "next.config.ts",
    ".next/cache",
    "coverage",
    "test-results",
    "playwright-report",
    ".git",
  ];
  for (const relative of forbidden) {
    if (existsSync(path.join(outDir, relative))) {
      throw new Error(`forbidden desktop runtime path was staged: ${relative}`);
    }
  }

  if (existsSync(path.join(outDir, "src"))) {
    const { readdir } = await import("node:fs/promises");
    const sourceFiles = [];
    async function collectSource(current) {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) await collectSource(absolute);
        else sourceFiles.push(path.relative(outDir, absolute).replace(/\\/g, "/"));
      }
    }
    await collectSource(path.join(outDir, "src"));
    const unexpected = sourceFiles.filter((file) => {
      if (file.startsWith("src/lib/billing/entitlement/")) return false;
      if (file.startsWith("src/app/fonts/") && /\.(woff2?|ttf|otf)$/i.test(file)) return false;
      return true;
    });
    if (unexpected.length) throw new Error(`unexpected raw source was traced: ${unexpected.join(", ")}`);
  }

  for (const packageName of ["typescript", "tsx", "vitest", "tailwindcss", "@vitest", "@types"]) {
    if (existsSync(path.join(outDir, "node_modules", packageName))) {
      throw new Error(`development-only package leaked into desktop runtime: ${packageName}`);
    }
  }

  const runtimeBytes = await directoryBytes(outDir);
  const report = {
    generatedAt: new Date().toISOString(),
    bytes: runtimeBytes,
    mebibytes: Number((runtimeBytes / 1024 / 1024).toFixed(1)),
    inputs: {
      serverBundleFiles: Object.keys(serverBuild.metafile.inputs).length,
      migrateBundleFiles: Object.keys(migrateBuild.metafile.inputs).length,
      deriveBundleFiles: Object.keys(deriveBuild.metafile.inputs).length,
    },
  };
  await writeFile(path.join(outDir, "runtime-build.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Desktop runtime staged at ${path.relative(root, outDir)} (${report.mebibytes} MiB)`);
}

main().catch((error) => {
  console.error(`desktop runtime build failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
