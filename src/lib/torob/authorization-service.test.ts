import { describe, expect, it, vi } from "vitest";

/**
 * Issue #894 Wave 3 — the two decisions in the approval flow that are pure.
 *
 * The transitions themselves need Postgres and Torob (`integration/torob-authorization.integration.test.ts`);
 * what can be checked without either is the 15-minute window and the sentences a
 * merchant is left with. Both are worth a fast test because both are easy to get
 * subtly wrong: a window measured from the wrong moment sends people to a page
 * that has already given up, and an unmapped reason shows a merchant a code.
 */

vi.mock("../db", () => ({ query: vi.fn() }));
vi.mock("./shop-service", () => ({
  TorobShopError: class TorobShopError extends Error {},
  readTorobShop: vi.fn(),
  readTorobShopByConnection: vi.fn(),
}));

const { TOROB_APPROVAL_WINDOW_MS, approvalWindowOpen, authorizationErrorCopy } = await import(
  "./authorization-service"
);

describe("the approval window", () => {
  const start = new Date("2026-11-01T10:00:00.000Z");

  it("is exactly Torob's fifteen minutes", () => {
    expect(TOROB_APPROVAL_WINDOW_MS).toBe(15 * 60 * 1000);
  });

  it("is open up to the last second and closed after", () => {
    expect(approvalWindowOpen(start.toISOString(), new Date(start.getTime() + 1_000))).toBe(true);
    expect(approvalWindowOpen(start.toISOString(), new Date(start.getTime() + 14 * 60 * 1000))).toBe(true);
    expect(approvalWindowOpen(start.toISOString(), new Date(start.getTime() + 15 * 60 * 1000))).toBe(false);
    expect(approvalWindowOpen(start.toISOString(), new Date(start.getTime() + 60 * 60 * 1000))).toBe(false);
  });

  it("is closed when the moment is missing or unreadable", () => {
    // A pending row always carries one (the schema enforces it); a missing value
    // here means something wrote the row outside this service, and the safe answer
    // is to send nobody to Torob.
    expect(approvalWindowOpen(null)).toBe(false);
    expect(approvalWindowOpen("not-a-date")).toBe(false);
    expect(approvalWindowOpen("")).toBe(false);
  });
});

describe("what the merchant is told", () => {
  it("has a sentence for the two outcomes Torob's API cannot describe", () => {
    expect(authorizationErrorCopy("denied")).toContain("رد");
    expect(authorizationErrorCopy("expired")).toContain("۱۵");
  });

  it("reuses the partner vocabulary for a failed call", () => {
    expect(authorizationErrorCopy("no_such_shop")).toContain("دامنه");
    expect(authorizationErrorCopy("not_configured")).toContain("توکن");
    expect(authorizationErrorCopy("code_invalid")).toContain("تأیید");
  });

  it("falls back to a sentence rather than echoing a code from the database", () => {
    expect(authorizationErrorCopy("something_new")).toBe("تأیید اتصال انجام نشد.");
    expect(authorizationErrorCopy(null)).toBeNull();
  });
});
