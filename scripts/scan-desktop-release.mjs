#!/usr/bin/env node
/**
 * Issue #1194 — release gate over the *packaged Windows payload*, not the
 * source tree.
 *
 * `electron/package.json`'s `build.files`, the staged runtime and the compiled
 * Next output are all positive selections; each of them can regress by a
 * single added line (a file re-added to `files`, a trace that pulls a
 * platform chunk back in). This script reads what electron-builder actually
 * produced and fails when a shipped byte still grants what the issue is
 * about:
 *
 *   - a test-only owner bootstrap / mock cloud activation path
 *     (`DESKTOP_SMOKE_*`, `smoke-probe`, `Packaged-Test-Password`, …),
 *   - Central Superadmin route modules (`app/platform`, `app/api/platform`)
 *     or credential seed tooling,
 *   - private signing material, private-key containers and `.env` files,
 *   - test/source/repository files that should never be packed.
 *
 * It understands an electron-builder `win-unpacked` tree (recursively, with
 * the ASAR archive read from its real header rather than naively grepped, so
 * `app.asar` entry names are checked too) and can extract the **signed NSIS
 * installer** with 7-Zip and scan that, which is the closest reproducible
 * equivalent to "scan the bytes the customer receives" without executing
 * them. Findings contain the rule id and path only; no matched context and no
 * secret values are ever printed to a public CI log.
 *
 * Usage (CI):
 *   node scripts/scan-desktop-release.mjs \
 *     --payload=electron/dist/win-unpacked \
 *     --installer="electron/dist/Bizamiz Setup 1.0.149.exe" \
 *     --output=desktop-release-scan.json
 *
 * Exit code: 0 when clean, 1 on any finding or shape failure, 2 on a usage
 * error. `--require-installer-extraction` turns "7-Zip not available" into a
 * failure for release jobs that must prove the signed artifact was inspected.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { FORBIDDEN_PATH_RULES, FORBIDDEN_TEXT_MARKERS, TEXT_RULES, scanPath, scanTextBuffer } = require("./desktop/release-scan-rules.cjs");

const SCAN_PROTOCOL = "biza_desktop_release_scan_v1";
/** Chunk size for streaming scans; the overlap covers a marker split across two reads. */
const CHUNK_BYTES = 4 * 1024 * 1024;
const OVERLAP_BYTES = 256;
/** Zip/7z archives inside an extracted installer (electron-builder nests app-64.7z). */
const NESTED_ARCHIVE = /\.(?:7z|zip)$/i;

function fail(message) {
  console.error(`desktop release scan failed: ${message}`);
  process.exit(1);
}

function usage(message) {
  console.error(`desktop release scan: ${message}`);
  console.error(
    "usage: node scripts/scan-desktop-release.mjs [--payload=<win-unpacked dir>] [--installer=<setup.exe>] " +
      "[--output=<report.json>] [--require-installer-extraction]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { payload: null, installer: null, output: "desktop-release-scan.json", requireInstallerExtraction: false };
  for (const raw of argv) {
    if (raw === "--require-installer-extraction") options.requireInstallerExtraction = true;
    else if (raw.startsWith("--payload=")) options.payload = raw.slice("--payload=".length);
    else if (raw.startsWith("--installer=")) options.installer = raw.slice("--installer=".length);
    else if (raw.startsWith("--output=")) options.output = raw.slice("--output=".length);
    else if (raw === "--help" || raw === "-h") usage("help");
    else usage(`unknown argument ${raw}`);
  }
  return options;
}

/* ------------------------------------------------------------------------- *
 * ASAR
 *
 * electron-builder packs the Electron main process into `resources/app.asar`.
 * The format is a Chromium pickle: `uint32 4`, `uint32 headerSize`, then the
 * header pickle (`uint32 jsonLength`, JSON, padding to 4 bytes) followed by
 * the concatenated file data. Reading the header is what lets this gate judge
 * entry *names* (`/smoke-probe.js`) and file *contents* without unpacking or
 * trusting `asar list` to be installed on the runner.
 * ------------------------------------------------------------------------- */

/** Parse an asar header from the first bytes of an archive. Pure, for tests. */
export function readAsarHeader(buffer) {
  if (buffer.length < 12) throw new Error("asar header truncated");
  const headerSize = buffer.readUInt32LE(4);
  const jsonLength = buffer.readUInt32LE(8);
  if (jsonLength <= 0 || 12 + jsonLength > buffer.length) throw new Error("asar header length is invalid");
  const json = JSON.parse(buffer.subarray(12, 12 + jsonLength).toString("utf8"));
  let dataOffset = 12 + jsonLength;
  while (dataOffset % 4 !== 0) dataOffset += 1;
  if (headerSize < jsonLength + 4) throw new Error("asar header size does not cover its JSON");
  return { header: json, dataOffset };
}

/** Flatten an asar header tree into `{ path, size, offset, unpacked }` entries. */
export function asarEntries(header, prefix = "") {
  const entries = [];
  for (const [name, value] of Object.entries(header?.files ?? {})) {
    const entryPath = prefix ? `${prefix}/${name}` : name;
    if (value?.files) {
      entries.push(...asarEntries(value, entryPath));
    } else {
      entries.push({
        path: entryPath,
        size: Number(value?.size) || 0,
        offset: value?.offset === undefined ? null : Number(value.offset),
        unpacked: value?.unpacked === true,
      });
    }
  }
  return entries;
}

/** Every regular file below `directory`, as absolute paths. */
export function walkFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

/** Stream a file through the text rules without loading it whole. */
async function scanFileStream(absolute, payloadPath) {
  // One finding per rule per file: a marker repeated in a bundle is the same
  // regression, and a public CI log should not list it a thousand times.
  const findings = new Map();
  let tail = Buffer.alloc(0);
  const stream = createReadStream(absolute, { highWaterMark: CHUNK_BYTES });
  for await (const chunk of stream) {
    const block = tail.length ? Buffer.concat([tail, chunk]) : chunk;
    for (const finding of scanTextBuffer(block, payloadPath)) {
      if (!findings.has(finding.id)) findings.set(finding.id, finding);
    }
    if (findings.size === TEXT_RULES.length) break;
    tail = block.subarray(Math.max(0, block.length - OVERLAP_BYTES));
  }
  return [...findings.values()];
}

/**
 * Scan one payload root (a win-unpacked tree or an extracted installer).
 * `label` distinguishes "packaged-payload" from "signed-installer" in the
 * report; `skip` names absolute directories to leave out (the ASAR is read
 * separately, and the installer file itself is not part of the tree).
 */
export async function scanPayload(root, { label = "payload", skip = [] } = {}) {
  const findings = [];
  const inventory = { files: 0, bytes: 0, asar: [], skipped: [] };
  const skipSet = new Set(skip.map((entry) => path.resolve(entry)));

  const files = walkFiles(root);
  for (const absolute of files) {
    if (skipSet.has(path.resolve(absolute))) {
      inventory.skipped.push({ reason: "handled-separately", path: path.relative(root, absolute).replace(/\\/g, "/") });
      continue;
    }
    const relative = path.relative(root, absolute).replace(/\\/g, "/");
    const stats = statSync(absolute);
    inventory.files += 1;
    inventory.bytes += stats.size;
    findings.push(...scanPath(relative));

    if (path.basename(absolute) === "app.asar") {
      try {
        findings.push(...(await scanAsar(absolute, relative, inventory)));
      } catch (error) {
        // An unreadable archive fails the gate: "we could not inspect the
        // packaged main process" is not a pass.
        findings.push({
          id: "asar-unreadable",
          path: relative,
          description: `app.asar could not be read with its header: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      continue;
    }
    findings.push(...(await scanFileStream(absolute, `${label}:${relative}`)));
  }

  const shape = checkRequiredShape(root);
  return { label, root, inventory, shape, findings };
}

/** Read `app.asar` with its real header, scanning packed entry names and bytes. */
export async function scanAsar(absolute, relative, inventory) {
  const findings = [];
  const buffer = readFileSync(absolute);
  const { header, dataOffset } = readAsarHeader(buffer);
  const entries = asarEntries(header);
  inventory.asar.push({ path: relative, entries: entries.length, bytes: buffer.length });
  for (const entry of entries) {
    findings.push(...scanPath(entry.path));
    if (entry.unpacked || entry.offset === null) continue;
    const start = dataOffset + entry.offset;
    const end = Math.min(buffer.length, start + entry.size);
    findings.push(...scanTextBuffer(buffer.subarray(start, end), `${relative}:${entry.path}`));
  }
  return findings;
}

/**
 * Shapes a shipping desktop payload must contain. Absence means the build is
 * not what later acceptance steps believe it is; presence of `app.asar` is
 * also what makes the ASAR scan above meaningful.
 */
export function checkRequiredShape(root) {
  const required = [
    "resources/app.asar",
    "resources/desktop-runtime/bin/server.cjs",
    "resources/desktop-runtime/.next/BUILD_ID",
  ];
  const missing = required.filter((relative) => !existsSync(path.join(root, ...relative.split("/"))));
  return { ok: missing.length === 0, missing };
}

function sevenZipCommand() {
  if (process.env.SEVEN_ZIP) return process.env.SEVEN_ZIP;
  for (const candidate of ["7z", "7za", "7z.exe", "C:\\Program Files\\7-Zip\\7z.exe"]) {
    const result = spawnSync(candidate, ["i"], { stdio: "ignore", windowsHide: true });
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}

function extractArchive(command, archive, destination) {
  const result = spawnSync(command, ["x", archive, `-o${destination}`, "-y"], {
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return { ok: result.status === 0, status: result.status, stderr: (result.stderr || "").slice(-2_000) };
}

/**
 * Extract the signed installer and scan the tree it would install.
 *
 * electron-builder's NSIS package is itself a 7-Zip archive containing
 * `app-64.7z`; one nested pass covers it. Every command is bounded, and the
 * temporary tree is removed afterwards.
 */
export async function scanInstaller(installerPath) {
  const absolute = path.resolve(installerPath);
  if (!existsSync(absolute)) throw new Error(`installer is missing: ${absolute}`);
  const buffer = readFileSync(absolute);
  const summary = {
    path: absolute,
    bytes: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    extraction: { attempted: false, ok: false, nested: 0, note: null },
  };
  const command = sevenZipCommand();
  if (!command) {
    summary.extraction.note = "7-Zip is not available on this runner; the installer was hashed but not extracted.";
    return { summary, findings: [], scanned: null };
  }

  const workRoot = mkdtempSync(path.join(tmpdir(), "biza-release-scan-"));
  try {
    summary.extraction.attempted = true;
    const outer = path.join(workRoot, "installer");
    const first = extractArchive(command, absolute, outer);
    if (!first.ok) throw new Error(`7-Zip could not extract the installer (exit ${first.status}): ${first.stderr}`);
    // Nested archives: electron-builder stores the application payload as app-64.7z.
    const nested = [];
    for (const file of walkFiles(outer)) {
      if (!NESTED_ARCHIVE.test(file)) continue;
      const destination = path.join(workRoot, `nested-${nested.length}`);
      const result = extractArchive(command, file, destination);
      if (!result.ok) throw new Error(`7-Zip could not extract ${path.basename(file)} (exit ${result.status})`);
      nested.push(destination);
    }
    summary.extraction.nested = nested.length;
    summary.extraction.ok = true;

    const findings = [];
    const scanned = [];
    for (const directory of [outer, ...nested]) {
      const result = await scanPayload(directory, { label: "signed-installer" });
      findings.push(...result.findings);
      scanned.push({ root: result.root.replace(workRoot, "<extracted>"), ...result.inventory });
    }
    summary.extraction.note = `Scanned ${scanned.length} extracted tree(s).`;
    // The installed payload is the nested app archive; a payload with no
    // app.asar means the extraction did not reach it and the scan proved
    // nothing about the application bytes.
    if (!scanned.some((tree) => tree.asar.length > 0)) {
      throw new Error("no app.asar was found in the extracted installer, so the application payload was not scanned");
    }
    return { summary, findings, scanned };
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

function dedupe(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.id}|${finding.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function runScan({ payload = null, installer = null, requireInstallerExtraction = false }) {
  if (!payload && !installer) throw new Error("at least one of --payload or --installer is required");
  if (payload && !existsSync(payload)) throw new Error(`payload does not exist: ${payload}`);
  if (!payload && !installer) throw new Error("nothing to scan");

  const findings = [];
  const report = {
    protocol: SCAN_PROTOCOL,
    generatedAt: new Date().toISOString(),
    payload: null,
    installer: null,
    rules: {
      text: FORBIDDEN_TEXT_MARKERS.map((rule) => rule.id),
      paths: FORBIDDEN_PATH_RULES.map((rule) => rule.id),
    },
    findings: [],
    ok: false,
  };

  if (payload) {
    const payloadResult = await scanPayload(payload, { label: "packaged-payload" });
    findings.push(...payloadResult.findings);
    report.payload = {
      root: path.resolve(payload),
      ...payloadResult.inventory,
      shape: payloadResult.shape,
    };
  }

  if (installer) {
    const result = await scanInstaller(installer);
    report.installer = result.summary;
    findings.push(...result.findings);
    if (!result.summary.extraction.ok && requireInstallerExtraction) {
      throw new Error(
        `the signed installer could not be extracted for scanning: ${result.summary.extraction.note || "unknown reason"}`,
      );
    }
    if (!result.summary.extraction.ok) {
      console.warn(
        "::warning title=Desktop release scan::The signed installer was hashed but not extracted; " +
          "install a 7-Zip runner step (or set SEVEN_ZIP) and pass --require-installer-extraction to make this a hard gate.",
      );
    }
  }

  report.findings = dedupe(findings);
  if (report.payload && !report.payload.shape.ok) {
    report.findings.push({
      id: "payload-shape",
      path: report.payload.root,
      description: `Required packaged files are missing: ${report.payload.shape.missing.join(", ")}`,
    });
  }
  report.ok = report.findings.length === 0;
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.payload && !options.installer) usage("--payload or --installer is required");
  let report;
  try {
    report = await runScan(options);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  console.log(
    (report.payload
      ? `Scanned packaged payload: ${report.payload.files} file(s), ${mib(report.payload.bytes)}`
      : "Scanned the signed installer only (no unpacked payload was supplied)") +
      (report.installer ? `; installer sha256 ${report.installer.sha256}` : ""),
  );
  if (report.findings.length) {
    for (const finding of report.findings) {
      console.error(`::error title=Desktop release scan::${finding.id} at ${finding.path} — ${finding.description}`);
      console.error(`  ${finding.id}: ${finding.path}`);
    }
    console.error(`Desktop release scan FAILED with ${report.findings.length} finding(s). Report: ${options.output}`);
    process.exit(1);
  }
  console.log(`Desktop release scan passed. Report: ${options.output}`);
}

// Importable for the unit test without executing the gate.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
