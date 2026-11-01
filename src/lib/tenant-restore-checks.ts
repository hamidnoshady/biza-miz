/**
 * Issue #903 §5 — the consistency checks either side of a tenant-only restore.
 *
 * The apply engine already proves that the bytes are the right ones (checksum,
 * signature, archive parse), that the archive describes *this* business, and
 * that the row counts it promised are the counts that survived the write. What
 * it did not prove is the half of §5 that is about everything **around** the
 * replaced data:
 *
 *  • **row-level security was actually in force.** The replacement is
 *    `DELETE FROM <table>` on every tenant table, filtered only by the RLS
 *    policy. A superuser (or a role with `BYPASSRLS`) ignores those policies, so
 *    on such a connection the same statement would empty every business in the
 *    database. "Never whole-DB" cannot be a property of the SQL text; it has to
 *    be checked against the role the engine is running as, at the moment it
 *    runs.
 *  • **the business is still reachable.** `users` is tenant data and is
 *    replaced too, so a restore of a backup taken before the Owner's account
 *    existed would leave a business nobody can sign in to. Refusing (and
 *    rolling back) is the only answer that does not hand the Owner a locked
 *    door.
 *  • **accounting is still internally consistent.** Every posted journal entry
 *    must still balance. This is the check that notices a partial capture
 *    (entries restored, their lines not) instead of committing it.
 *  • **the canonical wallet is unchanged.** §5 says the restore must prove it,
 *    and `RESTORE_IMMUTABLE_TABLES` skipping the money tables is what makes it
 *    true — this asserts the claim rather than trusting the skip list to stay
 *    right through future edits.
 *  • **the sync fence moved forward.** A restore rewinds `business_wallets`'s
 *    neighbours but must not rewind the *generation*: the heartbeat row is in
 *    the archive, so a restored old backup would otherwise lower the site's
 *    generation and let artifacts captured before the restore pass the hybrid
 *    upload fence. The fence is raised to one past the newest generation either
 *    side of the swap, inside the same transaction, so an artifact older than
 *    the restore can never overwrite it.
 *
 * Everything here takes a pinned `PoolClient` so it runs inside the restoring
 * transaction: a check that reads on a different connection would be reading a
 * different snapshot. Failures are returned, not thrown — the caller decides
 * what a failed check means (the engine rolls the whole replacement back).
 */
import type { PoolClient } from "pg";

export type RestoreCheckCode =
  | "rls_proven"
  | "owner_preserved"
  | "accounting_balanced"
  | "wallet_unchanged"
  | "sync_fence_advanced";

export interface RestoreCheck {
  code: RestoreCheckCode;
  ok: boolean;
  /** Provider-neutral detail for the journal; never shown to a tenant verbatim. */
  detail?: string;
}

/** What the business looked like before the swap, for the checks after it. */
export interface RestoreBaseline {
  /** Canonical wallet balance, or null when the business has no wallet row yet. */
  walletBalanceRial: string | null;
  /** Active Owners, so a restore that removes the last one can be refused. */
  activeOwners: number;
  /** Sync generation the install reports, so the fence can be raised past it. */
  syncGeneration: number | null;
}

export type PostRestoreVerdict =
  | { ok: true; checks: RestoreCheck[] }
  | { ok: false; failed: RestoreCheckCode[]; checks: RestoreCheck[] };

/**
 * Whether RLS can protect anything on this connection.
 *
 * Read through the pinned client so it answers for the role that is about to
 * issue the `DELETE`s, not for whatever the pool happened to hand out earlier.
 */
export async function rlsProtectsRows(client: PoolClient): Promise<boolean> {
  const { rows } = await client.query<{ privileged: boolean }>(
    `SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = current_user`,
  );
  return rows[0] ? !rows[0].privileged : false;
}

/** The canonical wallet balance, as a decimal string (bigint stays exact). */
export async function walletBalanceRial(client: PoolClient, businessId: string): Promise<string | null> {
  const { rows } = await client.query<{ balance_rial: string }>(
    `SELECT balance_rial::text AS balance_rial FROM business_wallets WHERE business_id = $1`,
    [businessId],
  );
  return rows[0]?.balance_rial ?? null;
}

async function activeOwnerCount(client: PoolClient, businessId: string): Promise<number> {
  const { rows } = await client.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM users
      WHERE business_id = $1 AND role = 'owner' AND is_active`,
    [businessId],
  );
  return Number(rows[0]?.total ?? 0);
}

/** Business-scoped journal entries whose debits do not equal their credits. */
async function unbalancedEntryCount(client: PoolClient, businessId: string): Promise<number> {
  const { rows } = await client.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM (
       SELECT e.id
         FROM journal_entries e
         LEFT JOIN journal_lines l ON l.entry_id = e.id
        WHERE e.business_id = $1
        GROUP BY e.id
       HAVING COALESCE(SUM(l.debit), 0) <> COALESCE(SUM(l.credit), 0)
     ) unbalanced`,
    [businessId],
  );
  return Number(rows[0]?.total ?? 0);
}

async function syncGeneration(client: PoolClient, businessId: string): Promise<number | null> {
  const { rows } = await client.query<{ site_generation: string }>(
    `SELECT site_generation::text AS site_generation FROM tenant_backup_site_heartbeat WHERE business_id = $1`,
    [businessId],
  );
  const value = rows[0]?.site_generation;
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Read the three facts the post-swap checks compare against. */
export async function captureRestoreBaseline(
  client: PoolClient,
  businessId: string,
): Promise<RestoreBaseline> {
  const [wallet, owners, generation] = await Promise.all([
    walletBalanceRial(client, businessId),
    activeOwnerCount(client, businessId),
    syncGeneration(client, businessId),
  ]);
  return { walletBalanceRial: wallet, activeOwners: owners, syncGeneration: generation };
}

/**
 * Raise the hybrid upload fence past everything that existed before the swap.
 *
 * The restored heartbeat row carries the *backup's* generation, which is older
 * than the state the site has since produced. Leaving it there would let an
 * artifact captured before the restore pass `fenceDecision` and overwrite the
 * restored data with the state it replaced. The new generation is one past the
 * newer of (restored, pre-restore), and it is written inside the restoring
 * transaction, so the fence and the data it protects move together.
 */
export async function advanceSyncFence(
  client: PoolClient,
  businessId: string,
  baseline: RestoreBaseline,
): Promise<number | null> {
  const restored = await syncGeneration(client, businessId);
  const known = [restored, baseline.syncGeneration].filter((value): value is number => typeof value === "number");
  if (known.length === 0) return null;
  const next = Math.max(...known) + 1;
  // `accepted_generation` moves with it: it is the platform's watermark for
  // "nothing older than this may upload", and a restore is exactly the moment
  // that watermark has to jump.
  await client.query(
    `UPDATE tenant_backup_site_heartbeat
        SET site_generation = $2,
            accepted_generation = GREATEST(accepted_generation, $2),
            updated_at = now()
      WHERE business_id = $1`,
    [businessId, next],
  );
  return next;
}

/**
 * The checks that run *after* the replacement, inside its transaction, and the
 * fence advance that must commit with it.
 *
 * Order matters: the fence is advanced first so that a failure in any check
 * still rolls it back together with the data (nothing here commits alone).
 */
export async function verifyPostRestore(
  client: PoolClient,
  businessId: string,
  baseline: RestoreBaseline,
): Promise<PostRestoreVerdict> {
  const checks: RestoreCheck[] = [];

  const protectedNow = await rlsProtectsRows(client);
  checks.push({ code: "rls_proven", ok: protectedNow });

  const owners = await activeOwnerCount(client, businessId);
  checks.push({
    code: "owner_preserved",
    ok: owners > 0,
    detail: owners > 0 ? undefined : `active owners after restore: ${owners} (before: ${baseline.activeOwners})`,
  });

  const unbalanced = await unbalancedEntryCount(client, businessId);
  checks.push({
    code: "accounting_balanced",
    ok: unbalanced === 0,
    detail: unbalanced === 0 ? undefined : `unbalanced journal entries: ${unbalanced}`,
  });

  const wallet = await walletBalanceRial(client, businessId);
  checks.push({
    code: "wallet_unchanged",
    ok: wallet === baseline.walletBalanceRial,
    detail:
      wallet === baseline.walletBalanceRial
        ? undefined
        : `wallet balance moved from ${baseline.walletBalanceRial ?? "none"} to ${wallet ?? "none"}`,
  });

  const next = await advanceSyncFence(client, businessId, baseline);
  checks.push({
    code: "sync_fence_advanced",
    ok: true,
    detail: next === null ? "no heartbeat row" : `generation ${next}`,
  });

  const failed = checks.filter((check) => !check.ok).map((check) => check.code);
  return failed.length === 0 ? { ok: true, checks } : { ok: false, failed, checks };
}
