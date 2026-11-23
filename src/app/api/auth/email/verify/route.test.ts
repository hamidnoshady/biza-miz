import { beforeEach, describe, expect, it, vi } from "vitest";

const consumeEmailVerification = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iam/identity-credentials", () => ({ consumeEmailVerification }));

import { POST } from "./route";

function request(body: unknown) {
  return new Request("http://localhost/api/auth/email/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => consumeEmailVerification.mockReset());

describe("email proof redemption", () => {
  it("requires a bounded token", async () => {
    expect((await POST(request({}))).status).toBe(400);
    expect((await POST(request({ token: "x".repeat(300) }))).status).toBe(400);
    expect(consumeEmailVerification).not.toHaveBeenCalled();
  });

  it("returns a generic success and never echoes the address", async () => {
    consumeEmailVerification.mockResolvedValue({
      ok: true,
      platformUserId: "11111111-1111-4111-8111-111111111111",
      email: "person@example.invalid",
    });
    const response = await POST(request({ token: "a".repeat(43) }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("refuses an expired, spent, unknown or address-changed proof", async () => {
    consumeEmailVerification.mockResolvedValue({ ok: false, error: "invalid_token" });
    const response = await POST(request({ token: "a".repeat(43) }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_token" });
  });
});
