/** One source relation for all A/R reads. Each source contributes at most one
 * row, including the amendment -> original-order bridge. Named statements
 * push the party predicate into this same relation, before touching journals;
 * balances/aging LEFT JOIN it so unsupported/missing sources remain unknown.
 * $1 is always the authenticated business. Values are bound by the caller.
 */
export function arCustomerAttributionSql(customerParameter?: "$3::uuid"): string {
  const party = (column: string) => customerParameter ? ` AND ${column} = ${customerParameter}` : "";
  return `
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.entry_id
  ${customerParameter ? "JOIN" : "LEFT JOIN"} (
    SELECT 'order'::text AS source_type, o.id AS source_id, o.customer_id,
           o.id AS order_id, o.order_number, NULL::text AS receipt_method,
           NULL::text AS serial_number, NULL::text AS bank_name
      FROM orders o JOIN locations l ON l.id = o.location_id
     WHERE l.business_id = $1${party("o.customer_id")}
    UNION ALL
    SELECT 'order_amendment', am.id, o.customer_id, o.id, o.order_number, NULL, NULL, NULL
      FROM order_amendments am JOIN orders o ON o.id = am.order_id
      JOIN locations l ON l.id = o.location_id
     WHERE am.business_id = $1 AND l.business_id = $1${party("o.customer_id")}
    UNION ALL
    SELECT 'ar_receipt', r.id, r.customer_id, NULL, NULL, r.method, NULL, NULL
      FROM ar_receipts r WHERE r.business_id = $1${party("r.customer_id")}
    UNION ALL
    SELECT 'cheque', ch.id, ch.customer_id, NULL, NULL, NULL, ch.serial_number, ch.bank_name
      FROM cheques ch WHERE ch.business_id = $1${party("ch.customer_id")}
  ) ar_source ON ar_source.source_type = je.source_type AND ar_source.source_id = je.source_id`;
}

export const AR_CUSTOMER_ATTRIBUTION_SQL = arCustomerAttributionSql();
export const AR_CUSTOMER_ID_SQL = "ar_source.customer_id";
