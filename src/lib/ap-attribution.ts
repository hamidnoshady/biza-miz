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
  opening_balance: { mode: "conditional", path: "opening_balance_lines.supplier_id on an A/P line of a posted opening set" },
  opening_balance_reversal: { mode: "conditional", path: "opening_balance_lines.supplier_id via reversal_journal_line_id of a reversed opening set" },
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

/**
 * Shared A/P source joins. `$1` is supplied by the caller as business id only
 * when needed; tenant/account/date filters stay in the caller's WHERE clause.
 * Every join is on the source type as well as source id, so an unrelated table
 * cannot accidentally claim another source's UUID.
 */
export const AP_SUPPLIER_ATTRIBUTION_SQL = `
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.entry_id
  LEFT JOIN purchases p
         ON je.source_type = 'purchase' AND p.id = je.source_id
        AND EXISTS (SELECT 1 FROM locations pl WHERE pl.id = p.location_id AND pl.business_id = je.business_id)
  LEFT JOIN supplier_returns sr
         ON je.source_type = 'supplier_return'
        AND sr.id = je.source_id
        AND sr.business_id = je.business_id
        AND sr.settlement_method = 'accounts_payable'
  LEFT JOIN purchases p2
         ON p2.id = sr.purchase_id
        AND EXISTS (SELECT 1 FROM locations p2l WHERE p2l.id = p2.location_id AND p2l.business_id = je.business_id)
  LEFT JOIN item_purchases ip
         ON je.source_type = 'item_purchase' AND ip.id = je.source_id AND ip.business_id = je.business_id
  LEFT JOIN item_supplier_returns isr
         ON je.source_type = 'item_supplier_return'
        AND isr.id = je.source_id
        AND isr.business_id = je.business_id
        AND isr.settlement_method = 'accounts_payable'
  LEFT JOIN item_purchases ipr
         ON ipr.id = isr.purchase_id AND ipr.business_id = je.business_id
  LEFT JOIN expenses exp
         ON je.source_type = 'expense'
        AND exp.id = je.source_id
        AND exp.business_id = je.business_id
        AND exp.settlement = 'credit'
  LEFT JOIN ap_payments ap
         ON je.source_type IN ('ap_payment', 'ap_payment_reversal')
        AND ap.id = je.source_id AND ap.business_id = je.business_id
  LEFT JOIN cheques ch ON je.source_type = 'cheque' AND ch.id = je.source_id AND ch.business_id = je.business_id
  -- An endorsed received cheque has no supplier_id on its original row. Its
  -- endorsement identifies the counterparty; the same identity is used for a
  -- later bounce so both sides stay on one statement.
  LEFT JOIN LATERAL (
    SELECT ce.endorsed_to_supplier_id
      FROM cheque_events ce
     WHERE ce.cheque_id = ch.id AND ce.endorsed_to_supplier_id IS NOT NULL
     ORDER BY ce.created_at, ce.id
     LIMIT 1
  ) endorsed ON ch.id IS NOT NULL
  LEFT JOIN installments ins
         ON je.source_type = 'installment_interest'
        AND ins.id = je.source_id
        AND ins.business_id = je.business_id
        AND ins.direction = 'payable'
  -- A location-bound plan uses only its branch alias. A legacy/business-wide
  -- plan is attributed only when the party has exactly one alias in the
  -- business; with multiple aliases, choosing one would be arbitrary.
  LEFT JOIN LATERAL (
    SELECT si.id AS supplier_id
      FROM suppliers si
      JOIN locations sil ON sil.id = si.location_id AND sil.business_id = ins.business_id
     WHERE ins.party_id IS NOT NULL
       AND si.party_id = ins.party_id
       AND (
         (ins.location_id IS NOT NULL AND si.location_id = ins.location_id)
         OR
         (ins.location_id IS NULL AND (
           SELECT count(*)
             FROM suppliers sx
             JOIN locations sxl ON sxl.id = sx.location_id
            WHERE sx.party_id = ins.party_id
              AND sxl.business_id = ins.business_id
         ) = 1)
       )
     ORDER BY si.id
     LIMIT 1
  ) interest_supplier ON ins.id IS NOT NULL
  -- A posted opening (or its reversal) carries the supplier it was entered
  -- against. The link is the journal line itself, so a carried payable keeps
  -- its party after the year rolls over (issue #867).
  LEFT JOIN opening_balance_lines obl
         ON obl.journal_line_id = jl.id OR obl.reversal_journal_line_id = jl.id
  LEFT JOIN suppliers s ON s.id = COALESCE(
    p.supplier_id,
    p2.supplier_id,
    ip.supplier_id,
    ipr.supplier_id,
    exp.supplier_id,
    ap.supplier_id,
    ch.supplier_id,
    endorsed.endorsed_to_supplier_id,
    interest_supplier.supplier_id,
    obl.supplier_id
  ) AND EXISTS (
    SELECT 1 FROM locations supplier_business_location
     WHERE supplier_business_location.id = s.location_id
       AND supplier_business_location.business_id = je.business_id
  )
  LEFT JOIN parties pa ON pa.id = s.party_id AND pa.business_id = je.business_id
  LEFT JOIN locations supplier_location
         ON supplier_location.id = s.location_id AND supplier_location.business_id = je.business_id
  LEFT JOIN locations entry_location
         ON entry_location.id = je.location_id AND entry_location.business_id = je.business_id`;

/** The one canonical A/P supplier alias expression paired with the joins above. */
export const AP_SUPPLIER_ID_SQL = `COALESCE(
  p.supplier_id,
  p2.supplier_id,
  ip.supplier_id,
  ipr.supplier_id,
  exp.supplier_id,
  ap.supplier_id,
  ch.supplier_id,
  endorsed.endorsed_to_supplier_id,
  interest_supplier.supplier_id,
  obl.supplier_id
)`;
