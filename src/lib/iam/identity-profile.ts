/**
 * ESH-199 / #1384 — the optional national ID on the global person.
 *
 * The national ID is the most identifying value the platform can hold about a
 * person, so it is treated differently from every other profile field:
 *
 *  - **Never plaintext.** The value is stored as an AES-256-GCM envelope under
 *    the install's field-encryption master key (`platform_users.national_id_
 *    ciphertext`, migration 0303). There is no plaintext column, not even
 *    during a transition window, because nothing here predates the column.
 *  - **Duplicate detection without decryption.** A domain-separated
 *    HMAC-SHA-256 blind index (`national_id_bidx`) carries a partial unique
 *    index, so two identities cannot claim one number. The key never leaves the
 *    process and the index cannot be reversed without it.
 *  - **Self-service only for writes.** A person sets or clears their own
 *    number. A business administrator can never write another person's national
 *    ID, the same rule that makes the verified phone write-once from a business
 *    door.
 *  - **Every write and privileged read is audited.** `platform_identity_events`
 *    records the subject, the actor, the business door and the action — never
 *    the value.
 *
 * Encryption is refused, not degraded, when no master key is configured: a
 * deployment that cannot encrypt must not silently store a national ID in the
 * clear, so the service answers `encryption_unavailable` and writes nothing.
 */
import { createHmac } from "node:crypto";
import { query, withoutTenantScope, withoutTenantScopeTransaction } from "../db";
import { decryptSecret, encryptSecret } from "../integrations/secrets";
import { getMasterKey } from "../master-key";
import { asciiDigits, isValidIranianNationalId } from "../parties";

export type NationalIdRefusal =
  | "invalid_national_id"
  | "forbidden"
  | "identity_missing"
  | "national_id_taken"
  | "encryption_unavailable";

/**
 * Canonical ten ASCII digits, or null.
 *
 * Persian and Arabic-Indic digits are accepted on input (people type them) and
 * normalised, then the check digit is validated by the same function the party
 * file uses, so a typo never becomes a plausible identity.
 */
export function normalizeNationalId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const digits = asciiDigits(String(value).trim());
  if (!isValidIranianNationalId(digits)) return null;
  return digits;
}

export type SetNationalIdResult =
  | { ok: true }
  | { ok: false; error: NationalIdRefusal };

/**
 * Store the person's national ID.
 *
 * The actor must be the subject: there is no path by which one person writes
 * another's identity number, not even a platform administrator (an
 * administrator needing a correction has the audited `clear` + the person's own
 * re-entry, not an impersonated write).
 */
export async function setNationalId(input: {
  platformUserId: string;
  nationalId: string;
  actorPlatformUserId: string;
  actorBusinessId?: string | null;
}): Promise<SetNationalIdResult> {
  if (input.actorPlatformUserId !== input.platformUserId) {
    return { ok: false, error: "forbidden" };
  }
  const digits = normalizeNationalId(input.nationalId);
  if (!digits) return { ok: false, error: "invalid_national_id" };

  const key = getMasterKey();
  if (!key) return { ok: false, error: "encryption_unavailable" };
  const ciphertext = encryptSecret(digits, key);
  const blindIndex = nationalIdBlindIndex(digits, key);

  try {
    return await withoutTenantScopeTransaction("identity", async () => {
      const { rows } = await query<{ id: string }>(
        `UPDATE platform_users
            SET national_id_ciphertext = $2,
                national_id_bidx       = $3,
                updated_at             = now()
          WHERE id = $1
          RETURNING id`,
        [input.platformUserId, ciphertext, blindIndex],
      );
      if (!rows[0]) return { ok: false as const, error: "identity_missing" as const };

      await recordIdentityEvent({
        platformUserId: input.platformUserId,
        action: "national_id_set",
        actorPlatformUserId: input.actorPlatformUserId,
        actorBusinessId: input.actorBusinessId ?? null,
      });
      return { ok: true as const };
    });
  } catch (error) {
    // The blind-index unique index is the authority on uniqueness; a
    // read-then-write pre-check would race exactly the way the phone claim's
    // would.
    if (isUniqueViolation(error)) return { ok: false, error: "national_id_taken" };
    throw error;
  }
}

/** Forget the person's national ID, ciphertext and blind index together. */
export async function clearNationalId(input: {
  platformUserId: string;
  actorPlatformUserId: string;
  actorBusinessId?: string | null;
}): Promise<{ ok: true } | { ok: false; error: "forbidden" | "identity_missing" }> {
  if (input.actorPlatformUserId !== input.platformUserId) {
    return { ok: false, error: "forbidden" };
  }

  return withoutTenantScopeTransaction("identity", async () => {
    const { rows } = await query<{ id: string }>(
      `UPDATE platform_users
          SET national_id_ciphertext = NULL,
              national_id_bidx       = NULL,
              updated_at             = now()
        WHERE id = $1
        RETURNING id`,
      [input.platformUserId],
    );
    if (!rows[0]) return { ok: false as const, error: "identity_missing" as const };

    await recordIdentityEvent({
      platformUserId: input.platformUserId,
      action: "national_id_cleared",
      actorPlatformUserId: input.actorPlatformUserId,
      actorBusinessId: input.actorBusinessId ?? null,
    });
    return { ok: true as const };
  });
}

export type ReadNationalIdResult =
  | { ok: true; nationalId: string | null }
  | { ok: false; error: "forbidden" | "identity_missing" | "encryption_unavailable" };

/**
 * Read the person's national ID.
 *
 * Allowed for the person themselves and for the platform-admin realm (support
 * and compliance), and for nobody else — a business never learns the national
 * ID of its owner, let alone of a member. The read is audited so support access
 * is visible to the subject.
 */
export async function readNationalId(input: {
  platformUserId: string;
  actorPlatformUserId?: string | null;
  actorPlatformAdminId?: string | null;
  actorBusinessId?: string | null;
}): Promise<ReadNationalIdResult> {
  const self = input.actorPlatformUserId === input.platformUserId;
  if (!self && !input.actorPlatformAdminId) return { ok: false, error: "forbidden" };

  return withoutTenantScopeTransaction("identity", async () => {
    const { rows } = await query<{ national_id_ciphertext: string | null }>(
      `SELECT national_id_ciphertext FROM platform_users WHERE id = $1`,
      [input.platformUserId],
    );
    const row = rows[0];
    if (!row) return { ok: false as const, error: "identity_missing" as const };
    if (!row.national_id_ciphertext) return { ok: true as const, nationalId: null };

    const key = getMasterKey();
    if (!key) return { ok: false as const, error: "encryption_unavailable" as const };

    let nationalId: string;
    try {
      nationalId = decryptSecret(row.national_id_ciphertext, key);
    } catch {
      // Fail closed without echoing ciphertext, IV, tag or key material.
      return { ok: false as const, error: "encryption_unavailable" as const };
    }

    await recordIdentityEvent({
      platformUserId: input.platformUserId,
      action: "national_id_read",
      /** NULL when a platform admin read it; the admin id below names them. */
      actorPlatformUserId: self ? input.platformUserId : null,
      actorPlatformAdminId: self ? null : (input.actorPlatformAdminId ?? null),
      actorBusinessId: input.actorBusinessId ?? null,
    });
    return { ok: true as const, nationalId };
  });
}

/**
 * Whether the identity has a national ID, without decrypting it.
 *
 * The commercial audit trail needs the fact ("this person is identified") far
 * more often than the value, and this is the cheap read for it.
 */
export async function hasNationalId(platformUserId: string): Promise<boolean> {
  const { rows } = await withoutTenantScope("identity", () =>
    query<{ identified: boolean }>(
      `SELECT (national_id_bidx IS NOT NULL) AS identified
         FROM platform_users WHERE id = $1`,
      [platformUserId],
    ),
  );
  return rows[0]?.identified === true;
}

export function nationalIdBlindIndex(digits: string, key: Buffer): string {
  return createHmac("sha256", key).update(`platform_users.national_id:${digits}`).digest("hex");
}

async function recordIdentityEvent(event: {
  platformUserId: string;
  action: "national_id_set" | "national_id_cleared" | "national_id_read";
  actorPlatformUserId?: string | null;
  /**
   * The platform-admin realm is its own table, so the person column cannot
   * name an administrative reader. Migration 0311 adds this actor.
   */
  actorPlatformAdminId?: string | null;
  actorBusinessId?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO platform_identity_events
       (platform_user_id, action, actor_platform_user_id, actor_platform_admin_id, actor_business_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      event.platformUserId,
      event.action,
      event.actorPlatformUserId ?? null,
      event.actorPlatformAdminId ?? null,
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
