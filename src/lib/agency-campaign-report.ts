import { isValidIsoDate } from "./iso-date";
import { agencyCampaignMetrics } from "./agency-campaign";

export class CampaignReportError extends Error {
  constructor(
    readonly code:
      | "invalid_report"
      | "campaign_not_found"
      | "report_conflict"
      | "report_state",
  ) {
    super(code);
  }
}
export interface CampaignReportInput {
  periodStart: string;
  periodEnd: string;
  evidenceReference: string;
  attributionNote: string;
  attributionConfirmed: boolean;
  spendRial: number;
  reach: number | null;
  impressions: number;
  clicks: number;
  leadsGenerated: number;
  conversions: number;
  revenueRial: number | null;
  supersedesId: string | null;
}
const text = (v: unknown, max: number) => {
  if (typeof v !== "string" || !v.trim() || v.trim().length > max)
    throw new CampaignReportError("invalid_report");
  return v.trim();
};
export function readCampaignReport(
  input: Record<string, unknown>,
): CampaignReportInput {
  const number = (key: string, max = 9000000000000000) => {
    const n = input[key];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > max)
      throw new CampaignReportError("invalid_report");
    return n;
  };
  const periodStart = text(input.periodStart, 10),
    periodEnd = text(input.periodEnd, 10);
  if (
    !isValidIsoDate(periodStart) ||
    !isValidIsoDate(periodEnd) ||
    periodStart > periodEnd ||
    typeof input.attributionConfirmed !== "boolean"
  )
    throw new CampaignReportError("invalid_report");
  const impressions = number("impressions", 1000000000000),
    clicks = number("clicks", 1000000000000);
  const reach = input.reach == null ? null : number("reach", 1000000000000);
  if (reach !== null && reach > impressions)
    throw new CampaignReportError("invalid_report");
  if (clicks > impressions) throw new CampaignReportError("invalid_report");
  const supersedesId =
    input.supersedesId == null || input.supersedesId === ""
      ? null
      : text(input.supersedesId, 36);
  if (
    supersedesId &&
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(supersedesId)
  )
    throw new CampaignReportError("invalid_report");
  return {
    periodStart,
    periodEnd,
    reach,
    impressions,
    clicks,
    spendRial: number("spendRial"),
    leadsGenerated: number("leadsGenerated", 1000000000),
    conversions: number("conversions", 1000000000),
    revenueRial: input.revenueRial == null ? null : number("revenueRial"),
    evidenceReference: text(input.evidenceReference, 500),
    attributionNote: text(input.attributionNote, 2000),
    attributionConfirmed: input.attributionConfirmed,
    supersedesId,
  };
}
export function campaignReportMetrics(input: CampaignReportInput) {
  const metrics = agencyCampaignMetrics({ ...input, budgetRial: null });
  // Explicit zero revenue is measured zero; missing revenue is not. A person's
  // attestation is labelled as such, never presented as platform verification.
  return {
    ctrPct: metrics.ctrPct,
    cplRial: input.attributionConfirmed ? metrics.cplRial : null,
    cpaRial: input.attributionConfirmed ? metrics.cpaRial : null,
    roas:
      input.attributionConfirmed &&
      input.spendRial > 0 &&
      input.revenueRial !== null
        ? Math.round((input.revenueRial / input.spendRial) * 100) / 100
        : null,
  };
}
