import type { Industry } from "./industries";

/**
 * Issue #1128 §A — the advertising agency's *sales* pipeline, as a preset.
 *
 * §A asks for "inbound lead intake, opportunity pipeline, client briefs,
 * qualification, proposals/quotes, scope of work and contract renewals", and
 * then constrains how: new leads and opportunities "must reuse canonical CRM
 * records and existing dedup, activity history, consent, ownership and tenant
 * permissions". So this module adds no table, no entity and no engine. It is a
 * list of stage names with probabilities, outcomes and the requirement each
 * stage asks for — data the platform's own `crm_pipeline_stages` already holds,
 * and which `savePipelineStages` already validates and writes.
 *
 * ## Why a second pipeline rather than different seed stages
 *
 * `SEED_STAGES` in `crm-pipeline-service.ts` carries an explicit warning: the
 * six it seeds are the six the pre-0157 CHECK allowed, "so a freshly provisioned
 * business and an upgraded one have structurally identical pipelines. Anything
 * else would mean two code paths to test and a subtle difference nobody notices
 * until a report disagrees between two tenants."
 *
 * Forking that seed by industry is exactly what the comment argues against, and
 * the argument holds: a win-rate or forecast report keyed on the default
 * pipeline must mean the same thing for every tenant. So the agency gets its own
 * pipeline *beside* the universal default — which `createPipeline`'s own
 * docblock already anticipates, naming "a tender track, an after-sales track" as
 * the reason a second board exists. The default stays structurally identical
 * everywhere; the agency's track is an addition a member can rename, reorder,
 * edit or mark default through the same UI every other trade uses.
 *
 * That is also why these stages carry no `legacy_key`. `SaveStageInput` has no
 * such field, and `legacyStageKey` exists to recognise the pre-0157 strings —
 * a stage a business configures for itself has none, and neither does this one.
 * Reusing `lead`/`proposal`/`won` as legacy keys would have made reports keyed
 * on the legacy vocabulary count agency stages as though they were the seeded
 * ones, which is the silent disagreement the warning is about.
 *
 * ## A preset orders and labels; it never gates
 *
 * Nothing here restricts what an agency may do, and nothing makes another trade
 * unable to build the same pipeline by hand. It is the starting point the issue
 * asks for, not a rule — the same line #1128 draws for operating presets.
 *
 * Framework-free and side-effect-free: a type-only import and no `pg`, so it is
 * unit-testable and safe to import from either side of the client boundary.
 */

/** What a stage's outcome is, mirroring `StageOutcome` in the pipeline service. */
export type AgencyStageOutcome = "open" | "won" | "lost";

/**
 * One stage of the preset, in the shape `savePipelineStages` accepts.
 *
 * `requirementNote` is the stage's own exit criterion — the thing a member has
 * to have in hand before the deal ought to move on. It is guidance written to
 * the row the board already renders, not a validation rule, so it cannot block
 * anybody; §A's "qualification" is expressed as advice rather than as a gate.
 */
export interface AgencyPipelineStagePreset {
  name: string;
  displayOrder: number;
  defaultProbability: number;
  outcome: AgencyStageOutcome;
  requirementNote: string;
}

/** The pipeline's name, which is also its idempotency key (see below). */
export const AGENCY_PIPELINE_NAME = "قیف فروش آژانس";

export const AGENCY_PIPELINE_DESCRIPTION =
  "مراحل فروش کار آژانس: از سرنخ ورودی تا بریف کارفرما، پیشنهاد قیمت و قرارداد.";

/**
 * §A's list, in the order an agency actually sells: inbound intake,
 * qualification, the brief, the proposal, the contract, and the two outcomes.
 *
 * Probabilities rise monotonically to `won` so a forecast over this pipeline is
 * not nonsense, and there is at least one `open` and exactly one `won` stage —
 * the two invariants `savePipelineStages` refuses to save without, so this
 * preset can never be rejected by the function that writes it.
 */
export const AGENCY_PIPELINE_STAGES: readonly AgencyPipelineStagePreset[] = [
  {
    name: "سرنخ ورودی",
    displayOrder: 1,
    defaultProbability: 10,
    outcome: "open",
    requirementNote: "منبع ورود، نام کسب‌وکار و درخواست اولیهٔ کارفرما ثبت شود.",
  },
  {
    name: "واجد شرایط",
    displayOrder: 2,
    defaultProbability: 25,
    outcome: "open",
    requirementNote: "بودجه، بازهٔ زمانی و تصمیم‌گیرندهٔ نهایی روشن شود.",
  },
  {
    name: "بریف کارفرما",
    displayOrder: 3,
    defaultProbability: 40,
    outcome: "open",
    requirementNote: "بریف کارفرما ثبت و با او مرور شود: هدف، مخاطب، کانال‌ها و معیار پذیرش.",
  },
  {
    name: "پیشنهاد و پیش‌فاکتور",
    displayOrder: 4,
    defaultProbability: 60,
    outcome: "open",
    requirementNote: "پیشنهاد قیمت و دامنهٔ کار برای کارفرما ارسال شود.",
  },
  {
    name: "دامنهٔ کار و قرارداد",
    displayOrder: 5,
    defaultProbability: 80,
    outcome: "open",
    requirementNote: "شرح دامنهٔ کار توافق و قرارداد امضا یا تمدید شود.",
  },
  {
    name: "برنده",
    displayOrder: 6,
    defaultProbability: 100,
    outcome: "won",
    requirementNote: "",
  },
  {
    name: "بازنده",
    displayOrder: 7,
    defaultProbability: 0,
    outcome: "lost",
    requirementNote: "",
  },
];

/**
 * The preset for one trade, or null where §A does not apply.
 *
 * Only `advertising_agency` gets it. A preset that every trade received would
 * be a rename of the default pipeline rather than an agency capability, and one
 * that any trade could receive would make the report-divergence warning above
 * true for tenants nobody intended to change.
 */
export function agencyPipelinePreset(
  industry: Industry | string,
): { name: string; description: string; stages: readonly AgencyPipelineStagePreset[] } | null {
  if (industry !== "advertising_agency") return null;
  return {
    name: AGENCY_PIPELINE_NAME,
    description: AGENCY_PIPELINE_DESCRIPTION,
    stages: AGENCY_PIPELINE_STAGES,
  };
}

/**
 * Whether a pipeline is this preset, by name.
 *
 * `(business_id, name)` is unique in `crm_pipelines`, and that is what makes
 * creating the preset idempotent under concurrency — the same trick
 * `defaultPipeline` already relies on with its `ON CONFLICT DO NOTHING`. A read
 * path that creates what it needs must be able to recognise what it already
 * made, and the name is the only stable handle it has.
 */
export function isAgencyPipelineName(name: unknown): boolean {
  return typeof name === "string" && name.trim() === AGENCY_PIPELINE_NAME;
}

/** True when the preset satisfies both invariants `savePipelineStages` enforces. */
export function agencyPresetIsSavable(
  stages: readonly AgencyPipelineStagePreset[] = AGENCY_PIPELINE_STAGES,
): boolean {
  return stages.some((stage) => stage.outcome === "open") && stages.some((stage) => stage.outcome === "won");
}
