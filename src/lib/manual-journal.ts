/**
 * «سند دستی» — the rules of a manual journal document, as pure functions.
 *
 * The screen (`manual-entry-section.tsx`) and the service
 * (`manual-journal-service.ts`) have to agree about what a valid document is,
 * because the screen's summary panel is the only check most people read before
 * pressing «ثبت پیش‌نویس». When the two disagreed, the disagreement always took
 * the same shape: a green «متوازن» above a form whose submission came back as a
 * red server error. Two real cases —
 *
 *   - «صندوق بدهکار ۱۰٬۰۰۰ / صندوق بستانکار ۱۰٬۰۰۰» balances arithmetically, so
 *     the screen enabled the button; it is one account netting to zero, which
 *     the ledger should never be asked to carry;
 *   - a row whose amount could not be parsed contributed 0 to the on-screen
 *     total while being dropped from the payload, so the totals matched on
 *     screen and `not_balanced` came back from the API.
 *
 * So the rules live here once, framework-free, and both sides import them.
 * Pure and side-effect-free by design — per CLAUDE.md that makes them unit
 * testable directly (`manual-journal.test.ts`), unlike the DB-touching service.
 */

/** Caps on one manual document — see `manualDocumentProblem` for why each exists. */
export const MANUAL_MEMO_MAX = 500;
export const MANUAL_LINES_MAX = 200;
/** A client-generated idempotency key: enough for a UUID plus a prefix, short enough to index. */
export const MANUAL_IDEMPOTENCY_KEY_MAX = 128;
/** Why a draft was rejected. Long enough for a sentence, not for a novel. */
export const MANUAL_REJECTION_REASON_MAX = 500;

/**
 * Why a request body was refused before it ever reached the database.
 *
 * These are *payload* problems, distinct from `ManualJournalProblem` (which
 * describes a document that is well-formed but not postable). Both end up as a
 * 400 with the code as the body's `error`, so the API maps them the same way.
 */
export type ManualPayloadProblem =
  | "bad_request"
  | "too_many_lines"
  | "invalid_line"
  | "invalid_account_id"
  | "invalid_amount"
  | "invalid_entry_date"
  | "invalid_idempotency_key";

/** A draft-create request body, parsed and known to be well-formed. */
export interface ManualDraftPayload {
  memo: string;
  /** `null` means «امروز» — the service resolves it against the branch's own clock. */
  entryDate: string | null;
  lines: ManualJournalLine[];
  /** Client-supplied dedupe key, or `null` when the caller did not send one. */
  idempotencyKey: string | null;
}

export type ManualPayloadResult =
  | { ok: true; value: ManualDraftPayload }
  | { ok: false; problem: ManualPayloadProblem };

/** A document row as both sides hold it: integer Rial, debit XOR credit. */
export interface ManualJournalLine {
  accountId: string;
  debit: number;
  credit: number;
}

/**
 * The error code a document would be refused with, or `null` when it is
 * postable. The order matters: it is the order a person would fix the problems
 * in, and the screen turns the same codes into the sentence under its disabled
 * button.
 */
export type ManualJournalProblem =
  | "no_lines"
  | "too_many_lines"
  | "invalid_line"
  | "too_few_lines"
  | "single_account_entry"
  | "not_balanced";

/** The rows that actually become a document: everything with an amount on it. */
export function nonZeroLines<T extends ManualJournalLine>(lines: readonly T[]): T[] {
  return lines.filter((l) => l.debit !== 0 || l.credit !== 0);
}

/** Debit and credit totals as BigInt, so a large document cannot lose precision. */
export function manualJournalTotals(lines: readonly ManualJournalLine[]): {
  totalDebit: bigint;
  totalCredit: bigint;
  difference: bigint;
} {
  const totalDebit = lines.reduce((sum, l) => sum + BigInt(l.debit), 0n);
  const totalCredit = lines.reduce((sum, l) => sum + BigInt(l.credit), 0n);
  return { totalDebit, totalCredit, difference: totalDebit - totalCredit };
}

/**
 * What is wrong with this set of rows, or `null` if nothing is.
 *
 * `lines` is the *submitted* set — rows the caller has already decided are
 * complete. The screen filters incomplete rows out before calling this (and
 * reports them separately), exactly as the API's payload does.
 */
export function manualDocumentProblem(
  lines: readonly ManualJournalLine[],
): ManualJournalProblem | null {
  const rows = nonZeroLines(lines);
  if (rows.length === 0) return "no_lines";
  // A document with thousands of rows is a script or a mistake, not something
  // typed into the form, and every row is another INSERT inside the approval's
  // single transaction.
  if (rows.length > MANUAL_LINES_MAX) return "too_many_lines";
  for (const l of rows) {
    if (
      !l.accountId ||
      !Number.isSafeInteger(l.debit) ||
      l.debit < 0 ||
      !Number.isSafeInteger(l.credit) ||
      l.credit < 0 ||
      (l.debit !== 0 && l.credit !== 0)
    ) {
      return "invalid_line";
    }
  }
  // Double entry: at least two rows, naming at least two accounts. One account
  // debited and credited for the same amount balances and means nothing, and
  // because only a manual entry is reversible (and a reversal is not), the
  // ledger would carry the pair for ever.
  if (rows.length < 2) return "too_few_lines";
  if (new Set(rows.map((l) => l.accountId)).size < 2) return "single_account_entry";
  if (manualJournalTotals(rows).difference !== 0n) return "not_balanced";
  return null;
}

/** Whether a memo is present and within the stored column's sane length. */
export function manualMemoProblem(memo: string): "memo_required" | "memo_too_long" | null {
  const trimmed = memo.trim();
  if (!trimmed) return "memo_required";
  // `memo` is `text` in Postgres, so without this an accidental paste of a
  // whole invoice was stored in full and drawn untruncated in the review queue,
  // pushing every other draft off the screen.
  if (trimmed.length > MANUAL_MEMO_MAX) return "memo_too_long";
  return null;
}

/**
 * Reads an untrusted request body into a draft-create payload — or names the
 * first thing wrong with it. Pure by construction, so the API route has one
 * line to write and this is unit-testable without a database.
 *
 * Two things it does that the route used to do wrongly:
 *
 *  - **The line cap is checked against the raw array, before any of it is
 *    mapped.** Coercing ten thousand objects into a typed array only to count
 *    them and throw the result away was work a hostile or merely broken client
 *    could ask for at will.
 *  - **Nothing is coerced.** `Number(l.debit) || 0` turned `true`, a Persian
 *    string, `NaN`, `Infinity`, `{}` and `[]` into `0` — a silently dropped
 *    amount on a document that then failed `not_balanced`, or worse, balanced
 *    by accident. A payload that is not exactly the shape the screen sends is
 *    refused with a code that names the field, instead of being normalised
 *    into something the accountant never typed.
 *
 * `accountId` is checked as a UUID here for the same reason
 * `src/lib/ar-service.ts` guards its ids: `WHERE id = ANY($2::uuid[])` does
 * not answer "no such account" for a non-UUID, it raises `invalid input syntax
 * for type uuid`, which reaches the browser as «خطای غیرمنتظره».
 */
const MANUAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isManualUuid(value: unknown): value is string {
  return typeof value === "string" && MANUAL_UUID_RE.test(value);
}

/** A Rial amount: an integer the ledger can store, never a boolean or a string. */
function isRialAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseManualDraftPayload(body: unknown): ManualPayloadResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, problem: "bad_request" };
  }
  const raw = body as Record<string, unknown>;

  if (raw.lines !== undefined && !Array.isArray(raw.lines)) return { ok: false, problem: "bad_request" };
  const rawLines = (raw.lines ?? []) as unknown[];
  // Before mapping — see the docblock. A ten-thousand-row body must cost one
  // comparison, not ten thousand objects.
  if (rawLines.length > MANUAL_LINES_MAX) return { ok: false, problem: "too_many_lines" };

  const lines: ManualJournalLine[] = [];
  for (const entry of rawLines) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, problem: "invalid_line" };
    const line = entry as Record<string, unknown>;
    if (!isManualUuid(line.accountId)) return { ok: false, problem: "invalid_account_id" };
    // Absent is zero: the screen always sends both sides, but a caller that
    // omits the empty one is not wrong. Present-and-wrong is — including
    // `null`, which is not "no amount" but a typed value of the wrong type.
    const debit = line.debit === undefined ? 0 : line.debit;
    const credit = line.credit === undefined ? 0 : line.credit;
    if (!isRialAmount(debit) || !isRialAmount(credit)) return { ok: false, problem: "invalid_amount" };
    lines.push({ accountId: line.accountId, debit, credit });
  }

  // Only the *type* is judged here. Whether the string is a real calendar day
  // belongs to the service's `normalizeEntryDate`, which owns the single date
  // grammar both the manual path and a reversal are checked against — a second
  // parser here would be a second opinion the two could disagree with.
  let entryDate: string | null = null;
  if (raw.entryDate !== undefined && raw.entryDate !== null && raw.entryDate !== "") {
    if (typeof raw.entryDate !== "string") return { ok: false, problem: "invalid_entry_date" };
    entryDate = raw.entryDate;
  }

  let idempotencyKey: string | null = null;
  if (raw.idempotencyKey !== undefined && raw.idempotencyKey !== null) {
    if (typeof raw.idempotencyKey !== "string") return { ok: false, problem: "invalid_idempotency_key" };
    const key = raw.idempotencyKey.trim();
    if (!key || key.length > MANUAL_IDEMPOTENCY_KEY_MAX) return { ok: false, problem: "invalid_idempotency_key" };
    idempotencyKey = key;
  }

  return {
    ok: true,
    value: { memo: typeof raw.memo === "string" ? raw.memo : "", entryDate, lines, idempotencyKey },
  };
}

/**
 * Who may decide a pending draft's fate — one rule, three callers.
 *
 * The review screen, `DELETE …/drafts/{id}` and `POST …/drafts/{id}/reject`
 * each spelled this out for themselves, which is how they came to disagree:
 * the routes demanded `ledger.propose` up front and only then looked at who
 * owned the draft, so an approve-only role was refused the rejection the
 * documented workflow gives them, and a drafter who had since lost
 * `ledger.propose` could not withdraw their own draft.
 *
 * So the rule is one line and it mentions `ledger.propose` nowhere: **the
 * drafter may always take their own draft back, and `ledger.approve` may
 * decide anybody's.** Proposing is the capability to *put a draft into* the
 * queue; deciding what happens to one already there is a different act, and
 * conflating them is what blocked both of those people.
 */
/** The drafter, and only them — `createdBy`, not `proposedBy`, because that is the column the routes compare against. */
export function isDraftAuthor(input: {
  actorId: string | null | undefined;
  draftAuthorId: string | null;
}): boolean {
  return !!input.actorId && input.draftAuthorId === input.actorId;
}

export function canDecideOnDraft(input: {
  actorId: string | null | undefined;
  draftAuthorId: string | null;
  canApprove: boolean;
}): { mayDecide: boolean; isAuthor: boolean } {
  const isAuthor = isDraftAuthor(input);
  return { mayDecide: isAuthor || input.canApprove, isAuthor };
}

/**
 * A rejection recorded without a reason is not a rejection, it is a
 * disappearance — the reviewer reading the history six months later cannot tell
 * a mistake from a policy change. So a reviewer's rejection requires one; the
 * drafter withdrawing their own draft says why only if they want to.
 */
export function manualRejectionReasonProblem(
  reason: string | null | undefined,
): "rejection_reason_required" | "rejection_reason_too_long" | null {
  const trimmed = (reason ?? "").trim();
  if (!trimmed) return "rejection_reason_required";
  if (trimmed.length > MANUAL_REJECTION_REASON_MAX) return "rejection_reason_too_long";
  return null;
}
