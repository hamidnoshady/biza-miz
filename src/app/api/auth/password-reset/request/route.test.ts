import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Issue #885 L10 — the forgotten-password endpoint's response contract.
 *
 * This route is pre-session and takes an email address, which makes it a
 * perfect account-existence oracle: ask whether any address has an account,
 * one request at a time, for free. The only defence is that every outcome
 * produces the same response, so that is what is asserted here — status *and*
 * body, for every branch the service can return.
 *
 * Matching only the status would not be enough. A differing `error` or
 * `message` field, or a different key set, is just as readable an oracle as a
 * different status code.
 */

const mocks = vi.hoisted(() => ({
  requestPlatformUserPasswordReset: vi.fn(),
}));

vi.mock("@/lib/password-reset-request", () => ({
  requestPlatformUserPasswordReset: mocks.requestPlatformUserPasswordReset,
}));

import { POST } from "./route";

function request(body: unknown, raw = false): NextRequest {
  return new NextRequest("http://test.local/api/auth/password-reset/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

const EMAIL = "manager@example.com";

beforeEach(() => {
  mocks.requestPlatformUserPasswordReset.mockClear();
});

describe("non-enumeration (L10)", () => {
  /** Every outcome the service can produce. */
  const outcomes = [
    { outcome: "sent", subjectId: "11111111-1111-4111-8111-111111111111" },
    { outcome: "unknown_email" },
    { outcome: "inactive" },
    { outcome: "rate_limited", retryAfterMs: 120_000 },
    { outcome: "not_configured", reason: "no_transport" },
    { outcome: "not_configured", reason: "no_base_url" },
  ] as const;

  it("answers every outcome with an identical status and body", async () => {
    const responses = [];
    for (const outcome of outcomes) {
      mocks.requestPlatformUserPasswordReset.mockResolvedValue({ ...outcome });
      const res = await POST(request({ email: EMAIL }));
      responses.push({ status: res.status, body: await res.json() });
    }

    // One shape, six ways. If any branch drifted, this names it.
    const first = JSON.stringify(responses[0]);
    for (const [i, r] of responses.entries()) {
      expect(JSON.stringify(r), `outcome ${outcomes[i].outcome} diverged`).toBe(first);
    }

    expect(responses[0].status).toBe(200);
    expect(responses[0].body).toEqual({
      ok: true,
      message:
        "اگر این نشانی در سامانه ثبت شده باشد، پیوند بازنشانی رمز عبور برایش ارسال می‌شود.",
    });
  });

  it("does not leak a rate limit as a 429", async () => {
    // A 429 would be the most useful possible answer to an attacker: it
    // distinguishes an address that exists and has been used from one that
    // does not. The limit still applies — the service refuses to send — it is
    // simply not reported.
    mocks.requestPlatformUserPasswordReset.mockResolvedValue({
      outcome: "rate_limited",
      retryAfterMs: 120_000,
    });
    const res = await POST(request({ email: EMAIL }));

    expect(res.status).toBe(200);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(JSON.stringify(await res.json())).not.toContain("rate");
  });

  it("does not echo the outcome back to the caller", async () => {
    mocks.requestPlatformUserPasswordReset.mockResolvedValue({
      outcome: "unknown_email",
    });
    const body = JSON.stringify(await (await POST(request({ email: EMAIL }))).json());

    // None of the internal distinctions may appear in the response.
    expect(body).not.toContain("unknown");
    expect(body).not.toContain("inactive");
    expect(body).not.toContain("not_configured");
    expect(body).not.toContain("sent");
  });

  it("passes the canonical address to the service", async () => {
    mocks.requestPlatformUserPasswordReset.mockResolvedValue({ outcome: "unknown_email" });
    await POST(request({ email: "  Manager@Example.COM  " }));

    // Lower-cased and trimmed once, here, so the rate-limit window and the
    // citext lookup cannot disagree about which address was asked for.
    expect(mocks.requestPlatformUserPasswordReset).toHaveBeenCalledWith(EMAIL);
  });
});

describe("input validation", () => {
  it("refuses a malformed address with 400", async () => {
    // Not an enumeration leak: the caller supplied the string, so refusing it
    // reveals nothing about any account.
    for (const bad of ["not-an-email", "a@b", "@example.com", "a b@example.com"]) {
      mocks.requestPlatformUserPasswordReset.mockClear();
      const res = await POST(request({ email: bad }));

      expect(res.status, `for ${bad}`).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_email" });
      expect(mocks.requestPlatformUserPasswordReset).not.toHaveBeenCalled();
    }
  });

  it("refuses a missing address with 400", async () => {
    const res = await POST(request({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_email" });
  });

  it("bounds the address instead of passing an arbitrary value through", async () => {
    const res = await POST(request({ email: `a${"b".repeat(300)}@example.com` }));
    expect(res.status).toBe(400);
    expect(mocks.requestPlatformUserPasswordReset).not.toHaveBeenCalled();
  });

  it("refuses a malformed body rather than throwing", async () => {
    const res = await POST(request("{not json", true));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });
});
