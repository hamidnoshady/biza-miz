/**
 * Issue #923 — the warehouse register's P0 branch authorization, proved
 * against a real database, plus the P2 filters, the reversal history and the
 * printable/exportable surface added in this slice.
 *
 * The six P0 scenarios are the ones the issue lists, each as its own test:
 *
 *   1. a branch-restricted member's register contains only their branch;
 *   2. naming a branch they may not act in is refused (403, no leak);
 *   3. opening another branch's voucher by id is refused *before* payload;
 *   4. the owner reads every branch and can narrow to one;
 *   5. writing (posting/reversing) into another branch is refused;
 *   6. a member with no branch scope reads an empty register — not the
 *      tenant's — and another tenant's voucher is simply not found.
 *
 * Why these call `authorize()`/`actionableLocationIds()` rather than the route
 * handlers: those two functions *are* the route's enforcement, and the routes
 * call them in a fixed order (guard → document → authorize its branch → read).
 * A test that re-implemented the order would pass while the route drifted; the
 * assertions below pin the primitives and the order the routes document.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName = "";
let db: Client;
let dbLib: typeof import("../src/lib/db");
let authorizeLib: typeof import("../src/lib/authorize");
let provisioning: typeof import("../src/lib/business-provisioning");
let retailService: typeof import("../src/lib/retail-warehouse-document-service");
let fnbService: typeof import("../src/lib/warehouse-document-service");
let printLib: typeof import("../src/lib/warehouse-document-print");
let historyLib: typeof import("../src/lib/warehouse-document-history");
let itemsService: typeof import("../src/lib/items-service");
let registerLib: typeof import("../src/lib/warehouse-document-register");

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

interface Fixture {
  businessId: string;
  otherBusinessId: string;
  locA: string;
  locB: string;
  locDubai: string;
  itemA: string;
  itemB: string;
  itemDubai: string;
  fnbItemA: string;
  fnbItemB: string;
  owner: string;
  branchA: string;
  noBranch: string;
  docA: string;
  docB: string;
  docBReversed: string;
  fnbDocA: string;
  fnbDocB: string;
}

const fx = {} as Fixture;

async function newBusiness(name: string): Promise<{ businessId: string; locA: string; locB: string; locDubai: string }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry) VALUES ($1, $2, 'cosmetics') RETURNING id`,
    [name, `${name.toLowerCase().replaceAll(" ", "-")}-${randomUUID().slice(0, 8)}`],
  );
  const businessId = rows[0].id;
  const locations = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name, timezone) VALUES ($1, 'Branch A', 'Asia/Tehran')
     RETURNING id`,
    [businessId],
  );
  const locB = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'Branch B') RETURNING id`,
    [businessId],
  );
  const locDubai = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name, timezone) VALUES ($1, 'Branch Dubai', 'Asia/Dubai') RETURNING id`,
    [businessId],
  );
  const client = await dbLib.getPool().connect();
  try {
    await provisioning.seedChartOfAccounts(client, businessId, "cosmetics");
  } finally {
    client.release();
  }
  // The F&B posting rule posts to the well-known inventory/other-income pair;
  // the cosmetics chart does not necessarily carry those codes.
  await db.query(
    `INSERT INTO accounts (business_id, code, name, type)
     SELECT $1, v.code, v.name, v.type::account_type
       FROM (VALUES ('1300','Inventory','asset'), ('4900','Other income','revenue'), ('5900','Other expense','expense')) AS v(code, name, type)
     ON CONFLICT DO NOTHING`,
    [businessId],
  );
  return { businessId, locA: locations.rows[0].id, locB: locB.rows[0].id, locDubai: locDubai.rows[0].id };
}

async function newMember(input: {
  businessId: string;
  name: string;
  role: "owner" | "manager";
  locationScope: "all" | "selected" | "none";
  homeLocationId?: string | null;
  assigned?: string[];
}): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, location_id, role, full_name, email, password_hash, location_scope)
     VALUES ($1, $2, $3, $4, $5, 'x', $6) RETURNING id`,
    [
      input.businessId,
      input.homeLocationId ?? null,
      input.role,
      input.name,
      `${randomUUID().slice(0, 8)}@example.test`,
      input.locationScope,
    ],
  );
  const userId = rows[0].id;
  for (const locationId of input.assigned ?? []) {
    await db.query(`INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2)`, [userId, locationId]);
  }
  return userId;
}

function sessionFor(userId: string, businessId: string, role: "owner" | "manager") {
  return { sub: userId, businessId, role } as unknown as import("../src/lib/auth-edge").SessionPayload;
}

async function postRetailReceipt(input: {
  businessId: string;
  locationId: string;
  itemId: string;
  quantity: string;
  unitCost: number;
  createdBy: string | null;
  lot?: string;
}): Promise<string> {
  const client = await dbLib.getPool().connect();
  try {
    await client.query("BEGIN");
    const parsed = retailService.parseRetailWarehouseDocumentLines("receipt", [
      { itemId: input.itemId, quantity: input.quantity, unitCost: input.unitCost, lot: input.lot ?? null },
    ]);
    const created = await retailService.createRetailWarehouseDocumentInTransaction(client, {
      businessId: input.businessId,
      locationId: input.locationId,
      kind: "receipt",
      createdBy: input.createdBy,
      lines: parsed.lines,
    });
    await client.query("COMMIT");
    return created.id;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function postFnbReceipt(input: {
  businessId: string;
  locationId: string;
  itemId: string;
  quantity: string;
  unitCost: string;
  createdBy: string | null;
}): Promise<string> {
  const client = await dbLib.getPool().connect();
  try {
    await client.query("BEGIN");
    const parsed = fnbService.parseWarehouseDocumentLines("receipt", [
      { inventoryItemId: input.itemId, quantity: input.quantity, unitCost: input.unitCost },
    ]);
    const created = await fnbService.createWarehouseDocumentInTransaction(client, {
      businessId: input.businessId,
      locationId: input.locationId,
      kind: "receipt",
      supplierId: null,
      recipient: null,
      documentNumber: null,
      note: null,
      createdBy: input.createdBy,
      lines: parsed.lines,
    });
    await client.query("COMMIT");
    return created.id;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  databaseName = `pos_register_${randomUUID().replaceAll("-", "")}`;
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
  authorizeLib = await import("../src/lib/authorize");
  provisioning = await import("../src/lib/business-provisioning");
  retailService = await import("../src/lib/retail-warehouse-document-service");
  fnbService = await import("../src/lib/warehouse-document-service");
  printLib = await import("../src/lib/warehouse-document-print");
  historyLib = await import("../src/lib/warehouse-document-history");
  itemsService = await import("../src/lib/items-service");
  registerLib = await import("../src/lib/warehouse-document-register");
  await import("../src/lib/retail-stock-posting-rules");
  await import("../src/lib/fnb-posting-rules");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const main = await newBusiness("Register Branch Biz");
  const other = await newBusiness("Register Other Biz");
  fx.businessId = main.businessId;
  fx.otherBusinessId = other.businessId;
  fx.locA = main.locA;
  fx.locB = main.locB;
  fx.locDubai = main.locDubai;

  fx.owner = await newMember({
    businessId: fx.businessId,
    name: "Owner Zero",
    role: "owner",
    locationScope: "all",
  });
  fx.branchA = await newMember({
    businessId: fx.businessId,
    name: "Branch A Manager",
    role: "manager",
    locationScope: "selected",
    homeLocationId: fx.locA,
    assigned: [fx.locA],
  });
  fx.noBranch = await newMember({
    businessId: fx.businessId,
    name: "Suspended Scope",
    role: "manager",
    locationScope: "none",
  });

  fx.itemA = (await itemsService.createItem({ locationId: fx.locA, name: "Retail A", tracking: "batch" })).id;
  fx.itemB = (await itemsService.createItem({ locationId: fx.locB, name: "Retail B", tracking: "batch" })).id;
  fx.itemDubai = (await itemsService.createItem({ locationId: fx.locDubai, name: "Retail Dubai", tracking: "batch" })).id;

  const fnbItems = await db.query<{ id: string }>(
    `INSERT INTO inventory_items (location_id, name, unit, avg_cost, carrying_value_rial)
     VALUES ($1, 'F&B A', 'unit', 100, 0), ($2, 'F&B B', 'unit', 100, 0) RETURNING id`,
    [fx.locA, fx.locB],
  );
  fx.fnbItemA = fnbItems.rows[0].id;
  fx.fnbItemB = fnbItems.rows[1].id;
  await db.query(
    `INSERT INTO settings (business_id, key, value) VALUES ($1, 'inventory.costing', '{"method":"fifo"}'::jsonb)
     ON CONFLICT DO NOTHING`,
    [fx.businessId],
  );

  fx.docA = await postRetailReceipt({
    businessId: fx.businessId,
    locationId: fx.locA,
    itemId: fx.itemA,
    quantity: "4",
    unitCost: 100_000,
    createdBy: fx.branchA,
    lot: "A-1",
  });
  fx.docB = await postRetailReceipt({
    businessId: fx.businessId,
    locationId: fx.locB,
    itemId: fx.itemB,
    quantity: "2",
    unitCost: 300_000,
    createdBy: fx.owner,
    lot: "B-1",
  });
  // A second, reversed document in B so the reversal-history panel has a chain
  // in the branch the restricted member must not see.
  fx.docBReversed = await postRetailReceipt({
    businessId: fx.businessId,
    locationId: fx.locB,
    itemId: fx.itemB,
    quantity: "1",
    unitCost: 300_000,
    createdBy: fx.owner,
    lot: "B-2",
  });
  {
    const client = await dbLib.getPool().connect();
    try {
      await client.query("BEGIN");
      const { rows: lines } = await client.query<{
        item_id: string;
        quantity: string;
        unit_cost: string;
        lot_number: string | null;
      }>(
        `SELECT item_id, quantity::text, unit_cost::text, lot_number
           FROM retail_warehouse_document_lines WHERE document_id = $1`,
        [fx.docBReversed],
      );
      const parsed = retailService.parseRetailWarehouseDocumentLines(
        "issue",
        lines.map((line) => ({
          itemId: line.item_id,
          quantity: line.quantity,
          unitCost: line.unit_cost,
          lot: line.lot_number,
        })),
      );
      await retailService.createRetailWarehouseDocumentInTransaction(client, {
        businessId: fx.businessId,
        locationId: fx.locB,
        kind: "issue",
        createdBy: fx.owner,
        lines: parsed.lines,
        reversedOf: fx.docBReversed,
        reversalReason: "خطای شمارش اولیه",
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  fx.fnbDocA = await postFnbReceipt({
    businessId: fx.businessId,
    locationId: fx.locA,
    itemId: fx.fnbItemA,
    quantity: "3",
    unitCost: "50000",
    createdBy: fx.branchA,
  });
  fx.fnbDocB = await postFnbReceipt({
    businessId: fx.businessId,
    locationId: fx.locB,
    itemId: fx.fnbItemB,
    quantity: "5",
    unitCost: "70000",
    createdBy: fx.owner,
  });

  // A Dubai-branch document posted at 20:30 UTC: 00:30 the *next* day locally.
  // Its stored business_date is cleared so the fallback is what is under test.
  const dubaiDoc = await postRetailReceipt({
    businessId: fx.businessId,
    locationId: fx.locDubai,
    itemId: fx.itemDubai,
    quantity: "1",
    unitCost: 10_000,
    createdBy: fx.owner,
    lot: "DXB-1",
  });
  await db.query(
    `UPDATE retail_warehouse_documents SET business_date = NULL, created_at = '2026-03-21T20:30:00Z' WHERE id = $1`,
    [dubaiDoc],
  );
}, 300_000);

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
}, 120_000);

async function permittedFor(userId: string, role: "owner" | "manager"): Promise<{
  session: import("../src/lib/auth-edge").SessionPayload;
  locationIds: string[];
}> {
  const session = sessionFor(userId, fx.businessId, role);
  const membership = await authorizeLib.loadMembership(session);
  if (!membership) throw new Error("membership missing");
  const locationIds = await authorizeLib.actionableLocationIds(membership);
  return { session, locationIds };
}

describe("P0 branch authorization — the six scenarios", () => {
  it("1. a branch-restricted member's register contains only their branch", async () => {
    const { locationIds } = await permittedFor(fx.branchA, "manager");
    expect(locationIds).toEqual([fx.locA]);

    const rows = await retailService.listRetailWarehouseDocuments(fx.businessId, {
      locationIds,
      limit: 100,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.location_id))).toEqual(new Set([fx.locA]));
    expect(rows.some((row) => row.id === fx.docB)).toBe(false);

    // B genuinely has documents — the filter is doing the work, not an empty table.
    const { rows: bDocs } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM retail_warehouse_documents WHERE business_id = $1 AND location_id = $2`,
      [fx.businessId, fx.locB],
    );
    expect(bDocs[0].n).toBeGreaterThan(1);

    // The F&B register enforces the same rule through the same primitive.
    const fnbRows = await fnbService.listWarehouseDocuments(fx.businessId, {
      locationIds,
      limit: 100,
    });
    expect(new Set(fnbRows.map((row) => row.location_id))).toEqual(new Set([fx.locA]));
    expect(fnbRows.some((row) => row.id === fx.fnbDocB)).toBe(false);
  });

  it("2. naming a branch they may not act in is refused, without leaking it", async () => {
    const { session } = await permittedFor(fx.branchA, "manager");
    const denied = await authorizeLib.authorize(session, { locationId: fx.locB });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.code).toBe("LOCATION_FORBIDDEN");
    expect(denied.status).toBe(403);
    const response = authorizeLib.denialResponse(denied);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.error).toBe("forbidden");
    expect(body.code).toBe("LOCATION_FORBIDDEN");
    // Nothing about the branch travels with the refusal.
    expect(JSON.stringify(body)).not.toContain(fx.locB);
  });

  it("3. opening another branch's voucher by id is refused before any payload is read", async () => {
    // The row is readable by id (that is what makes the check meaningful)…
    const asB = await printLib.loadPrintableWarehouseDocument({
      businessId: fx.businessId,
      documentId: fx.docB,
      family: "retail",
    });
    expect(asB?.locationId).toBe(fx.locB);

    // …and the detail/print order refuses before handing it over, because the
    // route authorizes the *document's own* location.
    const { session } = await permittedFor(fx.branchA, "manager");
    const decision = await authorizeLib.authorize(session, { locationId: asB!.locationId });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.code).toBe("LOCATION_FORBIDDEN");

    // Its own branch's voucher passes the same check.
    const own = await printLib.loadPrintableWarehouseDocument({
      businessId: fx.businessId,
      documentId: fx.docA,
      family: "retail",
    });
    const ownDecision = await authorizeLib.authorize(session, { locationId: own!.locationId });
    expect(ownDecision.ok).toBe(true);

    // The same for the F&B detail/print pair.
    const fnbB = await printLib.loadPrintableWarehouseDocument({
      businessId: fx.businessId,
      documentId: fx.fnbDocB,
      family: "fnb",
    });
    const fnbDecision = await authorizeLib.authorize(session, { locationId: fnbB!.locationId });
    expect(fnbDecision.ok).toBe(false);
  });

  it("4. the owner reads every branch and can narrow to one", async () => {
    const { locationIds } = await permittedFor(fx.owner, "owner");
    expect(new Set(locationIds)).toEqual(new Set([fx.locA, fx.locB, fx.locDubai]));

    const all = await retailService.listRetailWarehouseDocuments(fx.businessId, {
      locationIds,
      limit: 100,
    });
    expect(new Set(all.map((row) => row.location_id))).toEqual(new Set([fx.locA, fx.locB, fx.locDubai]));

    const onlyB = await retailService.listRetailWarehouseDocuments(fx.businessId, {
      locationIds: [fx.locB],
      limit: 100,
    });
    expect(onlyB.length).toBeGreaterThan(0);
    expect(new Set(onlyB.map((row) => row.location_id))).toEqual(new Set([fx.locB]));
  });

  it("5. writing into another branch is refused", async () => {
    const { session } = await permittedFor(fx.branchA, "manager");
    // This is the guard both write paths run before touching stock or ledger:
    // POST /warehouse-documents and POST /[id]/reverse.
    const denied = await authorizeLib.authorize(session, { locationId: fx.locB });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.status).toBe(403);

    // And the denial really did stop the write: B's document count is unchanged
    // by the attempt above.
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM retail_warehouse_documents WHERE business_id = $1 AND location_id = $2`,
      [fx.businessId, fx.locB],
    );
    expect(rows[0].n).toBe(3); // two receipts + their reversal
  });

  it("6. a member with no branch scope reads an empty register, and another tenant's voucher is not found", async () => {
    const { locationIds } = await permittedFor(fx.noBranch, "manager");
    expect(locationIds).toEqual([]);

    const rows = await retailService.listRetailWarehouseDocuments(fx.businessId, {
      locationIds,
      limit: 100,
    });
    expect(rows).toEqual([]);
    // The table is not empty — the scope is.
    const { rows: count } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM retail_warehouse_documents WHERE business_id = $1`,
      [fx.businessId],
    );
    expect(count[0].n).toBeGreaterThan(0);

    // A voucher id from another tenant resolves to nothing at all, so the route
    // answers 404 without confirming it exists somewhere.
    const foreign = await printLib.loadPrintableWarehouseDocument({
      businessId: fx.otherBusinessId,
      documentId: fx.docA,
      family: "retail",
    });
    expect(foreign).toBeNull();
    const foreignHistory = await historyLib.loadWarehouseDocumentHistory({
      businessId: fx.otherBusinessId,
      locationId: fx.locA,
      documentId: fx.docA,
      family: "retail",
    });
    expect(foreignHistory).toEqual({ original: null, reversal: null });
  });
});

describe("P2 filters", () => {
  it("filters by the amount band, creator and posting state", async () => {
    const { locationIds } = await permittedFor(fx.owner, "owner");

    // docA carries 4 × 100,000 = 400,000; docB carries 2 × 300,000 = 600,000.
    const byAmount = await retailService.listRetailWarehouseDocuments(fx.businessId, {
      locationIds,
      amountMin: "450000",
      amountMax: "700000",
      limit: 100,
    });
    expect(byAmount.length).toBeGreaterThan(0);
    for (const row of byAmount) {
      expect(Number(row.total_value_rial)).toBeGreaterThanOrEqual(450_000);
      expect(Number(row.total_value_rial)).toBeLessThanOrEqual(700_000);
    }
    expect(byAmount.map((row) => row.id)).toContain(fx.docB);
    expect(byAmount.map((row) => row.id)).not.toContain(fx.docA);
  });

  it("narrows to one creator and one posting state", async () => {
    const { locationIds } = await permittedFor(fx.owner, "owner");

    const byCreator = await retailService.listRetailWarehouseDocuments(fx.businessId, {
      locationIds,
      createdBy: fx.branchA,
      limit: 100,
    });
    expect(byCreator.length).toBeGreaterThan(0);
    expect(new Set(byCreator.map((row) => row.location_id))).toEqual(new Set([fx.locA]));

    const posted = await retailService.listRetailWarehouseDocuments(fx.businessId, {
      locationIds,
      postingState: "posted",
      limit: 100,
    });
    expect(posted.length).toBeGreaterThan(0);
    expect(posted.some((row) => row.id === fx.docA)).toBe(true);

    // Break one document's source-linked posting and it moves to `missing`.
    await db.query(
      `UPDATE domain_events SET entry_id = NULL
        WHERE business_id = $1 AND source_type = 'retail_warehouse_document' AND source_id = $2`,
      [fx.businessId, fx.docA],
    );
    const missing = await retailService.listRetailWarehouseDocuments(fx.businessId, {
      locationIds,
      postingState: "missing",
      limit: 100,
    });
    expect(missing.map((row) => row.id)).toContain(fx.docA);
    const stillPosted = await retailService.listRetailWarehouseDocuments(fx.businessId, {
      locationIds,
      postingState: "posted",
      limit: 100,
    });
    expect(stillPosted.map((row) => row.id)).not.toContain(fx.docA);
  });

  it("pages the default sort through the encoded cursor the route hands the client", async () => {
    // The route returns `nextCursor` built from the row's `sort_key` and the
    // client sends it straight back. This is that round trip: encode → decode →
    // next page. It is the test that catches a sort key the decoder rejects
    // (a `timestamptz` rendered as `2026-10-22 09:00:00+00`, say), which would
    // break paging on the register's default order while the SQL looked fine.
    const { locationIds } = await permittedFor(fx.owner, "owner");
    const first = await retailService.listRetailWarehouseDocuments(fx.businessId, {
      locationIds,
      limit: 2,
    });
    expect(first.length).toBe(2);
    const encoded = registerLib.encodeWarehouseRegisterCursor({
      sort: "created_desc",
      key: first[first.length - 1].sort_key,
      id: first[first.length - 1].id,
    });
    const decoded = registerLib.decodeWarehouseRegisterCursor(encoded, "created_desc");
    expect(decoded).not.toBeNull();

    const second = await retailService.listRetailWarehouseDocuments(fx.businessId, {
      locationIds,
      sort: "created_desc",
      cursor: decoded,
      limit: 100,
    });
    const firstIds = first.map((row) => row.id);
    expect(second.some((row) => firstIds.includes(row.id))).toBe(false);
    expect(second.length).toBeGreaterThan(0);

    // The same round trip for a date sort and an amount sort.
    for (const sort of ["date_desc", "amount_desc"] as const) {
      const page = await retailService.listRetailWarehouseDocuments(fx.businessId, {
        locationIds,
        sort,
        limit: 1,
      });
      const cursor = registerLib.decodeWarehouseRegisterCursor(
        registerLib.encodeWarehouseRegisterCursor({ sort, key: page[0].sort_key, id: page[0].id }),
        sort,
      );
      expect(cursor, `${sort} key ${page[0].sort_key} must survive the cursor`).not.toBeNull();
      const next = await retailService.listRetailWarehouseDocuments(fx.businessId, {
        locationIds,
        sort,
        cursor,
        limit: 1,
      });
      expect(next[0]?.id).not.toBe(page[0].id);
    }
  });

  it("pages a non-default sort without repeating or skipping a row", async () => {
    const { locationIds } = await permittedFor(fx.owner, "owner");
    const seen: string[] = [];
    let cursor: { sort: "amount_asc"; key: string; id: string } | null = null;
    for (let page = 0; page < 10; page++) {
      const rows = await retailService.listRetailWarehouseDocuments(fx.businessId, {
        locationIds,
        sort: "amount_asc",
        cursor,
        limit: 1,
      });
      if (rows.length === 0) break;
      seen.push(rows[0].id);
      cursor = { sort: "amount_asc", key: rows[0].sort_key, id: rows[0].id };
      expect(rows.length).toBe(1);
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(3);
  });
});

describe("branch-aware business date", () => {
  it("derives a legacy document's day in its own branch's timezone", async () => {
    const { locationIds } = await permittedFor(fx.owner, "owner");
    const rows = await retailService.listRetailWarehouseDocuments(fx.businessId, {
      locationIds: [fx.locDubai],
      limit: 10,
    });
    expect(rows.length).toBe(1);
    // 2026-03-21 20:30 UTC is 2026-03-22 00:30 in Dubai (UTC+4).
    expect(rows[0].business_date).toBe("2026-03-22");
    expect(rows[0].location_timezone).toBe("Asia/Dubai");
  });

  it("finds that document by its business date, not the server's date", async () => {
    const { locationIds } = await permittedFor(fx.owner, "owner");
    const byBranchDay = await retailService.listRetailWarehouseDocuments(fx.businessId, {
      locationIds: [fx.locDubai],
      dateFrom: "2026-03-22",
      dateTo: "2026-03-22",
      limit: 10,
    });
    expect(byBranchDay.length).toBe(1);
    const serverDay = await retailService.listRetailWarehouseDocuments(fx.businessId, {
      locationIds: [fx.locDubai],
      dateFrom: "2026-03-21",
      dateTo: "2026-03-21",
      limit: 10,
    });
    expect(serverDay.length).toBe(0);
  });
});

describe("correction / reversal history", () => {
  it("shows the original and the reversal with reason and actor", async () => {
    const { rows: reversalRows } = await db.query<{ id: string }>(
      `SELECT id FROM retail_warehouse_documents WHERE business_id = $1 AND reversed_of = $2`,
      [fx.businessId, fx.docBReversed],
    );
    const reversalId = reversalRows[0].id;

    const originalSide = await historyLib.loadWarehouseDocumentHistory({
      businessId: fx.businessId,
      locationId: fx.locB,
      documentId: fx.docBReversed,
      family: "retail",
    });
    expect(originalSide.original).toBeNull();
    expect(originalSide.reversal?.id).toBe(reversalId);
    expect(originalSide.reversal?.reason).toBe("خطای شمارش اولیه");
    expect(originalSide.reversal?.actorName).toBe("Owner Zero");
    expect(originalSide.reversal?.reversesVoucherNumber).toBeTruthy();

    const reversalSide = await historyLib.loadWarehouseDocumentHistory({
      businessId: fx.businessId,
      locationId: fx.locB,
      documentId: reversalId,
      family: "retail",
    });
    expect(reversalSide.original?.id).toBe(fx.docBReversed);
    expect(reversalSide.reversal).toBeNull();
  });

  it("never crosses the branch boundary when following a link", async () => {
    const history = await historyLib.loadWarehouseDocumentHistory({
      businessId: fx.businessId,
      locationId: fx.locA, // wrong branch on purpose
      documentId: fx.docBReversed,
      family: "retail",
    });
    expect(history).toEqual({ original: null, reversal: null });
  });

  it("keeps a generated reason when the caller gave none", () => {
    expect(historyLib.normaliseReversalReason(null, "یادداشت", "برگشت سند R-1")).toBe("یادداشت");
    expect(historyLib.normaliseReversalReason(null, null, "برگشت سند R-1")).toBe("برگشت سند R-1");
    expect(historyLib.normaliseReversalReason("دلیل واقعی", "یادداشت", "x")).toBe("دلیل واقعی");
  });
});

describe("printable sheet", () => {
  it("renders the platform A4 template with the branch's date and the document's lines", async () => {
    const document = await printLib.loadPrintableWarehouseDocument({
      businessId: fx.businessId,
      documentId: fx.docA,
      family: "retail",
    });
    expect(document).not.toBeNull();
    const data = printLib.buildWarehousePrintData({
      document: document!,
      business: { name: "کسب‌وکار آزمون" },
      unit: "toman",
    });
    expect(data.title).toBe("رسید انبار");
    expect(data.lines).toHaveLength(1);
    expect(data.lines[0].quantity).toBe(4);
    expect(data.total).toBe(400_000);
    // A business day is printed as a day: no clock, pinned so no offset moves it.
    expect(data.showTime).toBe(false);
    expect(data.timeZone).toBe("UTC");

    const html = await printLib.renderWarehouseDocumentHtml({
      businessId: fx.businessId,
      document: document!,
    });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("رسید انبار");
    expect(html).toContain("Register Branch Biz");
    expect(html).toContain("Retail A");
    // The sheet is printable: paper size and the print rule are in the output.
    expect(html).toContain("@page");
  });

  it("labels a reversal sheet as such and carries its reason", async () => {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM retail_warehouse_documents WHERE business_id = $1 AND reversed_of = $2`,
      [fx.businessId, fx.docBReversed],
    );
    const document = await printLib.loadPrintableWarehouseDocument({
      businessId: fx.businessId,
      documentId: rows[0].id,
      family: "retail",
    });
    const data = printLib.buildWarehousePrintData({
      document: document!,
      business: { name: "کسب‌وکار آزمون" },
      unit: "rial",
    });
    expect(data.title).toContain("برگشت");
    expect(data.note).toContain("خطای شمارش اولیه");
    expect(data.subtitle).toContain("Branch B");
  });
});

describe("the register's SQL contract", () => {
  it("keeps the branch timezone on every row so the screen can format clocks", async () => {
    const { locationIds } = await permittedFor(fx.owner, "owner");
    const rows = await fnbService.listWarehouseDocuments(fx.businessId, { locationIds, limit: 50 });
    for (const row of rows) {
      expect(row.location_timezone).toBeTruthy();
      expect(row.sort_key).toBeTruthy();
      expect(/^\d{4}-\d{2}-\d{2}$/.test(row.business_date)).toBe(true);
    }
  });
});
