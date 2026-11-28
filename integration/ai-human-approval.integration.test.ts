/**
 * GH #1567 F7 — mandatory human approval for AI-initiated financial and
 * stock writes, in every business type, enforced at the backend boundary.
 *
 * Proven here against a real database:
 *   - an MCP `apply`-mode connection's sale is queued, moves nothing, and
 *     runs only after a human approves the exact payload they were shown;
 *   - the approval is bound: no hash / a stale hash goes back to the queue,
 *     an expired proposal and a tampered payload fail, and a second approval
 *     (replay) finds nothing;
 *   - the executor boundary refuses any gated call without a fresh approval
 *     for this approver and this payload, and spends it exactly once;
 *   - an enabled autopilot category cannot run a stock count or an expense;
 *   - ungated writes (catalogue master data) still apply immediately.
 */
import { randomUUID } from "node:crypto";
import { Client, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { Industry } from "../src/lib/industries";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let itemsService: typeof import("../src/lib/items-service");
let stockService: typeof import("../src/lib/retail-stock-service");
let accessories: typeof import("../src/lib/accessories-service");
let provisioning: typeof import("../src/lib/business-provisioning");
let mcpAuth: typeof import("../src/lib/mcp/auth");
let mcpServer: typeof import("../src/lib/mcp/server");
let connections: typeof import("../src/lib/mcp/connections-service");
let writeService: typeof import("../src/lib/mcp/write-service");
let approval: typeof import("../src/lib/ai-human-approval");
let policy: typeof import("../src/lib/ai-approval-policy");
let hashLib: typeof import("../src/lib/ai-approval-hash");
let audit: typeof import("../src/lib/ai-action-audit");
let autopilot: typeof import("../src/lib/ai-autopilot-service");

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}
function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_ai_approval_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  itemsService = await import("../src/lib/items-service");
  stockService = await import("../src/lib/retail-stock-service");
  accessories = await import("../src/lib/accessories-service");
  provisioning = await import("../src/lib/business-provisioning");
  mcpAuth = await import("../src/lib/mcp/auth");
  mcpServer = await import("../src/lib/mcp/server");
  connections = await import("../src/lib/mcp/connections-service");
  writeService = await import("../src/lib/mcp/write-service");
  approval = await import("../src/lib/ai-human-approval");
  policy = await import("../src/lib/ai-approval-policy");
  hashLib = await import("../src/lib/ai-approval-hash");
  audit = await import("../src/lib/ai-action-audit");
  autopilot = await import("../src/lib/ai-autopilot-service");
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

interface Biz {
  id: string;
  main: string;
  branch: string;
  ownerId: string;
  industry: Industry;
  inventoryCode: string;
}

async function seed(industry: Industry, inventoryCode: string): Promise<Biz> {
  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Shop', $1, $2) RETURNING id",
    [`shop-${randomUUID().slice(0, 8)}`, industry],
  );
  const id = bizRow.rows[0].id;
  const locRows = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main'), ($1, 'Branch') RETURNING id",
    [id],
  );
  const user = await db.query<{ id: string }>(
    "INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id",
    [id],
  );
  const client = await dbLib.getPool().connect();
  try {
    await provisioning.seedChartOfAccounts(client, id, industry);
  } finally {
    client.release();
  }
  return { id, main: locRows.rows[0].id, branch: locRows.rows[1].id, ownerId: user.rows[0].id, industry, inventoryCode };
}

async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await dbLib.getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function sku(locationId: string, name: string): Promise<string> {
  const parent = await itemsService.createItem({ locationId, name, kind: "variant_parent" });
  const child = await itemsService.createVariantChild(parent.id, locationId, `${name} M`, null, [{ name: "سایز", value: "M" }]);
  return child.id;
}

async function purchase(b: Biz, locationId: string, itemId: string, quantity: string, unitCost: number) {
  return tx((client) => stockService.receiveItemPurchase(client, { businessId: b.id, locationId, lines: [{ itemId, quantity, unitCost }] }));
}

async function stock(itemId: string): Promise<{ quantity: string; unitCost: string | null; total: string | null }> {
  const { rows } = await db.query<{ quantity: string; unit_cost: string | null; total_value_rial: string | null }>(
    "SELECT quantity::text, unit_cost::text, total_value_rial::text FROM item_stock WHERE item_id=$1",
    [itemId],
  );
  return { quantity: String(Number(rows[0]?.quantity ?? 0)), unitCost: rows[0]?.unit_cost ?? null, total: rows[0]?.total_value_rial ?? null };
}

async function glNet(b: Biz, code: string): Promise<bigint> {
  const { rows } = await db.query<{ net: string }>(
    `SELECT (coalesce(sum(jl.debit),0) - coalesce(sum(jl.credit),0))::text AS net
       FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id JOIN accounts a ON a.id = jl.account_id
      WHERE je.business_id = $1 AND a.code = $2`,
    [b.id, code],
  );
  return BigInt(rows[0].net);
}

async function sumCarrying(b: Biz): Promise<bigint> {
  const { rows } = await db.query<{ total: string }>(
    `SELECT coalesce(sum(s.total_value_rial),0)::text AS total
       FROM item_stock s JOIN items i ON i.id = s.item_id JOIN locations l ON l.id = i.location_id
      WHERE l.business_id = $1`,
    [b.id],
  );
  return BigInt(rows[0].total);
}




function bearer(token: string): Pick<Request, "headers"> {
  return { headers: new Headers({ authorization: `Bearer ${token}` }) } as Pick<Request, "headers">;
}

async function mintApplyToken(b: Biz): Promise<string> {
  await db.query(
    "INSERT INTO business_features (business_id, flag_key, enabled) VALUES ($1, 'api_platform', true) ON CONFLICT DO NOTHING",
    [b.id],
  );
  const result = await dbLib.withTenant(b.id, () =>
    connections.createStaticMcpConnection(b.id, b.ownerId, {
      name: "Claude",
      locationId: b.main,
      scopes: ["pos.read", "pos.write"],
      writeMode: "apply",
      grants: { apps: {}, branches: "all" },
    }),
  );
  if (!result.ok) throw new Error(`mint failed: ${result.error}`);
  return result.token;
}

async function callTool(token: string, name: string, args: Record<string, unknown>) {
  const outcome = await mcpAuth.withMcpScope(bearer(token), (auth) =>
    mcpServer.dispatchMcpMessage(auth, { kind: "request", id: 1, method: "tools/call", params: { name, arguments: args } }),
  );
  if (!outcome.ok) throw new Error(`auth failed: ${outcome.error}`);
  const value = outcome.value as { result?: { isError: boolean; structuredContent: Record<string, unknown> }; error?: unknown };
  if (value.error) throw new Error(`json-rpc error: ${JSON.stringify(value.error)}`);
  return value.result!;
}

async function stockedFashion(b: Biz, name = "پیراهن"): Promise<string> {
  const id = await sku(b.main, name);
  await purchase(b, b.main, id, "5", 50_000);
  await accessories.setUnitPrice(id, 100_000);
  return id;
}

async function pending(b: Biz) {
  return dbLib.withTenant(b.id, () => connections.listMcpPendingActions(b.id));
}

async function decide(b: Biz, auditId: string, payloadHash?: string | null) {
  return dbLib.withTenant(b.id, () =>
    writeService.decideMcpPendingAction({
      businessId: b.id,
      auditId,
      decision: "approve",
      deciderUserId: b.ownerId,
      presentedPayloadHash: payloadHash,
    }),
  );
}

async function auditRow(id: string) {
  const { rows } = await db.query<{
    status: string; approval_class: string | null; approved_by: string | null;
    approval_consumed_at: string | null; deferred_reason: string | null; result: unknown;
  }>(
    `SELECT status, approval_class, approved_by, approval_consumed_at::text, deferred_reason, result
       FROM ai_action_audit WHERE id = $1`,
    [id],
  );
  return rows[0];
}

const ASSERT_NOT_MOVED = { quantity: "5", total: "250000" };

describe("F7 — MCP apply mode cannot sell without a human", () => {
  it("queues the sale, moves nothing, and posts only after the exact payload is approved once", async () => {
    const b = await seed("fashion_apparel", "1374");
    const item = await stockedFashion(b);
    const token = await mintApplyToken(b);

    const result = await callTool(token, "write_fashion_apparel_item_sell", { id: item, quantity: "2", paymentMethod: "cash" });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.status).toBe("pending_approval");
    expect(await stock(item)).toMatchObject(ASSERT_NOT_MOVED);
    expect(await glNet(b, "4584")).toBe(0n);

    const [row] = await pending(b);
    expect(row).toMatchObject({ actionType: "fashion_apparel.item.sell", approvalClass: "sale", risk: "high" });
    expect(row.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.approvalExpiresAt).toBeTruthy();

    // No hash from the screen → back to the queue, nothing moved.
    expect(await decide(b, row.id, null)).toEqual({ ok: false, error: "approval_binding_required" });
    expect((await auditRow(row.id)).status).toBe("proposed");
    // A hash of some other payload (a stale screen) → back to the queue.
    const staleHash = hashLib.aiApprovalPayloadHash("fashion_apparel.item.sell", { id: item, quantity: "1", paymentMethod: "cash" });
    expect(await decide(b, row.id, staleHash)).toEqual({ ok: false, error: "approval_stale" });
    expect(await stock(item)).toMatchObject(ASSERT_NOT_MOVED);

    const approved = await decide(b, row.id, row.payloadHash);
    expect(approved).toMatchObject({ ok: true, decision: "approve", outcome: { status: "applied" } });
    expect(await stock(item)).toMatchObject({ quantity: "3", total: "150000" });
    expect(await glNet(b, "4584")).toBe(-200_000n);
    expect(await glNet(b, "5184")).toBe(100_000n);
    const after = await auditRow(row.id);
    expect(after).toMatchObject({ status: "applied", approval_class: "sale", approved_by: b.ownerId });
    expect(after.approval_consumed_at).toBeTruthy();

    // Replay: a second approval (double click, retried request) finds nothing.
    expect(await decide(b, row.id, row.payloadHash)).toEqual({ ok: false, error: "not_found" });
    expect(await stock(item)).toMatchObject({ quantity: "3", total: "150000" });
    expect(await sumCarrying(b)).toBe(await glNet(b, "1374"));
  });

  it("an expired proposal or a tampered stored payload never runs", async () => {
    const b = await seed("fashion_apparel", "1374");
    const item = await stockedFashion(b);
    const token = await mintApplyToken(b);

    await callTool(token, "write_fashion_apparel_item_sell", { id: item, quantity: "1", paymentMethod: "cash" });
    const [expiring] = await pending(b);
    await db.query("UPDATE ai_action_audit SET approval_expires_at = now() - interval '1 minute' WHERE id = $1", [expiring.id]);
    expect(await decide(b, expiring.id, expiring.payloadHash)).toEqual({ ok: false, error: "approval_expired" });
    expect((await auditRow(expiring.id)).status).toBe("failed");

    await callTool(token, "write_fashion_apparel_item_sell", { id: item, quantity: "1", paymentMethod: "cash" });
    const [tampered] = await pending(b);
    // Someone edits the stored request after it was framed: the stamp breaks.
    await db.query(`UPDATE ai_action_audit SET proposal_payload = jsonb_set(proposal_payload, '{quantity}', '"5"') WHERE id = $1`, [tampered.id]);
    const fresh = (await pending(b))[0];
    expect(await decide(b, tampered.id, fresh.payloadHash)).toEqual({ ok: false, error: "approval_payload_mismatch" });
    expect((await auditRow(tampered.id)).status).toBe("failed");
    expect(await stock(item)).toMatchObject(ASSERT_NOT_MOVED);
    expect(await glNet(b, "4584")).toBe(0n);
  });

  it("ungated catalogue writes still apply immediately on an apply connection", async () => {
    const b = await seed("fashion_apparel", "1374");
    const token = await mintApplyToken(b);
    const result = await callTool(token, "write_fashion_apparel_item_create", { name: "شلوار جین" });
    expect(result.structuredContent.status).toBe("applied");
    expect(await pending(b)).toHaveLength(0);
  });
});

describe("F7 — the executor boundary", () => {
  it("refuses a gated call without an approval and spends a bound approval exactly once", async () => {
    const b = await seed("fashion_apparel", "1374");
    const item = await stockedFashion(b);
    const other = await db.query<{ id: string }>(
      "INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Second owner', 'x') RETURNING id",
      [b.id],
    );
    const payload = { id: item, quantity: "1", paymentMethod: "cash" };

    // No audit row at all (an AI path calling straight through).
    const bare = await approval.runAiExecutor({
      actionType: "fashion_apparel.item.sell", businessId: b.id, authorizedByUserId: b.ownerId, payload, auditId: null,
    });
    expect(bare).toMatchObject({ ok: false, errorCode: "human_approval_required" });
    expect(await stock(item)).toMatchObject(ASSERT_NOT_MOVED);

    const auditId = await audit.createAiActionAudit({
      businessId: b.id, actorUserId: b.ownerId, actorName: "test", prompt: "sell",
      proposal: { type: "fashion_apparel.item.sell", title: "sell", summary: "sell", payload },
    });
    await db.query("UPDATE ai_action_audit SET status = 'processing' WHERE id = $1", [auditId]);
    // Claimed but not approved.
    expect(await approval.runAiExecutor({
      actionType: "fashion_apparel.item.sell", businessId: b.id, authorizedByUserId: b.ownerId, payload, auditId,
    })).toMatchObject({ ok: false, errorCode: "human_approval_required" });

    expect(await approval.recordHumanApproval({
      businessId: b.id, auditId, approverUserId: b.ownerId, presentedPayloadHash: null, requirePresentedHash: false,
    })).toEqual({ ok: true, gated: true });
    // Another actor cannot spend the owner's approval…
    expect(await approval.runAiExecutor({
      actionType: "fashion_apparel.item.sell", businessId: b.id, authorizedByUserId: other.rows[0].id, payload, auditId,
    })).toMatchObject({ ok: false, errorCode: "human_approval_required" });
    // …nor can a changed payload…
    expect(await approval.runAiExecutor({
      actionType: "fashion_apparel.item.sell", businessId: b.id, authorizedByUserId: b.ownerId, payload: { ...payload, quantity: "4" }, auditId,
    })).toMatchObject({ ok: false, errorCode: "human_approval_required" });
    // …nor another tenant.
    const stranger = await seed("fashion_apparel", "1374");
    expect(await approval.runAiExecutor({
      actionType: "fashion_apparel.item.sell", businessId: stranger.id, authorizedByUserId: b.ownerId, payload, auditId,
    })).toMatchObject({ ok: false, errorCode: "human_approval_required" });
    expect(await stock(item)).toMatchObject(ASSERT_NOT_MOVED);

    const ran = await approval.runAiExecutor({
      actionType: "fashion_apparel.item.sell", businessId: b.id, authorizedByUserId: b.ownerId, payload, auditId,
    });
    expect(ran.ok).toBe(true);
    expect(await stock(item)).toMatchObject({ quantity: "4", total: "200000" });
    // Replay of the same approval is refused.
    expect(await approval.runAiExecutor({
      actionType: "fashion_apparel.item.sell", businessId: b.id, authorizedByUserId: b.ownerId, payload, auditId,
    })).toMatchObject({ ok: false, errorCode: "human_approval_required" });
    expect(await stock(item)).toMatchObject({ quantity: "4", total: "200000" });
  });

  it("an approval older than the execution window cannot be spent", async () => {
    const b = await seed("fashion_apparel", "1374");
    const item = await stockedFashion(b);
    const payload = { id: item, quantity: "1", paymentMethod: "cash" };
    const auditId = await audit.createAiActionAudit({
      businessId: b.id, actorUserId: b.ownerId, actorName: "test", prompt: "sell",
      proposal: { type: "fashion_apparel.item.sell", title: "sell", summary: "sell", payload },
    });
    await db.query("UPDATE ai_action_audit SET status = 'processing' WHERE id = $1", [auditId]);
    await approval.recordHumanApproval({ businessId: b.id, auditId, approverUserId: b.ownerId, presentedPayloadHash: null, requirePresentedHash: false });
    await db.query(
      "UPDATE ai_action_audit SET approved_at = now() - make_interval(secs => $2::int + 5) WHERE id = $1",
      [auditId, policy.AI_APPROVAL_EXECUTION_WINDOW_SECONDS],
    );
    expect(await approval.runAiExecutor({
      actionType: "fashion_apparel.item.sell", businessId: b.id, authorizedByUserId: b.ownerId, payload, auditId,
    })).toMatchObject({ ok: false, errorCode: "human_approval_required" });
    expect(await stock(item)).toMatchObject(ASSERT_NOT_MOVED);
  });
});

describe("F7 — unattended AI never runs a financial or stock write", () => {
  it("an enabled autopilot category defers stock counts and expenses to a human, in any trade", async () => {
    for (const industry of ["food_service", "fashion_apparel"] as const) {
      const b = await seed(industry, industry === "food_service" ? "1300" : "1374");
      const setting = { enabled: true, maxAmountRial: 1_000_000_000, maxPercent: 100, maxItemsPerRun: 50, dailyActionLimit: 50 };
      for (const [category, proposal] of [
        ["inventory", { type: "inventory.adjustment.propose", title: "count", summary: "count", payload: { lines: [{ itemId: randomUUID(), countedQuantity: "1" }] } }],
        ["money", { type: "expense.categorize", title: "expense", summary: "expense", payload: { amount: 10_000, description: "x" } }],
      ] as const) {
        const outcome = await autopilot.applyOrDeferProposal({
          businessId: b.id,
          category,
          setting,
          proposal: proposal as never,
          authorizedBy: b.ownerId,
        });
        expect(outcome).toMatchObject({ outcome: "deferred", reasonCode: "human_approval_required" });
        const row = await auditRow(outcome.auditId);
        expect(row.status).toBe("proposed");
        expect(row.approval_class).toBeTruthy();
      }
      const { rows } = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM journal_entries WHERE business_id = $1", [b.id]);
      expect(rows[0].n).toBe("0");
    }
  });
});


