import { NextRequest, NextResponse } from "next/server";
import {withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listDeals, upsertDeal } from "@/lib/crm-service";
import { defaultPipeline, listPipelines } from "@/lib/crm-pipeline-service";
import { isDealStage, type DealStage } from "@/lib/crm-shared";
import { isUuid } from "@/lib/uuid";
import { tomanToRial } from "@/lib/money";
import { listAssignableMembers } from "@/lib/crm-ownership";
import {
  dealViewOwnerUserId,
  dealViewQuery,
  dealViewRialBounds,
  dealViewUnownedOnly,
  parseDealViewFilters,
} from "@/lib/crm-deal-views";

/**
 * The sales pipeline (Phase 36).
 *
 * Owner/manager only: a deal carries a revenue expectation and an owner's name,
 * which is forecasting data rather than floor data.
 *
 * **A deal posts no money.** `valueRial` is what someone expects to sell, not
 * what was sold; revenue appears when an order or invoice is settled through
 * the sales path that already posts correctly. Winning a deal here writes
 * nothing to the ledger — see the note on `crm_deals` in migration 0118. The
 * optional `orderId` is how a won deal points *at* the sale that realised it.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmView);
  if (error) return error;

  const search = request.nextUrl.searchParams;
  const stage = search.get("stage");

  // The screen's own parser, not a second reading of the same names: a view
  // saved from the board and a link pasted into the address bar are interpreted
  // by exactly one function (`crm-deal-views.ts`), so "the filter the UI shows"
  // and "the filter the server applies" cannot drift apart.
  const { filters, error: filterError } = parseDealViewFilters(search);
  if (filterError) {
    return NextResponse.json({ error: "bad_filter", field: filterError }, { status: 400 });
  }

  const ownerUserId = dealViewOwnerUserId(filters, session.sub);
  const bounds = dealViewRialBounds(filters);
  const deals = await listDeals(session.businessId, {
    customerId: search.get("customerId") ?? undefined,
    stage: stage && isDealStage(stage) ? (stage as DealStage) : undefined,
    stageId: filters.stageId || undefined,
    pipelineId: filters.pipelineId || undefined,
    q: filters.q || undefined,
    ownerUserId,
    // `mine` for a caller with no member id, or `none`, means "nobody" rather
    // than "everybody" — the safe direction for a filter about ownership.
    unowned: dealViewUnownedOnly(filters) || (filters.owner === "mine" && !ownerUserId),
    minValueRial: bounds.minValueRial,
    maxValueRial: bounds.maxValueRial,
    openOnly: filters.openOnly,
  });

  // The board's columns come from the database, not from the six-value
  // constant the UI used to hardcode: a business that renamed «واجد شرایط» to
  // «ارزیابی» sees its own words, and a business with a second pipeline can
  // open it. `?pipelineId=` selects one; the default is used otherwise, and
  // `defaultPipeline` self-heals a tenant that has none.
  const requestedPipelineId = search.get("pipelineId");
  const pipeline =
    requestedPipelineId && isUuid(requestedPipelineId)
      ? (await listPipelines(session.businessId, { includeArchived: true })).find(
          (entry) => entry.id === requestedPipelineId,
        ) ?? (await defaultPipeline(session.businessId))
      : await defaultPipeline(session.businessId);
  const pipelines = (await listPipelines(session.businessId)).map((entry) => ({
    id: entry.id,
    name: entry.name,
    isDefault: entry.isDefault,
  }));

  // The filters the server actually applied, echoed back in the vocabulary the
  // screen sent them in. The client renders its chips from this rather than
  // from its own state, so a list can never be labelled with a filter that was
  // dropped on the way (a reserved key, a mixed-version deployment).
  const applied = dealViewQuery(filters);
  // The members the owner filter can name, for the chip and the picker. Read
  // through the same list the assignee picker uses, so an inactive member's
  // name is available here too — reassignment starts by seeing who holds what.
  const members = (await listAssignableMembers(session.businessId)).map((member) => ({
    id: member.id,
    name: member.name,
    isActive: member.isActive,
  }));

  return NextResponse.json({ deals, pipeline, pipelines, applied, members });
});

interface DealBody {
  id?: string;
  customerId?: string | null;
  title?: string;
  description?: string;
  /** The canonical stage row. Preferred over `stage` wherever the caller has it. */
  stageId?: string;
  stage?: string;
  /** The UI speaks Toman; storage is integer Rial. Converted here, once. */
  valueToman?: number;
  valueRial?: number;
  probability?: number | null;
  expectedCloseDate?: string | null;
  ownerUser?: string;
  /** The owner as a member id. Preferred over `ownerUser`, which stays the snapshot. */
  ownerUserId?: string | null;
  source?: string;
  lostReason?: string | null;
  orderId?: string | null;
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmManage);
  if (error) return error;

  let body: DealBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const title = body.title?.trim();
  if (!title) return NextResponse.json({ error: "deal_title_required" }, { status: 400 });
  if (body.stageId !== undefined && !isUuid(body.stageId)) {
    return NextResponse.json({ error: "deal_stage_invalid" }, { status: 400 });
  }
  if (body.ownerUserId !== undefined && body.ownerUserId !== null && !isUuid(body.ownerUserId)) {
    return NextResponse.json({ error: "deal_owner_invalid" }, { status: 400 });
  }
  if (body.stage !== undefined && !isDealStage(body.stage)) {
    return NextResponse.json({ error: "deal_stage_invalid" }, { status: 400 });
  }
  if (
    body.probability !== undefined &&
    body.probability !== null &&
    (!Number.isFinite(body.probability) || body.probability < 0 || body.probability > 100)
  ) {
    return NextResponse.json({ error: "deal_probability_invalid" }, { status: 400 });
  }

  const valueRial =
    body.valueRial !== undefined
      ? Math.round(body.valueRial)
      : body.valueToman !== undefined
        ? tomanToRial(body.valueToman)
        : 0;
  if (!Number.isFinite(valueRial) || valueRial < 0) {
    return NextResponse.json({ error: "deal_value_invalid" }, { status: 400 });
  }

  const deal = await upsertDeal(session.businessId, {
    id: body.id,
    customerId: body.customerId ?? null,
    title,
    description: body.description,
    stageId: body.stageId,
    stage: body.stage as DealStage | undefined,
    valueRial,
    probability: body.probability,
    expectedCloseDate: body.expectedCloseDate ?? null,
    ownerUser: body.ownerUser,
    ownerUserId: body.ownerUserId ?? null,
    source: body.source,
    lostReason: body.lostReason ?? null,
    orderId: body.orderId ?? null,
    createdBy: session.fullName,
    createdById: session.sub,
  });
  return NextResponse.json({ deal }, { status: body.id ? 200 : 201 });
});
