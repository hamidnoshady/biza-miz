import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../integrations/secrets";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withoutTenantScope: vi.fn(async (_reason: string, fn: () => Promise<unknown>) => fn()),
  withoutTenantScopeTransaction: vi.fn(
    async (_reason: string, fn: () => Promise<unknown>) => fn(),
  ),
  getMasterKey: vi.fn(),
}));

vi.mock("../db", () => ({
  query: mocks.query,
  withoutTenantScope: mocks.withoutTenantScope,
  withoutTenantScopeTransaction: mocks.withoutTenantScopeTransaction,
}));

vi.mock("../master-key", () => ({
  getMasterKey: mocks.getMasterKey,
}));

import {
  nationalIdBlindIndex,
  normalizeNationalId,
  readNationalId,
  setNationalId,
} from "./identity-profile";

const KEY_A = Buffer.from(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "hex",
);
const KEY_B = Buffer.from(
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
  "hex",
);

describe("normalizeNationalId", () => {
  it("normalizes Persian and Arabic-Indic digits and validates the check digit", () => {
    expect(normalizeNationalId("0012345679")).toBe("0012345679");
    expect(normalizeNationalId("۰۰۱۲۳۴۵۶۷۹")).toBe("0012345679");
    expect(normalizeNationalId("٠٠١٢٣٤٥٦٧٩")).toBe("0012345679");
    expect(normalizeNationalId("0012345678")).toBeNull();
    expect(normalizeNationalId("1111111111")).toBeNull();
    expect(normalizeNationalId("12345")).toBeNull();
    expect(normalizeNationalId(null)).toBeNull();
  });

  it("computes a deterministic domain-separated blind index", () => {
    const a = nationalIdBlindIndex("0012345679", KEY_A);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(nationalIdBlindIndex("0012345679", KEY_A)).toBe(a);
    expect(nationalIdBlindIndex("0012345679", KEY_B)).not.toBe(a);
  });
});

describe("readNationalId & setNationalId fail-closed behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses unauthorized callers without touching the database", async () => {
    expect(
      await readNationalId({ platformUserId: "u-1", actorPlatformUserId: "u-2" }),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(mocks.query).not.toHaveBeenCalled();

    expect(
      await setNationalId({
        platformUserId: "u-1",
        nationalId: "0012345679",
        actorPlatformUserId: "u-2",
      }),
    ).toEqual({ ok: false, error: "forbidden" });
  });

  it("executes both the ciphertext read and audit insert inside withoutTenantScopeTransaction", async () => {
    mocks.getMasterKey.mockReturnValue(KEY_A);
    const envelope = encryptSecret("0012345679", KEY_A);
    mocks.query
      .mockResolvedValueOnce({ rows: [{ national_id_ciphertext: envelope }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await readNationalId({
      platformUserId: "u-1",
      actorPlatformUserId: "u-1",
    });

    expect(res).toEqual({ ok: true, nationalId: "0012345679" });
    expect(mocks.withoutTenantScopeTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.withoutTenantScopeTransaction).toHaveBeenCalledWith(
      "identity",
      expect.any(Function),
    );
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it("fails closed with encryption_unavailable when envelope cannot be decrypted under current key, without echoing ciphertext", async () => {
    const wrongEnvelope = encryptSecret("0012345679", KEY_B);
    mocks.getMasterKey.mockReturnValue(KEY_A);
    mocks.query.mockResolvedValueOnce({ rows: [{ national_id_ciphertext: wrongEnvelope }] });

    const res = await readNationalId({
      platformUserId: "u-1",
      actorPlatformUserId: "u-1",
    });

    expect(res).toEqual({ ok: false, error: "encryption_unavailable" });
    expect(JSON.stringify(res)).not.toContain(wrongEnvelope);
    expect(JSON.stringify(res)).not.toContain("0012345679");
    // No national_id_read event is recorded when decryption failed.
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
});
