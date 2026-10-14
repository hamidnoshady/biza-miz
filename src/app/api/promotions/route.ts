import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  listPromotionCatalogue,
  setPromotionActive,
  upsertPromotion,
  type PromotionInput,
} from "@/lib/promotions-service";

/**
 * The business's promotions, as the management catalogue (Phase 36b): full
 * rows — name, is_active, the date window — so the Growth app's campaigns
 * screen can label, order and pause them. The engine's own callers read
 * `listPromotions` server-side and never through this route.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.campaignsView);
  if (error) return error;
  return NextResponse.json({ promotions: await listPromotionCatalogue(session.businessId) });
});

/** Creates or edits one promotion. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.campaignsManage);
  if (error) return error;

  let body: PromotionInput;
  try {
    body = (await request.json()) as PromotionInput;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!body.name?.trim()) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  try {
    const promotion = await upsertPromotion(session.businessId, body);
    return NextResponse.json({ ok: true, promotion });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});

/**
 * Pause or resume one campaign.
 *
 * Separate from POST because pausing is not an edit. The screen used to toggle
 * by POSTing the entire row back with `isActive` flipped, which meant a
 * one-tap pause rewrote every column from whatever the browser last loaded —
 * clobbering any change made elsewhere in between — and, now that the
 * catalogue validates properly, a campaign stored before those rules existed
 * could not be switched off at all, because its own row no longer passed
 * validation on the way back in. One boolean in, one boolean written.
 */
export const PATCH = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.campaignsManage);
  if (error) return error;

  let body: { id?: unknown; isActive?: unknown };
  try {
    body = (await request.json()) as { id?: unknown; isActive?: unknown };
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (typeof body.id !== "string" || !body.id.trim() || typeof body.isActive !== "boolean") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const promotion = await setPromotionActive(session.businessId, body.id, body.isActive);
  if (!promotion) return NextResponse.json({ error: "promotion_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, promotion });
});
