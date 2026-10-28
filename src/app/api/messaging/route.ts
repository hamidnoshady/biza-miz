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
import { getMessageBusinessBilling } from "@/lib/messaging-billing";
import { getTenantMessagingConfig } from "@/lib/messaging-service-readiness";
import {
  createLookupTemplate,
  disableLookupTemplate,
  listLookupTemplates,
  readTemplateForBusiness,
  reviseLookupTemplate,
  toTenantLookupTemplates,
} from "@/lib/kavenegar/template-service";
import {
  instantiateMasterTemplate,
  MasterTemplateError,
  tenantTemplateLibrary,
} from "@/lib/kavenegar/master-template-service";

const channel = (value: unknown): "sms" | "email" | null =>
  value === "sms" || value === "email" ? value : null;

/**
 * Owner/manager messaging workbench. Audience resolution remains in the CRM
 * service and campaign launches snapshot it there; this route only coordinates
 * the authenticated tenant's templates and campaign records. Credit is bought
 * in the central wallet (/settings/billing), never here.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.campaignsView);
  if (error) return error;

  // `billing` is the central wallet's usable balance, for the cost warning
  // only; buying credit is the platform billing page's job (issue #764).
  const [
    config,
    billing,
    templates,
    campaigns,
    segments,
    projects,
    promotions,
    lookupTemplates,
    templateLibrary,
  ] = await Promise.all([
      getTenantMessagingConfig(session.businessId),
      getMessageBusinessBilling(session.businessId),
      listMessageTemplates(session.businessId),
      listMessageCampaigns(session.businessId),
      listSegments(session.businessId),
      listProjects({ businessId: session.businessId, actorUserId: session.sub }),
      listPromotionCatalogue(session.businessId),
      // Approved verification/transactional messages, in first-party words.
      // The provider's template names, ids and rejection text never leave the
      // server (src/lib/kavenegar/template-service.ts).
      listLookupTemplates(session.businessId).then(toTenantLookupTemplates),
      // Issue #902 §5 — the platform's own message library, filtered to this
      // business's trade and plan server-side. First-party titles and a rendered
      // sample only: no provider template name, id or approval vocabulary.
      tenantTemplateLibrary(session.businessId),
    ]);
  return NextResponse.json({
    config,
    billing,
    templates,
    campaigns,
    segments,
    projects,
    promotions,
    lookupTemplates,
    templateLibrary,
  });
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

    if (body.action === "lookup_template") {
      // A draft only. Submission to the provider is a platform action
      // (`/api/platform/sms/accounts`), so a tenant cannot create something the
      // provider will reject on its behalf.
      if (
        typeof body.title !== "string" ||
        typeof body.message !== "string" ||
        typeof body.purpose !== "string"
      ) {
        return NextResponse.json({ error: "invalid_lookup_template" }, { status: 400 });
      }
      const template = await createLookupTemplate({
        businessId: session.businessId,
        title: body.title,
        body: body.message,
        purpose: body.purpose,
      });
      return NextResponse.json(
        {
          template: toTenantLookupTemplates([template])[0],
        },
        { status: 201 },
      );
    }

    if (body.action === "lookup_template_from_library") {
      // Adding one of the platform's approved messages to this business's own
      // catalog. The entry is named by id, but eligibility (enabled, trade,
      // plan) is re-resolved server-side — the id is not an authorisation.
      if (typeof body.libraryId !== "string" || !body.libraryId) {
        return NextResponse.json({ error: "invalid_lookup_template" }, { status: 400 });
      }
      try {
        const result = await instantiateMasterTemplate({
          businessId: session.businessId,
          masterTemplateId: body.libraryId,
        });
        return NextResponse.json(
          {
            template: toTenantLookupTemplates([result.template])[0],
            created: result.created,
          },
          { status: result.created ? 201 : 200 },
        );
      } catch (error) {
        if (error instanceof MasterTemplateError) {
          const status = error.code === "master_template_not_found" ? 404 : 400;
          return NextResponse.json({ error: error.code }, { status });
        }
        throw error;
      }
    }

    if (body.action === "lookup_template_revise") {
      // Editing a message. The server decides the shape (issue #902 §5): a
      // draft or rejected row is rewritten in place, while an approved one
      // gains a successor so this business's working automation keeps sending
      // until the replacement is approved.
      if (
        typeof body.templateId !== "string" ||
        typeof body.title !== "string" ||
        typeof body.message !== "string"
      ) {
        return NextResponse.json({ error: "invalid_lookup_template" }, { status: 400 });
      }
      const revised = await reviseLookupTemplate({
        businessId: session.businessId,
        templateId: body.templateId,
        title: body.title,
        body: body.message,
      });
      return NextResponse.json(
        { template: toTenantLookupTemplates([revised.template])[0], created: revised.created },
        { status: revised.created ? 201 : 200 },
      );
    }

    if (body.action === "lookup_template_disable") {
      // Removing a message from the catalog. Ownership is checked in the
      // tenant's own scope first; the provider copy is cleaned up by the
      // platform console, never deleted from a tenant request.
      if (typeof body.templateId !== "string") {
        return NextResponse.json({ error: "invalid_lookup_template" }, { status: 400 });
      }
      const owned = await readTemplateForBusiness(session.businessId, body.templateId);
      if (!owned) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
      const template = await disableLookupTemplate(owned.id);
      return NextResponse.json({ template: toTenantLookupTemplates([template])[0] });
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
      "title_required",
      "title_too_long",
      "body_required",
      "body_too_long",
      "missing_token",
      "unsupported_token",
      "unknown_purpose",
      "variables_mismatch",
      "template_archived",
    ];
    if (known.some((code) => message.startsWith(code)) || message.startsWith("message_variable_missing") || message.startsWith("unknown_template_variable")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    throw cause;
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
});
