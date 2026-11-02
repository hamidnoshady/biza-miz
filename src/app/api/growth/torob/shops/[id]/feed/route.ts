import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { TorobShopError } from "@/lib/torob/shop-service";
import {
  TOROB_FEED_BLOCKED_COPY,
  buildShopFeed,
  type TorobFeedBlockedReason,
} from "@/lib/torob/feed-service";

/**
 * Issue #894 Wave 2 — «پیش‌نمایش فید»: what this shop would send to Torob.
 *
 * A `POST`, not a `GET`, and that is deliberate: a build writes a
 * `torob_feed_runs` row, so it is not a safe read. Making it a GET would let a
 * prefetch or a link preview manufacture run history and make "when was this feed
 * last built" a meaningless question.
 *
 * The response is Torob's own envelope for the first page plus the counts a
 * merchant can act on. What it is **not**: a claim that Torob received anything.
 * `status: "built"` means the platform assembled a feed; sending it is Wave 3's
 * runtime and its proof is Torob's response.
 */
export const POST = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.torobView);
  if (error) return error;
  const { id } = await context.params;

  try {
    const result = await buildShopFeed({
      businessId: session.businessId,
      shopId: id,
      createdBy: session.sub,
    });
    return NextResponse.json({
      status: result.status,
      builtAt: result.builtAt,
      // The reason is a code *and* the sentence, so a client never has to own a
      // second copy of the vocabulary (the same rule the rest of the app follows).
      blocked: result.blockedReason
        ? {
            reason: result.blockedReason,
            message: TOROB_FEED_BLOCKED_COPY[result.blockedReason as TorobFeedBlockedReason],
          }
        : null,
      summary: result.summary,
      page: result.firstPage,
      skipped: result.skipped,
      capabilities: { feed: true, sent: false, listing: false },
    });
  } catch (caught) {
    if (caught instanceof TorobShopError) {
      return NextResponse.json({ error: caught.code }, { status: 404 });
    }
    throw caught;
  }
});
