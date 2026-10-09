/**
 * Issue #866 — the worker tick, on a real database.
 *
 * The tick serves every business in the database, so this file owns its own
 * database and its scenarios run in order. Each one settles its records before
 * the next starts, so no scenario can pick up another's leftovers.
 *
 * The authority is the simulator. "A worker died mid-send" is scripted by moving
 * the record to the state the worker would have left it in, through the owner
 * role, because the crash itself cannot be reproduced in-process.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAppRole } from "../scripts/create-app-role";
import { runMigrations } from "../scripts/migrate";
import type { TaxPayloadV1 } from "../src/lib/tax-invoice-core";
import { SandboxTaxProvider, type SandboxScript, type TaxProviderAdapter, type TaxSubmitRequest } from "../src/lib/tax-invoice-provider";
import type { TaxActor } from "../src/lib/tax-invoice-service";

const simulator = vi.hoisted(() => ({ adapter: null as TaxProviderAdapter | null }));

vi.mock("../src/lib/tax-invoice-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/tax-invoice-provider")>();
  return {
    ...actual,
    providerFor: (environment: "sandbox" | "production") =>
      environment === "sandbox" && simulator.adapter ? simulator.adapter : actual.providerFor(environment),
  };
});

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

const APP_ROLE = "pos_tax_worker_role";
const APP_PASSWORD = "tax-worker-password";
const MINUTE = 60_000;

let databaseName = "";
let owner: Client;
let dbLib: typeof import("../src/lib/db");
let service: typeof import("../src/lib/tax-invoice-service");

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_tax_worker_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  const ownerUrl = urlFor(databaseName);
  await runMigrations({ databaseUrl: ownerUrl, quiet: true });
  await createAppRole({ databaseUrl: ownerUrl, roleName: APP_ROLE, password: APP_PASSWORD, quiet: true });

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();

  process.env.DATABASE_URL = urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD });
  dbLib = await import("../src/lib/db");
  service = await import("../src/lib/tax-invoice-service");
}, 120_000);

afterAll(async () => {
  await owner?.end();
  await dbLib?.closeDatabasePool();
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await maintenance.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
  } finally {
    await maintenance.end();
  }
}, 120_000);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Tenant = { businessId: string; locationId: string; userId: string; actor: TaxActor };
type StoredRecord = {
  status: string;
  uid: string;
  reference_number: string;
  payload_snapshot: TaxPayloadV1;
};
type Simulator = { adapter: SandboxTaxProvider; submits: TaxSubmitRequest[] };

let orderSeq = 9000;

function sandboxWith(script: SandboxScript = {}): Simulator {
  const adapter = new SandboxTaxProvider({ processingPolls: 0, ...script });
  const submits: TaxSubmitRequest[] = [];
  simulator.adapter = {
    provider: "sandbox",
    submit: async (request) => {
      submits.push(request);
      return adapter.submit(request);
    },
    inquire: (request) => adapter.inquire(request),
  };
  return { adapter, submits };
}

async function seedTenant(label: string): Promise<Tenant> {
  const business = await owner.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, plan) VALUES ($1, $2, 'business') RETURNING id`,
    [label, `tick-${randomUUID().slice(0, 12)}`],
  );
  const businessId = business.rows[0].id;
  const location = await owner.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'شعبه مرکزی') RETURNING id`,
    [businessId],
  );
  const user = await owner.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', $2, 'hash') RETURNING id`,
    [businessId, `${label} owner`],
  );
  const userId = user.rows[0].id;
  return { businessId, locationId: location.rows[0].id, userId, actor: { businessId, userId } };
}

async function enableTax(t: Tenant): Promise<void> {
  await service.saveTaxProfile(t.actor, { enabled: true, environment: "sandbox", taxpayerId: "A1B2C3", referencePrefix: "BIZ" });
  await service.saveTaxUnits(t.actor, [{ locationId: t.locationId, memoryId: "1234567890123456", unitCode: "K1" }]);
}

/** A closed sale with one coded product: opened, its line added while open, then closed. */
async function sale(t: Tenant, code: string): Promise<string> {
  const menu = await owner.query<{ id: string }>(
    `INSERT INTO menu_items (location_id, name, price) VALUES ($1, 'کباب کوبیده', 100000) RETURNING id`,
    [t.locationId],
  );
  await service.saveTaxItemCodes(t.actor, [{ productKind: "menu_item", productId: menu.rows[0].id, code }]);
  orderSeq += 1;
  const order = await owner.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, type, status, subtotal, discount, service_charge, tax, total, opened_at, opened_by)
     VALUES ($1, $2, 'takeaway', 'open', 200000, 0, 0, 18000, 218000, '2026-10-01T09:59:00Z', $3) RETURNING id`,
    [t.locationId, orderSeq, t.userId],
  );
  await owner.query(
    `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity, status)
     VALUES ($1, $2, $3, 'کباب کوبیده', 100000, 2, 'served')`,
    [t.locationId, order.rows[0].id, menu.rows[0].id],
  );
  await owner.query(`UPDATE orders SET status = 'completed', closed_at = '2026-10-01T10:00:00Z', closed_by = $2 WHERE id = $1`, [
    order.rows[0].id,
    t.userId,
  ]);
  return order.rows[0].id;
}

async function prepare(t: Tenant, orderId: string): Promise<string> {
  const [result] = await service.prepareSales(t.actor, [orderId]);
  if (!result || result.outcome !== "prepared" || !result.submissionId) {
    throw new Error(`expected a prepared record, got ${JSON.stringify(result)}`);
  }
  return result.submissionId;
}

async function stored(id: string): Promise<StoredRecord> {
  const { rows } = await owner.query<StoredRecord>(
    `SELECT status, uid, reference_number, payload_snapshot FROM tax_invoice_submissions WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw new Error(`no tax record ${id}`);
  return rows[0];
}

async function eventTypes(id: string): Promise<string[]> {
  const { rows } = await owner.query<{ event_type: string }>(
    `SELECT event_type FROM tax_invoice_events WHERE submission_id = $1 ORDER BY created_at, id`,
    [id],
  );
  return rows.map((row) => row.event_type);
}

/** What a worker leaves behind when it dies mid-send: `sending`, under a lease that has already run out. */
async function strandInSending(id: string, lease: "expired" | "live"): Promise<void> {
  await owner.query(`UPDATE tax_invoice_submissions SET status = 'queued' WHERE id = $1 AND status = 'prepared'`, [id]);
  const until = lease === "expired" ? "now() - interval '1 minute'" : "now() + interval '5 minutes'";
  await owner.query(`UPDATE tax_invoice_submissions SET status = 'sending', leased_until = ${until} WHERE id = $1 AND status = 'queued'`, [id]);
}

// ---------------------------------------------------------------------------
// The scenarios, in order
// ---------------------------------------------------------------------------

describe("the worker tick", () => {
  it("retries a refused connection after its backoff, then inquires the packet to acceptance", async () => {
    const sim = sandboxWith({
      submitFailures: [{ kind: "not_delivered", code: "ECONNREFUSED", message: "اتصال برقرار نشد." }],
    });
    const t = await seedTenant("Tick Refused Co");
    await enableTax(t);
    const id = await prepare(t, await sale(t, "1111111111111"));

    await service.queueAndSend(t.actor, [id]);
    expect((await stored(id)).status).toBe("queued");

    // An hour on, the send is due. The packet waits for its first inquiry.
    await service.runTaxInvoiceTick(new Date(Date.now() + 60 * MINUTE));
    expect((await stored(id)).status).toBe("submitted");

    // Two hours on, the inquiry is due, and the authority holds the packet.
    await service.runTaxInvoiceTick(new Date(Date.now() + 120 * MINUTE));
    expect((await stored(id)).status).toBe("accepted");

    // Two submit calls, one packet, one uid: the refused attempt never reached the authority.
    expect(sim.submits).toHaveLength(2);
    expect(new Set(sim.submits.map((request) => request.uid)).size).toBe(1);
    expect(sim.adapter.packetCount).toBe(1);
    expect(await eventTypes(id)).toEqual(["prepared", "queued", "send_started", "send_failed", "send_started", "submitted", "inquired"]);
  });

  it("a worker that died after the packet left finds it by uid, and never sends it again", async () => {
    const sim = sandboxWith();
    const t = await seedTenant("Tick Delivered Co");
    await enableTax(t);
    const id = await prepare(t, await sale(t, "1111111111111"));

    // The packet reached the authority. The worker died before it wrote that down.
    const record = await stored(id);
    await sim.adapter.submit({
      uid: record.uid,
      reference: record.reference_number,
      environment: "sandbox",
      payload: record.payload_snapshot,
      credentials: null,
    });
    await strandInSending(id, "expired");

    await service.runTaxInvoiceTick(new Date());
    expect((await stored(id)).status).toBe("accepted");
    expect(sim.submits).toHaveLength(0);
    expect(sim.adapter.packetCount).toBe(1);
    expect(await eventTypes(id)).toEqual(expect.arrayContaining(["lease_expired", "inquired"]));
  });

  it("a worker that died before the packet left is inquired, found missing, queued, and sent once under the same uid", async () => {
    const sim = sandboxWith();
    const t = await seedTenant("Tick Missing Co");
    await enableTax(t);
    const id = await prepare(t, await sale(t, "1111111111111"));
    const uid = (await stored(id)).uid;
    await strandInSending(id, "expired");

    // The lease ran out and the authority holds nothing. The record goes back to the queue, not to a blind resend.
    await service.runTaxInvoiceTick(new Date());
    expect((await stored(id)).status).toBe("queued");
    expect(sim.submits).toHaveLength(0);
    expect(await eventTypes(id)).toEqual(expect.arrayContaining(["lease_expired", "not_received"]));

    // The next tick sends it under the uid it was born with. The inquiry after that accepts it.
    await service.runTaxInvoiceTick(new Date(Date.now() + 1 * MINUTE));
    expect((await stored(id)).status).toBe("submitted");
    await service.runTaxInvoiceTick(new Date(Date.now() + 3 * MINUTE));
    expect((await stored(id)).status).toBe("accepted");
    expect(sim.submits.map((request) => request.uid)).toEqual([uid]);
    expect(sim.adapter.packetCount).toBe(1);
  });

  it("leaves a send that is still under a live lease alone", async () => {
    const sim = sandboxWith();
    const t = await seedTenant("Tick Live Lease Co");
    await enableTax(t);
    const id = await prepare(t, await sale(t, "1111111111111"));
    await strandInSending(id, "live");

    await service.runTaxInvoiceTick(new Date());
    expect((await stored(id)).status).toBe("sending");
    expect(sim.submits).toHaveLength(0);
    expect(sim.adapter.packetCount).toBe(0);
  });
});
