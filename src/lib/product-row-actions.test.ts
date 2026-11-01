import { describe, expect, it } from "vitest";
import {
  ALL_STORES,
  PRODUCT_SOURCE_FILTERS,
  PRODUCT_WOO_FILTERS,
  STORE_LINK_STATE_LABEL,
  duplicateReviewGatesPublication,
  matchesSourceFilter,
  matchesStoreFilter,
  matchesWooFilter,
  productLinkState,
  productRowAction,
  storeLinkState,
  storesInLinks,
} from "./product-row-actions";

const linked = { connectionStatus: "active" as const, lastOutboundStatus: null };
const acknowledged = { connectionStatus: "active" as const, lastOutboundStatus: "sent" as const };
const queued = { connectionStatus: "active" as const, lastOutboundStatus: "pending" as const };
const failed = { connectionStatus: "active" as const, lastOutboundStatus: "failed" as const };

describe("one store's state", () => {
  it("separates an acknowledged send from a plain mapping and from work in flight", () => {
    expect(storeLinkState(linked)).toBe("linked");
    expect(storeLinkState(acknowledged)).toBe("acknowledged");
    expect(storeLinkState(queued)).toBe("queued");
    expect(storeLinkState(failed)).toBe("failed");
    expect(storeLinkState({ connectionStatus: "error", lastOutboundStatus: null })).toBe("failed");
    expect(storeLinkState({ connectionStatus: "paused", lastOutboundStatus: "sent" })).toBe("paused");
  });

  it("states each state in the words the list always used", () => {
    expect(STORE_LINK_STATE_LABEL).toEqual({
      linked: "متصل",
      acknowledged: "ارسال تأیید شد",
      queued: "در صف ارسال",
      failed: "نیازمند بررسی",
      paused: "اتصال متوقف",
    });
  });
});

describe("the row's link state is the worst store's", () => {
  it("is unlinked with no mapping at all", () => {
    expect(productLinkState([])).toBe("unlinked");
    expect(matchesWooFilter("unlinked", false, "unlinked")).toBe(true);
  });

  it("prefers a failure over work in flight over a healthy link", () => {
    expect(productLinkState([failed, acknowledged])).toBe("failed");
    expect(productLinkState([queued, acknowledged])).toBe("queued");
    expect(productLinkState([acknowledged, linked])).toBe("linked");
  });

  it("treats one acknowledged store as linked for the filter", () => {
    expect(matchesWooFilter(productLinkState([acknowledged]), false, "linked")).toBe(true);
  });
});

describe("the Woo/duplicate filter", () => {
  it("offers exactly the five states issue #1207 asks for", () => {
    expect(PRODUCT_WOO_FILTERS.map((option) => option.label)).toEqual([
      "همهٔ وضعیت‌های فروشگاه",
      "متصل",
      "محلی / بدون پیوند",
      "احتمال تکراری",
      "در صف",
      "ناموفق",
    ]);
  });

  it("matches one state at a time and everything on `all`", () => {
    expect(matchesWooFilter("failed", false, "all")).toBe(true);
    expect(matchesWooFilter("failed", true, "duplicate")).toBe(true);
    expect(matchesWooFilter("linked", false, "duplicate")).toBe(false);
    expect(matchesWooFilter("queued", false, "queued")).toBe(true);
    expect(matchesWooFilter("linked", false, "queued")).toBe(false);
    expect(matchesWooFilter("failed", false, "failed")).toBe(true);
  });
});

describe("the row's primary action", () => {
  it("is a manual review-and-send on a linked row, never a publication", () => {
    const action = productRowAction({ links: [acknowledged], duplicate: false });
    expect(action.kind).toBe("manual_update");
    expect(action.label).toBe("به‌روزرسانی دستی");
    expect(action.shortLabel).toBe("به‌روزرسانی");
    // The copy must not imply the automatic sync needs this click.
    expect(action.hint).toContain("به‌صورت غیرهمزمان");
    expect(action.hint).toContain("بی‌نیاز از این دکمه");
    expect(action.hint).toContain("پس از تأیید فروشگاه");
  });

  it("is a publication with a link alternative on an unlinked row", () => {
    const action = productRowAction({ links: [], duplicate: false });
    expect(action.kind).toBe("publish");
    expect(action.label).toBe("انتشار در فروشگاه");
    expect(action.hint).toContain("اگر همان محصول از قبل در فروشگاه هست");
    expect(action.label).not.toContain("به‌روزرسانی");
  });

  it("is a duplicate review before any new publication on a flagged unmapped row", () => {
    const action = productRowAction({ links: [], duplicate: true });
    expect(action.kind).toBe("review_duplicate");
    expect(action.label).toBe("بررسی محصول تکراری");
    expect(duplicateReviewGatesPublication([], true)).toBe(true);
  });

  it("keeps the manual update on a flagged row that is already linked", () => {
    // It creates nothing, so the review does not replace it — the row offers
    // the review beside it.
    expect(productRowAction({ links: [linked], duplicate: true }).kind).toBe("manual_update");
    expect(duplicateReviewGatesPublication([linked], true)).toBe(false);
    expect(duplicateReviewGatesPublication([], false)).toBe(false);
  });

  it("explains the review where it is the row's only store action", () => {
    expect(productRowAction({ links: [], duplicate: true }).hint).toContain("کد کالای یکسان");
    expect(productRowAction({ links: [], duplicate: true }).shortLabel).toBe("بررسی تکراری");
    // A linked flagged row keeps the plain manual-update hint: the review sits
    // beside it in the row, so nothing here may read as "publish again".
    expect(productRowAction({ links: [linked], duplicate: true }).hint).not.toContain("کد کالای یکسان");
  });
});

describe("the source filter", () => {
  it("offers every source the catalogue can have", () => {
    expect(PRODUCT_SOURCE_FILTERS.map((option) => option.value)).toEqual(["all", "woocommerce", "holoo", "local"]);
  });

  it("matches the row's owning integration, and `local` means no integration at all", () => {
    expect(matchesSourceFilter({ provider: "woocommerce" }, "all")).toBe(true);
    expect(matchesSourceFilter({ provider: "woocommerce" }, "woocommerce")).toBe(true);
    expect(matchesSourceFilter({ provider: "woocommerce" }, "holoo")).toBe(false);
    expect(matchesSourceFilter({ provider: "holoo" }, "holoo")).toBe(true);
    // A row nothing owns is not a store row — and is not matched by `all`-or-store either.
    expect(matchesSourceFilter(null, "local")).toBe(true);
    expect(matchesSourceFilter(null, "woocommerce")).toBe(false);
    expect(matchesSourceFilter(undefined, "holoo")).toBe(false);
  });
});

describe("the per-store filter", () => {
  const storeA = { connectionId: "store-a", storeName: "فروشگاه الف" };
  const storeB = { connectionId: "store-b", storeName: "فروشگاه ب" };

  it("lists each store once, in the server's order", () => {
    expect(storesInLinks([storeA, storeB, { connectionId: "store-a", storeName: "فروشگاه الف" }])).toEqual([
      { id: "store-a", name: "فروشگاه الف" },
      { id: "store-b", name: "فروشگاه ب" },
    ]);
    expect(storesInLinks([])).toEqual([]);
  });

  it("matches only rows mapped to the chosen store, and everything on `all`", () => {
    expect(matchesStoreFilter([storeA], ALL_STORES)).toBe(true);
    // `all` is not the same claim as the Woo filter's «محلی / بدون پیوند».
    expect(matchesStoreFilter([], ALL_STORES)).toBe(true);
    expect(matchesStoreFilter([storeA], "store-a")).toBe(true);
    expect(matchesStoreFilter([storeA], "store-b")).toBe(false);
    expect(matchesStoreFilter([], "store-a")).toBe(false);
  });
});
