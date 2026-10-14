import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  listPipelines,
  pipelineStageUsage,
  savePipelineStages,
  type StageOutcome,
} from "@/lib/crm-pipeline-service";

/**
 * A pipeline's stages, replaced as one ordered list.
 *
 * Whole-list rather than per-stage because **ordering is a property of the
 * set**: saving stages one at a time leaves the board briefly in an order
 * nobody chose, and two managers reordering at once interleave into nonsense.
 *
 * The service owns every rule that protects existing deals — a stage holding
 * deals cannot be deleted, a pipeline keeps at least one open stage and one won
 * stage, duplicate names are refused before the unique index sees them — and it
 * runs them inside a transaction with the stage list locked `FOR UPDATE`. This
 * route only translates: it validates the shape of the JSON and maps the
 * outcome onto a status code, because a rule implemented twice (once here, once
 * in the service) is a rule that will disagree with itself.
 *
 * Returns the `usage` counts with the saved pipeline, so the configurator can
 * redraw its warnings from the same numbers the refusal would have used.
 */
export const PUT = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmConfigure);
    if (error) return error;

    let body: { stages?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (!Array.isArray(body.stages)) {
      return NextResponse.json({ error: "stages_required" }, { status: 400 });
    }

    const { id } = await params;
    const stages = body.stages.flatMap((raw) => {
      if (!raw || typeof raw !== "object") return [];
      const stage = raw as Record<string, unknown>;
      if (typeof stage.name !== "string") return [];
      return [
        {
          id: typeof stage.id === "string" ? stage.id : undefined,
          name: stage.name,
          displayOrder: typeof stage.displayOrder === "number" ? stage.displayOrder : undefined,
          defaultProbability:
            typeof stage.defaultProbability === "number" ? stage.defaultProbability : undefined,
          outcome:
            stage.outcome === "open" || stage.outcome === "won" || stage.outcome === "lost"
              ? (stage.outcome as StageOutcome)
              : undefined,
          isActive: stage.isActive !== false,
          requirementNote: typeof stage.requirementNote === "string" ? stage.requirementNote : "",
        },
      ];
    });

    const result = await savePipelineStages(session.businessId, id, stages, {
      name: session.fullName,
      userId: session.sub,
    });
    if (!result.pipeline) {
      const status = result.error === "not_found" ? 404 : result.error === "stage_in_use" ? 409 : 400;
      return NextResponse.json({ error: result.error ?? "stages_invalid", blocking: result.blocking }, { status });
    }

    const pipelines = await listPipelines(session.businessId, { includeArchived: true });
    return NextResponse.json({
      pipeline: result.pipeline,
      pipelines,
      usage: {
        pipelineId: id,
        stages: await pipelineStageUsage(session.businessId, id),
      },
    });
  },
);
