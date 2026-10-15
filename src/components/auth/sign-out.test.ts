/**
 * Issue #854 follow-up (F10 + logout) — a sign-out only reports success when
 * the server confirmed it, and an unconfirmed one is finished through the
 * retry route, never by a second plain sign-out.
 */
import { describe, expect, it, vi } from "vitest";
import { requestSignOut, retrySignOut, signOutAgain, signOutDestination } from "./sign-out";

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
    for (const outcome of ["revoked", "already_ended", "no_session"]) {
      await expect(
        requestSignOut(answer(200, confirmed(outcome)) as unknown as typeof fetch),
      ).resolves.toEqual({ kind: "signed_out", outcome });
    }
  });

  it("no longer knows `not_tracked`: every session has a server record to end since the third pass", async () => {
    await expect(
      requestSignOut(answer(200, confirmed("not_tracked")) as unknown as typeof fetch),
    ).resolves.toEqual({ kind: "server" });
  });

  it("carries the server's destination — a support operator goes back to the console", async () => {
    const path = "/platform/businesses/7198892a-cca7-4e29-80a1-ff9f5f64fa97/support";
    await expect(
      requestSignOut(answer(200, { ...confirmed("revoked"), redirectTo: path }) as unknown as typeof fetch),
    ).resolves.toEqual({ kind: "signed_out", outcome: "revoked", redirectTo: path });
    await expect(
      requestSignOut(answer(503, { ...unconfirmed, redirectTo: path }) as unknown as typeof fetch),
    ).resolves.toEqual({
      kind: "unconfirmed",
      pendingRevocations: 1,
      sessionCookieCleared: true,
      redirectTo: path,
    });
  });

  it("never follows a destination that leaves the origin", async () => {
    for (const redirectTo of [
      "https://evil.example/login",
      "//evil.example/login",
      "/\\evil.example",
      "/%2F%2Fevil.example",
      "javascript:alert(1)",
      "platform/businesses/x/support",
      "/line\nbreak",
      42,
      null,
    ]) {
      await expect(
        requestSignOut(answer(200, { ...confirmed("revoked"), redirectTo }) as unknown as typeof fetch),
        String(redirectTo),
      ).resolves.toEqual({ kind: "signed_out", outcome: "revoked" });
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

  it("a retry keeps the first answer's destination: the retry route never names one", async () => {
    const previous = {
      kind: "unconfirmed",
      pendingRevocations: 1,
      sessionCookieCleared: true,
      redirectTo: "/platform/businesses/b/support",
    } as const;
    const finished = answer(200, { ...confirmed("revoked"), sessionCookieCleared: false });
    await expect(signOutAgain(previous, finished as unknown as typeof fetch)).resolves.toEqual({
      kind: "signed_out",
      outcome: "revoked",
      redirectTo: "/platform/businesses/b/support",
    });
    const stillFailing = answer(503, { ...unconfirmed, sessionCookieCleared: false });
    await expect(signOutAgain(previous, stillFailing as unknown as typeof fetch)).resolves.toMatchObject({
      kind: "unconfirmed",
      redirectTo: "/platform/businesses/b/support",
    });
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

describe("signOutDestination", () => {
  it("is the server's destination when it named one, otherwise the caller's", () => {
    expect(
      signOutDestination({ kind: "signed_out", outcome: "revoked", redirectTo: "/platform/businesses/b/support" }, "/login"),
    ).toBe("/platform/businesses/b/support");
    expect(
      signOutDestination(
        { kind: "unconfirmed", pendingRevocations: 1, sessionCookieCleared: true, redirectTo: "/platform/businesses/b/support" },
        "/login",
      ),
    ).toBe("/platform/businesses/b/support");
    expect(signOutDestination({ kind: "signed_out", outcome: "revoked" }, "/login?changeAccount=1")).toBe(
      "/login?changeAccount=1",
    );
    expect(signOutDestination({ kind: "server" }, "/login")).toBe("/login");
    expect(signOutDestination({ kind: "network" }, "/login")).toBe("/login");
  });
});
