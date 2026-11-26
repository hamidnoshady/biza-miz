/**
 * GH #1567 Phase 6D — fashion consignment (امانی) by contract: the service.
 *
 * The accounting contract is in `fashion-consignment.ts`. This module keeps
 * it: receipts and returns-to-owner move quantity only; a sale posts the
 * owner's share to 2110 and the shop's commission to 4700 with no COGS; a
 * customer return restocks and reclassifies; a settlement pays 2110 down.
 * Every mutation is branch-scoped, idempotent (a key per request) and leaves
 * an append-only movement row.
 *
 * The till does not call this module directly for sales: a fashion `stocked`
 * line for a variant that holds consigned units is routed here by
 * `retail-invoice-service.ts`, so a consigned sale is an ordinary invoice line
 * (same receipt, tenders, void and return flows) with a different posting.
 */
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenantTransaction } from "./db";
import {
  ConsignmentRuleError,
  assertAllowed,
  consignmentShares,
  contractStatus,
  onHand,
  outstandingPayable,
  parseConsignmentQuantity,
  returnShares,
  validateContract,
  type ConsignmentContractInput,
  type ConsignmentTerms,
  type ContractStatus,
} from "./fashion-consignment";
import { FASHION_CONSIGNMENT_EVENTS } from "./fashion-consignment-posting-rules";
import { rialText, type RialText } from "./inventory-exact";
import { emitDomainEvent } from "./posting-engine";
import { resolveLineTenders, type RetailTenderQueueEntry } from "./retail-tenders";
import { computeTradeGoodsSalePrice } from "./trade-goods";

const MESSAGES: Record<string, string> = {
  contract_not_found: "قرارداد امانی پیدا نشد.",
  consignor_not_found: "امانت‌گذار پیدا نشد.",
  item_not_found: "کالا در این شعبه پیدا نشد.",
  item_is_variant_parent: "کالای مادر موجودی ندارد؛ تنوع‌ها (سایز/رنگ) را انتخاب کنید.",
  item_tracking_not_supported: "کالاهای سریالی/بچی/وزنی را نمی‌توان امانی ثبت کرد.",
  item_on_open_contract: "این تنوع در قرارداد امانی باز دیگری است.",
  item_has_owned_stock: "این تنوع موجودی متعلق به فروشگاه دارد؛ کالای امانی و کالای خودِ فروشگاه نباید در یک تنوع مخلوط شوند.",
  reference_taken: "قراردادی با این شماره در این شعبه وجود دارد.",
  line_not_found: "ردیف قرارداد پیدا نشد.",
  consignment_shortage: "موجودی امانی کافی نیست.",
  below_owner_price: "قیمت فروش از قیمت توافقی امانت‌گذار کمتر است.",
  contract_expired: "مهلت قرارداد امانی تمام شده است؛ فروش و دریافت کالای تازه ممکن نیست.",
  contract_closed: "قرارداد امانی بسته شده است.",
  contract_has_stock: "پیش از بستن قرارداد، کالاهای فروش‌نرفته را به امانت‌گذار برگردانید.",
  settlement_exceeds_payable: "مبلغ تسویه از بدهی به امانت‌گذار بیشتر است.",
  consignment_return_must_restock: "کالای امانی برگشتی باید به قفسه برگردد؛ اگر آسیب دیده، پس از برگشت آن را به امانت‌گذار مرجوع کنید.",
  version_conflict: "این قرارداد در این فاصله تغییر کرده است؛ صفحه را تازه کنید.",
  idempotency_conflict: "این درخواست با همین شناسه قبلاً با محتوای دیگری ثبت شده است.",
  price_required: "قیمت فروش این کالای امانی تعیین نشده است.",
  invalid_quantity: "تعداد باید عدد صحیح مثبت باشد.",
  invalid_amount: "مبلغ معتبر نیست.",
};

export class ConsignmentError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(MESSAGES[code] ?? code);
    this.name = "ConsignmentError";
  }
}

const RULE_STATUS: Record<string, number> = {
  below_owner_price: 409,
  contract_expired: 409,
  contract_closed: 409,
  return_exceeds_sale: 409,
};

function fromRule(error: unknown): never {
  if (error instanceof ConsignmentRuleError) {
    throw new ConsignmentError(error.code, RULE_STATUS[error.code] ?? 400, error.detail);
  }
  throw error;
}

export interface ConsignmentActor {
  businessId: string;
  userId: string | null;
}

export interface ConsignmentLineDto {
  id: string;
  itemId: string;
  name: string;
  sku: string | null;
  attributes: string;
  terms: ConsignmentTerms;
  ownerUnitPriceRial: number | null;
  commissionBp: number | null;
  retailPriceRial: number | null;
  received: number;
  sold: number;
  customerReturned: number;
  voided: number;
  returnedToOwner: number;
  onHand: number;
  shareSoldRial: number;
  shareReturnedRial: number;
  shareVoidedRial: number;
  commissionRial: number;
}

export interface ConsignmentContractDto {
  id: string;
  reference: string;
  consignorId: string;
  consignorName: string;
  startsOn: string;
  expiresOn: string | null;
  notes: string | null;
  status: ContractStatus;
  version: number;
  settledRial: number;
  outstandingRial: number;
  onHand: number;
  lines: ConsignmentLineDto[];
}

export interface ConsignmentMovementDto {
  id: string;
  kind: string;
  lineId: string | null;
  itemName: string | null;
  quantity: number | null;
  ownerShareRial: number | null;
  commissionRial: number | null;
  amountRial: number | null;
  orderId: string | null;
  journalEntryId: string | null;
  note: string | null;
  actorName: string | null;
  at: string;
}

async function today(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Asia/Tehran')::date)::text AS d`);
  return rows[0].d;
}

function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

interface ContractRow {
  id: string;
  business_id: string;
  location_id: string;
  consignor_id: string;
  consignor_name: string;
  reference: string;
  starts_on: string;
  expires_on: string | null;
  notes: string | null;
  settled_rial: string;
  closed_at: string | null;
  version: number;
}

interface LineRow {
  id: string;
  contract_id: string;
  item_id: string;
  name: string;
  sku: string | null;
  attributes: string | null;
  terms: ConsignmentTerms;
  owner_unit_price_rial: string | null;
  commission_bp: number | null;
  retail_price_rial: string | null;
  received_qty: number;
  sold_qty: number;
  customer_returned_qty: number;
  voided_qty: number;
  returned_to_owner_qty: number;
  share_sold_rial: string;
  share_returned_rial: string;
  share_voided_rial: string;
  commission_rial: string;
}

const LINE_SELECT = `
  SELECT l.*, i.name, i.sku,
         (SELECT string_agg(a.value, ' / ' ORDER BY a.name) FROM item_variant_attributes a WHERE a.item_id = i.id) AS attributes
    FROM fashion_consignment_lines l JOIN items i ON i.id = l.item_id`;

function lineOnHand(l: Pick<LineRow, "received_qty" | "sold_qty" | "customer_returned_qty" | "voided_qty" | "returned_to_owner_qty">): number {
  return onHand({
    received: l.received_qty,
    sold: l.sold_qty,
    customerReturned: l.customer_returned_qty + l.voided_qty,
    returnedToOwner: l.returned_to_owner_qty,
  });
}

function lineDto(l: LineRow): ConsignmentLineDto {
  return {
    id: l.id,
    itemId: l.item_id,
    name: l.name,
    sku: l.sku,
    attributes: l.attributes ?? "",
    terms: l.terms,
    ownerUnitPriceRial: l.owner_unit_price_rial == null ? null : Number(l.owner_unit_price_rial),
    commissionBp: l.commission_bp,
    retailPriceRial: l.retail_price_rial == null ? null : Number(l.retail_price_rial),
    received: l.received_qty,
    sold: l.sold_qty,
    customerReturned: l.customer_returned_qty,
    voided: l.voided_qty,
    returnedToOwner: l.returned_to_owner_qty,
    onHand: lineOnHand(l),
    shareSoldRial: Number(l.share_sold_rial),
    shareReturnedRial: Number(l.share_returned_rial),
    shareVoidedRial: Number(l.share_voided_rial),
    commissionRial: Number(l.commission_rial),
  };
}

function contractDto(c: ContractRow, lines: LineRow[], day: string): ConsignmentContractDto {
  const dtos = lines.map(lineDto);
  const sum = (f: (l: LineRow) => string) => lines.reduce((acc, l) => acc + BigInt(f(l)), 0n);
  const outstanding = outstandingPayable({
    shareSoldRial: sum((l) => l.share_sold_rial),
    shareReturnedRial: sum((l) => l.share_returned_rial) + sum((l) => l.share_voided_rial),
    settledRial: BigInt(c.settled_rial),
  });
  return {
    id: c.id,
    reference: c.reference,
    consignorId: c.consignor_id,
    consignorName: c.consignor_name,
    startsOn: c.starts_on,
    expiresOn: c.expires_on,
    notes: c.notes,
    status: contractStatus({ closedAt: c.closed_at, expiresOn: c.expires_on }, day),
    version: c.version,
    settledRial: Number(c.settled_rial),
    outstandingRial: Number(outstanding),
    onHand: dtos.reduce((acc, l) => acc + l.onHand, 0),
    lines: dtos,
  };
}

async function lockContract(client: PoolClient, actor: ConsignmentActor, locationId: string, contractId: string): Promise<ContractRow> {
  const { rows } = await client.query<ContractRow>(
    `SELECT c.id, c.business_id, c.location_id, c.consignor_id, o.name AS consignor_name, c.reference,
            c.starts_on::text, c.expires_on::text, c.notes, c.settled_rial::text, c.closed_at::text, c.version
       FROM fashion_consignment_contracts c JOIN consignors o ON o.id = c.consignor_id
      WHERE c.id = $1 AND c.business_id = $2 AND c.location_id = $3
      FOR UPDATE OF c`,
    [contractId, actor.businessId, locationId],
  );
  if (!rows[0]) throw new ConsignmentError("contract_not_found", 404);
  return rows[0];
}

async function readContract(client: PoolClient, c: ContractRow): Promise<ConsignmentContractDto> {
  const { rows: lines } = await client.query<LineRow>(`${LINE_SELECT} WHERE l.contract_id = $1 ORDER BY i.name, l.id`, [c.id]);
  return contractDto(c, lines, await today(client));
}

/** Replays a mutation already recorded under `key`, or refuses a different payload under it. */
async function replayed(client: PoolClient, businessId: string, key: string, hash: string): Promise<boolean> {
  const { rows } = await client.query<{ request_hash: string | null }>(
    `SELECT request_hash FROM fashion_consignment_movements WHERE business_id = $1 AND idempotency_key = $2`,
    [businessId, key],
  );
  if (!rows[0]) return false;
  if (rows[0].request_hash !== hash) throw new ConsignmentError("idempotency_conflict", 409);
  return true;
}

// ---------------------------------------------------------------------------
// Owners (the shared `consignors` table).

export async function listConsignors(actor: ConsignmentActor): Promise<{ id: string; name: string; phone: string | null }[]> {
  return withTenantTransaction(actor.businessId, async (client) => {
    const { rows } = await client.query<{ id: string; name: string; phone: string | null }>(
      `SELECT id, name, phone FROM consignors WHERE business_id = $1 ORDER BY name LIMIT 500`,
      [actor.businessId],
    );
    return rows;
  });
}

export async function createConsignorRecord(
  actor: ConsignmentActor,
  locationId: string,
  input: { name: string; phone: string | null; notes: string | null },
): Promise<{ id: string; name: string; phone: string | null }> {
  const name = input.name.trim();
  if (!name || name.length > 200) throw new ConsignmentError("consignor_not_found");
  return withTenantTransaction(actor.businessId, async (client) => {
    const { rows } = await client.query<{ id: string; name: string; phone: string | null }>(
      `INSERT INTO consignors (business_id, location_id, name, phone, notes) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, phone`,
      [actor.businessId, locationId, name, input.phone?.trim() || null, input.notes?.trim() || null],
    );
    return rows[0];
  });
}

// ---------------------------------------------------------------------------
// Contracts.

export async function listContracts(actor: ConsignmentActor, locationId: string): Promise<ConsignmentContractDto[]> {
  return withTenantTransaction(actor.businessId, async (client) => {
    const { rows: contracts } = await client.query<ContractRow>(
      `SELECT c.id, c.business_id, c.location_id, c.consignor_id, o.name AS consignor_name, c.reference,
              c.starts_on::text, c.expires_on::text, c.notes, c.settled_rial::text, c.closed_at::text, c.version
         FROM fashion_consignment_contracts c JOIN consignors o ON o.id = c.consignor_id
        WHERE c.business_id = $1 AND c.location_id = $2
        ORDER BY c.closed_at IS NOT NULL, c.created_at DESC LIMIT 300`,
      [actor.businessId, locationId],
    );
    if (contracts.length === 0) return [];
    const { rows: lines } = await client.query<LineRow>(
      `${LINE_SELECT} WHERE l.contract_id = ANY($1::uuid[]) ORDER BY i.name, l.id`,
      [contracts.map((c) => c.id)],
    );
    const day = await today(client);
    return contracts.map((c) => contractDto(c, lines.filter((l) => l.contract_id === c.id), day));
  });
}

export async function getContract(
  actor: ConsignmentActor,
  locationId: string,
  contractId: string,
): Promise<{ contract: ConsignmentContractDto; movements: ConsignmentMovementDto[] }> {
  return withTenantTransaction(actor.businessId, async (client) => {
    const { rows } = await client.query<ContractRow>(
      `SELECT c.id, c.business_id, c.location_id, c.consignor_id, o.name AS consignor_name, c.reference,
              c.starts_on::text, c.expires_on::text, c.notes, c.settled_rial::text, c.closed_at::text, c.version
         FROM fashion_consignment_contracts c JOIN consignors o ON o.id = c.consignor_id
        WHERE c.id = $1 AND c.business_id = $2 AND c.location_id = $3`,
      [contractId, actor.businessId, locationId],
    );
    if (!rows[0]) throw new ConsignmentError("contract_not_found", 404);
    const contract = await readContract(client, rows[0]);
    const { rows: moves } = await client.query<{
      id: string; kind: string; line_id: string | null; item_name: string | null; quantity: number | null;
      owner_share_rial: string | null; commission_rial: string | null; amount_rial: string | null;
      order_id: string | null; journal_entry_id: string | null; note: string | null; actor_name: string | null; created_at: string;
    }>(
      `SELECT m.id, m.kind, m.line_id, i.name AS item_name, m.quantity, m.owner_share_rial::text, m.commission_rial::text,
              m.amount_rial::text, m.order_id, m.journal_entry_id, m.note, u.name AS actor_name, m.created_at::text
         FROM fashion_consignment_movements m
         LEFT JOIN fashion_consignment_lines l ON l.id = m.line_id
         LEFT JOIN items i ON i.id = l.item_id
         LEFT JOIN users u ON u.id = m.created_by
        WHERE m.contract_id = $1 ORDER BY m.created_at DESC, m.id LIMIT 300`,
      [contractId],
    );
    return {
      contract,
      movements: moves.map((m) => ({
        id: m.id, kind: m.kind, lineId: m.line_id, itemName: m.item_name, quantity: m.quantity,
        ownerShareRial: m.owner_share_rial == null ? null : Number(m.owner_share_rial),
        commissionRial: m.commission_rial == null ? null : Number(m.commission_rial),
        amountRial: m.amount_rial == null ? null : Number(m.amount_rial),
        orderId: m.order_id, journalEntryId: m.journal_entry_id, note: m.note, actorName: m.actor_name, at: m.created_at,
      })),
    };
  });
}

export interface CreateContractInput extends ConsignmentContractInput {
  notes: string | null;
  lines: (ConsignmentContractInput["lines"][number] & { retailPriceRial: number | null })[];
}

export async function createContract(actor: ConsignmentActor, locationId: string, input: CreateContractInput): Promise<ConsignmentContractDto> {
  try {
    validateContract(input);
  } catch (error) {
    fromRule(error);
  }
  return withTenantTransaction(actor.businessId, async (client) => {
    const { rows: owner } = await client.query(`SELECT 1 FROM consignors WHERE id = $1 AND business_id = $2`, [input.consignorId, actor.businessId]);
    if (!owner[0]) throw new ConsignmentError("consignor_not_found", 404);
    const { rows: items } = await client.query<{ id: string; kind: string; tracking: string }>(
      `SELECT i.id, i.kind, i.tracking FROM items i
         JOIN locations loc ON loc.id = i.location_id
        WHERE i.id = ANY($1::uuid[]) AND i.location_id = $2 AND loc.business_id = $3`,
      [input.lines.map((l) => l.itemId), locationId, actor.businessId],
    );
    for (const line of input.lines) {
      const item = items.find((i) => i.id === line.itemId);
      if (!item) throw new ConsignmentError("item_not_found", 404, { itemId: line.itemId });
      if (item.kind === "variant_parent") throw new ConsignmentError("item_is_variant_parent", 400, { itemId: line.itemId });
      if (item.tracking !== "none") throw new ConsignmentError("item_tracking_not_supported", 400, { itemId: line.itemId });
    }
    let contractId: string;
    try {
      await client.query("SAVEPOINT consignment_create");
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO fashion_consignment_contracts (business_id, location_id, consignor_id, reference, starts_on, expires_on, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [actor.businessId, locationId, input.consignorId, input.reference.trim(), input.startsOn, input.expiresOn, input.notes?.trim() || null, actor.userId],
      );
      contractId = rows[0].id;
      for (const line of input.lines) {
        await client.query(
          `INSERT INTO fashion_consignment_lines (contract_id, business_id, item_id, terms, owner_unit_price_rial, commission_bp, retail_price_rial)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [contractId, actor.businessId, line.itemId, line.terms, line.ownerUnitPriceRial, line.commissionBp, line.retailPriceRial],
        );
      }
      await client.query("RELEASE SAVEPOINT consignment_create");
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT consignment_create");
      const e = error as { code?: string; constraint?: string };
      if (e.code === "23505") {
        throw new ConsignmentError(e.constraint === "fashion_consignment_lines_open_item_uq" ? "item_on_open_contract" : "reference_taken", 409);
      }
      throw error;
    }
    return readContract(client, await lockContract(client, actor, locationId, contractId));
  });
}

// ---------------------------------------------------------------------------
// Quantity movements: receive from the owner, hand back to the owner.

export interface QuantityMovementInput {
  idempotencyKey: string;
  expectedVersion: number;
  note: string | null;
  lines: { lineId: string; quantity: number }[];
}

async function moveQuantities(
  actor: ConsignmentActor,
  locationId: string,
  contractId: string,
  kind: "receive" | "return_to_owner",
  input: QuantityMovementInput,
): Promise<ConsignmentContractDto> {
  const quantities = input.lines.map((l) => {
    try {
      return { lineId: l.lineId, quantity: parseConsignmentQuantity(l.quantity) };
    } catch (error) {
      return fromRule(error);
    }
  });
  if (quantities.length === 0) throw new ConsignmentError("invalid_quantity");
  const hash = hashOf({ kind, contractId, lines: quantities, note: input.note ?? null });
  return withTenantTransaction(actor.businessId, async (client) => {
    const contract = await lockContract(client, actor, locationId, contractId);
    if (await replayed(client, actor.businessId, input.idempotencyKey, hash)) return readContract(client, contract);
    if (contract.version !== input.expectedVersion) throw new ConsignmentError("version_conflict", 409);
    try {
      assertAllowed(contractStatus({ closedAt: contract.closed_at, expiresOn: contract.expires_on }, await today(client)), kind);
    } catch (error) {
      fromRule(error);
    }
    for (let index = 0; index < quantities.length; index++) {
      const { lineId, quantity } = quantities[index];
      const { rows } = await client.query<LineRow>(
        `SELECT * FROM fashion_consignment_lines WHERE id = $1 AND contract_id = $2 FOR UPDATE`,
        [lineId, contractId],
      );
      const line = rows[0];
      if (!line) throw new ConsignmentError("line_not_found", 404);
      if (kind === "receive") {
        const { rows: owned } = await client.query<{ quantity: string }>(
          `SELECT quantity::text FROM item_stock WHERE item_id = $1 FOR SHARE`,
          [line.item_id],
        );
        if (owned[0] && Number(owned[0].quantity) > 0) throw new ConsignmentError("item_has_owned_stock", 409, { lineId });
        await client.query(`UPDATE fashion_consignment_lines SET received_qty = received_qty + $2 WHERE id = $1`, [lineId, quantity]);
      } else {
        const available = lineOnHand(line);
        if (available < quantity) throw new ConsignmentError("consignment_shortage", 409, { lineId, onHand: available, quantity });
        await client.query(`UPDATE fashion_consignment_lines SET returned_to_owner_qty = returned_to_owner_qty + $2 WHERE id = $1`, [lineId, quantity]);
      }
      await client.query(
        `INSERT INTO fashion_consignment_movements
           (business_id, location_id, contract_id, line_id, kind, quantity, idempotency_key, request_hash, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [actor.businessId, locationId, contractId, lineId, kind, quantity,
          index === 0 ? input.idempotencyKey : `${input.idempotencyKey}:${index}`, hash, input.note?.trim() || null, actor.userId],
      );
    }
    await client.query(`UPDATE fashion_consignment_contracts SET version = version + 1, updated_at = now() WHERE id = $1`, [contractId]);
    return readContract(client, await lockContract(client, actor, locationId, contractId));
  });
}

export const receiveConsignedGoods = (actor: ConsignmentActor, locationId: string, contractId: string, input: QuantityMovementInput) =>
  moveQuantities(actor, locationId, contractId, "receive", input);

export const returnGoodsToOwner = (actor: ConsignmentActor, locationId: string, contractId: string, input: QuantityMovementInput) =>
  moveQuantities(actor, locationId, contractId, "return_to_owner", input);

// ---------------------------------------------------------------------------
// Settlement and close.

export async function settleWithOwner(
  actor: ConsignmentActor,
  locationId: string,
  contractId: string,
  input: { idempotencyKey: string; amountRial: number; method: "cash" | "bank"; note: string | null },
): Promise<ConsignmentContractDto> {
  if (!Number.isInteger(input.amountRial) || input.amountRial <= 0) throw new ConsignmentError("invalid_amount");
  const hash = hashOf({ kind: "settlement", contractId, amount: input.amountRial, method: input.method, note: input.note ?? null });
  return withTenantTransaction(actor.businessId, async (client) => {
    const contract = await lockContract(client, actor, locationId, contractId);
    if (await replayed(client, actor.businessId, input.idempotencyKey, hash)) return readContract(client, contract);
    const current = await readContract(client, contract);
    if (BigInt(input.amountRial) > BigInt(current.outstandingRial)) {
      throw new ConsignmentError("settlement_exceeds_payable", 409, { outstandingRial: current.outstandingRial });
    }
    const { entryId } = await emitDomainEvent(client, {
      businessId: actor.businessId,
      locationId,
      eventType: FASHION_CONSIGNMENT_EVENTS.settlement,
      payload: { contractId, amount: rialText(String(input.amountRial)), method: input.method },
      sourceType: "fashion_consignment_contract",
      sourceId: contractId,
      postingSourceId: randomUUID(),
      createdBy: actor.userId,
    });
    await client.query(
      `UPDATE fashion_consignment_contracts SET settled_rial = settled_rial + $2, version = version + 1, updated_at = now() WHERE id = $1`,
      [contractId, input.amountRial],
    );
    await client.query(
      `INSERT INTO fashion_consignment_movements
         (business_id, location_id, contract_id, kind, amount_rial, journal_entry_id, idempotency_key, request_hash, note, created_by)
       VALUES ($1, $2, $3, 'settlement', $4, $5, $6, $7, $8, $9)`,
      [actor.businessId, locationId, contractId, input.amountRial, entryId, input.idempotencyKey, hash, input.note?.trim() || null, actor.userId],
    );
    return readContract(client, await lockContract(client, actor, locationId, contractId));
  });
}

export async function closeContract(
  actor: ConsignmentActor,
  locationId: string,
  contractId: string,
  input: { expectedVersion: number },
): Promise<ConsignmentContractDto> {
  return withTenantTransaction(actor.businessId, async (client) => {
    const contract = await lockContract(client, actor, locationId, contractId);
    if (contract.closed_at) return readContract(client, contract);
    if (contract.version !== input.expectedVersion) throw new ConsignmentError("version_conflict", 409);
    const current = await readContract(client, contract);
    if (current.onHand > 0) throw new ConsignmentError("contract_has_stock", 409, { onHand: current.onHand });
    await client.query(
      `UPDATE fashion_consignment_contracts SET closed_at = now(), closed_by = $2, version = version + 1, updated_at = now() WHERE id = $1`,
      [contractId, actor.userId],
    );
    await client.query(`UPDATE fashion_consignment_lines SET is_open = false WHERE contract_id = $1`, [contractId]);
    await client.query(
      `INSERT INTO fashion_consignment_movements (business_id, location_id, contract_id, kind, created_by)
       VALUES ($1, $2, $3, 'close', $4)`,
      [actor.businessId, locationId, contractId, actor.userId],
    );
    return readContract(client, await lockContract(client, actor, locationId, contractId));
  });
}

// ---------------------------------------------------------------------------
// Till hooks — called inside the retail invoice's own transaction.

/** What a consigned sale line keeps in `order_items.retail_snapshot.consignment`. */
export interface ConsignmentSaleSnapshot {
  contractId: string;
  lineId: string;
  terms: ConsignmentTerms;
  quantity: number;
  net: RialText;
  ownerShare: RialText;
  commission: RialText;
}

/** The open consignment line holding units of this variant at this branch, locked; null for owned goods. */
export async function lockConsignedLineForSale(
  client: PoolClient,
  businessId: string,
  locationId: string,
  itemId: string,
): Promise<(LineRow & { expires_on: string | null; closed_at: string | null }) | null> {
  const { rows } = await client.query<LineRow & { expires_on: string | null; closed_at: string | null }>(
    `SELECT l.*, c.expires_on::text, c.closed_at::text
       FROM fashion_consignment_lines l
       JOIN fashion_consignment_contracts c ON c.id = l.contract_id
      WHERE l.item_id = $1 AND l.is_open AND c.business_id = $2 AND c.location_id = $3
      FOR UPDATE OF l`,
    [itemId, businessId, locationId],
  );
  const line = rows[0];
  if (!line || lineOnHand(line) <= 0) return null;
  return line;
}

export interface SellConsignedInput {
  businessId: string;
  locationId: string;
  itemId: string;
  quantity: string;
  unitPrice?: number | null;
  discount: number;
  vatPercent: number;
  tenders: RetailTenderQueueEntry[];
  createdBy: string | null;
}

export async function sellConsignedUnits(
  client: PoolClient,
  line: NonNullable<Awaited<ReturnType<typeof lockConsignedLineForSale>>>,
  input: SellConsignedInput,
) {
  let quantity: number;
  try {
    quantity = parseConsignmentQuantity(input.quantity);
    assertAllowed(contractStatus({ closedAt: line.closed_at, expiresOn: line.expires_on }, await today(client)), "sell");
  } catch (error) {
    return fromRule(error);
  }
  const available = lineOnHand(line);
  if (available < quantity) throw new ConsignmentError("consignment_shortage", 409, { onHand: available, quantity });

  let unitPrice = input.unitPrice ?? (line.retail_price_rial == null ? null : Number(line.retail_price_rial));
  if (unitPrice == null) {
    const { rows } = await client.query<{ unit_price: string | null }>(`SELECT unit_price::text FROM item_stock WHERE item_id = $1`, [line.item_id]);
    unitPrice = rows[0]?.unit_price == null ? null : Number(rows[0].unit_price);
  }
  if (unitPrice == null) throw new ConsignmentError("price_required", 400);

  const breakdown = computeTradeGoodsSalePrice({
    unitPrice,
    quantity: String(quantity),
    discount: input.discount,
    vatPercent: input.vatPercent,
  });
  let shares;
  try {
    shares = consignmentShares(
      {
        terms: line.terms,
        ownerUnitPriceRial: line.owner_unit_price_rial == null ? null : Number(line.owner_unit_price_rial),
        commissionBp: line.commission_bp,
      },
      quantity,
      BigInt(breakdown.net),
    );
  } catch (error) {
    return fromRule(error);
  }
  const tenders = resolveLineTenders({ tenders: input.tenders }, breakdown.total);
  const { entryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: FASHION_CONSIGNMENT_EVENTS.sale,
    payload: {
      itemId: line.item_id,
      contractId: line.contract_id,
      lineId: line.id,
      quantity,
      unitPrice,
      gross: breakdown.gross,
      discount: breakdown.discount,
      net: breakdown.net,
      vat: breakdown.vat,
      total: breakdown.total,
      ownerShare: rialText(shares.ownerShareRial.toString()),
      commission: rialText(shares.commissionRial.toString()),
      tenders,
    },
    sourceType: "fashion_consignment_sale",
    sourceId: line.item_id,
    postingSourceId: randomUUID(),
    createdBy: input.createdBy,
  });
  await client.query(
    `UPDATE fashion_consignment_lines
        SET sold_qty = sold_qty + $2, share_sold_rial = share_sold_rial + $3, commission_rial = commission_rial + $4
      WHERE id = $1`,
    [line.id, quantity, shares.ownerShareRial.toString(), shares.commissionRial.toString()],
  );
  const snapshot: ConsignmentSaleSnapshot = {
    contractId: line.contract_id,
    lineId: line.id,
    terms: line.terms,
    quantity,
    net: breakdown.net,
    ownerShare: rialText(shares.ownerShareRial.toString()),
    commission: rialText(shares.commissionRial.toString()),
  };
  return { breakdown, entryId, snapshot };
}

/** After the invoice line row exists: the sale's movement row, keyed by the order line. */
export async function recordConsignedSaleMovement(
  client: PoolClient,
  input: { businessId: string; locationId: string; orderId: string; orderItemId: string; createdBy: string | null; snapshot: ConsignmentSaleSnapshot; entryId: string | null },
): Promise<void> {
  await client.query(
    `INSERT INTO fashion_consignment_movements
       (business_id, location_id, contract_id, line_id, kind, quantity, net_rial, owner_share_rial, commission_rial,
        order_id, order_item_id, journal_entry_id, created_by)
     VALUES ($1, $2, $3, $4, 'sale', $5, $6, $7, $8, $9, $10, $11, $12)`,
    [input.businessId, input.locationId, input.snapshot.contractId, input.snapshot.lineId, input.snapshot.quantity,
      input.snapshot.net, input.snapshot.ownerShare, input.snapshot.commission, input.orderId, input.orderItemId, input.entryId, input.createdBy],
  );
}

export function parseConsignmentSnapshot(value: unknown): ConsignmentSaleSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.lineId !== "string" || typeof v.contractId !== "string" || typeof v.quantity !== "number") return null;
  return v as unknown as ConsignmentSaleSnapshot;
}

/** Customer return of a consigned line: restock it for the owner and reclassify the contra-revenue. */
export async function returnConsignedUnits(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    orderId: string;
    orderItemId: string;
    customerReturnId: string;
    quantity: string;
    disposition: "restockable" | "discarded";
    snapshot: ConsignmentSaleSnapshot;
    createdBy: string | null;
  },
): Promise<void> {
  if (input.disposition !== "restockable") throw new ConsignmentError("consignment_return_must_restock", 409);
  let quantity: number;
  try {
    quantity = parseConsignmentQuantity(input.quantity);
  } catch (error) {
    return fromRule(error);
  }
  const { rows: prior } = await client.query<{ q: string }>(
    `SELECT COALESCE(sum(quantity), 0)::text AS q FROM fashion_consignment_movements
      WHERE order_item_id = $1 AND kind = 'customer_return'`,
    [input.orderItemId],
  );
  let shares;
  try {
    shares = returnShares(
      { quantity: input.snapshot.quantity, ownerShareRial: BigInt(input.snapshot.ownerShare), commissionRial: BigInt(input.snapshot.commission) },
      Number(prior[0].q),
      quantity,
    );
  } catch (error) {
    return fromRule(error);
  }
  await client.query(`SELECT 1 FROM fashion_consignment_lines WHERE id = $1 FOR UPDATE`, [input.snapshot.lineId]);
  const { entryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: FASHION_CONSIGNMENT_EVENTS.returnReclass,
    payload: {
      orderItemId: input.orderItemId,
      quantity,
      ownerShare: rialText(shares.ownerShareRial.toString()),
      commission: rialText(shares.commissionRial.toString()),
    },
    sourceType: "customer_return",
    sourceId: input.customerReturnId,
    postingSourceId: randomUUID(),
    createdBy: input.createdBy,
  });
  await client.query(
    `UPDATE fashion_consignment_lines
        SET customer_returned_qty = customer_returned_qty + $2, share_returned_rial = share_returned_rial + $3,
            commission_rial = commission_rial - $4
      WHERE id = $1`,
    [input.snapshot.lineId, quantity, shares.ownerShareRial.toString(), shares.commissionRial.toString()],
  );
  await client.query(
    `INSERT INTO fashion_consignment_movements
       (business_id, location_id, contract_id, line_id, kind, quantity, owner_share_rial, commission_rial,
        order_id, order_item_id, customer_return_id, journal_entry_id, created_by)
     VALUES ($1, $2, $3, $4, 'customer_return', $5, $6, $7, $8, $9, $10, $11, $12)`,
    [input.businessId, input.locationId, input.snapshot.contractId, input.snapshot.lineId, quantity,
      shares.ownerShareRial.toString(), shares.commissionRial.toString(), input.orderId, input.orderItemId,
      input.customerReturnId, entryId, input.createdBy],
  );
}

/** Void of a consigned line (the sale entry itself is reversed by the void engine): units back to the owner's shelf. */
export async function voidConsignedSale(
  client: PoolClient,
  input: { businessId: string; locationId: string; orderId: string; orderItemId: string; snapshot: ConsignmentSaleSnapshot; createdBy: string | null },
): Promise<void> {
  await client.query(`SELECT 1 FROM fashion_consignment_lines WHERE id = $1 FOR UPDATE`, [input.snapshot.lineId]);
  await client.query(
    `UPDATE fashion_consignment_lines
        SET voided_qty = voided_qty + $2, share_voided_rial = share_voided_rial + $3, commission_rial = commission_rial - $4
      WHERE id = $1`,
    [input.snapshot.lineId, input.snapshot.quantity, input.snapshot.ownerShare, input.snapshot.commission],
  );
  await client.query(
    `INSERT INTO fashion_consignment_movements
       (business_id, location_id, contract_id, line_id, kind, quantity, owner_share_rial, commission_rial, order_id, order_item_id, created_by)
     VALUES ($1, $2, $3, $4, 'void', $5, $6, $7, $8, $9, $10)`,
    [input.businessId, input.locationId, input.snapshot.contractId, input.snapshot.lineId, input.snapshot.quantity,
      input.snapshot.ownerShare, input.snapshot.commission, input.orderId, input.orderItemId, input.createdBy],
  );
}

/** Consigned on-hand per variant at a branch (for the till's catalogue). */
export async function consignedOnHandByItem(client: PoolClient, businessId: string, locationId: string): Promise<Map<string, { onHand: number; retailPriceRial: number | null }>> {
  const { rows } = await client.query<LineRow & { expires_on: string | null }>(
    `SELECT l.*, c.expires_on::text FROM fashion_consignment_lines l
       JOIN fashion_consignment_contracts c ON c.id = l.contract_id
      WHERE l.is_open AND c.business_id = $1 AND c.location_id = $2
        AND (c.expires_on IS NULL OR c.expires_on >= (now() AT TIME ZONE 'Asia/Tehran')::date)`,
    [businessId, locationId],
  );
  const map = new Map<string, { onHand: number; retailPriceRial: number | null }>();
  for (const row of rows) {
    const units = lineOnHand(row);
    if (units > 0) map.set(row.item_id, { onHand: units, retailPriceRial: row.retail_price_rial == null ? null : Number(row.retail_price_rial) });
  }
  return map;
}
