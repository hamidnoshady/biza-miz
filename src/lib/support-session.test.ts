import { describe, expect, it } from "vitest";
import type { SessionPayload } from "./auth-edge";
import {
  isSupportSessionExitRequest,
  SUPPORT_SESSION_EXIT_PATH,
  SUPPORT_SESSION_SIGN_OUT_PATH,
  supportCloseMeta,
  supportMutationAllowed,
  supportSessionRemainingMs,
  supportSessionReturnPath,
  validSupportReason,
} from "./support-session";

const session = (mode?: "read_only" | "controlled" | "full" | "emergency"): SessionPayload => ({
  sub: "user", role: "owner", businessId: "business", locationId: null, fullName: "Test",
  ...(mode ? { imp: { grantId: "grant", adminId: "admin", mode, allowedCapabilities: ["printer.test"] } } : {}),
});

describe("support session policy", () => {
  it("requires a meaningful normalized reason", () => {
    expect(validSupportReason("          ")).toBe(false);
    expect(validSupportReason("short")).toBe(false);
    expect(validSupportReason("بررسی مشکل چاپگر فروشگاه")).toBe(true);
  });

  it("denies every write in read-only mode", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(supportMutationAllowed(session("read_only"), method, "/api/printing/jobs")).toBe(false);
      expect(supportMutationAllowed(session("read_only"), method, "/api/orders/123")).toBe(false);
    }
  });

  it("allows only explicitly granted technical actions in controlled mode", () => {
    expect(supportMutationAllowed(session("controlled"), "POST", "/api/printing/jobs")).toBe(true);
    expect(supportMutationAllowed(session("controlled"), "POST", "/api/orders/123")).toBe(false);
  });

  it("does not restrict normal tenant sessions or full support", () => {
    expect(supportMutationAllowed(session(), "POST", "/api/orders")).toBe(true);
    expect(supportMutationAllowed(session("full"), "POST", "/api/orders")).toBe(true);
  });
});

describe("ending a support session", () => {
  // The regression: DELETE /api/support-access is how the banner's «پایان نشست»
  // ends the session, and the read-only guard refused it as a "mutation", so a
  // read-only operator could never leave.
  it("is allowed in every support mode, read-only included", () => {
    for (const mode of ["read_only", "controlled", "full", "emergency"] as const) {
      expect(supportMutationAllowed(session(mode), "DELETE", SUPPORT_SESSION_EXIT_PATH), mode).toBe(true);
    }
  });

  it("exempts exactly DELETE on the exit path and nothing near it", () => {
    expect(isSupportSessionExitRequest("DELETE", "/api/support-access")).toBe(true);
    expect(isSupportSessionExitRequest("PATCH", "/api/support-access")).toBe(false);
    expect(isSupportSessionExitRequest("POST", "/api/support-access")).toBe(false);
    expect(isSupportSessionExitRequest("DELETE", "/api/support-access/extra")).toBe(false);
    expect(isSupportSessionExitRequest("DELETE", "/api/support-accessx")).toBe(false);
    // The policy PATCH stays a mutation a read-only session may not make.
    expect(supportMutationAllowed(session("read_only"), "PATCH", SUPPORT_SESSION_EXIT_PATH)).toBe(false);
    expect(supportMutationAllowed(session("controlled"), "PATCH", SUPPORT_SESSION_EXIT_PATH)).toBe(false);
  });

  // #854 follow-up (third pass): the sidebar's and Profile's «خروج» post to
  // the sign-out route, which closes a support session's grant through the
  // banner's own service. A read-only guard refusing it left a read-only
  // operator with a 403 and a live grant.
  it("lets every support mode sign itself out, and exempts exactly POST on the sign-out path", () => {
    expect(SUPPORT_SESSION_SIGN_OUT_PATH).toBe("/api/auth/logout");
    for (const mode of ["read_only", "controlled", "full", "emergency"] as const) {
      expect(supportMutationAllowed(session(mode), "POST", SUPPORT_SESSION_SIGN_OUT_PATH), mode).toBe(true);
    }
    expect(isSupportSessionExitRequest("POST", "/api/auth/logout")).toBe(true);
    expect(isSupportSessionExitRequest("DELETE", "/api/auth/logout")).toBe(false);
    expect(isSupportSessionExitRequest("PUT", "/api/auth/logout")).toBe(false);
    expect(isSupportSessionExitRequest("POST", "/api/auth/logout/retry")).toBe(false);
    expect(isSupportSessionExitRequest("POST", "/api/auth/logoutx")).toBe(false);
    // Moving the session elsewhere is not leaving it.
    expect(supportMutationAllowed(session("read_only"), "POST", "/api/auth/switch-business")).toBe(false);
    expect(supportMutationAllowed(session("read_only"), "POST", "/api/auth/switch-location")).toBe(false);
  });

  it("returns the operator to the business's support tab in the console", () => {
    expect(supportSessionReturnPath("7198892a-cca7-4e29-80a1-ff9f5f64fa97")).toBe(
      "/platform/businesses/7198892a-cca7-4e29-80a1-ff9f5f64fa97/support",
    );
    expect(supportSessionReturnPath("a/../b")).toBe("/platform/businesses/a%2F..%2Fb/support");
  });

  it("records the first forwarded address and the user agent", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1", "user-agent": "UA" });
    expect(supportCloseMeta(headers, "tenant_banner")).toEqual({ channel: "tenant_banner", ipAddress: "203.0.113.9", userAgent: "UA" });
    expect(supportCloseMeta(new Headers(), "x")).toEqual({ channel: "x", ipAddress: "unknown", userAgent: null });
  });
});

describe("supportSessionRemainingMs — the countdown runs on the server's clock", () => {
  const serverNow = "2026-09-25T12:00:00.000Z";
  const expiresAt = "2026-09-25T12:30:00.000Z";

  it("counts down from the server's render time, not the component's mount", () => {
    const renderedAt = new Date(serverNow).getTime();
    expect(supportSessionRemainingMs(expiresAt, serverNow, renderedAt, renderedAt)).toBe(30 * 60_000);
    expect(supportSessionRemainingMs(expiresAt, serverNow, renderedAt, renderedAt + 10 * 60_000)).toBe(20 * 60_000);
  });

  it("corrects a browser clock that is off", () => {
    // The browser thinks it is 12:05 when the server said 12:00.
    const renderedAt = new Date("2026-09-25T12:05:00.000Z").getTime();
    expect(supportSessionRemainingMs(expiresAt, serverNow, renderedAt, renderedAt)).toBe(30 * 60_000);
  });

  it("never goes below zero", () => {
    const renderedAt = new Date(serverNow).getTime();
    expect(supportSessionRemainingMs(expiresAt, serverNow, renderedAt, renderedAt + 60 * 60_000)).toBe(0);
  });
});
