#!/usr/bin/env tsx
/**
 * Issue #984 — builds a companion update-channel directory from a published
 * EXE. Hashes are machine-computed from the exact bytes served, never
 * hand-written; the manifest file IS the signed bytes (canonical JSON);
 * the copy served is re-hashed after copying.
 *
 *   npx tsx scripts/build-companion-update.mts \
 *     --exe companion-release/BizaSupportCompanion.exe \
 *     --version 1.2.0 --channel companion-stable --kid release-1 \
 *     --out update-channel/
 *
 * Signing: the release RSA key is the SAME key as the #981 desktop
 * channel. By default it is read from DESKTOP_RELEASE_PRIVATE_KEY_PEM
 * (`--key-env` overrides the variable name). Without a key the channel
 * is built UNSIGNED (manifest + file, no .sig) and the script says so
 * loudly — the companion refuses unsigned channels, so this output is
 * only useful as the exact bytes to sign later, never to serve.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  buildUpdateManifest,
  signUpdateManifest,
  verifyUpdateManifest,
} from "../src/lib/support-companion/update-channel";

function usage(): never {
  console.error(
    "Usage: build-companion-update.mts --exe <path> --version <1.2.0> --channel <name> --kid <id> --out <dir> [--key-env NAME]",
  );
  process.exit(2);
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1];
}

const exePath = arg("exe");
const version = arg("version");
const channel = arg("channel");
const kid = arg("kid");
const outDir = arg("out");
if (!exePath || !version || !channel || !kid || !outDir) usage();

try {
  await buildChannel(exePath, version, channel, kid, outDir);
} catch (err) {
  console.error(`Channel build refused: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

async function buildChannel(
  exePath: string,
  version: string,
  channel: string,
  kid: string,
  outDir: string,
): Promise<void> {

const keyEnv = arg("key-env") ?? "DESKTOP_RELEASE_PRIVATE_KEY_PEM";

const exeStat = await stat(exePath);
if (!exeStat.isFile()) {
  console.error(`Not a file: ${exePath}`);
  process.exit(1);
}
const exeBytes = await readFile(exePath);
const sha256 = createHash("sha256").update(exeBytes).digest("hex");

const { canonical } = buildUpdateManifest({
  channel,
  version,
  kid,
  files: [{ path: basename(exePath), bytes: exeStat.size, sha256 }],
});

await mkdir(outDir, { recursive: true });
// Serve the copy, and prove the copy is what the manifest hashes.
await copyFile(exePath, join(outDir, basename(exePath)));
const servedHash = createHash("sha256").update(await readFile(join(outDir, basename(exePath)))).digest("hex");
if (servedHash !== sha256) {
  console.error("Served copy does not match the hashed bytes — refusing to publish.");
  process.exit(1);
}
await writeFile(join(outDir, `${channel}.json`), `${canonical}\n`);

const privatePem = process.env[keyEnv]?.replaceAll("\\n", "\n").trim() || "";
if (!privatePem) {
  console.log(`Built UNSIGNED channel '${channel}' v${version} in ${outDir}/`);
  console.log(`  ${channel}.json + ${basename(exePath)} (${exeStat.size} bytes, sha256 ${sha256.slice(0, 16)}…)`);
  console.log("  NO .sig was written: set the release key and re-run to sign.");
  console.log("  The companion refuses unsigned channels — do not serve this output.");
  process.exit(0);
}

const signature = signUpdateManifest(canonical, privatePem);
await writeFile(join(outDir, `${channel}.json.sig`), `${signature}\n`);
// Belt and braces: the .sig file on disk verifies against the manifest on disk.
const { createPublicKey } = await import("node:crypto");
const onDiskManifest = (await readFile(join(outDir, `${channel}.json`), "utf8")).trim();
const onDiskSig = (await readFile(join(outDir, `${channel}.json.sig`), "utf8")).trim();
const publicPem = createPublicKey(privatePem).export({ type: "spki", format: "pem" }).toString();
if (!verifyUpdateManifest(onDiskManifest, onDiskSig, publicPem)) {
  console.error("On-disk channel does not self-verify — refusing to publish.");
  process.exit(1);
}
  console.log(`Built SIGNED channel '${channel}' v${version} in ${outDir}/`);
  console.log(`  ${channel}.json + ${channel}.json.sig + ${basename(exePath)} (${exeStat.size} bytes)`);
}
