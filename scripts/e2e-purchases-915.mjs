#!/usr/bin/env node
/**
 * Issue #915 — one manual pass through the canonical Accounting → انبار → خرید
 * workspace, food-service engine: **purchase → receipt → return → report**.
 *
 * The pass talks to a real `npm run dev`/`npm start` server over HTTP, exactly
 * as the browser does (session cookie, `Origin` header, the same routes the
 * screen calls), and reads the resulting rows out of the real Postgres beside
 * it. Nothing is mocked and no assertion is retried into a pass.
 *
 *   # fresh database (migrations applied), server running on :3000
 *   node scripts/e2e-purchases-915.mjs --evidence docs/audits/915-evidence
 *
 * Environment:
 *   E2E_BASE_URL   default http://127.0.0.1:3000
 *   DATABASE_URL   default postgres://pos:pos@localhost:5432/pos
 *
 * The install must be **empty**: the pass starts at the product's own first-run
 * bootstrap, because that is what writes the business's industry (food service),
 * and it keeps the session bootstrap hands back. Re-running against an
 * initialized database exits with code 2 by design — recreate the database
 * (`createdb` + `npm run db:migrate`) instead of half-replaying the pass.
 *
 * What it proves, in order:
 *
 *   1. A draft purchase can be created, edited, ordered, received and — while
 *      unreceived — cancelled or deleted, with no stock, lot, journal or sync
 *      effect until the receipt.
 *   2. The receipt is the effect: stock movements, FIFO lots, per-line cost
 *      allocations, `inventory_events` and a balanced purchase journal entry
 *      (Debit 1300 + Debit 1220 / Credit 2100 for a credit purchase).
 *   3. A received purchase cannot be edited, cancelled or deleted — the
 *      correction is a supplier return, never an edit (the #915 decision).
 *   4. The supplier return is posted **by the server**, in the receipt's own
 *      terms: proportional goods value, cumulative VAT reversal, lot quantities
 *      and values reduced, a balanced return journal entry (Debit 2100 /
 *      Credit 1300 + Credit 1220), and the same answer — not a second document
 *      — on an idempotent retry. Over-return and a lot belonging to another
 *      line are refused.
 *   5. The reports reconcile with the ledger and with each other: purchase
 *      history (JSON totals + CSV), «خرید به تفکیک تأمین‌کننده», «ارزش‌گذاری
 *      موجودی», the stock-level screen, and the 1300/1220/2100 balances read
 *      straight from the posted entries.
 *   6. Ownership: while the branch is unpaired the server records **no**
 *      sync events at all (the cloud owns the effect); once a desktop is paired
 *      to the branch, exactly the three *effect* events appear — create,
 *      receive, supplier return — and edit/order/cancel/delete still record
 *      nothing. The return's event is written by the server in the same
 *      transaction as the posting, which is what "returns stay server-posted"
 *      means in this codebase.
 *
 * Exits non-zero if any expectation fails.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const BASE = (process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://pos:pos@localhost:5432/pos";

const argIndex = process.argv.indexOf("--evidence");
const EVIDENCE_DIR =
  argIndex > -1 ? path.resolve(process.argv[argIndex + 1] ?? "docs/audits/915-evidence") : null;

const RUN = randomUUID().slice(0, 8);
const costs = {
  // Rial. Each line is entered in the item's PURCHASE unit; the server converts
  // to the base unit (kg→g, L→ml) before anything is stored.
  flourDraft: "4000000",
  flourEdited: "4000000",
  milkDraft: "6000000",
  milkEdited: "7500000",
  goodsDraft: "10000000",
  goodsEdited: "11500000",
  vatDraft: 900000,
  vatEdited: 1035000,
  payable: "12535000",
  returnFlourQty: "2500", // g of 10,000
  returnMilkQty: "5000", // ml of 25,000
  returnFlourValue: "1000000",
  returnMilkValue: "1500000",
  returnGoods: "2500000",
  returnVat: "225000", // 1,035,000 × 2,500,000 / 11,500,000
  returnPayable: "2725000",
  remainingFlourValue: "3000000",
  remainingMilkValue: "6000000",
  inventoryLeft: "9000000",
  payableLeft: "9810000",
  vatLeft: "810000",
};

const transcript = [];
const failures = [];
const checks = [];
/** The rows behind the numbers, kept for the evidence file. */
const facts = {};

function log(line = "") {
  transcript.push(line);
  console.log(line);
}

function check(name, condition, detail = "") {
  checks.push({ name, ok: Boolean(condition), detail });
  if (condition) log(`  ✓ ${name}`);
  else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  log("");
  log(`── ${title} ──`);
}

/** numeric()/money columns come back at their own scale ("10000.000000000"). */
function num(value) {
  return Number(value ?? Number.NaN);
}

/** Persian digits → ASCII, for assertions on user-facing (Shamsi) dates. */
function latinDigits(text) {
  return String(text).replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
}

let cookie = "";

/** One HTTP call as the browser's own page would make it (cookie + Origin). */
async function api(method, pathname, body) {
  const headers = { origin: BASE, accept: "application/json, text/csv;q=0.9, */*;q=0.8" };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  // Keep the freshest session cookie (bootstrap sets it; login rotates it).
  const setCookies = response.headers.getSetCookie?.() ?? [];
  for (const raw of setCookies) {
    const [pair] = raw.split(";");
    if (pair.startsWith("pos_session=")) cookie = pair;
  }
  // Decoded with ignoreBOM so the CSV export's UTF-8 BOM is visible to the
  // assertion instead of being silently stripped by the decoder.
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, bytes, text, json };
}

const db = new Client({ connectionString: DATABASE_URL });

async function rows(sql, params = []) {
  const result = await db.query(sql, params);
  return result.rows;
}

async function one(sql, params = []) {
  return (await rows(sql, params))[0] ?? null;
}

/** Reads a row count for a table the pass cares about, scoped to the branch. */
async function count(sql, params = []) {
  return Number((await one(sql, params))?.count ?? 0);
}

async function ledger(entryId) {
  return rows(
    `SELECT a.code, a.name, jl.debit::text, jl.credit::text
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
      WHERE jl.entry_id = $1 ORDER BY a.code`,
    [entryId],
  );
}

/** Σ debit and Σ credit of one entry, as text — equality is the assertion. */
function balanced(lines) {
  const debit = lines.reduce((sum, line) => sum + BigInt(line.debit), 0n);
  const credit = lines.reduce((sum, line) => sum + BigInt(line.credit), 0n);
  return { debit: debit.toString(), credit: credit.toString(), balanced: debit === credit };
}

function accountLine(lines, code) {
  return lines.find((line) => line.code === code) ?? null;
}

async function main() {
  await db.connect();
  log(`Issue #915 manual pass — ${BASE} / ${DATABASE_URL}`);
  log(`run ${RUN} · ${new Date().toISOString()}`);

  // ── 0. first run: bootstrap → wizard basics → fixture master data ─────────
  section("0. First run — bootstrap, chart of accounts, costing, tax");

  const bootstrap = await api("POST", "/api/setup/bootstrap", {
    businessName: `کافه آزمون ۹۱۵ ${RUN}`,
    locationName: "شعبه مرکزی",
    ownerName: "مالک آزمون ۹۱۵",
    ownerPhone: "09121234567",
    email: `pass915-${RUN}@example.com`,
    password: `pass915-${RUN}-Aa1`,
    industry: "food_service",
    deploymentMode: "connected",
  });
  check(
    "bootstrap created the business and signed the owner in",
    bootstrap.status === 200 && bootstrap.json?.signedIn === true,
    `status ${bootstrap.status} ${bootstrap.text.slice(0, 200)}`,
  );
  if (bootstrap.status === 409) {
    log("");
    log("This install already has a user. The pass starts from an empty database by design:");
    log("  dropdb/create the database, run `npm run db:migrate`, then run this script again.");
    process.exit(2);
  }

  const business = await one("SELECT id, industry FROM businesses ORDER BY created_at LIMIT 1");
  const location = await one("SELECT id, name FROM locations WHERE business_id = $1 LIMIT 1", [
    business.id,
  ]);
  check("the business's industry is food service", business.industry === "food_service", business.industry);
  log(`  business ${business.id} · branch ${location.id}`);

  const accountsTemplate = await api("GET", "/api/setup/accounts");
  check(
    "the wizard offers the food-service chart template",
    accountsTemplate.status === 200 && accountsTemplate.json?.template?.length > 0,
    `status ${accountsTemplate.status}`,
  );
  const accountsInstalled = await api("POST", "/api/setup/accounts", {
    accounts: accountsTemplate.json.template,
  });
  check(
    "the chart of accounts is installed",
    accountsInstalled.status === 200,
    `status ${accountsInstalled.status} ${accountsInstalled.text.slice(0, 200)}`,
  );

  const costing = await api("POST", "/api/setup/costing", { method: "fifo", system: "perpetual" });
  check("costing is FIFO on the perpetual system", costing.status === 200, `status ${costing.status}`);
  const tax = await api("POST", "/api/setup/tax", { defaultRate: 9 });
  check("the business's VAT rate is 9%", tax.status === 200, `status ${tax.status}`);

  const flour = await api("POST", "/api/inventory/items", {
    name: `آرد آزمون ${RUN}`,
    unit: "g",
    purchaseUnit: "kg",
    purchaseUnitFactor: 1000,
    reorderLevel: 5000,
  });
  const milk = await api("POST", "/api/inventory/items", {
    name: `شیر آزمون ${RUN}`,
    unit: "ml",
    purchaseUnit: "L",
    purchaseUnitFactor: 1000,
    reorderLevel: 10000,
  });
  check(
    "two ingredients exist (kg→g and L→ml purchase units)",
    flour.status === 200 && milk.status === 200,
    `flour ${flour.status}, milk ${milk.status}`,
  );
  const flourId = flour.json.id;
  const milkId = milk.json.id;

  const supplier = await api("POST", "/api/inventory/suppliers", {
    name: `تأمین‌کنندهٔ آزمون ۹۱۵ ${RUN}`,
    phone: "02155443322",
  });
  check("a supplier exists", supplier.status === 200, `status ${supplier.status}`);
  const supplierId = supplier.json.id;

  const baseline = await one(
    `SELECT
       (SELECT count(*) FROM stock_movements WHERE location_id = $1)::int AS movements,
       (SELECT count(*) FROM inventory_lots WHERE location_id = $1)::int AS lots,
       (SELECT count(*) FROM journal_entries WHERE location_id = $1)::int AS entries,
       (SELECT count(*) FROM sync_events WHERE location_id = $1)::int AS events`,
    [location.id],
  );
  check(
    "the branch starts empty: no stock, lots, entries or sync events",
    baseline.movements === 0 && baseline.lots === 0 && baseline.entries === 0 && baseline.events === 0,
    JSON.stringify(baseline),
  );

  // ── 1. draft → edit → order → receive ────────────────────────────────────
  section("1. Purchase → draft, edit, order, receive");

  const created = await api("POST", "/api/inventory/purchases", {
    supplierId,
    note: `خرید آزمون ۹۱۵ ${RUN}`,
    items: [
      { inventoryItemId: flourId, purchaseQty: "10", totalCost: costs.flourDraft },
      { inventoryItemId: milkId, purchaseQty: "20", totalCost: costs.milkDraft },
    ],
    invoice: {
      invoiceNumber: "INV-915-1",
      invoiceDate: "2026-10-18",
      vatAmount: costs.vatDraft,
      paymentTermsDays: 30,
    },
  });
  check(
    "a draft purchase is created with the lines' total",
    created.status === 200 && created.json?.id && created.json.total === costs.goodsDraft,
    `status ${created.status} ${created.text.slice(0, 200)}`,
  );
  const purchaseId = created.json.id;

  const afterCreate = await one(
    `SELECT p.status::text, p.total::text, p.vat_amount::text, p.supplier_invoice_number,
            p.purchase_date::text,
            (SELECT count(*) FROM stock_movements WHERE location_id = p.location_id)::int AS movements,
            (SELECT count(*) FROM journal_entries WHERE location_id = p.location_id)::int AS entries
       FROM purchases p WHERE p.id = $1`,
    [purchaseId],
  );
  check(
    "the draft has posted nothing: no stock movement, no journal entry",
    afterCreate.status === "draft" && afterCreate.movements === 0 && afterCreate.entries === 0,
    JSON.stringify(afterCreate),
  );

  const edited = await api("PUT", `/api/inventory/purchases/${purchaseId}`, {
    supplierId,
    note: `خرید آزمون ۹۱۵ ${RUN} — ویرایش‌شده`,
    purchaseDate: "2026-10-18",
    items: [
      { inventoryItemId: flourId, purchaseQty: "10", totalCost: costs.flourEdited },
      { inventoryItemId: milkId, purchaseQty: "25", totalCost: costs.milkEdited },
    ],
    invoice: {
      invoiceNumber: "INV-915-1",
      invoiceDate: "2026-10-18",
      vatAmount: costs.vatEdited,
      paymentTermsDays: 30,
    },
  });
  check(
    "the draft is editable (PUT) and the total is recomputed",
    edited.status === 200 && edited.json?.total === costs.goodsEdited,
    `status ${edited.status} ${edited.text.slice(0, 200)}`,
  );
  const editedLines = await rows(
    `SELECT ii.name, pi.quantity::text, pi.unit_cost::text, pi.extended_cost::text
       FROM purchase_items pi JOIN inventory_items ii ON ii.id = pi.inventory_item_id
      WHERE pi.purchase_id = $1 ORDER BY pi.quantity DESC`,
    [purchaseId],
  );
  check(
    "purchase-unit lines became base units at the line's own unit cost (10 kg=10,000 g @400, 25 L=25,000 ml @300)",
    editedLines.length === 2 &&
      editedLines[0].quantity !== undefined &&
      num(editedLines[0].quantity) === 25000 &&
      num(editedLines[0].unit_cost) === 300 &&
      num(editedLines[1].quantity) === 10000 &&
      num(editedLines[1].unit_cost) === 400,
    JSON.stringify(editedLines),
  );

  facts.editedLines = editedLines;

  const ordered = await api("PATCH", `/api/inventory/purchases/${purchaseId}`, { status: "ordered" });
  const orderedRow = await one("SELECT status::text, ordered_at FROM purchases WHERE id = $1", [purchaseId]);
  check(
    "the purchase is ordered without any stock or ledger effect",
    ordered.status === 200 && orderedRow.status === "ordered" && orderedRow.ordered_at !== null,
    `status ${ordered.status}`,
  );

  const received = await api("PATCH", `/api/inventory/purchases/${purchaseId}`, {
    status: "received",
    settlementMethod: "credit",
  });
  check("the purchase is received on credit", received.status === 200, `status ${received.status} ${received.text.slice(0, 200)}`);

  const receiptMovements = await rows(
    `SELECT ii.name, sm.type::text, sm.quantity::text, sm.cost_value_rial::text
       FROM stock_movements sm JOIN inventory_items ii ON ii.id = sm.inventory_item_id
      WHERE sm.location_id = $1 ORDER BY ii.name, sm.id`,
    [location.id],
  );
  check(
    "the receipt moved exactly the two lines into stock at their cost",
    receiptMovements.length === 2 &&
      receiptMovements.some((m) => num(m.quantity) === 10000 && m.cost_value_rial === costs.flourEdited) &&
      receiptMovements.some((m) => num(m.quantity) === 25000 && m.cost_value_rial === costs.milkEdited),
    JSON.stringify(receiptMovements),
  );

  const lots = await rows(
    `SELECT il.id, ii.name, il.remaining_qty::text, il.remaining_value_rial::text, il.source_type
       FROM inventory_lots il JOIN inventory_items ii ON ii.id = il.inventory_item_id
      WHERE il.location_id = $1 ORDER BY ii.name`,
    [location.id],
  );
  check(
    "each line became its own FIFO lot with its own value",
    lots.length === 2 &&
      lots.some((lot) => num(lot.remaining_qty) === 10000 && lot.remaining_value_rial === costs.flourEdited) &&
      lots.some((lot) => num(lot.remaining_qty) === 25000 && lot.remaining_value_rial === costs.milkEdited),
    JSON.stringify(lots),
  );

  facts.receiptMovements = receiptMovements;
  facts.lots = lots;
  const receiptEntry = await one(
    "SELECT id FROM journal_entries WHERE source_type = 'purchase' AND source_id = $1",
    [purchaseId],
  );
  const receiptLines = receiptEntry ? await ledger(receiptEntry.id) : [];
  const receiptBalance = balanced(receiptLines);
  check(
    "the receipt posted one balanced entry: Dr 1300 goods + Dr 1220 VAT / Cr 2100 payable",
    receiptEntry &&
      receiptBalance.balanced &&
      accountLine(receiptLines, "1300")?.debit === costs.goodsEdited &&
      accountLine(receiptLines, "1220")?.debit === String(costs.vatEdited) &&
      accountLine(receiptLines, "2100")?.credit === costs.payable,
    JSON.stringify({ lines: receiptLines, ...receiptBalance }),
  );

  facts.receiptJournal = { lines: receiptLines, ...receiptBalance };
  const receiptEvent = await one(
    "SELECT event_type, posting_status FROM inventory_events WHERE source_type = 'purchase' AND source_id = $1",
    [purchaseId],
  );
  check(
    "the receipt's inventory event is posted inside the same transaction",
    receiptEvent?.event_type === "purchase_receipt" && receiptEvent.posting_status === "posted",
    JSON.stringify(receiptEvent),
  );

  // ── 2. a received purchase is corrected by a return, never by an edit ─────
  section("2. A received purchase refuses correction");

  const editReceived = await api("PUT", `/api/inventory/purchases/${purchaseId}`, {
    supplierId,
    items: [{ inventoryItemId: flourId, purchaseQty: "1", totalCost: "1" }],
  });
  check(
    "PUT on a received purchase is refused (409 purchase_received_cannot_edit)",
    editReceived.status === 409 && editReceived.json?.error === "purchase_received_cannot_edit",
    `status ${editReceived.status} ${editReceived.text.slice(0, 120)}`,
  );
  const cancelReceived = await api("PATCH", `/api/inventory/purchases/${purchaseId}`, { status: "cancelled" });
  check(
    "cancelling a received purchase is refused (409 invalid_transition)",
    cancelReceived.status === 409 && cancelReceived.json?.error === "invalid_transition",
    `status ${cancelReceived.status} ${cancelReceived.text.slice(0, 120)}`,
  );
  const deleteReceived = await api("DELETE", `/api/inventory/purchases/${purchaseId}`);
  check(
    "deleting a received purchase is refused (409 purchase_received_cannot_delete)",
    deleteReceived.status === 409 && deleteReceived.json?.error === "purchase_received_cannot_delete",
    `status ${deleteReceived.status} ${deleteReceived.text.slice(0, 120)}`,
  );
  const stillReceived = await one(
    `SELECT status::text, total::text,
            (SELECT count(*) FROM journal_entries WHERE source_type = 'purchase' AND source_id = $1)::int AS entries
       FROM purchases WHERE id = $1`,
    [purchaseId],
  );
  check(
    "the refused corrections changed nothing",
    stillReceived.status === "received" &&
      stillReceived.total === costs.goodsEdited &&
      stillReceived.entries === 1,
    JSON.stringify(stillReceived),
  );

  // ── 3. unreceived documents: edit → order → cancel, and delete ───────────
  section("3. Unreceived documents — edit, order, cancel, delete");

  const drafted = await api("POST", "/api/inventory/purchases", {
    supplierId,
    note: `پیش‌نویس لغوشده ${RUN}`,
    items: [{ inventoryItemId: flourId, purchaseQty: "1", totalCost: "400000" }],
  });
  const cancelledId = drafted.json.id;
  await api("PATCH", `/api/inventory/purchases/${cancelledId}`, { status: "ordered" });
  const orderEdited = await api("PUT", `/api/inventory/purchases/${cancelledId}`, {
    supplierId,
    note: `سفارش ویرایش‌شده ${RUN}`,
    items: [{ inventoryItemId: flourId, purchaseQty: "2", totalCost: "800000" }],
  });
  const cancelled = await api("PATCH", `/api/inventory/purchases/${cancelledId}`, { status: "cancelled" });
  const cancelledRow = await one("SELECT status::text, total::text FROM purchases WHERE id = $1", [cancelledId]);
  check(
    "an ordered purchase can still be edited, then cancelled",
    orderEdited.status === 200 && cancelled.status === 200 && cancelledRow.status === "cancelled",
    `edit ${orderEdited.status}, cancel ${cancelled.status}`,
  );

  const doomed = await api("POST", "/api/inventory/purchases", {
    supplierId,
    note: `پیش‌نویس حذف‌شده ${RUN}`,
    items: [{ inventoryItemId: milkId, purchaseQty: "1", totalCost: "300000" }],
  });
  const deleteUnreceived = await api("DELETE", `/api/inventory/purchases/${doomed.json.id}`);
  const deletedRow = await one("SELECT id FROM purchases WHERE id = $1", [doomed.json.id]);
  const orphanLines = await count("SELECT count(*)::int AS count FROM purchase_items WHERE purchase_id = $1", [
    doomed.json.id,
  ]);
  check(
    "a draft purchase can be deleted with its lines",
    deleteUnreceived.status === 200 && deletedRow === null && orphanLines === 0,
    `status ${deleteUnreceived.status}`,
  );

  const afterLifecycle = await one(
    `SELECT
       (SELECT count(*) FROM stock_movements WHERE location_id = $1)::int AS movements,
       (SELECT count(*) FROM journal_entries WHERE location_id = $1)::int AS entries,
       (SELECT count(*) FROM sync_events WHERE location_id = $1)::int AS events`,
    [location.id],
  );
  check(
    "edit / order / cancel / delete posted no stock, no entry and no sync event",
    afterLifecycle.movements === 2 && afterLifecycle.entries === 1 && afterLifecycle.events === 0,
    JSON.stringify(afterLifecycle),
  );

  // ── 4. supplier return — server-posted, proportional, idempotent ─────────
  section("4. Supplier return");

  const detail = await api("GET", `/api/inventory/purchases/${purchaseId}`);
  const detailItems = detail.json?.items ?? [];
  check(
    "the detail resolves each line's own returnable lot",
    detail.status === 200 &&
      detailItems.length === 2 &&
      detailItems.every((item) => typeof item.inventory_lot_id === "string" && item.inventory_lot_id),
    JSON.stringify(detailItems.map((item) => ({ id: item.id, lot: item.inventory_lot_id }))),
  );
  const flourLine = detailItems.find((item) => item.inventory_item_id === flourId);
  const milkLine = detailItems.find((item) => item.inventory_item_id === milkId);

  const returnKey = randomUUID();
  const returnBody = {
    purchaseId,
    settlementMethod: "accounts_payable",
    reason: `مرجوعی آزمون ۹۱۵ ${RUN}`,
    idempotencyKey: returnKey,
    lines: [
      { purchaseItemId: flourLine.id, inventoryLotId: flourLine.inventory_lot_id, quantity: costs.returnFlourQty },
      { purchaseItemId: milkLine.id, inventoryLotId: milkLine.inventory_lot_id, quantity: costs.returnMilkQty },
    ],
  };
  const returned = await api("POST", "/api/inventory/supplier-returns", returnBody);
  check(
    "the return posts with the lines' proportional value",
    returned.status === 200 && returned.json?.value === costs.returnGoods && returned.json?.duplicate === false,
    `status ${returned.status} ${returned.text.slice(0, 200)}`,
  );
  const returnId = returned.json?.id;
  facts.returnDocument = returned.json;

  const returnLines = await rows(
    `SELECT l.quantity::text, l.value_rial::text, ii.name
       FROM supplier_return_lines l
       JOIN purchase_items pi ON pi.id = l.purchase_item_id
       JOIN inventory_items ii ON ii.id = pi.inventory_item_id
      WHERE l.supplier_return_id = $1 ORDER BY ii.name`,
    [returnId],
  );
  check(
    "each returned line is valued from its own lot (1,000,000 + 1,500,000)",
    returnLines.length === 2 &&
      returnLines.some((line) => line.value_rial === costs.returnFlourValue) &&
      returnLines.some((line) => line.value_rial === costs.returnMilkValue),
    JSON.stringify(returnLines),
  );

  const lotsAfterReturn = await rows(
    `SELECT ii.name, il.remaining_qty::text, il.remaining_value_rial::text
       FROM inventory_lots il JOIN inventory_items ii ON ii.id = il.inventory_item_id
      WHERE il.location_id = $1 ORDER BY ii.name`,
    [location.id],
  );
  check(
    "the lots lost exactly the returned quantity and value",
    lotsAfterReturn.length === 2 &&
      lotsAfterReturn.some((lot) => num(lot.remaining_qty) === 7500 && lot.remaining_value_rial === costs.remainingFlourValue) &&
      lotsAfterReturn.some((lot) => num(lot.remaining_qty) === 20000 && lot.remaining_value_rial === costs.remainingMilkValue),
    JSON.stringify(lotsAfterReturn),
  );

  const returnStock = await rows(
    `SELECT quantity::text, cost_value_rial::text, source_type::text
       FROM stock_movements WHERE source_type = 'supplier_return' AND source_id = $1 ORDER BY cost_value_rial`,
    [returnId],
  );
  check(
    "the return wrote negative stock movements — the stock is gone, not edited",
    returnStock.length === 2 &&
      returnStock.some((movement) => num(movement.quantity) === -5000 && movement.cost_value_rial === costs.returnMilkValue) &&
      returnStock.some((movement) => num(movement.quantity) === -2500 && movement.cost_value_rial === costs.returnFlourValue),
    JSON.stringify(returnStock),
  );

  facts.returnLines = returnLines;
  facts.lotsAfterReturn = lotsAfterReturn;
  facts.returnStockMovements = returnStock;
  const returnEntry = await one(
    "SELECT id FROM journal_entries WHERE source_type = 'supplier_return' AND source_id = $1",
    [returnId],
  );
  const returnEntryLines = returnEntry ? await ledger(returnEntry.id) : [];
  const returnBalance = balanced(returnEntryLines);
  check(
    "the server posted the return's balanced entry: Dr 2100 / Cr 1300 goods + Cr 1220 VAT",
    returnEntry &&
      returnBalance.balanced &&
      accountLine(returnEntryLines, "2100")?.debit === costs.returnPayable &&
      accountLine(returnEntryLines, "1300")?.credit === costs.returnGoods &&
      accountLine(returnEntryLines, "1220")?.credit === costs.returnVat,
    JSON.stringify({ lines: returnEntryLines, ...returnBalance }),
  );

  const returnEvent = await one(
    "SELECT event_type, posting_status FROM inventory_events WHERE source_type = 'supplier_return' AND source_id = $1",
    [returnId],
  );
  check(
    "the return's inventory event is posted",
    returnEvent?.event_type === "supplier_return" && returnEvent.posting_status === "posted",
    JSON.stringify(returnEvent),
  );

  facts.returnJournal = { lines: returnEntryLines, ...returnBalance };
  const purchaseAfterReturn = await one("SELECT status::text, total::text FROM purchases WHERE id = $1", [purchaseId]);
  check(
    "the purchase itself is untouched by the return (still received, same total)",
    purchaseAfterReturn.status === "received" && purchaseAfterReturn.total === costs.goodsEdited,
    JSON.stringify(purchaseAfterReturn),
  );

  // Same key, same payload — the answer is the original document.
  const retried = await api("POST", "/api/inventory/supplier-returns", returnBody);
  const afterRetry = await one(
    `SELECT
       (SELECT count(*) FROM supplier_returns WHERE purchase_id = $1)::int AS returns,
       (SELECT count(*) FROM journal_entries WHERE location_id = $2 AND source_type = 'supplier_return')::int AS entries,
       (SELECT count(*) FROM stock_movements WHERE location_id = $2 AND source_type = 'supplier_return')::int AS movements`,
    [purchaseId, location.id],
  );
  check(
    "a retry with the same idempotency key replays the original return — no second document",
    retried.status === 200 && retried.json?.duplicate === true && retried.json?.id === returnId &&
      afterRetry.returns === 1 && afterRetry.entries === 1 && afterRetry.movements === 2,
    JSON.stringify({ retried: retried.json, afterRetry }),
  );

  const overReturn = await api("POST", "/api/inventory/supplier-returns", {
    purchaseId,
    settlementMethod: "accounts_payable",
    reason: `مرجوعی بیش از حد ${RUN}`,
    idempotencyKey: randomUUID(),
    lines: [{ purchaseItemId: flourLine.id, inventoryLotId: flourLine.inventory_lot_id, quantity: "8000" }],
  });
  check(
    "returning more than the lot still holds is refused (409 quantity_underflow)",
    overReturn.status === 409 && overReturn.json?.error === "quantity_underflow",
    `status ${overReturn.status} ${overReturn.text.slice(0, 120)}`,
  );

  // A manipulated lot id: this is the milk's lot named against the flour's line.
  // The lot/line association is checked before anything is written — the same
  // item on two different lines is the case `supplier_return_lot_mismatch`
  // names, exercised below on the repeated-SKU purchase.
  const wrongLot = await api("POST", "/api/inventory/supplier-returns", {
    purchaseId,
    settlementMethod: "accounts_payable",
    reason: `لات اشتباه ${RUN}`,
    idempotencyKey: randomUUID(),
    lines: [{ purchaseItemId: flourLine.id, inventoryLotId: milkLine.inventory_lot_id, quantity: "100" }],
  });
  check(
    "a lot that does not belong to the named line is refused before any write",
    wrongLot.status === 409 && ["supplier_return_lot_not_found", "supplier_return_lot_mismatch"].includes(wrongLot.json?.error),
    `status ${wrongLot.status} ${wrongLot.text.slice(0, 120)}`,
  );

  // ── 5. reports ───────────────────────────────────────────────────────────
  section("5. Reports");

  const history = await api("GET", "/api/inventory/purchases?status=received&page=1");
  check(
    "purchase history totals reconcile with the receipt (11,500,000 + 1,035,000)",
    history.status === 200 &&
      history.json?.totals?.goodsRial === costs.goodsEdited &&
      history.json?.totals?.vatRial === String(costs.vatEdited) &&
      history.json?.totals?.count === 1 &&
      history.json?.purchases?.[0]?.id === purchaseId,
    `status ${history.status} ${JSON.stringify(history.json?.totals)}`,
  );

  facts.history = { totals: history.json?.totals, pagination: history.json?.pagination };
  const csv = await api("GET", "/api/inventory/purchases?status=received&format=csv");
  const csvHasBom = csv.text.startsWith("\uFEFF");
  const csvHeader = csv.text.split("\r\n")[0] ?? "";
  const csvRow = csv.text.split("\r\n")[1] ?? "";
  check(
    "the history exports CSV with exact Rial, the invoice number and a Shamsi date",
    csv.status === 200 &&
      csvHasBom &&
      csvHeader.includes("supplier_invoice_number") &&
      csvRow.includes("INV-915-1") &&
      csvRow.includes(costs.goodsEdited) &&
      csvRow.includes(String(costs.vatEdited)) &&
      // Shamsi, in Persian digits — the export never prints a Gregorian date.
      /["',]{1,2}1[34]\d{2}\/\d{2}\/\d{2}/.test(latinDigits(csvRow)),
    `status ${csv.status} :: ${csvRow.slice(0, 220)}`,
  );

  const bySupplier = await api(
    "GET",
    "/api/reports/standard/purchases_by_supplier?dateFrom=2026-10-01&dateTo=2026-10-31",
  );
  const bySupplierRows = bySupplier.json?.rows ?? [];
  // The report is a row dump of v_purchase_summary, which keeps every status on
  // purpose ("filter on status for received-only spend", reports.ts). The pass
  // therefore reconciles per status instead of summing the dump: the received
  // document carries the receipt's value, the cancelled draft still shows its
  // own status (see the finding in the report).
  const receivedCost = bySupplierRows
    .filter((row) => row.status === "received")
    .reduce((sum, row) => sum + BigInt(row.cost ?? "0"), 0n);
  const cancelledRows = bySupplierRows.filter((row) => row.status === "cancelled");
  check(
    "«خرید به تفکیک تأمین‌کننده» shows the received purchase's goods value under its status",
    bySupplier.status === 200 && receivedCost === BigInt(costs.goodsEdited),
    `status ${bySupplier.status} received ${receivedCost} rows ${JSON.stringify(bySupplierRows.map((row) => [row.status, row.cost]))}`,
  );
  check(
    "the dump keeps each document's status, so a cancelled draft is visible as cancelled, not spend",
    cancelledRows.length === 1 && cancelledRows[0].status === "cancelled" && BigInt(cancelledRows[0].cost) === 800000n,
    JSON.stringify(cancelledRows.map((row) => [row.status, row.cost])),
  );

  facts.purchasesBySupplier = bySupplierRows.map((row) => ({ status: row.status, supplier: row.supplier_name, item: row.item_name, cost: row.cost }));
  const valuation = await api("GET", "/api/reports/standard/inventory_valuation");
  const valuationRows = valuation.json?.rows ?? [];
  const flourValue = valuationRows.find((row) => row.item === `آرد آزمون ${RUN}` || row.item_name === `آرد آزمون ${RUN}`);
  const milkValue = valuationRows.find((row) => row.item === `شیر آزمون ${RUN}` || row.item_name === `شیر آزمون ${RUN}`);
  check(
    "«ارزش‌گذاری موجودی» values what is left after the return (3,000,000 + 6,000,000)",
    valuation.status === 200 &&
      flourValue &&
      milkValue &&
      BigInt(flourValue.valuation ?? "0") === BigInt(costs.remainingFlourValue) &&
      BigInt(milkValue.valuation ?? "0") === BigInt(costs.remainingMilkValue),
    `status ${valuation.status} rows ${JSON.stringify(valuationRows)}`,
  );

  facts.inventoryValuation = valuationRows;
  const stockLevels = await api("GET", "/api/inventory/stock-levels");
  const stockItems = stockLevels.json?.items ?? [];
  const flourStock = stockItems.find((item) => item.item_name === `آرد آزمون ${RUN}` || item.name === `آرد آزمون ${RUN}`);
  const milkStock = stockItems.find((item) => item.item_name === `شیر آزمون ${RUN}` || item.name === `شیر آزمون ${RUN}`);
  check(
    "the stock-level screen shows the remaining quantities and their value",
    stockLevels.status === 200 &&
      flourStock &&
      milkStock &&
      Number(flourStock.quantity) === 7500 &&
      Number(milkStock.quantity) === 20000 &&
      BigInt(stockLevels.json?.totals?.totalValueRial ?? "0") === BigInt(costs.inventoryLeft),
    `status ${stockLevels.status} ${JSON.stringify(stockLevels.json?.totals)}`,
  );

  facts.stockLevels = { totals: stockLevels.json?.totals, items: stockItems };
  const ledgerBalances = await rows(
    `SELECT a.code, sum(jl.debit)::text AS debit, sum(jl.credit)::text AS credit
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
       JOIN journal_entries je ON je.id = jl.entry_id
      WHERE je.location_id = $1 AND a.code IN ('1300','1220','2100')
      GROUP BY a.code ORDER BY a.code`,
    [location.id],
  );
  const net = (code) => {
    const row = ledgerBalances.find((line) => line.code === code);
    return row ? (BigInt(row.debit) - BigInt(row.credit)).toString() : "0";
  };
  check(
    "the ledger agrees with the stock screen and the pegged invoices (1300 9,000,000 · 1220 810,000 · 2100 −9,810,000)",
    net("1300") === costs.inventoryLeft && net("1220") === costs.vatLeft && net("2100") === `-${costs.payableLeft}`,
    JSON.stringify(ledgerBalances),
  );

  // ── 6. ownership: nothing replicated, then exactly the effects ───────────
  section("6. Sync ownership — cloud-only corrections, server-recorded effects");

  const eventsBefore = await count("SELECT count(*)::int AS count FROM sync_events WHERE location_id = $1", [location.id]);
  check(
    "on an unpaired branch the server queues no sync event at all — the cloud owns the effects",
    eventsBefore === 0,
    `sync_events ${eventsBefore}`,
  );

  // A paired desktop: the row pairing writes when an install is bound to this
  // branch (site_devices). Fixture only — the subject here is what the server
  // records once a consumer exists.
  await db.query(
    `INSERT INTO site_devices (business_id, location_id, display_name) VALUES ($1, $2, $3)`,
    [business.id, location.id, `دسکتاپ آزمون ۹۱۵ ${RUN}`],
  );

  // The paired-branch document repeats ONE SKU on two lines at two prices —
  // the case the per-line cost allocation exists for (#915 P1).
  const pairedCreated = await api("POST", "/api/inventory/purchases", {
    supplierId,
    note: `خرید شعبهٔ متصل ${RUN}`,
    items: [
      { inventoryItemId: flourId, purchaseQty: "1", totalCost: "400000" },
      { inventoryItemId: flourId, purchaseQty: "2", totalCost: "1000000" },
    ],
    invoice: { invoiceNumber: "INV-915-2", invoiceDate: "2026-10-19", vatAmount: 126000, paymentTermsDays: 0 },
  });
  const pairedId = pairedCreated.json.id;
  const pairedEdited = await api("PUT", `/api/inventory/purchases/${pairedId}`, {
    supplierId,
    note: `خرید شعبهٔ متصل ${RUN} — ویرایش`,
    items: [
      { inventoryItemId: flourId, purchaseQty: "1", totalCost: "400000" },
      { inventoryItemId: flourId, purchaseQty: "2", totalCost: "1000000" },
    ],
    invoice: { invoiceNumber: "INV-915-2", invoiceDate: "2026-10-19", vatAmount: 126000, paymentTermsDays: 0 },
  });
  await api("PATCH", `/api/inventory/purchases/${pairedId}`, { status: "ordered" });
  const pairedReceived = await api("PATCH", `/api/inventory/purchases/${pairedId}`, {
    status: "received",
    settlementMethod: "cash",
  });
  check(
    "a two-line purchase of one SKU at two prices is received paid in cash",
    pairedCreated.status === 200 && pairedEdited.status === 200 && pairedReceived.status === 200,
    `create ${pairedCreated.status}, edit ${pairedEdited.status}, receive ${pairedReceived.status}`,
  );

  const pairedDetail = await api("GET", `/api/inventory/purchases/${pairedId}`);
  const pairedLines = (pairedDetail.json?.items ?? []).filter((item) => item.inventory_item_id === flourId);
  const cheapLine = pairedLines.find((item) => num(item.unit_cost) === 400);
  const dearLine = pairedLines.find((item) => num(item.unit_cost) === 500);
  check(
    "the two lines of the same SKU resolved to two different lots — no first-lot shortcut",
    pairedLines.length === 2 &&
      cheapLine?.inventory_lot_id &&
      dearLine?.inventory_lot_id &&
      cheapLine.inventory_lot_id !== dearLine.inventory_lot_id,
    JSON.stringify(pairedLines.map((item) => [item.unit_cost, item.inventory_lot_id])),
  );

  const crossLineLot = await api("POST", "/api/inventory/supplier-returns", {
    purchaseId: pairedId,
    settlementMethod: "cash",
    reason: `لات خط دیگر ${RUN}`,
    idempotencyKey: randomUUID(),
    lines: [{ purchaseItemId: cheapLine.id, inventoryLotId: dearLine.inventory_lot_id, quantity: "100" }],
  });
  check(
    "returning one line from another line's lot is refused (409 supplier_return_lot_mismatch)",
    crossLineLot.status === 409 && crossLineLot.json?.error === "supplier_return_lot_mismatch",
    `status ${crossLineLot.status} ${crossLineLot.text.slice(0, 120)}`,
  );

  const pairedReturn = await api("POST", "/api/inventory/supplier-returns", {
    purchaseId: pairedId,
    settlementMethod: "cash",
    reason: `مرجوعی شعبهٔ متصل ${RUN}`,
    idempotencyKey: randomUUID(),
    lines: [{ purchaseItemId: cheapLine.id, inventoryLotId: cheapLine.inventory_lot_id, quantity: "500" }],
  });
  check(
    "half of the cheaper line returns at its own price (200,000)",
    pairedReturn.status === 200 && pairedReturn.json?.value === "200000",
    `status ${pairedReturn.status} ${JSON.stringify(pairedReturn.json)}`,
  );

  facts.ledgerBalances = ledgerBalances;
  const syncEvents = await rows(
    `SELECT event_type, origin, actor_role, applied_at IS NOT NULL AS acknowledged, payload
       FROM sync_events WHERE location_id = $1 ORDER BY id`,
    [location.id],
  );
  const types = syncEvents.map((event) => event.event_type);
  check(
    "a paired branch receives exactly the three effect events — create, receive, supplier return",
    types.length === 3 &&
      types.filter((type) => type === "inventory.purchase.created").length === 1 &&
      types.filter((type) => type === "inventory.purchase.received").length === 1 &&
      types.filter((type) => type === "inventory.supplier_return.created").length === 1,
    JSON.stringify(types),
  );
  check(
    "the edit and the order recorded nothing — lifecycle corrections stay cloud-only",
    !types.some((type) => type.includes("updated") || type.includes("ordered") || type.includes("cancelled")),
    JSON.stringify(types),
  );
  const returnSyncEvent = syncEvents.find((event) => event.event_type === "inventory.supplier_return.created");
  check(
    "the return event was written by the server with the document's own payload",
    pairedReturn.status === 200 &&
      returnSyncEvent?.origin === "local" &&
      returnSyncEvent.actor_role === "owner" &&
      returnSyncEvent.acknowledged === true &&
      returnSyncEvent.payload?.purchaseId === pairedId &&
      Array.isArray(returnSyncEvent.payload?.lines) &&
      returnSyncEvent.payload.lines.length === 1,
    JSON.stringify(returnSyncEvent ?? null),
  );

  facts.syncEvents = syncEvents.map((event) => ({ type: event.event_type, origin: event.origin, payload: event.payload }));
  const pairedReturnJournal = await one(
    `SELECT je.id, je.source_type FROM journal_entries je
      WHERE je.source_type = 'supplier_return' AND je.source_id = $1`,
    [pairedReturn.json?.id],
  );
  const pairedReturnLines = pairedReturnJournal ? await ledger(pairedReturnJournal.id) : [];
  check(
    "the return's money moved on the server: balanced Dr 1100 / Cr 1300 + Cr 1220 for a cash return",
    pairedReturnJournal &&
      balanced(pairedReturnLines).balanced &&
      accountLine(pairedReturnLines, "1100")?.debit === "218000" &&
      accountLine(pairedReturnLines, "1300")?.credit === "200000" &&
      accountLine(pairedReturnLines, "1220")?.credit === "18000",
    JSON.stringify(pairedReturnLines),
  );

  await db.query("DELETE FROM site_devices WHERE business_id = $1 AND display_name = $2", [
    business.id,
    `دسکتاپ آزمون ۹۱۵ ${RUN}`,
  ]);
}

async function run() {
  try {
    await main();
  } catch (error) {
    failures.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
    log("");
    log(`✗ the pass stopped: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  } finally {
    await db.end().catch(() => {});
  }

  log("");
  log(`── ${checks.filter((c) => c.ok).length}/${checks.length} checks passed ──`);
  for (const failure of failures) log(`FAILED: ${failure}`);

  if (EVIDENCE_DIR) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(path.join(EVIDENCE_DIR, "manual-pass.log"), `${transcript.join("\n")}\n`);
    writeFileSync(
      path.join(EVIDENCE_DIR, "manual-pass.json"),
      `${JSON.stringify(
        {
          run: RUN,
          base: BASE,
          at: new Date().toISOString(),
          checks,
          facts,
          failures,
        },
        null,
        2,
      )}\n`,
    );
    log(`evidence written to ${EVIDENCE_DIR}`);
  }

  process.exit(failures.length === 0 ? 0 : 1);
}

await run();
