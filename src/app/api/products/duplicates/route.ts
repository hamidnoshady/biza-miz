import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { readBoundedJson } from "@/lib/product-attributes";
import {
  archiveDuplicateOrphanFromReview,
  listDuplicateCandidateSkus,
  loadDuplicateReviewGroups,
  recordDuplicateKeepSeparate,
} from "@/lib/duplicate-items-review-service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Issue #1207 §C — the duplicate review behind «بررسی محصول تکراری».
 *
 * Read-only on GET: the same tenant-scoped, `READ ONLY` report the operator
 * script uses, plus each candidate's archive plan and review state. POST records
 * one of exactly two decisions and nothing else:
 *
 *  - `keep_separate` — «نگهداری جداگانه»: an audited "these are different rows";
 *  - `archive_orphan` — the existing guarded, reversible archive of a proven
 *    creation-race twin that nothing references.
 *
 * Both echo the `reviewToken` the screen was shown, so a plan that changed in
 * the meantime is refused rather than acted on. Nothing here merges two items,
 * aggregates their stock or moves a sale.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  // The evidence is integration data (stores, remote ids): the same door the
  // products list's link column opens.
  const integrationAccess = await requirePermission(PERMISSIONS.integrationsView);
  if (integrationAccess.error) return integrationAccess.error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  // `summary=1` is what the list asks for: the flagged SKUs only, without
  // planning an archive for every one of them.
  if (request.nextUrl.searchParams.get("summary") === "1") {
    return NextResponse.json({ skus: await listDuplicateCandidateSkus(session.businessId) });
  }

  const sku = request.nextUrl.searchParams.get("sku")?.trim() || null;
  if (sku && sku.length > 120) return NextResponse.json({ error: "invalid_sku" }, { status: 400 });
  const groups = await loadDuplicateReviewGroups(session.businessId, { sku });
  return NextResponse.json({ groups });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const integrationAccess = await requirePermission(PERMISSIONS.integrationsManage);
  if (integrationAccess.error) return integrationAccess.error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  const parsed = await readBoundedJson(request, 8_192);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const body = parsed.value as Record<string, unknown> | null;
  if (
    !body ||
    typeof body.sku !== "string" ||
    !body.sku.trim() ||
    body.sku.length > 120 ||
    typeof body.reviewToken !== "string" ||
    !body.reviewToken ||
    body.confirm !== true
  ) {
    return NextResponse.json({ error: "invalid_duplicate_decision" }, { status: 400 });
  }

  try {
    if (body.action === "keep_separate") {
      const group = await recordDuplicateKeepSeparate(session.businessId, {
        sku: body.sku,
        reviewToken: body.reviewToken,
        actorUserId: session.sub,
      });
      return NextResponse.json({ ok: true, group });
    }
    if (body.action === "archive_orphan") {
      if (typeof body.orphanItemId !== "string" || !UUID_RE.test(body.orphanItemId)) {
        return NextResponse.json({ error: "invalid_duplicate_decision" }, { status: 400 });
      }
      const result = await archiveDuplicateOrphanFromReview(session.businessId, {
        sku: body.sku,
        orphanItemId: body.orphanItemId,
        reviewToken: body.reviewToken,
        actorUserId: session.sub,
      });
      if (!result.archived) return NextResponse.json({ error: "duplicate_not_safe_to_archive", blockers: result.blockers }, { status: 409 });
      const groups = await loadDuplicateReviewGroups(session.businessId, { sku: body.sku });
      return NextResponse.json({ ok: true, archived: result.archived, group: groups[0] ?? null });
    }
    return NextResponse.json({ error: "invalid_duplicate_decision" }, { status: 400 });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "duplicate_review_failed";
    if (!message.startsWith("duplicate_")) throw cause;
    return NextResponse.json({ error: message }, { status: 409 });
  }
});
