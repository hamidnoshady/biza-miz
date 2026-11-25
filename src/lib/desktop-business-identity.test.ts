/**
 * @vitest-environment jsdom
 *
 * #1572 — the renderer side of the identity backfill. The logic that decides
 * what may be written lives in electron/profile-registry.js (covered by
 * desktop-profile-registry.test.ts); this only proves the hand-off is a no-op
 * where there is no shell, and exactly one call where there is.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordDesktopBusinessIdentity } from "./desktop-business-identity";

const IDENTITY = {
  businessId: "11111111-1111-4111-8111-111111111111",
  businessSubdomain: "cafe-alefba",
  cloudOrigin: "https://app.example.com",
};

function installBridge(recordIdentity: (identity: unknown) => Promise<{ ok: true; changed: boolean }>) {
  (window as unknown as { businessSuiteDesktop?: unknown }).businessSuiteDesktop = {
    business: { recordIdentity },
  };
}

afterEach(() => {
  delete (window as unknown as { businessSuiteDesktop?: unknown }).businessSuiteDesktop;
  vi.restoreAllMocks();
});

describe("recordDesktopBusinessIdentity", () => {
  it("does nothing in a browser", () => {
    expect(() => recordDesktopBusinessIdentity(IDENTITY)).not.toThrow();
  });

  it("does nothing on a shell that predates the bridge", () => {
    (window as unknown as { businessSuiteDesktop?: unknown }).businessSuiteDesktop = {
      business: { current: async () => ({ status: null, multiBusiness: false }) },
    };
    expect(() => recordDesktopBusinessIdentity(IDENTITY)).not.toThrow();
  });

  it("hands the identity to the shell exactly once", async () => {
    const recordIdentity = vi.fn(async () => ({ ok: true as const, changed: true }));
    installBridge(recordIdentity);
    recordDesktopBusinessIdentity(IDENTITY);
    expect(recordIdentity).toHaveBeenCalledTimes(1);
    expect(recordIdentity).toHaveBeenCalledWith(IDENTITY);
  });

  it("still sends the business id when only that is known, and never throws", async () => {
    const recordIdentity = vi.fn(async () => ({ ok: true as const, changed: true }));
    installBridge(recordIdentity);
    recordDesktopBusinessIdentity({ businessId: IDENTITY.businessId });
    expect(recordIdentity).toHaveBeenCalledWith({
      businessId: IDENTITY.businessId,
      businessSubdomain: null,
      cloudOrigin: null,
    });
  });
});
