/**
 * Issue #1592 — the read-only stock-authority preview (DB-touching).
 *
 * It reuses the duplicate report and the archive planner, keeps only the pairs
 * whose orphan still holds quantity, and compares them with the newest product
 * payload the store sent for the surviving row's remote id. The result is
 * evidence for an owner: which pairs are safe to archive with zero physical
 * stock movement, which need the store or the canonical row reconciled first,
 * and which need a person because a variable family's stock is per variation.
 *
 * It writes nothing: the report/plan run on a `READ ONLY` transaction that is
 * rolled back, and the connection configuration is a plain tenant-scoped read.
 * There is deliberately **no apply function in this module** — a production
 * stock decision requires the owner's separate approval of this exact evidence
 * (`approvalToken`) and a separate, reviewed write path.
 */
import { query, withTenant } from "./db";
import { findDuplicateItemGroups, type DuplicateReportMember, type DuplicateReportOptions } from "./duplicate-items-report";
import { planOrphanArchivesForGroups } from "./duplicate-items-resolve-service";
import type { OrphanPlan } from "./duplicate-items-resolution";
import {
  planStockAuthority,
  stockAuthorityApprovalToken,
  summariseStockAuthority,
  type StockAuthorityApprovalEntry,
  type StockAuthorityEvidence,
  type StockAuthorityProposal,
  type StockAuthorityVerdict,
} from "./duplicate-items-stock-authority";

export interface StoreAuthorityConfig {
  connectionId: string;
  connectionName: string;
  provider: string;
  pushStock: boolean;
  pushPrices: boolean;
  active: boolean;
}

export interface StockAuthorityPreviewItem extends StockAuthorityApprovalEntry {
  name: string;
  canonicalItemId: string;
  canonicalName: string;
  connectionId: string | null;
  connectionName: string | null;
  remoteId: string | null;
  daysApart: number | null;
  proposal: StockAuthorityProposal;
  /** Tables still pointing at the orphan; they are never modified. */
  references: Array<{ table: string; column: string; count: number }>;
  /** True when the surviving row is a variable product (per-variation stock). */
  variantFamily: boolean;
}

export interface StockAuthorityPreview {
  businessId: string;
  generatedAt: string;
  scope: { sku: string | null; locationId: string | null };
  storeAuthority: StoreAuthorityConfig[];
  totals: ReturnType<typeof summariseStockAuthority>;
  /** Hash covering the safe entries only — what an owner would approve. */
  approvalToken: string;
  /** Hash covering every row in this preview, for change detection. */
  previewHash: string;
  items: StockAuthorityPreviewItem[];
  facts: string[];
}

function newestSnapshot(member: DuplicateReportMember | undefined) {
  if (!member || member.snapshots.length === 0) return null;
  return [...member.snapshots].sort(
    (left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt),
  )[0];
}

function numeric(value: string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Build one preview row from a stocked plan. */
export function buildStockAuthorityItem(
  plan: OrphanPlan,
  groupMembers: readonly DuplicateReportMember[],
  storeAuthority: readonly StoreAuthorityConfig[],
): StockAuthorityPreviewItem | null {
  const orphanQuantity = plan.orphanQuantity == null ? null : Number(plan.orphanQuantity);
  if (orphanQuantity == null || !Number.isFinite(orphanQuantity) || orphanQuantity === 0) return null;

  const orphan = groupMembers.find((member) => member.itemId === plan.orphanItemId);
  const canonical = groupMembers.find((member) => member.itemId === plan.twinItemId);
  if (!orphan || !canonical) return null;

  const mapping = canonical.mappings.find((candidate) => candidate.entityType === "product");
  const connection = mapping ? storeAuthority.find((entry) => entry.connectionId === mapping.connectionId) ?? null : null;
  const snapshot = newestSnapshot(canonical);
  const variantFamily = plan.kind === "historical_variant_orphan" || canonical.kind === "variant_parent";

  const proposal = planStockAuthority({
    orphanQuantity,
    canonicalQuantity: canonical.quantity,
    storeQuantity: snapshot?.stockQuantity ?? null,
    storeSnapshotAt: snapshot?.receivedAt ?? null,
    variantFamily,
    canonicalActive: canonical.isActive,
    canonicalMapped: canonical.mappings.length > 0,
    historyReferences: plan.references.length,
  });

  return {
    itemId: plan.orphanItemId,
    sku: plan.sku,
    name: orphan.name,
    canonicalItemId: canonical.itemId,
    canonicalName: canonical.name,
    orphanQuantity,
    canonicalQuantity: numeric(canonical.quantity),
    storeQuantity: snapshot?.stockQuantity ?? null,
    storeSnapshotAt: snapshot?.receivedAt ?? null,
    evidence: proposal.evidence,
    verdict: proposal.verdict,
    connectionId: mapping?.connectionId ?? null,
    connectionName: mapping?.connectionName ?? null,
    remoteId: mapping?.remoteId ?? null,
    daysApart: plan.daysApart,
    proposal,
    references: plan.references,
    variantFamily,
  };
}

/**
 * The preview for one business (optionally one SKU / branch).
 *
 * No writes, no `--apply`: callers render this and an owner approves the exact
 * `approvalToken`. The write path is intentionally absent until that approval
 * exists and is reviewed as its own change.
 */
export async function previewStockAuthority(
  businessId: string,
  options: DuplicateReportOptions & { now?: Date } = {},
): Promise<StockAuthorityPreview> {
  const scope = { sku: options.sku ?? null, locationId: options.locationId ?? null };
  const groups = await findDuplicateItemGroups(businessId, scope);
  if (groups.length === 0) {
    return emptyPreview(businessId, scope, options.now);
  }
  const plans = await planOrphanArchivesForGroups(businessId, groups);
  const stocked = plans.filter((plan) => Number(plan.orphanQuantity ?? 0) !== 0);

  const storeAuthority = await withTenant(businessId, async () => {
    const { rows } = await query<{
      id: string;
      name: string;
      provider: string;
      push_stock: boolean;
      push_prices: boolean;
      deleted_at: Date | null;
      status: string;
    }>(
      `SELECT id::text, name, provider, push_stock, push_prices, deleted_at, status
         FROM integration_connections
        WHERE business_id = $1 AND provider = 'woocommerce'
        ORDER BY created_at`,
      [businessId],
    );
    return rows.map(
      (row): StoreAuthorityConfig => ({
        connectionId: row.id,
        connectionName: row.name,
        provider: row.provider,
        pushStock: row.push_stock,
        pushPrices: row.push_prices,
        active: row.deleted_at == null && row.status === "active",
      }),
    );
  });

  const items: StockAuthorityPreviewItem[] = [];
  for (const plan of stocked) {
    const group = groups.find((candidate) => candidate.members.some((member) => member.itemId === plan.orphanItemId));
    if (!group) continue;
    const item = buildStockAuthorityItem(plan, group.members, storeAuthority);
    if (item) items.push(item);
  }

  items.sort((left, right) => left.sku.localeCompare(right.sku) || left.itemId.localeCompare(right.itemId));
  const safe = items.filter((item) => item.verdict === "safe_to_archive");
  const totals = summariseStockAuthority(items);
  const facts = [
    "Preview only: no stock, item or mapping row is written by this read.",
    storeAuthority.some((entry) => entry.pushStock || entry.pushPrices)
      ? "At least one connection still pushes stock/prices; the store is not configured as the sole authority."
      : "All WooCommerce connections have push_stock and push_prices off: the store is the configured stock authority.",
    `${items.length} stocked duplicate pair(s); ${safe.length} have the store agreeing with the surviving row.`,
    "Order, refund, invoice and journal references are listed but never modified.",
  ];

  return {
    businessId,
    generatedAt: (options.now ?? new Date()).toISOString(),
    scope,
    storeAuthority,
    totals,
    approvalToken: stockAuthorityApprovalToken(safe),
    previewHash: stockAuthorityApprovalToken(items),
    items,
    facts,
  };
}

function emptyPreview(
  businessId: string,
  scope: { sku: string | null; locationId: string | null },
  now?: Date,
): StockAuthorityPreview {
  return {
    businessId,
    generatedAt: (now ?? new Date()).toISOString(),
    scope,
    storeAuthority: [],
    totals: summariseStockAuthority([]),
    approvalToken: stockAuthorityApprovalToken([]),
    previewHash: stockAuthorityApprovalToken([]),
    items: [],
    facts: ["No duplicate SKU group was found in this scope."],
  };
}

export type { StockAuthorityEvidence, StockAuthorityVerdict };
