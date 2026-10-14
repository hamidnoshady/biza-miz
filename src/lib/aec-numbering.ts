/**
 * Per-project document numbers for the AEC registers (`MR-001`, `RFQ-001`,
 * `PO-001`, `VO-001`, `PC-001`, …).
 *
 * Extracted in Wave 9 rather than copied: five registers now number their rows,
 * and "how a register numbers its documents" is a rule — one lock, one prefix,
 * one padded sequence per project — not five implementations of it. Wave 8's
 * `nextCommercialNumber` moved here unchanged, so the commercial registers'
 * numbers are bit-for-bit what they were.
 *
 * The lock is an advisory transaction lock keyed on the table and the project,
 * which is what makes two people pressing "new" at the same moment produce
 * `MR-004` and `MR-005` rather than both producing `MR-004` (a unique index would
 * only turn the second into an error the person cannot act on). The seed is part
 * of this module's namespace and is shared by every caller: it is the same lock
 * every register takes, keyed by table, so five registers never contend with each
 * other and no register can deadlock with another.
 *
 * The table and column are interpolated into the query, so they are a closed
 * union rather than strings: a caller cannot pass a name from a request.
 */

export const AEC_NUMBERING_LOCK_SEED = 7998;

export type AecNumberedTable =
  | "aec_variations"
  | "aec_payment_certificates"
  | "aec_material_requests"
  | "aec_rfqs"
  | "aec_commitments";

export type AecNumberedColumn =
  | "variation_number"
  | "certificate_number"
  | "request_number"
  | "rfq_number"
  | "commitment_number";

const NUMBER_COLUMN: Record<AecNumberedTable, AecNumberedColumn> = {
  aec_variations: "variation_number",
  aec_payment_certificates: "certificate_number",
  aec_material_requests: "request_number",
  aec_rfqs: "rfq_number",
  aec_commitments: "commitment_number",
};

/**
 * The next number for a project, inside the caller's transaction.
 *
 * Must be called inside one: the lock it takes is released at commit, and the
 * insert it exists to serialise has to be in the same transaction or the lock
 * guards nothing.
 */
/**
 * A register number, formatted the one way every register formats it.
 *
 * Extracted in Wave 11: `RFQ-004`, `SNG-004`, `RFI-004` and the commercial
 * registers' numbers are all `<prefix>-<at least three digits>`, and the same
 * `String(n).padStart(3, "0")` was appearing in three modules — a shared shape
 * is a shared function, so a register that needs four digits later changes one
 * place rather than being the odd one out.
 */
export function formatAecNumber(prefix: string, value: number): string {
  return `${prefix}-${String(Math.max(0, Math.trunc(value))).padStart(3, "0")}`;
}

/**
 * The next number in a series, from the numbers already issued.
 *
 * For a *suggestion* rather than an allocation: the field screen prefills an
 * RFI number the person may keep or overwrite (§10 keeps numbering the team's).
 * Only members that already follow the `<prefix>-digits` shape are counted, so a
 * hand-typed number can never break the arithmetic and the result is the number
 * the register would hand out next.
 */
export function nextNumberInSeries(prefix: string, numbers: readonly string[]): string {
  let highest = 0;
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`);
  for (const number of numbers) {
    const match = pattern.exec(number.trim());
    if (!match) continue;
    highest = Math.max(highest, Number(match[1]));
  }
  return formatAecNumber(prefix, highest + 1);
}

export async function nextAecNumber(
  table: AecNumberedTable,
  projectId: string,
  prefix: string,
): Promise<string> {
  const { query } = await import("./db");
  const column = NUMBER_COLUMN[table];
  await query(`SELECT pg_advisory_xact_lock(hashtextextended($1, ${AEC_NUMBERING_LOCK_SEED}))`, [
    `aec-number:${table}:${projectId}`,
  ]);
  const { rows } = await query<{ max: number | null }>(
    `SELECT MAX(NULLIF(regexp_replace(${column}, '^.*-', ''), '')::integer) AS max
       FROM ${table}
      WHERE project_id = $1 AND ${column} LIKE $2`,
    [projectId, `${prefix}-%`],
  );
  return formatAecNumber(prefix, (rows[0]?.max ?? 0) + 1);
}
