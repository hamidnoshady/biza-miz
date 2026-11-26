import { afterEach, describe, expect, it, vi } from "vitest";

// Unit coverage for the owner-profile identity mirror. The DB-backed cases
// (real mirror rows, the rehire-after-email-change regression) live in the
// integration suite; here we pin the *wiring*: that an identity edit also
// invokes the membership mirror inside the same transaction, and that a
// per-business unique clash rolls back to the right refusal.

// A controllable pool/client pair so the function can run without Postgres.
const clientQuery = vi.fn();
const poolQuery = vi.fn();
const fakeClient = {
  query: clientQuery,
  release: vi.fn(),
};

vi.mock("@/lib/db", () => ({
  getPool: () => ({
    query: poolQuery,
    connect: async () => fakeClient,
  }),
  // listBusinessOwnerProfiles runs inside this; just run the inner fn.
  withoutTenantScope: async (_reason: string, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("@/lib/membership-lock", () => ({
  lockMembership: vi.fn(async () => {}),
}));

// The mirror helper is mocked so we can assert the *call*, not re-test its SQL
// (covered in membership-identity-sync.test.ts). The real helper is what writes the
// `users` rows; both writers route through it.
const syncMembershipIdentity = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@/lib/membership-identity-sync", () => ({
  syncMembershipIdentity: (...args: unknown[]) => syncMembershipIdentity(...args),
}));

import { updateBusinessOwnerProfile } from "@/lib/platform-owner-profile";

const BUSINESS = "biz-1";
const MEMBERSHIP = "m-1";
const IDENTITY = "pu-1";

function memberRow(overrides: Record<string, unknown> = {}) {
  return {
    membership_id: MEMBERSHIP,
    role: "owner",
    full_name: "Owner One",
    membership_email: "old@ex.com",
    membership_phone: "+989120000000",
    is_active: true,
    created_at: new Date("2026-01-01T00:00:00Z"),
    location_id: null,
    location_name: null,
    platform_user_id: IDENTITY,
    email: "old@ex.com",
    identity_active: true,
    last_login_at: null,
    identity_created_at: new Date("2025-12-01T00:00:00Z"),
    membership_count: "1",
    ...overrides,
  };
}

function mfaRow(overrides: Record<string, unknown> = {}) {
  return {
    subject_id: IDENTITY,
    method: "sms_otp",
    phone_e164: "+989120000000",
    confirmed_at: new Date("2026-01-02T00:00:00Z"),
    grace_until: null,
    recovery_codes_remaining: "2",
    ...overrides,
  };
}

function reset() {
  vi.clearAllMocks();
  clientQuery.mockImplementation(async (sql: unknown) => {
    if (typeof sql === "string" && sql.includes("FOR UPDATE")) {
      return { rows: [{ id: MEMBERSHIP, platform_user_id: IDENTITY, is_active: true }] };
    }
    return { rows: [] };
  });
  poolQuery.mockImplementation(async (sql: unknown) => {
    if (typeof sql === "string" && sql.includes("u.role::text = ANY")) {
      return { rows: [memberRow()] };
    }
    if (typeof sql === "string" && sql.includes("mfa_enrolments e")) {
      return { rows: [mfaRow()] };
    }
    if (typeof sql === "string" && sql.includes("mu.platform_user_id = ANY")) {
      return { rows: [] };
    }
    return { rows: [] };
  });
  syncMembershipIdentity.mockResolvedValue(undefined);
}

afterEach(() => reset());

describe("updateBusinessOwnerProfile identity mirror", () => {
  it("an email change mirrors onto every membership of the identity in the same transaction", async () => {
    reset();
    const result = await updateBusinessOwnerProfile(BUSINESS, {
      membershipId: MEMBERSHIP,
      email: "new@ex.com",
    });
    expect(result.ok).toBe(true);
    // The identity row was written…
    const platformUpdate = clientQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("UPDATE platform_users"),
    );
    expect(platformUpdate).toBeTruthy();
    expect(platformUpdate![1]).toEqual([IDENTITY, "new@ex.com"]);
    // …and the membership copy moved with it, via the shared helper.
    expect(syncMembershipIdentity).toHaveBeenCalledWith(
      fakeClient,
      IDENTITY,
      { email: "new@ex.com" },
    );
    // No rollback: the edit committed.
    expect(clientQuery.mock.calls.some((c: unknown[]) => c[0] === "ROLLBACK")).toBe(false);
    expect(clientQuery.mock.calls.some((c: unknown[]) => c[0] === "COMMIT")).toBe(true);
  });

  it("a per-business email collision rolls back and returns email_taken (no partial write)", async () => {
    reset();
    // The mirror write hits the per-business unique index.
    syncMembershipIdentity.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));
    const result = await updateBusinessOwnerProfile(BUSINESS, {
      membershipId: MEMBERSHIP,
      email: "taken@ex.com",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("email_taken");
    expect(clientQuery.mock.calls.some((c: unknown[]) => c[0] === "ROLLBACK")).toBe(true);
    expect(clientQuery.mock.calls.some((c: unknown[]) => c[0] === "COMMIT")).toBe(false);
    // The mirror was reached (it was the row that collided).
    expect(syncMembershipIdentity).toHaveBeenCalled();
  });

  it("a phone change stages the enrolment as unconfirmed/non-primary and mirrors the membership phone", async () => {
    reset();
    const result = await updateBusinessOwnerProfile(BUSINESS, {
      membershipId: MEMBERSHIP,
      phone: "+989129999999",
    });
    expect(result.ok).toBe(true);

    // The enrolment is written pending: unconfirmed, and explicitly non-primary
    // so it is not a live factor for a number nobody has proven.
    const upsert = clientQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("INSERT INTO mfa_enrolments"),
    );
    expect(upsert).toBeTruthy();
    expect(upsert![0]).toContain("is_primary = false");
    expect(upsert![0]).toContain("confirmed_at = NULL");

    // The membership copy moved too, verification dropped.
    expect(syncMembershipIdentity).toHaveBeenCalledWith(
      fakeClient,
      IDENTITY,
      { phoneE164: "+989129999999" },
    );
  });

  it("clearing the phone demotes the enrolment and clears the membership copy", async () => {
    reset();
    const result = await updateBusinessOwnerProfile(BUSINESS, {
      membershipId: MEMBERSHIP,
      phone: "",
    });
    expect(result.ok).toBe(true);
    const clear = clientQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("UPDATE mfa_enrolments"),
    );
    expect(clear).toBeTruthy();
    expect(clear![0]).toContain("phone_e164 = NULL");
    expect(clear![0]).toContain("confirmed_at = NULL");
    expect(clear![0]).toContain("is_primary = false");
    // Mirror to NULL — `users.phone_e164` is now empty on the tenant screens.
    expect(syncMembershipIdentity).toHaveBeenCalledWith(
      fakeClient,
      IDENTITY,
      { phoneE164: null },
    );
  });

  it("a per-business phone collision rolls back and returns phone_taken", async () => {
    reset();
    syncMembershipIdentity.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));
    const result = await updateBusinessOwnerProfile(BUSINESS, {
      membershipId: MEMBERSHIP,
      phone: "+989129999999",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("phone_taken");
    expect(clientQuery.mock.calls.some((c: unknown[]) => c[0] === "ROLLBACK")).toBe(true);
    expect(clientQuery.mock.calls.some((c: unknown[]) => c[0] === "COMMIT")).toBe(false);
  });
});
