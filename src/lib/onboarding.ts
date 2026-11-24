/**
 * ESH-202 / #1387 — the short post-signup business onboarding.
 *
 * This module owns the server-side draft, the step validation and the one
 * confirmation-gated provisioning call. It deliberately reuses:
 *
 *  - `ENABLED_INDUSTRIES` for the industry list (no second registry);
 *  - the canonical `BusinessLogo` validation/storage shape for the logo;
 *  - #1384's encrypted national-ID and verified-email services;
 *  - `provisionBusinessWithClient` for the business, branch, owner membership
 *    and settings — there is no parallel tenant writer here;
 *  - the existing setup wizard (`/setup`) for everything after provisioning.
 *
 * The continuation cookie is the only caller identity. No function in this
 * module accepts a person, business or membership id from the request.
 */
import { query, withoutTenantScope, withoutTenantScopeTransaction } from "./db";
import {
  ENABLED_INDUSTRIES,
  INDUSTRY_LABELS,
  type Industry,
} from "./industries";
import { isStoredLogo, type BusinessLogo } from "./business-logo";
import {
  issueEmailVerification,
  normalizeIdentityEmail,
  setIdentityEmail,
} from "./iam/identity-credentials";
import {
  sendIdentityEmailVerification,
  type IdentityEmailDeliveryOutcome,
} from "./iam/identity-email-delivery";
import {
  clearNationalId,
  hasNationalId,
  normalizeNationalId,
  setNationalId,
} from "./iam/identity-profile";
import {
  provisionBusinessWithClient,
  VerifiedIdentityRequiredError,
  type ProvisionedBusiness,
} from "./business-provisioning";
import { SETTING_KEYS, setSetting } from "./settings";
import { maskPhoneE164 } from "./phone-otp";
import { recordSignupEvent } from "./iam/signup-events";

export const ONBOARDING_STEPS = ["industry", "basics", "logo", "profile"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** The business fields the setup wizard also accepts, with its limits. */
const MAX_BUSINESS_NAME = 200;
const MAX_ADDRESS = 500;
const MAX_PHONE = 32;

export interface OnboardingDraft {
  industry: Industry | null;
  businessName: string;
  locationName: string;
  address: string;
  phone: string;
  logo: BusinessLogo | null;
  completedSteps: OnboardingStep[];
  submitted: boolean;
  provisionedBusinessId: string | null;
}

export interface OnboardingIdentitySummary {
  fullName: string;
  maskedPhone: string | null;
  email: string | null;
  emailVerified: boolean;
  hasNationalId: boolean;
}

export interface OnboardingState {
  identity: OnboardingIdentitySummary;
  draft: OnboardingDraft;
  /** The canonical list, labels included, so the client never hardcodes a copy. */
  industries: Array<{ key: Industry; label: string }>;
  membershipsExist: boolean;
  provisioned: boolean;
}

export type SaveStepInput = {
  step: OnboardingStep;
  industry?: string | null;
  businessName?: string | null;
  locationName?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  nationalId?: string | null;
  clearNationalId?: boolean;
};

export type SaveStepResult =
  | {
      ok: true;
      draft: OnboardingDraft;
      /** Present on the profile step when an email proof was minted. */
      emailVerification?: IdentityEmailDeliveryOutcome;
    }
  | {
      ok: false;
      error:
        | "invalid_step"
        | "industry_required"
        | "invalid_industry"
        | "invalid_business_name"
        | "invalid_location_name"
        | "field_too_long"
        | "invalid_email"
        | "email_taken"
        | "invalid_national_id"
        | "national_id_taken"
        | "encryption_unavailable"
        | "identity_missing";
    };

export type SubmitResult =
  | {
      ok: true;
      businessId: string;
      userId: string;
      businessSlug: string;
      businessSubdomain: string;
      locationId: string;
      platformUserId: string;
      ownerName: string;
      alreadyProvisioned: boolean;
    }
  | {
      ok: false;
      error:
        | "not_started"
        | "memberships_exist"
        | "invalid_industry"
        | "missing_business_name"
        | "invalid_logo"
        | "email_taken"
        | "identity_missing";
    };

interface DraftRow extends Record<string, unknown> {
  industry: string | null;
  business_name: string | null;
  location_name: string | null;
  address: string | null;
  phone: string | null;
  logo: unknown;
  completed_steps: string[] | null;
  submitted_at: Date | null;
  provisioned_business_id: string | null;
}

function isEnabledIndustry(value: unknown): value is Industry {
  return typeof value === "string" && ENABLED_INDUSTRIES.includes(value as Industry);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function completedSteps(value: unknown): OnboardingStep[] {
  if (!Array.isArray(value)) return [];
  return ONBOARDING_STEPS.filter((step) => value.includes(step));
}

function draftFromRow(row: DraftRow | undefined): OnboardingDraft {
  return {
    industry: isEnabledIndustry(row?.industry) ? row.industry : null,
    businessName: row?.business_name ?? "",
    locationName: row?.location_name ?? "",
    address: row?.address ?? "",
    phone: row?.phone ?? "",
    logo: isStoredLogo(row?.logo) ? row.logo : null,
    completedSteps: completedSteps(row?.completed_steps),
    submitted: Boolean(row?.submitted_at),
    provisionedBusinessId: row?.provisioned_business_id ?? null,
  };
}

async function readDraft(platformUserId: string): Promise<DraftRow | undefined> {
  const { rows } = await query<DraftRow>(
    `SELECT industry, business_name, location_name, address, phone, logo,
            completed_steps, submitted_at, provisioned_business_id
       FROM platform_onboarding_drafts
      WHERE platform_user_id = $1`,
    [platformUserId],
  );
  return rows[0];
}

async function identityRow(platformUserId: string): Promise<{
  id: string;
  full_name: string;
  phone_e164: string | null;
  email: string | null;
  email_verified_at: Date | null;
} | null> {
  const { rows } = await query<{
    id: string;
    full_name: string;
    phone_e164: string | null;
    email: string | null;
    email_verified_at: Date | null;
  }>(
    `SELECT id, full_name, phone_e164, email::text AS email, email_verified_at
       FROM platform_users
      WHERE id = $1 AND is_active AND phone_verified_at IS NOT NULL`,
    [platformUserId],
  );
  return rows[0] ?? null;
}

/** One identity's resumable draft, or null when the continuation is no longer live. */
export async function loadOnboardingState(
  platformUserId: string,
): Promise<OnboardingState | null> {
  return withoutTenantScope("onboarding", async () => {
    const identity = await identityRow(platformUserId);
    if (!identity) return null;

    const [{ rows: membershipRows }, draftRow, identified] = await Promise.all([
      query<{ n: string }>(
        // Every membership counts, including an inactive one: #1385 uses the
        // same test to decide that a verified person already has an account to
        // sign in to, and offering them a second business here would be wrong.
        `SELECT count(*)::text AS n FROM users
          WHERE platform_user_id = $1`,
        [platformUserId],
      ),
      readDraft(platformUserId),
      hasNationalId(platformUserId),
    ]);

    return {
      identity: {
        fullName: identity.full_name,
        maskedPhone: identity.phone_e164 ? maskPhoneE164(identity.phone_e164) : null,
        email: identity.email,
        emailVerified: identity.email !== null && identity.email_verified_at !== null,
        hasNationalId: identified,
      },
      draft: draftFromRow(draftRow),
      industries: ENABLED_INDUSTRIES.map((key) => ({ key, label: INDUSTRY_LABELS[key] })),
      membershipsExist: Number(membershipRows[0]?.n ?? 0) > 0,
      provisioned: Boolean(draftRow?.provisioned_business_id),
    };
  });
}

/**
 * Save one step. Writes are upserts keyed by the platform identity, so a
 * refreshed tab, a retry or a second tab converges on one draft row rather than
 * duplicating progress. Basic fields are validated against the same limits the
 * setup wizard uses.
 */
export async function saveOnboardingStep(
  platformUserId: string,
  input: SaveStepInput,
): Promise<SaveStepResult> {
  if (!ONBOARDING_STEPS.includes(input.step)) return { ok: false, error: "invalid_step" };

  return withoutTenantScope("onboarding", async () => {
    const identity = await identityRow(platformUserId);
    if (!identity) return { ok: false as const, error: "identity_missing" as const };

    const current = await readDraft(platformUserId);
    let emailVerification: IdentityEmailDeliveryOutcome | undefined;

    if (input.step === "industry") {
      const industry = text(input.industry);
      if (!isEnabledIndustry(industry)) return { ok: false as const, error: "invalid_industry" as const };
      await query(
        `INSERT INTO platform_onboarding_drafts (platform_user_id, industry, completed_steps)
         VALUES ($1, $2, ARRAY['industry']::text[])
         ON CONFLICT (platform_user_id) DO UPDATE
            SET industry = EXCLUDED.industry,
                completed_steps = (
                  SELECT array_agg(DISTINCT step ORDER BY step)
                    FROM unnest(platform_onboarding_drafts.completed_steps || ARRAY['industry']::text[]) AS step
                ),
                updated_at = now()`,
        [platformUserId, industry],
      );
      // Issue #1388 — "onboarding started" is the first saved step of a draft
      // that did not exist before, not every edit of that step.
      if (!current) {
        await recordSignupEvent({ event: "onboarding_started", platformUserId });
      }
    } else if (input.step === "basics") {
      const industry = isEnabledIndustry(current?.industry)
        ? current.industry
        : null;
      if (!industry) return { ok: false as const, error: "industry_required" as const };

      const businessName = text(input.businessName);
      const locationName = text(input.locationName);
      const address = text(input.address);
      const phone = text(input.phone);
      if (!businessName) return { ok: false as const, error: "invalid_business_name" as const };
      if (businessName.length > MAX_BUSINESS_NAME || locationName.length > MAX_BUSINESS_NAME) {
        return { ok: false as const, error: "field_too_long" as const };
      }
      if (address.length > MAX_ADDRESS || phone.length > MAX_PHONE) {
        return { ok: false as const, error: "field_too_long" as const };
      }

      await query(
        `INSERT INTO platform_onboarding_drafts
           (platform_user_id, business_name, location_name, address, phone, completed_steps)
         VALUES ($1, $2, $3, $4, $5, ARRAY['basics']::text[])
         ON CONFLICT (platform_user_id) DO UPDATE
            SET business_name = EXCLUDED.business_name,
                location_name = EXCLUDED.location_name,
                address = EXCLUDED.address,
                phone = EXCLUDED.phone,
                completed_steps = (
                  SELECT array_agg(DISTINCT step ORDER BY step)
                    FROM unnest(platform_onboarding_drafts.completed_steps || ARRAY['basics']::text[]) AS step
                ),
                updated_at = now()`,
        [
          platformUserId,
          businessName,
          locationName || null,
          address || null,
          phone || null,
        ],
      );
    } else if (input.step === "logo") {
      // Reaching this endpoint without uploading is the explicit skip. The
      // canonical logo route calls saveOnboardingLogo for an actual file.
      await query(
        `INSERT INTO platform_onboarding_drafts (platform_user_id, completed_steps)
         VALUES ($1, ARRAY['logo']::text[])
         ON CONFLICT (platform_user_id) DO UPDATE
            SET completed_steps = (
                  SELECT array_agg(DISTINCT step ORDER BY step)
                    FROM unnest(platform_onboarding_drafts.completed_steps || ARRAY['logo']::text[]) AS step
                ),
                updated_at = now()`,
        [platformUserId],
      );
    } else {
      // Profile step: both fields are optional and skipping is a save.
      if (input.email !== undefined) {
        if (input.email === null || input.email === "") {
          const cleared = await setIdentityEmail({
            platformUserId,
            email: null,
            actorPlatformUserId: platformUserId,
          });
          if (!cleared.ok) {
            return {
              ok: false as const,
              error: cleared.error === "email_taken" ? "email_taken" as const : "invalid_email" as const,
            };
          }
        } else {
          const email = normalizeIdentityEmail(input.email);
          if (!email) return { ok: false as const, error: "invalid_email" as const };
          const saved = await setIdentityEmail({
            platformUserId,
            email,
            actorPlatformUserId: platformUserId,
          });
          if (!saved.ok) {
            return {
              ok: false as const,
              error: saved.error === "email_taken" ? "email_taken" as const : "invalid_email" as const,
            };
          }
          // A changed address always needs a fresh proof (the 0305 trigger
          // cleared the old stamp). An unverified address is re-proved on save
          // too, so a person whose first mail did not arrive can retry by
          // saving the step again.
          if (saved.changed || !identity.email_verified_at) {
            const issued = await issueEmailVerification({ platformUserId });
            if (!issued.ok) {
              return { ok: false as const, error: "invalid_email" as const };
            }
            emailVerification = (
              await sendIdentityEmailVerification({
                to: issued.email,
                token: issued.token,
              })
            ).outcome;
          }
        }
      }

      if (input.clearNationalId) {
        const cleared = await clearNationalId({
          platformUserId,
          actorPlatformUserId: platformUserId,
        });
        if (!cleared.ok && cleared.error === "identity_missing") {
          return { ok: false as const, error: "identity_missing" as const };
        }
      } else if (input.nationalId !== undefined && input.nationalId !== null && text(input.nationalId)) {
        const nationalId = normalizeNationalId(input.nationalId);
        if (!nationalId) return { ok: false as const, error: "invalid_national_id" as const };
        const saved = await setNationalId({
          platformUserId,
          nationalId,
          actorPlatformUserId: platformUserId,
        });
        if (!saved.ok) {
          const error =
            saved.error === "national_id_taken"
              ? "national_id_taken" as const
              : saved.error === "encryption_unavailable"
                ? "encryption_unavailable" as const
                : "invalid_national_id" as const;
          return { ok: false as const, error };
        }
      }

      await query(
        `INSERT INTO platform_onboarding_drafts (platform_user_id, completed_steps)
         VALUES ($1, ARRAY['profile']::text[])
         ON CONFLICT (platform_user_id) DO UPDATE
            SET completed_steps = (
                  SELECT array_agg(DISTINCT step ORDER BY step)
                    FROM unnest(platform_onboarding_drafts.completed_steps || ARRAY['profile']::text[]) AS step
                ),
                updated_at = now()`,
        [platformUserId],
      );
    }

    const next = await readDraft(platformUserId);
    return {
      ok: true as const,
      draft: draftFromRow(next),
      ...(emailVerification ? { emailVerification } : {}),
    };
  });
}

/** Persist an already validated canonical logo record and mark the step done. */
export async function saveOnboardingLogo(
  platformUserId: string,
  logo: BusinessLogo,
): Promise<OnboardingDraft> {
  return withoutTenantScope("onboarding", async () => {
    await query(
      `INSERT INTO platform_onboarding_drafts (platform_user_id, logo, completed_steps)
       VALUES ($1, $2::jsonb, ARRAY['logo']::text[])
       ON CONFLICT (platform_user_id) DO UPDATE
          SET logo = EXCLUDED.logo,
              completed_steps = (
                SELECT array_agg(DISTINCT step ORDER BY step)
                  FROM unnest(platform_onboarding_drafts.completed_steps || ARRAY['logo']::text[]) AS step
              ),
              updated_at = now()`,
      [platformUserId, JSON.stringify(logo)],
    );
    return draftFromRow(await readDraft(platformUserId));
  });
}

/** Remove the draft logo. Removing is an explicit "no logo for now". */
export async function removeOnboardingLogo(
  platformUserId: string,
): Promise<OnboardingDraft> {
  return withoutTenantScope("onboarding", async () => {
    await query(
      `INSERT INTO platform_onboarding_drafts (platform_user_id, logo, completed_steps)
       VALUES ($1, NULL, ARRAY['logo']::text[])
       ON CONFLICT (platform_user_id) DO UPDATE
          SET logo = NULL,
              completed_steps = (
                SELECT array_agg(DISTINCT step ORDER BY step)
                  FROM unnest(platform_onboarding_drafts.completed_steps || ARRAY['logo']::text[]) AS step
              ),
              updated_at = now()`,
      [platformUserId],
    );
    return draftFromRow(await readDraft(platformUserId));
  });
}

/**
 * Provision exactly once, only after the person confirmed the review.
 *
 * The advisory lock is keyed by the global identity (never a request id), and
 * the draft row is locked in the same transaction. The business, its logo
 * setting and the draft's `provisioned_business_id` commit together, so a
 * retry, a duplicate tab or a crash after commit can only ever return the same
 * business.
 */
export async function submitOnboarding(
  platformUserId: string,
): Promise<SubmitResult> {
  return withoutTenantScopeTransaction("onboarding", async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `short-onboarding:${platformUserId}`,
    ]);

    const { rows } = await client.query<DraftRow>(
      `SELECT industry, business_name, location_name, address, phone, logo,
              completed_steps, submitted_at, provisioned_business_id
         FROM platform_onboarding_drafts
        WHERE platform_user_id = $1
        FOR UPDATE`,
      [platformUserId],
    );
    const draft = rows[0];
    if (!draft) return { ok: false as const, error: "not_started" as const };

    // Revalidate the person before *either* branch: a retry of a committed
    // provisioning must not mint a session for an identity that has since been
    // deactivated or lost its verified phone.
    const { rows: identityRows } = await client.query<{
      id: string;
      full_name: string;
      phone_e164: string | null;
      phone_verified_at: Date | null;
      is_active: boolean;
      email: string | null;
    }>(
      `SELECT id, full_name, phone_e164, phone_verified_at, is_active, email::text AS email
         FROM platform_users
        WHERE id = $1
        FOR UPDATE`,
      [platformUserId],
    );
    const identity = identityRows[0];
    if (!identity || !identity.is_active || !identity.phone_verified_at) {
      return { ok: false as const, error: "identity_missing" as const };
    }

    if (draft.provisioned_business_id) {
      const { rows: memberRows } = await client.query<{ id: string }>(
        `SELECT id FROM users
          WHERE platform_user_id = $1 AND business_id = $2 AND is_active
          LIMIT 1`,
        [platformUserId, draft.provisioned_business_id],
      );
      // Sequential on purpose: a `pg` client has one wire protocol, and this
      // branch must not interleave statements on the transaction's connection.
      const { rows: bizRows } = await client.query<{ slug: string; subdomain: string }>(
        `SELECT slug::text AS slug, subdomain::text AS subdomain
           FROM businesses WHERE id = $1`,
        [draft.provisioned_business_id],
      );
      const { rows: locationRows } = await client.query<{ id: string }>(
        `SELECT id FROM locations
          WHERE business_id = $1
          ORDER BY created_at
          LIMIT 1`,
        [draft.provisioned_business_id],
      );
      if (!memberRows[0] || !bizRows[0]) {
        return { ok: false as const, error: "identity_missing" as const };
      }
      return {
        ok: true as const,
        businessId: draft.provisioned_business_id,
        userId: memberRows[0].id,
        businessSlug: bizRows[0].slug,
        businessSubdomain: bizRows[0].subdomain,
        locationId: locationRows[0]?.id ?? "",
        platformUserId,
        ownerName: identity.full_name,
        alreadyProvisioned: true,
      };
    }

    const { rows: membershipRows } = await client.query<{ n: string }>(
      // Every membership counts, including inactive ones — see
      // `loadOnboardingState` and #1385's matching rule.
      `SELECT count(*)::text AS n FROM users
        WHERE platform_user_id = $1`,
      [platformUserId],
    );
    if (Number(membershipRows[0]?.n ?? 0) > 0) {
      return { ok: false as const, error: "memberships_exist" as const };
    }

    // `users.email` is unique across memberships while the global identity's
    // email is unique across people. An address already used by another
    // business's membership must be refused here, before the canonical insert
    // turns it into an opaque unique violation — and never attached silently.
    if (identity.email) {
      const { rows: emailRows } = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE email = $1 LIMIT 1",
        [identity.email],
      );
      if (emailRows[0]) {
        return { ok: false as const, error: "email_taken" as const };
      }
    }

    if (!isEnabledIndustry(draft.industry)) {
      return { ok: false as const, error: "invalid_industry" as const };
    }
    if (!text(draft.business_name)) {
      return { ok: false as const, error: "missing_business_name" as const };
    }
    if (draft.logo != null && !isStoredLogo(draft.logo)) {
      return { ok: false as const, error: "invalid_logo" as const };
    }

    let provisioned: ProvisionedBusiness;
    try {
      provisioned = await provisionBusinessWithClient(client, {
        businessName: text(draft.business_name),
        locationName: text(draft.location_name) || undefined,
        address: text(draft.address) || null,
        phone: text(draft.phone) || null,
        ownerName: identity.full_name,
        ownerPhone: identity.phone_e164,
        email: identity.email,
        platformUserId,
        industry: draft.industry,
        // Deliberately no `seedChartOfAccounts`, `completeSetup` or any
        // subscription/wallet/app side effect: the existing /setup wizard
        // remains the owner of those decisions.
      });
    } catch (error) {
      if (error instanceof VerifiedIdentityRequiredError) {
        return { ok: false as const, error: "identity_missing" as const };
      }
      throw error;
    }

    if (isStoredLogo(draft.logo)) {
      await setSetting(provisioned.businessId, SETTING_KEYS.businessLogo, draft.logo);
    }

    await client.query(
      `UPDATE platform_onboarding_drafts
          SET submitted_at = now(),
              provisioned_business_id = $2,
              provisioned_user_id = $3,
              updated_at = now()
        WHERE platform_user_id = $1`,
      [platformUserId, provisioned.businessId, provisioned.userId],
    );

    return {
      ok: true as const,
      businessId: provisioned.businessId,
      userId: provisioned.userId,
      businessSlug: provisioned.businessSlug,
      businessSubdomain: provisioned.businessSubdomain,
      locationId: provisioned.locationId,
      platformUserId,
      ownerName: identity.full_name,
      alreadyProvisioned: false,
    };
  });
}


