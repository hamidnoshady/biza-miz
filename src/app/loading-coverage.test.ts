/**
 * Route transitions must never fall back to a blank document while server or
 * client data resolves. Keep one loading boundary for the root and one for
 * each visual realm whose chrome differs from it.
 *
 * The layout rule below generalises that contract: *every* layout in the app
 * must sit under a loading boundary (its own, or an ancestor's), so a new
 * realm cannot ship without a skeleton fallback. And the primitive rule keeps
 * each boundary honest — a realm whose chrome is the dashboard frame falls
 * back to the dashboard skeleton, not to three bare bars that say nothing
 * about the shape of the page being waited for.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const APP_DIR = fileURLToPath(new URL("./", import.meta.url));

const BOUNDARIES = [
  { path: "loading.tsx", primitive: "Skeleton" },
  { path: "dashboard/loading.tsx", primitive: "DashboardPageSkeleton" },
  { path: "platform/loading.tsx", primitive: "PlatformPageSkeleton" },
  { path: "setup/loading.tsx", primitive: "Skeleton" },
] as const;

describe("route-level skeleton coverage", () => {
  for (const boundary of BOUNDARIES) {
    it(`${boundary.path} renders its realm's structural fallback`, () => {
      const path = `${APP_DIR}/${boundary.path}`;
      expect(existsSync(path), `${boundary.path} is missing`).toBe(true);
      expect(readFileSync(path, "utf8")).toContain(boundary.primitive);
    });
  }

  it("every layout realm sits under a loading boundary (its own or an ancestor's)", () => {
    const layoutDirs = collectLayoutDirs();
    // Guards against a broken walk: the app has realms beyond the four above
    // (crm, growth, businesses/[id], system …) that inherit a boundary.
    expect(layoutDirs.length).toBeGreaterThan(6);

    const missing = layoutDirs.filter((dir) => !hasLoadingBoundaryAbove(dir));
    expect(
      missing.join("\n"),
      [
        "Layout realms without any loading.tsx above them:",
        missing.join("\n"),
        "",
        "Add a loading.tsx to the realm (or rely on the ancestor that already",
        "has one) — navigation into it must show a skeleton, never a blank",
        "document. See src/app/loading-coverage.test.ts.",
      ].join("\n"),
    ).toBe("");
  });

  it("client managers that fetch on mount reserve their shape with a skeleton", () => {
    // The practical form of "skeleton loading on any element": every client
    // component that starts reading data while rendering must also render a
    // *Skeleton — LoadingSkeleton/SectionCardSkeleton/KpiRowSkeleton
    // (dashboard), FormLoadingSkeleton (entry realms), or a bespoke
    // *-named skeleton (ReservationSkeleton, SetupDataSkeleton, the
    // ops-skeleton bars). A file with a fetch and no skeleton is a flash of
    // empty layout waiting to happen.
    //
    // Excluded: flows whose only fetch is an action (submit a PIN, flush the
    // offline queue, resolve one barcode scan) — there is no data region to
    // reserve before the fetch fires.
    const ACTION_ONLY = new Set([
      "dashboard/lock-screen.tsx", // PIN pad; the fetch is the submit
      "dashboard/offline-queue.tsx", // queue-flushing glue, renders no data
      "dashboard/inventory/count-scan-field.tsx", // per-scan lookup with instant inline feedback
      // Fixed-size chrome pill (a coin icon + balance) in the sidebar/mobile
      // header; it reserves its own shape and shows an ellipsis before the
      // first read, so there is no data region to skeleton — it is chrome, not
      // a page manager.
      "dashboard/credit-badge.tsx",
      // The sidebar's identity drop-up. Its only fetch is the sign-out POST —
      // an action, with the button's own "در حال خروج…" state — and the menu
      // renders a fixed list of links, so there is no data region to reserve.
      "dashboard/platform-user-menu.tsx",
      // Persistent support chrome has no initial read; its only request is the
      // end-session action (button, expiry, or the ended-session screen, which
      // is a one-line status rather than a data region) and owns its pending text.
      "dashboard/support-session-banner.tsx",
      // The wizard's hardware step renders the shared PrintersPanel, which owns
      // its own loading state; this page's only request is the progress-write
      // action that retires the step, and its effect probes the desktop bridge
      // rather than any API. There is no data region here to reserve (issue #808).
      "setup/hardware/page.tsx",
      // The menu item Sheet's requests are all mutations (save, attach,
      // detach) against data the workspace already loaded — menu-workspace.tsx
      // skeletons the tree before any Sheet can open, so there is no
      // first-fetch region for the Sheet itself to reserve (issue #844).
      "(app)/accounting/menu/item-sheet.tsx",
    ]);
    const offenders: string[] = [];
    for (const file of walkTsFiles(APP_DIR)) {
      const rel = relative(APP_DIR, file).split(sep).join("/");
      if (rel.startsWith("platform/")) continue; // separate realm, own kit
      if (rel.includes(".test.") || rel.includes("/ui.tsx")) continue;
      if (!rel.endsWith(".tsx") || !rel.includes("/")) continue;
      if (ACTION_ONLY.has(rel)) continue;
      const source = readFileSync(file, "utf8");
      if (!/"use client"/.test(source)) continue;
      if (!/useEffect/.test(source)) continue;
      const fetches =
        /\bfetch\(|\bapi</.test(source) || /\/api\/[a-z0-9/_-]+/.test(source);
      if (!fetches) continue;
      const hasSkeleton = /[A-Za-z]*Skeleton\b|ops-skeleton/.test(source);
      if (!hasSkeleton) offenders.push(rel);
    }

    expect(
      offenders.join("\n"),
      [
        "Client components that fetch but never render a skeleton:",
        offenders.join("\n"),
        "",
        "While the first fetch is in flight, show LoadingSkeleton/",
        "SectionCardSkeleton (dashboard) or FormLoadingSkeleton (entry",
        "realms) instead of an empty container. See docs/design-system.md",
        "§Charts and loading.",
      ].join("\n"),
    ).toBe("");
  });
});

/** Every directory under src/app that owns a layout.tsx. */
function collectLayoutDirs(): string[] {
  return walkTsFiles(APP_DIR)
    .filter((file) => file.endsWith("layout.tsx"))
    .map((file) => dirname(relative(APP_DIR, file).split(sep).join("/")))
    .sort();
}

/** Is there a loading.tsx in `dir` or any ancestor up to src/app? */
function hasLoadingBoundaryAbove(dir: string): boolean {
  let probe = dir;
  while (true) {
    if (existsSync(join(APP_DIR, probe, "loading.tsx"))) return true;
    if (probe === "") return false;
    const parent = probe.slice(0, probe.lastIndexOf("/"));
    if (parent === probe) return false;
    probe = parent;
  }
}

function walkTsFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walkTsFiles(full));
    } else if (/\.(?:ts|tsx)$/.test(entry) && !entry.includes(".test.")) {
      files.push(full);
    }
  }
  return files;
}
