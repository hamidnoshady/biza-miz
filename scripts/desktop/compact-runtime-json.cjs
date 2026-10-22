const { readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");

// Next's conservative trace includes this 4.1 MiB, pretty-printed font table.
// Keep the entire table and its require() path: only packaging whitespace is
// redundant. Do NOT recursively rewrite runtime JSON (application data, signed
// documents, provenance, etc.) or change the installed-payload budget.
const RUNTIME_JSON_ASSETS = [
  "node_modules/next/dist/server/capsize-font-metrics.json",
];

/** Remove JSON whitespace without reserializing numbers or string escapes. */
function compactJson(source) {
  JSON.parse(source); // Fail the build on malformed input; never emit a repair.
  let quoted = false;
  let escaped = false;
  const output = [];
  for (const character of source) {
    if (quoted) {
      output.push(character);
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') {
      quoted = true;
      output.push(character);
    } else if (!" \t\r\n".includes(character)) {
      output.push(character);
    }
  }
  return output.join("");
}

async function compactRuntimeJson(runtimeDirectory) {
  let files = 0;
  let bytesSaved = 0;
  for (const relative of RUNTIME_JSON_ASSETS) {
    const file = path.join(runtimeDirectory, relative);
    let source;
    try {
      source = await readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const compact = compactJson(source);
    const saved = Buffer.byteLength(source) - Buffer.byteLength(compact);
    if (saved > 0) {
      await writeFile(file, compact);
      files += 1;
      bytesSaved += saved;
    }
  }
  return { files, bytesSaved };
}

module.exports = { compactJson, compactRuntimeJson };
