const { readdir, rm } = require("node:fs/promises");
const path = require("node:path");

async function removeTraceFiles(directory) {
  let removed = 0;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return removed;
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      removed += await removeTraceFiles(entryPath);
    } else if (entry.isFile() && entry.name.endsWith(".nft.json")) {
      await rm(entryPath);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Drop only Next's build-time output-file-tracing manifests from a staged
 * standalone runtime. Next's server never reads these manifests at runtime;
 * their dependency lists have already been used to populate standalone's
 * node_modules. Keep runtime manifests and all traced dependencies intact.
 *
 * @param {string} runtimeDirectory
 * @returns {Promise<number>} the number of removed trace manifests
 */
async function stripNextTraceMetadata(runtimeDirectory) {
  const runtime = path.resolve(runtimeDirectory);
  const removedFromNextOutput = await removeTraceFiles(path.join(runtime, ".next"));
  const standaloneServerTrace = path.join(runtime, "server.js.nft.json");
  let removedServerTrace = 0;
  try {
    await rm(standaloneServerTrace);
    removedServerTrace = 1;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  return removedFromNextOutput + removedServerTrace;
}

const NON_RUNTIME_NODE_MODULE_DIRS = [
  path.join("node_modules", "next", "dist", "compiled", "amphtml-validator"),
  path.join("node_modules", "caniuse-lite"),
];

function isNonRuntimeNodeModuleArtifact(fileName) {
  return (
    fileName.endsWith(".js.map") ||
    fileName.endsWith(".cjs.map") ||
    fileName.endsWith(".mjs.map") ||
    fileName.endsWith(".d.ts.map") ||
    fileName.endsWith(".d.ts") ||
    fileName.endsWith(".d.mts") ||
    fileName.endsWith(".d.cts")
  );
}

/**
 * Strip non-runtime debug source maps (`.js.map` / `.cjs.map` / `.mjs.map`),
 * TypeScript declarations (`.d.ts*`), and build/Pages-only Next artifacts
 * (`amphtml-validator`, `caniuse-lite`) from staged `node_modules` without
 * touching any runtime `.js`, `.cjs`, `.mjs`, `.json`, `.wasm`, or native binaries.
 *
 * @param {string} runtimeDirectory
 * @returns {Promise<number>} count of removed non-runtime artifacts
 */
async function stripRuntimeNodeModulesDeadWeight(runtimeDirectory) {
  const runtime = path.resolve(runtimeDirectory);
  let removed = 0;

  for (const relDir of NON_RUNTIME_NODE_MODULE_DIRS) {
    const target = path.join(runtime, relDir);
    await rm(target, { recursive: true, force: true });
  }

  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && isNonRuntimeNodeModuleArtifact(entry.name)) {
        await rm(entryPath, { force: true });
        removed += 1;
      }
    }
  }

  await walk(path.join(runtime, "node_modules"));
  return removed;
}

module.exports = { stripNextTraceMetadata, stripRuntimeNodeModulesDeadWeight };
