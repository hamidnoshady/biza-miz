import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  getServiceWizardState,
  saveServiceWizardState,
} from "@/lib/service-activation/activation-service";
import { isServiceKey, isServiceKind, type ServiceIdentity } from "@/lib/service-activation/catalog";
import {
  normalizeWizardProgress,
  validateWizardStep,
  wizardProgress,
  wizardStepsFor,
} from "@/lib/service-activation/wizard";

interface Ctx {
  params: Promise<{ kind: string; key: string }>;
}

/**
 * A service's own resumable setup wizard state (issue #1041 §B).
 *
 * Deliberately separate from `businesses.setup_progress/completedAt`: resuming
 * an app's wizard must never reopen the business's first-run onboarding
 * (PR #838). The data lives in `business_service_wizard_state`, which is
 * service-owned and is the one dataset the retention purge deletes.
 */
export const GET = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.billingView);
  if (error) return error;
  const identity = await parseIdentity(ctx, request);
  if (!identity) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const wizard = await getServiceWizardState(session.businessId, identity);
  return NextResponse.json({ wizard });
});

export const PUT = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.billingManage);
  if (error) return error;
  const identity = await parseIdentity(ctx, request);
  if (!identity) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { step?: unknown; progress?: unknown; completed?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.step !== "string" || body.step.trim().length === 0) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const submittedProgress =
    body.progress && typeof body.progress === "object" && !Array.isArray(body.progress)
      ? (body.progress as Record<string, unknown>)
      : {};
  const steps = wizardStepsFor(identity.kind, identity.key);
  const stepKey = body.step.trim().slice(0, 100);
  if (!steps.some((step) => step.key === stepKey)) {
    return NextResponse.json({ error: "invalid_wizard_step" }, { status: 400 });
  }
  // The server, not just the form, is the authority on the answer vocabulary:
  // unknown keys are dropped, values are trimmed/bounded, and a client cannot
  // mark an incomplete setup complete by posting { completed: true }.
  const progress = normalizeWizardProgress(steps, submittedProgress);
  const completion = wizardProgress(steps, progress);
  if (body.completed === true && !completion.complete) {
    const fault = completion.nextStep
      ? validateWizardStep(completion.nextStep, progress)
      : null;
    return NextResponse.json(
      { error: "wizard_incomplete", field: fault?.field, reason: fault?.code },
      { status: 400 },
    );
  }

  const wizard = await saveServiceWizardState({
    businessId: session.businessId,
    identity,
    step: stepKey,
    progress,
    completed: body.completed === true && completion.complete,
    actorUserId: session.sub,
  });
  return NextResponse.json({ wizard });
});

async function parseIdentity(
  ctx: Ctx,
  request: NextRequest,
): Promise<ServiceIdentity | null> {
  const { kind, key } = await ctx.params;
  if (!isServiceKind(kind)) return null;
  const decoded = decodeURIComponent(key ?? "");
  if (!isServiceKey(kind, decoded)) return null;
  const runtimeInstanceId =
    new URL(request.url).searchParams.get("runtimeInstanceId")?.trim() || "";
  return { kind, key: decoded, runtimeInstanceId };
}
