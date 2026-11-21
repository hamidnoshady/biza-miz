/**
 * ESH-199 / #1384 — the global person's email, and the proof of control of it.
 *
 * Migration 0303 makes `platform_users.email` nullable and adds
 * `platform_email_verifications`. This module is the only writer of that table
 * and of `platform_users.email_verified_at`. The rules it encodes:
 *
 *  - **Only a hash is stored.** The delivered token is 32 random bytes; the row
 *    holds its SHA-256, so a dump of this table cannot be replayed as a link.
 *  - **One live token per identity.** Issuing a new token consumes every older
 *    one *before* inserting, so the partial unique index can never be the thing
 *    that tells a caller an old link was still valid.
 *  - **The proof is bound to the address it was issued for.** Consumption is a
 *    single UPDATE joining the verification row to the identity on
 *    `p.email = v.email`; if the address changed in between, nothing is
 *    consumed and nothing is stamped. A person who lost an address therefore
 *    cannot inherit its verification.
 *  - **Consumption is atomic.** Two deliveries of the same link both reach the
 *    UPDATE; the second matches no row (the first set `consumed_at`), so a
 *    mail scanner following the link does not spend it twice.
 *
 * Everything here runs under the reviewed `identity` bypass: the table is
 * global (it has no `business_id` to scope by), and the only rows touched are
 * the ones a membership or the person themselves already had a right to.
 */
import { createHash, randomBytes } from "node:crypto";
import { query, withoutTenantScope, withoutTenantScopeTransaction } from "../db";

const TOKEN_TTL_MINUTES = 24 * 60;

export type IssueEmailVerificationResult =
  | { ok: true; token: string; expiresAt: string; email: string }
  | { ok: false; error: "identity_missing" | "email_missing" };

/**
 * Mint a proof for the identity's current email address.
 *
 * The caller is responsible for delivery (and for not logging the token); this
 * function only records it. `actorBusinessId` is the door the request came
 * through, if any, and is recorded on the audit row.
 */
export async function issueEmailVerification(input: {
  platformUserId: string;
  actorBusinessId?: string | null;
  actorPlatformUserId?: string | null;
  now?: Date;
  ttlMinutes?: number;
}): Promise<IssueEmailVerificationResult> {
  const now = input.now ?? new Date();
  const ttl = input.ttlMinutes ?? TOKEN_TTL_MINUTES;
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashEmailVerificationToken(token);

  return withoutTenantScopeTransaction("identity", async () => {
    // Lock the identity so two concurrent issues serialise: otherwise both
    // could invalidate the old token and then race the live-token index.
    const { rows } = await query<{ email: string | null }>(
      `SELECT email::text AS email FROM platform_users WHERE id = $1 FOR UPDATE`,
      [input.platformUserId],
    );
    const identity = rows[0];
    if (!identity) return { ok: false as const, error: "identity_missing" as const };
    if (!identity.email) return { ok: false as const, error: "email_missing" as const };

    await query(
      `UPDATE platform_email_verifications
          SET consumed_at = now()
        WHERE platform_user_id = $1
          AND consumed_at IS NULL`,
      [input.platformUserId],
    );

    const expiresAt = new Date(now.getTime() + ttl * 60_000);
    await query(
      `INSERT INTO platform_email_verifications
         (platform_user_id, email, token_hash, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.platformUserId, identity.email, tokenHash, now.toISOString(), expiresAt.toISOString()],
    );

    await recordIdentityEvent({
      platformUserId: input.platformUserId,
      action: "email_verification_issued",
      actorPlatformUserId: input.actorPlatformUserId ?? null,
      actorBusinessId: input.actorBusinessId ?? null,
    });

    return {
      ok: true as const,
      token,
      expiresAt: expiresAt.toISOString(),
      email: identity.email,
    };
  });
}

export type ConsumeEmailVerificationResult =
  | { ok: true; platformUserId: string; email: string }
  | { ok: false; error: "invalid_token" | "email_changed" };

/**
 * Spend a delivered token and stamp the identity's email as verified.
 *
 * `invalid_token` covers malformed, unknown, already-spent and expired tokens
 * alike — distinguishing them would tell an unauthenticated caller whether a
 * guessed link once existed.
 */
export async function consumeEmailVerification(
  token: string,
  options: { now?: Date } = {},
): Promise<ConsumeEmailVerificationResult> {
  const now = options.now ?? new Date();
  if (!token || token.length > 256) return { ok: false, error: "invalid_token" };

  return withoutTenantScopeTransaction("identity", async () => {
    const { rows } = await query<{ platform_user_id: string; email: string }>(
      `UPDATE platform_email_verifications v
          SET consumed_at = now()
         FROM platform_users p
        WHERE v.token_hash = $1
          AND v.consumed_at IS NULL
          AND v.expires_at > $2
          AND p.id = v.platform_user_id
          AND p.email = v.email
      RETURNING v.platform_user_id, v.email::text AS email`,
      [hashEmailVerificationToken(token), now.toISOString()],
    );
    const consumed = rows[0];
    if (!consumed) {
      // Tokens are single-use and rotate on issue, so a row that exists but
      // did not match means the address changed since issue.
      const { rows: known } = await query<{ changed: boolean }>(
        `SELECT (p.email IS DISTINCT FROM v.email) AS changed
           FROM platform_email_verifications v
           JOIN platform_users p ON p.id = v.platform_user_id
          WHERE v.token_hash = $1
          LIMIT 1`,
        [hashEmailVerificationToken(token)],
      );
      return known[0]?.changed
        ? { ok: false as const, error: "email_changed" as const }
        : { ok: false as const, error: "invalid_token" as const };
    }

    await query(
      `UPDATE platform_users
          SET email_verified_at = now(),
              updated_at        = now()
        WHERE id = $1`,
      [consumed.platform_user_id],
    );
    await recordIdentityEvent({
      platformUserId: consumed.platform_user_id,
      action: "email_verified",
    });

    return { ok: true as const, platformUserId: consumed.platform_user_id, email: consumed.email };
  });
}

/**
 * Set (or replace) the identity's optional email address.
 *
 * The address is stored **unverified**: a non-null `email_verified_at` is a
 * claim nobody has proved yet, and migration 0305's trigger clears an existing
 * stamp the moment the address changes, so a new address cannot inherit the old
 * one's proof. Sensitive notification and recovery must therefore ask
 * `hasVerifiedEmail`, never merely "is there an email".
 *
 * Uniqueness is the same global constraint `platform_users.email` already
 * carries; a collision is reported as `email_taken` rather than as a raw
 * database error, because the caller is a person filling in their own profile
 * and needs an actionable answer.
 */
export async function setIdentityEmail(input: {
  platformUserId: string;
  email: string;
}): Promise<
  | { ok: true; email: string }
  | { ok: false; error: "invalid_email" | "identity_missing" | "email_taken" }
> {
  const email = input.email.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "invalid_email" };
  }
  try {
    const { rows } = await withoutTenantScope("identity", () =>
      query<{ email: string }>(
        `UPDATE platform_users
            SET email = $2,
                updated_at = now()
          WHERE id = $1
          RETURNING email::text AS email`,
        [input.platformUserId, email],
      ),
    );
    if (!rows[0]) return { ok: false, error: "identity_missing" };
    return { ok: true, email: rows[0].email };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "23505"
    ) {
      return { ok: false, error: "email_taken" };
    }
    throw error;
  }
}

/** The stored form of a delivered token. Never the token itself. */
export function hashEmailVerificationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Whether an identity has a *verified* email, read through the same contract
 * billing uses. Verification requires the stamp as well as the address.
 */
export async function hasVerifiedEmail(platformUserId: string): Promise<boolean> {
  const { rows } = await withoutTenantScope("identity", () =>
    query<{ email_verified: boolean }>(
      `SELECT (email IS NOT NULL AND email_verified_at IS NOT NULL) AS email_verified
         FROM platform_users
        WHERE id = $1`,
      [platformUserId],
    ),
  );
  return rows[0]?.email_verified === true;
}

async function recordIdentityEvent(event: {
  platformUserId: string;
  action: "email_verification_issued" | "email_verified";
  actorPlatformUserId?: string | null;
  actorBusinessId?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO platform_identity_events
       (platform_user_id, action, actor_platform_user_id, actor_business_id)
     VALUES ($1, $2, $3, $4)`,
    [
      event.platformUserId,
      event.action,
      event.actorPlatformUserId ?? null,
      event.actorBusinessId ?? null,
    ],
  );
}
