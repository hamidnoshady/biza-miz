/**
 * Phase 16 — chart of accounts customisation.
 *
 * `accounts` has carried `parent_id` and `is_active` since Phase 1 — sub-
 * accounts and archival needed no schema change, only the CRUD this file
 * provides plus the guards that make them safe: a well-known code (anything
 * in coa-template.ts's WELL_KNOWN_CODES — auto-posting looks these up by
 * code, not id) can never be archived or deleted, and an account with any
 * postings against it (real or drafted) can only be archived, never deleted,
 * so history never goes missing. Archiving doesn't touch history either — a
 * trial balance or statement still shows every posting an archived account
 * ever received; it just stops being offered for new ones (manual-journal-
 * service's assertAccountsOwned filters is_active the same way the account
 * picker already did).
 *
 * Three rules this file keeps, all of them learned from bugs:
 *
 *  - **An id that cannot exist is a 404, never a 500.** Every id arrives from
 *    a URL or a request body, and `WHERE id = $1` against a `uuid` column
 *    raises `invalid input syntax for type uuid` for anything else — see
 *    uuid.ts, which exists for exactly this class of crash.
 *  - **The database's own constraints are error codes, not surprises.** The
 *    `UNIQUE (business_id, code)` index and `journal_lines.account_id`'s
 *    `ON DELETE RESTRICT` are the real guards against a concurrent writer;
 *    the SELECTs before them only make the common case report nicely, so a
 *    lost race has to come back as `code_in_use`/`account_has_postings` too
 *    rather than as «خطای غیرمنتظره».
 *  - **One edit is one transaction.** Renaming, moving and archiving can
 *    arrive in a single PATCH, and a half-applied edit (renamed, then a
 *    rejected move) leaves the screen showing an error next to a change that
 *    actually happened. `updateAccount` applies all three, with their audit
 *    rows, atomically.
 */
import { query, getPool } from "./db";
import { assertCurrencyAvailable, MulticurrencyError } from "./multicurrency-service";
import { isUuid } from "./uuid";
import { toLatinDigits } from "./digits";
import {
  ACCOUNT_TYPES,
  WELL_KNOWN_CODES,
  isValidAccountCode,
  nextAccountLevel,
  type AccountLevel,
  type AccountType,
  type NormalBalance,
} from "./coa-template";
import type { PoolClient } from "pg";

export class AccountsError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

const WELL_KNOWN_CODE_SET = new Set<string>(Object.values(WELL_KNOWN_CODES));

/** Postgres SQLSTATEs this file translates into its own error codes. */
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

function sqlState(err: unknown): string | undefined {
  return typeof err === "object" && err !== null ? (err as { code?: string }).code : undefined;
}

/**
 * An account code as it is stored: ASCII digits, no surrounding whitespace.
 *
 * A Persian keyboard produces «۶۱۰۰», and a code stored that way is a
 * different string from the `1100`/`4300` the auto-posting engine looks up in
 * `WELL_KNOWN_CODES` — so a business could create an account that *looks*
 * exactly like the one the system needs and have nothing find it. Codes are
 * identifiers, not display text (digits.ts: "Data is always stored with Latin
 * (ASCII) digits"), so the conversion belongs here, on the way in.
 */
export function normalizeAccountCode(code: string): string {
  return toLatinDigits(String(code)).trim();
}

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  parentId: string | null;
  parentCode: string | null;
  isActive: boolean;
  hasPostings: boolean;
  hasChildren: boolean;
  level: AccountLevel;
  normalBalance: NormalBalance;
  isContra: boolean;
  /**
   * Multicurrency (issue #863): the account's own currency when it is a
   * foreign-currency financial account (a foreign bank). NULL = the business
   * base currency, which is every account until one is flagged. Surfaced so
   * the chart shows which accounts hold foreign value instead of leaving the
   * flag visible only at creation time.
   */
  currencyCode: string | null;
}

export async function listAccounts(businessId: string): Promise<AccountRow[]> {
  const { rows } = await query<{
    id: string;
    code: string;
    name: string;
    type: AccountType;
    parent_id: string | null;
    parent_code: string | null;
    is_active: boolean;
    has_postings: boolean;
    has_children: boolean;
    level: AccountLevel;
    normal_balance: NormalBalance;
    is_contra: boolean;
    currency_code: string | null;
  }>(
    `SELECT a.id, a.code, a.name, a.type, a.parent_id, p.code AS parent_code, a.is_active,
            EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.account_id = a.id) AS has_postings,
            EXISTS (SELECT 1 FROM accounts c WHERE c.parent_id = a.id) AS has_children,
            a.level, a.normal_balance, a.is_contra, a.currency_code
       FROM accounts a LEFT JOIN accounts p ON p.id = a.parent_id
      WHERE a.business_id = $1
      ORDER BY a.code`,
    [businessId],
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    type: r.type,
    parentId: r.parent_id,
    parentCode: r.parent_code,
    isActive: r.is_active,
    hasPostings: r.has_postings,
    hasChildren: r.has_children,
    level: r.level,
    normalBalance: r.normal_balance,
    isContra: r.is_contra,
    currencyCode: r.currency_code,
  }));
}

interface AccountLookup extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  level: AccountLevel;
  is_active: boolean;
}

/**
 * One account, or null — including for an id that is not a uuid at all, which
 * is a row that cannot exist rather than a reason to raise.
 */
async function findAccount(
  businessId: string,
  id: string,
  client?: PoolClient,
): Promise<AccountLookup | null> {
  if (!isUuid(id)) return null;
  const sql = `SELECT id, code, name, parent_id, level, is_active FROM accounts WHERE business_id = $1 AND id = $2`;
  const params = [businessId, id];
  const { rows } = client
    ? await client.query<AccountLookup>(sql, params)
    : await query<AccountLookup>(sql, params);
  return rows[0] ?? null;
}

/**
 * §7.5's audit-trail question (issue #160, Phase 22 Wave 11) — reuses the
 * existing `audit_log` table (Phase 0/20) rather than a dedicated history
 * table: `accounts` itself stays current-state-only, and every
 * rename/reparent/archive is a row here instead, the same "current state +
 * an append-only log elsewhere" split every other audited entity
 * (branches, employees, devices) already uses.
 *
 * Written on the *same* client as the change it describes, so the log and the
 * state it records commit or roll back together — an audited system whose
 * audit row can be the thing that fails is not audited.
 */
async function recordAccountAudit(
  client: PoolClient,
  businessId: string,
  actorId: string | null,
  action: "account.renamed" | "account.reparented" | "account.archived" | "account.reactivated",
  accountId: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, 'account', $4, $5)`,
    [businessId, actorId, action, accountId, payload ? JSON.stringify(payload) : null],
  );
}

/** Run `fn` inside one transaction, rolling back on any failure. */
async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Walks a subtree top-down, recomputing each descendant's `level` from its
 * (already-updated) parent's — the cascade a reparent needs whenever the
 * moved account's own level changes. Throws `hierarchy_too_deep` if any
 * descendant would need to sit below تفصیلی, the deepest standard tier.
 */
async function cascadeDescendantLevels(
  client: PoolClient,
  businessId: string,
  rootId: string,
  rootLevel: AccountLevel,
): Promise<void> {
  let frontier: { id: string; level: AccountLevel }[] = [{ id: rootId, level: rootLevel }];
  const seen = new Set<string>([rootId]);
  while (frontier.length > 0) {
    const nextFrontier: { id: string; level: AccountLevel }[] = [];
    for (const node of frontier) {
      const { rows: children } = await client.query<{ id: string }>(
        `SELECT id FROM accounts WHERE business_id = $1 AND parent_id = $2`,
        [businessId, node.id],
      );
      if (children.length === 0) continue;
      const childLevel = nextAccountLevel(node.level);
      if (!childLevel) throw new AccountsError("hierarchy_too_deep", 409);
      for (const c of children) {
        // `accounts.parent_id` has no DB-level cycle guard (see migration
        // 0056); without this the walk would never terminate on bad data.
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        await client.query(`UPDATE accounts SET level = $1 WHERE id = $2`, [childLevel, c.id]);
        nextFrontier.push({ id: c.id, level: childLevel });
      }
    }
    frontier = nextFrontier;
  }
}

/** Walks the parent chain of `candidateParentId`; throws if it ever reaches `accountId`. */
async function assertNoCycle(
  client: PoolClient,
  businessId: string,
  accountId: string,
  candidateParentId: string,
): Promise<void> {
  let current: string | null = candidateParentId;
  const seen = new Set<string>();
  while (current) {
    if (current === accountId) throw new AccountsError("parent_cycle");
    if (seen.has(current)) break;
    seen.add(current);
    const result: { rows: { parent_id: string | null }[] } = await client.query<{ parent_id: string | null }>(
      `SELECT parent_id FROM accounts WHERE business_id = $1 AND id = $2`,
      [businessId, current],
    );
    current = result.rows[0]?.parent_id ?? null;
  }
}

export async function createAccount(params: {
  businessId: string;
  code: string;
  name: string;
  type: string;
  parentId?: string | null;
  isContra?: boolean;
  /**
   * Multicurrency (issue #863): the account's own currency for a
   * foreign-currency financial account (a foreign bank). NULL/omitted = the
   * business's base currency, which is every account until one is flagged.
   */
  currencyCode?: string | null;
}): Promise<{ id: string }> {
  /* The convention is «Latin digits in storage, Persian digits in display»
     (digits.ts), and the add form's own placeholder invites «۶۱۰۰». Storing a
     Persian-digit code verbatim would make «۶۱۰۰» and «6100» two different
     accounts to UNIQUE(business_id, code), to ORDER BY code, and to the
     well-known-code lookups the auto-posting engine keys on — so the code is
     canonicalised here at the boundary, not trusted to every caller. */
  const code = normalizeAccountCode(params.code);
  const name = params.name.trim();
  if (!code) throw new AccountsError("code_required");
  if (!isValidAccountCode(code)) throw new AccountsError("invalid_code");
  if (!name) throw new AccountsError("name_required");
  if (!ACCOUNT_TYPES.includes(params.type as AccountType)) throw new AccountsError("invalid_type");

  let level: AccountLevel = "group";
  if (params.parentId) {
    const parent = await findAccount(params.businessId, params.parentId);
    if (!parent) throw new AccountsError("parent_not_found");
    const computed = nextAccountLevel(parent.level);
    if (!computed) throw new AccountsError("parent_too_deep", 409);
    level = computed;
  }

  const { rows: existing } = await query(`SELECT 1 FROM accounts WHERE business_id = $1 AND code = $2`, [
    params.businessId,
    code,
  ]);
  if (existing.length > 0) throw new AccountsError("code_in_use", 409);

  const currencyCode =
    typeof params.currencyCode === "string" && /^[A-Za-z]{3}$/.test(params.currencyCode)
      ? params.currencyCode.toUpperCase()
      : null;
  if (currencyCode) {
    // An account that names a currency may only name one this business has
    // enabled — and never the base currency (that is what NULL means). The
    // catalogue check is server-side: the form offers the allowed list, but
    // the API does not trust it (issue #863 §tenant-ownership).
    try {
      await assertCurrencyAvailable(params.businessId, currencyCode);
    } catch (err) {
      if (err instanceof MulticurrencyError) throw new AccountsError(err.message, err.status);
      throw err;
    }
  }
  try {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra, currency_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [params.businessId, params.parentId ?? null, code, name, params.type, level, params.isContra ?? false, currencyCode],
    );
    return { id: rows[0].id };
  } catch (err) {
    // The SELECT above is a pre-flight, not a lock: two simultaneous creates
    // of the same code race the table's UNIQUE(business_id, code), and before
    // this the loser of that race got a raw 500 instead of the same 409 the
    // pre-flight would have produced.
    if (sqlState(err) === UNIQUE_VIOLATION) throw new AccountsError("code_in_use", 409);
    throw err;
  }
}

/** Renames an account. See `updateAccount` for the combined edit. */
export async function renameAccount(
  businessId: string,
  id: string,
  name: string,
  actorId: string | null = null,
): Promise<void> {
  await updateAccount({ businessId, id, actorId, name });
}

/** Moves an account (and its subtree) under a new parent, or to the top level. */
export async function reparentAccount(
  businessId: string,
  id: string,
  parentId: string | null,
  actorId: string | null = null,
): Promise<void> {
  await updateAccount({ businessId, id, actorId, parentId, reparent: true });
}

/** Archives or restores an account. */
export async function setAccountActive(
  businessId: string,
  id: string,
  isActive: boolean,
  actorId: string | null = null,
): Promise<void> {
  await updateAccount({ businessId, id, actorId, isActive });
}

/**
 * One account edit — rename and/or reparent and/or archive — applied as a
 * single transaction, with its audit rows.
 *
 * The route accepts all three in one PATCH ("rename while reparenting"), and
 * they used to run as three independent statements: a rename that succeeded
 * followed by a move the hierarchy rules rejected left the account renamed,
 * the caller holding an error, and the screen still showing the old name.
 *
 * `reparent` is explicit rather than inferred from `parentId !== undefined`,
 * because moving an account to the top level *is* `parentId: null` — the
 * route's own "a present parentId is an instruction" rule, made unambiguous
 * for callers that build the patch from a form.
 */
export async function updateAccount(params: {
  businessId: string;
  id: string;
  actorId?: string | null;
  name?: string;
  parentId?: string | null;
  /** Apply `parentId` (which may be null, meaning "no parent"). */
  reparent?: boolean;
  isActive?: boolean;
}): Promise<void> {
  const { businessId, id } = params;
  const actorId = params.actorId ?? null;
  const wantsReparent = params.reparent === true || (params.reparent === undefined && params.parentId !== undefined);
  const parentId = params.parentId ?? null;

  const trimmedName = params.name === undefined ? undefined : params.name.trim();
  if (trimmedName !== undefined && !trimmedName) throw new AccountsError("name_required");

  await inTransaction(async (client) => {
    const account = await findAccount(businessId, id, client);
    if (!account) throw new AccountsError("account_not_found", 404);

    if (trimmedName !== undefined && trimmedName !== account.name) {
      await client.query(`UPDATE accounts SET name = $1 WHERE business_id = $2 AND id = $3`, [
        trimmedName,
        businessId,
        id,
      ]);
      await recordAccountAudit(client, businessId, actorId, "account.renamed", id, {
        before: account.name,
        after: trimmedName,
      });
    }

    if (wantsReparent && parentId !== account.parent_id) {
      let newLevel: AccountLevel;
      if (parentId) {
        if (parentId === id) throw new AccountsError("parent_cycle");
        const parent = await findAccount(businessId, parentId, client);
        if (!parent) throw new AccountsError("parent_not_found");
        await assertNoCycle(client, businessId, id, parentId);
        const computed = nextAccountLevel(parent.level);
        if (!computed) throw new AccountsError("parent_too_deep", 409);
        newLevel = computed;
      } else {
        newLevel = "group";
      }

      await client.query(`UPDATE accounts SET parent_id = $1, level = $2 WHERE business_id = $3 AND id = $4`, [
        parentId,
        newLevel,
        businessId,
        id,
      ]);
      await cascadeDescendantLevels(client, businessId, id, newLevel);
      await recordAccountAudit(client, businessId, actorId, "account.reparented", id, {
        beforeParentId: account.parent_id,
        afterParentId: parentId,
      });
    }

    if (params.isActive !== undefined) {
      const isActive = params.isActive;
      if (!isActive && WELL_KNOWN_CODE_SET.has(account.code)) {
        throw new AccountsError("well_known_account", 409);
      }
      // Archiving an already-archived account is not an event. Rename and
      // reparent have always skipped their no-ops (and the integration suite
      // asserts it); this one used to write a fresh row every time, so a
      // double-click produced a history of changes that never happened.
      if (isActive !== account.is_active) {
        await client.query(`UPDATE accounts SET is_active = $1 WHERE business_id = $2 AND id = $3`, [
          isActive,
          businessId,
          id,
        ]);
        await recordAccountAudit(
          client,
          businessId,
          actorId,
          isActive ? "account.reactivated" : "account.archived",
          id,
        );
      }
    }
  });
}

/** Hard delete — only for an account that was never actually posted to. Otherwise, archive it. */
export async function deleteAccount(businessId: string, id: string): Promise<void> {
  const account = await findAccount(businessId, id);
  if (!account) throw new AccountsError("account_not_found", 404);
  if (WELL_KNOWN_CODE_SET.has(account.code)) throw new AccountsError("well_known_account", 409);

  await inTransaction(async (client) => {
    const { rows: postings } = await client.query(`SELECT 1 FROM journal_lines WHERE account_id = $1 LIMIT 1`, [id]);
    if (postings.length > 0) throw new AccountsError("account_has_postings", 409);

    const { rows: draftLines } = await client.query(
      `SELECT 1 FROM journal_entry_draft_lines WHERE account_id = $1 LIMIT 1`,
      [id],
    );
    if (draftLines.length > 0) throw new AccountsError("account_has_draft_postings", 409);

    const { rows: children } = await client.query(
      `SELECT 1 FROM accounts WHERE business_id = $1 AND parent_id = $2 LIMIT 1`,
      [businessId, id],
    );
    if (children.length > 0) throw new AccountsError("account_has_children", 409);

    try {
      const { rowCount } = await client.query(`DELETE FROM accounts WHERE business_id = $1 AND id = $2`, [
        businessId,
        id,
      ]);
      if (!rowCount) throw new AccountsError("account_not_found", 404);
    } catch (err) {
      // Every table that points at an account does so `ON DELETE RESTRICT`
      // (journal lines, draft lines, expenses, reconciliations). Those FKs —
      // not the SELECTs above — are what actually holds against a concurrent
      // writer, and a lost race must still read as «این حساب سند خورده».
      if (sqlState(err) === FOREIGN_KEY_VIOLATION) throw new AccountsError("account_has_postings", 409);
      throw err;
    }
  });
}
