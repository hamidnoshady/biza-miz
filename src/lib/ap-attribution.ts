/**
 * The explicit source-attribution contract for every journal source that may
 * post to Accounts Payable (2100).
 *
 * Keep this file framework- and database-free. The query fragment below is
 * reused by A/P balances, statements and aging; the registry lets tests and the
 * unknown-bucket UI distinguish a deliberate control-account adjustment from
 * a future automatic source that was added without supplier attribution.
 */
export const AP_SOURCE_ATTRIBUTION_CONTRACT = {
  purchase: { mode: "supplier", path: "purchases.supplier_id" },
  supplier_return: { mode: "conditional", path: "supplier_returns.purchase_id → purchases.supplier_id; accounts_payable settlement only" },
  item_purchase: { mode: "supplier", path: "item_purchases.supplier_id" },
  item_supplier_return: { mode: "conditional", path: "item_supplier_returns.purchase_id → item_purchases.supplier_id; accounts_payable settlement only" },
  expense: { mode: "supplier", path: "expenses.supplier_id when settlement=credit" },
  ap_payment: { mode: "supplier", path: "ap_payments.supplier_id" },
  ap_payment_reversal: { mode: "supplier", path: "ap_payment_reversal → ap_payments.supplier_id" },
  cheque: { mode: "conditional", path: "cheques.supplier_id or cheque_events.endorsed_to_supplier_id" },
  installment_interest: { mode: "supplier", path: "installments.party_id → one supplier alias at the plan location" },
  manual: { mode: "intentional_unknown", path: "manual journal has no counterparty dimension" },
  manual_adjustment: { mode: "intentional_unknown", path: "manual adjustment has no counterparty dimension" },
  opening: { mode: "intentional_unknown", path: "opening balance has no counterparty dimension" },
  holoo_import: { mode: "intentional_unknown", path: "imported general journal has no counterparty dimension" },
} as const;

export type ApAttributionStatus =
  | "attributed"
  | "automatic_missing"
  | "conditional_missing"
  | "intentional_unknown"
  | "unclassified";

/** Classifies an A/P journal line for the reconciliation-exception view. */
export function apAttributionStatus(sourceType: string | null, supplierId: string | null): ApAttributionStatus {
  if (supplierId) return "attributed";
  if (!sourceType || !Object.hasOwn(AP_SOURCE_ATTRIBUTION_CONTRACT, sourceType)) return "unclassified";
  const entry = AP_SOURCE_ATTRIBUTION_CONTRACT[sourceType as keyof typeof AP_SOURCE_ATTRIBUTION_CONTRACT];
  if (entry.mode === "intentional_unknown") return "intentional_unknown";
  if (entry.mode === "conditional") return "conditional_missing";
  return "automatic_missing";
}


// The source relation is also the statement's access path. Each source's
// supplier rule and metadata are declared once; a named statement applies its
// predicate here, before joining journal_entries. Unknown sources still survive
// the LEFT JOIN used by full-book reads. No cached attribution/balance table.
type Source = {
  type: string;
  from: string;
  scope: string;
  id: string;
  supplier: string;
  fields?: Partial<Record<"note" | "return_reason" | "purchase_id" | "item_purchase_id" |
    "supplier_return_id" | "item_supplier_return_id" | "payment_id" | "cheque_id" | "installment_plan_id", string>>;
};
const sources: Source[] = [
  { type: "purchase", from: "purchases p JOIN locations l ON l.id = p.location_id", scope: "l.business_id = $1",
    id: "p.id", supplier: "p.supplier_id", fields: { note: "p.note", purchase_id: "p.id" } },
  { type: "supplier_return", from: "supplier_returns sr JOIN purchases p ON p.id = sr.purchase_id JOIN locations l ON l.id = p.location_id",
    scope: "sr.business_id = $1 AND l.business_id = $1 AND sr.settlement_method = 'accounts_payable'",
    id: "sr.id", supplier: "p.supplier_id", fields: { note: "p.note", return_reason: "sr.reason", purchase_id: "p.id", supplier_return_id: "sr.id" } },
  { type: "item_purchase", from: "item_purchases ip", scope: "ip.business_id = $1",
    id: "ip.id", supplier: "ip.supplier_id", fields: { note: "ip.note", item_purchase_id: "ip.id" } },
  { type: "item_supplier_return", from: "item_supplier_returns sr JOIN item_purchases ip ON ip.id = sr.purchase_id",
    scope: "sr.business_id = $1 AND ip.business_id = $1 AND sr.settlement_method = 'accounts_payable'",
    id: "sr.id", supplier: "ip.supplier_id", fields: { note: "ip.note", return_reason: "sr.reason", item_purchase_id: "ip.id", item_supplier_return_id: "sr.id" } },
  { type: "expense", from: "expenses exp", scope: "exp.business_id = $1 AND exp.settlement = 'credit'",
    id: "exp.id", supplier: "exp.supplier_id", fields: { note: "exp.memo" } },
  ...["ap_payment", "ap_payment_reversal"].map((type): Source => ({ type, from: "ap_payments ap", scope: "ap.business_id = $1",
    id: "ap.id", supplier: "ap.supplier_id", fields: { payment_id: "ap.id" } })),
  { type: "cheque", from: `cheques ch LEFT JOIN LATERAL (
      SELECT ce.endorsed_to_supplier_id FROM cheque_events ce
       WHERE ce.cheque_id = ch.id AND ce.endorsed_to_supplier_id IS NOT NULL
       ORDER BY ce.created_at, ce.id LIMIT 1
    ) endorsed ON true`, scope: "ch.business_id = $1", id: "ch.id",
    supplier: "COALESCE(ch.supplier_id, endorsed.endorsed_to_supplier_id)", fields: { cheque_id: "ch.id" } },
  { type: "installment_interest", from: `installments ins LEFT JOIN LATERAL (
      SELECT si.id FROM suppliers si JOIN locations l ON l.id = si.location_id
       WHERE l.business_id = ins.business_id AND si.party_id = ins.party_id
         AND ((ins.location_id IS NOT NULL AND si.location_id = ins.location_id)
           OR (ins.location_id IS NULL AND (
             SELECT count(*) FROM suppliers sx JOIN locations lx ON lx.id = sx.location_id
              WHERE sx.party_id = ins.party_id AND lx.business_id = ins.business_id
           ) = 1))
       ORDER BY si.id LIMIT 1
    ) alias ON true`, scope: "ins.business_id = $1 AND ins.direction = 'payable'",
    id: "ins.id", supplier: "alias.id", fields: { installment_plan_id: "ins.id" } },
];

export function apSupplierAttributionSql(supplierParameter?: "$3::uuid"): string {
  const fields = ["note", "return_reason", "purchase_id", "item_purchase_id", "supplier_return_id",
    "item_supplier_return_id", "payment_id", "cheque_id", "installment_plan_id"] as const;
  const relation = sources.map((source) => `
    SELECT '${source.type}'::text AS source_type, ${source.id} AS source_id,
           ${source.supplier} AS supplier_id,
           ${fields.map((key) => `${source.fields?.[key] ?? "NULL"}::text AS ${key}`).join(", ")}
      FROM ${source.from}
     WHERE ${source.scope}${supplierParameter ? ` AND ${source.supplier} = ${supplierParameter}` : ""}
  `).join("UNION ALL");
  return `
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.entry_id
  ${supplierParameter ? "JOIN" : "LEFT JOIN"} (${relation}) ap_source
    ON ap_source.source_type = je.source_type AND ap_source.source_id = je.source_id
  LEFT JOIN suppliers s ON s.id = ap_source.supplier_id
    AND EXISTS (SELECT 1 FROM locations l WHERE l.id = s.location_id AND l.business_id = je.business_id)
  LEFT JOIN parties pa ON pa.id = s.party_id AND pa.business_id = je.business_id
  LEFT JOIN locations supplier_location ON supplier_location.id = s.location_id AND supplier_location.business_id = je.business_id
  LEFT JOIN locations entry_location ON entry_location.id = je.location_id AND entry_location.business_id = je.business_id`;
}

export const AP_SUPPLIER_ATTRIBUTION_SQL = apSupplierAttributionSql();
export const AP_SUPPLIER_ID_SQL = "ap_source.supplier_id";
