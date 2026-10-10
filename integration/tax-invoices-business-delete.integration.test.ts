/**
 * Issue #866 — the taxpayer records through business reset and hard delete, on a
 * real database, under the owner role as the existing reset tests run.
 *
 * Both paths delete a business's operational data. The tax records are immutable,
 * reference their sales with RESTRICT, and sit beside an append-only history. So
 * the purge in platform-service must clear them leaves-first, under its own flag,
 * before the generic sweep runs. Without it, either path fails. A control business
 * with its own records proves that nothing outside the target is touched.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { SandboxTaxProvider, type SandboxScript, type TaxProviderAdapter } from "../src/lib/tax-invoice-provider";
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

let databaseName = "";
let owner: Client;
let service: typeof import("../src/lib/tax-invoice-service");
let platform: typeof import("../src/lib/platform-service");

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
  databaseName = `pos_tax_delete_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);

  owner = new Client({ connectionString: urlFor(databaseName) });
  await owner.connect();
  service = await import("../src/lib/tax-invoice-service");
  platform = await import("../src/lib/platform-service");
}, 120_000);

afterAll(async () => {
  await owner?.end();
  const { getPool } = await import("../src/lib/db");
  await getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
}, 120_000);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Tenant = { businessId: string; locationId: string; userId: string; actor: TaxActor };
type History = { acceptedSale: string; amendment: string; rejectedSale: string };

let orderSeq = 20000;

function sandboxWith(script: SandboxScript = {}): void {
  const adapter = new SandboxTaxProvider({ processingPolls: 0, ...script });
  simulator.adapter = {
    provider: "sandbox",
    submit: (request) => adapter.submit(request),
    inquire: (request) => adapter.inquire(request),
  };
}

/** A business with an owner who holds a platform login, as the reset path requires. */
async function seedBusiness(label: string): Promise<Tenant> {
  const identity = await owner.query<{ id: string }>(
    `INSERT INTO platform_users (email, password_hash, full_name) VALUES ($1, 'hash', $2) RETURNING id`,
    [`${randomUUID().slice(0, 8)}@example.com`, `${label} owner`],
  );
  const business = await owner.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, plan) VALUES ($1, $2, 'business') RETURNING id`,
    [label, `delete-${randomUUID().slice(0, 12)}`],
  );
  const businessId = business.rows[0].id;
  const location = await owner.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'شعبه مرکزی') RETURNING id`,
    [businessId],
  );
  const user = await owner.query<{ id: string }>(
    `INSERT INTO users (business_id, platform_user_id, role, full_name) VALUES ($1, $2, 'owner', $3) RETURNING id`,
    [businessId, identity.rows[0].id, `${label} owner`],
  );
  const userId = user.rows[0].id;
  return { businessId, locationId: location.rows[0].id, userId, actor: { businessId, userId } };
}

async function enableTax(t: Tenant): Promise<void> {
  await service.saveTaxProfile(t.actor, { enabled: true, environment: "sandbox", taxpayerId: "A1B2C3", referencePrefix: "BIZ" });
  await service.saveTaxUnits(t.actor, [{ locationId: t.locationId, memoryId: "1234567890123456", unitCode: "K1" }]);
}

/** A closed sale with one coded product, written as the POS writes one. */
async function sale(t: Tenant, subtotal: number, quantity: number): Promise<string> {
  const menu = await owner.query<{ id: string }>(
    `INSERT INTO menu_items (location_id, name, price) VALUES ($1, 'کباب کوبیده', $2) RETURNING id`,
    [t.locationId, subtotal / quantity],
  );
  await service.saveTaxItemCodes(t.actor, [{ productKind: "menu_item", productId: menu.rows[0].id, code: "1111111111111" }]);
  const vat = (subtotal * 9) / 100;
  orderSeq += 1;
  const order = await owner.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, type, status, subtotal, discount, service_charge, tax, total, opened_at, opened_by)
     VALUES ($1, $2, 'takeaway', 'open', $3, 0, 0, $4, $5, '2026-10-01T09:59:00Z', $6) RETURNING id`,
    [t.locationId, orderSeq, subtotal, vat, subtotal + vat, t.userId],
  );
  await owner.query(
    `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity, status)
     VALUES ($1, $2, $3, 'کباب کوبیده', $4, $5, 'served')`,
    [t.locationId, order.rows[0].id, menu.rows[0].id, subtotal / quantity, quantity],
  );
  await owner.query(`UPDATE orders SET status = 'completed', closed_at = '2026-10-01T10:00:00Z', closed_by = $2 WHERE id = $1`, [
    order.rows[0].id,
    t.userId,
  ]);
  return order.rows[0].id;
}

/** Closes a sale's record through the amendment flag the POS uses for closed orders. */
async function correctClosedSale(orderId: string, quantity: number, subtotal: number, tax: number): Promise<void> {
  await owner.query("BEGIN");
  try {
    await owner.query(`SELECT set_config('app.order_amendment', 'on', true)`);
    await owner.query(`UPDATE order_items SET quantity = $2 WHERE order_id = $1`, [orderId, quantity]);
    await owner.query(`UPDATE orders SET subtotal = $2, tax = $3, total = $4 WHERE id = $1`, [orderId, subtotal, tax, subtotal + tax]);
    await owner.query("COMMIT");
  } catch (error) {
    await owner.query("ROLLBACK");
    throw error;
  }
}

async function prepareAndAccept(t: Tenant, orderId: string): Promise<string> {
  const [result] = await service.prepareSales(t.actor, [orderId]);
  if (!result || result.outcome !== "prepared" || !result.submissionId) throw new Error("prepare failed");
  await service.queueAndSend(t.actor, [result.submissionId]);
  await service.inquireSubmissions(t.businessId, { ids: [result.submissionId], force: true });
  return result.submissionId;
}

/**
 * The records a real business accumulates: an accepted sale, an accepted amendment
 * that references it, a rejected sale, and the history of each. The amendment is a
 * child of the sale, so the purge has to delete leaves first.
 */
async function taxedHistory(t: Tenant, accepted = true): Promise<History> {
  if (!accepted) {
    sandboxWith();
    const order = await sale(t, 100000, 1);
    const [prepared] = await service.prepareSales(t.actor, [order]);
    if (!prepared.submissionId) throw new Error("prepare failed");
    await service.queueAndSend(t.actor, [prepared.submissionId]);
    const { archiveTaxInvoices, saveTaxArchivePolicy } = await import("../src/lib/tax-invoice-archive");
    // Rejected by a verified inquiry, so this submitted record is archive-eligible.
    simulator.adapter = { provider: "sandbox", submit: async () => ({ receiptId: "unused" }), inquire: async () => ({ state: "rejected", issues: [{ code: "invalid", message: "invalid" }] }) };
    await service.inquireSubmissions(t.businessId, { ids: [prepared.submissionId], force: true });
    await saveTaxArchivePolicy(t.actor, 1);
    await archiveTaxInvoices(t.businessId, new Date(Date.now() + 2 * 86400000));
    return { acceptedSale: prepared.submissionId, amendment: prepared.submissionId, rejectedSale: prepared.submissionId };
  }
  // The rejection is the first submit, so the script's first failure lands on this sale.
  sandboxWith({ submitFailures: [{ kind: "rejected", issues: [{ code: "ITEM_CODE_UNKNOWN", message: "شناسه کالا ثبت نشده است." }] }] });
  const rejectedOrder = await sale(t, 100000, 1);
  const [rejected] = await service.prepareSales(t.actor, [rejectedOrder]);
  if (!rejected?.submissionId) throw new Error("prepare failed");
  await service.queueAndSend(t.actor, [rejected.submissionId]);

  const acceptedOrder = await sale(t, 200000, 2);
  const acceptedSale = await prepareAndAccept(t, acceptedOrder);

  await correctClosedSale(acceptedOrder, 3, 300000, 27000);
  const amendment = await service.amendSubmission(t.actor, acceptedSale, "اشتباه در تعداد");
  if (!amendment.submissionId) throw new Error("amendment failed");
  await service.queueAndSend(t.actor, [amendment.submissionId]);
  await service.inquireSubmissions(t.businessId, { ids: [amendment.submissionId], force: true });

  return { acceptedSale, amendment: amendment.submissionId, rejectedSale: rejected.submissionId };
}

const TAX_TABLES = [
  "tax_invoice_archives",
  "tax_invoice_submissions",
  "tax_invoice_events",
  "tax_invoice_profiles",
  "tax_invoice_units",
  "tax_item_codes",
] as const;

async function taxRowCounts(businessId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TAX_TABLES) {
    const { rows } = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE business_id = $1`, [businessId]);
    counts[table] = rows[0].n;
  }
  return counts;
}

async function statusOf(id: string): Promise<string | null> {
  const { rows } = await owner.query<{ status: string }>(`SELECT status FROM tax_invoice_submissions WHERE id = $1`, [id]);
  return rows[0]?.status ?? null;
}

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

describe("taxpayer records through business reset and hard delete", () => {
  it("a reset clears the taxpayer records, their history, and settings; keeps the business and its owner; leaves other businesses alone", async () => {
    const control = await seedBusiness("Control Co");
    await enableTax(control);
    const controlHistory = await taxedHistory(control);

    const target = await seedBusiness("Reset Co");
    await enableTax(target);
    await taxedHistory(target, false);
    expect((await taxRowCounts(target.businessId)).tax_invoice_submissions).toBe(1);

    await platform.resetBusiness(target.businessId);

    expect(await taxRowCounts(target.businessId)).toEqual({
      tax_invoice_archives: 0,
      tax_invoice_submissions: 0,
      tax_invoice_events: 0,
      tax_invoice_profiles: 0,
      tax_invoice_units: 0,
      tax_item_codes: 0,
    });

    // The root survives, and the owner's login is still there.
    const root = await owner.query(`SELECT 1 FROM businesses WHERE id = $1`, [target.businessId]);
    expect(root.rowCount).toBe(1);
    const ownership = await owner.query(`SELECT 1 FROM users WHERE business_id = $1 AND role = 'owner' AND is_active`, [target.businessId]);
    expect(ownership.rowCount).toBeGreaterThan(0);

    // The other business's records and history are exactly as they were.
    expect(await statusOf(controlHistory.acceptedSale)).toBe("accepted");
    expect(await statusOf(controlHistory.amendment)).toBe("accepted");
    expect(await statusOf(controlHistory.rejectedSale)).toBe("rejected");
    expect((await taxRowCounts(control.businessId)).tax_invoice_events).toBeGreaterThan(0);
  });

  it("a hard delete removes the business and its taxpayer records, and leaves other businesses alone", async () => {
    const control = await seedBusiness("Survivor Co");
    await enableTax(control);
    const controlHistory = await taxedHistory(control);

    const doomed = await seedBusiness("Doomed Co");
    await enableTax(doomed);
    await taxedHistory(doomed, false);
    expect((await taxRowCounts(doomed.businessId)).tax_invoice_submissions).toBe(1);

    await platform.hardDeleteBusiness(doomed.businessId);

    expect((await owner.query(`SELECT 1 FROM businesses WHERE id = $1`, [doomed.businessId])).rowCount).toBe(0);
    expect(Object.values(await taxRowCounts(doomed.businessId)).every((count) => count === 0)).toBe(true);

    expect(await statusOf(controlHistory.acceptedSale)).toBe("accepted");
    expect((await taxRowCounts(control.businessId)).tax_invoice_submissions).toBe(3);
  });
});


it("refuses reset and hard delete of accepted invoices atomically, preserving records and archives", async () => {
  const target = await seedBusiness("Retained Co"); await enableTax(target);
  const history = await taxedHistory(target);
  const archive = await import("../src/lib/tax-invoice-archive");
  await archive.saveTaxArchivePolicy(target.actor, 1);
  await archive.archiveTaxInvoices(target.businessId, new Date(Date.now() + 2 * 86400000));
  const before = await taxRowCounts(target.businessId);
  expect(before.tax_invoice_archives).toBeGreaterThan(0);
  await expect(platform.resetBusiness(target.businessId)).rejects.toMatchObject({ reference: "tax_accepted_retained" });
  expect(await taxRowCounts(target.businessId)).toEqual(before);
  await expect(platform.hardDeleteBusiness(target.businessId)).rejects.toMatchObject({ reference: "tax_accepted_retained" });
  expect(await taxRowCounts(target.businessId)).toEqual(before);
  expect(await statusOf(history.acceptedSale)).toBe("accepted");
});

it("refuses destruction while a provider delivery is unresolved", async () => {
  const target = await seedBusiness("Pending Co"); await enableTax(target); sandboxWith();
  const order = await sale(target, 100000, 1);
  const [record] = await service.prepareSales(target.actor, [order]);
  await service.queueAndSend(target.actor, [record.submissionId!]);
  await expect(platform.resetBusiness(target.businessId)).rejects.toMatchObject({ reference: "tax_inflight_retained" });
  await expect(platform.hardDeleteBusiness(target.businessId)).rejects.toMatchObject({ reference: "tax_inflight_retained" });
  expect(await statusOf(record.submissionId!)).toBe("submitted");
});

it("refuses reset and hard delete for a retained provider dispute without calling it accepted", async () => {
  const target = await seedBusiness("Disputed Co"); await enableTax(target);
  sandboxWith({ submitFailures: [{ kind: "rejected", issues: [{ code: "bad", message: "refused" }] }] });
  const order = await sale(target, 100000, 1);
  const [record] = await service.prepareSales(target.actor, [order]);
  await service.queueAndSend(target.actor, [record.submissionId!]);
  await owner.query("UPDATE tax_invoice_submissions SET retention_hold_at = now() WHERE id = $1", [record.submissionId]);
  await expect(platform.resetBusiness(target.businessId)).rejects.toMatchObject({ reference: "tax_retention_hold" });
  await expect(platform.hardDeleteBusiness(target.businessId)).rejects.toMatchObject({ reference: "tax_retention_hold" });
  expect(await statusOf(record.submissionId!)).toBe("rejected");
});
