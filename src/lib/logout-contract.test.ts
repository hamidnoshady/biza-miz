/**
 * Issue #854 follow-up — the one reading of a sign-out answer every surface
 * shares.
 */
import { describe, expect, it } from "vitest";
import {
  browserSignedOut,
  LOGOUT_MESSAGES,
  LOGOUT_OUTCOMES,
  readLogoutResponse,
  signOutResultMessage,
} from "./logout-contract";

describe("readLogoutResponse", () => {
  it("reads every confirmed outcome as signed out", () => {
    for (const outcome of LOGOUT_OUTCOMES.filter((o) => o !== "unconfirmed")) {
      expect(
        readLogoutResponse(200, { ok: true, outcome, sessionCookieCleared: true, pendingRevocations: 0 }),
      ).toEqual({ kind: "signed_out", outcome });
    }
  });

  it("reads `ok: false` as unconfirmed whatever outcome rides along", () => {
    expect(
      readLogoutResponse(503, {
        ok: false,
        outcome: "revoked",
        sessionCookieCleared: true,
        pendingRevocations: 2,
      }),
    ).toEqual({ kind: "unconfirmed", pendingRevocations: 2, sessionCookieCleared: true });
  });

  it("never reports zero pending for an unconfirmed answer", () => {
    expect(
      readLogoutResponse(503, { ok: false, outcome: "unconfirmed", sessionCookieCleared: false }),
    ).toEqual({ kind: "unconfirmed", pendingRevocations: 1, sessionCookieCleared: false });
  });

  it("reads middleware's bare 401 as no session, and nothing else as one", () => {
    expect(readLogoutResponse(401, { error: "unauthorized" })).toEqual({
      kind: "signed_out",
      outcome: "no_session",
    });
    expect(readLogoutResponse(401, { error: "something_else" })).toEqual({ kind: "server" });
    expect(readLogoutResponse(401, null)).toEqual({ kind: "server" });
  });

  it("does not trust a shape that is not the contract", () => {
    expect(readLogoutResponse(200, { ok: true })).toEqual({ kind: "server" });
    expect(readLogoutResponse(200, { ok: true, outcome: "done" })).toEqual({ kind: "server" });
    expect(readLogoutResponse(200, "ok")).toEqual({ kind: "server" });
    expect(readLogoutResponse(502, null)).toEqual({ kind: "server" });
  });
});

describe("browserSignedOut / signOutResultMessage", () => {
  it("lets a caller leave only once this browser is signed out", () => {
    expect(browserSignedOut({ kind: "signed_out", outcome: "revoked" })).toBe(true);
    expect(browserSignedOut({ kind: "unconfirmed", pendingRevocations: 1, sessionCookieCleared: true })).toBe(
      true,
    );
    expect(
      browserSignedOut({ kind: "unconfirmed", pendingRevocations: 1, sessionCookieCleared: false }),
    ).toBe(false);
    expect(browserSignedOut({ kind: "network" })).toBe(false);
    expect(browserSignedOut({ kind: "server" })).toBe(false);
  });

  it("has a Persian message for every result that is not a clean sign-out", () => {
    expect(signOutResultMessage({ kind: "signed_out", outcome: "revoked" })).toBeNull();
    expect(
      signOutResultMessage({ kind: "unconfirmed", pendingRevocations: 1, sessionCookieCleared: true }),
    ).toBe(LOGOUT_MESSAGES.unconfirmed);
    expect(signOutResultMessage({ kind: "network" })).toMatch(/نشست شما هنوز باز است/);
    expect(signOutResultMessage({ kind: "server" })).toMatch(/ممکن است هنوز باز باشد/);
    // The unconfirmed case says both halves: out of this device, server unconfirmed.
    expect(LOGOUT_MESSAGES.unconfirmed).toMatch(/از این دستگاه خارج شدید/);
    expect(LOGOUT_MESSAGES.unconfirmed).toMatch(/تأیید نکرد/);
  });
});
