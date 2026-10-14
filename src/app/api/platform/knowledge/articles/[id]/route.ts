import { NextRequest, NextResponse } from "next/server";
import {
  requirePlatformAdmin,
  requirePlatformCapability,
  withPlatformScope,
  platformAudit,
} from "@/lib/platform-auth";
import { KNOWLEDGE_PAGES, KNOWLEDGE_SECTIONS } from "@/lib/knowledge-base";
import {
  adminDeleteKbArticle,
  adminGetKbArticle,
  adminUpdateKbArticle,
  knowledgeError,
  parseArticleInput,
} from "@/lib/knowledge-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

const KNOWN_SECTION_KEYS = new Set([...KNOWLEDGE_SECTIONS.map((s) => s.key), ...KNOWLEDGE_PAGES.map((p) => p.key)]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One article's full record for the editor. */
export const GET = withPlatformScope(async (_request: NextRequest, ctx: Ctx) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const article = await adminGetKbArticle(id);
  if (!article) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ article });
});

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
  const parsed = parseArticleInput(body, KNOWN_SECTION_KEYS);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    await adminUpdateKbArticle(id, parsed.input, session.padmin);
    await platformAudit({
      adminId: session.padmin,
      action: "knowledge_article.update",
      entity: "knowledge_articles",
      entityId: id,
      payload: { slug: parsed.input.slug, status: parsed.input.status },
    });
    return NextResponse.json({ ok: true, slug: parsed.input.slug });
  } catch (err) {
    return knowledgeError(err);
  }
});

export const DELETE = withPlatformScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePlatformCapability("knowledge.manage");
  if (error) return error;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    await adminDeleteKbArticle(id);
    await platformAudit({
      adminId: session.padmin,
      action: "knowledge_article.delete",
      entity: "knowledge_articles",
      entityId: id,
      payload: {},
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return knowledgeError(err);
  }
});
