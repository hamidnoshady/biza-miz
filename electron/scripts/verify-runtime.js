"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { fileURLToPath } = require("node:url");

const root = path.resolve(__dirname, "..", "..");
const runtime = path.join(root, ".desktop-runtime");
const electronPackage = require(path.join(root, "electron", "package.json"));

function fail(message) {
  console.error(`desktop runtime verification failed: ${message}`);
  process.exitCode = 1;
}
function requirePath(relative) {
  if (!fs.existsSync(path.join(runtime, relative))) fail(`missing ${relative}`);
}

const compiledEntries = [
  "bin/server.cjs",
  "bin/migrate.cjs",
  "bin/derive-runtime-database-url.cjs",
];

for (const relative of [
  "package.json",
  "runtime-build.json",
  ...compiledEntries,
  ".next/BUILD_ID",
  ".next/required-server-files.json",
  ".next/static",
  "node_modules/next/headers.js",
  "node_modules/next/navigation.js",
  "node_modules/next/server.js",
  "public/sw.js",
  "public/offline.html",
  "public/windows/cafe-pos-print-connector.ps1",
  "migrations/0001_foundation.sql",
]) requirePath(relative);

const buildNodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
if (!Number.isInteger(buildNodeMajor) || buildNodeMajor < 24) {
  fail(`desktop runtime must be built and verified with supported Node.js 24+, found ${process.versions.node}`);
}
const pinnedElectron = electronPackage.devDependencies?.electron || "";
const electronMajor = Number.parseInt(pinnedElectron.split(".")[0], 10);
if (!/^\d+\.\d+\.\d+$/.test(pinnedElectron) || !Number.isInteger(electronMajor) || electronMajor < 44) {
  fail(`Electron must be exactly pinned to a supported 44+ release, found ${pinnedElectron || "missing"}`);
}

const runtimeRequire = createRequire(path.join(runtime, "package.json"));
const stagedNextRoot = path.join(runtime, "node_modules", "next");
for (const specifier of ["next/headers", "next/navigation", "next/server"]) {
  const resolved = runtimeRequire.resolve(specifier);
  const relativeToStagedNext = path.relative(stagedNextRoot, resolved);
  if (
    relativeToStagedNext === ".." ||
    relativeToStagedNext.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToStagedNext)
  ) {
    fail(`${specifier} escapes the staged Next package: ${resolved}`);
    continue;
  }
  try {
    runtimeRequire(specifier);
  } catch (error) {
    fail(`${specifier} cannot load from the staged runtime: ${error.message}`);
  }
}

const bundleDependencyUrl = "file:///C:/__desktop_bundle_dependency__.ts";
try {
  // This check runs on Windows in both desktop workflows, where a file URL
  // without a drive letter throws ERR_INVALID_FILE_URL_PATH before migrations.
  fileURLToPath(bundleDependencyUrl);
} catch (error) {
  fail(`compiled import.meta replacement is invalid on ${process.platform}: ${error.message}`);
}
for (const relative of compiledEntries) {
  const compiled = fs.readFileSync(path.join(runtime, relative), "utf8");
  if (!compiled.includes(bundleDependencyUrl)) {
    fail(`${relative} does not use the portable import.meta replacement`);
  }
  if (compiled.includes("file:///__desktop_bundle_dependency__.ts")) {
    fail(`${relative} still contains the Windows-invalid import.meta replacement`);
  }
}

const serverBundle = fs.readFileSync(path.join(runtime, "bin/server.cjs"), "utf8");
if (!serverBundle.includes("__NEXT_PRIVATE_STANDALONE_CONFIG")) {
  fail("compiled server does not install the traced standalone Next config");
}
const requiredServerFiles = JSON.parse(
  fs.readFileSync(path.join(runtime, ".next/required-server-files.json"), "utf8"),
);
if (requiredServerFiles.config?.output !== "standalone") {
  fail("required-server-files.json does not contain a standalone Next config");
}

for (const relative of ["scripts", "next.config.ts", "tsconfig.json", ".next/cache", "coverage", "test-results", ".git"]) {
  if (fs.existsSync(path.join(runtime, relative))) fail(`forbidden staged path ${relative}`);
}
for (const packageName of ["typescript", "tsx", "vitest", "tailwindcss", "@vitest", "@types", "playwright"]) {
  if (fs.existsSync(path.join(runtime, "node_modules", packageName))) fail(`development dependency ${packageName} is staged`);
}

if (JSON.stringify(electronPackage.build.electronLanguages) !== JSON.stringify(["en-US", "fa"])) {
  fail("Electron must package only the product's English and Persian Chromium locales");
}
const resources = electronPackage.build.extraResources || [];
if (resources.some((entry) => entry.from === "../node_modules" || entry.to === "app/node_modules")) {
  fail("electron-builder still bulk-copies root node_modules");
}
if (!resources.some((entry) => entry.from === "../.desktop-runtime" && entry.to === "desktop-runtime")) {
  fail("electron-builder does not package the positive runtime stage");
}
if (!resources.some((entry) =>
  entry.from === "../.desktop-runtime/node_modules" &&
  entry.to === "desktop-runtime/node_modules" &&
  Array.isArray(entry.filter) && entry.filter.includes("**/*")
)) {
  fail("electron-builder does not explicitly package the positive runtime dependency tree");
}
if (!resources.some((entry) => entry.from === "../.desktop-assets/postgresql-tools" && entry.to === "postgresql-tools")) {
  fail("electron-builder does not package the controlled PostgreSQL client-tools stage");
}
const pgToolsManifestPath = path.join(root, ".desktop-assets", "postgresql-tools", "provenance.json");
if (!fs.existsSync(pgToolsManifestPath)) {
  fail("PostgreSQL tools staging status is absent; run desktop:stage-pg-tools");
} else {
  const pgTools = JSON.parse(fs.readFileSync(pgToolsManifestPath, "utf8"));
  if (!["verified", "not-configured"].includes(pgTools.status)) fail("PostgreSQL tools staging status is invalid");
  if (process.env.REQUIRE_PACKAGED_PG_TOOLS === "1" && pgTools.status !== "verified") {
    fail("release packaging requires verified PostgreSQL client tools");
  }
}
const icon = path.resolve(root, "electron", electronPackage.build.win.icon);
if (!fs.existsSync(icon)) fail(`installer icon does not exist: ${icon}`);

// Issue #985: the packaged copy of embedded-postgres must carry the
// missing-callback patch. Without it, a quit in which the library's `exit`
// hook still runs rejects with "done is not a function"; packaging must fail
// here rather than ship that build again.
const embeddedPostgresEntry = path.join(root, "electron", "node_modules", "embedded-postgres", "dist", "index.js");
const { isPatched } = require(path.join(__dirname, "patch-embedded-postgres-exit-hook.js"));
if (!fs.existsSync(embeddedPostgresEntry)) {
  fail(`embedded-postgres is not installed at ${embeddedPostgresEntry}`);
} else if (!isPatched(fs.readFileSync(embeddedPostgresEntry, "utf8"))) {
  fail(
    "embedded-postgres still calls done() unconditionally (issue #985); run " +
      "electron/scripts/patch-embedded-postgres-exit-hook.js before packaging",
  );
}

const embeddedRoot = path.join(root, "electron", "node_modules", "@embedded-postgres");
const platformPackages = fs.existsSync(embeddedRoot)
  ? fs.readdirSync(embeddedRoot).filter((name) => fs.existsSync(path.join(embeddedRoot, name, "native")))
  : [];
if (process.platform === "win32") {
  if (JSON.stringify(platformPackages) !== JSON.stringify(["windows-x64"])) {
    fail(`expected exactly one Windows PostgreSQL payload, found: ${platformPackages.join(", ") || "none"}`);
  }
} else if (platformPackages.length !== 1) {
  fail(`expected one host PostgreSQL payload, found: ${platformPackages.join(", ") || "none"}`);
}

const manifest = JSON.parse(fs.readFileSync(path.join(runtime, "package.json"), "utf8"));
if (manifest.desktopRuntime?.format !== 1) fail("runtime manifest format is invalid");
if (manifest.engines?.node !== ">=24") {
  fail(`runtime manifest must require supported Node.js 24+, found ${manifest.engines?.node || "missing"}`);
}

if (!process.exitCode) console.log("Desktop runtime shape is valid.");
