import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { knowledgePage } from "@/lib/knowledge-base";
import { learningRecommendationsFor } from "@/lib/learning-recommendation-service";

/**
 * Contextual learning recommendations (issue #972, Phase F).
 *
 * Deterministic, server-filtered and cached in-process for a minute: the same
 * eligible tours and paths the «آموزش» button offers, ranked for this member
 * and this page. It never starts a tour and never invents an id — the client
 * hands the chosen id to the existing runtime.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requireMember();
  if (guard.error) return guard.error;

  const rawPage = (request.nextUrl.searchParams.get("page") ?? "").trim();
  const page = rawPage ? knowledgePage(rawPage) : undefined;
  if (rawPage && !page) return NextResponse.json({ error: "unknown_page" }, { status: 400 });

  const recommendations = await learningRecommendationsFor({
    businessId: guard.session.businessId,
    userId: guard.session.sub,
    permissions: guard.membership.permissions,
    route: page?.route ?? null,
  });

  return NextResponse.json(
    { recommendations },
    { headers: { "Cache-Control": "no-store" } },
  );
});
