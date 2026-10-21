import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { KB_SEARCH_MAX_LENGTH } from "@/lib/knowledge";
import { searchKbArticles } from "@/lib/knowledge-service";

/**
 * Knowledge-centre search (migration 0131): ranked full-text search over
 * published, member-visible articles (title/slug/summary weighted up).
 *
 * `q` in the query string; an empty query is not an error — it is "no results
 * yet", which the UI shows as the untouched search box. Queries longer than
 * `KB_SEARCH_MAX_LENGTH` are rejected rather than clipped silently, and the
 * optional `limit` is clamped by the service (1…50).
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { error } = await requireMember();
  if (error) return error;

  const q = (request.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length > KB_SEARCH_MAX_LENGTH) {
    return NextResponse.json({ error: "query_too_long" }, { status: 400 });
  }
  const rawLimit = Number(request.nextUrl.searchParams.get("limit") ?? "");
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.trunc(rawLimit) : 20;
  const results = await searchKbArticles(q, limit);
  return NextResponse.json({ q, results });
});
