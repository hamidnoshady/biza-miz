/**
 * The site-portfolio rules (issue #1215 / P1‑1) — the part that decides what a
 * card is allowed to claim. Everything here is pure, so these are the tests
 * that hold the «no invented green» line: a configured REST pair is not a
 * healthy store, a plugin with no heartbeat needs a person, a failed read is
 * never an empty list.
 */
import { describe, expect, it } from "vitest";
import {
  cmsSiteState,
  isoTimestamp,
  latestTimestamp,
  portfolioCards,
  portfolioHasReadablePart,
  portfolioShowsOnboarding,
  siteHost,
  sitePortfolioTotals,
  siteStateTone,
  siteUrl,
  siteWorkLabel,
  sortSiteCards,
  storeCardTitle,
  storeLastAppliedAt,
  storeSiteState,
  storeVerification,
  type CmsSiteCard,
  type SitePortfolioState,
  type StoreSiteCard,
} from "./site-portfolio";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-11-01T09:00:00.000Z");
const iso = (offsetHours: number) => new Date(NOW + offsetHours * HOUR).toISOString();

function store(patch: Partial<StoreSiteCard> = {}): StoreSiteCard {
  return {
    kind: "woocommerce",
    id: "store-1",
    name: "فروشگاه مرکزی",
    domain: "shop.example.com",
    url: "https://shop.example.com",
    linkMode: "plugin",
    state: "active",
    lastVerifiedAt: iso(-1),
    verificationSource: "plugin_heartbeat",
    lastAppliedAt: iso(-2),
    products: 12,
    orders: 4,
    work: { pending: 0, failed: 0 },
    ...patch,
  };
}

function cms(patch: Partial<CmsSiteCard> = {}): CmsSiteCard {
  return {
    kind: "cms",
    id: "cms-1",
    domain: "acme.example",
    state: "active",
    lastCheckedAt: iso(-3),
    lastAppliedAt: null,
    syncedProducts: 5,
    work: { pending: 0, failed: 0 },
    ...patch,
  };
}

function portfolio(patch: Partial<SitePortfolioState> = {}): SitePortfolioState {
  return {
    readAt: iso(0),
    cms: { status: "ok", value: null },
    stores: { status: "ok", value: [] },
    ...patch,
  };
}

describe("timestamps", () => {
  it("accepts the Date the pg driver hands over, and ISO strings", () => {
    expect(isoTimestamp(new Date(NOW))).toBe("2026-11-01T09:00:00.000Z");
    expect(isoTimestamp("2026-11-01T09:00:00.000Z")).toBe("2026-11-01T09:00:00.000Z");
  });

  it("returns null for missing or unparseable values instead of printing Invalid Date", () => {
    expect(isoTimestamp(null)).toBeNull();
    expect(isoTimestamp(undefined)).toBeNull();
    expect(isoTimestamp("")).toBeNull();
    expect(isoTimestamp("not a date")).toBeNull();
    expect(isoTimestamp(new Date("nope"))).toBeNull();
  });

  it("picks the newest of the watermarks, ignoring junk", () => {
    expect(latestTimestamp(null, iso(-5), "junk", iso(-1))).toBe(iso(-1));
    expect(latestTimestamp(null, undefined)).toBeNull();
  });
});

describe("storeSiteState", () => {
  it("is active only with a live plugin heartbeat", () => {
    expect(storeSiteState({ status: "active", linkMode: "plugin", transportState: "healthy" })).toBe("active");
  });

  it("needs a person when the plugin has never connected", () => {
    expect(storeSiteState({ status: "active", linkMode: "plugin", transportState: "never_connected" })).toBe("action_required");
  });

  it("needs a person when the plugin answers from another domain", () => {
    expect(storeSiteState({ status: "active", linkMode: "plugin", transportState: "site_mismatch" })).toBe("action_required");
  });

  it("is degraded for a silent plugin or a recorded error", () => {
    expect(storeSiteState({ status: "active", linkMode: "plugin", transportState: "stale" })).toBe("degraded");
    expect(storeSiteState({ status: "error", linkMode: "plugin", transportState: "healthy" })).toBe("degraded");
  });

  it("keeps a paused store paused, even with a dead plugin", () => {
    expect(storeSiteState({ status: "paused", linkMode: "plugin", transportState: "stale" })).toBe("paused");
    expect(storeSiteState({ status: "active", linkMode: "plugin", transportState: "paused" })).toBe("paused");
  });

  it("never calls a configured REST pair verified without a successful check or sync", () => {
    expect(storeSiteState({ status: "active", linkMode: "rest_api" })).toBe("unverified");
    expect(storeSiteState({ status: "active", linkMode: "rest_api", lastSyncAt: iso(-4) })).toBe("active");
    expect(storeSiteState({ status: "active", linkMode: "rest_api", lastSuccessfulTestAt: iso(-9) })).toBe("active");
  });

  it("says unknown rather than green when the transport was not read at all", () => {
    expect(storeSiteState({ status: "active", linkMode: "plugin" })).toBe("unknown");
  });
});

describe("storeVerification", () => {
  it("labels a plugin heartbeat as the plugin's own last answer", () => {
    expect(
      storeVerification({ linkMode: "plugin", lastPluginSeenAt: iso(-1), lastSyncAt: iso(-8) }),
    ).toEqual({ at: iso(-1), source: "plugin_heartbeat" });
  });

  it("prefers a recorded connection test in REST mode, then falls back to a sync", () => {
    expect(
      storeVerification({ linkMode: "rest_api", lastSuccessfulTestAt: iso(-6), lastOrderSyncAt: iso(-2) }),
    ).toEqual({ at: iso(-6), source: "connection_test" });
    expect(storeVerification({ linkMode: "rest_api", lastOrderSyncAt: iso(-2) })).toEqual({
      at: iso(-2),
      source: "sync",
    });
  });

  it("reports nothing rather than a date for a store that has never been confirmed", () => {
    expect(storeVerification({ linkMode: "rest_api" })).toEqual({ at: null, source: null });
  });
});

describe("storeLastAppliedAt", () => {
  it("is the newest per-job watermark, so a store whose orders synced recently is not called stale", () => {
    expect(
      storeLastAppliedAt({
        lastCatalogueSyncAt: iso(-30),
        lastOrderSyncAt: iso(-1),
        lastCustomerSyncAt: iso(-9),
        lastContentSyncAt: null,
      }),
    ).toBe(iso(-1));
  });
});

describe("cmsSiteState", () => {
  it("is active when the credential was checked and recorded no error", () => {
    expect(cmsSiteState({ status: "active", lastCheckedAt: iso(-3) })).toBe("active");
  });

  it("needs a person when the site's credential is disabled", () => {
    expect(cmsSiteState({ status: "disabled", lastCheckedAt: iso(-3) })).toBe("action_required");
  });

  it("is degraded when the last check recorded an error", () => {
    expect(cmsSiteState({ status: "active", lastError: "unauthorized", lastCheckedAt: iso(-3) })).toBe("degraded");
  });

  it("is unverified when nothing has ever checked it", () => {
    expect(cmsSiteState({ status: "active", lastCheckedAt: null })).toBe("unverified");
  });
});

describe("presentation", () => {
  it("gives each state one tone, and only a real success gets the positive one", () => {
    expect(siteStateTone("active")).toBe("positive");
    expect(siteStateTone("degraded")).toBe("danger");
    expect(siteStateTone("action_required")).toBe("danger");
    expect(siteStateTone("paused")).toBe("neutral");
    expect(siteStateTone("unverified")).toBe("neutral");
    expect(siteStateTone("unknown")).toBe("neutral");
  });

  it("counts queued and failed work separately, and says nothing when both are zero", () => {
    expect(siteWorkLabel({ pending: 2, failed: 1 })).toContain("۲");
    expect(siteWorkLabel({ pending: 0, failed: 1 })).not.toContain("در صف");
    expect(siteWorkLabel({ pending: 0, failed: 0 })).toBeNull();
  });

  it("tells two stores with one name apart by their domain", () => {
    expect(storeCardTitle({ name: "فروشگاه", domain: "a.example" })).toBe("فروشگاه — a.example");
    expect(storeCardTitle({ name: "a.example", domain: "a.example" })).toBe("a.example");
    expect(storeCardTitle({ name: "فروشگاه", domain: null })).toBe("فروشگاه");
  });

  it("reads a host out of a store URL, with or without a scheme", () => {
    expect(siteHost("https://shop.example.com/wp")).toBe("shop.example.com");
    expect(siteHost("shop.example.com")).toBe("shop.example.com");
    expect(siteHost(null)).toBeNull();
  });

  it("keeps the store's own address for «بازکردن فروشگاه», and refuses junk", () => {
    expect(siteUrl("https://shop.example.com/")).toBe("https://shop.example.com");
    expect(siteUrl("https://shop.example.com/wp")).toBe("https://shop.example.com/wp");
    expect(siteUrl("not a url")).toBeNull();
    expect(siteUrl(null)).toBeNull();
  });
});

describe("ordering and totals", () => {
  it("puts attention first, then the platform site, then stores by name", () => {
    const ordered = sortSiteCards([
      store({ id: "b", name: "ب", state: "active" }),
      store({ id: "a", name: "الف", state: "degraded" }),
      cms({ state: "active" }),
      store({ id: "c", name: "ج", state: "paused" }),
    ]);
    expect(ordered.map((card) => card.id)).toEqual(["a", "c", "cms-1", "b"]);
  });

  it("sums sites, attention and work without double-counting the CMS as a store", () => {
    const totals = sitePortfolioTotals([
      cms({ work: { pending: 1, failed: 0 } }),
      store({ id: "1", work: { pending: 0, failed: 2 } }),
      store({ id: "2", state: "paused", work: { pending: 0, failed: 0 } }),
    ]);
    expect(totals).toEqual({ sites: 3, stores: 2, needingAttention: 1, pendingWork: 1, failedWork: 2 });
  });
});

describe("portfolio parts", () => {
  it("offers onboarding only when both halves were read and both are empty", () => {
    expect(portfolioShowsOnboarding(portfolio())).toBe(true);
    expect(portfolioShowsOnboarding(portfolio({ cms: { status: "ok", value: cms() } }))).toBe(false);
    expect(portfolioShowsOnboarding(portfolio({ stores: { status: "ok", value: [store()] } }))).toBe(false);
  });

  it("never shows onboarding for a refused or failed half — that is not an empty business", () => {
    expect(portfolioShowsOnboarding(portfolio({ stores: { status: "error" } }))).toBe(false);
    expect(portfolioShowsOnboarding(portfolio({ stores: { status: "denied" } }))).toBe(false);
    expect(portfolioShowsOnboarding(portfolio({ cms: { status: "error" } }))).toBe(false);
  });

  it("still renders the half it could read", () => {
    const state = portfolio({ cms: { status: "error" }, stores: { status: "ok", value: [store()] } });
    expect(portfolioHasReadablePart(state)).toBe(true);
    expect(portfolioCards(state).map((card) => card.id)).toEqual(["store-1"]);
    expect(portfolioHasReadablePart(portfolio({ cms: { status: "error" }, stores: { status: "error" } }))).toBe(false);
  });
});
