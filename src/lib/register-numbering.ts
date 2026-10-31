/**
 * Per-project document numbers for the commercial registers (`MR-001`,
 * `RFQ-001`, `PO-001`, `VO-001`, `PC-001`, `MS-001`, `CR-001`, …).
 *
 * This is `aec-numbering.ts`'s rule lifted out unchanged, because issue #1128's
 * agency registers need it and "how a register numbers its documents" is one
 * rule — one advisory lock, one prefix, one padded sequence per project — not
 * one rule per industry. #799's Wave 9 extracted it from five copies for exactly
 * this reason; a sixth and a seventh register are two more callers of it.
 * `aec-numbering.ts` stays as the AEC-named door its five callers were written
 * against, so nothing changed for an AEC tenant: same numbers, same lock, same
 * sequence.
 *
 * The lock is an advisory transaction lock keyed on the table and the project,
 * which is what makes two people pressing "new" at the same moment produce
 * `MR-004` and `MR-005` rather than both producing `MR-004` (a unique index would
 * only turn the second into an error the person cannot act on). The seed is part
 * of this module's namespace and is shared by every caller: it is the same lock
 * every register takes, keyed by table, so registers never contend with each
 * other and no register can deadlock with another.
 *
 * The table and column are interpolated into the query, so they are a closed
 * union rather than strings: a caller cannot pass a name from a request.
 */

export const REGISTER_NUMBERING_LOCK_SEED = 7998;

export type RegisterNumberedTable =
  | "aec_variations"
  | "aec_payment_certificates"
  | "aec_material_requests"
  | "aec_rfqs"
  | "aec_commitments"
  // Issue #1128 §D — the agency's billing schedule and its change requests.
  | "agency_billing_milestones"
  | "agency_change_requests"
  // Issue #1128 §A — what the client asked for, which is numbered per agency
  // rather than per project; see `nextBusinessRegisterNumber`.
  | "agency_client_briefs";

export type RegisterNumberedColumn =
  | "variation_number"
  | "certificate_number"
  | "request_number"
  | "rfq_number"
  | "commitment_number"
  | "milestone_number"
  | "change_request_number"
  | "brief_number";

const NUMBER_COLUMN: Record<RegisterNumberedTable, RegisterNumberedColumn> = {
  aec_variations: "variation_number",
  aec_payment_certificates: "certificate_number",
  aec_material_requests: "request_number",
  aec_rfqs: "rfq_number",
  aec_commitments: "commitment_number",
  agency_billing_milestones: "milestone_number",
  agency_change_requests: "change_request_number",
  agency_client_briefs: "brief_number",
};

/**
 * The lock key's namespace stays `aec-number:` on purpose. It is the string the
 * five AEC registers have always hashed, and a rolling deploy runs two versions
 * of this code at once: rename the key and, for the length of that deploy, an
 * old pod and a new pod lock *different* keys for the same register and can hand
 * out the same number. The name is historical; the guarantee is not.
 */
function lockKey(table: RegisterNumberedTable, scope: string): string {
  return `aec-number:${table}:${scope}`;
}

/**
 * A register number, formatted the one way every register formats it.
 *
 * Extracted in #799's Wave 11: `RFQ-004`, `SNG-004`, `RFI-004` and the
 * commercial registers' numbers are all `<prefix>-<at least three digits>`, and
 * the same `String(n).padStart(3, "0")` was appearing in three modules — a
 * shared shape is a shared function, so a register that needs four digits later
 * changes one place rather than being the odd one out.
 */
export function formatRegisterNumber(prefix: string, value: number): string {
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
  return formatRegisterNumber(prefix, highest + 1);
}

/**
 * The next number for a project, inside the caller's transaction.
 *
 * Must be called inside one: the lock it takes is released at commit, and the
 * insert it exists to serialise has to be in the same transaction or the lock
 * guards nothing.
 */
export async function nextRegisterNumber(
  table: RegisterNumberedTable,
  projectId: string,
  prefix: string,
): Promise<string> {
  const { query } = await import("./db");
  const column = NUMBER_COLUMN[table];
  await query(`SELECT pg_advisory_xact_lock(hashtextextended($1, ${REGISTER_NUMBERING_LOCK_SEED}))`, [
    lockKey(table, projectId),
  ]);
  const { rows } = await query<{ max: number | null }>(
    `SELECT MAX(NULLIF(regexp_replace(${column}, '^.*-', ''), '')::integer) AS max
       FROM ${table}
      WHERE project_id = $1 AND ${column} LIKE $2`,
    [projectId, `${prefix}-%`],
  );
  return formatRegisterNumber(prefix, (rows[0]?.max ?? 0) + 1);
}

/**
 * The next number within one business, for a register that is not scoped to a
 * project.
 *
 * `nextRegisterNumber` numbers inside a project because that is what the five AEC
 * registers and §D's two mean by "the next one". A client brief means something
 * different: it is usually written while the work is still an opportunity and has
 * no project at all, so a project-scoped sequence would leave the common case
 * unnumbered. One sequence per agency also keeps a number unambiguous outside its
 * client's file, which matters because a brief gets quoted in proposals, projects
 * and change requests read by people who are not looking at one client's page.
 *
 * Same contract as its project-scoped sibling, and for the same reason: call it
 * inside the caller's transaction, because the lock it takes is released at
 * commit and an insert outside that transaction is not serialised by it.
 */
export async function nextBusinessRegisterNumber(
  table: RegisterNumberedTable,
  businessId: string,
  prefix: string,
): Promise<string> {
  const { query } = await import("./db");
  const column = NUMBER_COLUMN[table];
  await query(`SELECT pg_advisory_xact_lock(hashtextextended($1, ${REGISTER_NUMBERING_LOCK_SEED}))`, [
    lockKey(table, businessId),
  ]);
  const { rows } = await query<{ max: number | null }>(
    `SELECT MAX(NULLIF(regexp_replace(${column}, '^.*-', ''), '')::integer) AS max
       FROM ${table}
      WHERE business_id = $1 AND ${column} LIKE $2`,
    [businessId, `${prefix}-%`],
  );
  return formatRegisterNumber(prefix, (rows[0]?.max ?? 0) + 1);
}
