import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verify: vi.fn() }));

vi.mock("./jwt-secret", () => ({
  getRealmSecret: vi.fn(),
  verifyWithRealmSecret: mocks.verify,
}));
vi.mock("./db", () => ({
  getPool: vi.fn(),
  query: vi.fn(),
  withoutTenantScope: vi.fn(),
}));

import { verifyMfaPendingToken } from "./mfa-service";

const validTelegramPending = {
  realm: "mfa",
  sub: "platform-user-1",
  method: "totp",
  authRealm: "tenant_telegram",
  businessId: "business-1",
  primaryAuth: "telegram",
  telegramIdentityLinkId: "123e4567-e89b-42d3-a456-426614174000",
  telegramIdentityGeneration: 2,
  telegramTokenVersion: 7,
};

beforeEach(() => mocks.verify.mockReset());

describe("Telegram-primary MFA pending token contract", () => {
  it("accepts only a complete signed link, identity version, tenant and Telegram primary factor", async () => {
    mocks.verify.mockResolvedValue(validTelegramPending);
    await expect(verifyMfaPendingToken("signed-pending-token")).resolves.toMatchObject({
      authRealm: "tenant_telegram",
      primaryAuth: "telegram",
      businessId: "business-1",
      telegramIdentityGeneration: 2,
      telegramTokenVersion: 7,
    });
    expect(mocks.verify).toHaveBeenCalledWith("signed-pending-token", "mfa");
  });

  it.each([
    { ...validTelegramPending, primaryAuth: "password" },
    { ...validTelegramPending, telegramIdentityLinkId: "not-a-uuid" },
    { ...validTelegramPending, telegramIdentityGeneration: 0 },
    { ...validTelegramPending, telegramTokenVersion: -1 },
    { ...validTelegramPending, businessId: undefined },
  ])("rejects incomplete or contradictory Telegram claims", async (payload) => {
    mocks.verify.mockResolvedValue(payload);
    await expect(verifyMfaPendingToken("signed-pending-token")).resolves.toBeNull();
  });

  it("does not let password MFA tokens carry Telegram identity claims", async () => {
    mocks.verify.mockResolvedValue({
      realm: "mfa",
      sub: "platform-user-1",
      method: "totp",
      authRealm: "tenant_password",
      primaryAuth: "password",
      telegramIdentityLinkId: validTelegramPending.telegramIdentityLinkId,
    });
    await expect(verifyMfaPendingToken("signed-pending-token")).resolves.toBeNull();
  });
});
