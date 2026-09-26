/**
 * Phase 21 Wave 4 — consignment (امانی). `consignors` mirrors
 * `parties-service.ts`'s shape and simplicity (a business-wide directory,
 * no separate pure-validation module — matching how customers/suppliers are
 * already validated inline in this codebase, not with dedicated pure
 * modules the way costing/pricing math is).
 *
 * `item_consignments` marks a `tracking: 'weight'` item as held for a
 * consignor rather than owned by the business — `gold-sales-service.ts`
 * checks this to route a sale through `gold.consignment_sale_revenue`
 * (src/lib/gold-posting-rules.ts) instead of the owned-inventory posting,
 * and to skip COGS entirely (the shop never owned the piece).
 *
 * DB-touching, so per repo convention it has no direct unit test; covered
 * instead by integration/consignment.integration.test.ts.
 */
import { randomUUID } from "node:crypto";
import { query, type PoolClient } from "./db";
import { getItem } from "./items-service";
import { consignorBalance } from "./industry-reports";
import { emitDomainEvent } from "./posting-engine";
import { rialText } from "./inventory-exact";
import type { SettlementMethod } from "./ledger";
// Side-effect import: registers the consignment.payout rule with the engine.
import "./gold-posting-rules";

export interface Consignor {
  id: string;
  businessId: string;
  name: string;
  phone: string | null;
  notes: string | null;
  createdAt: string;
}

interface ConsignorRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  name: string;
  phone: string | null;
  notes: string | null;
  created_at: string;
}

function mapConsignor(row: ConsignorRow): Consignor {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    phone: row.phone,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

export async function createConsignor(
  businessId: string,
  input: { name: string; phone?: string | null; notes?: string | null },
): Promise<Consignor> {
  const name = input.name?.trim();
  if (!name) throw new Error("نام امانت‌گذار نمی‌تواند خالی باشد.");

  const { rows } = await query<ConsignorRow>(
    `INSERT INTO consignors (business_id, name, phone, notes) VALUES ($1, $2, $3, $4) RETURNING *`,
    [businessId, name, input.phone?.trim() || null, input.notes?.trim() || null],
  );
  return mapConsignor(rows[0]);
}

export async function listConsignors(businessId: string): Promise<Consignor[]> {
  const { rows } = await query<ConsignorRow>(
    `SELECT * FROM consignors WHERE business_id = $1 ORDER BY name`,
    [businessId],
  );
  return rows.map(mapConsignor);
}

export async function getConsignor(id: string): Promise<Consignor | null> {
  const { rows } = await query<ConsignorRow>(`SELECT * FROM consignors WHERE id = $1`, [id]);
  return rows[0] ? mapConsignor(rows[0]) : null;
}

export interface ItemConsignment {
  itemId: string;
  consignorId: string;
  createdAt: string;
}

interface ItemConsignmentRow extends Record<string, unknown> {
  item_id: string;
  consignor_id: string;
  created_at: string;
}

function mapItemConsignment(row: ItemConsignmentRow): ItemConsignment {
  return { itemId: row.item_id, consignorId: row.consignor_id, createdAt: row.created_at };
}

/** Marks a `tracking: 'weight'` item as held for a consignor — one-time, at intake; there is no "un-consign" (the item stays theirs until it's sold or returned, and a return is just deleting the item, not a status transition modeled here yet). */
export async function markAsConsigned(itemId: string, consignorId: string): Promise<ItemConsignment> {
  const item = await getItem(itemId);
  if (!item) throw new Error("کالا یافت نشد.");
  if (item.tracking !== "weight") {
    throw new Error("فقط کالای با ردیابی «وزنی» می‌تواند امانی باشد.");
  }
  const consignor = await getConsignor(consignorId);
  if (!consignor) throw new Error("امانت‌گذار یافت نشد.");

  const { rows } = await query<ItemConsignmentRow>(
    `INSERT INTO item_consignments (item_id, consignor_id) VALUES ($1, $2) RETURNING *`,
    [itemId, consignorId],
  );
  return mapItemConsignment(rows[0]);
}

export async function getConsignment(itemId: string): Promise<ItemConsignment | null> {
  const { rows } = await query<ItemConsignmentRow>(
    `SELECT * FROM item_consignments WHERE item_id = $1`,
    [itemId],
  );
  return rows[0] ? mapItemConsignment(rows[0]) : null;
}

/**
 * Phase 21 Wave 7 — the consignor statement, and settling it.
 *
 * Reconstructed from the domain-event log rather than kept as a running
 * balance column, the same "never a shadow copy" discipline Phase 16's
 * AR/AP statements follow: what a consignor is owed is the sum of what
 * their sold pieces credited (`gold.consignment_sale_revenue`, whose
 * metal value + making charge is the consignor's portion — the shop keeps
 * only the profit as commission), less what has already been paid out
 * (`consignment.payout`). Each event also carries the `entry_id` of the
 * journal entry it posted, so the statement and the ledger can always be
 * reconciled against each other.
 */
export interface ConsignorStatementLine {
  itemId: string;
  itemName: string;
  soldAt: string;
  metalValue: number;
  makingCharge: number;
  /** The shop's commission on this sale — shown for transparency; not part of what the consignor is owed. */
  commission: number;
  /** metalValue + makingCharge — what this sale credited the consignor. */
  owed: number;
  entryId: string | null;
}

export interface ConsignorStatement {
  consignor: Consignor;
  /** Pieces still held, unsold. */
  itemsOnHand: { itemId: string; name: string; purity: string; netWeight: string }[];
  sales: ConsignorStatementLine[];
  payouts: { amount: number; paidAt: string; entryId: string | null }[];
  totalOwed: number;
  totalPaid: number;
  balance: number;
}

export async function getConsignorStatement(
  businessId: string,
  consignorId: string,
): Promise<ConsignorStatement | null> {
  const consignor = await getConsignor(consignorId);
  if (!consignor || consignor.businessId !== businessId) return null;

  const { rows: onHand } = await query<{
    item_id: string;
    name: string;
    purity: string;
    net_weight: string;
  }>(
    `SELECT c.item_id, i.name, w.purity, w.net_weight
       FROM item_consignments c
       JOIN items i ON i.id = c.item_id
       JOIN item_weight_attributes w ON w.item_id = c.item_id
      WHERE c.consignor_id = $1 AND w.status <> 'sold'
      ORDER BY i.name`,
    [consignorId],
  );

  const { rows: saleRows } = await query<{
    item_id: string;
    item_name: string;
    created_at: string;
    metal_value: string;
    making_charge: string;
    profit: string;
    entry_id: string | null;
  }>(
    `SELECT e.source_id AS item_id, i.name AS item_name, e.created_at,
            e.payload->>'metalValue' AS metal_value,
            e.payload->>'makingCharge' AS making_charge,
            e.payload->>'profit' AS profit,
            e.entry_id
       FROM domain_events e
       JOIN item_consignments c ON c.item_id = e.source_id
       JOIN items i ON i.id = e.source_id
      WHERE e.business_id = $1 AND e.event_type = 'gold.consignment_sale_revenue'
        AND c.consignor_id = $2
      ORDER BY e.created_at`,
    [businessId, consignorId],
  );

  const sales: ConsignorStatementLine[] = saleRows.map((r) => {
    const metalValue = Number(r.metal_value ?? 0);
    const makingCharge = Number(r.making_charge ?? 0);
    return {
      itemId: r.item_id,
      itemName: r.item_name,
      soldAt: r.created_at,
      metalValue,
      makingCharge,
      commission: Number(r.profit ?? 0),
      owed: metalValue + makingCharge,
      entryId: r.entry_id,
    };
  });

  const { rows: payoutRows } = await query<{ amount: string; created_at: string; entry_id: string | null }>(
    `SELECT payload->>'amount' AS amount, created_at, entry_id
       FROM domain_events
      WHERE business_id = $1 AND event_type = 'consignment.payout'
        AND payload->>'consignorId' = $2
      ORDER BY created_at`,
    [businessId, consignorId],
  );
  const payouts = payoutRows.map((r) => ({
    amount: Number(r.amount ?? 0),
    paidAt: r.created_at,
    entryId: r.entry_id,
  }));

  const totalOwed = sales.reduce((sum, s) => sum + s.owed, 0);
  const totalPaid = payouts.reduce((sum, p) => sum + p.amount, 0);

  return {
    consignor,
    itemsOnHand: onHand.map((r) => ({
      itemId: r.item_id,
      name: r.name,
      purity: r.purity,
      netWeight: r.net_weight,
    })),
    sales,
    payouts,
    totalOwed,
    totalPaid,
    balance: consignorBalance({ owed: totalOwed, paid: totalPaid }),
  };
}

export interface PayConsignorInput {
  businessId: string;
  locationId: string;
  consignorId: string;
  /** Rial, whole, positive — and never more than the outstanding balance. */
  amount: number;
  paymentMethod: Extract<SettlementMethod, "cash" | "bank">;
  createdBy?: string | null;
}

/** Settles part or all of a consignor's balance, in the caller's transaction. Refuses to overpay — a consignor payable is not a place to park money. */
export async function payConsignor(
  client: PoolClient,
  input: PayConsignorInput,
): Promise<{ entryId: string | null; balance: number }> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error("مبلغ تسویه باید یک عدد صحیح مثبت (ریال) باشد.");
  }
  if (input.paymentMethod !== "cash" && input.paymentMethod !== "bank") {
    throw new Error("تسویه با امانت‌گذار فقط نقدی یا بانکی است.");
  }

  const statement = await getConsignorStatement(input.businessId, input.consignorId);
  if (!statement) throw new Error("امانت‌گذار یافت نشد.");
  if (input.amount > statement.balance) {
    throw new Error("مبلغ تسویه از مانده بدهی به امانت‌گذار بیشتر است.");
  }

  // Same defect class as the retail sell-services: `postingKind` for this
  // rule is the fixed string "consignment_payout", and — per this function's
  // own doc comment — a consignor is meant to be paid "part or all" of their
  // balance, i.e. across many separate payouts over time. Keying the posting
  // identity on `input.consignorId`, as this used to, meant only the *first*
  // payout to any consignor could ever post; every later partial payout to
  // the same consignor threw a raw unique-constraint violation.
  // `getConsignorStatement` reads `payload->>'consignorId'`, not
  // `source_id`, so it is unaffected; `postingSourceId` is the separate
  // identity only the ledger posting itself uses, fresh per payout.
  const { entryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "consignment.payout",
    payload: {
      consignorId: input.consignorId,
      amount: rialText(String(input.amount)),
      paymentMethod: input.paymentMethod,
    },
    sourceType: "consignment_payout",
    sourceId: input.consignorId,
    postingSourceId: randomUUID(),
    createdBy: input.createdBy ?? null,
  });

  return { entryId, balance: statement.balance - input.amount };
}
