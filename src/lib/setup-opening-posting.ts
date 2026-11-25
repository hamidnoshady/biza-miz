/**
 * The wizard's opening-balance posting path (issue #1583), extracted from the
 * route so it can be exercised against a real database.
 *
 * Two rules this module exists to keep:
 *
 *  1. **One posting engine.** The wizard used to INSERT `journal_entries`
 *     itself, bypassing `postJournalEntry` — and with it voucher numbering, the
 *     fiscal-period trigger and line validation. It now posts through the same
 *     function every other document uses, keeping `source_type = 'opening'` so
 *     the entry is still *the* opening entry.
 *  2. **One authoritative opening per year.** The formal
 *     `opening_balance_sets` workflow already refuses to post into a year that
 *     has a wizard opening. This is the other half of that guard: the wizard
 *     refuses to post when an approved or posted set already exists.
 *
 * The wizard remains optional and never manufactures balances; it only records
 * the owner's real opening lines.
 */
import type { SessionPayload } from "./auth";
import { getPool, query } from "./db";
import { markStepDone, type WizardProgress } from "./settings";
import { checkBalance, validateOpeningLines, withAutoOffset, type OpeningLine } from "./opening";
import { WELL_KNOWN_CODES } from "./coa-template";
import { postJournalEntry } from "./ledger-service";
import { resolveActiveLocation } from "./setup-state";
import { inventoryControlSubtreeIds } from "./setup-opening";

/** A typed refusal the route can translate without guessing a status. */
export class WizardOpeningError extends Error {
  status: number;
  details?: Record<string, unknown>;
  constructor(code: string, status = 400, details?: Record<string, unknown>) {
    super(code);
    this.status = status;
    if (details) this.details = details;
  }
}

export interface WizardOpeningResult {
  entryId: string;
  totalDebit: number;
  totalCredit: number;
  alreadyExists?: boolean;
  progress: WizardProgress;
}

/** The one opening journal entry of this business, if the wizard (or a set) wrote it. */
async function existingOpeningEntry(businessId: string): Promise<{ id: string } | null> {
  const { rows } = await query<{ id: string }>(
    "SELECT id FROM journal_entries WHERE business_id = $1 AND source_type = 'opening' ORDER BY entry_date, posted_at LIMIT 1",
    [businessId],
  );
  return rows[0] ?? null;
}

/**
 * Post the owner's opening lines. Idempotent: a retry answers with the entry
 * that already exists, and a concurrent loser of the idempotency race is
 * resolved to the winner rather than a unique-violation 500.
 */
export async function postWizardOpeningBalances(params: {
  session: SessionPayload;
  lines?: OpeningLine[];
  autoOffset?: boolean;
}): Promise<WizardOpeningResult> {
  const businessId = params.session.businessId;
  const userId = params.session.sub;

  const existing = await existingOpeningEntry(businessId);
  if (existing) {
    // The ledger already holds the opening entry; the retry's job is only to
    // make the progress marker agree (issue #808 §9).
    const progress = await markStepDone(businessId, "opening");
    return { entryId: existing.id, totalDebit: 0, totalCredit: 0, alreadyExists: true, progress };
  }

  const { rows: formalOpening } = await query<{
    id: string;
    status: string;
    fiscal_year_label: string;
  }>(
    `SELECT id, status::text AS status, fiscal_year_label
       FROM opening_balance_sets
      WHERE business_id = $1 AND status IN ('approved', 'posted')
      ORDER BY fiscal_year_label
      LIMIT 1`,
    [businessId],
  );
  if (formalOpening[0]) {
    throw new WizardOpeningError("opening_set_exists", 409, {
      setId: formalOpening[0].id,
      fiscalYearLabel: formalOpening[0].fiscal_year_label,
      status: formalOpening[0].status,
    });
  }

  const rawLines = (params.lines ?? []).map((line) => ({
    accountId: String(line.accountId ?? ""),
    debit: Number(line.debit) || 0,
    credit: Number(line.credit) || 0,
  }));

  let lines = rawLines.filter((line) => line.debit !== 0 || line.credit !== 0);

  if (params.autoOffset) {
    const { rows: offsetAccount } = await query<{ id: string }>(
      "SELECT id FROM accounts WHERE business_id = $1 AND code = $2 AND is_active",
      [businessId, WELL_KNOWN_CODES.openingEquity],
    );
    if (!offsetAccount[0]) throw new WizardOpeningError("offset_account_missing", 409);
    lines = withAutoOffset(lines, offsetAccount[0].id);
  }

  const errors = validateOpeningLines(lines);
  if (errors.length > 0) {
    throw new WizardOpeningError("invalid_lines", 400, { messages: errors });
  }
  const balance = checkBalance(lines);
  if (!balance.balanced) {
    throw new WizardOpeningError("not_balanced", 400, {
      totalDebit: balance.totalDebit,
      totalCredit: balance.totalCredit,
    });
  }

  // Every referenced account must be this business's, active, postable, and
  // outside the automatic inventory-control subtree.
  const { rows: chartRows } = await query<{
    id: string;
    code: string;
    type: string;
    parent_id: string | null;
    is_active: boolean;
    has_children: boolean;
  }>(
    `SELECT a.id, a.code, a.type::text AS type, a.parent_id, a.is_active,
            EXISTS (SELECT 1 FROM accounts k WHERE k.parent_id = a.id) AS has_children
       FROM accounts a WHERE a.business_id = $1`,
    [businessId],
  );
  const byId = new Map(chartRows.map((row) => [row.id, row]));
  const excluded = inventoryControlSubtreeIds(
    chartRows.map((row) => ({
      id: row.id,
      code: row.code,
      type: row.type,
      parentId: row.parent_id,
      isActive: row.is_active,
      hasChildren: row.has_children,
    })),
  );
  for (const id of new Set(lines.map((line) => line.accountId))) {
    const account = byId.get(id);
    if (!account) throw new WizardOpeningError("unknown_account", 400);
    if (!account.is_active) throw new WizardOpeningError("account_inactive", 409, { accountId: id });
    if (account.has_children) throw new WizardOpeningError("not_a_leaf_account", 409, { accountId: id });
    if (excluded.has(id)) throw new WizardOpeningError("inventory_opening_is_automatic", 409);
  }

  const location = await resolveActiveLocation(params.session);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const entryId = await postJournalEntry(client, {
      businessId,
      locationId: location?.id ?? null,
      entryDate: null,
      memo: "تراز افتتاحیه",
      sourceType: "opening",
      sourceId: null,
      createdBy: userId,
      postingKind: "opening",
      lines: lines.map((line) => ({
        accountId: line.accountId,
        debit: line.debit,
        credit: line.credit,
      })),
      idempotencyKey: `setup-opening:${businessId}`,
    });
    if (!entryId) throw new WizardOpeningError("opening_entry_not_posted", 500);
    // The marker commits with the entry it describes (issue #808 §6).
    const progress = await markStepDone(businessId, "opening", client);
    await client.query("COMMIT");
    return {
      entryId,
      totalDebit: balance.totalDebit,
      totalCredit: balance.totalCredit,
      progress,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // A concurrent submit lost the idempotency race: answer with the winner.
    if ((err as { code?: string }).code === "23505") {
      const winner = await existingOpeningEntry(businessId);
      if (winner) {
        const progress = await markStepDone(businessId, "opening");
        return { entryId: winner.id, totalDebit: 0, totalCredit: 0, alreadyExists: true, progress };
      }
    }
    throw err;
  } finally {
    client.release();
  }
}
