import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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

  it("keeps a connections-fetch failure as an error with a retry — never a fake 'no store connected'", () => {
    // Issue #943: reloadConnections() used to flatten an API failure into
    // connections=[], and every section then told the owner they had no
    // store — hiding the stores that exist behind one failed request.
    expect(context).toContain("connectionsError");
    expect(context).toContain("setConnectionsError");
    // The failure path must not clear a list that is already on screen.
    expect(context).toContain("setConnections((previous) => previous ?? [])");
    expect(context).not.toMatch(/if \(!res\.ok\) \{\s*setConnections\(\[\]\);\s*setSelectedIdState\(""\);/);

    expect(host).toContain("connectionsError");
    expect(host).toContain("ConnectionsError");
    expect(host).toContain("تلاش دوباره");
    // The genuine empty state stays reachable — but only without an error.
    expect(host).toContain("connections.length === 0 && connectionsError");
    expect(host).toContain("EmptyConnections");
  });
});
