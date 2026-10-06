import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  createPipeline,
  defaultPipeline,
  listPipelines,
  pipelineStageUsage,
} from "@/lib/crm-pipeline-service";

/**
 * The sales pipelines and their stages.
 *
 * `crm.configure`, not `crm.view`: reading the board is one right and reshaping
 * the columns every historical report is keyed to is another — the second one
 * is what a stage rename does, and it applies to deals people closed last year.
 * The board itself reads its stages from `GET /api/crm/deals` under `crm.view`;
 * this route is the configurator behind `/crm/settings`.
 *
 * ## Why `usage` comes back with the list
 *
 * The configurator must not let somebody delete a stage that still holds deals
 * — `savePipelineStages` refuses it, because a deleted stage leaves those deals
 * on no board at all. A refusal the user only meets after pressing save is a
 * dead end; sending the counts alongside means the screen can say «۳ معامله در
 * این مرحله است — غیرفعالش کنید» before the attempt. The counts are advisory to
 * the UI and authoritative in the service, never the other way round.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmConfigure);
  if (error) return error;

  // Reading the list is also what self-heals a business with no pipeline yet —
  // `defaultPipeline` creates it, exactly as the deals board does, so the
  // configurator cannot open onto an empty page on a freshly provisioned tenant.
  const requested = request.nextUrl.searchParams.get("pipelineId");
  const pipelines = await listPipelines(session.businessId, { includeArchived: true });
  if (pipelines.length === 0) await defaultPipeline(session.businessId);

  const all = pipelines.length === 0
    ? await listPipelines(session.businessId, { includeArchived: true })
    : pipelines;
  const usage = await Promise.all(
    all.map(async (pipeline) => ({
      pipelineId: pipeline.id,
      stages: await pipelineStageUsage(session.businessId, pipeline.id),
    })),
  );

  return NextResponse.json({
    pipelines: all,
    usage,
    selectedPipelineId: requested && all.some((pipeline) => pipeline.id === requested)
      ? requested
      : (all.find((pipeline) => pipeline.isDefault) ?? all[0])?.id ?? null,
  });
});

interface PipelineBody {
  name?: string;
  description?: string;
  isDefault?: boolean;
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmConfigure);
  if (error) return error;

  let body: PipelineBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await createPipeline(
    session.businessId,
    { name: body.name ?? "", description: body.description, isDefault: body.isDefault },
    { name: session.fullName, userId: session.sub },
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 400 });
  }
  return NextResponse.json({ pipeline: result.pipeline }, { status: 201 });
});
