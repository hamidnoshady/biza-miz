import { NextRequest, NextResponse } from "next/server";
import {
  requirePlatformCapability,
  withPlatformScope,
  platformAudit,
} from "@/lib/platform-auth";
import {
  adminDeleteKbTag,
  adminUpdateKbTag,
  knowledgeError,
  parseTagInput,
} from "@/lib/knowledge-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const parsed = parseTagInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    await adminUpdateKbTag(id, parsed.input, session.padmin);
    await platformAudit({
      adminId: session.padmin,
      action: "knowledge_tag.update",
      entity: "knowledge_tags",
      entityId: id,
      payload: { slug: parsed.input.slug },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return knowledgeError(err);
  }
});

/** Deleting a tag un-links it from every article (the join row cascades). */
export const DELETE = withPlatformScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePlatformCapability("knowledge.manage");
  if (error) return error;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    await adminDeleteKbTag(id);
    await platformAudit({
      adminId: session.padmin,
      action: "knowledge_tag.delete",
      entity: "knowledge_tags",
      entityId: id,
      payload: {},
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return knowledgeError(err);
  }
});
