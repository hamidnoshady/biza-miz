/**
 * Issue #854 (GAP 7) — one locking protocol for everything that decides whether
 * a member has a way in.
 *
 * `assertRoleTransitionKeepsLoginPath` already ran inside the caller's
 * transaction, and the comment on it claimed that made it safe: "a credential
 * revoked between the check and the commit cannot slip past". That is only true
 * if the revoker and the checker cannot run at the same time, and nothing made
 * them take turns. The check is a plain read of `users`, `platform_users` and
 * `employee_credentials`; the writers — PIN rotation, cloud PIN replication,
 * identity suspension, offboarding — each took their own row lock (or none) on
 * their own connection. Postgres gave every one of them a consistent snapshot of
 * *their own* transaction and no more, so this interleaving was legal:
 *
 *   1. T1 (role change manager → cashier) reads `employee_credentials`, sees an
 *      active PIN, decides the transition keeps the login path, and moves on to
 *      update `users`.
 *   2. T2 (`applyReplicatedPins` applying a cloud removal) revokes that PIN.
 *   3. Both commit.
 *
 * Result: an active cashier whose door does not exist — precisely the state the
 * check was added to prevent, arrived at from the other side. The same shape
 * covers the password half (`platform_users.password_hash` cleared or the
 * identity suspended by replication) and offboarding racing reactivation.
 *
 * The protocol is an **advisory transaction lock keyed by the membership**, taken
 * as the first statement of any transaction that can change that membership's
 * door:
 *
 *   - the decision itself (`updateMembership`, `removeMembership`);
 *   - credential writes (`setMembershipPin`, `applyReplicatedPins`);
 *   - identity/credential replication (`applyLoginCredentials`, `iam/sync.ts`);
 *   - offboarding, suspension and reactivation, which are the same rows.
 *
 * Advisory locks are deliberately *not* row locks here. A row lock would have to
 * be `FOR UPDATE` on `users`, which the role-transition path already writes later
 * in the same transaction — so it would work — but credential replication
 * touches memberships whose `users` row it may not write at all, and taking a
 * row lock on rows a code path only reads is the sort of thing that turns into a
 * deadlock the day somebody reorders the reads. `pg_advisory_xact_lock` is
 * explicit about intent, released automatically at COMMIT/ROLLBACK, and — because
 * it is taken from the *same pool client* — it belongs to the same transaction
 * the invariant must hold across.
 *
 * Two calling rules, both mechanical:
 *
 *  1. **Take it first.** Before reading the state it protects, never after. A
 *     lock acquired after the read protects nothing.
 *  2. **Take them in a stable order.** `lockMemberships` sorts and dedupes, so a
 *     replica applying ten memberships cannot deadlock against another applying
 *     the same ten in a different order.
 */

/** The minimum this module needs from a connection — a pool client, or anything shaped like one. */
export interface LockExecutor {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

/**
 * Serialize every decision about one membership.
 *
 * Keyed on `(businessId, userId)`: the pair is the actual unit of the invariant
 * (a person may hold memberships in several businesses, and a role in one says
 * nothing about access in another), and it is stable across the paths that need
 * it, none of which know the other's identifiers.
 */
export async function lockMembership(
  client: LockExecutor,
  businessId: string,
  userId: string,
): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
    `biza:membership:${businessId}`,
    userId,
  ]);
}

/**
 * Lock several memberships, in a stable order.
 *
 * Replication applies whole batches. Sorting here rather than at each call site
 * is what keeps two concurrent batches from each holding half of what the other
 * wants: with a consistent order there is no cycle to deadlock on.
 */
export async function lockMemberships(
  client: LockExecutor,
  businessId: string,
  userIds: readonly string[],
): Promise<void> {
  const ordered = Array.from(new Set(userIds)).sort();
  for (const userId of ordered) {
    await lockMembership(client, businessId, userId);
  }
}

/**
 * Serialize changes to the global identity behind a membership.
 *
 * The password door and the identity's active flag live on `platform_users`, and
 * an identity is shared: two memberships in two businesses point at one row. A
 * lock keyed by membership would let two business-scoped paths race on the same
 * identity, so the second namespace exists. `lockMembership` → `lockIdentity` is
 * the only order that call sites use, and no path takes them the other way
 * round.
 */
export async function lockPlatformIdentity(
  client: LockExecutor,
  platformUserId: string,
): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
    "biza:identity",
    platformUserId,
  ]);
}
