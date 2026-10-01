import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listSegments } from "@/lib/crm-segments-service";
import { getProject, listProjects } from "@/lib/ai-projects";
import { listPromotionCatalogue } from "@/lib/promotions-service";
import {
  createMessageCampaign,
  launchMessageCampaign,
  listMessageCampaigns,
  listMessageTemplates,
  pauseMessageCampaign,
  resumeMessageCampaign,
  saveMessageTemplate,
} from "@/lib/message-campaigns-service";
import {
  createMessageTopUpRequest,
  getMessageBusinessBilling,
  getPublicMessageConfig,
  listMessageCreditPackages,
  listRecentMessageLedger,
} from "@/lib/messaging-billing";

const channel = (value: unknown): "sms" | "email" | null =>
  value === "sms" || value === "email" ? value : null;

/**
 * Owner/manager messaging workbench. Audience resolution remains in the CRM
 * service and campaign launches snapshot it there; this route only coordinates
 * the authenticated tenant's templates, campaign records and credit purchase.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.campaignsView);
  if (error) return error;

  const [config, billing, packages, ledger, templates, campaigns, segments, projects, promotions] = await Promise.all([
    getPublicMessageConfig(),
    getMessageBusinessBilling(session.businessId),
    listMessageCreditPackages(true),
    listRecentMessageLedger(session.businessId),
    listMessageTemplates(session.businessId),
    listMessageCampaigns(session.businessId),
    listSegments(session.businessId),
    listProjects({ businessId: session.businessId, actorUserId: session.sub }),
    listPromotionCatalogue(session.businessId),
  ]);
  return NextResponse.json({ config, billing, packages, ledger, templates, campaigns, segments, projects, promotions });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.campaignsManage);
  if (error) return error;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  try {
    if (body.action === "template") {
      const selectedChannel = channel(body.channel);
      if (!selectedChannel || typeof body.name !== "string" || typeof body.message !== "string") {
        return NextResponse.json({ error: "invalid_template" }, { status: 400 });
      }
      const template = await saveMessageTemplate(session.businessId, {
        channel: selectedChannel, name: body.name, subject: typeof body.subject === "string" ? body.subject : "", body: body.message,
      });
      return NextResponse.json({ template }, { status: 201 });
    }

    if (body.action === "campaign") {
      const selectedChannel = channel(body.channel);
      if (!selectedChannel || typeof body.name !== "string" || typeof body.templateId !== "string" || typeof body.segmentId !== "string") {
        return NextResponse.json({ error: "invalid_campaign" }, { status: 400 });
      }
      // A project FK alone cannot prove tenant affinity. Refuse a UUID from a
      // different business before a campaign can acquire its cost centre.
      let projectId: string | null = null;
      if (typeof body.projectId === "string" && body.projectId) {
        const project = await getProject({ businessId: session.businessId, actorUserId: session.sub, projectId: body.projectId });
        if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 400 });
        projectId = project.id;
      }
      const template = (await listMessageTemplates(session.businessId, selectedChannel)).find((item) => item.id === body.templateId);
      const segment = (await listSegments(session.businessId)).find((item) => item.id === body.segmentId);
      let promotionId: string | null = null;
      if (typeof body.promotionId === "string" && body.promotionId) {
        const promotion = (await listPromotionCatalogue(session.businessId)).find((item) => item.id === body.promotionId && item.isActive);
        if (!promotion) return NextResponse.json({ error: "promotion_not_found" }, { status: 400 });
        promotionId = promotion.id;
      }
      if (!template || !segment) return NextResponse.json({ error: "template_or_segment_not_found" }, { status: 400 });
      const campaign = await createMessageCampaign(session.businessId, {
        channel: selectedChannel, name: body.name, templateId: template.id, segmentId: segment.id, projectId, promotionId, triggeredBy: session.fullName,
      });
      return NextResponse.json({ campaign }, { status: 201 });
    }

    if (body.action === "launch") {
      if (typeof body.campaignId !== "string") return NextResponse.json({ error: "campaign_required" }, { status: 400 });
      const launch = await launchMessageCampaign(session.businessId, body.campaignId, {
        creditRial: typeof body.creditRial === "number" && Number.isSafeInteger(body.creditRial) ? body.creditRial : undefined,
        discountCode: typeof body.discountCode === "string" ? body.discountCode : undefined,
      });
      return NextResponse.json({ launch });
    }

    if (body.action === "pause") {
      if (typeof body.campaignId !== "string") return NextResponse.json({ error: "campaign_required" }, { status: 400 });
      await pauseMessageCampaign(session.businessId, body.campaignId);
      return NextResponse.json({ ok: true });
    }

    if (body.action === "resume") {
      if (typeof body.campaignId !== "string") return NextResponse.json({ error: "campaign_required" }, { status: 400 });
      await resumeMessageCampaign(session.businessId, body.campaignId);
      return NextResponse.json({ ok: true });
    }

    if (body.action === "top_up") {
      if (typeof body.packageId !== "string" || !body.packageId) {
        return NextResponse.json({ error: "package_required" }, { status: 400 });
      }
      const request = await createMessageTopUpRequest({ businessId: session.businessId, packageId: body.packageId, note: typeof body.note === "string" ? body.note : undefined });
      return NextResponse.json({ request }, { status: 201 });
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "messaging_error";
    const known = [
      "invalid_template",
      "invalid_campaign",
      "not_found",
      "campaign_needs_segment",
      "campaign_already_launched",
      "campaign_audience_limit_exceeded",
      "campaign_has_no_recipients",
      "no_reachable_customer",
      "messaging_not_configured",
      "template_not_found",
      "invalid_amount",
    ];
    if (known.some((code) => message.startsWith(code)) || message.startsWith("message_variable_missing") || message.startsWith("unknown_template_variable")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    throw cause;
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
});
