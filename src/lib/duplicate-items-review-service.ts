/**
 * Issue #1207 §C — the duplicate review the Accounting products screen shows.
 *
 * The report (`duplicate-items-report.ts`), the classification
 * (`duplicate-items.ts`) and the archive plan (`duplicate-items-resolution.ts`
 * with `duplicate-items-resolve-service.ts`) already existed and are reused
 * here unchanged in behaviour. What this file adds is the seam a screen needs:
 *
 *  - one read that returns a group *and* its plan, so the panel can show the
 *    evidence and the one safe action together;
 *  - a review token, hashed from what the reader was shown, so confirming
 *    cannot act on a plan that changed in the meantime (the same
 *    preview-invalidation shape the publication panel uses);
 *  - «نگهداری جداگانه»: an audited decision that two rows stay apart, stored in
 *    `audit_log` (no new table) and read back to stop the same candidate being
 *    reported forever;
 *  - «حفظ سابقه»: the same shape for a row that historic orders/invoices keep
 *    referencing — kept active, explicitly not a deduplication, and refused
 *    while the row still holds stock;
 *  - one explicit `resolution` per group (`pending_review`, `safely_archived`,
 *    `blocked_stock`, `blocked_history`, `kept_separate`, `history_retained`,
 *    `restored`, …), so an archived duplicate stops flagging the product.
 *
 * Nothing here merges, deletes, re-points a mapping or aggregates two stock
 * snapshots. The only write to `items` is the existing reversible archive,
 * which re-checks its guards under a row lock inside its own transaction.
 */
import { createHash } from "node:crypto";
import { query, withTenant, withTenantTransaction } from "./db";
import {
  verdictNeedsAction,
  RESOLVED_DUPLICATE_STATES,
  type DuplicateResolutionState,
  type DuplicateVerdict,
} from "./duplicate-items";
import { findDuplicateItemGroups, type DuplicateReportMember } from "./duplicate-items-report";
import {
  archiveDuplicateOrphans,
  planOrphanArchivesForGroups,
  restoreArchivedDuplicateItem,
  type ArchiveOrphansResult,
} from "./duplicate-items-resolve-service";
import { duplicateAmbiguityNotes, keepSeparateReasons } from "./duplicate-items-copy";
import type { OrphanBlocker, OrphanPlan } from "./duplicate-items-resolution";

/** The audit row a «نگهداری جداگانه» decision writes. */
export const KEEP_SEPARATE_ACTION = "item.duplicate_kept_separate";

/**
 * The audit row written when a reference-carrying row is deliberately kept as
 * the historical record. It is a disposition, not a deduplication: the row
 * stays active and the sales/invoice lines keep pointing at it.
 */
export const HISTORY_RETAINED_ACTION = "item.duplicate_history_retained";

const ARCHIVE_ACTIONS = [
  "item.duplicate_orphan_archived",
  "item.duplicate_historical_archived",
  "item.duplicate_variant_orphan_archived",
] as const;
const RESTORE_ACTION = "item.duplicate_archive_restored";

/**
 * What the reader is looking at, after the plan and the recorded decisions are
 * combined. The first six are the states the review screen must distinguish;
 * `archived_elsewhere` exists so a row a person archived for an unrelated
 * reason is never presented as "safely archived" by this workflow.
 */
const RESOLVED_STATES = RESOLVED_DUPLICATE_STATES;

export interface DuplicateReviewGroup {
  sku: string;
  verdict: DuplicateVerdict;
  /** Whether the verdict is something a person must decide about. */
  needsAction: boolean;
  /** The explicit state this group is in (archive/blocked/decisions). */
  resolution: DuplicateResolutionState;
  /** No operator decision is outstanding (archived, kept separate, history kept). */
  resolved: boolean;
  /** True only when this workflow actually archived the duplicate row. */
  deduplicated: boolean;
  /** A «نگهداری جداگانه» or «حفظ سابقه» decision recorded for exactly these rows. */
  reviewed: boolean;
  reviewedAt: string | null;
  /** Why this candidate is ambiguous — empty for the two legitimate verdicts. */
  notes: string[];
  /** The distinctions that would justify keeping the rows apart. */
  separateReasons: string[];
  members: DuplicateReportMember[];
  /** The archive plan when the verdict is one of the planned duplicate shapes; null otherwise. */
  plan: OrphanPlan | null;
  /** What a confirmation must echo back; changes whenever the evidence does. */
  reviewToken: string;
}

interface KeepSeparateRow extends Record<string, unknown> {
  sku: string | null;
  item_ids: string[] | null;
  action: string;
  created_at: Date;
}

function memberKey(members: readonly { itemId: string }[]): string {
  return members
    .map((member) => member.itemId)
    .sort()
    .join(",");
}

/**
 * The token covers the verdict, every row in the group and the plan's own
 * shape — so a new twin, an archived twin, a row that gained stock or a
 * newly-blocking reference each invalidate a review a reader confirmed a
 * moment ago.
 */
function reviewTokenFor(group: {
  sku: string;
  verdict: DuplicateVerdict;
  members: readonly { itemId: string }[];
  plan: OrphanPlan | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sku: group.sku,
        verdict: group.verdict,
        members: memberKey(group.members),
        plan: group.plan
          ? {
              kind: group.plan.kind,
              orphanItemId: group.plan.orphanItemId,
              twinItemId: group.plan.twinItemId,
              daysApart: group.plan.daysApart,
              status: group.plan.status,
              blockers: [...group.plan.blockers].sort(),
              references: group.plan.references.map((reference) => `${reference.table}.${reference.column}:${reference.count}`).sort(),
            }
          : null,
      }),
    )
    .digest("hex");
}

/** The disposition rows (keep separate / history retained) for the SKUs in hand, newest first. */
async function dispositionRows(businessId: string, skus: readonly string[]): Promise<KeepSeparateRow[]> {
  if (skus.length === 0) return [];
  return withTenant(businessId, async () => {
    const { rows } = await query<KeepSeparateRow>(
      `SELECT payload ->> 'sku' AS sku,
              ARRAY(SELECT jsonb_array_elements_text(payload -> 'itemIds')) AS item_ids,
              action, created_at
         FROM audit_log
        WHERE business_id = $1 AND action = ANY($2::text[]) AND payload ->> 'sku' = ANY($3::text[])
        ORDER BY created_at DESC`,
      [businessId, [KEEP_SEPARATE_ACTION, HISTORY_RETAINED_ACTION], skus],
    );
    return rows;
  });
}

/** The latest archive/restore audit action per item id, for the rows in hand. */
async function archiveAuditByItem(
  businessId: string,
  itemIds: readonly string[],
): Promise<Map<string, { action: string; at: number }>> {
  if (itemIds.length === 0) return new Map();
  return withTenant(businessId, async () => {
    const { rows } = await query<{ entity_id: string; action: string; created_at: Date }>(
      `SELECT DISTINCT ON (entity_id) entity_id::text, action, created_at
         FROM audit_log
        WHERE business_id = $1 AND entity = 'item' AND entity_id = ANY($2::text[])
          AND action = ANY($3::text[])
        ORDER BY entity_id, created_at DESC`,
      [businessId, itemIds, [...ARCHIVE_ACTIONS, RESTORE_ACTION]],
    );
    return new Map(rows.map((row) => [row.entity_id, { action: row.action, at: row.created_at.getTime() }]));
  });
}

/**
 * Combine the plan and the recorded decisions into one explicit state.
 *
 * Stock and history blockers are kept apart: an owner can retain a historical
 * row's references without touching its stock, but a stocked row still needs a
 * stock-authority decision and stays blocked.
 */
function resolutionFor(
  group: { verdict: DuplicateVerdict; members: readonly { itemId: string }[] },
  plan: OrphanPlan | null,
  decision: KeepSeparateRow | undefined,
  lastArchiveEvent: { action: string; at: number } | undefined,
): DuplicateResolutionState {
  const decisionState =
    decision?.action === HISTORY_RETAINED_ACTION
      ? ("history_retained" as const)
      : decision?.action === KEEP_SEPARATE_ACTION
        ? ("kept_separate" as const)
        : null;
  // A newer archive/restore beats an older disposition, and vice versa: the
  // screen must reflect what happened last, not the first decision ever made.
  const decisionAt = decision ? decision.created_at.getTime() : Number.NEGATIVE_INFINITY;
  const archiveAt = lastArchiveEvent?.at ?? Number.NEGATIVE_INFINITY;
  if (decisionState && decisionAt >= archiveAt) return decisionState;
  const lastArchiveAction = lastArchiveEvent?.action;

  if (plan) {
    if (plan.status === "already_archived") {
      const archivedByThis = lastArchiveAction != null && (ARCHIVE_ACTIONS as readonly string[]).includes(lastArchiveAction);
      return archivedByThis ? "safely_archived" : "archived_elsewhere";
    }
    if (plan.status === "archive") {
      // A row this workflow already archived once and a person restored: still
      // actionable, but the screen should say what happened.
      return lastArchiveAction === RESTORE_ACTION ? "restored" : "pending_review";
    }
    if (plan.blockers.includes("nonzero_stock") || plan.blockers.includes("inventory_unchecked")) {
      return "blocked_stock";
    }
    if (plan.blockers.includes("has_references")) return "blocked_history";
    return "blocked_other";
  }
  return verdictNeedsAction(group.verdict) ? "pending_review" : "not_a_duplicate";
}

/**
 * Every duplicate group worth showing, with its plan and review state.
 *
 * `sku` narrows it to one code, which is what a row's «بررسی محصول تکراری»
 * does. The read itself is the report's own — read-only, tenant-scoped.
 */
export async function loadDuplicateReviewGroups(
  businessId: string,
  options: { sku?: string | null; locationId?: string | null } = {},
): Promise<DuplicateReviewGroup[]> {
  const groups = await findDuplicateItemGroups(businessId, {
    sku: options.sku ?? null,
    locationId: options.locationId ?? null,
  });
  if (groups.length === 0) return [];
  const plans = await planOrphanArchivesForGroups(businessId, groups);
  const decisions = await dispositionRows(businessId, groups.map((group) => group.sku));
  const archiveAudit = await archiveAuditByItem(
    businessId,
    groups.flatMap((group) => group.members.map((member) => member.itemId)),
  );

  return groups.map((group) => {
    const plan = plans.find((candidate) => group.members.some((member) => member.itemId === candidate.orphanItemId)) ?? null;
    const key = memberKey(group.members);
    const decision = decisions.find((row) => row.sku === group.sku && [...(row.item_ids ?? [])].sort().join(",") === key);
    const shaped = { sku: group.sku, verdict: group.verdict, members: group.members, plan };
    const resolution = resolutionFor(group, plan, decision, plan ? archiveAudit.get(plan.orphanItemId) : undefined);
    const resolved = RESOLVED_STATES.has(resolution);
    return {
      ...shaped,
      resolution,
      resolved,
      deduplicated: resolution === "safely_archived",
      needsAction: verdictNeedsAction(group.verdict) && !resolved,
      reviewed: Boolean(decision),
      reviewedAt: decision ? decision.created_at.toISOString() : null,
      notes: duplicateAmbiguityNotes(group.verdict, group.members),
      separateReasons: keepSeparateReasons(group.members),
      reviewToken: reviewTokenFor(shaped),
    };
  });
}

/** One row's own group, or null when its SKU is unique. */
export async function loadDuplicateReviewForItem(
  businessId: string,
  sku: string | null,
  options: { locationId?: string | null } = {},
): Promise<DuplicateReviewGroup | null> {
  if (!sku) return null;
  const groups = await loadDuplicateReviewGroups(businessId, { sku, locationId: options.locationId ?? null });
  return groups[0] ?? null;
}

/**
 * The SKUs a list needs to flag, and nothing else — the report without the
 * plans, for a catalogue screen that runs on every visit. The full evidence is
 * read per SKU, only when a reader opens the review.
 */
export async function listDuplicateCandidateSkus(
  businessId: string,
  options: { locationId?: string | null } = {},
): Promise<string[]> {
  const groups = (await findDuplicateItemGroups(businessId, { locationId: options.locationId ?? null })).filter((group) =>
    verdictNeedsAction(group.verdict),
  );
  if (groups.length === 0) return [];
  // Reconciliation status is part of the question: a group whose duplicate row
  // is archived, or whose rows were explicitly kept apart / retained, must not
  // keep flagging the product. This stays a lightweight read (no per-group plan).
  const decisions = await dispositionRows(businessId, groups.map((group) => group.sku));
  return groups
    .filter((group) => {
      const key = memberKey(group.members);
      const decided = decisions.some(
        (row) => row.sku === group.sku && [...(row.item_ids ?? [])].sort().join(",") === key,
      );
      if (decided) return false;
      const orphans = group.members.filter((member) => member.mappings.length === 0);
      return !(orphans.length > 0 && orphans.every((member) => !member.isActive));
    })
    .map((group) => group.sku);
}

/** A candidate that needs a person's attention and has not been decided yet. */
export function isUnresolvedDuplicate(group: DuplicateReviewGroup | null): boolean {
  return Boolean(group && group.needsAction && !group.resolved);
}

/** Refuses a confirmation whose evidence changed since it was shown. */
export async function assertReviewToken(
  businessId: string,
  sku: string,
  reviewToken: string,
  options: { locationId?: string | null } = {},
): Promise<DuplicateReviewGroup> {
  const group = await loadDuplicateReviewForItem(businessId, sku, options);
  if (!group) throw new Error("duplicate_review_not_found");
  if (group.reviewToken !== reviewToken) throw new Error("duplicate_review_changed");
  return group;
}

/** Record that two (or more) rows share a SKU on purpose and stay separate. */
export async function recordDuplicateKeepSeparate(
  businessId: string,
  input: { sku: string; reviewToken: string; actorUserId: string | null; locationId?: string | null },
): Promise<DuplicateReviewGroup> {
  return recordDisposition(businessId, { ...input, action: KEEP_SEPARATE_ACTION });
}

/**
 * Record that a reference-carrying row is kept as the historical record.
 *
 * This is explicitly **not** a deduplication: the row stays active, its orders,
 * invoices and price history keep pointing at it, and the duplicate is not
 * archived. It is only offered where the only blocker is history — a row that
 * also holds stock still needs the owner's stock-authority decision.
 */
export async function recordDuplicateHistoryRetained(
  businessId: string,
  input: { sku: string; reviewToken: string; actorUserId: string | null; locationId?: string | null },
): Promise<DuplicateReviewGroup> {
  const group = await assertReviewToken(businessId, input.sku, input.reviewToken, {
    locationId: input.locationId ?? null,
  });
  const plan = group.plan;
  if (!plan || !plan.blockers.includes("has_references")) throw new Error("duplicate_history_not_referenced");
  if (plan.blockers.includes("nonzero_stock") || plan.blockers.includes("inventory_unchecked")) {
    throw new Error("duplicate_history_has_stock");
  }
  return recordDisposition(businessId, { ...input, action: HISTORY_RETAINED_ACTION });
}

async function recordDisposition(
  businessId: string,
  input: {
    sku: string;
    reviewToken: string;
    actorUserId: string | null;
    locationId?: string | null;
    action: typeof KEEP_SEPARATE_ACTION | typeof HISTORY_RETAINED_ACTION;
  },
): Promise<DuplicateReviewGroup> {
  const group = await assertReviewToken(businessId, input.sku, input.reviewToken, {
    locationId: input.locationId ?? null,
  });
  await withTenantTransaction(businessId, async (client) => {
    await client.query(
      `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, $3, $4, 'item', $5, $6::jsonb)`,
      [
        businessId,
        group.members[0]?.locationId ?? null,
        input.actorUserId,
        input.action,
        group.members[0]?.itemId ?? null,
        JSON.stringify({
          sku: group.sku,
          verdict: group.verdict,
          itemIds: group.members.map((member) => member.itemId),
          ...(input.action === HISTORY_RETAINED_ACTION
            ? {
                references: group.plan?.references ?? [],
                orphanItemId: group.plan?.orphanItemId ?? null,
                deduplicated: false,
              }
            : {}),
        }),
      ],
    );
  });
  return assertReviewToken(businessId, input.sku, group.reviewToken, { locationId: input.locationId ?? null });
}

/**
 * Archive one proven duplicate — the ten-minute race twin or the weeks-apart
 * historical twin — through the existing guarded archive. A plan that is not
 * `archive` (blocked, already archived) refuses here too: the screen never
 * widens what the script allows.
 */
export async function archiveDuplicateOrphanFromReview(
  businessId: string,
  input: {
    sku: string;
    orphanItemId: string;
    reviewToken: string;
    actorUserId: string | null;
    locationId?: string | null;
  },
): Promise<{ archived: OrphanPlan | null; blockers: OrphanBlocker[] }> {
  const group = await assertReviewToken(businessId, input.sku, input.reviewToken, {
    locationId: input.locationId ?? null,
  });
  const plan = group.plan;
  if (!plan || plan.orphanItemId !== input.orphanItemId) throw new Error("duplicate_review_plan_changed");
  if (plan.status !== "archive") return { archived: null, blockers: plan.blockers };
  const result: ArchiveOrphansResult = await archiveDuplicateOrphans(businessId, [plan], {
    actorUserId: input.actorUserId,
  });
  const archived = result.archived[0] ?? null;
  return {
    archived,
    blockers: archived ? [] : result.changedSincePlan[0]?.blockers ?? ["has_references"],
  };
}

/**
 * Undo the archive of the plan's own orphan. The token must still describe the
 * `already_archived` plan, so a row that changed after the read is refused.
 */
export async function restoreDuplicateFromReview(
  businessId: string,
  input: {
    sku: string;
    itemId: string;
    reviewToken: string;
    actorUserId: string | null;
    locationId?: string | null;
  },
): Promise<{ restored: boolean; reason?: "not_found" | "already_active" | "not_duplicate_archive" }> {
  const group = await assertReviewToken(businessId, input.sku, input.reviewToken, {
    locationId: input.locationId ?? null,
  });
  if (!group.plan || group.plan.orphanItemId !== input.itemId || group.plan.status !== "already_archived") {
    throw new Error("duplicate_review_plan_changed");
  }
  return restoreArchivedDuplicateItem(businessId, { itemId: input.itemId, actorUserId: input.actorUserId });
}
