import { NextRequest, NextResponse } from "next/server";
import {
  requirePlatformCapability,
  withPlatformScope,
  platformAudit,
} from "@/lib/platform-auth";
import {
  adminDeleteKbCategory,
  adminUpdateKbCategory,
  knowledgeError,
  parseCategoryInput,
} from "@/lib/knowledge-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Update one category of the category builder (`knowledge.manage`). */
export const PUT = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePlatformCapability("knowledge.manage");
  if (error) return error;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = parseCategoryInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    await adminUpdateKbCategory(id, parsed.input, session.padmin);
    await platformAudit({
      adminId: session.padmin,
      action: "knowledge_category.update",
      entity: "knowledge_categories",
      entityId: id,
      payload: { slug: parsed.input.slug, is_active: parsed.input.isActive },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return knowledgeError(err);
  }
});

/**
 * Delete a category. Refused (409) while it still has children or articles —
 * the operator first moves them, so a whole branch of the member side menu /
 * its articles never silently disappears.
 */
export const DELETE = withPlatformScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePlatformCapability("knowledge.manage");
  if (error) return error;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    await adminDeleteKbCategory(id);
    await platformAudit({
      adminId: session.padmin,
      action: "knowledge_category.delete",
      entity: "knowledge_categories",
      entityId: id,
      payload: {},
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return knowledgeError(err);
  }
});
