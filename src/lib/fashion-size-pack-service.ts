/**
 * GH #1567 Phase 6C — virtual size packs: definitions, derived availability,
 * and the sale-time expansion into ordinary per-variant invoice lines.
 *
 * Contract (see migrations/0331_fashion_size_packs.sql):
 *  - A pack never has stock. `listSizePacks` derives availability from the
 *    components' `item_stock` rows.
 *  - `expandSizePackInvoiceLines` runs inside the invoice transaction and
 *    replaces each `size_pack` line by `stocked` lines (one per component, at
 *    the component's wholesale price, flagged `sizePackId` so automatic
 *    promotions skip them). The existing sale path then relieves stock under
 *    row locks, posts WAC COGS and revenue per variant, and refuses the whole
 *    invoice if any component is short — so a pack sells atomically and
 *    exactly once, and the stock is never counted twice.
 *  - `recordSizePackSales` writes the append-only snapshot pairing each
 *    component with its order line. A retry under the same request key is
 *    rebuilt from that snapshot (so a pack edited between the attempt and the
 *    retry still replays the original sale); a different pack request under
 *    the same key is a conflict.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { normalizeBarcode } from "./barcode";
import { withTenantTransaction } from "./db";
import {
  canonicalPackRequest,
  expandPack,
  packAvailability,
  packReturnStatus,
  packTotals,
  SizePackRuleError,
  validatePackDefinition,
  type PackDefinitionInput,
  type PackLineRequest,
  type PackShortage,
  type PackSnapshotComponent,
} from "./fashion-size-packs";
import { RetailRequestConflictError, type RetailInvoice, type RetailInvoiceLineInput } from "./retail-invoice-service";
import type { Industry } from "./industries";

export class SizePackError extends Error {
  constructor(public readonly code: string, public readonly status = 409, public readonly detail?: Record<string, unknown>) {
    super(code);
    this.name = "SizePackError";
  }
}

function fail(code: string, status = 409, detail?: Record<string, unknown>): never {
  throw new SizePackError(code, status, detail);
}

function rethrowRule(error: unknown): never {
  if (error instanceof SizePackRuleError) fail(error.code, 400, error.detail);
  throw error;
}

export interface SizePackActor {
  businessId: string;
  userId: string | null;
}

export interface SizePackComponentView {
  itemId: string;
  name: string;
  sku: string | null;
  attributes: string;
  quantity: number;
  unitPriceRial: number;
  onHand: string;
}

export interface SizePackView {
  id: string;
  name: string;
  barcode: string | null;
  isActive: boolean;
  version: number;
  priceRial: number;
  pieces: number;
  available: number;
  shortages: PackShortage[];
  components: SizePackComponentView[];
  /**
   * GH #1567 C3 — a barcode migration 0334 had to clear because an item at
   * this branch already scans with it. Shown until the pack is saved again.
   */
  clearedBarcode: string | null;
}

interface ComponentRow {
  pack_id: string;
  item_id: string;
  name: string;
  sku: string | null;
  attributes: string | null;
  quantity: number;
  unit_price_rial: string;
  on_hand: string;
}

const COMPONENT_SELECT = `
  SELECT c.pack_id, c.item_id, i.name, i.sku, c.quantity, c.unit_price_rial::text,
         COALESCE(s.quantity, 0)::text AS on_hand,
         (SELECT string_agg(a.value, ' / ' ORDER BY a.name) FROM item_variant_attributes a WHERE a.item_id = i.id) AS attributes
    FROM item_size_pack_components c
    JOIN items i ON i.id = c.item_id
    LEFT JOIN item_stock s ON s.item_id = c.item_id`;

type PackRow = { id: string; name: string; barcode: string | null; is_active: boolean; version: number; cleared_barcode: string | null };

const PACK_COLUMNS = `p.id, p.name, p.barcode, p.is_active, p.version,
  (SELECT c.code FROM scan_code_collisions c
    WHERE c.cleared_kind = 'size_pack' AND c.cleared_id = p.id AND c.resolved_at IS NULL
    ORDER BY c.detected_at DESC LIMIT 1) AS cleared_barcode`;

function packView(
  pack: PackRow,
  rows: ComponentRow[],
): SizePackView {
  const components = rows.map((r) => ({
    itemId: r.item_id, name: r.name, sku: r.sku, attributes: r.attributes ?? "",
    quantity: r.quantity, unitPriceRial: Number(r.unit_price_rial), onHand: r.on_hand,
  }));
  const totals = packTotals(components);
  const availability = packAvailability(components.map((c) => ({ itemId: c.itemId, name: c.name, quantity: c.quantity, onHand: c.onHand })));
  return {
    id: pack.id, name: pack.name, barcode: pack.barcode, isActive: pack.is_active, version: pack.version,
    priceRial: totals.priceRial, pieces: totals.pieces, available: availability.available, shortages: availability.shortages,
    components, clearedBarcode: pack.cleared_barcode,
  };
}

export async function listSizePacks(actor: SizePackActor, locationId: string, opts: { activeOnly?: boolean } = {}): Promise<SizePackView[]> {
  return withTenantTransaction(actor.businessId, async (client) => {
    const { rows: packs } = await client.query<PackRow>(
      `SELECT ${PACK_COLUMNS} FROM item_size_packs p
        WHERE p.business_id = $1 AND p.location_id = $2 ${opts.activeOnly ? "AND p.is_active" : ""}
        ORDER BY p.is_active DESC, p.name`,
      [actor.businessId, locationId],
    );
    if (packs.length === 0) return [];
    const { rows } = await client.query<ComponentRow>(
      `${COMPONENT_SELECT} WHERE c.pack_id = ANY($1::uuid[]) ORDER BY c.pack_id, c.position`,
      [packs.map((p) => p.id)],
    );
    return packs.map((p) => packView(p, rows.filter((r) => r.pack_id === p.id)));
  });
}

async function readPack(client: PoolClient, actor: SizePackActor, locationId: string, packId: string): Promise<SizePackView> {
  const { rows } = await client.query<PackRow>(
    `SELECT ${PACK_COLUMNS} FROM item_size_packs p WHERE p.id = $1 AND p.business_id = $2 AND p.location_id = $3`,
    [packId, actor.businessId, locationId],
  );
  if (!rows[0]) fail("pack_not_found", 404);
  const { rows: components } = await client.query<ComponentRow>(`${COMPONENT_SELECT} WHERE c.pack_id = $1 ORDER BY c.position`, [packId]);
  return packView(rows[0], components);
}

export async function getSizePack(actor: SizePackActor, locationId: string, packId: string): Promise<SizePackView> {
  return withTenantTransaction(actor.businessId, (client) => readPack(client, actor, locationId, packId));
}

export async function saveSizePack(
  actor: SizePackActor,
  locationId: string,
  input: PackDefinitionInput,
  packId?: string,
): Promise<SizePackView> {
  try {
    validatePackDefinition(input);
  } catch (error) {
    rethrowRule(error);
  }
  packTotals(input.components);
  const barcode = input.barcode ? normalizeBarcode(input.barcode) : null;
  if (barcode !== null && !/^[0-9A-Za-z\-_.]{4,64}$/.test(barcode)) fail("pack_invalid_barcode", 400);

  return withTenantTransaction(actor.businessId, async (client) => {
    const ids = input.components.map((c) => c.itemId);
    const { rows: items } = await client.query<{ id: string; kind: string; tracking: string; is_active: boolean }>(
      `SELECT i.id, i.kind, i.tracking, i.is_active FROM items i
         JOIN locations l ON l.id = i.location_id
        WHERE i.id = ANY($1::uuid[]) AND i.location_id = $2 AND l.business_id = $3`,
      [ids, locationId, actor.businessId],
    );
    for (const id of ids) {
      const item = items.find((i) => i.id === id);
      if (!item) fail("item_not_found", 404, { itemId: id });
      if (item.kind === "variant_parent") fail("item_is_variant_parent", 400, { itemId: id });
      if (item.tracking !== "none") fail("item_tracking_not_supported", 400, { itemId: id });
      if (!item.is_active) fail("item_inactive", 400, { itemId: id });
    }
    if (barcode) {
      const { rows: clash } = await client.query(
        `SELECT 1 FROM item_barcodes WHERE location_id = $1 AND code = $2
          UNION ALL
         SELECT 1 FROM item_size_packs WHERE location_id = $1 AND barcode = $2 AND id IS DISTINCT FROM $3::uuid`,
        [locationId, barcode, packId ?? null],
      );
      if (clash.length > 0) fail("pack_barcode_taken", 409);
    }

    let id = packId;
    try {
      if (id) {
        const { rowCount } = await client.query(
          `UPDATE item_size_packs SET name = $4, barcode = $5, version = version + 1, updated_at = now(), is_active = true
            WHERE id = $1 AND business_id = $2 AND location_id = $3`,
          [id, actor.businessId, locationId, input.name.trim(), barcode],
        );
        if (rowCount !== 1) fail("pack_not_found", 404);
        await client.query(`DELETE FROM item_size_pack_components WHERE pack_id = $1`, [id]);
      } else {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO item_size_packs (business_id, location_id, name, barcode, created_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [actor.businessId, locationId, input.name.trim(), barcode, actor.userId],
        );
        id = rows[0].id;
      }
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        const constraint = (error as { constraint?: string }).constraint ?? "";
        fail(constraint.includes("barcode") || constraint === "location_scan_codes_pkey" ? "pack_barcode_taken" : "pack_name_taken", 409);
      }
      throw error;
    }
    // GH #1567 C3: saving the pack is the owner's answer to a cleared barcode.
    await client.query(
      `UPDATE scan_code_collisions SET resolved_at = now()
        WHERE business_id = $1 AND cleared_kind = 'size_pack' AND cleared_id = $2 AND resolved_at IS NULL`,
      [actor.businessId, id],
    );
    for (const [position, c] of input.components.entries()) {
      await client.query(
        `INSERT INTO item_size_pack_components (pack_id, business_id, item_id, position, quantity, unit_price_rial)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, actor.businessId, c.itemId, position, c.quantity, c.unitPriceRial],
      );
    }
    return readPack(client, actor, locationId, id!);
  });
}

export async function deactivateSizePack(actor: SizePackActor, locationId: string, packId: string): Promise<SizePackView> {
  return withTenantTransaction(actor.businessId, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE item_size_packs SET is_active = false, updated_at = now() WHERE id = $1 AND business_id = $2 AND location_id = $3`,
      [packId, actor.businessId, locationId],
    );
    if (rowCount !== 1) fail("pack_not_found", 404);
    return readPack(client, actor, locationId, packId);
  });
}

export async function lookupSizePackByBarcode(actor: SizePackActor, locationId: string, rawCode: string): Promise<SizePackView | null> {
  const code = normalizeBarcode(rawCode);
  return withTenantTransaction(actor.businessId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM item_size_packs WHERE business_id = $1 AND location_id = $2 AND barcode = $3 AND is_active`,
      [actor.businessId, locationId, code],
    );
    return rows[0] ? readPack(client, actor, locationId, rows[0].id) : null;
  });
}

export interface StyleMatrixCell {
  itemId: string;
  name: string;
  sku: string | null;
  attributes: Record<string, string>;
  onHand: string;
  unitPriceRial: number | null;
}

/** The branch's styles (variant parents) with at least one plain-tracked variant. */
export async function listStyles(actor: SizePackActor, locationId: string): Promise<{ id: string; name: string; sku: string | null; variants: number }[]> {
  return withTenantTransaction(actor.businessId, async (client) => {
    const { rows } = await client.query<{ id: string; name: string; sku: string | null; variants: number }>(
      `SELECT p.id, p.name, p.sku, count(c.id)::int AS variants
         FROM items p JOIN locations l ON l.id = p.location_id
         JOIN items c ON c.parent_item_id = p.id AND c.is_active AND c.tracking = 'none'
        WHERE p.location_id = $1 AND l.business_id = $2 AND p.kind = 'variant_parent' AND p.is_active
        GROUP BY p.id ORDER BY p.name LIMIT 500`,
      [locationId, actor.businessId],
    );
    return rows;
  });
}

/** A style's sellable variants with their axis values — the builder's matrix. */
export async function styleMatrix(actor: SizePackActor, locationId: string, parentItemId: string): Promise<{ style: { id: string; name: string }; axes: string[]; cells: StyleMatrixCell[] }> {
  return withTenantTransaction(actor.businessId, async (client) => {
    const { rows: parent } = await client.query<{ id: string; name: string }>(
      `SELECT i.id, i.name FROM items i JOIN locations l ON l.id = i.location_id
        WHERE i.id = $1 AND i.location_id = $2 AND l.business_id = $3 AND i.kind = 'variant_parent'`,
      [parentItemId, locationId, actor.businessId],
    );
    if (!parent[0]) fail("style_not_found", 404);
    const { rows } = await client.query<{ id: string; name: string; sku: string | null; on_hand: string; unit_price: string | null; attrs: Record<string, string> | null }>(
      `SELECT i.id, i.name, i.sku, COALESCE(s.quantity, 0)::text AS on_hand, s.unit_price::text AS unit_price,
              (SELECT jsonb_object_agg(a.name, a.value) FROM item_variant_attributes a WHERE a.item_id = i.id) AS attrs
         FROM items i LEFT JOIN item_stock s ON s.item_id = i.id
        WHERE i.parent_item_id = $1 AND i.is_active AND i.tracking = 'none'
        ORDER BY i.name`,
      [parentItemId],
    );
    const axes = [...new Set(rows.flatMap((r) => Object.keys(r.attrs ?? {})))].sort();
    return {
      style: parent[0],
      axes,
      cells: rows.map((r) => ({
        itemId: r.id, name: r.name, sku: r.sku, attributes: r.attrs ?? {}, onHand: r.on_hand,
        unitPriceRial: r.unit_price == null ? null : Math.round(Number(r.unit_price)),
      })),
    };
  });
}

// ── sale-time expansion ───────────────────────────────────────────────────

export interface SizePackInvoiceLine {
  kind: "size_pack";
  packId: string;
  quantity: number;
  vatPercent: number;
}

interface PlannedPack {
  lineIndex: number;
  start: number;
  packId: string;
  packVersion: number;
  packName: string;
  packQuantity: number;
  components: PackSnapshotComponent[];
}

export interface SizePackPlan {
  lines: RetailInvoiceLineInput[];
  packs: PlannedPack[];
  replay: boolean;
  requestHash: string | null;
  businessId: string;
  locationId: string;
  createdBy: string | null;
}

function isPackLine(line: unknown): line is SizePackInvoiceLine {
  return Boolean(line) && typeof line === "object" && (line as { kind?: unknown }).kind === "size_pack";
}

function parsePackLine(line: Record<string, unknown>): PackLineRequest {
  const packId = typeof line.packId === "string" ? line.packId : "";
  const quantity = Number(line.quantity);
  const vatPercent = Number(line.vatPercent ?? 0);
  if (!/^[0-9a-f-]{36}$/i.test(packId)) fail("pack_not_found", 404);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) fail("pack_invalid_quantity", 400);
  if (!Number.isFinite(vatPercent) || vatPercent < 0 || vatPercent > 100) fail("pack_invalid_vat", 400);
  return { packId, quantity, vatPercent };
}

/**
 * Replaces each `size_pack` line by its per-variant `stocked` lines. Call it
 * inside the invoice transaction, before `createRetailInvoice`, then pass the
 * plan to `recordSizePackSales` with the created invoice.
 */
export async function expandSizePackInvoiceLines(
  client: PoolClient,
  ctx: { businessId: string; locationId: string; industry: Industry; clientRequestId: string | null; createdBy: string | null },
  lines: ReadonlyArray<RetailInvoiceLineInput | SizePackInvoiceLine>,
): Promise<SizePackPlan> {
  const base = { businessId: ctx.businessId, locationId: ctx.locationId, createdBy: ctx.createdBy };
  if (!lines.some(isPackLine)) {
    return { ...base, lines: lines as RetailInvoiceLineInput[], packs: [], replay: false, requestHash: null };
  }
  if (ctx.industry !== "fashion_apparel") fail("pack_industry_mismatch", 400);
  const requests = lines.flatMap((l, index) => (isPackLine(l) ? [{ index, ...parsePackLine(l as unknown as Record<string, unknown>) }] : []));
  const requestHash = createHash("sha256").update(canonicalPackRequest(requests)).digest("hex");

  // A retry of a committed sale: rebuild the exact lines from the snapshot so
  // the invoice's own fingerprint matches and it replays instead of re-selling.
  if (ctx.clientRequestId) {
    const { rows: prior } = await client.query<{ id: string }>(
      `SELECT id FROM orders WHERE location_id = $1 AND client_request_id = $2 AND type = 'retail'`,
      [ctx.locationId, ctx.clientRequestId],
    );
    if (prior[0]) {
      const { rows: sales } = await client.query<{ line_index: number; pack_id: string; pack_version: number; pack_name: string; pack_quantity: number; components: PackSnapshotComponent[]; request_hash: string }>(
        `SELECT line_index, pack_id, pack_version, pack_name, pack_quantity, components, request_hash
           FROM item_size_pack_sales WHERE order_id = $1 ORDER BY line_index`,
        [prior[0].id],
      );
      if (sales.length === 0 || sales.some((s) => s.request_hash !== requestHash)) throw new RetailRequestConflictError();
      const byIndex = new Map(sales.map((s) => [s.line_index, s]));
      const out: RetailInvoiceLineInput[] = [];
      for (const [index, line] of lines.entries()) {
        const sale = byIndex.get(index);
        if (!isPackLine(line)) { out.push(line); continue; }
        if (!sale) throw new RetailRequestConflictError();
        const request = requests.find((r) => r.index === index)!;
        out.push(...(expandPack(sale.pack_id, sale.components, sale.pack_quantity, request.vatPercent) as RetailInvoiceLineInput[]));
      }
      return { ...base, lines: out, packs: [], replay: true, requestHash };
    }
  }

  const out: RetailInvoiceLineInput[] = [];
  const packs: PlannedPack[] = [];
  for (const [index, line] of lines.entries()) {
    if (!isPackLine(line)) { out.push(line); continue; }
    const request = requests.find((r) => r.index === index)!;
    // FOR SHARE: an edit of this pack waits for the sale (and vice versa), so
    // the snapshot is exactly the definition the lines were built from.
    const { rows: packRows } = await client.query<{ id: string; name: string; version: number; is_active: boolean }>(
      `SELECT id, name, version, is_active FROM item_size_packs
        WHERE id = $1 AND business_id = $2 AND location_id = $3 FOR SHARE`,
      [request.packId, ctx.businessId, ctx.locationId],
    );
    const pack = packRows[0];
    if (!pack) fail("pack_not_found", 404);
    if (!pack.is_active) fail("pack_inactive", 409);
    const { rows: comps } = await client.query<ComponentRow>(`${COMPONENT_SELECT} WHERE c.pack_id = $1 ORDER BY c.position`, [pack.id]);
    if (comps.length === 0) fail("pack_has_no_components", 409);
    // The friendly per-variant answer; the sale path's row-locked relief is
    // the binding check and rolls the whole invoice back on any shortage.
    const { shortages } = packAvailability(
      comps.map((c) => ({ itemId: c.item_id, name: c.attributes ? `${c.name} (${c.attributes})` : c.name, quantity: c.quantity, onHand: c.on_hand })),
      request.quantity,
    );
    if (shortages.length > 0) fail("pack_shortage", 409, { packId: pack.id, packName: pack.name, shortages });
    const components: PackSnapshotComponent[] = comps.map((c) => ({
      itemId: c.item_id, name: c.name, quantityPerPack: c.quantity, unitPriceRial: Number(c.unit_price_rial),
    }));
    packs.push({ lineIndex: index, start: out.length, packId: pack.id, packVersion: pack.version, packName: pack.name, packQuantity: request.quantity, components });
    out.push(...(expandPack(pack.id, components, request.quantity, request.vatPercent) as RetailInvoiceLineInput[]));
  }
  return { ...base, lines: out, packs, replay: false, requestHash };
}

/** Writes the sale snapshots for a plan once its invoice exists (same transaction). */
export async function recordSizePackSales(client: PoolClient, plan: SizePackPlan, invoice: RetailInvoice): Promise<void> {
  if (plan.replay || plan.packs.length === 0) return;
  const { rows: existing } = await client.query(`SELECT 1 FROM item_size_pack_sales WHERE order_id = $1 LIMIT 1`, [invoice.orderId]);
  if (existing.length > 0) return; // the invoice service replayed a committed sale
  for (const pack of plan.packs) {
    const components = pack.components.map((c, offset) => {
      const line = invoice.lines[pack.start + offset];
      // The invoice keeps submitted line order; anything else is a bug that
      // must not be papered over with a mismatched snapshot.
      if (!line || line.itemId !== c.itemId) throw new Error("size_pack_line_mismatch");
      return { ...c, quantity: String(c.quantityPerPack * pack.packQuantity), orderItemId: line.orderItemId };
    });
    const total = packTotals(pack.components.map((c) => ({ quantity: c.quantityPerPack, unitPriceRial: c.unitPriceRial }))).priceRial * pack.packQuantity;
    await client.query(
      `INSERT INTO item_size_pack_sales
         (business_id, location_id, order_id, line_index, pack_id, pack_version, pack_name, pack_quantity, total_rial, components, request_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)`,
      [plan.businessId, plan.locationId, invoice.orderId, pack.lineIndex, pack.packId, pack.packVersion, pack.packName,
        pack.packQuantity, total, JSON.stringify(components), plan.requestHash, plan.createdBy],
    );
  }
}

export interface SizePackSaleView {
  id: string;
  orderId: string;
  orderNumber: string | null;
  orderStatus: string;
  packId: string;
  packName: string;
  packVersion: number;
  packQuantity: number;
  totalRial: number;
  at: string;
  status: "sold" | "partially_returned" | "returned" | "voided";
  components: { itemId: string; name: string; quantity: string; unitPriceRial: number; orderItemId: string; returnedQuantity: string }[];
}

/** Sold packs with each component's returned quantity — the pack sales report. */
export async function listSizePackSales(actor: SizePackActor, locationId: string, opts: { orderId?: string; limit?: number } = {}): Promise<SizePackSaleView[]> {
  const { rows } = await withTenantTransaction(actor.businessId, (client) => client.query<{
    id: string; order_id: string; order_number: string | null; order_status: string; pack_id: string; pack_name: string;
    pack_version: number; pack_quantity: number; total_rial: string; created_at: string;
    components: { itemId: string; name: string; quantity: string; unitPriceRial: number; orderItemId: string }[];
    returned: Record<string, string> | null;
  }>(
    `SELECT ps.id, ps.order_id, o.order_number::text AS order_number, o.status::text AS order_status, ps.pack_id, ps.pack_name,
            ps.pack_version, ps.pack_quantity, ps.total_rial::text, ps.created_at::text, ps.components,
            (SELECT jsonb_object_agg(x.order_item_id, x.qty) FROM (
               SELECT rl.order_item_id::text AS order_item_id, sum(rl.quantity)::text AS qty
                 FROM customer_return_lines rl
                WHERE rl.order_item_id IN (SELECT (c->>'orderItemId')::uuid FROM jsonb_array_elements(ps.components) c)
                GROUP BY rl.order_item_id) x) AS returned
       FROM item_size_pack_sales ps JOIN orders o ON o.id = ps.order_id
      WHERE ps.business_id = $1 AND ps.location_id = $2 ${opts.orderId ? "AND ps.order_id = $4" : ""}
      ORDER BY ps.created_at DESC, ps.line_index
      LIMIT $3`,
    opts.orderId ? [actor.businessId, locationId, opts.limit ?? 200, opts.orderId] : [actor.businessId, locationId, opts.limit ?? 200],
  ));
  return rows.map((r) => {
    const components = r.components.map((c) => ({ ...c, returnedQuantity: r.returned?.[c.orderItemId] ?? "0" }));
    const voided = r.order_status === "voided";
    return {
      id: r.id, orderId: r.order_id, orderNumber: r.order_number, orderStatus: r.order_status, packId: r.pack_id,
      packName: r.pack_name, packVersion: r.pack_version, packQuantity: r.pack_quantity, totalRial: Number(r.total_rial),
      at: r.created_at, status: voided ? "voided" : packReturnStatus(components), components,
    };
  });
}
