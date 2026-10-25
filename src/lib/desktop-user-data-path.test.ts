import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { resolveUserDataDir, USER_DATA_FOLDER, LEGACY_USER_DATA_FOLDERS } = require("../../electron/user-data-path.js") as {
  resolveUserDataDir: (appData: string, fsApi?: { existsSync: (p: string) => boolean }) => string;
  USER_DATA_FOLDER: string;
  LEGACY_USER_DATA_FOLDERS: string[];
};

const APPDATA = path.join("/users", "owner", "AppData", "Roaming");
const fsWith = (...files: string[]) => ({ existsSync: (p: string) => files.includes(p) });

describe("desktop userData folder after the Bizamiz rename", () => {
  it("names the new folder Bizamiz and remembers both earlier names", () => {
    expect(USER_DATA_FOLDER).toBe("Bizamiz");
    expect(LEGACY_USER_DATA_FOLDERS).toEqual(["Business Suite", "business-suite-desktop"]);
  });

  it("gives a machine with no data the new folder", () => {
    expect(resolveUserDataDir(APPDATA, fsWith())).toBe(path.join(APPDATA, "Bizamiz"));
  });

  it("keeps an existing install in its old folder, in either layout", () => {
    const flat = path.join(APPDATA, "Business Suite", "config.json");
    expect(resolveUserDataDir(APPDATA, fsWith(flat))).toBe(path.join(APPDATA, "Business Suite"));
    const migrated = path.join(APPDATA, "business-suite-desktop", "Configuration", "config.json");
    expect(resolveUserDataDir(APPDATA, fsWith(migrated))).toBe(path.join(APPDATA, "business-suite-desktop"));
  });

  it("follows an owner-chosen storage root recorded next to the old default", () => {
    const marker = path.join(APPDATA, "Business Suite", "storage-location.json");
    expect(resolveUserDataDir(APPDATA, fsWith(marker))).toBe(path.join(APPDATA, "Business Suite"));
  });

  it("prefers the new folder once it holds data, and never invents one from an empty directory", () => {
    const both = fsWith(
      path.join(APPDATA, "Business Suite", "config.json"),
      path.join(APPDATA, "Bizamiz", "Configuration", "config.json"),
    );
    expect(resolveUserDataDir(APPDATA, both)).toBe(path.join(APPDATA, "Bizamiz"));
    // An empty Bizamiz directory (created by Electron itself) must not hide the real data.
    expect(resolveUserDataDir(APPDATA, fsWith(path.join(APPDATA, "Business Suite", "config.json")))).toBe(
      path.join(APPDATA, "Business Suite"),
    );
  });
});
