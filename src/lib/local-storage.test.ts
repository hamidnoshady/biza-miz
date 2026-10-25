/**
 * electron/local-storage.js — first-run local storage folder checks (Section
 * 3 of the desktop audit): disk-space check, permission check, and a real
 * write/read/delete round trip for a candidate data folder, before the
 * desktop app commits Postgres/attachments/backups to it.
 *
 * Real filesystem operations run against a throwaway directory under
 * `os.tmpdir()` (this sandbox is Linux; `fs.promises.statfs` and
 * mkdir/writeFile/readFile/unlink are all POSIX-portable, so this exercises
 * the same code paths native-printing.test.ts's fakes exercise for
 * Windows-only APIs). Injected `fsp` fakes cover the error branches that are
 * impractical to trigger on a real disk (permission-denied, statfs
 * unsupported, read-back corruption).
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const storage = require("../../electron/local-storage.js") as {
  STORAGE_KINDS: readonly string[];
  RECOMMENDED_FREE_BYTES: number;
  MINIMUM_FREE_BYTES: number;
  formatBytes: (bytes: number) => string;
  closestExistingAncestor: (targetPath: string, fsp: typeof fs.promises) => Promise<string | null>;
  checkDiskSpace: (targetPath: string, opts?: { fsp?: unknown }) => Promise<Record<string, unknown>>;
  testFolderAccess: (targetPath: string, opts?: { fsp?: unknown; marker?: string }) => Promise<Record<string, unknown>>;
  evaluateFolder: (targetPath: string, opts?: { fsp?: unknown }) => Promise<Record<string, unknown>>;
  defaultLayout: (root: string) => Record<string, string>;
  suggestedDefaultRoot: (homedir?: string) => string;
  readStorageRootMarker: (defaultUserDataDir: string, opts?: { fsp?: unknown }) => Promise<{ root: string | null }>;
  writeStorageRootMarker: (defaultUserDataDir: string, root: string, opts?: { fsp?: unknown }) => Promise<void>;
  decideStorageBootstrap: (input: { hasExistingConfigAtDefault: boolean; markerRoot: string | null }) => {
    action: "use_default" | "use_marker_root" | "prompt";
    root?: string;
  };
};

describe("formatBytes", () => {
  it("renders bytes with no decimals", () => {
    expect(storage.formatBytes(0)).toBe("0 B");
    expect(storage.formatBytes(512)).toBe("512 B");
  });

  it("renders KB/MB/GB with unit-appropriate precision", () => {
    expect(storage.formatBytes(2048)).toBe("2.00 KB");
    expect(storage.formatBytes(1024 * 1024 * 20)).toBe("20.0 MB");
    expect(storage.formatBytes(1024 * 1024 * 1024 * 1.5)).toBe("1.50 GB");
  });

  it("treats negative/NaN as zero rather than throwing", () => {
    expect(storage.formatBytes(Number.NaN)).toBe("0 B");
    expect(storage.formatBytes(-5)).toBe("0 B");
  });
});

describe("closestExistingAncestor", () => {
  it("returns the path itself when it already exists", async () => {
    const result = await storage.closestExistingAncestor(os.tmpdir(), fs.promises);
    expect(result).toBe(path.resolve(os.tmpdir()));
  });

  it("walks up to the nearest existing directory for a not-yet-created path", async () => {
    const target = path.join(os.tmpdir(), "cafe-pos-does-not-exist-xyz", "nested", "deeper");
    const result = await storage.closestExistingAncestor(target, fs.promises);
    expect(result).toBe(path.resolve(os.tmpdir()));
  });
});

describe("checkDiskSpace", () => {
  it("reports free/total space for an existing real directory", async () => {
    const result = await storage.checkDiskSpace(os.tmpdir());
    expect(result.ok).toBe(true);
    expect(typeof result.freeBytes).toBe("number");
    expect((result.freeBytes as number) > 0).toBe(true);
    expect(typeof result.freeLabel).toBe("string");
  });

  it("reports space for a folder that does not exist yet by checking its ancestor", async () => {
    const target = path.join(os.tmpdir(), "cafe-pos-not-created-yet");
    const result = await storage.checkDiskSpace(target);
    expect(result.ok).toBe(true);
    expect(result.checkedPath).toBe(path.resolve(os.tmpdir()));
  });

  it("classifies statfs failure as statfs_unavailable without throwing", async () => {
    const fakeFsp = {
      stat: fs.promises.stat,
      statfs: async () => {
        throw new Error("ENOSYS: not supported on this filesystem");
      },
    };
    const result = await storage.checkDiskSpace(os.tmpdir(), { fsp: fakeFsp });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("statfs_unavailable");
  });

  it("flags insufficient space against the minimum/recommended thresholds", async () => {
    const fakeFsp = {
      stat: fs.promises.stat,
      statfs: async () => ({ bavail: 1000, bsize: 1, blocks: 2000 }),
    };
    const result = await storage.checkDiskSpace(os.tmpdir(), { fsp: fakeFsp });
    expect(result.ok).toBe(true);
    expect(result.sufficient).toBe(false);
    expect(result.recommended).toBe(false);
  });

  it("flags recommended space when comfortably above the 1 GiB bar", async () => {
    const fakeFsp = {
      stat: fs.promises.stat,
      statfs: async () => ({
        bavail: storage.RECOMMENDED_FREE_BYTES * 2,
        bsize: 1,
        blocks: storage.RECOMMENDED_FREE_BYTES * 4,
      }),
    };
    const result = await storage.checkDiskSpace(os.tmpdir(), { fsp: fakeFsp });
    expect(result.sufficient).toBe(true);
    expect(result.recommended).toBe(true);
  });
});

describe("testFolderAccess", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "cafe-pos-storage-test-"));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("creates the folder, writes, reads back and cleans up a marker file", async () => {
    const target = path.join(workDir, "does", "not", "exist", "yet");
    const result = await storage.testFolderAccess(target);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
    // The marker must not be left behind.
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it("reports cannot_create_folder when mkdir fails", async () => {
    const fakeFsp = {
      mkdir: async () => {
        throw new Error("EACCES: permission denied");
      },
    };
    const result = await storage.testFolderAccess(path.join(workDir, "blocked"), { fsp: fakeFsp });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("cannot_create_folder");
  });

  it("reports cannot_write when the write fails after folder creation", async () => {
    const fakeFsp = {
      mkdir: fs.promises.mkdir,
      writeFile: async () => {
        throw new Error("EROFS: read-only file system");
      },
    };
    const result = await storage.testFolderAccess(workDir, { fsp: fakeFsp });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("cannot_write");
  });

  it("reports cannot_read when the read-back fails", async () => {
    const fakeFsp = {
      mkdir: fs.promises.mkdir,
      writeFile: fs.promises.writeFile,
      readFile: async () => {
        throw new Error("EIO");
      },
      unlink: fs.promises.unlink,
    };
    const result = await storage.testFolderAccess(workDir, { fsp: fakeFsp, marker: "read-fail" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("cannot_read");
  });

  it("reports readback_mismatch when the content read back is corrupted", async () => {
    const fakeFsp = {
      mkdir: fs.promises.mkdir,
      writeFile: fs.promises.writeFile,
      readFile: async () => "not-what-was-written",
      unlink: fs.promises.unlink,
    };
    const result = await storage.testFolderAccess(workDir, { fsp: fakeFsp, marker: "mismatch" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("readback_mismatch");
  });

  it("still reports success even if the cleanup unlink fails (best-effort)", async () => {
    const fakeFsp = {
      mkdir: fs.promises.mkdir,
      writeFile: fs.promises.writeFile,
      readFile: fs.promises.readFile,
      unlink: async () => {
        throw new Error("EBUSY");
      },
    };
    const result = await storage.testFolderAccess(workDir, { fsp: fakeFsp, marker: "cleanup-fail" });
    expect(result.ok).toBe(true);
  });
});

describe("evaluateFolder", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "cafe-pos-storage-eval-"));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("rejects an empty path without touching the filesystem", async () => {
    const result = await storage.evaluateFolder("   ");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("empty_path");
  });

  it("combines disk-space and access checks for a real writable folder", async () => {
    const result = await storage.evaluateFolder(path.join(workDir, "data"));
    expect(result.ok).toBe(true);
    expect((result.space as Record<string, unknown>).ok).toBe(true);
    expect((result.access as Record<string, unknown>).ok).toBe(true);
    expect(result.path).toBe(path.resolve(path.join(workDir, "data")));
  });

  it("is not ok when the access check fails even if space is fine", async () => {
    const fakeFsp = {
      stat: fs.promises.stat,
      statfs: fs.promises.statfs,
      mkdir: async () => {
        throw new Error("EACCES");
      },
    };
    const result = await storage.evaluateFolder(path.join(workDir, "blocked"), { fsp: fakeFsp });
    expect(result.ok).toBe(false);
  });
});

describe("defaultLayout", () => {
  it("lays out one subfolder per storage kind under the chosen root", () => {
    const layout = storage.defaultLayout("/tmp/cafe-pos-root");
    for (const kind of storage.STORAGE_KINDS) {
      expect(layout[kind]).toBe(path.join(path.resolve("/tmp/cafe-pos-root"), toKebab(kind)));
    }
  });
});

describe("suggestedDefaultRoot", () => {
  it("suggests a Documents subfolder under the given home directory", () => {
    expect(storage.suggestedDefaultRoot("/home/owner")).toBe(
      path.join("/home/owner", "Documents", "Bizamiz Data"),
    );
  });
});

describe("storage root marker (persisting the first-run choice)", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "cafe-pos-marker-"));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("reports no root recorded for a fresh install", async () => {
    const result = await storage.readStorageRootMarker(workDir);
    expect(result.root).toBeNull();
  });

  it("round-trips a written root", async () => {
    await storage.writeStorageRootMarker(workDir, "/mnt/data-drive/cafe-pos");
    const result = await storage.readStorageRootMarker(workDir);
    expect(result.root).toBe("/mnt/data-drive/cafe-pos");
  });

  it("tolerates a corrupted marker file by reporting no root rather than throwing", async () => {
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, storage_marker_file()), "{not json", "utf8");
    const result = await storage.readStorageRootMarker(workDir);
    expect(result.root).toBeNull();
  });
});

describe("decideStorageBootstrap", () => {
  it("never prompts (or moves anything) when an install already has data at the default path", () => {
    expect(
      storage.decideStorageBootstrap({ hasExistingConfigAtDefault: true, markerRoot: "/somewhere/else" }),
    ).toEqual({ action: "use_default" });
  });

  it("reuses a previously recorded non-default root silently", () => {
    expect(
      storage.decideStorageBootstrap({ hasExistingConfigAtDefault: false, markerRoot: "/mnt/big-drive/pos" }),
    ).toEqual({ action: "use_marker_root", root: "/mnt/big-drive/pos" });
  });

  it("prompts only on a genuinely first launch: no default-path data, no recorded marker", () => {
    expect(storage.decideStorageBootstrap({ hasExistingConfigAtDefault: false, markerRoot: null })).toEqual({
      action: "prompt",
    });
  });

  it("treats a blank marker the same as no marker", () => {
    expect(storage.decideStorageBootstrap({ hasExistingConfigAtDefault: false, markerRoot: "   " })).toEqual({
      action: "prompt",
    });
  });
});

function storage_marker_file(): string {
  return (require("../../electron/local-storage.js") as { STORAGE_MARKER_FILE: string }).STORAGE_MARKER_FILE;
}

/** database -> database, printerConfig -> printer-config, matching local-storage.js's own naming. */
function toKebab(kind: string): string {
  const map: Record<string, string> = {
    database: "database",
    attachments: "attachments",
    images: "images",
    reports: "reports",
    backups: "backups",
    printerConfig: "printer-config",
  };
  return map[kind];
}
