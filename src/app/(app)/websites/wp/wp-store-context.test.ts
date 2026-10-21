import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const context = readFileSync("src/app/(app)/websites/wp/wp-store-context.tsx", "utf8");
const shell = readFileSync("src/app/(app)/websites/wp/wp-app-shell.tsx", "utf8");
const host = readFileSync("src/app/(app)/websites/wp/store-section-host.tsx", "utf8");
const sections = readFileSync("src/app/(app)/websites/wp/woo-store-sections.tsx", "utf8");

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

  it("keeps shared URL filters on reload, and says «queued» only when the write was actually queued", () => {
    // PR #1054 review finding 1: the store-switch reset ran on the initial
    // mount too, so a shared/reloaded link like ?store=…&q=…&page=2 had its
    // filters wiped the moment the selected store resolved. The reset must
    // only fire between two resolved, different stores.
    expect(sections).toContain("prevConnectionIdRef");
    expect(sections).toContain('if (prev === null || prev === "" || prev === connectionId) return;');

    // PR #1054 review finding 2: the panel confirmed every successful write
    // with the queued wording — wrong for a REST sync that completed inline
    // (it then contradicted the section's own accurate result) and for an
    // immediate settings PATCH. The notice must follow the response.
    expect(host).toContain("res.data?.queued === true");
    expect(host).toContain("successNotice");
    expect(host).toContain("تغییرات ثبت شد.");
    // The products sync speaks for itself in both modes.
    expect(sections).toContain("{ successNotice: null }");
  });
});
