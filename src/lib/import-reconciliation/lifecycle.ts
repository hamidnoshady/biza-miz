/**
 * Run lifecycle, gating, truthful progress — pure.
 *
 * The questions this file answers are the ones a screen, a plugin handshake
 * and the apply worker must all answer the same way:
 *
 *  - May a source write straight away, or must it be staged first? (`evaluateFirstRunGate`)
 *  - Is the preview the owner approved still true? (`isPreviewStale`)
 *  - What may an owner decide, and what would applying it do? (`effectForDecision`)
 *  - How far along are we — without ever saying "fully synced" when only
 *    queued or partially applied? (`summarizeItems`, `progressStage`)
 *  - May an outbound update (price, stock) be published yet? (`canPublishOutbound`)
 */

import {
  ACTIVE_RUN_STATUSES,
  SAFE_OUTCOMES,
  allowedDecisions,
  type ReconciliationDecision,
  type ReconciliationEffect,
  type ReconciliationImportMode,
  type ReconciliationItemStatus,
  type ReconciliationOutcome,
  type ReconciliationRunStatus,
} from "./types";

// ---------------------------------------------------------------------------
// Run state machine
// ---------------------------------------------------------------------------

const RUN_TRANSITIONS: Record<ReconciliationRunStatus, readonly ReconciliationRunStatus[]> = {
  discovering: ["staged", "failed", "cancelled"],
  staged: ["in_review", "applying", "stale", "cancelled"],
  in_review: ["in_review", "applying", "stale", "cancelled"],
  applying: ["applied", "partially_applied", "failed"],
  // A run that applied part of its items can be resumed: more review, more applying.
  partially_applied: ["in_review", "applying", "stale", "cancelled"],
  // A stale run re-evaluates back into review; it cannot be applied as it stands.
  stale: ["discovering", "staged", "cancelled"],
  applied: [],
  failed: ["staged", "cancelled"],
  cancelled: [],
};

export function canTransitionRun(from: ReconciliationRunStatus, to: ReconciliationRunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function isRunActive(status: ReconciliationRunStatus): boolean {
  return ACTIVE_RUN_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// First-run gate
// ---------------------------------------------------------------------------

export interface OutcomeCounts {
  alreadyLinked: number;
  safeMatch: number;
  createNew: number;
  fieldConflict: number;
  ambiguous: number;
  invalid: number;
  historicalMatch: number;
  skipped: number;
  failed: number;
}

export function emptyOutcomeCounts(): OutcomeCounts {
  return {
    alreadyLinked: 0,
    safeMatch: 0,
    createNew: 0,
    fieldConflict: 0,
    ambiguous: 0,
    invalid: 0,
    historicalMatch: 0,
    skipped: 0,
    failed: 0,
  };
}

export function countOutcomes(outcomes: readonly ReconciliationOutcome[]): OutcomeCounts {
  const counts = emptyOutcomeCounts();
  for (const outcome of outcomes) {
    switch (outcome) {
      case "already_linked": counts.alreadyLinked += 1; break;
      case "safe_match": counts.safeMatch += 1; break;
      case "create_new": counts.createNew += 1; break;
      case "field_conflict": counts.fieldConflict += 1; break;
      case "ambiguous": counts.ambiguous += 1; break;
      case "invalid": counts.invalid += 1; break;
      case "historical_match": counts.historicalMatch += 1; break;
      case "skipped": counts.skipped += 1; break;
      case "failed": counts.failed += 1; break;
    }
  }
  return counts;
}

export type GatePath = "fast" | "staged";

export interface GateDecision {
  path: GatePath;
  /** Persian-safe machine codes the screen renders; never free text. */
  reasons: Array<"preview_only" | "populated_domain" | "needs_review" | "empty_domain" | "all_linked">;
}

/**
 * May this source write immediately ("fast path") or must it be staged first?
 *
 * Staged is the default. The fast path exists for exactly two cases the issue
 * names — an empty domain, and records that all ride a verified mapping — and
 * only when nothing needs a person. A preview-only run never writes at all, so
 * it is always staged.
 */
export function evaluateFirstRunGate(input: {
  /** How many canonical rows of this domain/scope the business already has. */
  canonicalCount: number;
  counts: OutcomeCounts;
  mode: ReconciliationImportMode;
}): GateDecision {
  const { canonicalCount, counts, mode } = input;
  if (mode === "preview_only") return { path: "staged", reasons: ["preview_only"] };

  const total =
    counts.alreadyLinked + counts.safeMatch + counts.createNew + counts.fieldConflict + counts.ambiguous +
    counts.invalid + counts.historicalMatch + counts.skipped + counts.failed;
  const needsPerson = counts.fieldConflict + counts.ambiguous + counts.invalid + counts.safeMatch > 0;
  if (needsPerson) return { path: "staged", reasons: ["needs_review"] };

  if (total > 0 && counts.alreadyLinked === total) return { path: "fast", reasons: ["all_linked"] };
  if (canonicalCount === 0) return { path: "fast", reasons: ["empty_domain"] };
  return { path: "staged", reasons: ["populated_domain"] };
}

// ---------------------------------------------------------------------------
// Stale-preview check
// ---------------------------------------------------------------------------

export interface PreviewFingerprint {
  /**
   * Identity of the source version the preview was built from (file hash,
   * schema/profile, cursor). `null` on the *current* side means the source
   * could not be reached, which makes the preview unverified.
   */
  sourceFingerprint: string | null;
  /** Version of the field-authority policy in force. */
  policyVersion: number;
  /** A digest of the canonical state the matches were computed against. */
  canonicalToken: string | null;
}

export type StaleReason = "source_changed" | "policy_changed" | "canonical_changed" | "expired";

export interface StaleCheck {
  stale: boolean;
  reasons: StaleReason[];
  /**
   * True when the current state could not be checked (offline, source
   * unreachable). The preview is then shown as unverified — it is neither
   * declared fresh nor claimed reconciled.
   */
  unverified: boolean;
}

export function isPreviewStale(input: {
  staged: PreviewFingerprint & { stagedAt: Date };
  /** A `null` token or fingerprint ⇒ that side could not be read right now. */
  current: PreviewFingerprint;
  now: Date;
  maxAgeMs?: number;
}): StaleCheck {
  const { staged, current, now, maxAgeMs } = input;
  const reasons: StaleReason[] = [];
  const unverified =
    current.canonicalToken == null || staged.canonicalToken == null || current.sourceFingerprint == null;
  if (current.sourceFingerprint != null && staged.sourceFingerprint !== current.sourceFingerprint) {
    reasons.push("source_changed");
  }
  if (staged.policyVersion !== current.policyVersion) reasons.push("policy_changed");
  if (
    staged.canonicalToken != null &&
    current.canonicalToken != null &&
    staged.canonicalToken !== current.canonicalToken
  ) {
    reasons.push("canonical_changed");
  }
  if (maxAgeMs != null && now.getTime() - staged.stagedAt.getTime() > maxAgeMs) reasons.push("expired");
  return { stale: reasons.length > 0, reasons, unverified };
}

// ---------------------------------------------------------------------------
// Decisions → effects
// ---------------------------------------------------------------------------

/**
 * What applying an item does, given the verdict and the owner's decision.
 * Returns `null` when the decision is not allowed for that verdict — the
 * service turns that into a refusal, so a screen cannot offer (and an API
 * caller cannot force) a move the engine ruled out.
 */
export function effectForDecision(
  outcome: ReconciliationOutcome,
  decision: ReconciliationDecision,
  hasCandidates: boolean,
): ReconciliationEffect | null {
  if (!allowedDecisions(outcome, hasCandidates).includes(decision)) return null;
  switch (decision) {
    case "link":
      return "link";
    case "create_separate":
      return "create";
    case "skip":
      return "skip";
    case "choose_authority":
      // The owner settled which side owns each field; the link itself stands.
      return "link";
    case "keep_for_review":
      return "none";
  }
}

/** Items that may be approved in one click: nothing overlaps, or the link is already verified. */
export function isBatchApprovable(item: { outcome: ReconciliationOutcome; status: ReconciliationItemStatus }): boolean {
  return item.status === "proposed" && SAFE_OUTCOMES.includes(item.outcome) && item.outcome !== "already_linked";
}

// ---------------------------------------------------------------------------
// Truthful progress
// ---------------------------------------------------------------------------

export interface ItemView {
  outcome: ReconciliationOutcome;
  status: ReconciliationItemStatus;
}

export interface ReconciliationCounts {
  read: number;
  alreadyMapped: number;
  proposedLinks: number;
  newRecords: number;
  /** field_conflict + ambiguous, regardless of whether they are decided yet. */
  conflicts: number;
  invalid: number;
  historical: number;
  /** Not yet decided: `proposed` or `held`. */
  pending: number;
  approved: number;
  skipped: number;
  applied: number;
  failed: number;
}

export function summarizeItems(items: readonly ItemView[]): ReconciliationCounts {
  const counts: ReconciliationCounts = {
    read: items.length,
    alreadyMapped: 0,
    proposedLinks: 0,
    newRecords: 0,
    conflicts: 0,
    invalid: 0,
    historical: 0,
    pending: 0,
    approved: 0,
    skipped: 0,
    applied: 0,
    failed: 0,
  };
  for (const item of items) {
    switch (item.outcome) {
      case "already_linked": counts.alreadyMapped += 1; break;
      case "safe_match": counts.proposedLinks += 1; break;
      case "create_new": counts.newRecords += 1; break;
      case "field_conflict":
      case "ambiguous": counts.conflicts += 1; break;
      case "invalid": counts.invalid += 1; break;
      case "historical_match": counts.historical += 1; break;
      default: break;
    }
    switch (item.status) {
      case "proposed":
      case "held": counts.pending += 1; break;
      case "approved": counts.approved += 1; break;
      case "skipped": counts.skipped += 1; break;
      case "applied": counts.applied += 1; break;
      case "failed": counts.failed += 1; break;
    }
  }
  return counts;
}

export const PROGRESS_STAGES = ["read", "staged", "reviewed", "applying", "acknowledged", "reconciled"] as const;
export type ProgressStage = (typeof PROGRESS_STAGES)[number];

export const PROGRESS_STAGE_LABELS: Record<ProgressStage, string> = {
  read: "در حال خواندن",
  staged: "آمادهٔ بررسی",
  reviewed: "بررسی‌شده، آمادهٔ اعمال",
  applying: "در حال اعمال",
  acknowledged: "اعمال‌شده، در انتظار تطبیق نهایی",
  reconciled: "تطبیق کامل",
};

export interface Progress {
  stage: ProgressStage;
  label: string;
  /**
   * The only flag a screen may use to say "fully synced". It is true solely
   * when every item is terminal (applied or deliberately skipped), none failed
   * or is waiting, and the post-apply cross-check passed.
   */
  fullyReconciled: boolean;
  remaining: number;
}

export function progressStage(input: {
  runStatus: ReconciliationRunStatus;
  counts: ReconciliationCounts;
  /** The post-apply cross-check of counts/identities/stock/totals has passed. */
  crossChecked: boolean;
}): Progress {
  const { runStatus, counts, crossChecked } = input;
  const remaining = counts.pending + counts.approved + counts.failed;
  const allTerminal = counts.read > 0 && remaining === 0;

  let stage: ProgressStage;
  if (runStatus === "discovering") stage = "read";
  else if (runStatus === "applying") stage = "applying";
  else if (allTerminal && (runStatus === "applied" || runStatus === "partially_applied")) {
    stage = crossChecked ? "reconciled" : "acknowledged";
  } else if (counts.pending === 0 && counts.approved > 0) stage = "reviewed";
  else if (counts.applied > 0 && remaining > 0) stage = "acknowledged";
  else stage = "staged";

  // Never claim a stronger stage than the run itself supports.
  if (stage === "reconciled" && runStatus !== "applied") stage = "acknowledged";
  return { stage, label: PROGRESS_STAGE_LABELS[stage], fullyReconciled: stage === "reconciled", remaining };
}

// ---------------------------------------------------------------------------
// Outbound publish gate
// ---------------------------------------------------------------------------

/**
 * Outbound updates (price/stock pushed to a website or accounting source) go
 * out only after ownership and the mapping are committed and the item is
 * applied — and never from a preview, a stale run, or a rejected remote value.
 */
export function canPublishOutbound(input: {
  runStatus: ReconciliationRunStatus;
  itemStatus: ReconciliationItemStatus;
  mappingCommitted: boolean;
  ownershipConfirmed: boolean;
}): boolean {
  if (input.runStatus === "stale" || input.runStatus === "cancelled" || input.runStatus === "failed") return false;
  return input.itemStatus === "applied" && input.mappingCommitted && input.ownershipConfirmed;
}
