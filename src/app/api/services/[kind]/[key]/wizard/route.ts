import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  getServiceWizardState,
  saveServiceWizardState,
} from "@/lib/service-activation/activation-service";
import { isServiceKey, isServiceKind, type ServiceIdentity } from "@/lib/service-activation/catalog";

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
  const progress =
    body.progress && typeof body.progress === "object" && !Array.isArray(body.progress)
      ? (body.progress as Record<string, unknown>)
      : {};

  const wizard = await saveServiceWizardState({
    businessId: session.businessId,
    identity,
    step: body.step.trim().slice(0, 100),
    progress,
    completed: body.completed === true,
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
