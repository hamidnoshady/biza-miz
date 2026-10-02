/**
 * Phase 43 — AEC (مهندسی عمران، معماری و پیمانکاری) domain types.
 *
 * One industry, many profiles: an AEC business is always
 * architecture_construction at the industry level. What it *is* — an office,
 * an engineering company, a contractor, a solo practitioner — is an operating
 * profile that drives which My Workspace capabilities are surfaced and which
 * defaults a new project gets. Profiles are additive presets, not a parallel
 * industry discriminator.
 *
 * Framework-free like industries.ts/industry-profile.ts.
 */
import type { Industry } from "./industries";

export const AEC_INDUSTRY: Industry = "architecture_construction";

export const AEC_OPERATING_PROFILES = [
  "architecture_office",
  "civil_engineering",
  "contractor",
  "design_build",
  "consulting_supervision",
  "multidisciplinary",
  "team",
  "individual",
] as const;
export type AecOperatingProfile = (typeof AEC_OPERATING_PROFILES)[number];

export const AEC_OPERATING_PROFILE_LABELS: Record<AecOperatingProfile, string> = {
  architecture_office: "دفتر معماری",
  civil_engineering: "شرکت مهندسی عمران/سازه",
  contractor: "پیمانکار",
  design_build: "طراحی و اجرا",
  consulting_supervision: "مشاور / نظارت",
  multidisciplinary: "مهندسی چندرشته‌ای",
  team: "تیم کوچک",
  individual: "شخصی / فریلنسر",
};

export const AEC_SPECIALTIES = [
  "architecture",
  "structural",
  "civil",
  "electrical",
  "mechanical",
  "landscape",
  "interior",
  "urban_planning",
  "surveying",
  "geotechnical",
] as const;
export type AecSpecialty = (typeof AEC_SPECIALTIES)[number];

export const AEC_SPECIALTY_LABELS: Record<AecSpecialty, string> = {
  architecture: "معماری",
  structural: "سازه",
  civil: "عمران",
  electrical: "برق",
  mechanical: "مکانیک",
  landscape: "منظر",
  interior: "دکوراسیون داخلی",
  urban_planning: "شهرسازی",
  surveying: "نقشه‌برداری",
  geotechnical: "ژئوتکنیک",
};

export function isAecOperatingProfile(value: string): value is AecOperatingProfile {
  return (AEC_OPERATING_PROFILES as readonly string[]).includes(value);
}
export function isAecSpecialty(value: string): value is AecSpecialty {
  return (AEC_SPECIALTIES as readonly string[]).includes(value);
}

export type AecCapability =
  | "aec_project_profile"
  | "aec_templates"
  | "aec_boq"
  | "aec_document_control"
  | "aec_rfi"
  | "aec_submittals"
  | "aec_transmittals"
  | "aec_daily_logs"
  | "aec_inspections"
  | "aec_variations"
  | "aec_certificates"
  | "aec_procurement"
  | "aec_commercial_forecast";

/**
 * Which AEC capabilities each operating profile enables. Additive — a
 * multidisciplinary firm gets the union of the design + execution sets; an
 * individual gets a minimal subset. Gate code reads this, not a hand-written
 * if ladder per feature.
 */
export const AEC_PROFILE_CAPABILITIES: Record<AecOperatingProfile, readonly AecCapability[]> = {
  architecture_office: [
    "aec_project_profile",
    "aec_templates",
    "aec_boq",
    "aec_document_control",
    "aec_rfi",
    "aec_submittals",
    "aec_transmittals",
  ],
  civil_engineering: [
    "aec_project_profile",
    "aec_templates",
    "aec_boq",
    "aec_document_control",
    "aec_rfi",
    "aec_submittals",
    "aec_transmittals",
    "aec_inspections",
  ],
  contractor: [
    "aec_project_profile",
    "aec_templates",
    "aec_boq",
    "aec_document_control",
    "aec_daily_logs",
    "aec_inspections",
    "aec_variations",
    "aec_certificates",
    "aec_procurement",
    "aec_commercial_forecast",
  ],
  design_build: [
    "aec_project_profile",
    "aec_templates",
    "aec_boq",
    "aec_document_control",
    "aec_rfi",
    "aec_submittals",
    "aec_transmittals",
    "aec_daily_logs",
    "aec_inspections",
    "aec_variations",
    "aec_certificates",
    "aec_procurement",
    "aec_commercial_forecast",
  ],
  consulting_supervision: [
    "aec_project_profile",
    "aec_templates",
    "aec_document_control",
    "aec_rfi",
    "aec_submittals",
    "aec_transmittals",
    "aec_inspections",
  ],
  multidisciplinary: [
    "aec_project_profile",
    "aec_templates",
    "aec_boq",
    "aec_document_control",
    "aec_rfi",
    "aec_submittals",
    "aec_transmittals",
    "aec_daily_logs",
    "aec_inspections",
    "aec_variations",
    "aec_certificates",
    "aec_procurement",
    "aec_commercial_forecast",
  ],
  team: ["aec_project_profile", "aec_templates", "aec_boq", "aec_document_control", "aec_daily_logs"],
  individual: ["aec_project_profile", "aec_templates", "aec_boq"],
};

export function aecCapabilitiesForProfile(profile: AecOperatingProfile): readonly AecCapability[] {
  return AEC_PROFILE_CAPABILITIES[profile];
}

export function hasAecCapability(profile: AecOperatingProfile, capability: AecCapability): boolean {
  return AEC_PROFILE_CAPABILITIES[profile].includes(capability);
}

/**
 * Totally public marketing note: which capabilities an AEC business is
 * *expected* to have by virtue of being AEC. The console still gates per
 * profile; this is only for describing the trade in copy, not for enforcing.
 */
export const AEC_CAPABILITIES: readonly AecCapability[] = [
  "aec_project_profile",
  "aec_templates",
  "aec_boq",
  "aec_document_control",
  "aec_rfi",
  "aec_submittals",
  "aec_transmittals",
  "aec_daily_logs",
  "aec_inspections",
  "aec_variations",
  "aec_certificates",
  "aec_procurement",
  "aec_commercial_forecast",
] as const;
