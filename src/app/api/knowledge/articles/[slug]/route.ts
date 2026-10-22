import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { getKbArticleBySlug } from "@/lib/knowledge-service";

interface Ctx {
  params: Promise<{ slug: string }>;
}

/**
 * One published knowledge-base article (migration 0131) with its tags and
 * related reads — the body «مرکز آموزش» renders with anchored headings,
 * video, images and code blocks.
 */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { error } = await requireMember();
  if (error) return error;

  const { slug } = await ctx.params;
  // A slug is a bounded URL segment (or a uuid); refuse an oversized path
  // before it reaches SQL.
  const decoded = decodeURIComponent(slug);
  if (decoded.length > 200) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const article = await getKbArticleBySlug(decoded);
  if (!article) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ article });
});
