import { describe, expect, it } from "vitest";
import { BRAND_NAME_EN, BRAND_NAME_FA } from "../../brand";
import {
  CREDIT_NOTIFICATION_LEVELS,
  creditNotification,
  creditNotificationCopy,
  overdueItems,
  type CreditCopyParams,
  type CreditNotificationFacts,
} from "./notifications";

const H = 3_600_000;
const D = 24 * H;
const now = new Date("2026-11-01T12:00:00Z");
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

/** A healthy site: synced an hour ago, a fresh lease, recent backup and update check. */
const healthy: CreditNotificationFacts = {
  now,
  leaseExpiresAt: at(6 * D),
  lastSyncAt: at(-H),
  lastUpdateCheckAt: at(-D),
  lastBackupAt: at(-D),
  state: "lease",
  debtRial: 0,
  debtCeilingRial: 1_000,
};

describe("creditNotification — time-driven levels", () => {
  it("says nothing with no lease, or a healthy lease", () => {
    expect(creditNotification({ ...healthy, leaseExpiresAt: null }).level).toBe("none");
    expect(creditNotification(healthy).level).toBe("none");
  });

  it("starts a dismissible notice at day 4 (72 h before expiry)", () => {
    const n = creditNotification({ ...healthy, leaseExpiresAt: at(72 * H) });
    expect(n).toMatchObject({ level: "notice", dismissible: true, modal: false });
    expect(creditNotification({ ...healthy, leaseExpiresAt: at(72 * H + 1) }).level).toBe("none");
  });

  it("is a stronger, non-dismissible warning in the last 24 h", () => {
    const n = creditNotification({ ...healthy, leaseExpiresAt: at(24 * H) });
    expect(n).toMatchObject({ level: "warning", dismissible: false, modal: false });
  });

  it("shows a modal in the last hour", () => {
    const n = creditNotification({ ...healthy, leaseExpiresAt: at(H) });
    expect(n).toMatchObject({ level: "final", dismissible: false, modal: true });
  });

  it("also starts the notice when sync has been dark for four days, even with lease time left", () => {
    const n = creditNotification({ ...healthy, lastSyncAt: at(-4 * D) });
    expect(n.level).toBe("notice");
    expect(n.daysSinceSync).toBe(4);
  });

  it("is driven by timestamps only, so a stuck sync cannot hide it", () => {
    const stuck = creditNotification({ ...healthy, lastSyncAt: at(-8 * D), leaseExpiresAt: at(-D) });
    expect(stuck.level).toBe("final");
    expect(stuck.overdue).toContain("sync");
  });
});

describe("creditNotification — debt-driven levels", () => {
  const exhausted = { ...healthy, state: "over_lease_debt" as const, leaseExpiresAt: at(-H) };

  it("shows the debt banner under 80 % of the ceiling", () => {
    expect(creditNotification({ ...exhausted, debtRial: 799 }).level).toBe("debt");
  });

  it("warns near the lock from 80 %", () => {
    expect(creditNotification({ ...exhausted, debtRial: 800 })).toMatchObject({ level: "near_lock", modal: true });
  });

  it("shows the lock when locked, whatever the clock says", () => {
    expect(creditNotification({ ...healthy, state: "locked", debtRial: 1_000 })).toMatchObject({ level: "locked", dismissible: false });
  });
});

describe("overdueItems", () => {
  it("names each of the four housekeeping jobs separately", () => {
    expect(overdueItems(healthy)).toEqual([]);
    expect(overdueItems({ ...healthy, lastSyncAt: at(-4 * D) })).toEqual(["sync"]);
    expect(overdueItems({ ...healthy, leaseExpiresAt: at(3 * D) })).toEqual(["lease"]);
    expect(overdueItems({ ...healthy, lastUpdateCheckAt: at(-7 * D) })).toEqual(["update"]);
    expect(overdueItems({ ...healthy, lastBackupAt: at(-4 * D) })).toEqual(["backup"]);
  });

  it("treats a job that has never succeeded as overdue", () => {
    expect(overdueItems({ ...healthy, lastSyncAt: null, lastUpdateCheckAt: null, lastBackupAt: null })).toEqual(["sync", "update", "backup"]);
  });

  it("is empty with no lease", () => {
    expect(overdueItems({ ...healthy, leaseExpiresAt: null, lastSyncAt: null })).toEqual([]);
  });
});

describe("creditNotificationCopy", () => {
  const params: CreditCopyParams = {
    days: 4,
    expiry: "2026-11-01 12:00",
    used: "800,000",
    ceiling: "1,000,000",
    overdue: ["sync", "backup"],
  };
  const levels = CREDIT_NOTIFICATION_LEVELS.filter((l) => l !== "none");

  it("has a Persian and an English message for every level, with the right brand", () => {
    for (const level of levels) {
      const fa = creditNotificationCopy(level, "fa", params);
      const en = creditNotificationCopy(level, "en", params);
      expect(fa.title.length).toBeGreaterThan(0);
      expect(fa.body).toMatch(/[؀-ۿ]/);
      expect(en.body).not.toMatch(/[؀-ۿ]/);
      if (level === "notice" || level === "warning" || level === "final") {
        expect(fa.body).toContain(BRAND_NAME_FA);
        expect(en.body).toContain(BRAND_NAME_EN);
      }
    }
  });

  it("defaults to Persian and uses Persian digits for the day count", () => {
    const copy = creditNotificationCopy("notice", undefined, params);
    expect(copy.body).toContain("۴ روز");
    expect(copy.body).toContain("معوق: همگام‌سازی مصرف، پشتیبان‌گیری.");
  });

  it("names the overdue items in English and omits the list when nothing is overdue", () => {
    expect(creditNotificationCopy("notice", "en", params).body).toContain("Overdue: usage sync, backup.");
    expect(creditNotificationCopy("notice", "en", { ...params, overdue: [] }).body).not.toContain("Overdue");
    expect(creditNotificationCopy("notice", "en", { ...params, days: 1 }).body).toContain("1 day.");
  });

  it("puts the used and ceiling figures in the debt copy, as formatted by the caller", () => {
    expect(creditNotificationCopy("debt", "fa", params).body).toContain("800,000 از سقف 1,000,000");
    expect(creditNotificationCopy("debt", "en", params).body).toContain("(800,000 of 1,000,000)");
  });

  it("tells the locked user what still works", () => {
    const fa = creditNotificationCopy("locked", "fa", params).body;
    for (const word of ["بستن سفارش‌ها", "چاپ رسید", "خروجی‌گیری", "پشتیبان‌گیری"]) expect(fa).toContain(word);
    const en = creditNotificationCopy("locked", "en", params).body;
    for (const word of ["Closing orders", "printing receipts", "exporting", "backing up"]) expect(en).toContain(word);
  });
});
