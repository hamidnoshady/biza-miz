/**
 * Drift guard for the Bizamiz / «بیزامیز» rename.
 *
 * The product used to be called "Biza Miz" (Android, Telegram), "Business Suite"
 * (Windows desktop), "POS Accounting Connector" (WordPress), "Cafe POS" (print
 * connector) and «اشوبه» (panel, plugin menu, print service). Anything a person
 * reads must use the current name from `src/lib/brand.ts`; this test fails when
 * an old display name comes back in shipped sources.
 *
 * What it deliberately does NOT police: technical identifiers (the
 * `businesssuite://` protocol, `com.businesssuite.desktop`, the
 * `pos-accounting-connector` slug, `eshobe-cms` and `ESHOBE_*` names, domains).
 * Those are listed in docs/architecture/branding.md with the reason each stays.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

const SCANNED = [
  "src",
  "electron",
  "wordpress-plugin",
  "android/app/src",
  "config",
  "public",
  "scripts",
  ".env.example",
];
const SKIPPED_DIRS = new Set(["node_modules", ".next", "dist", "build", "fonts", "windows"]);
const TEXT = /\.(ts|tsx|js|cjs|mjs|json|php|txt|xml|kt|kts|nsh|ps1|sh|md|css|html|example)$/;

/** Old display names, with the identifiers that look similar and are fine. */
const OLD_NAMES: { name: RegExp; why: string }[] = [
  { name: /Biza[ -]Miz/, why: "was the Android/Telegram display name" },
  { name: /بیزا میز/, why: "was the Persian display name in the lock screen" },
  { name: /Cafe POS|Café POS/, why: "was the print connector's display name" },
  { name: /POS Accounting Connector/, why: "was the WordPress plugin's display name" },
  { name: /اشوبه/, why: "was the panel / print service / plugin menu name" },
  { name: /Business Suite/, why: "was the Windows desktop's display name" },
];

/**
 * Files that must keep an old name, each for a stated reason. A new entry is a
 * decision: add it to docs/architecture/branding.md as well.
 */
const KEEPS_OLD_NAME: Record<string, string> = {
  // Existing installs: these names are on disk / in the registry / on phones.
  "electron/user-data-path.js": "legacy userData folder names, so an upgrade finds its database",
  "electron/firewall-manager.js": "legacy firewall rule name, removed on upgrade",
  "electron/scripts/installer-cleanup.nsh": "removes the legacy firewall rule on uninstall",
  "electron/certificate-manager.js": "the local CA's subject is baked into CAs already trusted on phones",
  "src/app/(app)/settings/connections/local-devices-panel.tsx": "tells the owner which already-installed CA to trust",
  "electron/main.js": "comment explaining the rename",
  "src/lib/windows-print-connector.ts": "removes the legacy 'Cafe POS Print Connector' Start-menu/Startup shortcuts",
  // Test fixtures: a signing publisher / data path, not a product label.
  "src/lib/desktop-runtime-posture.test.ts": "fixture path of a pre-rename install",
  "src/lib/desktop-user-data-path.test.ts": "asserts the legacy folder names",
  "src/lib/desktop-update-engine.test.ts": "fixture signing publisher",
  "src/lib/desktop-release.test.ts": "fixture signing publisher",
  "src/lib/desktop-release-signing.test.ts": "fixture signing publisher",
  "src/lib/app-update.test.ts": "fixture signing publisher",
  "src/lib/app-update-engine-telemetry.test.ts": "fixture signing publisher",
  "src/lib/pg-tools.test.ts": "fixture certificate organisation",
  "src/app/(app)/settings/desktop-update-settings.test.tsx": "fixture signing publisher",
  "src/app/api/desktop-update/check/route.test.ts": "fixture signing publisher",
  // This file and its mirror name the old names on purpose.
  "src/lib/brand-coverage.test.ts": "lists the old names",
};

function walk(entry: string, out: string[]): void {
  const abs = path.join(root, entry);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return;
  }
  if (stat.isFile()) {
    if (TEXT.test(entry) || path.basename(entry) === ".env.example") out.push(entry);
    return;
  }
  for (const child of readdirSync(abs)) {
    if (SKIPPED_DIRS.has(child) && !(entry === "public" && child === "windows")) continue;
    walk(path.posix.join(entry, child), out);
  }
}

describe("brand coverage", () => {
  const files: string[] = [];
  for (const entry of SCANNED) walk(entry, files);

  it("scans a meaningful number of shipped files", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("shows no old product name in shipped sources", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const key = file.split(path.sep).join("/");
      if (key in KEEPS_OLD_NAME) continue;
      const text = readFileSync(path.join(root, key), "utf8");
      for (const { name, why } of OLD_NAMES) {
        const hit = text.match(name);
        if (hit) offenders.push(`${key}: "${hit[0]}" (${why})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only exempts files that still exist and still need the exemption", () => {
    for (const key of Object.keys(KEEPS_OLD_NAME)) {
      const text = readFileSync(path.join(root, key), "utf8");
      const stillNeeded = OLD_NAMES.some(({ name }) => name.test(text));
      expect(stillNeeded, `${key} no longer contains an old name — drop it from KEEPS_OLD_NAME`).toBe(true);
    }
  });
});
