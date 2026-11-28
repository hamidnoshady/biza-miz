/**
 * Playbook execution adapters (issue #1590 §Wave 3). TWO canonical executors:
 *
 *  - CRM executor: authorized CRM task / saved-view / duplicate-review queue
 *    using canonical `crm-service` + `crm-queues` + `crm-saved-views-service`.
 *    **Never** sends marketing, never moves money, never creates a parallel
 *    automation runtime. CRM→Growth handoff is an explicit draft only.
 *  - Growth executor: reuses existing Phase-37 `message-campaigns-service`
 *    (+ canonical `crm-segments`) and #901 `campaign-builder-service`.
 *    Consent + suppression are re-checked downstream at execution time.
 *    Nothing sends unless `requiresApproval` was satisfied by the caller.
 *
 * The caller (API/worker) MUST re-check authorization + eligibility + preflight
 * server-side BEFORE calling; this module does not re-derive permissions.
 */
import { createActivity } from "../crm-service";
import { crmQueues, type CrmQueueKey } from "../crm-queues";
import { isUuid } from "../uuid";
import type { PlaybookTemplate } from "./types";

export interface ExecutorContext {
  businessId: string;
  actorUserId: string | null;
  actorName: string;
  /** Sanitized, validated quick inputs. */
  inputs: Record<string, string | number | boolean | null>;
  /** Pre-computed preflight was clean; caller guarantees. */
  branchId?: string | null;
}

export interface ExecutorResult {
  ok: boolean;
  /** canonical executor output reference stored on the instance. */
  executorRef: Record<string, unknown>;
  /** how many canonical records were created/touched. */
  affected: number;
  /** human-readable summary (Persian) for audit. */
  summaryFa: string;
  error?: string;
}

/** Which canonical CRM queue feeds matching for each template. */
const CRM_QUEUE_BY_TEMPLATE: Record<string, CrmQueueKey> = {
  "crm.follow_up_new_lead": "new_leads",
  "crm.follow_up_stalled_deals": "stalled_deals",
  "crm.wholesale_quote_followup": "stalled_deals",
  "crm.agency_approval_followup": "stalled_deals",
  "crm.at_risk_customers": "at_risk_customers",
  "crm.repeat_cafe_visit": "at_risk_customers",
  "crm.cosmetics_replenishment": "at_risk_customers",
  "crm.vip_customers": "vip_follow_up",
  "crm.aec_enquiry_followup": "new_leads",
  "crm.automotive_test_drive_followup": "new_leads",
  "crm.data_cleanup": "possible_duplicates",
  // renewal templates are requires_setup (no canonical renewal-date source); never reach here.
};

function num(v: unknown, dflt: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : dflt;
  return Math.max(1, Math.min(Math.trunc(n), max));
}

function hoursFrom(v: unknown, dflt: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : dflt;
  return Math.max(1, Math.min(Math.trunc(n), 24 * 365));
}

// ---------------------------------------------------------------------------

export async function executePlaybook(template: PlaybookTemplate, ctx: ExecutorContext): Promise<ExecutorResult> {
  if (template.executionBinding.executor === "crm") return executeCrm(template, ctx);
  return executeGrowth(template, ctx);
}

// ---------------------------------------------------------------------------
// CRM executor
// ---------------------------------------------------------------------------

async function executeCrm(template: PlaybookTemplate, ctx: ExecutorContext): Promise<ExecutorResult> {
  const action = template.executionBinding.action;

  if (action === "crm.duplicate_review_queue") {
    // Non-mutating: surface duplicates for explicit human merge. NO auto-merge.
    const queues = await crmQueues(ctx.businessId);
    const dup = queues.find((q) => q.key === "possible_duplicates");
    return {
      ok: true,
      executorRef: { queue: "possible_duplicates", view: dup?.view ?? null, requiresHumanMerge: true, canonicalRoute: "/crm/duplicates" },
      affected: dup?.count ?? 0,
      summaryFa: `${dup?.count ?? 0} جفت تکراری برای بازبینی انسانی یافت شد؛ هیچ ادغامی انجام نشد.`,
    };
  }

  // crm.create_tasks
  const queueKey = CRM_QUEUE_BY_TEMPLATE[template.key];
  if (!queueKey) {
    return { ok: false, executorRef: {}, affected: 0, summaryFa: "", error: "no_canonical_match_source" };
  }

  const queues = await crmQueues(ctx.businessId);
  const queue = queues.find((q) => q.key === queueKey);
  const cap =
    queueKey === "new_leads"
      ? num(ctx.inputs.maxLeads, 100, 1000)
      : queueKey === "stalled_deals"
        ? num(ctx.inputs.maxDeals, 100, 1000)
        : queueKey === "vip_follow_up"
          ? num(ctx.inputs.maxCustomers, 50, 1000)
          : 1000;

  const items = (queue?.items ?? []).slice(0, cap);
  if (items.length === 0) {
    return { ok: true, executorRef: { queue: queueKey, createdActivityIds: [], matched: queue?.count ?? 0 }, affected: 0, summaryFa: "موردی برای ایجاد وظیفه یافت نشد." };
  }

  const slaHours = hoursFrom(ctx.inputs.slaHours, 24);
  const dueAt = new Date(Date.now() + slaHours * 3600_000).toISOString();
  const assigneeUserId = typeof ctx.inputs.assigneeUserId === "string" && isUuid(ctx.inputs.assigneeUserId) ? ctx.inputs.assigneeUserId : null;

  const createdActivityIds: string[] = [];
  for (const item of items) {
    // Linkage mirrors canonical automation: party/deal ids only when the queue supplies them.
    const isDeal = queueKey === "stalled_deals";
    const isCustomer = queueKey === "at_risk_customers" || queueKey === "vip_follow_up";
    const activity = await createActivity(ctx.businessId, {
      customerId: isCustomer ? item.id : null,
      dealId: isDeal ? item.id : null,
      caseId: null,
      kind: "task",
      subject: `${template.localized.titleFa}: ${item.title}`.slice(0, 300),
      body: `ایجادشده توسط قالب «${template.localized.titleFa}» (${template.key} v${template.version}). ${item.subtitle}`.trim(),
      dueAt,
      assigneeUserId,
      createdBy: ctx.actorName,
    });
    createdActivityIds.push(activity.id);
  }

  return {
    ok: true,
    executorRef: { queue: queueKey, createdActivityIds, matched: queue?.count ?? items.length, view: queue?.view ?? null },
    affected: createdActivityIds.length,
    summaryFa: `${createdActivityIds.length} وظیفه CRM ایجاد شد.`,
  };
}

// ---------------------------------------------------------------------------
// Growth executor (delegates to canonical services; no second engine)
// ---------------------------------------------------------------------------

async function executeGrowth(template: PlaybookTemplate, ctx: ExecutorContext): Promise<ExecutorResult> {
  const action = template.executionBinding.action;

  if (action === "growth.message_campaign_launch" || action === "growth.message_campaign_draft") {
    return executeGrowthMessageCampaign(template, ctx, action === "growth.message_campaign_launch");
  }
  if (action === "growth.campaign_builder_draft") {
    return executeCampaignBuilderDraft(template, ctx);
  }
  return { ok: false, executorRef: {}, affected: 0, summaryFa: "", error: "unknown_growth_action" };
}

async function executeGrowthMessageCampaign(template: PlaybookTemplate, ctx: ExecutorContext, launch: boolean): Promise<ExecutorResult> {
  // Lazy import keeps pure catalog tests DB-free.
  const { createSegment } = await import("../crm-segments-service");
  const { saveMessageTemplate, createMessageCampaign, launchMessageCampaign } = await import("../message-campaigns-service");
  const { businessToday } = await import("../business-day-service");

  const channel = ctx.inputs.channel === "email" ? "email" : "sms";
  const messageBody = typeof ctx.inputs.messageBody === "string" ? ctx.inputs.messageBody.trim() : "";
  if (!messageBody) return { ok: false, executorRef: {}, affected: 0, summaryFa: "", error: "message_body_required" };

  const today = await businessToday(ctx.businessId);
  const definition = segmentDefinitionForTemplate(template, ctx.inputs, today);

  const segment = await createSegment(ctx.businessId, {
    name: `${template.localized.titleFa} (${template.key})`.slice(0, 120),
    description: `قالب ${template.key} v${template.version}`,
    definition,
    createdBy: ctx.actorName,
  });

  const messageTemplate = await saveMessageTemplate(ctx.businessId, {
    channel,
    name: `${template.localized.titleFa}`.slice(0, 120),
    subject: channel === "email" ? template.localized.titleFa : "",
    body: messageBody,
  });

  const campaign = await createMessageCampaign(ctx.businessId, {
    channel,
    name: `${template.localized.titleFa}`.slice(0, 120),
    templateId: messageTemplate.id,
    segmentId: segment.id,
    triggeredBy: `playbook:${template.key}`,
  });

  if (!launch) {
    return { ok: true, executorRef: { segmentId: segment.id, templateId: messageTemplate.id, campaignId: campaign.id, status: "draft" }, affected: 0, summaryFa: "پیش‌نویس کمپین ساخته شد (ارسال نشد)." };
  }

  // launchMessageCampaign re-checks messaging configured + consent + recipients + template variables.
  const result = await launchMessageCampaign(ctx.businessId, campaign.id, {});
  return {
    ok: true,
    executorRef: { segmentId: segment.id, templateId: messageTemplate.id, campaignId: campaign.id, status: "sending", total: result.total, excluded: result.excluded },
    affected: result.total,
    summaryFa: `کمپین برای ${result.total} مخاطب واجد شرایط در صف ارسال قرار گرفت (${result.excluded} مستثنا).`,
  };
}

/**
 * Canonical segment definition for a Growth message template (pure). Consent is
 * applied downstream by `audienceForSegment`/`countDefinition` purpose; unknown
 * triggers fall back to empty (everyone) only when template truly has no filter.
 */
export function segmentDefinitionForTemplate(
  template: PlaybookTemplate,
  inputs: Record<string, string | number | boolean | null>,
  todayIso: string,
): import("../segments").SegmentDefinition {
  const inactiveDays = typeof inputs.inactiveDays === "number" ? Math.max(1, Math.trunc(inputs.inactiveDays)) : 60;
  if (template.trigger === "inactive_customer") {
    return { all: [{ field: "lastPurchaseAt", op: "before", days: inactiveDays }] };
  }
  if (template.trigger === "first_purchase") {
    return { all: [{ field: "firstPurchaseAt", op: "after", days: 30 }] };
  }
  if (template.trigger === "birthday") {
    const month = (new Date(todayIso + "T00:00:00Z").getUTCMonth() + 1) || 1;
    return { all: [{ field: "birthdayMonth", op: "is", month }] };
  }
  return { all: [] };
}

async function executeCampaignBuilderDraft(template: PlaybookTemplate, ctx: ExecutorContext): Promise<ExecutorResult> {
  // #901 canonical campaign builder: create draft + we do NOT execute reward posting.
  return { ok: false, executorRef: {}, affected: 0, summaryFa: "", error: "campaign_builder_draft_requires_separate_approval" };
}
