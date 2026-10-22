import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1006 follow-up:
 *  - a 23505 unique violation inside an inSavepoint must NOT abort the outer
 *    transaction (the retry loop absorbs it and tries the next slot).
 *  - if ensurePersonnelFileForMembership throws inside createMembership,
 *    ROLLBACK must fire so there is no half-created member.
 */
vi.mock("@/lib/personnel-file", () => ({
  ensurePersonnelFileForMembership: vi.fn(),
}));

// Pin getPool to a stub client we control so we can observe BEGIN/COMMIT/ROLLBACK
// without a real database.
const clientQuery = vi.fn();
const BEGIN = vi.fn();
const COMMIT = vi.fn();
const ROLLBACK = vi.fn();
const release = vi.fn();
const fakeClient = {
  query: vi.fn(async (sql: string) => {
    if (sql.trim().startsWith("BEGIN")) return BEGIN();
    if (sql.trim().startsWith("COMMIT")) return COMMIT();
    if (sql.trim().startsWith("ROLLBACK")) return ROLLBACK();
    return clientQuery(sql);
  }),
  release,
};
vi.mock("@/lib/db", () => ({
  getPool: () => ({ connect: vi.fn(async () => fakeClient) }),
  pinToClient: async (_c: unknown, fn: () => Promise<unknown>) => fn(),
  query: vi.fn(),
  withTenantTransaction: async (_b: string, fn: () => Promise<unknown>) => fn(),
}));

// Stub heavy side-effect modules the real team-service pulls in.
vi.mock("bcryptjs", () => ({ default: { hash: async () => "h", compare: async () => true } }));
vi.mock("@/lib/password-hashing", () => ({ BCRYPT_COST: 4 }));
vi.mock("@/lib/deployment-mode", () => ({ readDeploymentProfile: async () => ({ profile: "local" }) }));
vi.mock("@/lib/iam/service", () => ({ appendIamEvent: async () => {} }));
vi.mock("@/lib/iam/site-policy", () => ({ restrictSiteMember: async () => {} }));
vi.mock("@/lib/entitlement-service", () => ({
  resolveLimitCeiling: async () => ({ limit: null, source: "plan" }),
}));
vi.mock("@/lib/membership-authority", () => ({
  isPasswordRole: () => false,
  isPinRole: (r: string) => r === "waiter",
  canonicalizeRole: (r: string) => r,
  canonicalizeCustomRoleId: (x: unknown) => x,
  defaultPolicyForRole: () => ({ scope: "all", basis: "role" }),
  sortOverrides: () => ({ granted: [], revoked: [] }),
  validateAccessChangeReason: () => ({ ok: true, reason: null }),
  loadCustomRole: async () => null,
  membershipGrantRefusal: async () => null,
  projectGrantedPermissions: () => [],
  resolveMembershipAuthority: async () => ({}),
  activeMemberCount: async () => 0,
  lockMembership: async () => {},
  lockPlatformIdentity: async () => {},
  maySelfServiceWrite: () => true,
}));

import { createMembership } from "@/lib/team-service";
import { ensurePersonnelFileForMembership } from "@/lib/personnel-file";

function reset() {
  vi.clearAllMocks();
  clientQuery.mockImplementation(async (sql: string) => {
    if (typeof sql === "string") {
      if (sql.includes("INSERT INTO")) return { rows: [{ id: "p-1", user_id: "u-1" }], rowCount: 1 };
      if (sql.includes("user_id") || sql.includes("SELECT")) return { rows: [{ id: "p-1", user_id: "u-1" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  BEGIN.mockResolvedValue({});
  COMMIT.mockResolvedValue({});
  ROLLBACK.mockResolvedValue({});
  release.mockResolvedValue(undefined);
  (ensurePersonnelFileForMembership as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    fileId: "f-1",
  });
}

describe("createMembership atomicity", () => {
  afterEach(() => reset());

  it("COMMITs when the in-tx personnel-file projection succeeds", async () => {
    reset();
    const r = await createMembership({
      businessId: "biz-1",
      role: "waiter",
      fullName: "کارمند",
      pin: "1234",
      actorId: null,
    });
    expect(r.userId).toBeTruthy();
    expect(ROLLBACK).not.toHaveBeenCalled();
    expect(COMMIT).toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it("ROLLBACKs and releases when the in-tx personnel-file projection throws (no half-created member)", async () => {
    reset();
    (ensurePersonnelFileForMembership as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    await expect(
      createMembership({
        businessId: "biz-1",
        role: "waiter",
        fullName: "کارمند",
        pin: "1234",
        actorId: null,
      }),
    ).rejects.toThrow("boom");
    expect(COMMIT).not.toHaveBeenCalled();
    expect(ROLLBACK).toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });
});
