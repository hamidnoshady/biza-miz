/**
 * Issue #1128 — reading and saving an advertising agency's *operating profile*.
 *
 * The DB half of `agency.ts`, and deliberately a thin one: the choice is a
 * single jsonb value in the shared `settings` table (`SETTING_KEYS.agencyProfile`),
 * so there is no table to migrate, no row to seed and nothing for an existing
 * tenant to lose. AEC needed `aec_business_profiles` because a profile there
 * presets nineteen capability overrides and a specialty list per business
 * (#799 §2); an agency profile presets the ordering of seven project blueprints
 * and nothing else, so it gets the storage the platform already gives every
 * other business-wide preference.
 *
 * Two rules the whole file obeys:
 *
 *   * **Another industry is refused, not defaulted.** `loadBusinessAgencyProfile`
 *     throws `industry_mismatch` and `readAgencyOperatingProfile` answers
 *     `null`, exactly as the AEC pair does: serving a café the agency default
 *     would mean an F&B tenant reading configuration it can never use.
 *   * **Nothing is coerced on save.** An unrecognised profile string is
 *     `invalid_profile` (a 400 at the route), never a quiet fall back to
 *     `full_service` — a value this code does not know was written by a newer
 *     version or by hand, and overwriting it would lose a decision.
 *
 * Saving writes an `audit_log` row in the same transaction as the setting, so
 * "who changed the shape of this agency's workspace" has an answer even though
 * the choice itself is cosmetic: it reorders what every member of the business
 * is offered first.
 */

import {
  AGENCY_DEFAULT_OPERATING_PROFILE,
  AGENCY_INDUSTRY,
  parseAgencyProfileSetting,
  type AgencyOperatingProfile,
} from "./agency";
import { query, withTenantTransaction } from "./db";
import { getBusinessIndustry } from "./industry-guard";
import { getSetting, SETTING_KEYS, setSetting } from "./settings";

/** What a caller gets back: the resolved profile and whether it was chosen. */
export interface AgencyBusinessProfileState {
  operatingProfile: AgencyOperatingProfile;
  /** Additional shapes the agency works in. Labels only — never a gate. */
  specialties: AgencyOperatingProfile[];
  /** False until the business saves a choice; the default is assumed meanwhile. */
  stored: boolean;
  /** ISO time of the last save, or null while nothing is stored. */
  updatedAt: string | null;
}

/** The three ways a profile read or write can be refused, as HTTP statuses. */
export type AgencyProfileErrorCode = "industry_mismatch" | "invalid_profile";

export class AgencyProfileError extends Error {
  constructor(readonly code: AgencyProfileErrorCode) {
    super(code);
    this.name = "AgencyProfileError";
  }
}

const DEFAULT_STATE: AgencyBusinessProfileState = {
  operatingProfile: AGENCY_DEFAULT_OPERATING_PROFILE,
  specialties: [],
  stored: false,
  updatedAt: null,
};

/** The stored setting resolved, with the default standing in for "never saved". */
async function readAgencyProfile(businessId: string): Promise<AgencyBusinessProfileState> {
  const stored = parseAgencyProfileSetting(
    await getSetting<unknown>(businessId, SETTING_KEYS.agencyProfile),
  );
  return stored ? { ...stored, stored: true } : DEFAULT_STATE;
}

/**
 * The profile that orders this business's blueprints, or `null` for a business
 * of any other industry — the shape `templatesForIndustry` wants, and the
 * reason the templates route can ask without knowing the trade first.
 */
export async function readAgencyOperatingProfile(
  businessId: string,
): Promise<AgencyOperatingProfile | null> {
  if ((await getBusinessIndustry(businessId)) !== AGENCY_INDUSTRY) return null;
  return (await readAgencyProfile(businessId)).operatingProfile;
}

/** The GET half for the settings form: refuses a business of another industry. */
export async function loadBusinessAgencyProfile(
  businessId: string,
): Promise<AgencyBusinessProfileState> {
  if ((await getBusinessIndustry(businessId)) !== AGENCY_INDUSTRY) {
    throw new AgencyProfileError("industry_mismatch");
  }
  return readAgencyProfile(businessId);
}

/**
 * The PUT half: validates the body through `agency.ts`'s pure normalizer,
 * writes the setting and its audit row together, and returns what is now
 * stored — a write answers with the same shape the read gives, so the form
 * never has to re-fetch to know whether its choice took.
 */
export async function saveBusinessAgencyProfile(
  actor: { businessId: string; locationId?: string | null; userId?: string | null },
  body: unknown,
): Promise<AgencyBusinessProfileState> {
  const state = await loadBusinessAgencyProfile(actor.businessId);
  const candidate = normalizeSaveBody(body, state);
  if (!candidate) throw new AgencyProfileError("invalid_profile");

  const before = { operatingProfile: state.operatingProfile, specialties: state.specialties };
  const saved: AgencyBusinessProfileState = { ...candidate, stored: true };
  await withTenantTransaction(
    actor.businessId,
    async () => {
      await setSetting(actor.businessId, SETTING_KEYS.agencyProfile, saved);
      await query(
        `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
         VALUES ($1,$2,$3,'settings.agency_profile.update','settings',$4,$5::jsonb)`,
        [
          actor.businessId,
          actor.locationId ?? null,
          actor.userId ?? null,
          SETTING_KEYS.agencyProfile,
          JSON.stringify({ before, after: saved }),
        ],
      );
    },
    { locationId: actor.locationId ?? undefined, userId: actor.userId ?? undefined },
  );
  return saved;
}

/**
 * Pure: the setting a save request asks for, or null when the request is not
 * one. An omitted `operatingProfile` keeps the current choice — a client may
 * send only `specialties` — while an unrecognised one is a refusal rather than
 * a silent default.
 */
function normalizeSaveBody(
  body: unknown,
  current: AgencyBusinessProfileState,
): Omit<AgencyBusinessProfileState, "stored"> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== "operatingProfile" && key !== "specialties")) return null;
  const profile = parseAgencyProfileSetting({
    operatingProfile:
      raw.operatingProfile === undefined ? current.operatingProfile : raw.operatingProfile,
    specialties: raw.specialties === undefined ? current.specialties : raw.specialties,
    updatedAt: null,
  });
  if (!profile) return null;
  return { ...profile, updatedAt: new Date().toISOString() };
}
