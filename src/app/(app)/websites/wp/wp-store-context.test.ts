import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const context = readFileSync("src/app/(app)/websites/wp/wp-store-context.tsx", "utf8");
const shell = readFileSync("src/app/(app)/websites/wp/wp-app-shell.tsx", "utf8");
const host = readFileSync("src/app/(app)/websites/wp/store-section-host.tsx", "utf8");

describe("WP manager shared store selection", () => {
  it("provides one layout-level store provider", () => {
    expect(shell).toContain("<WpStoreProvider abilities={abilities} businessId={businessId}>");
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
});
