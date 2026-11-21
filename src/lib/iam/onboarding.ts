/**
 * ESH-202 / #1387 — the short, resumable post-signup business onboarding.
 *
 * This is deliberately a small wizard with four steps — industry, business
 * basics, an optional logo, optional profile — that ends in **one** explicit
 * act: provisioning the first business. It is not the full setup wizard. The
 * app gallery, pricing, per-app setup and Finish remain #1239's `/setup`, which
 * this flow hands off to with the values captured here already persisted in the
 * canonical rows it reads.
 *
 * The rules that shape it:
 *
 *  - **The industry registry is canonical.** The picker is generated from
 *    `ENABLED_INDUSTRIES`; an industry that is not enabled is refused here, not
 *    silently accepted and then rejected by provisioning.
 *  - **Nothing is required beyond what the business must have.** A name and an
 *    industry. Location, address, phone, logo, email and national ID are all
 *    optional; the person can add them now or later. No password, wallet, app
 *    purchase or payment is asked for.
 *  - **Progress is server-side and durable.** One row per person, not per
 *    session: a refresh, another device and a new sign-in all resume the same
 *    draft.
 *  - **Submit is idempotent.** Two tabs, a retry or a double tap converge on one
 *    business through an advisory lock and `provisioned_business_id`; the second
 *    call returns the first call's business rather than creating another.
 *  - **Provisioning is the existing service.** `provisionBusiness`'s transaction
 *    creates the business, branch, membership and settings exactly as every
 *    other entry point does — no second tenant model.
 *
 * The logo is staged here as the canonical inline data URL and validated with
 * the canonical rules (`src/lib/business-logo.ts`); the provisioning transaction
 * moves it into `settings.business.logo`, which is what `/setup` and receipts
 * read. It is never served from the onboarding row.
 */
import { query, withoutTenantScope, withoutTenantScopeTransaction } from "../db";
import {
  hasMatchingLogoSignature,
  isValidLogo,
  type LogoMimeType,
} from "../business-logo";
import { ENABLED_INDUSTRIES, INDUSTRY_LABELS, type Industry } from "../industries";
import { normalizePhone } from "../phone";
import {
  provisionFirstBusinessFromOnboarding,
  type ProvisionedFirstBusiness,
} from "../business-provisioning";
import { setIdentityEmail } from "./identity-credentials";
import { setNationalId } from "./identity-profile";

export const ONBOARDING_STEPS = ["industry", "business", "logo", "profile"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export function isOnboardingStep(value: unknown): value is OnboardingStep {
  return typeof value === "string" && (ONBOARDING_STEPS as readonly string[]).includes(value);
}

/** The industries the picker offers: the canonical enabled registry, labelled. */
export function onboardingIndustryOptions(): { key: Industry; label: string }[] {
  return ENABLED_INDUSTRIES.map((key) => ({ key, label: INDUSTRY_LABELS[key] }));
}

export interface OnboardingLogo {
  dataUrl: string;
  mimeType: LogoMimeType;
  byteLength: number;
}

export interface OnboardingState {
  platformUserId: string;
  industry: Industry | null;
  businessName: string | null;
  locationName: string | null;
  address: string | null;
  phoneE164: string | null;
  logo: OnboardingLogo | null;
  step: OnboardingStep;
  status: "in_progress" | "provisioned";
  provisionedBusinessId: string | null;
  submittedAt: string | null;
  updatedAt: string | null;
}

export type OnboardingError =
  | "invalid_name"
  | "invalid_industry"
  | "invalid_phone"
  | "invalid_logo"
  | "invalid_step"
  | "field_too_long"
  | "already_provisioned"
  | "onboarding_incomplete"
  | "invalid_email"
  | "email_taken"
  | "invalid_national_id"
  | "national_id_taken"
  | "identity_missing";

const MAX_BUSINESS_NAME = 200;
const MAX_LOCATION_NAME = 200;
const MAX_ADDRESS = 500;

/**
 * Validate the staged logo. Pure.
 *
 * Accepts the same four MIME types and 256 KiB decoded ceiling the canonical
 * logo setting enforces, and additionally checks the magic bytes: the declared
 * MIME type travels in the data URL and is attacker-controlled, so a file that
 * claims `image/png` but is really HTML must be refused before it can become an
 * `<img src>`.
 */
export function parseOnboardingLogo(
  value: unknown,
): { ok: true; logo: OnboardingLogo } | { ok: false; error: "invalid_logo" } {
  if (typeof value !== "string" || value.length > 700_000) {
    return { ok: false, error: "invalid_logo" };
  }
  const match = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) return { ok: false, error: "invalid_logo" };

  const mimeType = match[1] as LogoMimeType;
  const bytes = Buffer.from(match[2], "base64");
  if (!isValidLogo({ mimeType, byteLength: bytes.length })) {
    return { ok: false, error: "invalid_logo" };
  }
  if (!hasMatchingLogoSignature(mimeType, new Uint8Array(bytes))) {
    return { ok: false, error: "invalid_logo" };
  }
  return { ok: true, logo: { dataUrl: value, mimeType, byteLength: bytes.length } };
}

/** Trimmed, bounded optional text, or an error when it is over the bound. */
function boundedText(
  value: unknown,
  max: number,
): { ok: true; value: string | null } | { ok: false; error: "field_too_long" } {
  if (value === undefined) return { ok: true, value: null };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: true, value: null };
  const trimmed = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > max) return { ok: false, error: "field_too_long" };
  return { ok: true, value: trimmed };
}

export interface OnboardingPatch {
  industry?: unknown;
  businessName?: unknown;
  locationName?: unknown;
  address?: unknown;
  phone?: unknown;
  /** A data URL, or null to remove the staged logo. */
  logoDataUrl?: unknown;
  step?: unknown;
  email?: unknown;
  nationalId?: unknown;
}

type Row = Record<string, unknown> & {
  platform_user_id: string;
  industry: string | null;
  business_name: string | null;
  location_name: string | null;
  address: string | null;
  phone_e164: string | null;
  logo_data_url: string | null;
  logo_mime_type: LogoMimeType | null;
  logo_byte_length: number | null;
  step: OnboardingStep;
  status: "in_progress" | "provisioned";
  provisioned_business_id: string | null;
  submitted_at: Date | null;
  updated_at: Date | null;
};

function toState(row: Row): OnboardingState {
  return {
    platformUserId: row.platform_user_id,
    industry: (row.industry as Industry | null) ?? null,
    businessName: row.business_name,
    locationName: row.location_name,
    address: row.address,
    phoneE164: row.phone_e164,
    logo:
      row.logo_data_url && row.logo_mime_type && row.logo_byte_length
        ? {
            dataUrl: row.logo_data_url,
            mimeType: row.logo_mime_type,
            byteLength: row.logo_byte_length,
          }
        : null,
    step: row.step,
    status: row.status,
    provisionedBusinessId: row.provisioned_business_id,
    submittedAt: row.submitted_at ? new Date(row.submitted_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

const SELECT_COLUMNS = `platform_user_id, industry, business_name, location_name, address,
       phone_e164, logo_data_url, logo_mime_type, logo_byte_length,
       step, status, provisioned_business_id, submitted_at, updated_at`;

/** The person's onboarding draft, or null when they have never started. */
export async function readOnboarding(platformUserId: string): Promise<OnboardingState | null> {
  const { rows } = await withoutTenantScope("signup", () =>
    query<Row>(
      `SELECT ${SELECT_COLUMNS} FROM platform_onboarding_progress WHERE platform_user_id = $1`,
      [platformUserId],
    ),
  );
  return rows[0] ? toState(rows[0]) : null;
}

export type SaveOnboardingResult =
  | { ok: true; state: OnboardingState }
  | { ok: false; error: OnboardingError };

/**
 * Merge one step's answers into the draft.
 *
 * A field the request does not name is left exactly as stored — this is what
 * makes "save and continue" safe when the form only sends the step it is on.
 * `logoDataUrl: null` is the explicit removal; an absent key keeps the logo, so
 * a later step cannot wipe an earlier upload by omission.
 */
export async function saveOnboarding(
  platformUserId: string,
  patch: OnboardingPatch,
): Promise<SaveOnboardingResult> {
  const sets: string[] = [];
  const params: unknown[] = [platformUserId];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (patch.industry !== undefined) {
    if (typeof patch.industry !== "string" || !(ENABLED_INDUSTRIES as string[]).includes(patch.industry)) {
      return { ok: false, error: "invalid_industry" };
    }
    set("industry", patch.industry);
  }

  if (patch.businessName !== undefined) {
    const name = boundedText(patch.businessName, MAX_BUSINESS_NAME);
    if (!name.ok) return name;
    if (patch.businessName !== null && typeof patch.businessName === "string" && !name.value) {
      return { ok: false, error: "invalid_name" };
    }
    set("business_name", name.value);
  }

  if (patch.locationName !== undefined) {
    const name = boundedText(patch.locationName, MAX_LOCATION_NAME);
    if (!name.ok) return name;
    set("location_name", name.value);
  }

  if (patch.address !== undefined) {
    const address = boundedText(patch.address, MAX_ADDRESS);
    if (!address.ok) return address;
    set("address", address.value);
  }

  if (patch.phone !== undefined) {
    if (patch.phone === null || patch.phone === "") {
      set("phone_e164", null);
    } else {
      if (typeof patch.phone !== "string") return { ok: false, error: "invalid_phone" };
      const normalised = normalizePhone(patch.phone);
      if (!normalised.valid || !normalised.e164) return { ok: false, error: "invalid_phone" };
      set("phone_e164", normalised.e164);
    }
  }

  if (patch.logoDataUrl !== undefined) {
    if (patch.logoDataUrl === null) {
      set("logo_data_url", null);
      sets.push("logo_mime_type = NULL", "logo_byte_length = NULL");
    } else {
      const parsed = parseOnboardingLogo(patch.logoDataUrl);
      if (!parsed.ok) return parsed;
      set("logo_data_url", parsed.logo.dataUrl);
      set("logo_mime_type", parsed.logo.mimeType);
      set("logo_byte_length", parsed.logo.byteLength);
    }
  }

  if (patch.step !== undefined) {
    if (!isOnboardingStep(patch.step)) return { ok: false, error: "invalid_step" };
    set("step", patch.step);
  }

  // The optional profile fields are identity writes, not draft data: they reuse
  // the #1384 services so email uniqueness/verification invalidation and the
  // encrypted national ID keep exactly one implementation.
  if (patch.email !== undefined && patch.email !== null && patch.email !== "") {
    if (typeof patch.email !== "string") return { ok: false, error: "invalid_email" };
    const result = await setIdentityEmail({ platformUserId, email: patch.email });
    if (!result.ok) {
      return {
        ok: false,
        error:
          result.error === "email_taken"
            ? "email_taken"
            : result.error === "identity_missing"
              ? "identity_missing"
              : "invalid_email",
      };
    }
  }

  if (patch.nationalId !== undefined && patch.nationalId !== null && patch.nationalId !== "") {
    if (typeof patch.nationalId !== "string") return { ok: false, error: "invalid_national_id" };
    const result = await setNationalId({
      platformUserId,
      nationalId: patch.nationalId,
      actorPlatformUserId: platformUserId,
    });
    if (!result.ok) {
      return {
        ok: false,
        error:
          result.error === "national_id_taken"
            ? "national_id_taken"
            : result.error === "identity_missing"
              ? "identity_missing"
              : result.error === "encryption_unavailable"
                ? "identity_missing"
                : "invalid_national_id",
      };
    }
  }

  if (sets.length === 0) {
    const state = await readOnboarding(platformUserId);
    if (!state) return { ok: false, error: "identity_missing" };
    return { ok: true, state };
  }

  const saved = await withoutTenantScopeTransaction("signup", async () => {
    const { rows: locked } = await query<{ status: Row["status"] }>(
      `SELECT status FROM platform_onboarding_progress WHERE platform_user_id = $1 FOR UPDATE`,
      [platformUserId],
    );
    if (locked[0]?.status === "provisioned") return { ok: false as const, error: "already_provisioned" as const };

    await query(
      `INSERT INTO platform_onboarding_progress (platform_user_id)
       VALUES ($1)
       ON CONFLICT (platform_user_id) DO NOTHING`,
      [platformUserId],
    );
    sets.push("updated_at = now()");
    const { rows } = await query<Row>(
      `UPDATE platform_onboarding_progress
          SET ${sets.join(", ")}
        WHERE platform_user_id = $1
        RETURNING ${SELECT_COLUMNS}`,
      params,
    );
    return rows[0]
      ? { ok: true as const, state: toState(rows[0]) }
      : { ok: false as const, error: "identity_missing" as const };
  });

  return saved;
}

export type SubmitOnboardingResult =
  | { ok: true; business: ProvisionedFirstBusiness; state: OnboardingState }
  | { ok: false; error: OnboardingError };

/**
 * Provision the first business from the saved draft.
 *
 * The only act in this whole flow that creates a tenant. It runs once per
 * person: the provisioning transaction takes a lock keyed on the identity,
 * reads `provisioned_business_id`, and returns the existing business on a
 * repeat. That is what makes a double tap, a second tab and a network retry
 * safe without asking the client for an idempotency key.
 */
export async function submitOnboarding(platformUserId: string): Promise<SubmitOnboardingResult> {
  const state = await readOnboarding(platformUserId);
  if (!state) return { ok: false, error: "onboarding_incomplete" };

  if (state.provisionedBusinessId) {
    // Already done: answer with the same business, never create a second one.
    const business = await readProvisionedFirstBusiness(platformUserId, state.provisionedBusinessId);
    if (business) return { ok: true, business, state };
  }

  if (!state.industry || !state.businessName) {
    return { ok: false, error: "onboarding_incomplete" };
  }

  const business = await provisionFirstBusinessFromOnboarding({
    platformUserId,
    industry: state.industry,
    businessName: state.businessName,
    locationName: state.locationName,
    address: state.address,
    phone: state.phoneE164,
    logo: state.logo,
  });

  const after = await readOnboarding(platformUserId);
  if (!after) return { ok: false, error: "identity_missing" };
  return { ok: true, business, state: after };
}

/** The business a completed onboarding already points at, if it still exists. */
async function readProvisionedFirstBusiness(
  platformUserId: string,
  businessId: string,
): Promise<ProvisionedFirstBusiness | null> {
  const { rows } = await withoutTenantScope("signup", () =>
    query<{
      business_id: string;
      business_slug: string;
      business_subdomain: string;
      location_id: string | null;
      user_id: string | null;
      full_name: string | null;
    }>(
      `SELECT b.id AS business_id, b.slug::text AS business_slug,
              b.subdomain::text AS business_subdomain,
              l.id AS location_id, u.id AS user_id, u.full_name
         FROM businesses b
         LEFT JOIN locations l ON l.business_id = b.id
         LEFT JOIN users u ON u.business_id = b.id AND u.platform_user_id = $2
        WHERE b.id = $1
        ORDER BY l.created_at ASC NULLS LAST
        LIMIT 1`,
      [businessId, platformUserId],
    ),
  );
  const row = rows[0];
  if (!row?.location_id || !row.user_id) return null;
  return {
    businessId: row.business_id,
    businessSlug: row.business_slug,
    businessSubdomain: row.business_subdomain,
    locationId: row.location_id,
    userId: row.user_id,
    platformUserId,
    ownerName: row.full_name ?? "",
    created: false,
  };
}
