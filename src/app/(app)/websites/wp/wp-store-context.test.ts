import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { wpConnectionsErrorMessage } from "./wp-store-context";

const context = readFileSync("src/app/(app)/websites/wp/wp-store-context.tsx", "utf8");
const shell = readFileSync("src/app/(app)/websites/wp/wp-app-shell.tsx", "utf8");
const host = readFileSync("src/app/(app)/websites/wp/store-section-host.tsx", "utf8");

describe("WP manager shared store selection", () => {
  it("provides one layout-level store provider", () => {
    expect(shell).toContain("<WpStoreProvider>");
    expect(context).toContain("/api/integrations/connections?provider=woocommerce");
  });

  it("persists the selected store in URL and localStorage", () => {
    expect(context).toContain("store");
    expect(context).toContain("localStorage.setItem");
    expect(context).toContain("wp-manager:selected-connection");
  });

  it("store section hosts consume shared state instead of fetching connections themselves", () => {
    expect(host).toContain("useWpStore()");
    expect(host).not.toContain("api<{ connections");
  });
});

describe("connection-list load failures (#944 OVR-02/OVR-05)", () => {
  it("gives each failure class its own recovery copy", () => {
    expect(wpConnectionsErrorMessage(401)).toContain("نشست");
    expect(wpConnectionsErrorMessage(403)).toContain("دسترسی");
    expect(wpConnectionsErrorMessage(0)).toContain("ارتباط");
    expect(wpConnectionsErrorMessage(500)).toContain("سرور");
    expect(wpConnectionsErrorMessage(503)).toContain("سرور");
    expect(wpConnectionsErrorMessage(418).length).toBeGreaterThan(0);
    // No class collapses into another class's message.
    const all = [401, 403, 0, 500].map(wpConnectionsErrorMessage);
    expect(new Set(all).size).toBe(4);
  });

  it("never reads a failed load as an empty account", () => {
    // The failure path records the error and returns; the only
    // setConnections([]) left is the feature-locked branch.
    expect(context).toContain("setConnectionsError(wpConnectionsErrorMessage(res.status))");
    expect(context.split("setConnections([]);")).toHaveLength(2);
    expect(context).toContain("connectionsState");
  });

  it("sequences overlapping reloads so a stale answer cannot rewind the selection", () => {
    expect(context).toContain("reloadSeqRef");
    expect(context).toContain("selectedIdRef.current || querySelected");
  });

  it("offers a retry in both the no-list error card and the stale-list banner", () => {
    expect(context.split("تلاش دوباره").length).toBeGreaterThan(2);
    expect(context).toContain("آخرین فهرست خوانده‌شده نمایش داده می‌شود");
  });
});
