/**
 * The identity a printed document carries — one loader for every document
 * (issue #815: F5 branding server-side; the audit's "the browser does not
 * spell the letterhead" finding).
 *
 * What must hold: the ADDRESS AND PHONE COME FROM THE DOCUMENT'S BRANCH (not
 * the viewer's), the footer comes from the business profile, and the money unit
 * follows the business's own preference — because a receipt printed in the
 * wrong unit is off by a factor of ten in every line.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../db";
import * as settings from "../settings";
import { loadPrintIdentity } from "./identity";

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return { ...actual, query: vi.fn() };
});
vi.mock("../settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../settings")>();
  return { ...actual, getSetting: vi.fn() };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.query).mockImplementation((async (sql: string) =>
    String(sql).includes("FROM businesses")
      ? { rows: [{ name: "طلافروشی نمونه" }], rowCount: 1 }
      : { rows: [{ address: "تهران، بازار", phone: "02100000000" }], rowCount: 1 }) as never);
  vi.mocked(settings.getSetting).mockResolvedValue(null as never);
});

describe("loadPrintIdentity", () => {
  it("reads the branch's address and phone, not the viewer's", async () => {
    const identity = await loadPrintIdentity("biz-1", "loc-other");
    expect(identity.business).toEqual({
      name: "طلافروشی نمونه",
      address: "تهران، بازار",
      phone: "02100000000",
      footerMessage: null,
    });
    const locationCall = vi.mocked(db.query).mock.calls.find(([sql]) => String(sql).includes("FROM locations"));
    expect(locationCall?.[1]).toEqual(["loc-other"]);
  });

  it("carries the profile's receipt footer", async () => {
    vi.mocked(settings.getSetting).mockImplementation((async (_businessId: string, key: string) =>
      key === settings.SETTING_KEYS.businessProfile ? { receiptFooter: "با تشکر از خرید شما" } : null) as never);
    const identity = await loadPrintIdentity("biz-1", "loc-1");
    expect(identity.business.footerMessage).toBe("با تشکر از خرید شما");
  });

  it("defaults the money unit to Toman and follows the business preference to Rial", async () => {
    expect((await loadPrintIdentity("biz-1", "loc-1")).currencyUnit).toBe("toman");

    vi.mocked(settings.getSetting).mockImplementation((async (_businessId: string, key: string) =>
      key === settings.SETTING_KEYS.businessPrefs ? { currencyDisplay: "rial" } : null) as never);
    expect((await loadPrintIdentity("biz-1", "loc-1")).currencyUnit).toBe("rial");
  });

  it("degrades to blank fields rather than refusing to print", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [], rowCount: 0 } as never);
    const identity = await loadPrintIdentity("biz-1", "loc-1");
    expect(identity.business).toEqual({ name: "", address: null, phone: null, footerMessage: null });
  });
});
