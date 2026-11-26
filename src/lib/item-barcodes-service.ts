/**
 * Phase 27 Wave 4 — barcode assignment and lookup (DB-touching).
 *
 * One code = one item per branch. Uniqueness is *also* enforced here, in the
 * service layer, with a Persian, operator-readable refusal — the DB
 * UNIQUE (location_id, code) constraint is the backstop, not the UX. Internal
 * codes are minted from a retried candidate payload so the generator stays
 * pure (src/lib/barcode.ts) and only this service ever consults the database.
 */
import { randomInt } from "node:crypto";

import { query, type PoolClient } from "./db";
import {
  barcodeEntryError,
  classifyBarcode,
  internalBarcodeForPayload,
  internalPayloadFromNumber,
  normalizeBarcode,
  type BarcodeSymbology,
} from "./barcode";
import { getItem } from "./items-service";

export interface ItemBarcode {
  id: string;
  locationId: string;
  itemId: string;
  code: string;
  symbology: BarcodeSymbology;
  note: string | null;
}

export class BarcodeConflictError extends Error {
  constructor() {
    super("این بارکد قبلاً در همین شعبه برای کالای دیگری ثبت شده است.");
    this.name = "BarcodeConflictError";
  }
}

interface BarcodeRow extends Record<string, unknown> {
  id: string;
  location_id: string;
  item_id: string;
  code: string;
  symbology: BarcodeSymbology;
  note: string | null;
}

function mapBarcode(row: BarcodeRow): ItemBarcode {
  return {
    id: row.id,
    locationId: row.location_id,
    itemId: row.item_id,
    code: row.code,
    symbology: row.symbology,
    note: row.note,
  };
}

/** A supplier (EAN-13/UPC) or already-known code, or a minted internal one. */
export async function assignBarcode(
  itemId: string,
  input: { code?: string | null; symbology?: BarcodeSymbology | null; note?: string | null },
  client?: PoolClient,
): Promise<ItemBarcode> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);
  const item = await getItem(itemId, client);
  if (!item) throw new Error("کالا یافت نشد.");

  const code = normalizeBarcode(input.code?.trim() ?? "");

  // A code shaped exactly like EAN-13/UPC-A with a broken check digit is a
  // typo with certainty — stored it would never scan, because a real scanner
  // validates the check digit before it emits the code. Refuse it here rather
  // than letting it live in the table as a phantom "internal" code.
  if (code) {
    const entryError = barcodeEntryError(code);
    if (entryError) throw new Error(entryError);
  }

  const symbology = input.symbology ?? (code ? classifyBarcode(code) : null);

  // A supplier code must actually be the symbology the caller claims, or be
  // rejected — a mistyped check digit would otherwise live in the table and
  // never scan.
  if (code && symbology) {
    if (classifyBarcode(code) !== symbology) {
      throw new Error("بارکد با نوع انتخابی هم‌خوانی ندارد.");
    }
  }

  // Service-layer duplicate refusal (the acceptance criterion asks for it
  // specifically): a code already in use anywhere at this branch is refused
  // before the UNIQUE constraint could fire, with a message a shop clerk can
  // act on rather than a constraint name.
  if (code) {
    const { rows: existing } = await run<{ id: string }>(
      `SELECT id FROM item_barcodes WHERE location_id = $1 AND code = $2`,
      [item.locationId, code],
    );
    if (existing[0]) throw new BarcodeConflictError();
    // GH #1567 6C — a size pack's barcode is a scannable code at this branch
    // too; an item may not take it, or a scan would be ambiguous.
    const { rows: packCode } = await run<{ id: string }>(
      `SELECT id FROM item_size_packs WHERE location_id = $1 AND barcode = $2`,
      [item.locationId, code],
    );
    if (packCode[0]) throw new BarcodeConflictError();
  }

  const finalSymbology = symbology ?? "internal";
  const finalCode = code || (await mintUniqueInternalCode(item.locationId, client));

  let rows: BarcodeRow[];
  try {
    ({ rows } = await run<BarcodeRow>(
      `INSERT INTO item_barcodes (location_id, item_id, code, symbology, note)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [item.locationId, itemId, finalCode, finalSymbology, input.note?.trim() || null],
    ));
  } catch (error) {
    // The pre-check gives the normal readable refusal; this catches the race
    // where another request inserts the same branch/code before our INSERT.
    if ((error as { code?: string }).code === "23505") throw new BarcodeConflictError();
    throw error;
  }
  return mapBarcode(rows[0]);
}

/** Mint an internal code that is free at this branch, retrying the payload on the rare collision. */
async function mintUniqueInternalCode(locationId: string, client?: PoolClient): Promise<string> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);
  for (let attempt = 0; attempt < 20; attempt++) {
    const payload = internalPayloadFromNumber(randomInt(100_000_000_000));
    const code = internalBarcodeForPayload(payload);
    const { rows } = await run<{ id: string }>(
      `SELECT id FROM item_barcodes WHERE location_id = $1 AND code = $2`,
      [locationId, code],
    );
    if (!rows[0]) return code;
  }
  throw new Error("تولید بارکد داخلی ناموفق بود؛ دوباره تلاش کنید.");
}

export async function listBarcodes(itemId: string): Promise<ItemBarcode[]> {
  const { rows } = await query<BarcodeRow>(
    `SELECT * FROM item_barcodes WHERE item_id = $1 ORDER BY created_at`,
    [itemId],
  );
  return rows.map(mapBarcode);
}

export interface BarcodeLookupMatch {
  barcodeId: string;
  itemId: string;
  /** The sellable thing the code names — the item itself, or (watch) the serial it is stuck to. */
  serialId?: string | null;
  itemName: string;
  sku: string | null;
  kind: string;
  tracking: string;
  code: string;
  symbology: BarcodeSymbology;
}

interface LookupRow extends Record<string, unknown> {
  barcode_id: string;
  item_id: string;
  serial_id: string | null;
  item_name: string;
  sku: string | null;
  kind: string;
  tracking: string;
  code: string;
  symbology: BarcodeSymbology;
}

/**
 * Resolve a scanned code at this branch. A code normally names one item; a
 * watch's code may name one serial unit (item_serials). The POS screen
 * surfaces every match rather than guessing, so ambiguity is visible.
 */
export async function lookupBarcode(locationId: string, rawCode: string): Promise<BarcodeLookupMatch[]> {
  const code = normalizeBarcode(rawCode);
  const { rows } = await query<LookupRow>(
    `SELECT b.id AS barcode_id, b.item_id, b.code, b.symbology,
            i.name AS item_name, i.sku, i.kind, i.tracking,
            s.id AS serial_id
       FROM item_barcodes b
       JOIN items i ON i.id = b.item_id
       LEFT JOIN item_serials s ON s.item_id = b.item_id AND s.serial_number = b.code
      WHERE b.location_id = $1 AND b.code = $2`,
    [locationId, code],
  );
  return rows.map((r) => ({
    barcodeId: r.barcode_id,
    itemId: r.item_id,
    serialId: r.serial_id,
    itemName: r.item_name,
    sku: r.sku,
    kind: r.kind,
    tracking: r.tracking,
    code: r.code,
    symbology: r.symbology,
  }));
}
