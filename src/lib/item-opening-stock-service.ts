/**
 * GH #1567 F2 — reviewed opening stock for the items model (every retail
 * trade that sells fungible SKUs: fashion, accessories, cosmetics, wholesale,
 * haberdashery, tools, automotive parts, …).
 *
 *   draft ──(review: preview + fingerprint)──▶ posted
 *     └──────────────cancel──────────────────▶ cancelled
 *
 * Catalogue creation never moves stock. An opening quantity — typed into the
 * product form, read from a Holoo opening-inventory sheet or from an external
 * catalogue — becomes a draft line (branch, SKU, quantity, unit cost). Posting
 * is a separate, explicitly authorised act bound to the fingerprint of the
 * draft the poster reviewed, and it happens in one transaction:
 *
 *  - every line is re-validated under row locks (sellable, untracked, still at
 *    zero on hand, never opened before, real unit cost);
 *  - each line is received through the canonical receipt (`receiveStock`,
 *    exact value, F1 valuation);
 *  - one balanced entry posts Dr the trade's inventory account / Cr opening
 *    equity (3900) for the exact sum of the line values, dated at cutover;
 *  - `item_opening_stock_postings` (keyed by item) makes the opening of an item
 *    happen at most once, even across documents and concurrent posts.
 *
 * Anything else is refused with a stable code; nothing is half-posted. This is
 * not a second accounting engine: the journal goes through the ordinary
 * `postExactJournalEntry` path (fiscal locks, voucher numbering, reports), and
 * GL-only opening balances remain #867's opening-balance sets.
 */
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { receiveStock } from "./accessories-service";
import { WELL_KNOWN_CODES } from "./coa-template";
import { recordItemEvent } from "./item-audit-service";
import { roundRial, type RialText } from "./inventory-exact";
import { accountIdsByCode, postExactJournalEntry } from "./ledger-service";
import { inventoryCodeForBusiness } from "./retail-stock-posting-rules";
import { isValidIsoDate } from "./jalali";
import { isUuid } from "./uuid";

export type OpeningStockSource = "manual" | "product_form" | "import";
export type OpeningStockStatus = "draft" | "posted" | "cancelled";

export class OpeningStockError extends Error {
  status: number;
  details?: Record<string, unknown>;
  constructor(code: string, status = 400, details?: Record<string, unknown>) {
    super(code);
    this.status = status;
    if (details) this.details = details;
  }
}

export interface OpeningStockLineInput {
  itemId: string;
  quantity: string | number;
  /** Integer Rial per unit; 0 is allowed on a draft but refused at posting. */
  unitCost: string | number;
}

export const OPENING_STOCK_LINES_MAX = 2000;

export type OpeningStockLineIssue =
  | "item_not_found"
  | "wrong_branch"
  | "not_sellable"
  | "tracking_unsupported"
  | "item_has_stock"
  | "already_opened"
  | "unit_cost_required";

export interface OpeningStockLine {
  itemId: string;
  itemName: string | null;
  sku: string | null;
  quantity: string;
  unitCost: string;
  lineValue: string;
  issues: OpeningStockLineIssue[];
}

export interface OpeningStockDocument {
  id: string;
  locationId: string;
  status: OpeningStockStatus;
  cutoverDate: string;
  source: OpeningStockSource;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  postedBy: string | null;
  postedAt: string | null;
  journalEntryId: string | null;
  totalQuantity: string | null;
  totalValue: string | null;
}

export interface OpeningStockPreview {
  document: OpeningStockDocument;
  lines: OpeningStockLine[];
  totalQuantity: string;
  totalValue: string;
  inventoryAccountCode: string;
  equityAccountCode: string;
  /** Bind the post to exactly this review. */
  fingerprint: string;
  /** True when every line is postable and the document is a draft. */
  postable: boolean;
}

interface DocumentRow {
  id: string;
  business_id: string;
  location_id: string;
  status: OpeningStockStatus;
  cutover_date: string;
  source: OpeningStockSource;
  note: string | null;
  idempotency_key: string;
  created_by: string | null;
  created_at: string;
  posted_by: string | null;
  posted_at: string | null;
  journal_entry_id: string | null;
  total_quantity: string | null;
  total_value_rial: string | null;
}

const DOCUMENT_SELECT = `
  SELECT id::text, business_id::text, location_id::text, status, cutover_date::text, source, note,
         idempotency_key, created_by::text, created_at::text, posted_by::text, posted_at::text,
         journal_entry_id::text, total_quantity::text, total_value_rial::text
    FROM item_opening_stock_documents`;

function mapDocument(row: DocumentRow): OpeningStockDocument {
  return {
    id: row.id,
    locationId: row.location_id,
    status: row.status,
    cutoverDate: row.cutover_date,
    source: row.source,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
    postedBy: row.posted_by,
    postedAt: row.posted_at,
    journalEntryId: row.journal_entry_id,
    totalQuantity: row.total_quantity == null ? null : new Decimal(row.total_quantity).toFixed(),
    totalValue: row.total_value_rial,
  };
}

/** Quantity as a canonical decimal string (no exponent, no trailing zeros). */
function normaliseQuantity(raw: string | number): string {
  const text = String(raw).trim();
  if (!/^\d+(\.\d{1,9})?$/.test(text)) throw new OpeningStockError("invalid_quantity", 400, { quantity: text });
  const value = new Decimal(text);
  if (value.lte(0)) throw new OpeningStockError("invalid_quantity", 400, { quantity: text });
  return value.toFixed();
}

function normaliseUnitCost(raw: string | number): string {
  const text = String(raw).trim();
  if (!/^\d{1,15}$/.test(text)) throw new OpeningStockError("invalid_unit_cost", 400, { unitCost: text });
  return BigInt(text).toString();
}

export function normaliseOpeningStockLines(lines: OpeningStockLineInput[]): Array<{ itemId: string; quantity: string; unitCost: string }> {
  if (!Array.isArray(lines)) throw new OpeningStockError("invalid_lines");
  if (lines.length > OPENING_STOCK_LINES_MAX) throw new OpeningStockError("too_many_lines");
  const seen = new Set<string>();
  return lines.map((line) => {
    if (!line || !isUuid(String(line.itemId))) throw new OpeningStockError("invalid_item");
    if (seen.has(line.itemId)) throw new OpeningStockError("duplicate_item", 400, { itemId: line.itemId });
    seen.add(line.itemId);
    return { itemId: line.itemId, quantity: normaliseQuantity(line.quantity), unitCost: normaliseUnitCost(line.unitCost) };
  });
}

/** The exact value of one line: quantity × unit cost, rounded to the Rial. */
export function openingLineValue(quantity: string, unitCost: string): string {
  return roundRial(new Decimal(quantity).times(unitCost));
}

/**
 * What the reviewer saw: the branch, the cutover date and every line. Any edit
 * to a line, the date or the branch yields a different fingerprint, so a post
 * can only apply the exact draft that was reviewed.
 */
export function openingStockFingerprint(input: {
  documentId: string;
  locationId: string;
  cutoverDate: string;
  lines: Array<{ itemId: string; quantity: string; unitCost: string }>;
}): string {
  const lines = [...input.lines]
    .map((line) => [line.itemId, new Decimal(line.quantity).toFixed(), BigInt(line.unitCost).toString()])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return createHash("sha256")
    .update(JSON.stringify({ d: input.documentId, l: input.locationId, c: input.cutoverDate, lines }))
    .digest("hex");
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function validateCutoverDate(raw: string | null | undefined): string {
  const date = (raw ?? todayIso()).trim();
  if (!isValidIsoDate(date)) throw new OpeningStockError("invalid_cutover_date");
  if (date > todayIso()) throw new OpeningStockError("cutover_in_future");
  return date;
}

async function assertBranch(client: PoolClient, businessId: string, locationId: string): Promise<void> {
  if (!isUuid(locationId)) throw new OpeningStockError("location_not_found", 404);
  const { rows } = await client.query(`SELECT 1 FROM locations WHERE id = $1 AND business_id = $2`, [locationId, businessId]);
  if (!rows[0]) throw new OpeningStockError("location_not_found", 404);
}

async function loadDocument(
  client: PoolClient,
  businessId: string,
  documentId: string,
  lock = false,
): Promise<DocumentRow> {
  if (!isUuid(documentId)) throw new OpeningStockError("document_not_found", 404);
  const { rows } = await client.query<DocumentRow>(
    `${DOCUMENT_SELECT} WHERE id = $1 AND business_id = $2${lock ? " FOR UPDATE" : ""}`,
    [documentId, businessId],
  );
  if (!rows[0]) throw new OpeningStockError("document_not_found", 404);
  return rows[0];
}

async function upsertLines(
  client: PoolClient,
  businessId: string,
  documentId: string,
  lines: Array<{ itemId: string; quantity: string; unitCost: string }>,
): Promise<void> {
  for (const line of lines) {
    await client.query(
      `INSERT INTO item_opening_stock_lines (document_id, business_id, item_id, quantity, unit_cost)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (document_id, item_id) DO UPDATE
         SET quantity = EXCLUDED.quantity, unit_cost = EXCLUDED.unit_cost`,
      [documentId, businessId, line.itemId, line.quantity, line.unitCost],
    );
  }
  await client.query(`UPDATE item_opening_stock_documents SET updated_at = now() WHERE id = $1`, [documentId]);
}

/**
 * Create a draft (or return the one this idempotency key already created).
 * A replayed key with a different branch, date or line set is a conflict, not
 * a silent second draft.
 */
export async function createOpeningStockDraft(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    cutoverDate?: string | null;
    source?: OpeningStockSource;
    note?: string | null;
    idempotencyKey: string;
    lines: OpeningStockLineInput[];
    createdBy: string | null;
  },
): Promise<{ document: OpeningStockDocument; duplicate: boolean }> {
  const key = (input.idempotencyKey ?? "").trim();
  if (key.length < 8 || key.length > 200) throw new OpeningStockError("idempotency_key_required");
  const note = input.note == null ? null : String(input.note).trim().slice(0, 500) || null;
  const cutoverDate = validateCutoverDate(input.cutoverDate);
  const lines = normaliseOpeningStockLines(input.lines);
  await assertBranch(client, input.businessId, input.locationId);

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO item_opening_stock_documents
       (business_id, location_id, cutover_date, source, note, idempotency_key, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (business_id, idempotency_key) DO NOTHING
     RETURNING id::text`,
    [input.businessId, input.locationId, cutoverDate, input.source ?? "manual", note, key, input.createdBy],
  );
  if (!inserted.rows[0]) {
    const { rows } = await client.query<DocumentRow>(
      `${DOCUMENT_SELECT} WHERE business_id = $1 AND idempotency_key = $2`,
      [input.businessId, key],
    );
    const existing = rows[0];
    if (!existing) throw new OpeningStockError("idempotency_conflict", 409);
    const existingLines = await readLines(client, existing.id);
    const same =
      existing.location_id === input.locationId &&
      existing.cutover_date === cutoverDate &&
      openingStockFingerprint({ documentId: existing.id, locationId: existing.location_id, cutoverDate, lines: existingLines }) ===
        openingStockFingerprint({ documentId: existing.id, locationId: input.locationId, cutoverDate, lines });
    if (!same) throw new OpeningStockError("idempotency_conflict", 409);
    return { document: mapDocument(existing), duplicate: true };
  }
  const documentId = inserted.rows[0].id;
  await upsertLines(client, input.businessId, documentId, lines);
  return { document: mapDocument(await loadDocument(client, input.businessId, documentId)), duplicate: false };
}

/**
 * Add or replace draft lines (an import adds rows as it discovers them; the
 * reviewer fixes a quantity or enters a missing cost). `removeItemIds` drops
 * lines. Only a draft can change.
 */
export async function updateOpeningStockDraft(
  client: PoolClient,
  input: {
    businessId: string;
    documentId: string;
    lines?: OpeningStockLineInput[];
    removeItemIds?: string[];
    cutoverDate?: string | null;
    note?: string | null;
  },
): Promise<OpeningStockDocument> {
  const document = await loadDocument(client, input.businessId, input.documentId, true);
  if (document.status !== "draft") throw new OpeningStockError("document_not_draft", 409);
  const lines = normaliseOpeningStockLines(input.lines ?? []);
  if (input.cutoverDate !== undefined) {
    await client.query(`UPDATE item_opening_stock_documents SET cutover_date = $2 WHERE id = $1`, [
      document.id,
      validateCutoverDate(input.cutoverDate),
    ]);
  }
  if (input.note !== undefined) {
    const note = input.note == null ? null : String(input.note).trim().slice(0, 500) || null;
    await client.query(`UPDATE item_opening_stock_documents SET note = $2 WHERE id = $1`, [document.id, note]);
  }
  const removals = (input.removeItemIds ?? []).filter((id) => isUuid(String(id)));
  if (removals.length > 0) {
    await client.query(`DELETE FROM item_opening_stock_lines WHERE document_id = $1 AND item_id = ANY($2::uuid[])`, [
      document.id,
      removals,
    ]);
  }
  await upsertLines(client, input.businessId, document.id, lines);
  const total = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM item_opening_stock_lines WHERE document_id = $1`, [document.id]);
  if (total.rows[0].n > OPENING_STOCK_LINES_MAX) throw new OpeningStockError("too_many_lines");
  return mapDocument(await loadDocument(client, input.businessId, document.id));
}

/**
 * The draft an import run appends to: one draft per (branch, source key), so
 * a retried import reuses it and an approved row is never opened twice.
 */
export async function appendImportedOpeningStock(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    sourceKey: string;
    itemId: string;
    quantity: string;
    unitCost: string;
    createdBy: string | null;
    note?: string;
  },
): Promise<string | null> {
  if (!new Decimal(input.quantity || "0").gt(0)) return null;
  const key = `import:${input.locationId}:${input.sourceKey}`.slice(0, 200);
  const { rows } = await client.query<{ id: string; status: OpeningStockStatus }>(
    `SELECT id::text, status FROM item_opening_stock_documents WHERE business_id = $1 AND idempotency_key = $2 FOR UPDATE`,
    [input.businessId, key],
  );
  let documentId = rows[0]?.id ?? null;
  if (rows[0] && rows[0].status !== "draft") {
    // The draft this source fed was already posted or cancelled: a re-import
    // must not reopen stock. The reviewer corrects with a stock count.
    throw new OpeningStockError("opening_stock_already_reviewed", 409, { documentId });
  }
  if (!documentId) {
    const created = await createOpeningStockDraft(client, {
      businessId: input.businessId,
      locationId: input.locationId,
      source: "import",
      note: input.note ?? "موجودی افتتاحیهٔ واردشده — پیش از ثبت بازبینی شود",
      idempotencyKey: key,
      lines: [],
      createdBy: input.createdBy,
    });
    documentId = created.document.id;
  }
  await upsertLines(client, input.businessId, documentId, [
    { itemId: input.itemId, quantity: normaliseQuantity(input.quantity), unitCost: normaliseUnitCost(input.unitCost) },
  ]);
  return documentId;
}

async function readLines(client: PoolClient, documentId: string): Promise<Array<{ itemId: string; quantity: string; unitCost: string }>> {
  const { rows } = await client.query<{ item_id: string; quantity: string; unit_cost: string }>(
    `SELECT item_id::text, quantity::text, unit_cost::text FROM item_opening_stock_lines WHERE document_id = $1 ORDER BY item_id`,
    [documentId],
  );
  return rows.map((row) => ({ itemId: row.item_id, quantity: new Decimal(row.quantity).toFixed(), unitCost: row.unit_cost }));
}

interface LineFacts {
  item_id: string;
  name: string | null;
  sku: string | null;
  location_id: string | null;
  kind: string | null;
  tracking: string | null;
  on_hand: string | null;
  carrying: string | null;
  opened_by: string | null;
}

async function lineFacts(client: PoolClient, itemIds: string[], lock: boolean): Promise<Map<string, LineFacts>> {
  if (itemIds.length === 0) return new Map();
  if (lock) {
    // Deterministic order so two posts touching overlapping SKUs cannot
    // deadlock; the stock row lock serialises against sales and receipts.
    await client.query(`SELECT item_id FROM item_stock WHERE item_id = ANY($1::uuid[]) ORDER BY item_id FOR UPDATE`, [itemIds]);
  }
  const { rows } = await client.query<LineFacts>(
    `SELECT ids.item_id::text AS item_id, i.name, i.sku, i.location_id::text AS location_id, i.kind, i.tracking,
            s.quantity::text AS on_hand, s.total_value_rial::text AS carrying,
            p.document_id::text AS opened_by
       FROM unnest($1::uuid[]) AS ids(item_id)
       LEFT JOIN items i ON i.id = ids.item_id
       LEFT JOIN item_stock s ON s.item_id = ids.item_id
       LEFT JOIN item_opening_stock_postings p ON p.item_id = ids.item_id`,
    [itemIds],
  );
  return new Map(rows.map((row) => [row.item_id, row]));
}

function issuesFor(facts: LineFacts | undefined, locationId: string, unitCost: string): OpeningStockLineIssue[] {
  if (!facts || facts.location_id == null) return ["item_not_found"];
  const issues: OpeningStockLineIssue[] = [];
  if (facts.location_id !== locationId) issues.push("wrong_branch");
  if (facts.kind === "variant_parent") issues.push("not_sellable");
  // Serial (jewelry, watches), weight and batch (cosmetics lots) stock carry
  // per-unit or per-lot identity; they are opened through their own intake,
  // never as an anonymous fungible quantity.
  if (facts.tracking !== "none") issues.push("tracking_unsupported");
  if (facts.opened_by) issues.push("already_opened");
  else if (
    (facts.on_hand != null && !new Decimal(facts.on_hand).isZero()) ||
    (facts.carrying != null && BigInt(facts.carrying) !== 0n)
  ) {
    // Stock already on the shelf (a purchase, a count, a legacy import) is not
    // an opening balance any more: opening on top of it would double-count.
    issues.push("item_has_stock");
  }
  if (BigInt(unitCost) <= 0n) issues.push("unit_cost_required");
  return issues;
}

async function buildPreview(client: PoolClient, document: DocumentRow, lock: boolean): Promise<OpeningStockPreview> {
  const raw = await readLines(client, document.id);
  const facts = await lineFacts(client, raw.map((line) => line.itemId), lock);
  let totalQuantity = new Decimal(0);
  let totalValue = 0n;
  const lines: OpeningStockLine[] = raw.map((line) => {
    const fact = facts.get(line.itemId);
    const lineValue = openingLineValue(line.quantity, line.unitCost);
    totalQuantity = totalQuantity.plus(line.quantity);
    totalValue += BigInt(lineValue);
    return {
      itemId: line.itemId,
      itemName: fact?.name ?? null,
      sku: fact?.sku ?? null,
      quantity: line.quantity,
      unitCost: line.unitCost,
      lineValue,
      issues: document.status === "draft" ? issuesFor(fact, document.location_id, line.unitCost) : [],
    };
  });
  return {
    document: mapDocument(document),
    lines,
    totalQuantity: totalQuantity.toFixed(),
    totalValue: totalValue.toString(),
    inventoryAccountCode: await inventoryCodeForBusiness(client, document.business_id),
    equityAccountCode: WELL_KNOWN_CODES.openingEquity,
    fingerprint: openingStockFingerprint({
      documentId: document.id,
      locationId: document.location_id,
      cutoverDate: document.cutover_date,
      lines: raw,
    }),
    postable: document.status === "draft" && lines.length > 0 && lines.every((line) => line.issues.length === 0),
  };
}

/** The review screen: every line with its problems, totals, accounts and the fingerprint to post. */
export async function previewOpeningStock(
  client: PoolClient,
  input: { businessId: string; documentId: string },
): Promise<OpeningStockPreview> {
  return buildPreview(client, await loadDocument(client, input.businessId, input.documentId), false);
}

export async function listOpeningStockDocuments(
  client: PoolClient,
  input: { businessId: string; locationId?: string | null; limit?: number },
): Promise<Array<OpeningStockDocument & { lineCount: number }>> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const { rows } = await client.query<DocumentRow & { line_count: number }>(
    `SELECT d.id::text, d.business_id::text, d.location_id::text, d.status, d.cutover_date::text, d.source, d.note,
            d.idempotency_key, d.created_by::text, d.created_at::text, d.posted_by::text, d.posted_at::text,
            d.journal_entry_id::text, d.total_quantity::text, d.total_value_rial::text,
            (SELECT count(*)::int FROM item_opening_stock_lines l WHERE l.document_id = d.id) AS line_count
       FROM item_opening_stock_documents d
      WHERE d.business_id = $1 AND ($2::uuid IS NULL OR d.location_id = $2::uuid)
      ORDER BY d.created_at DESC
      LIMIT $3`,
    [input.businessId, input.locationId ?? null, limit],
  );
  return rows.map((row) => ({ ...mapDocument(row), lineCount: row.line_count }));
}

export interface OpeningStockPostResult {
  documentId: string;
  journalEntryId: string | null;
  totalQuantity: string;
  totalValue: string;
  lineCount: number;
  duplicate: boolean;
}

/**
 * Post a reviewed draft: stock and ledger in this transaction, exactly once.
 * The caller owns the transaction (and the tenant scope); any refusal throws
 * before a single row moved, and a failure after the first receipt rolls the
 * whole document back with the transaction.
 */
export async function postOpeningStock(
  client: PoolClient,
  input: { businessId: string; documentId: string; reviewedFingerprint: string; postedBy: string },
): Promise<OpeningStockPostResult> {
  if (!/^[0-9a-f]{64}$/.test(input.reviewedFingerprint ?? "")) throw new OpeningStockError("fingerprint_required");
  const document = await loadDocument(client, input.businessId, input.documentId, true);
  if (document.status === "posted") {
    // Replay of the same reviewed post (a retried request): report the
    // original result. A different fingerprint is not this post.
    const posted = await client.query<{ posted_fingerprint: string }>(
      `SELECT posted_fingerprint FROM item_opening_stock_documents WHERE id = $1`,
      [document.id],
    );
    if (posted.rows[0]?.posted_fingerprint !== input.reviewedFingerprint) {
      throw new OpeningStockError("document_not_draft", 409);
    }
    const count = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM item_opening_stock_lines WHERE document_id = $1`, [document.id]);
    return {
      documentId: document.id,
      journalEntryId: document.journal_entry_id,
      totalQuantity: new Decimal(document.total_quantity ?? "0").toFixed(),
      totalValue: document.total_value_rial ?? "0",
      lineCount: count.rows[0].n,
      duplicate: true,
    };
  }
  if (document.status !== "draft") throw new OpeningStockError("document_not_draft", 409);
  if (document.cutover_date > todayIso()) throw new OpeningStockError("cutover_in_future");

  const preview = await buildPreview(client, document, true);
  if (preview.fingerprint !== input.reviewedFingerprint) {
    throw new OpeningStockError("review_stale", 409, { fingerprint: preview.fingerprint });
  }
  if (preview.lines.length === 0) throw new OpeningStockError("no_lines");
  const blocked = preview.lines.filter((line) => line.issues.length > 0);
  if (blocked.length > 0) {
    throw new OpeningStockError("lines_not_postable", 409, {
      lines: blocked.map((line) => ({ itemId: line.itemId, issues: line.issues })),
    });
  }

  for (const line of preview.lines) {
    // The registry insert is the exactly-once guard across documents: a
    // concurrent post of the same item fails here on the primary key.
    try {
      await client.query("SAVEPOINT opening_stock_registry");
      await client.query(
        `INSERT INTO item_opening_stock_postings (item_id, business_id, document_id, quantity, value_rial)
         VALUES ($1, $2, $3, $4, $5)`,
        [line.itemId, input.businessId, document.id, line.quantity, line.lineValue],
      );
      await client.query("RELEASE SAVEPOINT opening_stock_registry");
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT opening_stock_registry");
      if ((error as { code?: string }).code === "23505") {
        throw new OpeningStockError("lines_not_postable", 409, { lines: [{ itemId: line.itemId, issues: ["already_opened"] }] });
      }
      throw error;
    }
    await receiveStock(line.itemId, { quantity: line.quantity, unitCost: line.unitCost, totalValue: line.lineValue }, client);
  }

  let journalEntryId: string | null = null;
  const total = BigInt(preview.totalValue);
  if (total > 0n) {
    const accounts = await accountIdsByCode(client, input.businessId, [preview.inventoryAccountCode, preview.equityAccountCode]);
    journalEntryId = await postExactJournalEntry(client, {
      businessId: input.businessId,
      locationId: document.location_id,
      entryDate: document.cutover_date,
      memo: "موجودی افتتاحیهٔ کالا",
      sourceType: "item_opening_stock",
      sourceId: document.id,
      createdBy: input.postedBy,
      postingKind: "retail_opening_stock",
      idempotencyKey: `item_opening_stock:${document.id}`,
      lines: [
        { accountId: accounts.get(preview.inventoryAccountCode)!, debit: preview.totalValue as RialText, credit: "0" as RialText },
        { accountId: accounts.get(preview.equityAccountCode)!, debit: "0" as RialText, credit: preview.totalValue as RialText },
      ],
    });
  }

  await client.query(
    `UPDATE item_opening_stock_documents
        SET status = 'posted', posted_fingerprint = $2, posted_by = $3, posted_at = now(),
            journal_entry_id = $4, total_quantity = $5, total_value_rial = $6, updated_at = now()
      WHERE id = $1`,
    [document.id, preview.fingerprint, input.postedBy, journalEntryId, preview.totalQuantity, preview.totalValue],
  );
  for (const line of preview.lines) {
    await recordItemEvent(
      {
        businessId: input.businessId,
        locationId: document.location_id,
        itemId: line.itemId,
        eventType: "item.opening_stock_posted",
        payload: {
          documentId: document.id,
          quantity: line.quantity,
          unitCost: line.unitCost,
          value: line.lineValue,
          cutoverDate: document.cutover_date,
        },
        createdBy: input.postedBy,
      },
      client,
    );
  }

  return {
    documentId: document.id,
    journalEntryId,
    totalQuantity: preview.totalQuantity,
    totalValue: preview.totalValue,
    lineCount: preview.lines.length,
    duplicate: false,
  };
}

/** Discard a draft. Nothing was ever posted from it, so nothing is reversed. */
export async function cancelOpeningStockDraft(
  client: PoolClient,
  input: { businessId: string; documentId: string; cancelledBy: string },
): Promise<OpeningStockDocument> {
  const document = await loadDocument(client, input.businessId, input.documentId, true);
  if (document.status === "cancelled") return mapDocument(document);
  if (document.status !== "draft") throw new OpeningStockError("document_not_draft", 409);
  await client.query(
    `UPDATE item_opening_stock_documents SET status = 'cancelled', cancelled_by = $2, cancelled_at = now(), updated_at = now()
      WHERE id = $1`,
    [document.id, input.cancelledBy],
  );
  return mapDocument(await loadDocument(client, input.businessId, document.id));
}
