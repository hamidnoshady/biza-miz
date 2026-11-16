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
  | { ok: false; error: PhoneClaimRefusal | "phone_taken" | "identity_missing" };

/**
 * Record a number as verified for this global person.
 *
 * The value is stored in its canonical E.164 form, never as typed, so the
 * uniqueness index compares the same string every door produces.
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
          RETURNING phone_e164`,
        [options.platformUserId, prepared.phoneE164],
      ),
    );
    const claimed = rows[0];
    if (!claimed) return { ok: false, error: "identity_missing" };
    return { ok: true, phoneE164: claimed.phone_e164 };
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
