import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SYNC_CONTROLS,
  SYNC_CONTROL_CATEGORIES,
  SYNC_CONTROL_FINDINGS,
  controlsThatMoveCloudSiteData,
  renderSyncControlsMarkdown,
  routeFileForApi,
} from "./sync-controls-inventory";

const ROOT = process.cwd();
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

/** Every file the inventory names, as a repo-relative path. */
const listedFiles = new Set(
  SYNC_CONTROLS.flatMap((control) => [control.source, ...(control.alsoIn ?? [])]),
);

/**
 * A UI file that calls one of these is part of the Cloud ↔ site, activation,
 * pairing, update, browser-queue or integration-sync surface. The list is the
 * discovery rule: a new caller must be classified, not silently shipped.
 */
const SYNC_ENDPOINT =
  /\/api\/(?:server-sync|iam\/|team\/iam-status|team\/detach-site|auth\/pin-login\/roster\/sync|sync\/events|connection\/status|local-activation|desktop-update|setup\/(?:pair|reconnect|bootstrap)|connections\/(?:desktop|website\/sync|website\/queue)|integrations\/connections\/[^"'`]*\/(?:sync|reconcile|outbox)|platform\/updates\/commands)/;
const ELECTRON_UPDATE_CHANNEL = /desktop:update-|desktop-update/;

function walk(dir: string, accept: (file: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    const stat = statSync(join(ROOT, rel));
    if (stat.isDirectory()) {
      if (rel === "src/app/api" || name === "node_modules") continue;
      walk(rel, accept, out);
    } else if (accept(rel)) {
      out.push(rel);
    }
  }
  return out;
}

const isSource = (file: string) => /\.(?:ts|tsx)$/.test(file) && !/\.(?:test|spec)\.tsx?$/.test(file);

describe("sync controls inventory", () => {
  it("uses unique ids and known categories", () => {
    const ids = SYNC_CONTROLS.map((control) => control.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const control of SYNC_CONTROLS) {
      expect(SYNC_CONTROL_CATEGORIES).toContain(control.category);
    }
  });

  it("references only findings that exist, and every finding is used", () => {
    const known = new Set(SYNC_CONTROL_FINDINGS.map((finding) => finding.id));
    const used = new Set<string>();
    for (const control of SYNC_CONTROLS) {
      for (const id of control.findings ?? []) {
        expect(known.has(id), `${control.id} cites unknown finding ${id}`).toBe(true);
        used.add(id);
      }
    }
    for (const id of known) expect(used.has(id), `finding ${id} is cited by no control`).toBe(true);
  });

  it("points at files, routes and labels that still exist", () => {
    for (const file of listedFiles) {
      expect(existsSync(join(ROOT, file)), `${file} is listed but missing`).toBe(true);
    }
    for (const control of SYNC_CONTROLS) {
      const route = routeFileForApi(control.api);
      if (route) {
        expect(existsSync(join(ROOT, route)), `${control.id}: ${route} is missing`).toBe(true);
      }
      if (control.label) {
        expect(read(control.source), `${control.id}: label «${control.label}» not found in ${control.source}`).toContain(
          control.label,
        );
      }
    }
  });

  it("names Electron channels that preload and main both register", () => {
    const preload = read("electron/preload.js");
    const main = read("electron/main.js");
    for (const control of SYNC_CONTROLS.filter((entry) => entry.kind === "ipc")) {
      expect(control.api, control.id).toMatch(/^desktop:update-[a-z-]+$/);
      expect(preload, `${control.id} not exposed by preload`).toContain(`"${control.api}"`);
      expect(main, `${control.id} not handled by main`).toContain(`"${control.api}"`);
    }
  });

  it("anchors each scheduled job to the code that runs it", () => {
    const anchors: Record<string, { file: string; symbol: string }> = {
      "auto.server-sync-tick": { file: "server.ts", symbol: "runServerSyncTick" },
      "auto.central-maintenance": { file: "server.ts", symbol: "runCentralSyncMaintenanceTick" },
      "auto.local-activation-validation": { file: "server.ts", symbol: "runLocalActivationValidationTick" },
      "auto.runtime-status-report": { file: "src/lib/app-update.ts", symbol: "/api/server-sync/runtime-status" },
    };
    for (const control of SYNC_CONTROLS.filter((entry) => entry.kind === "automatic" && entry.source === "server.ts")) {
      expect(anchors[control.id], `${control.id} has no anchor`).toBeDefined();
    }
    for (const [id, anchor] of Object.entries(anchors)) {
      expect(SYNC_CONTROLS.some((control) => control.id === id), `${id} missing from inventory`).toBe(true);
      expect(read(anchor.file), `${id}: ${anchor.symbol} not in ${anchor.file}`).toContain(anchor.symbol);
    }
  });

  it("lists every UI and Electron file that calls a sync, activation, pairing or update endpoint", () => {
    const callers = [
      ...walk("src/app", isSource),
      ...walk("src/components", isSource),
      ...readdirSync(join(ROOT, "electron"))
        .filter((name) => name.endsWith(".js"))
        .map((name) => `electron/${name}`),
    ].filter((file) => {
      const text = read(file);
      return file.startsWith("electron/") ? ELECTRON_UPDATE_CHANNEL.test(text) : SYNC_ENDPOINT.test(text);
    });
    const unlisted = callers.filter((file) => !listedFiles.has(file)).map((file) => relative("", file));
    expect(
      unlisted,
      "These files call a sync/activation/pairing/update endpoint but are not classified in src/lib/sync-controls-inventory.ts",
    ).toEqual([]);
  });

  describe("product invariants the inventory must keep visible", () => {
    it("never classifies a Full Offline-only control as moving operational data to the Cloud (issue #974)", () => {
      for (const control of SYNC_CONTROLS.filter((entry) => entry.modes.every((mode) => mode === "local"))) {
        expect(control.category, control.id).not.toBe("cloud_site_data_sync");
        expect(["both", "site_to_cloud"], control.id).not.toContain(control.direction);
      }
    });

    it("keeps software updates apart from data sync", () => {
      for (const control of SYNC_CONTROLS.filter((entry) => entry.category === "software_update")) {
        expect(control.domain, control.id).toMatch(/release manifest|installer/);
      }
      expect(controlsThatMoveCloudSiteData().some((control) => control.category === "software_update")).toBe(false);
    });

    it("keeps the Cloud-site data controls to the Hybrid / Cloud runtime", () => {
      for (const control of controlsThatMoveCloudSiteData()) {
        expect(control.modes, control.id).not.toContain("local");
      }
    });
  });

  it("keeps docs/architecture/sync-controls-inventory.md identical to the registry", () => {
    const doc = read("docs/architecture/sync-controls-inventory.md");
    expect(doc, "Run: npx tsx scripts/render-sync-controls-inventory.ts").toBe(renderSyncControlsMarkdown());
  });
});
