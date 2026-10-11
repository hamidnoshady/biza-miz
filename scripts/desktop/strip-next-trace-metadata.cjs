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

module.exports = { stripNextTraceMetadata };
