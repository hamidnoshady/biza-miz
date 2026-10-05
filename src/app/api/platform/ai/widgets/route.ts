import { NextRequest, NextResponse } from "next/server";
import {
  listAiWidgetTemplates,
  saveAiWidgetTemplate,
  widgetTemplateIndustryOptions,
} from "@/lib/ai-widget-admin";
import {
  platformAudit,
  requirePlatformAdmin,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";

/**
 * Issue #799 §22 — the platform's recommended AI widgets.
 *
 * `ai_widget_templates` rows with `business_id IS NULL` are the platform
 * catalogue: what a business of an industry is *offered* under its AI chat,
 * never imposed. Reading is `ai.read` like the rest of the platform AI console;
 * writing is `ai.config.manage` (owner-only), because a prompt written here is
 * executed against every tenant of that industry and a mis-scoped
 * `required_permissions` value would quietly withhold the offer from everyone.
 *
 * Nothing here touches `ai_widgets`: a member's own widgets stay theirs, which
 * is §22's second sentence and the reason this route has no tenant branch at
 * all.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const [templates, industries] = [await listAiWidgetTemplates(), widgetTemplateIndustryOptions()];
  return NextResponse.json({ templates, industries });
});

export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("ai.config.manage");
  if (error) return error;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body?.id === "string" && !UUID.test(body.id)) {
    return NextResponse.json({ error: "template_not_found" }, { status: 404 });
  }
  const result = await saveAiWidgetTemplate(session.padmin, body ?? {});
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.error === "template_not_found" ? 404 : 400 },
    );
  }

  await platformAudit({
    adminId: session.padmin,
    action: body?.id ? "ai_widget_template.update" : "ai_widget_template.create",
    entity: "ai_widget_templates",
    entityId: result.template.id,
    payload: {
      name: result.template.name,
      industry: result.template.industry,
      enabled: result.template.enabled,
      requiredPermissions: result.template.requiredPermissions,
    },
  });

  return NextResponse.json({ template: result.template }, { status: body?.id ? 200 : 201 });
});
