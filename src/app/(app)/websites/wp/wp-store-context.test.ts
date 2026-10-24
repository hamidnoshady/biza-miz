import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { wpConnectionsErrorMessage } from "./wp-store-context";

const context = readFileSync("src/app/(app)/websites/wp/wp-store-context.tsx", "utf8");
const shell = readFileSync("src/app/(app)/websites/wp/wp-app-shell.tsx", "utf8");
const host = readFileSync("src/app/(app)/websites/wp/store-section-host.tsx", "utf8");
const layout = readFileSync("src/app/(app)/websites/wp/layout.tsx", "utf8");
const sections = readFileSync("src/app/(app)/websites/wp/woo-store-sections.tsx", "utf8");

describe("WP manager shared store selection", () => {
  it("provides one layout-level store provider", () => {
    expect(shell).toContain("<WpStoreProvider abilities={abilities} businessId={businessId} caps={caps}>");
    // #944 / OVR-01: the manager reads its own, `woocommerce.view`-gated list.
    expect(context).toContain("/api/integrations/wp-manager/connections");
    expect(context).not.toContain("/api/integrations/connections?provider=woocommerce");
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

  it("keeps a connections-fetch failure as an error with a retry — never a fake 'no store connected'", () => {
    // Issues #943 + #944/OVR-02: a failed list read used to flatten into
    // connections=[], and every section then told the owner they had no
    // store — hiding the stores that exist behind one failed request. The
    // merged contract says the load state out loud instead: loading /
    // loaded / error, with the failure's status+code attached.
    expect(context).toContain("loadState");
    expect(context).toContain("setLoadError");
    // The failure path must not clear a list that is already on screen:
    // "A refresh keeps the last good list on screen."
    expect(context).toContain("setConnections(list)");
    expect(context).not.toMatch(/if \(!res\.ok\) \{\s*setConnections\(\[\]\);/);

    expect(host).toContain("refreshFailure");
    expect(host).toContain("WpStoreRefreshError");
    expect(host).toContain("reloadConnections");
    // The genuine empty state stays reachable — but only once loaded.
    expect(host).toContain("EmptyConnections");
  });

  it("keeps shared URL filters on reload, and says «queued» only when the write was actually queued", () => {
    // PR #1054 review finding 1: the store-switch reset ran on the initial
    // mount too, so a shared/reloaded link like ?store=…&q=…&page=2 had its
    // filters wiped the moment the selected store resolved. The reset must
    // only fire between two resolved, different stores.
    expect(sections).toContain("prevConnectionIdRef");
    expect(sections).toContain('if (prev === null || prev === "" || prev === connectionId) return;');

    // PR #1054 review finding 2, as merged with #944/OVR-08: the panel
    // confirmed every successful write with the queued wording — wrong for
    // a REST sync that completed inline. The notice now follows the
    // response body (`result` / `queued`), and callers that speak for
    // themselves (the products sync) still pass `successNotice: null`.
    expect(host).toContain("describeCallSuccess");
    expect(host).toContain('result === "queued" || data?.queued === true');
    expect(host).toContain("successNotice");
    expect(sections).toContain("{ successNotice: null }");
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
    expect(context).toContain("setLoadError({ status: res.status");
    expect(context.split("setConnections([]);")).toHaveLength(2);
    expect(context).toContain("connectionsState");
  });

  it("sequences overlapping reloads so a stale answer cannot rewind the selection", () => {
    expect(context).toContain("generationRef");
    expect(context).toContain("chosen: chosenRef.current");
  });

  it("offers a retry in both the no-list error card and the stale-list banner", () => {
    const states = readFileSync("src/app/(app)/websites/wp/wp-store-states.tsx", "utf8");
    expect(context).toContain("WpStoreLoadError");
    expect(states.split("تلاش دوباره").length).toBeGreaterThan(2);
    expect(states).toContain("فهرست قبلی نمایش داده می‌شود");
  });
});

describe("capability caps reach the client sections (#944 OVR-01)", () => {
  it("the layout resolves them server-side from the same matrix as the guard", () => {
    expect(layout).toContain("wpSectionCaps(session)");
    expect(context).toContain("caps?.canSync");
    expect(context).toContain("caps?.canEdit");
  });
});
