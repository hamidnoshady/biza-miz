import { describe, expect, it } from "vitest";
import { frameAncestorsAllow } from "./embed-frame";

const CMS = "https://cms.eshobe.com";
const POS = "https://admin.app.eshobe.com";

describe("frameAncestorsAllow", () => {
  it("refuses a CMS that only allows itself — the broken-frame icon in production", () => {
    expect(frameAncestorsAllow({ csp: "frame-ancestors 'self'" }, POS, CMS)).toBe(false);
  });

  it("allows a listed origin, a wildcard subdomain and a bare host", () => {
    expect(frameAncestorsAllow({ csp: `frame-ancestors 'self' ${POS}` }, POS, CMS)).toBe(true);
    expect(frameAncestorsAllow({ csp: "frame-ancestors https://*.eshobe.com" }, POS, CMS)).toBe(true);
    expect(frameAncestorsAllow({ csp: "frame-ancestors admin.app.eshobe.com" }, POS, CMS)).toBe(true);
    expect(frameAncestorsAllow({ csp: "frame-ancestors http://admin.app.eshobe.com" }, POS, CMS)).toBe(false);
    expect(frameAncestorsAllow({ csp: "frame-ancestors https://admin.app.eshobe.com:8443" }, POS, CMS)).toBe(false);
  });

  it("intersects several policies and ignores other directives", () => {
    expect(
      frameAncestorsAllow({ csp: `default-src 'self'; frame-ancestors ${POS}, frame-ancestors 'self'` }, POS, CMS),
    ).toBe(false);
    expect(frameAncestorsAllow({ csp: "default-src 'self'" }, POS, CMS)).toBe(true);
  });

  it("falls back to X-Frame-Options only without frame-ancestors", () => {
    expect(frameAncestorsAllow({ xFrameOptions: "DENY" }, POS, CMS)).toBe(false);
    expect(frameAncestorsAllow({ xFrameOptions: "SAMEORIGIN" }, POS, CMS)).toBe(false);
    expect(frameAncestorsAllow({ csp: `frame-ancestors ${POS}`, xFrameOptions: "DENY" }, POS, CMS)).toBe(true);
  });

  it("cannot tell without a parent origin", () => {
    expect(frameAncestorsAllow({ csp: "frame-ancestors 'self'" }, "not a url", CMS)).toBeUndefined();
  });
});
