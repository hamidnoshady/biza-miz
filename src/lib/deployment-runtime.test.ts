import { afterEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { NextRequest } from "next/server";
import { GET as healthGet, HEAD as healthHead } from "../app/api/health/route";
import { resolveLineModifiers } from "./order-cart";
import { enforceOrderControl } from "./order-control-service";

const originalImageSha = process.env.APP_IMAGE_SHA;
const originalHealthToken = process.env.HEALTH_VERSION_TOKEN;

afterEach(() => {
  if (originalImageSha === undefined) delete process.env.APP_IMAGE_SHA;
  else process.env.APP_IMAGE_SHA = originalImageSha;
  if (originalHealthToken === undefined) delete process.env.HEALTH_VERSION_TOKEN;
  else process.env.HEALTH_VERSION_TOKEN = originalHealthToken;
});

/**
 * The health probe as the post-publish rollout check calls it. Since issue
 * #1003 the build commit is only for a caller holding the deploy token
 * (HEALTH_VERSION_TOKEN); everyone else gets liveness alone.
 */
function healthRequest(token?: string) {
  return new NextRequest("http://localhost/api/health", {
    headers: token === undefined ? {} : { "x-health-token": token },
  });
}

interface FakeClient {
  client: PoolClient;
  maxConcurrent(): number;
  calls(): string[];
}

/** A pg@9-shaped client: starting a second query before awaiting the first fails. */
function nonQueueingClient(rowsFor: (sql: string) => Record<string, unknown>[]): FakeClient {
  let active = 0;
  let maximum = 0;
  const statements: string[] = [];

  const client = {
    async query(sql: string) {
      statements.push(sql);
      active += 1;
      maximum = Math.max(maximum, active);
      if (active > 1) {
        active -= 1;
        throw new Error("concurrent_client_query");
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return { rows: rowsFor(sql), rowCount: 1 };
    },
  } as unknown as PoolClient;

  return {
    client,
    maxConcurrent: () => maximum,
    calls: () => statements,
  };
}

describe("production deployment runtime", () => {
  it("identifies the running image through the database-less health endpoint", async () => {
    process.env.APP_IMAGE_SHA = "abc1234";
    process.env.HEALTH_VERSION_TOKEN = "deploy-token-for-tests";

    const response = healthGet(healthRequest("deploy-token-for-tests"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ ok: true, version: "abc1234" });

    const head = healthHead();
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("falls back to an explicit version instead of omitting the deploy marker", async () => {
    delete process.env.APP_IMAGE_SHA;
    process.env.HEALTH_VERSION_TOKEN = "deploy-token-for-tests";
    expect(await healthGet(healthRequest("deploy-token-for-tests")).json()).toMatchObject({
      ok: true,
      version: "unknown",
    });
  });

  it("keeps the build commit from anyone without the deploy token (issue #1003)", async () => {
    process.env.APP_IMAGE_SHA = "abc1234";
    process.env.HEALTH_VERSION_TOKEN = "deploy-token-for-tests";
    for (const request of [healthRequest(), healthRequest("wrong-token"), healthRequest("")]) {
      const response = healthGet(request);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ ok: true });
      expect(body).not.toHaveProperty("version");
    }
    // A deployment that never set the secret reveals it to nobody.
    delete process.env.HEALTH_VERSION_TOKEN;
    expect(await healthGet(healthRequest("")).json()).not.toHaveProperty("version");
  });

  it("serializes order-control reads made on one transaction client", async () => {
    const fake = nonQueueingClient((sql) =>
      sql.includes("FROM settings") ? [] : [{ kitchen_started: true }],
    );

    await enforceOrderControl(fake.client, {
      actor: {
        userId: "owner-1",
        role: "owner",
        businessId: "business-1",
      },
      locationId: "location-1",
      orderId: "order-1",
      action: "add_items",
    });

    expect(fake.calls()).toHaveLength(2);
    expect(fake.maxConcurrent()).toBe(1);
  });

  it("serializes modifier reads made on one transaction client", async () => {
    const fake = nonQueueingClient((sql) => {
      // resolveLineModifiers re-reads the menu item itself (availability and
      // its category's) before resolving the add-on selection.
      if (sql.includes("FROM menu_items")) {
        return [{
          id: "item-1",
          name: "Latte",
          price: "850000",
          is_active: true,
          category_is_active: true,
          tax_rate: "9",
        }];
      }
      if (sql.includes("menu_item_modifier_groups")) {
        return [{
          menu_item_id: "item-1",
          modifier_group_id: "group-1",
          min_select_override: null,
          max_select_override: null,
          is_active: true,
        }];
      }
      if (sql.includes("FROM modifiers")) {
        return [{
          id: "modifier-1",
          group_id: "group-1",
          name: "Extra shot",
          price_delta: "1000",
          is_active: true,
        }];
      }
      return [{ id: "group-1", is_active: true, min_select: 0, max_select: 2 }];
    });

    const result = await resolveLineModifiers(
      "location-1",
      "item-1",
      ["modifier-1"],
      fake.client,
    );

    expect(result).toMatchObject({ ok: true });
    // menu_items → modifier_groups → links → modifiers, awaited in order.
    expect(fake.calls()).toHaveLength(4);
    expect(fake.maxConcurrent()).toBe(1);
  });
});
