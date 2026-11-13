/** Issue #1128: preview ONE posted expense line. No posting or historical attribution. */
import { boundedRialText, type RialText } from "./inventory-exact";
import { allocateRialByWeight } from "./shareholder-accounting";
import { isUuid } from "./uuid";

export const CAMPAIGN_ALLOCATION_POLICY = "campaign-basis-points-v1" as const;
export interface CampaignAllocationTarget {
  campaignId: string;
  basisPoints: number;
}
export class CampaignAllocationError extends Error {
  constructor(
    public readonly code:
      | "invalid_allocation"
      | "allocation_source_not_found"
      | "allocation_campaign_not_found",
  ) {
    super(code);
    this.name = "CampaignAllocationError";
  }
}

/** Explicit weights: a missing share stays unassigned, never normalized to 100%. */
export function readCampaignAllocationTargets(
  input: unknown,
): CampaignAllocationTarget[] {
  if (!Array.isArray(input) || input.length > 100)
    throw new CampaignAllocationError("invalid_allocation");
  let total = 0;
  const seen = new Set<string>();
  return input
    .map((target: unknown) => {
      if (!target || typeof target !== "object" || Array.isArray(target))
        throw new CampaignAllocationError("invalid_allocation");
      const row = target as Record<string, unknown>;
      if (
        !isUuid(row.campaignId) ||
        typeof row.basisPoints !== "number" ||
        !Number.isInteger(row.basisPoints) ||
        row.basisPoints <= 0 ||
        row.basisPoints > 10000
      ) {
        throw new CampaignAllocationError("invalid_allocation");
      }
      const campaignId = row.campaignId.toLowerCase();
      total += row.basisPoints;
      if (seen.has(campaignId) || total > 10000)
        throw new CampaignAllocationError("invalid_allocation");
      seen.add(campaignId);
      return { campaignId, basisPoints: row.basisPoints };
    })
    .sort((a, b) => (a.campaignId < b.campaignId ? -1 : 1));
}

/**
 * JSON-safe exact rial; bounded to a source bigint column. Ties go by canonical
 * UUID, then unassigned; reordering a request cannot change a residual recipient.
 * Reversals must eventually mirror persisted amounts, NOT recalculate this preview.
 */
export function previewCampaignAllocation(
  sourceAmountRial: unknown,
  input: unknown,
) {
  let amount: RialText;
  try {
    if (typeof sourceAmountRial !== "string") throw new Error();
    amount = boundedRialText(sourceAmountRial);
  } catch {
    throw new CampaignAllocationError("invalid_allocation");
  }
  const targets = readCampaignAllocationTargets(input);
  const unassignedBasisPoints =
    10000 - targets.reduce((sum, row) => sum + row.basisPoints, 0);
  const amounts = new Map(
    allocateRialByWeight(BigInt(amount), [
      ...targets.map((row) => ({
        key: row.campaignId,
        weight: BigInt(row.basisPoints),
      })),
      { key: "unassigned", weight: BigInt(unassignedBasisPoints) },
    ]).map((row) => [row.key, row.amountRial.toString()]),
  );
  return {
    policy: CAMPAIGN_ALLOCATION_POLICY,
    sourceAmountRial: amount,
    allocations: targets.map((row) => ({
      ...row,
      amountRial: amounts.get(row.campaignId)!,
    })),
    unassignedBasisPoints,
    unassignedRial: amounts.get("unassigned")!,
  };
}

/** journal_lines.id is bigint, not UUID or a JS number. */
export function readAllocationSourceLineId(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(input) ||
    BigInt(input) > 9223372036854775807n
  ) {
    throw new CampaignAllocationError("invalid_allocation");
  }
  return input;
}
