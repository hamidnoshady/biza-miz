import { NextRequest, NextResponse } from "next/server";
import { setAiWidgetTemplateEnabled } from "@/lib/ai-widget-admin";
import {
  platformAudit,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";

/**
 * Offering or retiring one recommendation (§22).
 *
 * `enabled = false` is this catalogue's delete: an existing tenant widget keeps
 * its `template_id` provenance (`ON DELETE SET NULL` would drop it silently),
 * and a retired recommendation simply stops being offered. Only platform rows
 * (`business_id IS NULL`) can be reached — a tenant's own template is not the
 * console's to change.
 */
interface Ctx {
  params: Promise<{ id: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PATCH = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePlatformCapability("ai.config.manage");
  if (error) return error;

  const { id } = await ctx.params;
  // A malformed id is a 404, not a `22P02` from the uuid column.
  if (!UUID.test(id)) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const template = await setAiWidgetTemplateEnabled(id, body.enabled);
  if (!template) return NextResponse.json({ error: "template_not_found" }, { status: 404 });

  await platformAudit({
    adminId: session.padmin,
    action: template.enabled ? "ai_widget_template.enable" : "ai_widget_template.disable",
    entity: "ai_widget_templates",
    entityId: template.id,
    payload: { name: template.name, industry: template.industry },
  });

  return NextResponse.json({ template });
});
