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
 *    reported forever.
 *
 * Nothing here merges, deletes, re-points a mapping or aggregates two stock
 * snapshots. The only write to `items` is the existing reversible archive,
 * which re-checks its guards under a row lock inside its own transaction.
 */
import { createHash } from "node:crypto";
import { query, withTenant, withTenantTransaction } from "./db";
import {
  verdictNeedsAction,
  type DuplicateVerdict,
} from "./duplicate-items";
import { findDuplicateItemGroups, type DuplicateReportMember } from "./duplicate-items-report";
import {
  archiveDuplicateOrphans,
  planOrphanArchivesForGroups,
  type ArchiveOrphansResult,
} from "./duplicate-items-resolve-service";
import { duplicateAmbiguityNotes, keepSeparateReasons } from "./duplicate-items-copy";
import type { OrphanBlocker, OrphanPlan } from "./duplicate-items-resolution";

/** The audit row a «نگهداری جداگانه» decision writes. */
export const KEEP_SEPARATE_ACTION = "item.duplicate_kept_separate";

export interface DuplicateReviewGroup {
  sku: string;
  verdict: DuplicateVerdict;
  /** Whether the verdict is something a person must decide about. */
  needsAction: boolean;
  /** A «نگهداری جداگانه» decision recorded for exactly these rows. */
  reviewed: boolean;
  reviewedAt: string | null;
  /** Why this candidate is ambiguous — empty for the two legitimate verdicts. */
  notes: string[];
  /** The distinctions that would justify keeping the rows apart. */
  separateReasons: string[];
  members: DuplicateReportMember[];
  /** The archive plan when the verdict is `race_orphan`; null otherwise. */
  plan: OrphanPlan | null;
  /** What a confirmation must echo back; changes whenever the evidence does. */
  reviewToken: string;
}

interface KeepSeparateRow extends Record<string, unknown> {
  sku: string | null;
  item_ids: string[] | null;
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
 * shape — so a new twin, an archived twin or a newly-blocking reference each
 * invalidate a review a reader confirmed a moment ago.
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
              orphanItemId: group.plan.orphanItemId,
              twinItemId: group.plan.twinItemId,
              status: group.plan.status,
              blockers: [...group.plan.blockers].sort(),
              references: group.plan.references.map((reference) => `${reference.table}.${reference.column}:${reference.count}`).sort(),
            }
          : null,
      }),
    )
    .digest("hex");
}

/** The latest «نگهداری جداگانه» decisions for the SKUs in hand, newest first. */
async function keepSeparateDecisions(businessId: string, skus: readonly string[]): Promise<KeepSeparateRow[]> {
  if (skus.length === 0) return [];
  return withTenant(businessId, async () => {
    const { rows } = await query<KeepSeparateRow>(
      `SELECT payload ->> 'sku' AS sku, ARRAY(SELECT jsonb_array_elements_text(payload -> 'itemIds')) AS item_ids, created_at
         FROM audit_log
        WHERE business_id = $1 AND action = $2 AND payload ->> 'sku' = ANY($3::text[])
        ORDER BY created_at DESC`,
      [businessId, KEEP_SEPARATE_ACTION, skus],
    );
    return rows;
  });
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
  const decisions = await keepSeparateDecisions(businessId, groups.map((group) => group.sku));

  return groups.map((group) => {
    const plan = group.verdict === "race_orphan"
      ? plans.find((candidate) => group.members.some((member) => member.itemId === candidate.orphanItemId)) ?? null
      : null;
    const key = memberKey(group.members);
    const decision = decisions.find((row) => row.sku === group.sku && [...(row.item_ids ?? [])].sort().join(",") === key);
    const shaped = { sku: group.sku, verdict: group.verdict, members: group.members, plan };
    return {
      ...shaped,
      needsAction: verdictNeedsAction(group.verdict),
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
  const groups = await findDuplicateItemGroups(businessId, { locationId: options.locationId ?? null });
  return groups.filter((group) => verdictNeedsAction(group.verdict)).map((group) => group.sku);
}

/** A candidate that needs a person's attention and has not been decided yet. */
export function isUnresolvedDuplicate(group: DuplicateReviewGroup | null): boolean {
  return Boolean(group && group.needsAction && !group.reviewed);
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
        KEEP_SEPARATE_ACTION,
        group.members[0]?.itemId ?? null,
        JSON.stringify({
          sku: group.sku,
          verdict: group.verdict,
          itemIds: group.members.map((member) => member.itemId),
        }),
      ],
    );
  });
  return assertReviewToken(businessId, input.sku, group.reviewToken, { locationId: input.locationId ?? null });
}

/**
 * Archive one proven race orphan, through the existing guarded archive.
 * A plan that is not `archive` (blocked, already archived) refuses here too —
 * the screen never widens what the script allows.
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
