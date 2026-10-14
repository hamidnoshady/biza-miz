import { NextRequest, NextResponse } from "next/server";
import {
  requirePlatformAdmin,
  requirePlatformCapability,
  withPlatformScope,
  platformAudit,
} from "@/lib/platform-auth";
import { KNOWLEDGE_PAGES, KNOWLEDGE_SECTIONS } from "@/lib/knowledge-base";
import {
  adminCreateKbArticle,
  adminListKbArticles,
  knowledgeError,
  parseArticleInput,
} from "@/lib/knowledge-service";

const KNOWN_SECTION_KEYS = new Set([...KNOWLEDGE_SECTIONS.map((s) => s.key), ...KNOWLEDGE_PAGES.map((p) => p.key)]);

/**
 * The knowledge base's articles (migration 0131) — the console's editor data.
 * GET lists articles with optional filters (?q/&status=&category=&tag=&section=)
 * for the article manager; any admin may read (content destined for every
 * business is not privileged), writes need `knowledge.manage`.
 */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  const p = request.nextUrl.searchParams;
  const status = p.get("status");
  const articles = await adminListKbArticles({
    q: p.get("q")?.trim() || undefined,
    status: status === "draft" || status === "published" ? status : undefined,
    categoryId: p.get("category")?.trim() || undefined,
    tagId: p.get("tag")?.trim() || undefined,
    section: p.get("section")?.trim() || undefined,
  });
  return NextResponse.json({ articles });
});

export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("knowledge.manage");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = parseArticleInput(body, KNOWN_SECTION_KEYS);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const id = await adminCreateKbArticle(parsed.input, session.padmin);
    await platformAudit({
      adminId: session.padmin,
      action: "knowledge_article.create",
      entity: "knowledge_articles",
      entityId: id,
      payload: { slug: parsed.input.slug, status: parsed.input.status },
    });
    return NextResponse.json({ ok: true, id, slug: parsed.input.slug });
  } catch (err) {
    return knowledgeError(err);
  }
});
