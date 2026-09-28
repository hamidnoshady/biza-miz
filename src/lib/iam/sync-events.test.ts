import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPool } from "../db";
import type { IamEvent } from "./model";
import { applyIamEvents } from "./sync";

vi.mock("../db", () => ({ getPool: vi.fn(), query: vi.fn() }));

const businessId = "10000000-0000-4000-8000-000000000001";
const siteDeviceId = "10000000-0000-4000-8000-000000000002";
const memberId = "10000000-0000-4000-8000-000000000003";
const roleId = "10000000-0000-4000-8000-000000000004";
let client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };

function event(sequence: number, eventType: IamEvent["eventType"], entityType: IamEvent["entityType"], entityId: string, payload: Record<string, unknown>): IamEvent {
  return { id: `10000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`, businessId, sequence, eventType, entityType, entityId, schemaVersion: 1, payload, actorUserId: null, origin: "cloud", createdAt: new Date(0).toISOString() };
}

beforeEach(() => {
  client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }), release: vi.fn() };
  vi.mocked(getPool).mockReturnValue({ connect: vi.fn().mockResolvedValue(client) } as never);
});

describe("incremental IAM event application", () => {
  it("applies role, custom-role, location and reactivation events without waiting for snapshot repair", async () => {
    const cursor = await applyIamEvents(businessId, siteDeviceId, 0, [
      event(1, "membership.system_role_changed", "membership", memberId, { revision: 2, changes: { role: "manager" } }),
      event(2, "membership.custom_role_changed", "membership", memberId, { revision: 3, changes: { customRoleId: roleId } }),
      event(3, "membership.locations_changed", "membership", memberId, { revision: 4, changes: { locationScope: "selected", defaultLocationId: null, locationIds: [siteDeviceId] } }),
      event(4, "membership.reactivated", "membership", memberId, { revision: 5 }),
    ]);

    expect(cursor).toBe(4);
    const sql = client.query.mock.calls.map(([statement]) => String(statement)).join("\n");
    expect(sql).toContain("custom_role_id=NULL");
    expect(sql).toContain("SET custom_role_id=$3");
    expect(sql).toContain("DELETE FROM user_locations");
    expect(sql).toContain("membership_status='active'");
    expect(client.query).toHaveBeenCalledWith("COMMIT");
  });

  it("upserts complete custom-role authority from an ordered role event", async () => {
    await applyIamEvents(businessId, siteDeviceId, 0, [event(1, "tenant_role.permissions_changed", "tenant_role", roleId, {
      revision: 7,
      role: { id: roleId, name: "Shift lead", description: "Evening", permissions: ["orders.create"], defaultLocationScope: "selected", isActive: true, revision: 7 },
    })]);

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO tenant_roles"),
      [roleId, businessId, "Shift lead", "Evening", JSON.stringify(["orders.create"]), "selected", true, 7],
    );
  });
});
