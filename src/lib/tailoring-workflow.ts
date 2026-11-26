/**
 * GH #1567 Phase 6A — tailoring / alterations: the pure rules.
 *
 * Framework-free and side-effect-free so the workflow and the measurement
 * allow-list are unit-tested directly (tailoring-workflow.test.ts); the
 * service only enforces what this file decides.
 *
 * Workflow: intake → estimated → approved → fitting (repeatable; may be
 * skipped for a simple alteration) → qc → ready → picked_up. QC failure is a
 * rework back to fitting. Cancel is possible until the garment is ready.
 */

export const TAILORING_STATUSES = [
  "intake", "estimated", "approved", "fitting", "qc", "ready", "picked_up", "cancelled",
] as const;
export type TailoringStatus = (typeof TAILORING_STATUSES)[number];
export type TailoringKind = "alteration" | "made_to_measure";

export const TAILORING_STATUS_LABELS: Record<TailoringStatus, string> = {
  intake: "پذیرش",
  estimated: "برآورد شده",
  approved: "تأیید مشتری",
  fitting: "پرو",
  qc: "کنترل کیفیت",
  ready: "آمادهٔ تحویل",
  picked_up: "تحویل شده",
  cancelled: "لغو شده",
};

const TRANSITIONS: Record<TailoringStatus, readonly TailoringStatus[]> = {
  intake: ["estimated", "cancelled"],
  estimated: ["estimated", "approved", "cancelled"],
  approved: ["fitting", "qc", "cancelled"],
  fitting: ["fitting", "qc", "cancelled"],
  qc: ["ready", "fitting", "cancelled"],
  ready: ["picked_up"],
  picked_up: [],
  cancelled: [],
};

export interface TailoringJobState {
  status: TailoringStatus;
  kind: TailoringKind;
  estimateRial: bigint | null;
  orderId: string | null;
}

export interface TailoringTransitionInput {
  to: TailoringStatus;
  estimateRial?: bigint | null;
  /** Approval is the customer's decision, recorded explicitly. */
  customerApproved?: boolean;
  /** QC outcome when leaving `qc`. */
  qcPassed?: boolean;
  note?: string | null;
}

export type TailoringTransitionError =
  | "tailoring_transition_invalid"
  | "tailoring_estimate_required"
  | "tailoring_customer_approval_required"
  | "tailoring_fitting_required"
  | "tailoring_qc_outcome_required"
  | "tailoring_order_required";

export interface TailoringTransitionPlan {
  to: TailoringStatus;
  estimateRial: bigint | null;
  approve: boolean;
  fitting: boolean;
  rework: boolean;
}

/**
 * Decide one transition. Returns the plan the service writes, or the reason
 * it is refused. A made-to-measure garment cannot skip fitting; an alteration
 * can. Pickup of a priced job needs the sale (an order) linked first, so the
 * money goes through the ordinary order/invoice path and nowhere else.
 */
export function planTailoringTransition(
  job: TailoringJobState,
  input: TailoringTransitionInput,
): { ok: true; plan: TailoringTransitionPlan } | { ok: false; error: TailoringTransitionError } {
  if (!TRANSITIONS[job.status].includes(input.to)) return { ok: false, error: "tailoring_transition_invalid" };
  let estimateRial = job.estimateRial;
  if (input.to === "estimated") {
    if (input.estimateRial === undefined || input.estimateRial === null || input.estimateRial < BigInt(0)) {
      return { ok: false, error: "tailoring_estimate_required" };
    }
    estimateRial = input.estimateRial;
  }
  if (input.to === "approved" && input.customerApproved !== true) {
    return { ok: false, error: "tailoring_customer_approval_required" };
  }
  if (job.status === "approved" && input.to === "qc" && job.kind === "made_to_measure") {
    return { ok: false, error: "tailoring_fitting_required" };
  }
  if (job.status === "qc" && input.to !== "cancelled") {
    if (input.qcPassed === undefined) return { ok: false, error: "tailoring_qc_outcome_required" };
    if ((input.to === "ready") !== input.qcPassed) return { ok: false, error: "tailoring_transition_invalid" };
  }
  if (input.to === "picked_up" && (job.estimateRial ?? BigInt(0)) > BigInt(0) && !job.orderId) {
    return { ok: false, error: "tailoring_order_required" };
  }
  return {
    ok: true,
    plan: {
      to: input.to,
      estimateRial,
      approve: input.to === "approved",
      fitting: input.to === "fitting",
      rework: job.status === "qc" && input.to === "fitting",
    },
  };
}

// ---------------------------------------------------------------------------
// Measurements: minimal by construction. A fixed allow-list of body
// measurements, numbers only — no free text, no photos — so nothing beyond
// what a tailor needs can be stored.

export const TAILORING_MEASUREMENT_FIELDS = {
  neck: "دور گردن",
  chest: "دور سینه",
  waist: "دور کمر",
  hip: "دور باسن",
  shoulder: "سرشانه",
  sleeve: "قد آستین",
  bicep: "دور بازو",
  wrist: "دور مچ",
  back_width: "کارور پشت",
  front_length: "قد جلو",
  back_length: "قد پشت",
  garment_length: "قد لباس",
  inseam: "فاق تا مچ (داخل پا)",
  outseam: "قد شلوار",
  thigh: "دور ران",
  knee: "دور زانو",
  calf: "دور ساق",
  rise: "فاق",
} as const;
export type TailoringMeasurementField = keyof typeof TAILORING_MEASUREMENT_FIELDS;
export type TailoringUnit = "cm" | "in";

export interface TailoringMeasurements {
  unit: TailoringUnit;
  values: Partial<Record<TailoringMeasurementField, number>>;
}

const MAX_BY_UNIT: Record<TailoringUnit, number> = { cm: 300, in: 120 };

/**
 * Validate a measurement set. Unknown keys are refused (not dropped), every
 * value is a positive number with at most one decimal place inside a human
 * range, and at least one value is required.
 */
export function parseTailoringMeasurements(raw: unknown):
  | { ok: true; value: TailoringMeasurements }
  | { ok: false; error: "tailoring_measurements_invalid"; field?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "tailoring_measurements_invalid" };
  const { unit, values } = raw as { unit?: unknown; values?: unknown };
  if (unit !== "cm" && unit !== "in") return { ok: false, error: "tailoring_measurements_invalid", field: "unit" };
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return { ok: false, error: "tailoring_measurements_invalid", field: "values" };
  }
  const out: Partial<Record<TailoringMeasurementField, number>> = {};
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (!Object.hasOwn(TAILORING_MEASUREMENT_FIELDS, key)) return { ok: false, error: "tailoring_measurements_invalid", field: key };
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_BY_UNIT[unit] ||
        Math.round(value * 10) !== value * 10) {
      return { ok: false, error: "tailoring_measurements_invalid", field: key };
    }
    out[key as TailoringMeasurementField] = value;
  }
  if (Object.keys(out).length === 0) return { ok: false, error: "tailoring_measurements_invalid", field: "values" };
  return { ok: true, value: { unit, values: out } };
}

/** A stated reason for opening someone's measurements; logged with the access. */
export function parseAccessPurpose(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim().replace(/\s+/gu, " ");
  return text.length >= 3 && text.length <= 300 ? text : null;
}

/** Retention: what a purge would erase on `today`. Pure so the rule is testable. */
export function retentionCutoff(today: Date, retentionDays: number): Date {
  return new Date(today.getTime() - retentionDays * 86_400_000);
}
