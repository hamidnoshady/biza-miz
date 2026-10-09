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
 *  - **Hierarchy writes are serialized per business.** Any operation that
 *    mutates hierarchy state (create with parent, reparent, delete, archive
 *    when descendant invariants are involved) takes an advisory xact lock on
 *    `chart-of-accounts:<businessId>` before reading or writing. Without
 *    this, two concurrent opposite reparents could each pass assertNoCycle
 *    and commit a real cycle (issue #824 §1). Validation always happens
 *    after the lock is held.
 */
import { query, getPool } from "./db";
import { isUuid } from "./uuid";
import { toLatinDigits } from "./digits";
import { AccountsError } from "./accounts-error";
import { attachmentLevel, loadAttachableParent, resolveAttachableParent } from "./account-hierarchy";
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

export { AccountsError } from "./accounts-error";

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
  hasDraftPostings: boolean;
  hasChildren: boolean;
  level: AccountLevel;
  normalBalance: NormalBalance;
  isContra: boolean;
}

/**
 * The management metadata for one account — real postings, draft postings,
 * children. `listAccounts` exposes them all so the UI can decide eligibility
 * with the same rules the service enforces server-side; nothing the UI does
 * is the integrity boundary, but offering a button the backend is guaranteed
 * to reject just produces a confusing error dialog.
 */
export async function listAccounts(businessId: string, options?: { all?: boolean }): Promise<AccountRow[]> {
  // Preserve legacy semantics: `listAccounts()` (no options) returns every
  // account regardless of active/archived state, matching the historical
  // behaviour callers (e.g. Holoo export, the chart ?all=1 path) rely on.
  // Passing `{ all: false }` explicitly filters to active accounts only for
  // callers that want the narrow list.
  const onlyActive = options?.all === false;
  const { rows } = await query<{
    id: string;
    code: string;
    name: string;
    type: AccountType;
    parent_id: string | null;
    parent_code: string | null;
    is_active: boolean;
    has_postings: boolean;
    has_draft_postings: boolean;
    has_children: boolean;
    level: AccountLevel;
    normal_balance: NormalBalance;
    is_contra: boolean;
  }>(
    `SELECT a.id, a.code, a.name, a.type, a.parent_id, p.code AS parent_code, a.is_active,
            EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.account_id = a.id) AS has_postings,
            EXISTS (SELECT 1 FROM journal_entry_draft_lines dl WHERE dl.account_id = a.id) AS has_draft_postings,
            EXISTS (SELECT 1 FROM accounts c WHERE c.parent_id = a.id) AS has_children,
            a.level, a.normal_balance, a.is_contra
       FROM accounts a LEFT JOIN accounts p ON p.id = a.parent_id
      WHERE a.business_id = $1
        ${onlyActive ? "AND a.is_active" : ""}
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
    hasDraftPostings: r.has_draft_postings,
    hasChildren: r.has_children,
    level: r.level,
    normalBalance: r.normal_balance,
    isContra: r.is_contra,
  }));
}

interface AccountLookup extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  parent_id: string | null;
  level: AccountLevel;
  is_active: boolean;
  is_contra: boolean;
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
  const sql = `SELECT id, code, name, type, parent_id, level, is_active, is_contra FROM accounts WHERE business_id = $1 AND id = $2`;
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
 *
 * Creation (account.created), hard deletion (account.deleted) and contra
 * changes (account.contra_changed) are logged as of issue #824, alongside the
 * earlier rename/reparent/archive/reactivate actions. Deletion snapshots the
 * identifying fields so the row remains understandable after the account row
 * is gone.
 */
async function recordAccountAudit(
  client: PoolClient,
  businessId: string,
  actorId: string | null,
  action:
    | "account.created"
    | "account.renamed"
    | "account.reparented"
    | "account.archived"
    | "account.reactivated"
    | "account.contra_changed"
    | "account.deleted",
  accountId: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, 'account', $4, $5)`,
    [businessId, actorId, action, accountId, payload ? JSON.stringify(payload) : null],
  );
}

/**
 * Take a transaction-scoped advisory lock that serialises every hierarchy
 * mutation for one business. Issue #824 §1/§9: without a lock, two concurrent
 * opposite reparents could each read the pre-mutation state, both pass
 * assertNoCycle, update different rows and commit a real cycle — and many
 * other hierarchy-sensitive operations (derive level from parent, cascade
 * descendant levels, check archived-parent invariants) have analogous races.
 *
 * Using pg_advisory_xact_lock means the lock releases automatically on
 * COMMIT/ROLLBACK, so there is no leaked-lock path. Hashtextextended spreads
 * the keyspace over the 64-bit advisory namespace the same way other parts
 * of the codebase that need per-tenant serialization do.
 *
 * Exported because this is the *one* boundary for chart-of-accounts
 * hierarchy writes (review item 6). Any other code path that inserts or
 * reparents accounts must take the same lock — the canonical editor, the
 * Holoo account import, and the device-pairing restore all do. The two
 * provisioning paths (`seedChartOfAccounts`) take it too, even though a
 * business being created has no concurrent editor, so that the rule is
 * "every writer locks" rather than "every writer locks except the ones we
 * believed were alone".
 */
export async function lockChartOfAccounts(client: PoolClient, businessId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `chart-of-accounts:${businessId}`,
  ]);
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
 *
 * Must be called while the hierarchy lock is held (see `lockChartOfAccounts`).
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

/**
 * Fetch every descendant of `rootId` (root included), using UNION with an
 * array-accumulated visited set so a pre-existing cycle in the data cannot
 * cause the recursive CTE to loop infinitely. PG has no native CYCLE clause
 * in older versions, so we guard manually.
 *
 * Returns {id, parent_id, is_active, type} so callers can use the result for
 * type checks, active-status checks and cascade rules without re-querying.
 */
async function fetchDescendants(
  client: PoolClient,
  businessId: string,
  rootId: string,
): Promise<{ id: string; parent_id: string | null; is_active: boolean; type: AccountType }[]> {
  // Walk in application code with a seen-set so corrupt historical cycles
  // terminate deterministically (we must not loop, but we also must not
  // mutate historical data to "fix" cycles — the tree UI already tolerates
  // them; our job here is to not crash when validating).
  const out: { id: string; parent_id: string | null; is_active: boolean; type: AccountType }[] = [];
  const seen = new Set<string>([rootId]);
  // Start with direct children of rootId (root itself is excluded from the
  // "descendant" set — callers add it separately when needed).
  let frontier: string[] = [];
  const { rows: direct } = await client.query<{ id: string; parent_id: string | null; is_active: boolean; type: AccountType }>(
    `SELECT id, parent_id, is_active, type FROM accounts WHERE business_id = $1 AND parent_id = $2`,
    [businessId, rootId],
  );
  for (const r of direct) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
    frontier.push(r.id);
  }
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      const { rows } = await client.query<{ id: string; parent_id: string | null; is_active: boolean; type: AccountType }>(
        `SELECT id, parent_id, is_active, type FROM accounts WHERE business_id = $1 AND parent_id = $2`,
        [businessId, nodeId],
      );
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(r);
        next.push(r.id);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Fetch the type of every descendant of `rootId` (root included). Used to
 * enforce the type-consistency rule: a subtree can only be reparented under
 * a parent whose accounting type matches its own, because the chart groups
 * accounts by asset/liability/equity/revenue/expense semantics.
 */
async function fetchSubtreeTypes(
  client: PoolClient,
  businessId: string,
  rootId: string,
): Promise<{ id: string; type: AccountType }[]> {
  const root = await client.query<{ id: string; type: AccountType }>(
    `SELECT id, type FROM accounts WHERE business_id = $1 AND id = $2`,
    [businessId, rootId],
  );
  const rootRow = root.rows[0];
  if (!rootRow) return [];
  const descendants = await fetchDescendants(client, businessId, rootId);
  return [{ id: rootRow.id, type: rootRow.type }, ...descendants.map((d) => ({ id: d.id, type: d.type }))];
}

/**
 * Walk the ancestor chain of `accountId` upward and return the first ancestor
 * that is archived, or null if every ancestor is active. Used on restore
 * (issue #824 review item 1): restoring a child under an archived ancestor
 * would resurrect "archived ancestor → active descendant", the mirror
 * invariant of the archive-with-active-child guard.
 */
async function findArchivedAncestor(
  client: PoolClient,
  businessId: string,
  accountId: string,
  effectiveParentId: string | null,
): Promise<{ id: string; code: string } | null> {
  let current: string | null = effectiveParentId;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) break; // cycle guard
    seen.add(current);
    const { rows } = await client.query<{ id: string; code: string; parent_id: string | null; is_active: boolean }>(
      `SELECT id, code, parent_id, is_active FROM accounts WHERE business_id = $1 AND id = $2`,
      [businessId, current],
    );
    const row = rows[0];
    if (!row) return null;
    if (!row.is_active) return { id: row.id, code: row.code };
    current = row.parent_id;
  }
  return null;
}

/**
 * Does an active descendant exist under `rootId`? Used when archiving: we
 * disallow archiving a parent while any active child/grandchild/... remains
 * beneath it, regardless of whether an intermediate node in that chain is
 * itself already archived (issue #824 review item 2 — the old recursive
 * filter filtered on is_active in both terms, so it missed active
 * grandchildren hidden under an archived intermediate). We traverse every
 * descendant regardless of active state, then check each for is_active.
 */
async function hasActiveDescendant(
  client: PoolClient,
  businessId: string,
  rootId: string,
): Promise<boolean> {
  const descendants = await fetchDescendants(client, businessId, rootId);
  return descendants.some((d) => d.is_active);
}

export async function createAccount(params: {
  businessId: string;
  code: string;
  name: string;
  type: string;
  parentId?: string | null;
  isContra?: boolean;
  actorId?: string | null;
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
  if (params.isContra !== undefined && typeof params.isContra !== "boolean") {
    throw new AccountsError("bad_request");
  }
  const isContra = params.isContra ?? false;
  const actorId = params.actorId ?? null;
  const parentId = params.parentId ?? null;

  // Hierarchy creation takes the per-business lock so a concurrent reparent
  // cannot move our chosen parent out from under us after we read it. The
  // pre-flight duplicate-code check also runs under the lock; the UNIQUE
  // constraint remains the final authority for code races.
  return inTransaction(async (client) => {
    await lockChartOfAccounts(client, params.businessId);

    // The attachment rules (existence, archived parent, depth, type match) are
    // the shared ones in account-hierarchy.ts; see that file for the order.
    let level: AccountLevel = "group";
    let parentLabel: string | null = null;
    if (parentId) {
      const attached = await resolveAttachableParent(client, params.businessId, parentId, params.type as AccountType);
      level = attached.level;
      parentLabel = attached.parent.code;
    }

    const { rows: existing } = await client.query(
      `SELECT 1 FROM accounts WHERE business_id = $1 AND code = $2`,
      [params.businessId, code],
    );
    if (existing.length > 0) throw new AccountsError("code_in_use", 409);

    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [params.businessId, parentId, code, name, params.type, level, isContra],
      );
      const newId = rows[0].id;
      await recordAccountAudit(client, params.businessId, actorId, "account.created", newId, {
        code,
        name,
        type: params.type,
        parentId,
        parentLabel,
        level,
        isContra,
      });
      return { id: newId };
    } catch (err) {
      if (sqlState(err) === UNIQUE_VIOLATION) throw new AccountsError("code_in_use", 409);
      throw err;
    }
  });
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
 * One account edit — rename and/or reparent and/or archive/restoration and/or
 * contra change — applied as a single transaction, with its audit rows.
 *
 * The route accepts all in one PATCH ("rename while reparenting"), and they
 * used to run as independent statements: a rename that succeeded followed by a
 * move the hierarchy rules rejected left the account renamed, the caller
 * holding an error, and the screen still showing the old name.
 * `updateAccount` applies all requested changes, or none of them.
 *
 * `reparent` is explicit rather than inferred from `parentId !== undefined`,
 * because moving an account to the top level *is* `parentId: null` — the
 * route's own "a present parentId is an instruction" rule, made unambiguous
 * for callers that build the patch from a form.
 *
 * Hierarchy mutations (reparent, archive) take the per-business advisory lock
 * via `lockChartOfAccounts` before any validation, so concurrent writes are
 * serialised rather than racing.
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
  isContra?: boolean;
}): Promise<void> {
  const { businessId, id } = params;
  const actorId = params.actorId ?? null;
  const wantsReparent = params.reparent === true || (params.reparent === undefined && params.parentId !== undefined);
  const parentId = params.parentId ?? null;
  const wantsHierarchyMutation = wantsReparent || params.isActive !== undefined;

  const trimmedName = params.name === undefined ? undefined : params.name.trim();
  if (trimmedName !== undefined && !trimmedName) throw new AccountsError("name_required");

  await inTransaction(async (client) => {
    // Serialize any hierarchy-affecting mutation. Pure renames do not change
    // hierarchy shape and are safe without the lock (they still commit/roll
    // back atomically with their audit row).
    if (wantsHierarchyMutation) {
      await lockChartOfAccounts(client, businessId);
    }

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
      let destType: AccountType | null = null;
      let afterParentLabel: string | null = null;
      if (parentId) {
        if (parentId === id) throw new AccountsError("parent_cycle");
        const parent = await loadAttachableParent(client, businessId, parentId);
        await assertNoCycle(client, businessId, id, parentId);
        newLevel = attachmentLevel(parent, account.type);
        destType = parent.type;
        afterParentLabel = parent.code;
      } else {
        newLevel = "group";
      }

      // Enforce type consistency across the whole moved subtree (issue #824 §2).
      // If any descendant has a different type from the destination branch the
      // move is rejected atomically — no partial reparent.
      if (destType) {
        const subtree = await fetchSubtreeTypes(client, businessId, id);
        for (const node of subtree) {
          if (node.type !== destType) {
            throw new AccountsError("parent_type_mismatch", 409);
          }
        }
      }

      // Look up before-parent label for the audit payload — recorded while the
      // lock is held so it can't change under us.
      let beforeParentLabel: string | null = null;
      if (account.parent_id) {
        const { rows } = await client.query<{ code: string }>(
          `SELECT code FROM accounts WHERE business_id = $1 AND id = $2`,
          [businessId, account.parent_id],
        );
        beforeParentLabel = rows[0]?.code ?? null;
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
        beforeParentLabel,
        afterParentLabel,
      });
    }

    // Determine the effective post-mutation parent for restore validation: if
    // the PATCH also reparents, the new parent is what matters; otherwise we
    // use the existing parent_id.
    let effectiveParentId: string | null = account.parent_id;
    if (wantsReparent && parentId !== account.parent_id) {
      // The reparent block above updates parent_id only if the move was
      // accepted; we don't duplicate the change here — but we still need to
      // compute the effective parent for the restore check below. Compute it
      // from the same input the reparent block will apply.
      effectiveParentId = parentId;
    }

    if (params.isActive !== undefined) {
      const isActive = params.isActive;
      if (!isActive && WELL_KNOWN_CODE_SET.has(account.code)) {
        throw new AccountsError("well_known_account", 409);
      }
      // Archiving: refuse if any active descendant still exists (issue #824
      // §3 + review item 2 — traverses all descendants regardless of their
      // own archive state, so an active grandchild below an archived
      // intermediate is still detected).
      if (!isActive && isActive !== account.is_active) {
        if (await hasActiveDescendant(client, businessId, id)) {
          throw new AccountsError("parent_has_active_children", 409);
        }
      }
      // Restoring: refuse if the effective parent (after any concurrent
      // reparent in the same PATCH) is archived, or if any ancestor in the
      // post-mutation chain is archived (issue #824 review item 1). Without
      // this, a child can be restored under an archived parent/grandparent,
      // recreating an archived-ancestor → active-descendant state the UI
      // cannot represent.
      if (isActive && isActive !== account.is_active) {
        const archivedAncestor = await findArchivedAncestor(client, businessId, id, effectiveParentId);
        if (archivedAncestor) {
          throw new AccountsError("ancestor_archived", 409);
        }
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

    if (params.isContra !== undefined) {
      if (typeof params.isContra !== "boolean") throw new AccountsError("bad_request");
      // Code and type are immutable; isContra is correctable from the canonical
      // COA editor (issue #824 §6) because a mistaken contra flag does not
      // change postings or reclassify the account — it only changes how the
      // balance is presented on reports. System/well-known accounts keep the
      // existing protection: changing their contra semantics would silently
      // misstate figures the auto-posting engine relies on.
      if (WELL_KNOWN_CODE_SET.has(account.code)) {
        throw new AccountsError("well_known_account", 409);
      }
      if (params.isContra !== account.is_contra) {
        await client.query(`UPDATE accounts SET is_contra = $1 WHERE business_id = $2 AND id = $3`, [
          params.isContra,
          businessId,
          id,
        ]);
        await recordAccountAudit(client, businessId, actorId, "account.contra_changed", id, {
          before: account.is_contra,
          after: params.isContra,
        });
      }
    }
  });
}

/**
 * Hard delete — only for an account that was never actually posted to.
 * Otherwise, archive it. Takes the per-business hierarchy lock because
 * removing a node changes parent-child relationships for any future create/
 * reparent that might race it; the audit row is written in the same
 * transaction so it survives after the row is gone (issue #824 §5).
 */
export async function deleteAccount(
  businessId: string,
  id: string,
  actorId: string | null = null,
): Promise<void> {
  await inTransaction(async (client) => {
    await lockChartOfAccounts(client, businessId);

    const account = await findAccount(businessId, id, client);
    if (!account) throw new AccountsError("account_not_found", 404);
    if (WELL_KNOWN_CODE_SET.has(account.code)) throw new AccountsError("well_known_account", 409);

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

    // Snapshot enough fields for the audit row to remain legible after the
    // account itself no longer exists.
    const snapshot = {
      code: account.code,
      name: account.name,
      type: account.type,
      level: account.level,
      isContra: account.is_contra,
    };

    try {
      const { rowCount } = await client.query(`DELETE FROM accounts WHERE business_id = $1 AND id = $2`, [
        businessId,
        id,
      ]);
      if (!rowCount) throw new AccountsError("account_not_found", 404);
      await recordAccountAudit(client, businessId, actorId, "account.deleted", id, snapshot);
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
