/**
 * Issue #854 follow-up (F10 + logout) — a sign-out only reports success when
 * the server confirmed it, and an unconfirmed one is finished through the
 * retry route, never by a second plain sign-out.
 */
import { describe, expect, it, vi } from "vitest";
import { requestSignOut, retrySignOut, signOutAgain } from "./sign-out";

function answer(status: number, body: unknown) {
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": typeof body === "string" ? "text/html" : "application/json" },
      }),
  );
}

const confirmed = (outcome: string) => ({
  ok: true,
  outcome,
  sessionCookieCleared: true,
  pendingRevocations: 0,
});
const unconfirmed = {
  ok: false,
  outcome: "unconfirmed",
  sessionCookieCleared: true,
  pendingRevocations: 1,
  error: "logout_unconfirmed",
};

describe("requestSignOut", () => {
  it("posts to the sign-out route, uncached, and reads a confirmed outcome", async () => {
    const fetchImpl = answer(200, confirmed("revoked"));
    await expect(requestSignOut(fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      kind: "signed_out",
      outcome: "revoked",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST", cache: "no-store", credentials: "same-origin" }),
    );
  });

  it("reads every confirmed outcome as signed out", async () => {
    for (const outcome of ["revoked", "already_ended", "not_tracked", "no_session"]) {
      await expect(
        requestSignOut(answer(200, confirmed(outcome)) as unknown as typeof fetch),
      ).resolves.toEqual({ kind: "signed_out", outcome });
    }
  });

  it("reads the 503 contract as unconfirmed — the cookie is gone, the server side is not", async () => {
    await expect(requestSignOut(answer(503, unconfirmed) as unknown as typeof fetch)).resolves.toEqual({
      kind: "unconfirmed",
      pendingRevocations: 1,
      sessionCookieCleared: true,
    });
  });

  it("reads middleware's 401 (no valid session at all) as already signed out", async () => {
    await expect(
      requestSignOut(answer(401, { error: "unauthorized" }) as unknown as typeof fetch),
    ).resolves.toEqual({ kind: "signed_out", outcome: "no_session" });
  });

  it("reports an answer that is not the contract as a server failure, not a sign-out", async () => {
    for (const [status, body] of [
      [500, { error: "internal" }],
      [502, "<html>bad gateway</html>"],
      [200, { ok: true }],
      [403, { error: "bad_origin" }],
    ] as const) {
      await expect(requestSignOut(answer(status, body) as unknown as typeof fetch)).resolves.toEqual({
        kind: "server",
      });
    }
  });

  it("reports a rejected request (offline, aborted) as a network failure", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(requestSignOut(offline as unknown as typeof fetch)).resolves.toEqual({ kind: "network" });
    const aborted = vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(requestSignOut(aborted as unknown as typeof fetch)).resolves.toEqual({ kind: "network" });
  });
});

describe("retrySignOut / signOutAgain", () => {
  it("retrySignOut posts to the retry route with no body", async () => {
    const fetchImpl = answer(200, { ...confirmed("revoked"), sessionCookieCleared: false });
    await expect(retrySignOut(fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      kind: "signed_out",
      outcome: "revoked",
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/auth/logout/retry");
    expect(init?.body).toBeUndefined();
  });

  it("after an unconfirmed end, the next attempt is the retry route — never a second plain sign-out", async () => {
    const fetchImpl = answer(200, { ...confirmed("revoked"), sessionCookieCleared: false });
    await signOutAgain(
      { kind: "unconfirmed", pendingRevocations: 1, sessionCookieCleared: true },
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/auth/logout/retry");
  });

  it("after a network or server failure, the next attempt is the plain sign-out again", async () => {
    for (const previous of [{ kind: "network" }, { kind: "server" }, null] as const) {
      const fetchImpl = answer(200, confirmed("revoked"));
      await signOutAgain(previous, fetchImpl as unknown as typeof fetch);
      expect(fetchImpl.mock.calls[0][0]).toBe("/api/auth/logout");
    }
  });

  it("a retry that fails stays unconfirmed with the cookie still counted as cleared", async () => {
    const previous = { kind: "unconfirmed", pendingRevocations: 2, sessionCookieCleared: true } as const;
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(signOutAgain(previous, offline as unknown as typeof fetch)).resolves.toEqual(previous);
    // The retry route answers unconfirmed with `sessionCookieCleared: false`
    // (it never touches the cookie) — the browser is still the one that left.
    const again = answer(503, { ...unconfirmed, sessionCookieCleared: false });
    await expect(signOutAgain(previous, again as unknown as typeof fetch)).resolves.toEqual({
      kind: "unconfirmed",
      pendingRevocations: 1,
      sessionCookieCleared: true,
    });
  });
});
