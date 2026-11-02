import { describe, expect, it } from "vitest";
import {
  enrollable,
  normaliseHost,
  resolveTorobWebsites,
  websiteKey,
  type ExistingTorobShop,
  type ManagedWebsiteCandidate,
} from "./eligibility";

/**
 * Issue #894 Wave 1 — the rules that decide whether a managed website may publish
 * to Torob, tested without a database.
 *
 * The resolver is pure on purpose: every interesting decision here is a
 * *combination* (a paused connection that already has a connected shop, two
 * websites at one host, a revoked link that must stay re-enrollable), and a table
 * of cases pins those down far more legibly than rows would. The database half —
 * that one business can never see or touch another's shops — belongs to the
 * integration suite, not here.
 */

const woo = (over: Partial<ManagedWebsiteCandidate> = {}): ManagedWebsiteCandidate => ({
  kind: "woocommerce",
  connectionId: "c1",
  domain: "shop.example.com",
  label: "فروشگاه ووکامرس",
  connection: { active: true, catalogueReady: true, disabledReason: null },
  ...over,
});

const cms = (over: Partial<ManagedWebsiteCandidate> = {}): ManagedWebsiteCandidate => ({
  kind: "eshobe_cms",
  connectionId: "m1",
  domain: "www.example.ir",
  label: "سایت بیزامیز",
  connection: { active: true, catalogueReady: true, disabledReason: null },
  ...over,
});

const shop = (over: Partial<ExistingTorobShop> = {}): ExistingTorobShop => ({
  id: "s1",
  kind: "woocommerce",
  connectionId: "c1",
  domain: "shop.example.com",
  authorizationState: "authorized",
  enabled: true,
  ...over,
});

const resolve = (websites: ManagedWebsiteCandidate[], shops: ExistingTorobShop[] = []) =>
  resolveTorobWebsites({ websites, shops });

describe("normaliseHost", () => {
  it("lowercases, strips scheme, port, path and trailing dot", () => {
    expect(normaliseHost("HTTPS://Shop.Example.COM/Products/?page=2")).toBe("shop.example.com");
    expect(normaliseHost("shop.example.com.")).toBe("shop.example.com");
    expect(normaliseHost("  http://shop.example.com:8080  ")).toBe("shop.example.com");
  });

  it("refuses what cannot be a public website", () => {
    // Each of these is something a merchant can end up with in a connection row,
    // and none is a site Torob could fetch a feed from.
    expect(normaliseHost("")).toBeNull();
    expect(normaliseHost(null)).toBeNull();
    expect(normaliseHost("localhost")).toBeNull();
    expect(normaliseHost("127.0.0.1")).toBeNull();
    expect(normaliseHost("https://192.168.1.10")).toBeNull();
    expect(normaliseHost("shop")).toBeNull();
    expect(normaliseHost("not a host")).toBeNull();
  });

  it("settles an international domain on one spelling", () => {
    // `URL` punycodes it, which is the form to store: Wave 2 matches Torob's
    // `page_url` hosts against this column through the same function, so the
    // Persian spelling and the ASCII one must not become two different shops.
    expect(normaliseHost("فروشگاه.ایران")).toBe("xn--mgbtj4c7ad63e.xn--mgba3a4f16a");
    expect(normaliseHost("xn--mgbtj4c7ad63e.xn--mgba3a4f16a")).toBe(
      "xn--mgbtj4c7ad63e.xn--mgba3a4f16a",
    );
  });
});

describe("resolveTorobWebsites", () => {
  it("offers an actively connected, catalogue-ready website", () => {
    const [row] = resolve([woo()]);
    expect(row.state).toBe("eligible");
    expect(row.shop).toBeNull();
    expect(enrollable(row)).toBe(true);
  });

  it("withholds a website whose catalogue is not ready, and says why", () => {
    // An active connection whose product sync is off would send Torob an empty
    // feed, which is worse than no shop at all.
    const [row] = resolve([
      woo({ connection: { active: true, catalogueReady: false, disabledReason: "product_sync_disabled" } }),
    ]);
    expect(row.state).toBe("needs_attention");
    expect(row.reason).toBe("product_sync_disabled");
    expect(enrollable(row)).toBe(false);
    // Still listed: the merchant needs to see the site and the fix, not an empty
    // page that looks like it was never connected.
    expect(row.domain).toBe("shop.example.com");
  });

  it("withholds a paused connection, quoting the registry's own error", () => {
    const [row] = resolve([
      woo({ connection: { active: false, catalogueReady: false, disabledReason: "sync_products_failed" } }),
    ]);
    expect(row.state).toBe("inactive");
    expect(row.reason).toBe("sync_products_failed");
  });

  it("falls back to a generic reason when the registry has none", () => {
    const [row] = resolve([
      cms({ connection: { active: false, catalogueReady: false, disabledReason: null } }),
    ]);
    expect(row.state).toBe("inactive");
    expect(row.reason).toBe("connection_inactive");
  });

  it("reports an authorized shop as connected, not as eligible", () => {
    const [row] = resolve([woo()], [shop()]);
    expect(row.state).toBe("connected");
    expect(row.shop?.id).toBe("s1");
    // Still offered — the screen has to manage it — but not as a new enrolment.
    expect(enrollable(row)).toBe(false);
  });

  it("keeps an authorized shop connected even while its channel is switched off", () => {
    // `enabled` is the run switch, not a different relationship. Showing this as
    // broken is how a merchant who paused one site concludes the channel failed.
    const [row] = resolve([woo()], [shop({ enabled: false })]);
    expect(row.state).toBe("connected");
  });

  it("surfaces a pending approval as its own state", () => {
    const [row] = resolve([woo()], [shop({ authorizationState: "pending_approval", enabled: false })]);
    expect(row.state).toBe("pending_approval");
    expect(enrollable(row)).toBe(false);
  });

  it("treats a revoked link as disconnected, which may be re-enrolled", () => {
    const [row] = resolve([woo()], [shop({ authorizationState: "revoked", enabled: false })]);
    expect(row.state).toBe("disconnected");
    // Reconnecting is the same operation as connecting, so re-enrolment is a yes.
    expect(enrollable(row)).toBe(true);
  });

  it("puts a dead connection above the shop's own state", () => {
    // The website is paused, so nothing can publish from it whatever the shop row
    // says — and the merchant must still be able to see and clean it up.
    const [row] = resolve(
      [woo({ connection: { active: false, catalogueReady: false, disabledReason: null } })],
      [shop()],
    );
    expect(row.state).toBe("inactive");
    expect(row.shop).not.toBeNull();
  });

  it("never lends a shop to a different website", () => {
    const [row] = resolve([cms({ connectionId: "m1" })], [shop({ connectionId: "c1", kind: "woocommerce" })]);
    expect(row.state).toBe("eligible");
    expect(row.shop).toBeNull();
  });

  it("gives one domain to one shop, and explains the other", () => {
    // A WooCommerce plugin and the Eshobe site it runs on are two managed
    // websites at one host; only one Torob shop may own that domain.
    const rows = resolve([woo({ connectionId: "c1" }), cms({ connectionId: "m1", domain: "shop.example.com" })], [shop()]);
    expect(rows.map((row) => row.state)).toEqual(["connected", "needs_attention"]);
    expect(rows[1].reason).toBe("domain_already_enrolled");
  });

  it("lets the first eligible website claim a free domain", () => {
    const rows = resolve([woo({ connectionId: "c1" }), cms({ connectionId: "m1", domain: "shop.example.com" })]);
    expect(rows.map((row) => row.state)).toEqual(["eligible", "needs_attention"]);
    expect(rows[0].reason).toBeNull();
  });

  it("is stable: same input, same output, whatever order the registries return", () => {
    const forward = resolve([woo(), cms()]);
    const backward = resolve([cms(), woo()]);
    const key = (row: { kind: string; connectionId: string }) => websiteKey(row.kind as never, row.connectionId);
    expect(forward.map(key).sort()).toEqual(backward.map(key).sort());
  });

  it("keys a website by kind and connection, so the two registries cannot collide", () => {
    // Both registries are UUID-keyed; in principle ids could match across them.
    expect(websiteKey("woocommerce", "x")).not.toBe(websiteKey("eshobe_cms", "x"));
  });

  it("returns no row rather than a guess when there are no websites", () => {
    expect(resolve([])).toEqual([]);
  });
});
