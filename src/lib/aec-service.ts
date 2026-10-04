/**
 * Issue #799 Wave 2 — the AEC service: the business's operating profile, one
 * project's AEC profile, and the external participants on it.
 *
 * The shapes and the rules live in `aec.ts` (pure, testable, importable from a
 * client component); this file is the part that talks to PostgreSQL. It follows
 * `workspace.ts`'s conventions because it extends the same area:
 *
 *   * every function takes `WorkspaceOwner` (or a bare `businessId` for reads)
 *     and never trusts a business id from a request body;
 *   * a machine-readable `AecError` code, mapped to a status by the API guard;
 *   * the table's own constraints are the backstop, never the first line —
 *     the service validates what the caller sees as a 400, and the migration's
 *     CHECKs and triggers refuse anything that gets past it.
 */
import {
  AEC_DEFAULT_OPERATING_PROFILE,
  AEC_LIVE_CAPABILITIES,
  AEC_PARTICIPANT_GROUPS,
  AEC_PARTICIPANT_GROUP_BY_ROLE,
  AEC_PARTICIPANT_ROLE_DEFS,
  aecParticipantRoleAllowed,
  aecParticipantRolesFor,
  isAecOperatingProfile,
  normalizeAecCapabilityOverrides,
  normalizeAecSpecialties,
  resolveAecCapabilities,
  type AecCapabilityKey,
  type AecCapabilityOverrides,
  type AecCapabilityResolutionInput,
  type AecOperatingProfile,
  type AecParticipantGroup,
  type AecParticipantRole,
  type AecSpecialty,
} from "./aec";
import { businessToday } from "./business-day-service";
import { getBusinessIndustry } from "./industry-guard";
import { query } from "./db";
import { addDays } from "./workspace-shared";
import type { WorkspaceOwner } from "./workspace";

/** The one industry these tables belong to. Spelled once, here. */
export const AEC_INDUSTRY = "architecture_construction" as const;

/** Thrown with a code the API layer maps onto a status + Persian message. */
export class AecError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AecError";
  }
}

/* ===========================================================================
 * Input coercion
 * ======================================================================== */

function trimTo(value: unknown, max: number): string {
  return (typeof value === "string" ? value : "").trim().slice(0, max);
}

function optionalText(value: unknown, max: number): string | null {
  const text = trimTo(value, max);
  return text || null;
}

/** ISO `YYYY-MM-DD` or null. The UI converts from Shamsi; the database only ever sees Gregorian. */
function optionalDate(value: unknown, code = "invalid_date"): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AecError(code);
  return value;
}

/**
 * A decimal that may be negative (geo coordinates) or must not be
 * (areas, progress). Signedness is a parameter rather than two functions
 * because the parsing, the scale cap and the magnitude cap are identical.
 */
function optionalDecimal(
  value: unknown,
  max: number,
  scale: number,
  code: string,
  { signed = false }: { signed?: boolean } = {},
): string | null {
  if (value === null || value === undefined || value === "") return null;
  const text = (typeof value === "number" ? String(value) : String(value).trim()).replace(/^\+/, "");
  const pattern = signed ? /^-?\d+(\.\d+)?$/ : /^\d+(\.\d+)?$/;
  if (!pattern.test(text)) throw new AecError(code);
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = text.replace(/^-/, "").split(".");
  if (fraction.length > scale) throw new AecError(code);
  const numeric = Number(text);
  if (!Number.isFinite(numeric) || Math.abs(numeric) > max) throw new AecError(code);
  const sign = negative && numeric !== 0 ? "-" : "";
  return `${sign}${whole}.${fraction.padEnd(scale, "0")}`;
}

function optionalInteger(value: unknown, max: number, code: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > max) throw new AecError(code);
  return numeric;
}

function optionalUuid(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^[0-9a-fA-F-]{36}$/.test(value)) throw new AecError("invalid_reference");
  return value;
}

function stringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, maxLength))
        .filter(Boolean),
    ),
  ].slice(0, maxItems);
}

/* ===========================================================================
 * The business's operating profile
 * ======================================================================== */

export interface AecBusinessProfileState {
  operatingProfile: AecOperatingProfile;
  specialties: AecSpecialty[];
  capabilityOverrides: AecCapabilityOverrides;
  /** Resolved: the profile's preset with the overrides applied. */
  capabilities: AecCapabilityKey[];
  /** The participant roles those capabilities allow, grouped for the picker. */
  participantRoles: AecParticipantRole[];
  /** Which of the capabilities already have a shipped feature behind them. */
  liveCapabilities: readonly AecCapabilityKey[];
  /** False when the business has never saved a profile and the defaults are being served. */
  stored: boolean;
}

/** The resolution input a stored profile describes — used wherever a rule asks "what can this business do". */
function capabilityInput(state: Pick<AecBusinessProfileState, "operatingProfile" | "capabilityOverrides">): AecCapabilityResolutionInput {
  return { profile: state.operatingProfile, overrides: state.capabilityOverrides };
}

function resolveBusinessProfile(
  operatingProfile: AecOperatingProfile,
  specialties: AecSpecialty[],
  capabilityOverrides: AecCapabilityOverrides,
  stored: boolean,
): AecBusinessProfileState {
  const input: AecCapabilityResolutionInput = { profile: operatingProfile, overrides: capabilityOverrides };
  return {
    operatingProfile,
    specialties,
    capabilityOverrides,
    capabilities: resolveAecCapabilities(input),
    participantRoles: aecParticipantRolesFor(input).map((def) => def.key),
    liveCapabilities: AEC_LIVE_CAPABILITIES,
    stored,
  };
}

/**
 * The business's AEC profile, resolved.
 *
 * A business that has not saved one yet is not an error: it gets the default
 * profile's preset, and `stored: false` lets the settings screen say «هنوز
 * ذخیره نشده» rather than pretending a choice was made. A business of another
 * industry is refused — this configuration has no meaning outside AEC, and
 * serving it a default would let an F&B tenant read AEC settings it can never
 * use.
 */
export async function loadBusinessAecProfile(businessId: string): Promise<AecBusinessProfileState> {
  await assertAecIndustry(businessId);
  return readBusinessAecProfile(businessId);
}

/** The stored row, resolved — the read half, for callers that already know the industry. */
async function readBusinessAecProfile(businessId: string): Promise<AecBusinessProfileState> {
  const { rows } = await query<{
    operating_profile: string;
    specialties: string[];
    capability_overrides: Record<string, unknown>;
  }>(
    `SELECT operating_profile, specialties, capability_overrides
       FROM aec_business_profiles WHERE business_id = $1`,
    [businessId],
  );
  const row = rows[0];
  if (!row) {
    return resolveBusinessProfile(AEC_DEFAULT_OPERATING_PROFILE, [], {}, false);
  }
  const operatingProfile = isAecOperatingProfile(row.operating_profile)
    ? row.operating_profile
    : AEC_DEFAULT_OPERATING_PROFILE;
  return resolveBusinessProfile(
    operatingProfile,
    normalizeAecSpecialties(row.specialties ?? []),
    normalizeAecCapabilityOverrides(row.capability_overrides, operatingProfile),
    true,
  );
}

/**
 * What the project cockpit needs to know before it renders: whether this
 * business is AEC at all, and which of its capabilities are on.
 *
 * Answered rather than refused — a café's project page calls this too, and an
 * `industry_mismatch` 403 there would turn an ordinary page into an error. The
 * project id is still checked against the caller's business by
 * `requireProjectCapability` at the route, because capabilities are
 * business-wide today but the *access* to them is per project, and a later wave
 * may scope a capability to one project.
 */
export interface AecProjectCockpit {
  aec: boolean;
  capabilities: AecCapabilityKey[];
}

export async function loadAecProjectCockpit(businessId: string): Promise<AecProjectCockpit> {
  if ((await getBusinessIndustry(businessId)) !== AEC_INDUSTRY) {
    return { aec: false, capabilities: [] };
  }
  const state = await readBusinessAecProfile(businessId);
  return { aec: true, capabilities: state.capabilities };
}

/**
 * The business's operating profile, or `null` for a business of another
 * industry.
 *
 * The read a *shared* surface may make: template ordering and any other
 * presentation that must answer "is there an AEC profile here, and which" without
 * the `industry_mismatch` error the API guard turns into a 403. The full
 * profile read stays the strict one.
 */
export async function readAecOperatingProfile(
  businessId: string,
): Promise<AecOperatingProfile | null> {
  if ((await getBusinessIndustry(businessId)) !== AEC_INDUSTRY) return null;
  return (await readBusinessAecProfile(businessId)).operatingProfile;
}

/**
 * One entry a participant picker renders: the role, its Persian label and the
 * group it belongs to.
 */
export interface AecParticipantRoleOption {
  key: AecParticipantRole;
  label: string;
  group: AecParticipantGroup;
}

/**
 * The roles a participant picker may offer, in the order its groups appear.
 *
 * `null` — rather than an error or an empty list — for a business of another
 * industry, so the shared picker endpoint can simply leave AEC out of its
 * payload while an ordinary tenant keeps working. The returned set is the same
 * one `addProjectParticipant` enforces, so a picker built from it cannot offer
 * a role the API would then refuse. It is readable with `workspace.view`
 * rather than `settings.manage`: a project editor may name the client on a
 * project without being allowed to reconfigure the business.
 */
export async function listAecParticipantRoleOptions(
  businessId: string,
): Promise<AecParticipantRoleOption[] | null> {
  if ((await getBusinessIndustry(businessId)) !== AEC_INDUSTRY) return null;
  const state = await readBusinessAecProfile(businessId);
  return state.participantRoles.map((role) => {
    const def = AEC_PARTICIPANT_ROLE_DEFS[role];
    return { key: def.key, label: def.label, group: def.group };
  });
}

/**
 * Persist the operating profile, its specialties and its capability overrides.
 *
 * A field the caller omits keeps its stored value, and a field it sends
 * replaces it. The settings form sends all three; a caller that only wants to
 * flip one override does not silently reset the profile to the default.
 *
 * The overrides are *deltas*: whatever arrives is normalized against the
 * profile in force, so the stored column never restates a preset.
 */
export async function saveBusinessAecProfile(
  owner: WorkspaceOwner,
  input: {
    operatingProfile?: unknown;
    specialties?: unknown;
    capabilityOverrides?: unknown;
  },
): Promise<AecBusinessProfileState> {
  await assertAecIndustry(owner.businessId);
  const current = await loadBusinessAecProfile(owner.businessId);

  const operatingProfile =
    input.operatingProfile === undefined
      ? current.operatingProfile
      : typeof input.operatingProfile === "string" && isAecOperatingProfile(input.operatingProfile)
        ? input.operatingProfile
        : null;
  if (operatingProfile === null) throw new AecError("invalid_operating_profile");

  const specialties =
    input.specialties === undefined
      ? current.specialties
      : normalizeAecSpecialties(Array.isArray(input.specialties) ? input.specialties : []);
  const rawOverrides =
    input.capabilityOverrides === undefined
      ? current.capabilityOverrides
      : input.capabilityOverrides && typeof input.capabilityOverrides === "object"
        ? (input.capabilityOverrides as Record<string, unknown>)
        : {};
  const capabilityOverrides = normalizeAecCapabilityOverrides(rawOverrides, operatingProfile);

  const { rows } = await query<{
    operating_profile: string;
    specialties: string[];
    capability_overrides: Record<string, unknown>;
  }>(
    `INSERT INTO aec_business_profiles
        (business_id, operating_profile, specialties, capability_overrides, updated_at)
     VALUES ($1, $2, $3::text[], $4::jsonb, now())
     ON CONFLICT (business_id) DO UPDATE
        SET operating_profile = EXCLUDED.operating_profile,
            specialties = EXCLUDED.specialties,
            capability_overrides = EXCLUDED.capability_overrides,
            updated_at = now()
     RETURNING operating_profile, specialties, capability_overrides`,
    [owner.businessId, operatingProfile, specialties, JSON.stringify(capabilityOverrides)],
  );
  const row = rows[0];
  return resolveBusinessProfile(
    operatingProfile,
    normalizeAecSpecialties(row?.specialties ?? specialties),
    normalizeAecCapabilityOverrides(row?.capability_overrides ?? capabilityOverrides, operatingProfile),
    true,
  );
}

/**
 * Refuses AEC configuration for a business of another industry.
 *
 * Deliberately a read of `businesses.industry` on every call rather than a
 * session claim: the industry is immutable, but it lives in one place and this
 * is the same helper `requireIndustryForApi` uses, so there is no second source
 * of truth to drift.
 */
export async function assertAecIndustry(businessId: string): Promise<void> {
  if ((await getBusinessIndustry(businessId)) !== AEC_INDUSTRY) {
    throw new AecError("industry_mismatch");
  }
}

/* ===========================================================================
 * One project's AEC profile
 * ======================================================================== */

export interface AecProjectProfile {
  projectId: string;
  projectNumber: string | null;
  projectCategory: string | null;
  siteName: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  latitude: string | null;
  longitude: string | null;
  landArea: string | null;
  builtArea: string | null;
  floorCount: number | null;
  employerPartyId: string | null;
  employerPartyName: string | null;
  leadConsultantPartyId: string | null;
  leadConsultantPartyName: string | null;
  mainContractorPartyId: string | null;
  mainContractorPartyName: string | null;
  projectManagerUserId: string | null;
  projectManagerName: string | null;
  contractMethod: string | null;
  deliveryMethod: string | null;
  permitNumbers: string[];
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  actualStartDate: string | null;
  actualEndDate: string | null;
  plannedPhysicalProgress: string | null;
  reportedPhysicalProgress: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

type ProjectProfileRow = {
  project_id: string;
  project_number: string | null;
  project_category: string | null;
  site_name: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  latitude: string | null;
  longitude: string | null;
  land_area: string | null;
  built_area: string | null;
  floor_count: number | null;
  employer_party_id: string | null;
  employer_party_name: string | null;
  lead_consultant_party_id: string | null;
  lead_consultant_party_name: string | null;
  main_contractor_party_id: string | null;
  main_contractor_party_name: string | null;
  project_manager_user_id: string | null;
  project_manager_name: string | null;
  contract_method: string | null;
  delivery_method: string | null;
  permit_numbers: string[] | null;
  planned_start_date: string | null;
  planned_end_date: string | null;
  actual_start_date: string | null;
  actual_end_date: string | null;
  planned_physical_progress: string | null;
  reported_physical_progress: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
};

function toProjectProfile(row: ProjectProfileRow): AecProjectProfile {
  return {
    projectId: row.project_id,
    projectNumber: row.project_number,
    projectCategory: row.project_category,
    siteName: row.site_name,
    address: row.address,
    city: row.city,
    region: row.region,
    latitude: row.latitude,
    longitude: row.longitude,
    landArea: row.land_area,
    builtArea: row.built_area,
    floorCount: row.floor_count === null ? null : Number(row.floor_count),
    employerPartyId: row.employer_party_id,
    employerPartyName: row.employer_party_name,
    leadConsultantPartyId: row.lead_consultant_party_id,
    leadConsultantPartyName: row.lead_consultant_party_name,
    mainContractorPartyId: row.main_contractor_party_id,
    mainContractorPartyName: row.main_contractor_party_name,
    projectManagerUserId: row.project_manager_user_id,
    projectManagerName: row.project_manager_name,
    contractMethod: row.contract_method,
    deliveryMethod: row.delivery_method,
    permitNumbers: row.permit_numbers ?? [],
    plannedStartDate: row.planned_start_date,
    plannedEndDate: row.planned_end_date,
    actualStartDate: row.actual_start_date,
    actualEndDate: row.actual_end_date,
    plannedPhysicalProgress: row.planned_physical_progress,
    reportedPhysicalProgress: row.reported_physical_progress,
    notes: row.notes,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const PROJECT_PROFILE_SELECT = `
  SELECT p.project_id, p.project_number, p.project_category, p.site_name, p.address,
         p.city, p.region, p.latitude::text, p.longitude::text,
         p.land_area::text, p.built_area::text, p.floor_count,
         p.employer_party_id, employer.name AS employer_party_name,
         p.lead_consultant_party_id, consultant.name AS lead_consultant_party_name,
         p.main_contractor_party_id, contractor.name AS main_contractor_party_name,
         p.project_manager_user_id, manager.full_name AS project_manager_name,
         p.contract_method, p.delivery_method, p.permit_numbers,
         to_char(p.planned_start_date, 'YYYY-MM-DD') AS planned_start_date,
         to_char(p.planned_end_date, 'YYYY-MM-DD') AS planned_end_date,
         to_char(p.actual_start_date, 'YYYY-MM-DD') AS actual_start_date,
         to_char(p.actual_end_date, 'YYYY-MM-DD') AS actual_end_date,
         p.planned_physical_progress::text, p.reported_physical_progress::text,
         p.notes, p.created_at, p.updated_at
    FROM aec_project_profiles p
    LEFT JOIN parties employer   ON employer.id = p.employer_party_id
    LEFT JOIN parties consultant ON consultant.id = p.lead_consultant_party_id
    LEFT JOIN parties contractor ON contractor.id = p.main_contractor_party_id
    LEFT JOIN users manager      ON manager.id = p.project_manager_user_id
   WHERE p.business_id = $1 AND p.project_id = $2`;

/** A project's AEC profile, or null when it has none yet (the common first visit). */
export async function loadProjectAecProfile(
  businessId: string,
  projectId: string,
): Promise<AecProjectProfile | null> {
  await assertAecIndustry(businessId);
  const { rows } = await query<ProjectProfileRow>(PROJECT_PROFILE_SELECT, [businessId, projectId]);
  return rows[0] ? toProjectProfile(rows[0]) : null;
}

/**
 * Create or replace a project's AEC profile.
 *
 * `partial` is false for the form's full save and true for a single-field
 * patch: the form sends every field, so a field it omits is being *cleared*,
 * while a patch (the cockpit's inline edits in a later wave) must leave what it
 * does not name alone. Both paths run the same validation.
 */
export async function saveProjectAecProfile(
  owner: WorkspaceOwner,
  projectId: string,
  input: Record<string, unknown>,
  { partial = false }: { partial?: boolean } = {},
): Promise<AecProjectProfile> {
  await assertAecIndustry(owner.businessId);

  const has = (key: string) => !partial || Object.prototype.hasOwnProperty.call(input, key);
  const text = (key: string, max: number) => (has(key) ? optionalText(input[key], max) : undefined);

  const employerPartyId = has("employerPartyId") ? optionalUuid(input.employerPartyId) : undefined;
  const leadConsultantPartyId = has("leadConsultantPartyId")
    ? optionalUuid(input.leadConsultantPartyId)
    : undefined;
  const mainContractorPartyId = has("mainContractorPartyId")
    ? optionalUuid(input.mainContractorPartyId)
    : undefined;
  const projectManagerUserId = has("projectManagerUserId")
    ? optionalUuid(input.projectManagerUserId)
    : undefined;

  await Promise.all([
    assertPartyOfBusiness(owner.businessId, employerPartyId ?? null),
    assertPartyOfBusiness(owner.businessId, leadConsultantPartyId ?? null),
    assertPartyOfBusiness(owner.businessId, mainContractorPartyId ?? null),
    assertUserOfBusiness(owner.businessId, projectManagerUserId ?? null),
  ]);

  const values = {
    project_number: text("projectNumber", 100),
    project_category: text("projectCategory", 100),
    site_name: text("siteName", 200),
    address: text("address", 1000),
    city: text("city", 100),
    region: text("region", 100),
    latitude: has("latitude")
      ? optionalDecimal(input.latitude, 90, 6, "invalid_coordinate", { signed: true })
      : undefined,
    longitude: has("longitude")
      ? optionalDecimal(input.longitude, 180, 6, "invalid_coordinate", { signed: true })
      : undefined,
    land_area: has("landArea") ? optionalDecimal(input.landArea, 999_999_999_999, 2, "invalid_area") : undefined,
    built_area: has("builtArea") ? optionalDecimal(input.builtArea, 999_999_999_999, 2, "invalid_area") : undefined,
    floor_count: has("floorCount") ? optionalInteger(input.floorCount, 500, "invalid_floor_count") : undefined,
    employer_party_id: employerPartyId,
    lead_consultant_party_id: leadConsultantPartyId,
    main_contractor_party_id: mainContractorPartyId,
    project_manager_user_id: projectManagerUserId,
    contract_method: text("contractMethod", 100),
    delivery_method: text("deliveryMethod", 100),
    permit_numbers: has("permitNumbers") ? stringArray(input.permitNumbers, 30, 100) : undefined,
    planned_start_date: has("plannedStartDate") ? optionalDate(input.plannedStartDate) : undefined,
    planned_end_date: has("plannedEndDate") ? optionalDate(input.plannedEndDate) : undefined,
    actual_start_date: has("actualStartDate") ? optionalDate(input.actualStartDate) : undefined,
    actual_end_date: has("actualEndDate") ? optionalDate(input.actualEndDate) : undefined,
    planned_physical_progress: has("plannedPhysicalProgress")
      ? optionalDecimal(input.plannedPhysicalProgress, 100, 2, "invalid_progress")
      : undefined,
    reported_physical_progress: has("reportedPhysicalProgress")
      ? optionalDecimal(input.reportedPhysicalProgress, 100, 2, "invalid_progress")
      : undefined,
    notes: has("notes") ? trimTo(input.notes, 4000) : undefined,
  };

  const plannedStart = values.planned_start_date ?? null;
  const plannedEnd = values.planned_end_date ?? null;
  if (plannedStart && plannedEnd && plannedEnd < plannedStart) throw new AecError("end_before_start");
  const actualStart = values.actual_start_date ?? null;
  const actualEnd = values.actual_end_date ?? null;
  if (actualStart && actualEnd && actualEnd < actualStart) throw new AecError("end_before_start");

  if (partial) {
    // One statement, and the same one either way: absent fields are simply not
    // named, and a patch against a project that has no profile yet creates the
    // row with what it named — otherwise the first inline edit would silently
    // do nothing.
    const columns = Object.entries(values).filter(([, value]) => value !== undefined);
    if (columns.length > 0) {
      const names = columns.map(([column]) => column);
      const placeholders = names.map((_, index) => `$${index + 3}`);
      const updates = names.map((column) => `${column} = EXCLUDED.${column}`).join(", ");
      await query(
        `INSERT INTO aec_project_profiles (business_id, project_id, ${names.join(", ")}, updated_at)
         VALUES ($1, $2, ${placeholders.join(", ")}, now())
         ON CONFLICT (project_id) DO UPDATE SET ${updates}, updated_at = now()`,
        [owner.businessId, projectId, ...columns.map(([, value]) => value)],
      );
    }
  } else {
    await query(
      `INSERT INTO aec_project_profiles
          (business_id, project_id, project_number, project_category, site_name, address, city, region,
           latitude, longitude, land_area, built_area, floor_count,
           employer_party_id, lead_consultant_party_id, main_contractor_party_id, project_manager_user_id,
           contract_method, delivery_method, permit_numbers,
           planned_start_date, planned_end_date, actual_start_date, actual_end_date,
           planned_physical_progress, reported_physical_progress, notes, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15, $16, $17, $18, $19, $20::text[], $21, $22, $23, $24, $25, $26, $27, now())
       ON CONFLICT (project_id) DO UPDATE
          SET project_number = EXCLUDED.project_number,
              project_category = EXCLUDED.project_category,
              site_name = EXCLUDED.site_name,
              address = EXCLUDED.address,
              city = EXCLUDED.city,
              region = EXCLUDED.region,
              latitude = EXCLUDED.latitude,
              longitude = EXCLUDED.longitude,
              land_area = EXCLUDED.land_area,
              built_area = EXCLUDED.built_area,
              floor_count = EXCLUDED.floor_count,
              employer_party_id = EXCLUDED.employer_party_id,
              lead_consultant_party_id = EXCLUDED.lead_consultant_party_id,
              main_contractor_party_id = EXCLUDED.main_contractor_party_id,
              project_manager_user_id = EXCLUDED.project_manager_user_id,
              contract_method = EXCLUDED.contract_method,
              delivery_method = EXCLUDED.delivery_method,
              permit_numbers = EXCLUDED.permit_numbers,
              planned_start_date = EXCLUDED.planned_start_date,
              planned_end_date = EXCLUDED.planned_end_date,
              actual_start_date = EXCLUDED.actual_start_date,
              actual_end_date = EXCLUDED.actual_end_date,
              planned_physical_progress = EXCLUDED.planned_physical_progress,
              reported_physical_progress = EXCLUDED.reported_physical_progress,
              notes = EXCLUDED.notes,
              updated_at = now()`,
      [
        owner.businessId, projectId,
        values.project_number ?? null, values.project_category ?? null, values.site_name ?? null,
        values.address ?? null, values.city ?? null, values.region ?? null,
        values.latitude ?? null, values.longitude ?? null, values.land_area ?? null,
        values.built_area ?? null, values.floor_count ?? null,
        values.employer_party_id ?? null, values.lead_consultant_party_id ?? null,
        values.main_contractor_party_id ?? null, values.project_manager_user_id ?? null,
        values.contract_method ?? null, values.delivery_method ?? null,
        values.permit_numbers ?? [],
        values.planned_start_date ?? null, values.planned_end_date ?? null,
        values.actual_start_date ?? null, values.actual_end_date ?? null,
        values.planned_physical_progress ?? null, values.reported_physical_progress ?? null,
        values.notes ?? "",
      ],
    );
  }

  const profile = await loadProjectAecProfile(owner.businessId, projectId);
  if (!profile) throw new AecError("project_not_found");
  return profile;
}

/* ===========================================================================
 * Participants
 * ======================================================================== */

export interface AecProjectParticipant {
  id: string;
  partyId: string;
  partyName: string;
  partyRole: string;
  role: AecParticipantRole;
  contactName: string | null;
  notes: string;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type ParticipantRow = {
  id: string;
  party_id: string;
  party_name: string;
  party_role: string;
  role: AecParticipantRole;
  contact_name: string | null;
  notes: string;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
};

function toParticipant(row: ParticipantRow): AecProjectParticipant {
  return {
    id: row.id,
    partyId: row.party_id,
    partyName: row.party_name,
    partyRole: row.party_role,
    role: row.role,
    contactName: row.contact_name,
    notes: row.notes,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const PARTICIPANT_SELECT = `
  SELECT p.id, p.party_id, party.name AS party_name, party.role AS party_role, p.role,
         p.contact_name, p.notes,
         to_char(p.started_at, 'YYYY-MM-DD') AS started_at,
         to_char(p.ended_at, 'YYYY-MM-DD') AS ended_at,
         p.created_at, p.updated_at
    FROM aec_project_participants p
    JOIN parties party ON party.id = p.party_id
   WHERE p.business_id = $1 AND p.project_id = $2`;

/**
 * The people and companies on a project, ordered the way the picker groups
 * them: the client first, then the design side, then the contracting side, then
 * site staff — each group alphabetical by party name, which is the order a
 * Persian reader scans a list of names in.
 */
export async function listProjectParticipants(
  businessId: string,
  projectId: string,
): Promise<AecProjectParticipant[]> {
  await assertAecIndustry(businessId);
  const { rows } = await query<ParticipantRow>(PARTICIPANT_SELECT, [businessId, projectId]);
  const groupOrder = new Map<AecParticipantGroup, number>(
    AEC_PARTICIPANT_GROUPS.map((group, index) => [group, index]),
  );
  return rows
    .map(toParticipant)
    .sort((left, right) => {
      const leftGroup = groupOrder.get(AEC_PARTICIPANT_GROUP_BY_ROLE[left.role]) ?? 99;
      const rightGroup = groupOrder.get(AEC_PARTICIPANT_GROUP_BY_ROLE[right.role]) ?? 99;
      if (leftGroup !== rightGroup) return leftGroup - rightGroup;
      return left.partyName.localeCompare(right.partyName, "fa");
    });
}

/**
 * Records an external party in a professional role on one project.
 *
 * Two rules from the issue's §6 are enforced here, not merely in the picker:
 * the role must be a real catalogue role, and it must be allowed by the
 * business's operating profile — an individual architect who has not switched
 * the subcontracting capability on cannot record a subcontractor. The row is a
 * *record*: it creates no user, no membership and no access.
 */
export async function addProjectParticipant(
  owner: WorkspaceOwner,
  projectId: string,
  input: Record<string, unknown>,
): Promise<AecProjectParticipant[]> {
  const profile = await loadBusinessAecProfile(owner.businessId);
  const role = typeof input.role === "string" ? input.role : "";
  if (!aecParticipantRoleAllowed(capabilityInput(profile), role)) throw new AecError("role_not_allowed");

  const partyId = optionalUuid(input.partyId);
  if (!partyId) throw new AecError("party_not_found");
  await assertPartyOfBusiness(owner.businessId, partyId, "party_not_found");

  const startedAt = optionalDate(input.startedAt);
  const endedAt = optionalDate(input.endedAt);
  if (startedAt && endedAt && endedAt < startedAt) throw new AecError("end_before_start");

  try {
    await query(
      `INSERT INTO aec_project_participants
          (business_id, project_id, party_id, role, contact_name, notes, started_at, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        owner.businessId, projectId, partyId, role,
        optionalText(input.contactName, 200),
        trimTo(input.notes, 2000),
        startedAt, endedAt,
      ],
    );
  } catch (err) {
    // 23505 = the (project, party, role) unique key. The same company cannot
    // hold the same role twice; it may hold two roles (two rows), which is the
    // distinction a construction register needs.
    if ((err as { code?: string }).code === "23505") throw new AecError("participant_exists");
    throw err;
  }

  return listProjectParticipants(owner.businessId, projectId);
}

/** Amend one participant row — its role, its contact person, its window. */
export async function updateProjectParticipant(
  owner: WorkspaceOwner,
  projectId: string,
  participantId: string,
  input: Record<string, unknown>,
): Promise<AecProjectParticipant[]> {
  const { rows: existingRows } = await query<{ role: AecParticipantRole }>(
    `SELECT role FROM aec_project_participants
      WHERE business_id = $1 AND project_id = $2 AND id = $3`,
    [owner.businessId, projectId, participantId],
  );
  const existing = existingRows[0];
  if (!existing) throw new AecError("participant_not_found");

  if (input.role !== undefined && input.role !== existing.role) {
    const profile = await loadBusinessAecProfile(owner.businessId);
    if (typeof input.role !== "string" || !aecParticipantRoleAllowed(capabilityInput(profile), input.role)) {
      throw new AecError("role_not_allowed");
    }
    await query(`UPDATE aec_project_participants SET role = $4, updated_at = now() WHERE business_id = $1 AND project_id = $2 AND id = $3`, [
      owner.businessId, projectId, participantId, input.role,
    ]);
  }

  const startedAt = input.startedAt !== undefined ? optionalDate(input.startedAt) : undefined;
  const endedAt = input.endedAt !== undefined ? optionalDate(input.endedAt) : undefined;
  if (startedAt && endedAt && endedAt < startedAt) throw new AecError("end_before_start");

  const sets: string[] = [];
  const args: unknown[] = [owner.businessId, projectId, participantId];
  const push = (column: string, value: unknown) => {
    args.push(value);
    sets.push(`${column} = $${args.length}`);
  };
  if (input.contactName !== undefined) push("contact_name", optionalText(input.contactName, 200));
  if (input.notes !== undefined) push("notes", trimTo(input.notes, 2000));
  if (startedAt !== undefined) push("started_at", startedAt);
  if (endedAt !== undefined) push("ended_at", endedAt);
  if (sets.length > 0) {
    await query(
      `UPDATE aec_project_participants SET ${sets.join(", ")}, updated_at = now()
        WHERE business_id = $1 AND project_id = $2 AND id = $3`,
      args,
    );
  }

  return listProjectParticipants(owner.businessId, projectId);
}

export async function removeProjectParticipant(
  owner: WorkspaceOwner,
  projectId: string,
  participantId: string,
): Promise<AecProjectParticipant[]> {
  const { rowCount } = await query(
    `DELETE FROM aec_project_participants WHERE business_id = $1 AND project_id = $2 AND id = $3`,
    [owner.businessId, projectId, participantId],
  );
  if (!rowCount) throw new AecError("participant_not_found");
  return listProjectParticipants(owner.businessId, projectId);
}

/* ===========================================================================
 * Reference checks — the friendly layer over the migration's triggers
 * ======================================================================== */

/**
 * A party must belong to this business, still be active and not have been
 * merged away. The migration enforces the tenancy half with a trigger; the
 * service reports the same refusal as a 400 with a code the form can show,
 * rather than letting a `foreign_key_violation` become a 500.
 */
async function assertPartyOfBusiness(
  businessId: string,
  partyId: string | null,
  code = "party_not_found",
): Promise<void> {
  if (!partyId) return;
  const { rows } = await query(
    `SELECT 1 FROM parties
      WHERE id = $1 AND business_id = $2 AND is_active AND merged_into_id IS NULL`,
    [partyId, businessId],
  );
  if (!rows[0]) throw new AecError(code);
}

/** The project manager is an internal user of this business, never a party. */
async function assertUserOfBusiness(businessId: string, userId: string | null): Promise<void> {
  if (!userId) return;
  const { rows } = await query(`SELECT 1 FROM users WHERE id = $1 AND business_id = $2`, [
    userId,
    businessId,
  ]);
  if (!rows[0]) throw new AecError("user_not_found");
}

/* ===========================================================================
 * Milestones — what is coming, not what is late (§22, Wave 10)
 * ======================================================================== */

/** One dated thing in the future: a phase, an open task, or the project itself. */
export interface AecUpcomingMilestone {
  kind: "phase" | "task" | "project";
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  status: string;
  /** Phase only: how much of it is done, so the answer can say "۲ از ۵". */
  taskCount?: number;
  doneTaskCount?: number;
  date: string;
  daysRemaining: number;
}

/**
 * Everything dated inside the next `withinDays` days, soonest first.
 *
 * §22's «نقاط عطف پیش رو» widget and §23's question «چه چیزی تا ماه بعد موعد
 * دارد؟» are the same read, and it is deliberately **not**
 * `list_delayed_project_activities` upside down: the schedule screen shows
 * planned dates (a phase's end date, a task's due date, the project's end date),
 * and this reads exactly those three — the same tables, the same rows, the same
 * business boundary — so the chat answer and the cockpit cannot disagree about
 * what is due next. Only unfinished things are milestones: a completed phase's
 * end date is history.
 *
 * The window is measured against the business's own today, like every other
 * AEC aging read, never the server's date.
 */
export async function upcomingProjectMilestones(
  businessId: string,
  options: { projectId?: string | null; withinDays?: number; limit?: number } = {},
): Promise<AecUpcomingMilestone[]> {
  await assertAecIndustry(businessId);
  const withinDays = Math.min(Math.max(Math.trunc(options.withinDays ?? 30) || 30, 1), 365);
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 25) || 25, 1), 100);
  const today = await businessToday(businessId);
  const windowEnd = addDays(today, withinDays);

  const params: unknown[] = [businessId, today, windowEnd];
  let projectClause = "";
  if (options.projectId) {
    params.push(options.projectId);
    projectClause = ` AND p.id = $${params.length}`;
  }
  params.push(limit);

  const { rows } = await query<{
    kind: string; id: string; title: string; project_id: string; project_name: string;
    status: string; task_count: number | null; done_task_count: number | null;
    date: string; days_remaining: number;
  }>(
    `SELECT 'phase'::text AS kind, ph.id, ph.name AS title, p.id AS project_id, p.name AS project_name,
            ph.status,
            (SELECT count(*)::integer FROM ai_project_tasks t WHERE t.phase_id = ph.id) AS task_count,
            (SELECT count(*)::integer FROM ai_project_tasks t
              WHERE t.phase_id = ph.id AND t.status = 'done') AS done_task_count,
            ph.end_date::text AS date,
            (ph.end_date - $2::date)::integer AS days_remaining
       FROM workspace_project_phases ph
       JOIN ai_projects p ON p.id = ph.project_id
      WHERE p.business_id = $1 AND p.archived_at IS NULL${projectClause}
        AND ph.end_date IS NOT NULL AND ph.end_date >= $2::date AND ph.end_date <= $3::date
        AND ph.status NOT IN ('done', 'skipped')
     UNION ALL
     SELECT 'task'::text, t.id, t.title, p.id, p.name, t.status, NULL, NULL,
            t.due_date::text, (t.due_date - $2::date)::integer
       FROM ai_project_tasks t
       JOIN ai_projects p ON p.id = t.project_id
      WHERE p.business_id = $1 AND p.archived_at IS NULL${projectClause}
        AND t.status <> 'done' AND t.due_date IS NOT NULL
        AND t.due_date >= $2::date AND t.due_date <= $3::date
     UNION ALL
     SELECT 'project'::text, p.id, p.name, p.id, p.name, p.status, NULL, NULL,
            p.end_date::text, (p.end_date - $2::date)::integer
       FROM ai_projects p
      WHERE p.business_id = $1 AND p.archived_at IS NULL${projectClause}
        AND p.end_date IS NOT NULL AND p.end_date >= $2::date AND p.end_date <= $3::date
     ORDER BY date, kind, title
     LIMIT $${params.length}`,
    params,
  );

  return rows.map((row) => ({
    kind: row.kind as AecUpcomingMilestone["kind"],
    id: row.id,
    title: row.title,
    projectId: row.project_id,
    projectName: row.project_name,
    status: row.status,
    ...(row.kind === "phase"
      ? { taskCount: Number(row.task_count ?? 0), doneTaskCount: Number(row.done_task_count ?? 0) }
      : {}),
    date: row.date,
    daysRemaining: Number(row.days_remaining ?? 0),
  }));
}
