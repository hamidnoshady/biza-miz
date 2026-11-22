/**
 * ESH-199 / #1384 — the global person's verified phone, as a service.
 *
 * The schema (migration 0302) puts `phone_e164` and `phone_verified_at` on
 * `platform_users`; this module is the only writer of those two columns. Three
 * rules make it safe to run beside the membership-level phone the product has
 * used until now:
 *
 *  - **It never invents a number.** `preparePhoneClaim` normalises through
 *    `src/lib/phone.ts` and accepts only a mobile. A landline can be verified as
 *    a fact about a person, but it can never satisfy the commercial purchase
 *    precondition, so it is refused here where the stamp is written rather than
 *    blamed later at checkout.
 *  - **It never leaves a stale verification.** A successful claim writes the
 *    value and its stamp in the same UPDATE; clearing writes both to NULL. A
 *    change therefore cannot leave an old `phone_verified_at` next to a new
 *    number.
 *  - **It lets the index decide the race.** Two concurrent claims of one number
 *    both reach the UPDATE and the partial unique index
 *    (`idx_platform_users_verified_phone`) rejects the loser with SQLSTATE
 *    23505, which is translated to `phone_taken`. No pre-check-then-write
 *    window exists, so a read that says "free" is never trusted.
 *
 * Callers are the verified doors: the phone-OTP flow after the challenge has
 * passed, and identity self-service after proving the current number. The
 * `withoutTenantScope("identity")` bypass is the reviewed one for a narrow
 * `platform_users` write on behalf of an already-verified membership; this
 * module touches no other table and runs no tenant query inside that window.
 */
import {
  readIdentityAssurance,
  type IdentityAssurance,
  type IdentityAssuranceRow,
} from "../identity-billing-contract";
import { query, withoutTenantScope } from "../db";
import { normalizePhone } from "../phone";

/** Why a typed number could not become a claim, before any database work. */
export type PhoneClaimRefusal = "invalid_phone" | "not_mobile";

export type PreparedPhoneClaim =
  | { ok: true; phoneE164: string }
  | { ok: false; error: PhoneClaimRefusal };

/**
 * Validate and canonicalise a number for the global identity.
 *
 * Pure, so the doors can refuse before opening a transaction and the rule is
 * unit-tested without a database.
 */
export function preparePhoneClaim(input: string | null | undefined): PreparedPhoneClaim {
  if (!input || !String(input).trim()) return { ok: false, error: "invalid_phone" };
  const normalised = normalizePhone(input);
  if (!normalised.e164) return { ok: false, error: "invalid_phone" };
  if (normalised.kind !== "mobile") return { ok: false, error: "not_mobile" };
  return { ok: true, phoneE164: normalised.e164 };
}

export type PhoneClaimResult =
  | { ok: true; phoneE164: string }
  | {
      ok: false;
      error: PhoneClaimRefusal | "phone_taken" | "identity_missing" | "identity_phone_locked";
    };

export type CreateVerifiedIdentityResult =
  | { ok: true; platformUserId: string; created: boolean }
  | { ok: false; error: "invalid_name" | PhoneClaimRefusal | "identity_conflict" };

/**
 * Create the one canonical personal identity for a number its owner just
 * proved, or read back the identity that won a concurrent race.
 *
 * This is the only creation door for a phone-first person. It deliberately
 * writes no business, membership, wallet or subscription: a verified person can
 * exist before they own a business (#1384), and #1385's signup must not
 * provision one as a side effect of proving a number.
 *
 * The insert is a single statement so the partial unique index
 * (`idx_platform_users_verified_phone`) is the authority on ownership. If a
 * concurrent redemption won, `ON CONFLICT DO NOTHING` returns no row and the
 * winner is read back by the same verified-phone predicate; two identities can
 * never both result from one number.
 *
 * Callers that need this atomic with an OTP redemption should invoke it inside
 * their `withoutTenantScopeTransaction`; ambient `query` then pins it to that
 * transaction and a later failure rolls the identity back with the challenge.
 */
export async function createVerifiedPersonalIdentity(input: {
  fullName: string;
  phone: string | null | undefined;
}): Promise<CreateVerifiedIdentityResult> {
  const fullName = String(input.fullName ?? "").trim();
  if (!fullName || fullName.length > 200) {
    return { ok: false, error: "invalid_name" };
  }

  const prepared = preparePhoneClaim(input.phone);
  if (!prepared.ok) return prepared;

  try {
    const { rows } = await withoutTenantScope("identity", () =>
      query<{ id: string }>(
        `INSERT INTO platform_users (email, password_hash, full_name, phone_e164, phone_verified_at)
         VALUES (NULL, NULL, $1, $2, now())
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [fullName, prepared.phoneE164],
      ),
    );
    if (rows[0]) return { ok: true, platformUserId: rows[0].id, created: true };

    const { rows: winners } = await withoutTenantScope("identity", () =>
      query<{ id: string }>(
        `SELECT id FROM platform_users
          WHERE phone_e164 = $1 AND phone_verified_at IS NOT NULL
          LIMIT 2`,
        [prepared.phoneE164],
      ),
    );
    if (winners.length === 1) {
      return { ok: true, platformUserId: winners[0].id, created: false };
    }
    return { ok: false, error: "identity_conflict" };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The index rejected the write between the INSERT and the read below.
      const { rows } = await withoutTenantScope("identity", () =>
        query<{ id: string }>(
          `SELECT id FROM platform_users
            WHERE phone_e164 = $1 AND phone_verified_at IS NOT NULL
            LIMIT 2`,
          [prepared.phoneE164],
        ),
      );
      return rows.length === 1
        ? { ok: true, platformUserId: rows[0].id, created: false }
        : { ok: false, error: "identity_conflict" };
    }
    throw error;
  }
}

/**
 * Record a number as verified for this global person.
 *
 * The value is stored in its canonical E.164 form, never as typed, so the
 * uniqueness index compares the same string every door produces.
 *
 * **The person's verified number is write-once from a business door.** Once an
 * identity holds a verified number, a *different* number is refused with
 * `identity_phone_locked` — even when the caller proved control of it — and the
 * existing number is untouched. The reason is the recovery channel: a business
 * administrator can change a membership's phone to a number they control and
 * pass its OTP, and if that overwrote the global identity the employer would
 * own the person's password-reset channel. Replacing the identity's number is
 * the person's own act (identity self-service, proving the current number
 * first), not a side effect of working at another business.
 *
 * Re-claiming the *same* number is idempotent, so a member who signs in at a
 * second business with the phone already on their identity is not refused and
 * the stamp is simply renewed. A value with no stamp (never produced today, but
 * possible after a manual repair) may be replaced: it proves nothing yet.
 *
 * The condition lives in the UPDATE's WHERE clause rather than a read-then-write
 * check, so two doors in two businesses cannot interleave between deciding and
 * writing.
 */
export async function claimVerifiedPhone(options: {
  platformUserId: string;
  phone: string | null | undefined;
}): Promise<PhoneClaimResult> {
  const prepared = preparePhoneClaim(options.phone);
  if (!prepared.ok) return prepared;

  try {
    const { rows } = await withoutTenantScope("identity", () =>
      query<{ phone_e164: string }>(
        `UPDATE platform_users
            SET phone_e164        = $2,
                phone_verified_at = now(),
                updated_at        = now()
          WHERE id = $1
            AND (phone_e164 IS NULL
                 OR phone_verified_at IS NULL
                 OR phone_e164 = $2)
          RETURNING phone_e164`,
        [options.platformUserId, prepared.phoneE164],
      ),
    );
    const claimed = rows[0];
    if (claimed) return { ok: true, phoneE164: claimed.phone_e164 };

    // Nothing was updated. Either the identity is gone, or it already holds a
    // *different* verified number and this door may not rotate it.
    const { rows: existing } = await withoutTenantScope("identity", () =>
      query<{ phone_e164: string | null; phone_verified_at: Date | null }>(
        `SELECT phone_e164, phone_verified_at FROM platform_users WHERE id = $1`,
        [options.platformUserId],
      ),
    );
    if (!existing[0]) return { ok: false, error: "identity_missing" };
    return { ok: false, error: "identity_phone_locked" };
  } catch (error) {
    // The partial unique index is the authority on ownership. Racing claims
    // land here, not in a read-then-write gap.
    if (isUniqueViolation(error)) return { ok: false, error: "phone_taken" };
    throw error;
  }
}

/**
 * Forget the global person's phone, stamp included.
 *
 * Used when the number is being replaced or removed; the next claim starts
 * unverified, which is what stops a changed number from inheriting the old
 * number's proven-control status.
 */
export async function clearVerifiedPhone(platformUserId: string): Promise<void> {
  await withoutTenantScope("identity", () =>
    query(
      `UPDATE platform_users
          SET phone_e164        = NULL,
              phone_verified_at = NULL,
              updated_at        = now()
        WHERE id = $1`,
      [platformUserId],
    ),
  );
}

/**
 * The four facts billing is allowed to read, in the contract's own shape.
 *
 * Returns null for an unknown id rather than an "unverified" object: a caller
 * that passed a bad id must not be able to read that as "this person simply has
 * not verified a phone yet".
 */
/** `query<T>` requires an index signature; the contract's row shape is narrower. */
type AssuranceRow = IdentityAssuranceRow & Record<string, unknown>;

export async function readPlatformIdentityAssurance(
  platformUserId: string,
): Promise<IdentityAssurance | null> {
  const { rows } = await withoutTenantScope("identity", () =>
    query<AssuranceRow>(
      `SELECT phone_e164, phone_verified_at, email, email_verified_at
         FROM platform_users
        WHERE id = $1`,
      [platformUserId],
    ),
  );
  const row = rows[0];
  return row ? readIdentityAssurance(row) : null;
}

/** Postgres unique-violation SQLSTATE. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}
