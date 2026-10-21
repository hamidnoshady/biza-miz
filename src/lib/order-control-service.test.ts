import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { enforceOrderControl, recordOrderAudit } from "./order-control-service";

interface Call {
  sql: string;
  params: unknown[];
}

function scriptedClient(respond: (sql: string, params: unknown[]) => Record<string, unknown>[]) {
  const calls: Call[] = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      return { rows: respond(sql, params), rowCount: 1 };
    },
  } as unknown as PoolClient;
  return { client, calls };
}

const actor = {
  userId: "33333333-3333-4333-8333-333333333333",
  role: "cashier" as const,
  businessId: "11111111-1111-4111-8111-111111111111",
};
const LOCATION_ID = "22222222-2222-4222-8222-222222222222";
const ORDER_ID = "44444444-4444-4444-8444-444444444444";

describe("order-control service", () => {
  it("reads the branch override before the business fallback and enforces it in the same client", async () => {
    const { client, calls } = scriptedClient((sql) => {
      if (sql.includes("FROM settings")) {
        return [{ value: {
          cashierDiscountLimitPercent: 5,
          wholeOrderVoidRequiresManager: true,
          postKitchenChangeRequiresManager: true,
        } }];
      }
      return [{ kitchen_started: false }];
    });

    await expect(enforceOrderControl(client, {
      actor,
      locationId: LOCATION_ID,
      orderId: ORDER_ID,
      action: "discount",
      discountPercent: 6,
    })).rejects.toThrow("manager_approval_required");

    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toContain("location_id = $2 OR location_id IS NULL");
    expect(calls[0]?.sql).toContain("ORDER BY (location_id = $2) DESC");
    expect(calls[0]?.params).toEqual([actor.businessId, LOCATION_ID]);
    expect(calls[1]?.params).toEqual([ORDER_ID]);
  });

  it("writes the audited actor, reason, and metadata to the tenant audit_log schema", async () => {
    const { client, calls } = scriptedClient(() => []);
    await recordOrderAudit(client, {
      actor: { ...actor, role: "manager" },
      locationId: LOCATION_ID,
      action: "order.voided",
      entityType: "order",
      entityId: ORDER_ID,
      reason: "ثبت اشتباه",
      metadata: { orderNumber: "42" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("INSERT INTO audit_log");
    expect(calls[0]?.sql).toContain("user_id");
    const payload = JSON.parse(String(calls[0]?.params[6]));
    expect(payload).toMatchObject({
      orderNumber: "42",
      reason: "ثبت اشتباه",
      actorRole: "manager",
      managerAuthorizedBy: actor.userId,
    });
  });
});
