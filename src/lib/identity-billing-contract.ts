/**
 * ESH-199 × ESH-193 (GitHub #1384 / #1378) — the one surface the global
 * identity track and the commercial billing track share.
 *
 * The commercial launch rests on two foundations that are being built in
 * parallel: a global verified personal identity (#1384) and a canonical
 * pricing/entitlement engine (#1378). Parallel work only stays parallel if the
 * seam between them is a *named contract* rather than an assumption each side
 * makes about the other's schema — otherwise the first billing query that reads
 * a phone number, or the first identity migration that touches a wallet,
 * silently couples them again.
 *
 * So this file is deliberately:
 *
 *  - **pure and database-free.** It imports `./phone` (itself pure) and
 *    nothing else. Neither track has to wait for the other's tables to exist,
 *    and the seam can be unit-tested before a single migration lands.
 *  - **read-only about identity.** There is no function here that writes a
 *    phone, an email or a verification stamp, on purpose: billing states a
 *    commercial requirement, identity is the only thing that can satisfy it.
 *  - **narrow about the tenant.** An actor is built from session/membership
 *    facts — never from a phone, a request body or a slug — so "which business
 *    is being charged" has exactly one source.
 *
 * The four facts billing may rely on are listed once, in
 * `COMMERCIAL_IDENTITY_READ_FIELDS`. Everything else about a person — password
 * material, OTP challenges, national ID, profile metadata — is identity's and
 * never appears in a quote, a wallet row or an invoice.
 */
import { normalizePhone } from "./phone";

/**
 * The two ids every commercial fact hangs off, plus the membership that
 * authorized the request.
 *
 * `platformUserId` is the *global person*: the same person paying for two
 * businesses is one actor with two actorships, and an audit trail that recorded
 * the membership id instead would describe two unrelated payers. `businessId`
 * is the tenant whose plan, wallet or usage is being priced. `membershipId`
 * stays because tenant-scoped reads still need it; it is never the identity.
 */
export interface CommercialActor {
  /** `platform_users.id` — the global person. The one id a commercial audit row records. */
  platformUserId: string;
  /** The business being charged. */
  businessId: string;
  /** The membership that authorized this request. */
  membershipId: string;
}

/**
 * What the session layer already resolved before billing is reached.
 *
 * Deliberately the session's own facts — there is no `phone`, `email` or
 * `requestedBusinessId` field to pass, which is what makes "never derive the
 * tenant from a phone number" a structural property rather than a convention.
 */
export interface CommercialSessionFacts {
  platformUserId: string | null;
  businessId: string | null;
  membershipId: string | null;
  membershipActive: boolean;
}

export type CommercialActorRefusal =
  /** A legacy membership with no global identity yet (the dual-read window). */
  | "no_global_identity"
  /** No business/membership was resolved for this request. */
  | "no_business_scope"
  /** The membership exists but is not active. */
  | "membership_inactive";

export type CommercialActorResolution =
  | { ok: true; actor: CommercialActor }
  | { ok: false; refusal: CommercialActorRefusal };

/**
 * Resolve the commercial actor from session facts, or refuse.
 *
 * The order matters: a membership from before the identity migration has no
 * `platform_user_id`, and the honest answer is "no global identity yet" — not a
 * synthesised actor keyed on its phone. Refusing keeps the parallel tracks
 * honest: billing can deploy first and return a clear message instead of
 * writing commercial history under an id that will change.
 */
export function resolveCommercialActor(
  facts: CommercialSessionFacts,
): CommercialActorResolution {
  if (!facts.platformUserId) return { ok: false, refusal: "no_global_identity" };
  if (!facts.businessId || !facts.membershipId) {
    return { ok: false, refusal: "no_business_scope" };
  }
  if (!facts.membershipActive) return { ok: false, refusal: "membership_inactive" };
  return {
    ok: true,
    actor: {
      platformUserId: facts.platformUserId,
      businessId: facts.businessId,
      membershipId: facts.membershipId,
    },
  };
}

/** One Persian sentence per refusal, so both tracks say the same thing. */
export function commercialActorRefusalMessage(refusal: CommercialActorRefusal): string {
  switch (refusal) {
    case "no_global_identity":
      return "این حساب هنوز هویت سراسری ندارد. ابتدا شمارهٔ موبایل خود را تأیید و حساب را تکمیل کنید.";
    case "no_business_scope":
      return "کسب‌وکار فعال مشخص نیست. یک کسب‌وکار را انتخاب کنید و دوباره تلاش کنید.";
    case "membership_inactive":
      return "عضویت شما در این کسب‌وکار فعال نیست.";
  }
}

/**
 * Whether two actors are the same *person*. The business may differ — that is
 * the point: one person paying for two businesses is one actor identity in the
 * audit trail.
 */
export function sameGlobalPerson(a: CommercialActor, b: CommercialActor): boolean {
  return a.platformUserId === b.platformUserId;
}

/**
 * The complete set of identity facts a commercial code path may read.
 *
 * Anything not listed here belongs to identity: password hash, OTP challenges,
 * national ID, profile metadata. Billing never selects them, never stores them
 * and never echoes them back in a quote or invoice.
 */
export const COMMERCIAL_IDENTITY_READ_FIELDS = [
  "phone_e164",
  "phone_verified_at",
  "email",
  "email_verified_at",
] as const;

export type CommercialIdentityReadField = (typeof COMMERCIAL_IDENTITY_READ_FIELDS)[number];

/**
 * The identity row as billing reads it — the same column names during the
 * dual-read window whether the value comes from the global `platform_users`
 * row (#1384's target) or the membership row it is being backfilled from.
 */
export interface IdentityAssuranceRow {
  phone_e164: string | null;
  phone_verified_at: Date | string | null;
  email: string | null;
  email_verified_at: Date | string | null;
}

/** What a read produced. A value and its verification are separate facts. */
export interface IdentityAssurance {
  phone: { e164: string | null; verified: boolean };
  email: { address: string | null; verified: boolean };
}

/**
 * Read the assurance facts, read-only.
 *
 * Verification requires **both** the value and its stamp. That is not
 * pedantry: changing a phone clears `phone_verified_at` (the team service
 * already does this), so a row can legitimately hold a *new, unverified*
 * number. Reporting it as verified because a column was once non-null is how an
 * unproven number becomes a paid account's recovery phone.
 */
export function readIdentityAssurance(row: IdentityAssuranceRow): IdentityAssurance {
  const phone = typeof row.phone_e164 === "string" ? row.phone_e164.trim() : "";
  const email = typeof row.email === "string" ? row.email.trim() : "";
  const phoneE164 = phone.length > 0 ? phone : null;
  const address = email.length > 0 ? email : null;
  return {
    phone: {
      e164: phoneE164,
      verified: phoneE164 !== null && stamped(row.phone_verified_at),
    },
    email: {
      address,
      verified: address !== null && stamped(row.email_verified_at),
    },
  };
}

/** A stamp counts only when it is a real instant, not NULL and not an empty string. */
function stamped(value: Date | string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  return value.trim().length > 0;
}

export type PurchaseBlocker = "phone_not_verified" | "phone_not_mobile";

export type PurchaseReadiness =
  | { ok: true; phoneE164: string }
  | { ok: false; blockedBy: readonly PurchaseBlocker[]; message: string };

/**
 * Can this identity start a paid subscription or activate a paid service?
 *
 * A verified *mobile* is the requirement the commercial launch agreed on: a
 * landline cannot receive the SMS that proves control of the account, so a
 * verified landline is a legitimate fact that still does not unlock a purchase.
 * The answer carries the canonical `+98…` number, because billing must not
 * re-normalise a value identity already owns.
 *
 * Returning blockers rather than a boolean is intentional: billing renders the
 * Persian sentence from `purchaseBlockerMessage`, identity can log the code, and
 * neither track invents its own copy of "verify your phone first".
 */
export function purchaseReadiness(assurance: IdentityAssurance): PurchaseReadiness {
  const { phone } = assurance;
  if (!phone.e164 || !phone.verified) {
    return blockedFor("phone_not_verified");
  }
  const normalised = normalizePhone(phone.e164);
  if (!normalised.e164 || normalised.kind !== "mobile") {
    return blockedFor("phone_not_mobile");
  }
  return { ok: true, phoneE164: normalised.e164 };
}

function blockedFor(blocker: PurchaseBlocker): PurchaseReadiness {
  return { ok: false, blockedBy: [blocker], message: purchaseBlockerMessage(blocker) };
}

/** Describes the missing proof, never the person. Both tracks use this text. */
export function purchaseBlockerMessage(blocker: PurchaseBlocker): string {
  switch (blocker) {
    case "phone_not_verified":
      return "برای خرید یا فعال‌سازی سرویس، ابتدا شمارهٔ موبایل خود را با کد پیامکی تأیید کنید.";
    case "phone_not_mobile":
      return "برای خرید یا فعال‌سازی سرویس، یک شمارهٔ موبایل معتبر ثبت کنید؛ شمارهٔ ثابت کد تأیید را دریافت نمی‌کند.";
  }
}
