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

export type SetIdentityEmailResult =
  | { ok: true; email: string | null; changed: boolean }
  | { ok: false; error: "identity_missing" | "forbidden" | "invalid_email" | "email_taken" };

/**
 * The canonical form of an address typed by the person, or null when the value
 * cannot be an address at all. Lower-cased because `platform_users.email` is
 * `citext`; the same rule every login/provisioning door already uses is kept
 * here so the optional profile step cannot introduce a looser one.
 */
export function normalizeIdentityEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/**
 * Set or clear the global identity's email from the person's own session.
 *
 * The address is not a credential by itself: changing it clears
 * `email_verified_at` (the 0305 trigger) and consumes any live proof, so a new
 * address can never inherit the old one's verification. A non-null actor must
 * be the subject — a business administrator cannot change another person's
 * recovery address.
 */
export async function setIdentityEmail(input: {
  platformUserId: string;
  email: string | null | undefined;
  actorPlatformUserId: string;
  actorBusinessId?: string | null;
}): Promise<SetIdentityEmailResult> {
  if (input.actorPlatformUserId !== input.platformUserId) {
    return { ok: false, error: "forbidden" };
  }
  const clearing = input.email === null || input.email === undefined || input.email === "";
  const email = clearing ? null : normalizeIdentityEmail(input.email);
  if (!clearing && !email) return { ok: false, error: "invalid_email" };

  try {
    return await withoutTenantScopeTransaction("identity", async () => {
      const { rows } = await query<{ email: string | null }>(
        `SELECT email::text AS email FROM platform_users WHERE id = $1 FOR UPDATE`,
        [input.platformUserId],
      );
      const identity = rows[0];
      if (!identity) return { ok: false as const, error: "identity_missing" as const };

      const current = identity.email ? identity.email.toLowerCase() : null;
      if (current === email) return { ok: true as const, email, changed: false };

      if (email) {
        await query(
          `UPDATE platform_users
              SET email = $2, updated_at = now()
            WHERE id = $1`,
          [input.platformUserId, email],
        );
        await recordIdentityEvent({
          platformUserId: input.platformUserId,
          action: "email_changed",
          actorPlatformUserId: input.actorPlatformUserId,
          actorBusinessId: input.actorBusinessId ?? null,
        });
      } else {
        await query(
          `UPDATE platform_users
              SET email = NULL, updated_at = now()
            WHERE id = $1`,
          [input.platformUserId],
        );
        await recordIdentityEvent({
          platformUserId: input.platformUserId,
          action: "email_cleared",
          actorPlatformUserId: input.actorPlatformUserId,
          actorBusinessId: input.actorBusinessId ?? null,
        });
      }

      return { ok: true as const, email, changed: true };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, error: "email_taken" };
    throw error;
  }
}

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
  action:
    | "email_verification_issued"
    | "email_verified"
    | "email_changed"
    | "email_cleared";
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

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}
