import { describe, expect, it, vi } from "vitest";
import { syncMembershipIdentity } from "@/lib/membership-identity-sync";

// The mirror helper is the single shared SQL both the super-admin owner-profile
// edit and the cloud credential replication use to copy an identity's email/phone
// onto every `users` membership row. Its own SQL is asserted here; the callers'
// tests assert only that they invoke it.

function fakeClient() {
  return { query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] })) };
}

describe("syncMembershipIdentity", () => {
  it("writes users.email for every membership of the identity", async () => {
    const q = fakeClient().query;
    const client = { query: q };
    await syncMembershipIdentity(client, "pu-9", { email: "mirror@ex.com" });
    expect(q).toHaveBeenCalledTimes(1);
    const [sql, params] = q.mock.calls[0];
    expect(sql).toContain("UPDATE users");
    expect(sql).toContain("SET email = $2");
    expect(sql).toContain("WHERE platform_user_id = $1");
    expect(params).toEqual(["pu-9", "mirror@ex.com"]);
  });

  it("clears membership email for an accepted phone-only identity", async () => {
    const client = fakeClient();
    await syncMembershipIdentity(client, "pu-9", { email: null });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("SET email = $2"), ["pu-9", null]);
  });

  it("writes users.phone_e164 and drops verification", async () => {
    const q = fakeClient().query;
    const client = { query: q };
    await syncMembershipIdentity(client, "pu-9", { phoneE164: "+989121234567" });
    expect(q).toHaveBeenCalledTimes(1);
    const [sql, params] = q.mock.calls[0];
    expect(sql).toContain("SET phone_e164 = $2, phone_verified_at = NULL");
    expect(params).toEqual(["pu-9", "+989121234567"]);
  });

  it("clears the phone when null", async () => {
    const q = fakeClient().query;
    const client = { query: q };
    await syncMembershipIdentity(client, "pu-9", { phoneE164: null });
    expect(q).toHaveBeenCalledTimes(1);
    const [sql, params] = q.mock.calls[0];
    expect(sql).toContain("phone_e164 = $2");
    expect(params).toEqual(["pu-9", null]);
  });

  it("emits one statement per field and rethrows a unique violation to the caller", async () => {
    const q = fakeClient().query;
    const client = { query: q };
    await syncMembershipIdentity(client, "pu-9", {
      email: "a@b.com",
      phoneE164: "+989121234567",
    });
    expect(q).toHaveBeenCalledTimes(2);

    const q2 = fakeClient().query;
    q2.mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "23505" }));
    await expect(
      syncMembershipIdentity({ query: q2 }, "pu-9", { email: "c@d.com" }),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
