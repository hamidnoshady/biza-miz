/**
 * Playbook (ready-to-run business template) contracts — issue #1590 / ESH-233,
 * consolidating retired #1012. One declarative, centrally versioned catalog
 * supporting BOTH CRM and Growth while respecting their distinct execution
 * services. Two canonical executor types only; no parallel automation runtime.
 *
 * Framework-free: safe to import from server, client, tests, and (pure halves)
 * the Superadmin Template Studio.
 */
import type { Industry } from "../industries";
import type { AppKey } from "../apps";
import type { Permission } from "../permissions";
import type { ModuleKey } from "../industry-profile";
import type { BusinessGoal, BusinessSize } from "../adaptive-context";

// ---------------------------------------------------------------------------
// Owning app + execution binding
// ---------------------------------------------------------------------------

export const PLAYBOOK_APPS = ["crm", "growth"] as const;
export type PlaybookApp = (typeof PLAYBOOK_APPS)[number];

/** The only two canonical executor types. */
export const EXECUTOR_TYPES = ["crm", "growth"] as const;
export type ExecutorType = (typeof EXECUTOR_TYPES)[number];

/**
 * CRM-native actions. Authorized CRM task / assignment / queue / saved-view /
 * activity / relationship operations via canonical CRM services. **Never**
 * sends marketing messages or performs financial changes.
 */
export const CRM_EXECUTOR_ACTIONS = [
  "crm.create_tasks", // create assignable CRM follow-up tasks (kind=task) on matched records
  "crm.saved_view", // create/replace a canonical CRM saved view (filtered queue)
  "crm.queue_snapshot", // materialize a read-only attention queue snapshot (no record mutation)
  "crm.duplicate_review_queue", // surface duplicates for explicit human merge; never auto-merge
] as const;
export type CrmExecutorAction = (typeof CRM_EXECUTOR_ACTIONS)[number];

/**
 * Growth actions. Bound to existing #901 campaign primitives + Phase-37
 * message campaigns. Never a second sending/ledger engine.
 */
export const GROWTH_EXECUTOR_ACTIONS = [
  "growth.message_campaign_draft", // create message template + segment + draft message_campaign (no send)
  "growth.message_campaign_launch", // draft + launch via launchMessageCampaign (consent re-checked; requires approval flag)
  "growth.campaign_builder_draft", // #901 createCampaign draft + simulate (no reward execution; honest prerequisite)
] as const;
export type GrowthExecutorAction = (typeof GROWTH_EXECUTOR_ACTIONS)[number];

export interface ExecutionBinding {
  executor: ExecutorType;
  action: CrmExecutorAction | GrowthExecutorAction;
  /**
   * Stable reference into the canonical service. For Growth, which canonical
   * engine; for CRM, which entity queue. Never an arbitrary code/SQL string.
   */
  canonicalService: string;
  /** Whether explicit human approval is required before any outbound/financial effect. */
  requiresApproval: boolean;
  /** Whether launching requires online + configured integration (never claimed offline). */
  requiresOnline: boolean;
  /** CRM-only playbooks must never silently hand off to Growth; explicit draft handoff only. */
  handsOffToGrowth?: boolean;
}

// ---------------------------------------------------------------------------
// Typed quick-input schema (NO JSON / rule graphs / arbitrary code)
// ---------------------------------------------------------------------------

export const QUICK_INPUT_TYPES = [
  "text",
  "number",
  "money_rial",
  "boolean",
  "enum",
  "branch",
  "member",
  "segment",
  "channel",
  "schedule",
  "duration_days",
  "date",
] as const;
export type QuickInputType = (typeof QUICK_INPUT_TYPES)[number];

export interface QuickInputField {
  key: string;
  type: QuickInputType;
  labelFa: string;
  labelEn?: string;
  required: boolean;
  /** Safe authorized default; `null` = none. */
  default?: string | number | boolean | null;
  /** For `enum`. */
  options?: { value: string; labelFa: string }[];
  /** Inclusive bounds for number/money/duration. */
  min?: number;
  max?: number;
  helpFa?: string;
  /** Filled from authorized tenant data when available; never trusted from the caller. */
  derivedFrom?: string;
}

export interface QuickInputSchema {
  fields: QuickInputField[];
}

// ---------------------------------------------------------------------------
// Eligibility / capabilities
// ---------------------------------------------------------------------------

/** Required capability keys (module keys + canonical capability strings). */
export interface CapabilityRequirement {
  /** Industry module keys that must be enabled. */
  modules: ModuleKey[];
  /** Apps that must be enabled. */
  apps: AppKey[];
  /** Free-form capability keys (messaging, campaigns, inventory, ...). */
  capabilities: string[];
}

/** Required data sources; a template missing required data is `requires_setup`. */
export interface DataRequirement {
  key: string;
  labelFa: string;
  /** `required` blocks execution; `optional` only enriches. */
  requirement: "required" | "optional";
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export const PREFLIGHT_STATES = ["ok", "warn", "blocked", "unknown"] as const;
export type PreflightState = (typeof PREFLIGHT_STATES)[number];

export interface PreflightCheck {
  key: string;
  labelFa: string;
  state: PreflightState;
  detailFa?: string;
}

/** `unknown` is rendered نامشخص and is never reported as zero. */
export interface AudiencePreflight {
  /** Everyone matching rules, before consent. `null` = unknown. */
  totalMatched: number | null;
  /** Consent-qualified reachable audience. `null` = unknown. */
  reachable: number | null;
  /** Missing contact / suppressed / excluded count. `null` = unknown. */
  excluded: number | null;
  exclusionReasonsFa: string[];
}

export interface CostPreflight {
  /** Estimated integer Rial; `null` = unknown (نامشخص), never zero. */
  estimatedRial: number | null;
  /** Actual integer Rial once known. */
  actualRial: number | null;
  /** Reward/discount liability in integer Rial; `null` = unknown. */
  liabilityRial: number | null;
  currencyDisplay: "rial" | "toman";
  noteFa?: string;
}

export interface Preflight {
  checks: PreflightCheck[];
  audience: AudiencePreflight;
  cost: CostPreflight;
  /** Source-data freshness; `null` = unknown. */
  sourceFreshness?: { key: string; lastUpdatedAt: string | null }[];
  /** Overlapping running workflows on the same records; `null` = unknown. */
  overlappingWorkflows: number | null;
  sendFrequencyLimitFa?: string;
  quietWindowFa?: string;
  requiresApproval: boolean;
  /** Pause / stop / rollback availability after launch. */
  canPause: boolean;
  canCancel: boolean;
  rollbackFa?: string;
  /** Expected-outcome definitions surfaced before run. */
  kpiSummaryFa: string[];
  /** Truthful gate: never a fake Run. */
  blocked: boolean;
  blockedReasonsFa: string[];
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/** KPI kinds; revenue kinds require defensible source + attribution window. */
export const KPI_SOURCES = [
  "crm_activity",
  "crm_lead",
  "crm_deal",
  "crm_case",
  "crm_duplicate_resolution",
  "crm_saved_view",
  "settled_order",
  "accounting_revenue",
  "voucher_redemption",
  "inventory_aging",
  "message_delivery",
  "campaign_spend",
  "observed_reach",
  "verified_referral",
  "meeting_booked",
  "none",
] as const;
export type KpiSource = (typeof KPI_SOURCES)[number];

export interface KpiDefinition {
  key: string;
  labelFa: string;
  source: KpiSource;
  /** What is counted (denominator/numerator honesty). */
  definitionFa: string;
  /** pipeline-influenced vs attributed vs incremental vs confirmed accounting. */
  revenueClass?: "pipeline_influenced" | "attributed" | "incremental_uplift" | "confirmed_accounting" | "none";
  /** Attribution window in days; `null` = N/A. */
  attributionWindowDays?: number | null;
  /** Whether a baseline + control is required to claim uplift/ROI. */
  requiresBaselineForUplift?: boolean;
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

export const PUBLICATION_STATES = ["draft", "review", "published", "archived"] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];

export const AVAILABILITY_STATES = [
  "available",
  "requires_setup",
  "unavailable",
  "coming_later",
] as const;
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

// ---------------------------------------------------------------------------
// Lifecycle of an instance
// ---------------------------------------------------------------------------

export const INSTANCE_STATES = [
  "draft",
  "pending_approval",
  "scheduled",
  "running",
  "paused",
  "completed",
  "failed",
  "canceled",
] as const;
export type InstanceState = (typeof INSTANCE_STATES)[number];

/** Allowed transitions; anything else is rejected. */
export const INSTANCE_TRANSITIONS: Record<InstanceState, readonly InstanceState[]> = {
  draft: ["pending_approval", "scheduled", "running", "canceled", "failed"],
  pending_approval: ["scheduled", "running", "draft", "canceled", "failed"],
  scheduled: ["running", "paused", "canceled", "failed"],
  running: ["paused", "completed", "canceled", "failed"],
  paused: ["running", "scheduled", "canceled", "failed", "completed"],
  completed: [],
  failed: ["draft", "scheduled", "running", "canceled"], // retry creates new attempt, idempotent
  canceled: [],
};

export function canTransition(from: InstanceState, to: InstanceState): boolean {
  if (from === to) return false;
  return (INSTANCE_TRANSITIONS[from] ?? []).includes(to);
}

// ---------------------------------------------------------------------------
// Localization
// ---------------------------------------------------------------------------

export interface LocalizedText {
  titleFa: string;
  titleEn?: string;
  summaryFa: string; // one-line "what this does"
  summaryEn?: string;
  /** Clear business outcome. */
  outcomeFa: string;
  outcomeEn?: string;
}

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

export interface PlaybookTemplate {
  /** Stable key, e.g. `crm.follow_up_new_lead`. */
  key: string;
  /** Semantic version of the template definition. */
  version: string;
  /** Catalog schema version. */
  schemaVersion: number;
  owningApp: PlaybookApp;
  publicationState: PublicationState;
  /** Baseline availability; runtime eligibility is computed per tenant. */
  availability: AvailabilityState;
  localized: LocalizedText;
  businessGoals: BusinessGoal[];
  tags: string[];
  /** Business-goal category label key. */
  category: BusinessGoal;
  /** Canonical registry industry keys, or `["all"]`. Never invents keys. */
  supportedIndustries: readonly (Industry | "all")[];
  /** Recommendation-only size defaults; never a permission. */
  sizeDefaults: readonly BusinessSize[];
  /** Extra industry-specific recommendation boost keys. */
  industryBoost?: readonly Industry[];
  requiredCapabilities: CapabilityRequirement;
  requiredPermissions: readonly Permission[];
  /** Permission that ALSO grants launch (often stricter than view). */
  launchPermission: Permission;
  /** Permission required to see results/financial outcomes. */
  resultsPermission: Permission | null;
  requiredData: DataRequirement[];
  quickInputSchema: QuickInputSchema;
  /** 2–3 understandable execution steps shown on the card. */
  stepsFa: string[];
  /** Validated setup-time estimate in minutes; `null` = نامشخص. */
  setupMinutes: number | null;
  /** Cost classification (no invented numbers). */
  costClass: "free" | "credit" | "paid" | "unknown";
  /** Channel keys if any (sms/email/...). */
  channels: string[];
  /** Trigger kind key. */
  trigger: string;
  executionBinding: ExecutionBinding;
  measurement: KpiDefinition[];
  /** Persian one-liner safety note. */
  safetyNoteFa?: string;
}

// ---------------------------------------------------------------------------
// Catalog validation
// ---------------------------------------------------------------------------

export const PLAYBOOK_SCHEMA_VERSION = 1;

export interface CatalogProblem {
  key: string;
  message: string;
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const KEY = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export function validatePlaybook(t: PlaybookTemplate): CatalogProblem[] {
  const problems: CatalogProblem[] = [];
  const p = (message: string) => problems.push({ key: t.key || "(missing)", message });

  if (!KEY.test(t.key)) p("key must be `app.snake_case`");
  if (!SEMVER.test(t.version)) p("version must be semantic x.y.z");
  if (t.schemaVersion !== PLAYBOOK_SCHEMA_VERSION) p(`schemaVersion must be ${PLAYBOOK_SCHEMA_VERSION}`);
  if (!PLAYBOOK_APPS.includes(t.owningApp)) p("owningApp invalid");
  if (!PUBLICATION_STATES.includes(t.publicationState)) p("publicationState invalid");
  if (!AVAILABILITY_STATES.includes(t.availability)) p("availability invalid");
  if (!t.localized?.titleFa?.trim()) p("localized.titleFa required");
  if (!t.localized?.summaryFa?.trim()) p("localized.summaryFa required");
  if (!t.localized?.outcomeFa?.trim()) p("localized.outcomeFa required");
  if (!Array.isArray(t.businessGoals) || t.businessGoals.length === 0) p("businessGoals required");
  if (!Array.isArray(t.supportedIndustries) || t.supportedIndustries.length === 0) p("supportedIndustries required");
  if (!EXECUTOR_TYPES.includes(t.executionBinding?.executor)) p("executionBinding.executor invalid");
  const executorPrefix = t.executionBinding?.executor === "crm" ? "crm." : "growth.";
  if (typeof t.executionBinding?.action !== "string" || !t.executionBinding.action.startsWith(executorPrefix)) {
    p("executionBinding.action must match executor");
  }
  if (!t.executionBinding?.canonicalService?.trim()) p("executionBinding.canonicalService required");
  if (!Array.isArray(t.requiredPermissions)) p("requiredPermissions must be array");
  if (!t.launchPermission) p("launchPermission required");
  if (!Array.isArray(t.stepsFa) || t.stepsFa.length < 2 || t.stepsFa.length > 3) p("stepsFa must have 2–3 steps");
  if (t.setupMinutes !== null && (typeof t.setupMinutes !== "number" || t.setupMinutes < 0)) p("setupMinutes invalid");
  if (!Array.isArray(t.measurement) || t.measurement.length === 0) p("measurement KPI required");
  // CRM playbooks must never silently marketing-message or move money.
  if (t.executionBinding?.executor === "crm") {
    const bad = ["growth.", "send", "message_outbox"].some((x) => t.executionBinding.action.includes(x));
    if (bad) p("CRM executor must not send marketing or move money");
  }
  // Safety: no arbitrary code/SQL anywhere in a definition.
  const json = JSON.stringify(t);
  if (/"(sql|query|javascript|eval|script)"\s*:/i.test(json)) p("no arbitrary SQL/JS fields allowed");

  for (const f of t.quickInputSchema?.fields ?? []) {
    if (!f.key?.trim()) p("quickInput field.key required");
    if (!QUICK_INPUT_TYPES.includes(f.type)) p(`quickInput ${f.key} type invalid`);
    if (f.type === "enum" && (!f.options || f.options.length === 0)) p(`quickInput ${f.key} enum needs options`);
  }
  return problems;
}
