import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  createResearchRun,
  listResearchRuns,
} from "@/lib/ai-research";
import {
  RESEARCH_DEFAULT_MAX_ROUNDS,
  RESEARCH_DEFAULT_SPEND_CAP_USD,
  estimateResearchMaxCostUsd,
} from "@/lib/ai-research-shared";
import { getPlatformAiMode, isAiRuntimeModeAvailable } from "@/lib/ai-runtime-modes";

/**
 * Issue #812 §5 — Deep Research, the cost-approved isolated workflow.
 *
 * POST does NOT start a run. It creates one in `awaiting_approval` carrying the
 * estimated maximum cost the member is being asked to agree to, and that
 * estimate is computed here from the platform's own caps — never read from the
 * request. The member approves on the next call, to `[id]/approve`, and only
 * that call starts the environment.
 *
 * A run the platform has switched off is refused before anything is written:
 * §6 gives Superadmin an on/off switch, and it has to mean something.
 */
export const GET = withTenantScope(async () => {
  // §11 — reading a run history is an assistant capability, not a management
  // one: the runs listed are this member's own, and the read is scoped by
  // `userId` below. `withTenantScope` establishes the business; this is what
  // establishes that the caller may spend its budget at all.
  const guard = await requirePermission(PERMISSIONS.aiUse);
  if (guard.error) return guard.error;
  const session = guard.session;
  const runs = await listResearchRuns({ businessId: session.businessId, userId: session.sub });
  return NextResponse.json({ runs });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  // Deep research spends real money on a model call, so it is a chat capability
  // (`ai.use`) rather than a management one. `withTenantScope` establishes the
  // business; this establishes the capability. `getSession()` alone proved only
  // that the caller belongs to the business, which is not the same question.
  const guard = await requirePermission(PERMISSIONS.aiUse);
  if (guard.error) return guard.error;
  const session = guard.session;

  const mode = await getPlatformAiMode("deep_research");
  if (!isAiRuntimeModeAvailable("deep_research", mode.is_active)) {
    return NextResponse.json({ error: "research_disabled" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as
    | {
        question?: string;
        costApproved?: boolean;
        locationId?: string | null;
        appKey?: string | null;
        projectId?: string | null;
        maxRounds?: number;
        maxContextChars?: number;
        spendCapUsd?: number;
        modelAlias?: string;
      }
    | null;
  const question = (body?.question ?? "").trim();
  if (question.length < 8) {
    return NextResponse.json({ error: "research_question_too_short" }, { status: 400 });
  }

  // The estimate is derived from the caps the platform configured, so the
  // figure the member agrees to cannot be talked down by the client.
  const maxRounds = Math.max(1, Math.min(12, Math.floor(body?.maxRounds ?? RESEARCH_DEFAULT_MAX_ROUNDS)));
  const spendCapUsd = Math.max(0.01, Math.min(100, body?.spendCapUsd ?? RESEARCH_DEFAULT_SPEND_CAP_USD));
  const estimatedMaxCostUsd = estimateResearchMaxCostUsd({ maxRounds });
  if (!body?.costApproved) {
    return NextResponse.json(
      { error: "research_cost_not_approved", estimatedMaxCostUsd, spendCapUsd, maxRounds },
      { status: 402 },
    );
  }

  const created = await createResearchRun({
    businessId: session.businessId,
    userId: session.sub,
    question,
    costApproved: true,
    locationId: body?.locationId ?? null,
    appKey: body?.appKey ?? null,
    projectId: body?.projectId ?? null,
    maxRounds,
    maxContextChars: body?.maxContextChars,
    spendCapUsd,
    modelAlias: mode.model_alias || body?.modelAlias || "",
  });
  if (!created.ok) return NextResponse.json({ error: created.error }, { status: 400 });
  return NextResponse.json({ run: created.run }, { status: 201 });
});

