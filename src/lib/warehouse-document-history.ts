/**
 * A warehouse document's correction history — the original a reversal came
 * from, and the reversal a document got (if any) — as the detail dialog's
 * history panel shows it.
 *
 * Issue #923: the register must show *linked* original/replacement entries
 * with the reason and the actor, not just a `reversed_of` uuid. #922 owns the
 * reversal *operation*; this module only reads what that operation recorded
 * (`reversed_of`, `reversal_reason`, `note`, `created_by`) and never writes.
 *
 * Why it is a separate module: both families (Food Service
 * `warehouse_documents`, Retail `retail_warehouse_documents`) have the same
 * shape of history, and the two detail routes must answer identically — a
 * retail voucher and an F&B voucher reversed the same way should not produce
 * two different panels. The table name is chosen from a closed set, never from
 * a request.
 *
 * Branch scope: every query is scoped to the business **and** the branch the
 * caller was already authorized for. A reversal always lives in the same
 * branch as its original (the reversal route posts it there), so this can only
 * narrow the answer — it cannot widen what the caller may see.
 */
import { query } from "./db";
import { businessDateSql } from "./warehouse-document-register";

export type WarehouseHistoryFamily = "fnb" | "retail";

const TABLES: Record<WarehouseHistoryFamily, string> = {
  fnb: "warehouse_documents",
  retail: "retail_warehouse_documents",
};

/** One end of the chain, as the panel renders it. */
export interface WarehouseDocumentLink {
  id: string;
  /** «رسید» / «حواله» / «امحا» / «مصرف داخلی» — the raw kind. */
  kind: string;
  voucherNumber: string | null;
  businessDate: string;
  createdAt: string;
  /** The actor's name at posting time (snapshot first, live join after). */
  actorName: string | null;
  /** Why the reversal happened: the recorded reason, else the reversal's note. */
  reason: string | null;
  /** The reversal's own label when it named the original it replaced. */
  reversesVoucherNumber: string | null;
}

export interface WarehouseDocumentHistory {
  /** Set when this document *is* a reversal: the document it reverses. */
  original: WarehouseDocumentLink | null;
  /** Set when this document has been reversed: the reversal document. */
  reversal: WarehouseDocumentLink | null;
}

const LINK_COLUMNS = (table: string) => `
  x.id,
  x.kind::text AS kind,
  COALESCE(x.internal_voucher_number, x.document_number) AS voucher_number,
  ${businessDateSql("x", "lx")}::text AS business_date,
  x.created_at,
  COALESCE(x.created_by_name, ux.full_name) AS actor_name,
  COALESCE(NULLIF(x.reversal_reason, ''), x.note) AS reason,
  ox.voucher_number AS reverses_voucher_number
`;

/**
 * The history of `documentId`, read in one round trip.
 *
 * `documentId` must already have been authorized by the caller (the detail
 * routes authorize the document's branch before reading anything); the
 * `locationId` here is defence in depth, so a future bug in the caller cannot
 * turn a cross-branch link into a leak.
 */
export async function loadWarehouseDocumentHistory(input: {
  businessId: string;
  locationId: string;
  documentId: string;
  family: WarehouseHistoryFamily;
}): Promise<WarehouseDocumentHistory> {
  const table = TABLES[input.family];
  const { rows } = await query<{
    original: WarehouseDocumentLink | null;
    reversal: WarehouseDocumentLink | null;
  }>(
    `WITH self AS (
       SELECT id, reversed_of FROM ${table} WHERE id = $3 AND business_id = $1 AND location_id = $2
     ), original AS (
       SELECT ${LINK_COLUMNS(table)}
         FROM ${table} x
         JOIN self ON self.reversed_of = x.id
         JOIN locations lx ON lx.id = x.location_id
         LEFT JOIN users ux ON ux.id = x.created_by
         LEFT JOIN (SELECT id, COALESCE(internal_voucher_number, document_number) AS voucher_number
                      FROM ${table}) ox ON ox.id = x.reversed_of
        WHERE x.business_id = $1 AND x.location_id = $2
     ), reversal AS (
       SELECT ${LINK_COLUMNS(table)}
         FROM ${table} x
         JOIN self ON x.reversed_of = self.id
         JOIN locations lx ON lx.id = x.location_id
         LEFT JOIN users ux ON ux.id = x.created_by
         LEFT JOIN (SELECT id, COALESCE(internal_voucher_number, document_number) AS voucher_number
                      FROM ${table}) ox ON ox.id = x.reversed_of
        WHERE x.business_id = $1 AND x.location_id = $2
     )
     SELECT (SELECT row_to_json(o) FROM original o LIMIT 1) AS original,
            (SELECT row_to_json(r) FROM reversal r LIMIT 1) AS reversal`,
    [input.businessId, input.locationId, input.documentId],
  );

  const row = rows[0];
  const map = (value: unknown): WarehouseDocumentLink | null => {
    if (!value || typeof value !== "object") return null;
    const raw = value as Record<string, unknown>;
    if (typeof raw.id !== "string") return null;
    return {
      id: raw.id,
      kind: String(raw.kind ?? ""),
      voucherNumber: (raw.voucher_number as string | null) ?? null,
      businessDate: String(raw.business_date ?? ""),
      createdAt: String(raw.created_at ?? ""),
      actorName: (raw.actor_name as string | null) ?? null,
      reason: (raw.reason as string | null) ?? null,
      reversesVoucherNumber: (raw.reverses_voucher_number as string | null) ?? null,
    };
  };

  return { original: map(row?.original), reversal: map(row?.reversal) };
}

/**
 * The reason a reversal records.
 *
 * The reverse route takes a free-text note; `reversal_reason` is the column
 * that means "why", and it is what the history panel reads first. A caller
 * that gives no reason still gets the generated «برگشت سند …» note, so the
 * panel never shows an unexplained reversal — but when a human did type a
 * reason, that is the text shown.
 */
export function normaliseReversalReason(
  reason: unknown,
  note: unknown,
  fallback: string,
): string {
  if (typeof reason === "string" && reason.trim()) return reason.trim().slice(0, 500);
  if (typeof note === "string" && note.trim()) return note.trim().slice(0, 500);
  return fallback.slice(0, 500);
}
