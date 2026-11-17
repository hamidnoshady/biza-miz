import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { libraries, exclusions, verifySource, verifyPackaged } = require("../../electron/scripts/postgres-gui-libraries.js") as {
  libraries: string[];
  exclusions: string[];
  verifySource: (nativeRoot: string, patterns: string[]) => void;
  verifyPackaged: (resources: string) => void;
};
const manifest = JSON.parse(readFileSync(path.resolve("electron/package.json"), "utf8"));

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "pg-gui-"));
  const native = path.join(root, "native");
  const bin = path.join(native, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of [...libraries, "postgres.exe", "initdb.exe", "pg_ctl.exe"]) writeFileSync(path.join(bin, name), "binary");
  return { root, native, bin };
}

describe("Windows PostgreSQL desktop packaging", () => {
  it("keeps exact exclusions in the builder config and rejects changed or referenced libraries", () => {
    const { root, native, bin } = fixture();
    try {
      expect(exclusions.every((value) => manifest.build.files.includes(value))).toBe(true);
      expect(() => verifySource(native, manifest.build.files)).not.toThrow();
      expect(() => verifySource(native, manifest.build.files.filter((v: string) => v !== exclusions[0]))).toThrow("Missing PostgreSQL packaging exclusion");
      writeFileSync(path.join(bin, "pg_ctl.exe"), Buffer.from(libraries[0].toUpperCase(), "utf16le"));
      expect(() => verifySource(native, manifest.build.files)).toThrow("references excluded library");
      writeFileSync(path.join(bin, "pg_ctl.exe"), "binary");
      writeFileSync(path.join(bin, "wx_new.dll"), "binary");
      expect(() => verifySource(native, manifest.build.files)).toThrow("payload changed");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("checks the installed resources contain the real PostgreSQL binaries and no excluded GUI libraries", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pg-packaged-"));
    const bin = path.join(root, "app.asar.unpacked", "node_modules", "@embedded-postgres", "windows-x64", "native", "bin");
    try {
      mkdirSync(bin, { recursive: true });
      for (const name of ["postgres.exe", "initdb.exe", "pg_ctl.exe"]) writeFileSync(path.join(bin, name), "binary");
      expect(() => verifyPackaged(root)).not.toThrow();
      writeFileSync(path.join(bin, libraries[0]), "binary");
      expect(() => verifyPackaged(root)).toThrow("was packaged");
      rmSync(path.join(bin, libraries[0]));
      rmSync(path.join(bin, "postgres.exe"));
      expect(() => verifyPackaged(root)).toThrow("binary missing");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
