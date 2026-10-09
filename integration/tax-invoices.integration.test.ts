/**
 * Issue #866 — a taxpayer submission's life, on a real database.
 *
 * The scenarios call the same service functions the API routes call, as the
 * unprivileged application role, so row-level security and the immutability
 * triggers are the ones production runs. The authority is the simulator from
 * `tax-invoice-provider`, swapped in for the sandbox environment only. The
 * production environment keeps its real adapter, which fails closed.
 *
 * The worker tick and business reset / hard delete have their own files. The
 * tick serves every business in the database, and reset runs under the owner.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAppRole } from "../scripts/create-app-role";
import { runMigrations } from "../scripts/migrate";
import { decryptSecret, resolveEncryptionKey } from "../src/lib/integrations/secrets";
import { verifyPayloadHash, type ProviderIssue, type TaxPayloadV1 } from "../src/lib/tax-invoice-core";
import { SandboxTaxProvider, type SandboxScript, type TaxProviderAdapter, type TaxSubmitRequest } from "../src/lib/tax-invoice-provider";
import type { TaxActor } from "../src/lib/tax-invoice-service";

// The authority. `providerFor("sandbox")` returns whatever the current test
// installs; `providerFor("production")` always returns the real adapter.
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

const APP_ROLE = "pos_tax_test_role";
const APP_PASSWORD = "tax-test-password";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let databaseName = "";
let owner: Client;
let dbLib: typeof import("../src/lib/db");
let service: typeof import("../src/lib/tax-invoice-service");
let queries: typeof import("../src/lib/tax-invoice-queries");

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
  databaseName = `pos_tax_${randomUUID().replaceAll("-", "")}`;
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

  // Every service call below runs as the application role, not the owner.
  process.env.DATABASE_URL = urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD });
  dbLib = await import("../src/lib/db");
  service = await import("../src/lib/tax-invoice-service");
  queries = await import("../src/lib/tax-invoice-queries");
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
type SaleLine = { productId: string; name: string; price: number; quantity: number };
type Sale = { orderId: string; orderNumber: number; total: number; vat: number };

type StoredRecord = {
  id: string;
  order_id: string;
  kind: "sale" | "amendment" | "cancellation";
  revision: number;
  parent_submission_id: string | null;
  status: string;
  reference_number: string;
  uid: string;
  receipt_id: string | null;
  environment: string;
  provider: string;
  payload_snapshot: TaxPayloadV1;
  payload_hash: string;
  subtotal_rial: number;
  discount_rial: number;
  vat_rial: number;
  total_rial: number;
  attempts: number;
  last_error_code: string | null;
  provider_errors: ProviderIssue[];
  inquiry_result: { state: string; at: string } | null;
  accepted_at: Date | null;
  correlation_id: string;
  idempotency_key: string;
};

type Simulator = { adapter: SandboxTaxProvider; submits: TaxSubmitRequest[] };

let orderSeq = 5000;

/** The simulator for this test. Every submit the service makes is recorded, including ones that failed. */
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
    [label, `tax-${randomUUID().slice(0, 12)}`],
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

async function enableTax(t: Tenant, environment: "sandbox" | "production" = "sandbox"): Promise<void> {
  await service.saveTaxProfile(t.actor, {
    enabled: true,
    environment,
    taxpayerId: "A1B2C3",
    taxpayerName: "شرکت نمونه",
    referencePrefix: "BIZ",
  });
  await service.saveTaxUnits(t.actor, [{ locationId: t.locationId, memoryId: "1234567890123456", unitCode: "K1" }]);
}

async function product(t: Tenant, name: string, price: number, code: string | null): Promise<string> {
  const row = await owner.query<{ id: string }>(
    `INSERT INTO menu_items (location_id, name, price) VALUES ($1, $2, $3) RETURNING id`,
    [t.locationId, name, price],
  );
  const id = row.rows[0].id;
  if (code) await service.saveTaxItemCodes(t.actor, [{ productKind: "menu_item", productId: id, code }]);
  return id;
}

const SALE_OPENED = "2026-10-01T09:59:00Z";
const SALE_CLOSED = "2026-10-01T10:00:00Z";

/**
 * A closed sale, written the way the POS writes one: an order opened, its served
 * lines added while it is open, then closed. VAT is 9% of the subtotal.
 */
async function sale(t: Tenant, lines: SaleLine[], options: { status?: "completed" | "voided" } = {}): Promise<Sale> {
  const subtotal = lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
  const vat = (subtotal * 9) / 100;
  if (!Number.isInteger(vat)) throw new Error("fixture subtotals must make whole-rial VAT");
  const total = subtotal + vat;
  orderSeq += 1;
  const order = await owner.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, type, status, subtotal, discount, service_charge, tax, total, opened_at, opened_by)
     VALUES ($1, $2, 'takeaway', 'open', $3, 0, 0, $4, $5, $6::timestamptz, $7)
     RETURNING id`,
    [t.locationId, orderSeq, subtotal, vat, total, SALE_OPENED, t.userId],
  );
  const orderId = order.rows[0].id;
  for (const line of lines) {
    await owner.query(
      `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'served')`,
      [t.locationId, orderId, line.productId, line.name, line.price, line.quantity],
    );
  }
  await owner.query(`UPDATE orders SET status = $2, closed_at = $3::timestamptz, closed_by = $4 WHERE id = $1`, [
    orderId,
    options.status ?? "completed",
    SALE_CLOSED,
    t.userId,
  ]);
  return { orderId, orderNumber: orderSeq, total, vat };
}

/**
 * A correction to a closed sale, made the way the POS makes one: through the
 * closed-order amendment flag, which the item guard checks. Without it the
 * database refuses the change, as it should.
 */
async function correctClosedSale(orderId: string, quantity: number, subtotal: number, tax: number, total: number): Promise<void> {
  await owner.query("BEGIN");
  try {
    await owner.query(`SELECT set_config('app.order_amendment', 'on', true)`);
    await owner.query(`UPDATE order_items SET quantity = $2 WHERE order_id = $1`, [orderId, quantity]);
    await owner.query(`UPDATE orders SET subtotal = $2, tax = $3, total = $4 WHERE id = $1`, [orderId, subtotal, tax, total]);
    await owner.query("COMMIT");
  } catch (error) {
    await owner.query("ROLLBACK");
    throw error;
  }
}

async function prepare(t: Tenant, orderId: string): Promise<{ id: string; reference: string }> {
  const [result] = await service.prepareSales(t.actor, [orderId]);
  if (!result || result.outcome !== "prepared" || !result.submissionId || !result.reference) {
    throw new Error(`expected a prepared record, got ${JSON.stringify(result)}`);
  }
  return { id: result.submissionId, reference: result.reference };
}

async function stored(id: string): Promise<StoredRecord> {
  const { rows } = await owner.query<StoredRecord>(
    `SELECT id, order_id, kind, revision, parent_submission_id, status, reference_number, uid, receipt_id,
            environment, provider, payload_snapshot, payload_hash,
            subtotal_rial::int AS subtotal_rial, discount_rial::int AS discount_rial,
            vat_rial::int AS vat_rial, total_rial::int AS total_rial,
            attempts, last_error_code, provider_errors, inquiry_result, accepted_at, correlation_id, idempotency_key
       FROM tax_invoice_submissions WHERE id = $1`,
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

async function countRecords(orderId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tax_invoice_submissions WHERE order_id = $1`,
    [orderId],
  );
  return rows[0].n;
}

async function ciphertextOf(businessId: string): Promise<string | null> {
  const { rows } = await owner.query<{ credentials_ciphertext: string | null }>(
    `SELECT credentials_ciphertext FROM tax_invoice_profiles WHERE business_id = $1`,
    [businessId],
  );
  return rows[0]?.credentials_ciphertext ?? null;
}

function openSealed(ciphertext: string): Record<string, string> {
  const key = resolveEncryptionKey(process.env as Record<string, string | undefined>);
  return JSON.parse(decryptSecret(ciphertext, key)) as Record<string, string>;
}

/** Runs one statement as the application role, inside the business's tenant scope. */
async function asTenant(t: Tenant, sql: string, params: unknown[]): Promise<void> {
  await dbLib.withTenant(t.businessId, () => dbLib.query(sql, params));
}

/** A sale with one coded product, prepared, sent, and accepted. */
async function acceptedSale(t: Tenant, qty = 2): Promise<{ sale: Sale; recordId: string; reference: string }> {
  const menu = await product(t, "کباب کوبیده", 100000, "1111111111111");
  const s = await sale(t, [{ productId: menu, name: "کباب کوبیده", price: 100000, quantity: qty }]);
  const { id, reference } = await prepare(t, s.orderId);
  await service.queueAndSend(t.actor, [id]);
  await service.inquireSubmissions(t.businessId, { ids: [id], force: true });
  return { sale: s, recordId: id, reference };
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

describe("the database is the one production runs", () => {
  it("connects as a role that row-level security applies to", async () => {
    expect(await dbLib.rlsEffective()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Preparing a sale
// ---------------------------------------------------------------------------

describe("preparing a sale", () => {
  it("prepares a completed sale into one record, referenced from its unit; a second prepare returns that record", async () => {
    sandboxWith();
    const t = await seedTenant("Prepare Co");
    await enableTax(t);
    const menu = await product(t, "کباب کوبیده", 100000, "1111111111111");
    const s = await sale(t, [{ productId: menu, name: "کباب کوبیده", price: 100000, quantity: 2 }]);

    const first = await prepare(t, s.orderId);
    expect(first.reference).toBe(`BIZ-K1-${s.orderNumber}-S1`);

    const record = await stored(first.id);
    expect(record).toMatchObject({
      status: "prepared",
      kind: "sale",
      revision: 1,
      environment: "sandbox",
      provider: "sandbox",
      subtotal_rial: 200000,
      discount_rial: 0,
      vat_rial: 18000,
      total_rial: 218000,
    });
    expect(record.payload_snapshot.totals.totalRial).toBe(218000);
    expect(record.payload_snapshot.lines).toHaveLength(1);
    expect(record.payload_snapshot.lines[0]).toMatchObject({ taxCode: "1111111111111", quantity: 2, vatRial: 18000 });
    expect(verifyPayloadHash(record.payload_snapshot, record.payload_hash)).toBe(true);
    expect(await eventTypes(first.id)).toEqual(["prepared"]);

    const again = await service.prepareSales(t.actor, [s.orderId]);
    expect(again[0]).toMatchObject({ outcome: "existing", submissionId: first.id, reference: first.reference });
    expect(await countRecords(s.orderId)).toBe(1);
  });

  it("blocks a sale whose product has no item code, names the product, and writes no record", async () => {
    sandboxWith();
    const t = await seedTenant("Code Co");
    await enableTax(t);
    const coded = await product(t, "چای", 20000, "2222222222222");
    const bare = await product(t, "نان سنگک", 5000, null);
    const s = await sale(t, [
      { productId: coded, name: "چای", price: 20000, quantity: 1 },
      { productId: bare, name: "نان سنگک", price: 5000, quantity: 3 },
    ]);

    const [result] = await service.prepareSales(t.actor, [s.orderId]);
    expect(result).toMatchObject({ outcome: "blocked", submissionId: null });
    expect(result.blockers.map((b) => b.code)).toEqual(["item_code_missing"]);
    expect(result.blockers[0]).toMatchObject({ productName: "نان سنگک", productKind: "menu_item", productId: bare });
    expect(await countRecords(s.orderId)).toBe(0);
  });

  it("blocks preparation until the taxpayer profile is configured and enabled", async () => {
    sandboxWith();
    const t = await seedTenant("Off Co");
    const menu = await product(t, "کوکو", 60000, "3333333333333");
    const s = await sale(t, [{ productId: menu, name: "کوکو", price: 60000, quantity: 1 }]);

    const [none] = await service.prepareSales(t.actor, [s.orderId]);
    expect(none.blockers.map((b) => b.code)).toEqual(["profile_not_configured"]);

    await service.saveTaxProfile(t.actor, { enabled: false, taxpayerId: "A1B2C3", referencePrefix: "BIZ" });
    await service.saveTaxUnits(t.actor, [{ locationId: t.locationId, memoryId: "1234567890123456", unitCode: "K1" }]);
    await service.saveTaxItemCodes(t.actor, [{ productKind: "menu_item", productId: menu, code: "3333333333333" }]);
    const [off] = await service.prepareSales(t.actor, [s.orderId]);
    expect(off.blockers.map((b) => b.code)).toEqual(["profile_disabled"]);
    expect(await countRecords(s.orderId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Immutability, enforced by the database
// ---------------------------------------------------------------------------

describe("the database refuses to rewrite history", () => {
  it("refuses to rewrite a stored payload, reference, uid, or total, under the application role", async () => {
    sandboxWith();
    const t = await seedTenant("Frozen Co");
    await enableTax(t);
    const menu = await product(t, "کباب کوبیده", 100000, "1111111111111");
    const s = await sale(t, [{ productId: menu, name: "کباب کوبیده", price: 100000, quantity: 2 }]);
    const { id, reference } = await prepare(t, s.orderId);
    const before = await stored(id);

    await expect(asTenant(t, `UPDATE tax_invoice_submissions SET payload_snapshot = '{}'::jsonb WHERE id = $1`, [id])).rejects.toThrow(
      /tax_submission_immutable/,
    );
    await expect(asTenant(t, `UPDATE tax_invoice_submissions SET reference_number = 'FORGED-1' WHERE id = $1`, [id])).rejects.toThrow(
      /tax_submission_immutable/,
    );
    await expect(asTenant(t, `UPDATE tax_invoice_submissions SET uid = gen_random_uuid()::text WHERE id = $1`, [id])).rejects.toThrow(
      /tax_submission_immutable/,
    );
    await expect(asTenant(t, `UPDATE tax_invoice_submissions SET total_rial = 1 WHERE id = $1`, [id])).rejects.toThrow(
      /tax_submission_immutable/,
    );

    const after = await stored(id);
    expect(after.reference_number).toBe(reference);
    expect(after.payload_snapshot).toEqual(before.payload_snapshot);
    expect(after.total_rial).toBe(218000);
  });

  it("refuses an illegal status move, a deletion, and any change to the event history", async () => {
    sandboxWith();
    const t = await seedTenant("Ledger Co");
    await enableTax(t);
    const menu = await product(t, "کباب کوبیده", 100000, "1111111111111");
    const s = await sale(t, [{ productId: menu, name: "کباب کوبیده", price: 100000, quantity: 2 }]);
    const { id } = await prepare(t, s.orderId);

    await expect(asTenant(t, `UPDATE tax_invoice_submissions SET status = 'accepted' WHERE id = $1`, [id])).rejects.toThrow(
      /tax_submission_transition: prepared -> accepted/,
    );
    await expect(asTenant(t, `DELETE FROM tax_invoice_submissions WHERE id = $1`, [id])).rejects.toThrow(/never deleted/);
    await expect(asTenant(t, `UPDATE tax_invoice_events SET detail = '{}'::jsonb WHERE submission_id = $1`, [id])).rejects.toThrow(
      /append-only/,
    );
    await expect(asTenant(t, `DELETE FROM tax_invoice_events WHERE submission_id = $1`, [id])).rejects.toThrow(/append-only/);

    expect((await stored(id)).status).toBe("prepared");
    expect(await eventTypes(id)).toEqual(["prepared"]);
  });
  it("refuses a second live record for the same sale, even when it is written around the service", async () => {
    sandboxWith();
    const t = await seedTenant("Duplicate Co");
    await enableTax(t);
    const menu = await product(t, "کباب کوبیده", 100000, "1111111111111");
    const s = await sale(t, [{ productId: menu, name: "کباب کوبیده", price: 100000, quantity: 2 }]);
    const { id } = await prepare(t, s.orderId);

    // A copy of the live record, one revision on, inserted directly. The partial unique index is the backstop.
    await expect(
      owner.query(
        `INSERT INTO tax_invoice_submissions
           (business_id, location_id, order_id, kind, revision, idempotency_key, reference_number, uid,
            environment, provider, payload_version, payload_snapshot, payload_hash,
            subtotal_rial, discount_rial, vat_rial, total_rial, status, correlation_id)
         SELECT business_id, location_id, order_id, kind, 2, repeat('b', 64), 'DUPLICATE-S2', gen_random_uuid()::text,
                environment, provider, payload_version, payload_snapshot, payload_hash,
                subtotal_rial, discount_rial, vat_rial, total_rial, 'prepared', correlation_id
           FROM tax_invoice_submissions WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/tax_one_live_sale_per_order/);
    expect(await countRecords(s.orderId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Sending, inquiry, and the answers that go missing
// ---------------------------------------------------------------------------

describe("sending and inquiry", () => {
  it("sends the stored packet, and reaches accepted only after the authority answers its inquiry", async () => {
    const sim = sandboxWith({ processingPolls: 1 });
    const t = await seedTenant("Send Co");
    await enableTax(t);
    const menu = await product(t, "کباب کوبیده", 100000, "1111111111111");
    const s = await sale(t, [{ productId: menu, name: "کباب کوبیده", price: 100000, quantity: 2 }]);
    const prep = await prepare(t, s.orderId);

    const [sent] = await service.queueAndSend(t.actor, [prep.id]);
    expect(sent).toMatchObject({ status: "submitted", skipped: null });
    const submitted = await stored(prep.id);
    expect(submitted.receipt_id).not.toBeNull();

    // The authority was handed the stored snapshot, under the uid the record was born with.
    expect(sim.submits).toHaveLength(1);
    expect(sim.submits[0].uid).toBe(submitted.uid);
    expect(sim.submits[0].reference).toBe(prep.reference);
    expect(sim.submits[0].payload).toEqual(submitted.payload_snapshot);

    // The first answer is still processing. The second is acceptance.
    await service.inquireSubmissions(t.businessId, { ids: [prep.id], force: true });
    expect((await stored(prep.id)).status).toBe("submitted");
    await service.inquireSubmissions(t.businessId, { ids: [prep.id], force: true });

    const accepted = await stored(prep.id);
    expect(accepted).toMatchObject({ status: "accepted", receipt_id: submitted.receipt_id, inquiry_result: { state: "accepted" } });
    expect(accepted.accepted_at).not.toBeNull();
    expect(accepted.payload_snapshot).toEqual(submitted.payload_snapshot);
    expect(verifyPayloadHash(accepted.payload_snapshot, accepted.payload_hash)).toBe(true);
    expect(await eventTypes(prep.id)).toEqual(["prepared", "queued", "send_started", "submitted", "inquired", "inquired"]);

    // The receipt is recorded once.
    await expect(asTenant(t, `UPDATE tax_invoice_submissions SET receipt_id = 'FORGED' WHERE id = $1`, [prep.id])).rejects.toThrow(
      /receipt is recorded once/,
    );
  });

  it("a timeout after the packet left is inquired by its uid, and is never sent a second time", async () => {
    const sim = sandboxWith({
      submitFailures: [{ kind: "unknown_delivery", code: "timeout", message: "پاسخی از سامانه نرسید." }],
    });
    const t = await seedTenant("Timeout Co");
    await enableTax(t);
    const menu = await product(t, "کباب کوبیده", 100000, "1111111111111");
    const s = await sale(t, [{ productId: menu, name: "کباب کوبیده", price: 100000, quantity: 2 }]);
    const { id } = await prepare(t, s.orderId);

    const [first] = await service.queueAndSend(t.actor, [id]);
    expect(first).toMatchObject({ status: "awaiting_inquiry" });
    // The authority did receive the packet: the failure reached the sender, not the authority.
    expect(sim.adapter.packetCount).toBe(1);
    expect((await stored(id)).attempts).toBe(1);

    // Sending again does not touch a record that is waiting for its answer.
    const [again] = await service.queueAndSend(t.actor, [id]);
    expect(again).toMatchObject({ status: "awaiting_inquiry", skipped: "status_awaiting_inquiry" });
    expect(sim.submits).toHaveLength(1);

    // The inquiry finds the packet under its uid, and the record is accepted with no second send.
    await service.inquireSubmissions(t.businessId, { ids: [id], force: true });
    expect((await stored(id)).status).toBe("accepted");
    expect(sim.submits).toHaveLength(1);
    expect(sim.adapter.packetCount).toBe(1);
    expect(await eventTypes(id)).toEqual(["prepared", "queued", "send_started", "send_failed", "inquired"]);
  });

  it("a refused connection is queued, waits out its backoff, and is retried under the uid it was born with", async () => {
    const sim = sandboxWith({
      submitFailures: [{ kind: "not_delivered", code: "ECONNREFUSED", message: "اتصال برقرار نشد." }],
    });
    const t = await seedTenant("Refused Co");
    await enableTax(t);
    const menu = await product(t, "کباب کوبیده", 100000, "1111111111111");
    const s = await sale(t, [{ productId: menu, name: "کباب کوبیده", price: 100000, quantity: 2 }]);
    const { id } = await prepare(t, s.orderId);

    const [queued] = await service.queueAndSend(t.actor, [id]);
    expect(queued).toMatchObject({ status: "queued" });
    const waiting = await stored(id);
    expect(waiting).toMatchObject({ attempts: 1, last_error_code: "ECONNREFUSED" });
    expect(sim.adapter.packetCount).toBe(0);

    // Not yet: the backoff has not passed.
    const soon = await service.drainSubmissions(t.businessId, { ids: [id], now: new Date() });
    expect(soon.claimed).toBe(0);

    // After the backoff the record goes again, under the same uid.
    const later = await service.drainSubmissions(t.businessId, { ids: [id], now: new Date(Date.now() + 60 * 60_000) });
    expect(later).toMatchObject({ claimed: 1, submitted: 1 });
    expect(sim.submits.map((request) => request.uid)).toEqual([waiting.uid, waiting.uid]);
    expect((await stored(id)).status).toBe("submitted");
    expect(sim.adapter.packetCount).toBe(1);
    expect(await eventTypes(id)).toEqual(["prepared", "queued", "send_started", "send_failed", "send_started", "submitted"]);
  });

  it("production fails closed, and an operator's retry keeps the uid without ever reaching the simulator", async () => {
    const sim = sandboxWith();
    const t = await seedTenant("Live Co");
    await enableTax(t, "production");
    const menu = await product(t, "کباب کوبیده", 100000, "1111111111111");
    const s = await sale(t, [{ productId: menu, name: "کباب کوبیده", price: 100000, quantity: 2 }]);
    const { id } = await prepare(t, s.orderId);

    const [first] = await service.queueAndSend(t.actor, [id]);
    expect(first).toMatchObject({ status: "error" });
    const failed = await stored(id);
    expect(failed).toMatchObject({
      environment: "production",
      provider: "moodian",
      status: "error",
      attempts: 1,
      last_error_code: "live_provider_unavailable",
    });

    expect(await service.retrySubmission(t.actor, id)).toBe("error");
    expect(await stored(id)).toMatchObject({ uid: failed.uid, attempts: 2, last_error_code: "live_provider_unavailable" });
    expect(sim.submits).toHaveLength(0);
    expect(sim.adapter.packetCount).toBe(0);
  });

  it("a rejected packet is resubmitted as revision 2 under a new uid, and the refusal is reported by its code", async () => {
    const issue: ProviderIssue = { code: "ITEM_CODE_UNKNOWN", message: "شناسه کالا در سامانه ثبت نشده است.", field: "lines[0].taxCode" };
    const sim = sandboxWith({ submitFailures: [{ kind: "rejected", issues: [issue] }] });
    const t = await seedTenant("Refusal Co");
    await enableTax(t);
    const menu = await product(t, "کباب کوبیده", 100000, "1111111111111");
    const s = await sale(t, [{ productId: menu, name: "کباب کوبیده", price: 100000, quantity: 2 }]);
    const { id } = await prepare(t, s.orderId);

    const [refused] = await service.queueAndSend(t.actor, [id]);
    expect(refused).toMatchObject({ status: "rejected" });
    const rejected = await stored(id);
    expect(rejected).toMatchObject({ status: "rejected", last_error_code: "provider_rejected" });
    expect(rejected.provider_errors).toEqual([issue]);

    // The operator's report counts the refusal under the authority's own code.
    const report = await queries.getProviderErrorReport(t.businessId);
    expect(report).toEqual([expect.objectContaining({ code: "ITEM_CODE_UNKNOWN", records: 1 })]);

    // A refusal is not overwritten: a new revision is prepared, with a new uid.
    const revision = await service.resubmitSubmission(t.actor, id);
    expect(revision).toMatchObject({ outcome: "prepared" });
    expect(revision.reference).toBe(rejected.reference_number.replace(/-S1$/, "-S2"));
    const second = await stored(revision.submissionId!);
    expect(second).toMatchObject({ kind: "sale", revision: 2, status: "prepared" });
    expect(second.uid).toMatch(UUID);
    expect(second.uid).not.toBe(rejected.uid);

    const [sentAgain] = await service.queueAndSend(t.actor, [second.id]);
    expect(sentAgain).toMatchObject({ status: "submitted" });
    await service.inquireSubmissions(t.businessId, { ids: [second.id], force: true });
    expect((await stored(second.id)).status).toBe("accepted");

    // The refused record stands as it was.
    expect((await stored(id)).status).toBe("rejected");
    expect(sim.submits.map((request) => request.uid)).toEqual([rejected.uid, second.uid]);
  });
});

// ---------------------------------------------------------------------------
// Amendments and cancellations
// ---------------------------------------------------------------------------

describe("amendments and cancellations", () => {
  it("amends an accepted sale as a linked record built from the sale as it now stands, and only once", async () => {
    sandboxWith();
    const t = await seedTenant("Amend Co");
    await enableTax(t);
    const original = await acceptedSale(t, 2);
    expect((await stored(original.recordId)).status).toBe("accepted");

    // The sale is corrected in the books: three portions, not two.
    await correctClosedSale(original.sale.orderId, 3, 300000, 27000, 327000);

    const amendment = await service.amendSubmission(t.actor, original.recordId, "اشتباه در تعداد");
    expect(amendment).toMatchObject({ outcome: "prepared" });
    const amend = await stored(amendment.submissionId!);
    expect(amend).toMatchObject({
      kind: "amendment",
      revision: 1,
      parent_submission_id: original.recordId,
      status: "prepared",
      subtotal_rial: 300000,
      vat_rial: 27000,
      total_rial: 327000,
    });
    expect(amend.reference_number).toBe(`BIZ-K1-${original.sale.orderNumber}-A1`);
    expect(amend.payload_snapshot.lines[0].quantity).toBe(3);
    expect(amend.payload_snapshot.reason).toBe("اشتباه در تعداد");
    expect(amend.payload_snapshot.parent).toMatchObject({ submissionId: original.recordId, reference: original.reference });

    // The accepted original keeps the invoice that was sent: two portions, and its hash still holds.
    const before = await stored(original.recordId);
    expect(before.payload_snapshot.lines[0].quantity).toBe(2);
    expect(before.total_rial).toBe(218000);
    expect(verifyPayloadHash(before.payload_snapshot, before.payload_hash)).toBe(true);

    // Asking again while the amendment is live returns it. It does not create a second one.
    const again = await service.amendSubmission(t.actor, original.recordId, "اشتباه در تعداد");
    expect(again).toMatchObject({ outcome: "existing", submissionId: amendment.submissionId });

    await service.queueAndSend(t.actor, [amendment.submissionId!]);
    await service.inquireSubmissions(t.businessId, { ids: [amendment.submissionId!], force: true });
    expect((await stored(amendment.submissionId!)).status).toBe("accepted");
    expect((await stored(original.recordId)).status).toBe("accepted");
    expect(await countRecords(original.sale.orderId)).toBe(2);
  });

  it("cancels an accepted sale by reproducing the invoice as it was sent, not the sale as it now stands", async () => {
    sandboxWith();
    const t = await seedTenant("Cancel Co");
    await enableTax(t);
    const original = await acceptedSale(t, 2);

    // The sale changes after it was sent. The cancellation must withdraw what was sent.
    await correctClosedSale(original.sale.orderId, 5, 500000, 45000, 545000);

    const withdrawal = await service.cancelSubmission(t.actor, original.recordId, "صدور به اشتباه");
    expect(withdrawal).toMatchObject({ outcome: "prepared" });
    const cancel = await stored(withdrawal.submissionId!);
    expect(cancel).toMatchObject({
      kind: "cancellation",
      parent_submission_id: original.recordId,
      subtotal_rial: 200000,
      vat_rial: 18000,
      total_rial: 218000,
    });
    expect(cancel.reference_number).toBe(`BIZ-K1-${original.sale.orderNumber}-C1`);
    expect(cancel.payload_snapshot.lines[0].quantity).toBe(2);

    await service.queueAndSend(t.actor, [withdrawal.submissionId!]);
    await service.inquireSubmissions(t.businessId, { ids: [withdrawal.submissionId!], force: true });
    expect((await stored(withdrawal.submissionId!)).status).toBe("accepted");
    expect((await stored(original.recordId)).status).toBe("cancelled");
    expect((await eventTypes(original.recordId)).at(-1)).toBe("cancelled");

    // A withdrawn invoice is not amended. A cancellation is not cancelled.
    await expect(service.amendSubmission(t.actor, original.recordId, "تلاش دوباره")).rejects.toMatchObject({ code: "not_accepted" });
    await expect(service.cancelSubmission(t.actor, withdrawal.submissionId!, "دوباره")).rejects.toMatchObject({
      code: "not_cancellable",
    });
  });
});

// ---------------------------------------------------------------------------
// Credentials and settings
// ---------------------------------------------------------------------------

describe("credentials and settings", () => {
  it("keeps credentials sealed and write-only, and merges partial writes", async () => {
    const t = await seedTenant("Secret Co");

    await service.saveTaxProfile(t.actor, {
      taxpayerId: "A1B2C3",
      credentials: { secret: "KEY-ONE", certificatePem: "CERT-ONE" },
    });
    const sealed = await ciphertextOf(t.businessId);
    expect(sealed).not.toBeNull();
    expect(sealed!).not.toContain("KEY-ONE");
    expect(sealed!).not.toContain("CERT-ONE");
    expect(openSealed(sealed!)).toEqual({ secret: "KEY-ONE", certificatePem: "CERT-ONE" });

    const view = await service.getTaxSettings(t.businessId);
    expect(view.profile.credentialsConfigured).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/KEY-ONE|CERT-ONE/);

    // The audit names that credentials changed, and never carries their values.
    const audit = await owner.query<{ payload: unknown }>(
      `SELECT payload FROM audit_log WHERE business_id = $1 AND action = 'tax_invoice.settings_updated'`,
      [t.businessId],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit.rows)).not.toMatch(/KEY-ONE|CERT-ONE/);
    expect(audit.rows[0].payload).toMatchObject({ credentialsChanged: true });

    // A partial write replaces only the field it names.
    await service.saveTaxProfile(t.actor, { credentials: { certificatePem: "CERT-TWO" } });
    expect(openSealed((await ciphertextOf(t.businessId))!)).toEqual({ secret: "KEY-ONE", certificatePem: "CERT-TWO" });

    // An empty string is not a value, so it keeps the stored one.
    await service.saveTaxProfile(t.actor, { credentials: { secret: "" } });
    expect(openSealed((await ciphertextOf(t.businessId))!).secret).toBe("KEY-ONE");

    // null clears both.
    await service.saveTaxProfile(t.actor, { credentials: null });
    expect(await ciphertextOf(t.businessId)).toBeNull();
    expect((await service.getTaxSettings(t.businessId)).profile.credentialsConfigured).toBe(false);
  });

  it("refuses to enable without a taxpayer id, and leaves no profile behind", async () => {
    const t = await seedTenant("No Id Co");
    await expect(service.saveTaxProfile(t.actor, { enabled: true, referencePrefix: "BIZ" })).rejects.toMatchObject({
      code: "taxpayer_id_required",
      status: 409,
    });
    const { rows } = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tax_invoice_profiles WHERE business_id = $1`,
      [t.businessId],
    );
    expect(rows[0].n).toBe(0);
    expect((await service.getTaxSettings(t.businessId)).profile.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Isolation between businesses
// ---------------------------------------------------------------------------

describe("isolation between businesses", () => {
  it("another business cannot read, send, retry, amend, cancel, or resubmit a record", async () => {
    sandboxWith();
    const home = await seedTenant("Home Co");
    const stranger = await seedTenant("Stranger Co");
    await enableTax(home);
    await enableTax(stranger);
    const menu = await product(home, "کوکو", 60000, "3333333333333");
    const s = await sale(home, [{ productId: menu, name: "کوکو", price: 60000, quantity: 1 }]);
    const { id } = await prepare(home, s.orderId);

    expect(await queries.getTaxRecordDetail(stranger.businessId, id)).toBeNull();
    const page = await queries.listTaxRegister(stranger.businessId, { view: "all" });
    expect(page.rows.map((row) => row.id)).not.toContain(id);
    expect(JSON.stringify(await queries.listUnpreparedSales(stranger.businessId, {}))).not.toContain(s.orderId);
    const reconciliation = await queries.getTaxReconciliation(stranger.businessId, { from: "2026-10-01", to: "2026-10-01" });
    expect(reconciliation.rows).toEqual([]);
    expect(reconciliation.totals.sourceCount).toBe(0);

    const [foreign] = await service.queueAndSend(stranger.actor, [id]);
    expect(foreign).toMatchObject({ status: null, skipped: "not_found" });
    await expect(service.retrySubmission(stranger.actor, id)).rejects.toMatchObject({ code: "not_found" });
    await expect(service.amendSubmission(stranger.actor, id, "تلاش برای اصلاح")).rejects.toMatchObject({ code: "not_found" });
    await expect(service.cancelSubmission(stranger.actor, id, "تلاش برای ابطال")).rejects.toMatchObject({ code: "not_found" });
    await expect(service.resubmitSubmission(stranger.actor, id)).rejects.toMatchObject({ code: "not_found" });

    expect((await stored(id)).status).toBe("prepared");
    expect(await eventTypes(id)).toEqual(["prepared"]);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation: the register against the sales ledger
// ---------------------------------------------------------------------------

describe("reconciliation against the sales ledger", () => {
  it("ties every completed sale to the record that reports it, names the drift, and exports the same records", async () => {
    sandboxWith({
      submitFailures: [
        { kind: "unknown_delivery", code: "timeout", message: "پاسخی از سامانه نرسید." },
        { kind: "rejected", issues: [{ code: "ITEM_CODE_UNKNOWN", message: "شناسه کالا ثبت نشده است.", field: "lines[0].taxCode" }] },
      ],
    });
    const t = await seedTenant("Tie Co");
    await enableTax(t);
    const kabab = await product(t, "کباب کوبیده", 100000, "1111111111111");
    const doogh = await product(t, "دوغ", 50000, "2222222222222");

    const completed = await sale(t, [{ productId: kabab, name: "کباب کوبیده", price: 100000, quantity: 2 }]);
    const missing = await sale(t, [{ productId: doogh, name: "دوغ", price: 50000, quantity: 2 }]);
    const voided = await sale(t, [{ productId: doogh, name: "دوغ", price: 50000, quantity: 2 }], { status: "voided" });
    const pending = await sale(t, [{ productId: doogh, name: "دوغ", price: 50000, quantity: 2 }]);
    const refused = await sale(t, [{ productId: kabab, name: "کباب کوبیده", price: 100000, quantity: 1 }]);
    const drifted = await sale(t, [{ productId: kabab, name: "کباب کوبیده", price: 100000, quantity: 2 }]);
    const cancelled = await sale(t, [{ productId: kabab, name: "کباب کوبیده", price: 100000, quantity: 2 }]);

    // The sends are made in this order, so the scripted failures land on the sales they are meant for.
    const pendingRecord = await prepare(t, pending.orderId);
    await service.queueAndSend(t.actor, [pendingRecord.id]);
    const refusedRecord = await prepare(t, refused.orderId);
    await service.queueAndSend(t.actor, [refusedRecord.id]);

    const okRecord = await prepare(t, completed.orderId);
    const driftRecord = await prepare(t, drifted.orderId);
    const cancelRecord = await prepare(t, cancelled.orderId);
    await service.queueAndSend(t.actor, [okRecord.id, driftRecord.id, cancelRecord.id]);
    await service.inquireSubmissions(t.businessId, { ids: [okRecord.id, driftRecord.id, cancelRecord.id], force: true });

    expect((await stored(pendingRecord.id)).status).toBe("awaiting_inquiry");
    expect((await stored(refusedRecord.id)).status).toBe("rejected");
    expect((await stored(okRecord.id)).status).toBe("accepted");

    // The drift: the sale is corrected after it was accepted, so it no longer matches its record.
    await correctClosedSale(drifted.orderId, 3, 300000, 27000, 327000);

    // The withdrawn sale: accepted, then cancelled by an accepted cancellation.
    const withdrawal = await service.cancelSubmission(t.actor, cancelRecord.id, "ثبت تکراری");
    await service.queueAndSend(t.actor, [withdrawal.submissionId!]);
    await service.inquireSubmissions(t.businessId, { ids: [withdrawal.submissionId!], force: true });
    expect((await stored(cancelRecord.id)).status).toBe("cancelled");

    const page = await queries.getTaxReconciliation(t.businessId, { from: "2026-10-01", to: "2026-10-01" });
    const byOrder = new Map(page.rows.map((row) => [row.orderId, row] as const));
    expect(page.truncated).toBe(false);
    expect(byOrder.get(completed.orderId)?.state).toBe("accepted");
    expect(byOrder.get(missing.orderId)?.state).toBe("missing");
    expect(byOrder.get(voided.orderId)?.state).toBe("voided");
    expect(byOrder.get(pending.orderId)?.state).toBe("pending");
    expect(byOrder.get(refused.orderId)?.state).toBe("rejected");
    expect(byOrder.get(drifted.orderId)).toMatchObject({ state: "mismatch", sourceTotalRial: 327000, recordTotalRial: 218000 });
    expect(byOrder.get(cancelled.orderId)?.state).toBe("cancelled");

    // Every completed sale is counted. The voided one is listed, but not counted.
    expect(page.totals.sourceCount).toBe(6);
    expect(page.totals.byState.voided.count).toBe(1);
    expect(page.totals.unrecordedTotalRial).toBe(109000);
    expect(page.totals.unrecordedVatRial).toBe(9000);
    expect(page.totals.differenceTotalRial).toBe(109000);
    expect(page.totals.differenceVatRial).toBe(9000);

    // The export holds the same records the register does: six, one per submission made.
    const exported = await queries.buildTaxRegisterExport(t.businessId, { view: "all" }, "rial");
    expect(exported.rows).toHaveLength(6);
    expect(exported.rows.map((row) => row.referenceNumber)).toContain(okRecord.reference);
  });

  it("a sale voided after it was reported is a mismatch, and its accepted record is not changed to hide it", async () => {
    sandboxWith();
    const t = await seedTenant("Void Co");
    await enableTax(t);
    const menu = await product(t, "کباب کوبیده", 100000, "1111111111111");
    const s = await sale(t, [{ productId: menu, name: "کباب کوبیده", price: 100000, quantity: 2 }]);
    const { id } = await prepare(t, s.orderId);
    await service.queueAndSend(t.actor, [id]);
    await service.inquireSubmissions(t.businessId, { ids: [id], force: true });
    expect((await stored(id)).status).toBe("accepted");

    // The POS voids the closed sale through the amendment path. The authority still holds the invoice.
    await owner.query("BEGIN");
    try {
      await owner.query(`SELECT set_config('app.order_amendment', 'on', true)`);
      await owner.query(`UPDATE orders SET status = 'voided' WHERE id = $1`, [s.orderId]);
      await owner.query("COMMIT");
    } catch (error) {
      await owner.query("ROLLBACK");
      throw error;
    }

    const page = await queries.getTaxReconciliation(t.businessId, { from: "2026-10-01", to: "2026-10-01" });
    expect(page.rows.find((row) => row.orderId === s.orderId)).toMatchObject({ state: "mismatch", recordStatus: "accepted" });
    expect((await stored(id)).status).toBe("accepted");
  });
});
