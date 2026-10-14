/**
 * Issue #854 follow-up (F10) — a sign-out only reports success when the
 * server confirmed it.
 */
import { describe, expect, it, vi } from "vitest";
import { requestSignOut, signOutFailureMessage } from "./sign-out";

describe("requestSignOut", () => {
  it("is a success only for a 2xx answer from the logout route", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await expect(requestSignOut(fetchImpl as unknown as typeof fetch)).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST", cache: "no-store" }),
    );
  });

  it("reports a non-2xx answer as a server failure, not a sign-out", async () => {
    for (const status of [500, 502, 503, 403]) {
      const fetchImpl = vi.fn(async () => new Response("<html>bad gateway</html>", { status }));
      await expect(requestSignOut(fetchImpl as unknown as typeof fetch)).resolves.toEqual({
        ok: false,
        reason: "server",
      });
    }
  });

  it("reports a rejected request (offline, aborted) as a network failure", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(requestSignOut(offline as unknown as typeof fetch)).resolves.toEqual({
      ok: false,
      reason: "network",
    });
    const aborted = vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(requestSignOut(aborted as unknown as typeof fetch)).resolves.toEqual({
      ok: false,
      reason: "network",
    });
  });

  it("tells the member, in Persian, that they may still be signed in", () => {
    expect(signOutFailureMessage("network")).toMatch(/نشست شما هنوز باز است/);
    expect(signOutFailureMessage("server")).toMatch(/ممکن است هنوز باز باشد/);
  });
});
