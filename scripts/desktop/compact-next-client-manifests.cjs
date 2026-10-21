const { readdir, readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { runInNewContext } = require("node:vm");
const { transform } = require("esbuild");

function manifestData(source, filename) {
  // Next's evalManifest also evaluates these generated scripts in a fresh VM
  // without require(). They are runtime data, NOT disposable trace metadata.
  const context = Object.create(null);
  runInNewContext(source, context, { filename, timeout: 1000 });
  const manifest = context.__RSC_MANIFEST;
  if (!manifest || typeof manifest !== "object" || Object.keys(manifest).length !== 1) {
    throw new Error(`Unexpected Next client-reference manifest: ${filename}`);
  }
  // Next emits this payload with JSON.stringify. Compare every route, mapping,
  // chunk, CSS path and flag after printing, not just the script's byte count.
  return JSON.stringify(manifest);
}

/**
 * Next emits a JSON-shaped JS manifest for every app page AND route handler.
 * Quoted property names/boolean literals are repeated across thousands of
 * entries, even though the JSON whitespace is already compact. Compact only
 * their JS representation when staging desktop resources. Never delete these
 * manifests (including API manifests: Next uses them for `use cache`), rename
 * identifiers, rewrite paths, or change the original standalone/web build.
 */
async function compactNextClientManifests(runtimeDirectory) {
  const appDirectory = path.join(path.resolve(runtimeDirectory), ".next", "server", "app");
  const report = { files: 0, bytesBefore: 0, bytesAfter: 0 };

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(filename);
      } else if (entry.isFile() && entry.name.endsWith("_client-reference-manifest.js")) {
        const original = await readFile(filename, "utf8");
        const expected = manifestData(original, filename);
        const printed = await transform(original, {
          loader: "js",
          target: "node24",
          minifyWhitespace: true,
          minifySyntax: true,
          minifyIdentifiers: false,
          legalComments: "inline",
          charset: "utf8",
        });
        if (printed.warnings.length || manifestData(printed.code, filename) !== expected) {
          throw new Error(`Next client-reference manifest changed during compaction: ${filename}`);
        }
        const before = Buffer.byteLength(original);
        const after = Buffer.byteLength(printed.code);
        // Already compact output should remain byte-identical, not grow.
        if (after < before) await writeFile(filename, printed.code);
        report.files += 1;
        report.bytesBefore += before;
        report.bytesAfter += Math.min(before, after);
      }
    }
  }

  // A missing app tree indicates an incomplete/wrong build. Fail packaging
  // rather than silently skip the optimization and conceal that problem.
  await walk(appDirectory);
  return report;
}

module.exports = { compactNextClientManifests };
