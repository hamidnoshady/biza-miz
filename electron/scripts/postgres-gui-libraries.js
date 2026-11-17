"use strict";

// The pinned Windows PostgreSQL package includes wxWidgets GUI libraries, but
// ships no GUI executables. Keep this exact list reviewed: a dependency update
// must not silently add another library to the packaging exclusion.
const fs = require("node:fs");
const path = require("node:path");
const libraries = [
  "wxbase3210u_net_vc_x64_custom.dll",
  "wxbase3210u_vc_x64_custom.dll",
  "wxbase3210u_xml_vc_x64_custom.dll",
  "wxmsw3210u_adv_vc_x64_custom.dll",
  "wxmsw3210u_aui_vc_x64_custom.dll",
  "wxmsw3210u_core_vc_x64_custom.dll",
  "wxmsw3210u_html_vc_x64_custom.dll",
  "wxmsw3210u_xrc_vc_x64_custom.dll",
];
const prefix = "node_modules/@embedded-postgres/windows-x64/native/bin/";
const exclusions = libraries.map((name) => `!${prefix}${name}`);

function verifySource(nativeRoot, patterns) {
  for (const exclusion of exclusions) {
    if (!patterns.includes(exclusion)) throw new Error(`Missing PostgreSQL packaging exclusion: ${exclusion}`);
  }
  const bin = path.join(nativeRoot, "bin");
  const found = fs.readdirSync(bin).filter((name) => /^wx.*\.dll$/i.test(name)).sort();
  if (JSON.stringify(found) !== JSON.stringify([...libraries].sort())) {
    throw new Error("Windows PostgreSQL wxWidgets payload changed; review the packaging exclusion");
  }
  for (const required of ["postgres.exe", "initdb.exe", "pg_ctl.exe"]) {
    if (!fs.existsSync(path.join(bin, required))) throw new Error(`Windows PostgreSQL binary missing: ${required}`);
  }
  const scan = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { scan(file); continue; }
      if (!entry.isFile() || !/\.(dll|exe)$/i.test(entry.name) || (directory === bin && libraries.includes(entry.name))) continue;
      // Imports and LoadLibrary strings are normally ASCII; check UTF-16 too.
      // Fail closed even on a non-import string so an upstream change is reviewed.
      const contents = fs.readFileSync(file).toString("latin1").toLowerCase();
      for (const name of libraries) {
        if (contents.includes(name) || contents.includes(Buffer.from(name, "utf16le").toString("latin1"))) {
          throw new Error(`${file} references excluded library ${name}`);
        }
      }
    }
  };
  scan(nativeRoot);
}

function verifyPackaged(resourcesDir) {
  const bin = path.join(resourcesDir, "app.asar.unpacked", "node_modules", "@embedded-postgres", "windows-x64", "native", "bin");
  for (const required of ["postgres.exe", "initdb.exe", "pg_ctl.exe"]) {
    if (!fs.existsSync(path.join(bin, required))) throw new Error(`Packaged PostgreSQL binary missing: ${required}`);
  }
  for (const name of libraries) {
    if (fs.existsSync(path.join(bin, name))) throw new Error(`Excluded PostgreSQL GUI library was packaged: ${name}`);
  }
}

module.exports = { libraries, exclusions, verifySource, verifyPackaged };
