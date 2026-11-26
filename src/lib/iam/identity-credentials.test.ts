import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withoutTenantScope: vi.fn(async (_reason: string, fn: () => Promise<unknown>) => fn()),
  withoutTenantScopeTransaction: vi.fn(
    async (_reason: string, fn: () => Promise<unknown>) => fn(),
  ),
}));

vi.mock("../db", () => ({
  query: mocks.query,
  withoutTenantScope: mocks.withoutTenantScope,
  withoutTenantScopeTransaction: mocks.withoutTenantScopeTransaction,
}));

import { normalizeIdentityEmail, setIdentityEmail } from "./identity-credentials";

describe("normalizeIdentityEmail", () => {
  it("lowercases and trims valid addresses and rejects malformed ones", () => {
    expect(normalizeIdentityEmail("  Owner@Example.COM ")).toBe("owner@example.com");
    expect(normalizeIdentityEmail("")).toBeNull();
    expect(normalizeIdentityEmail("not-an-email")).toBeNull();
    expect(normalizeIdentityEmail("bad space@example.com")).toBeNull();
  });
});

describe("setIdentityEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses another person", async () => {
    expect(
      await setIdentityEmail({
        platformUserId: "u-1",
        actorPlatformUserId: "u-2",
        email: "new@example.com",
      }),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("refuses clearing email when the identity has no phone_e164 (credential_channel_required)", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ email: "only@example.com", phone_e164: null }],
    });

    const result = await setIdentityEmail({
      platformUserId: "u-1",
      actorPlatformUserId: "u-1",
      email: null,
    });

    expect(result).toEqual({ ok: false, error: "credential_channel_required" });
    // Locked SELECT ran, but UPDATE must not be attempted.
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("allows clearing email when a phone_e164 channel remains on the identity", async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ email: "both@example.com", phone_e164: "+989121234567" }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await setIdentityEmail({
      platformUserId: "u-1",
      actorPlatformUserId: "u-1",
      email: null,
    });

    expect(result).toEqual({ ok: true, email: null, changed: true });
    expect(mocks.query).toHaveBeenCalledTimes(3);
  });
});
