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

  it("distinguishes a failed connection-list request from a genuinely empty list", () => {
    expect(context).toContain("connectionsError");
    expect(context).toContain("res.status === 401");
    expect(context).toContain("res.status === 403");
    expect(context).toContain("res.status === 0");
    expect(context).toContain("current ?? []");
    expect(readFileSync("src/app/(app)/websites/wp/customers-section.tsx", "utf8")).toContain("فهرست فروشگاه‌های متصل در دسترس نیست");
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
