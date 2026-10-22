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

  // Optimistic concurrency: the editor sends the `version` it loaded. A
  // concurrent save gets 409 version_conflict instead of overwriting it.
  const rawVersion = (body as Record<string, unknown>).expectedVersion;
  let expectedVersion: number | null = null;
  if (rawVersion !== undefined && rawVersion !== null) {
    if (
      typeof rawVersion !== "number" ||
      !Number.isInteger(rawVersion) ||
      rawVersion < 1
    ) {
      return NextResponse.json({ error: "invalid_version" }, { status: 400 });
    }
    expectedVersion = rawVersion;
  }

  try {
    const version = await adminUpdateKbArticle(id, parsed.input, session.padmin, expectedVersion);
    await platformAudit({
      adminId: session.padmin,
      action: "knowledge_article.update",
      entity: "knowledge_articles",
      entityId: id,
      payload: { slug: parsed.input.slug, status: parsed.input.status, version },
    });
    return NextResponse.json({ ok: true, slug: parsed.input.slug, version });
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
