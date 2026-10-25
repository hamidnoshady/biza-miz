import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  activateService,
  disableService,
  getServiceActivation,
  getServiceWizardState,
  listServiceRuntimeSummary,
  reenableService,
  settleServiceRuntime,
} from "@/lib/service-activation/activation-service";
import { quoteService } from "@/lib/service-activation/pricing-service";
import {
  effectiveRetentionPolicy,
  listServicePurgeJournal,
  servicePurgePlan,
} from "@/lib/service-activation/retention-service";
import {
  isServiceKey,
  isServiceKind,
  type ServiceIdentity,
} from "@/lib/service-activation/catalog";
import { wizardProgress, wizardStepsFor } from "@/lib/service-activation/wizard";

interface Ctx {
  params: Promise<{ kind: string; key: string }>;
}

/**
 * One service, as the customer sees it: its state, the binding quote, the
 * retention policy actually in force, the dry-run destruction plan and the
 * history of every lifecycle step.
 *
 * The quote is the number the confirm button must show — setup debit, hourly
 * tariff, first-interval reserve, 24h/30d estimates and the additional
 * AI/provider/storage/SMS charges that are NOT part of this tariff.
 */
export const GET = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.billingView);
  if (error) return error;

  const identity = await parseIdentity(ctx);
  if (!identity) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const url = new URL(request.url);
  const runtimeInstanceId = url.searchParams.get("runtimeInstanceId")?.trim() || "";
  const fullIdentity: ServiceIdentity = { ...identity, runtimeInstanceId };

  const [activation, quote, policy, wizard, journal, runtime] = await Promise.all([
    getServiceActivation(session.businessId, fullIdentity),
    quoteService(session.businessId, fullIdentity),
    effectiveRetentionPolicy(session.businessId, identity.kind, identity.key),
    getServiceWizardState(session.businessId, fullIdentity),
    listServicePurgeJournal(session.businessId),
    listServiceRuntimeSummary(session.businessId),
  ]);

  return NextResponse.json({
    identity: fullIdentity,
    activation,
    quote,
    retentionPolicy: policy,
    purgePlan: servicePurgePlan(identity.kind, identity.key),
    wizard,
    purgeJournal: journal,
    runtime: runtime.filter(
      (row) =>
        row.identity.kind === identity.kind &&
        row.identity.key === identity.key &&
        (row.identity.runtimeInstanceId ?? "") === runtimeInstanceId,
    ),
  });
});

type ServiceAction = "activate" | "disable" | "reenable" | "settle";

/**
 * Enable / disable / re-enable one service.
 *
 * Everything that can spend money requires `billing.manage` — the same
 * permission the wallet and plan purchases use. The service layer re-checks the
 * tariff, the app's availability, wallet cover and the activation's state
 * inside one locked transaction, so a duplicate or parallel POST cannot
 * double-charge (issue #1041's acceptance list).
 *
 * `disable` is the ONLY action here that starts a retention countdown; it
 * deletes nothing and returns the exact deadline the customer is shown.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.billingManage);
  if (error) return error;

  const identity = await parseIdentity(ctx);
  if (!identity) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: {
    action?: unknown;
    requestId?: unknown;
    runtimeInstanceId?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const action = body.action;
  if (action !== "activate" && action !== "disable" && action !== "reenable" && action !== "settle") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const fullIdentity: ServiceIdentity = {
    ...identity,
    runtimeInstanceId:
      typeof body.runtimeInstanceId === "string" ? body.runtimeInstanceId.trim() : "",
  };
  const requestId = typeof body.requestId === "string" ? body.requestId.slice(0, 200) : null;
  const businessId = session.businessId;
  const actorUserId = session.sub;

  // Wizard completion is a server-side activation precondition, not just a
  // client-side courtesy. Without it a caller could POST directly, take the
  // one-time setup fee, and start an app whose activation questions were never
  // answered. Re-enablement after a purge also needs a fresh operational setup;
  // the once-paid proof lives separately and this check never charges it again.
  if (action === "activate" || action === "reenable") {
    const wizard = await getServiceWizardState(businessId, fullIdentity);
    const steps = wizardStepsFor(identity.kind, identity.key);
    const completion = wizardProgress(steps, wizard?.progress ?? {});
    if (!completion.complete) {
      return NextResponse.json(
        {
          error: "wizard_incomplete",
          nextStep: completion.nextStep?.key ?? null,
          service: identity.key,
        },
        { status: 409 },
      );
    }
  }

  if (action === "activate") {
    const result = await activateService({
      businessId,
      identity: fullIdentity,
      requestId,
      actorUserId,
    });
    return respond(result);
  }

  if (action === "reenable") {
    const result = await reenableService({
      businessId,
      identity: fullIdentity,
      requestId,
      actorUserId,
    });
    return respond(result);
  }

  if (action === "disable") {
    const result = await disableService({ businessId, identity: fullIdentity, actorUserId });
    return respond(result);
  }

  const settlement = await settleServiceRuntime({ businessId, identity: fullIdentity });
  return NextResponse.json({ settlement });
});

async function parseIdentity(ctx: Ctx): Promise<Omit<ServiceIdentity, "runtimeInstanceId"> | null> {
  const { kind, key } = await ctx.params;
  if (!isServiceKind(kind)) return null;
  const decoded = decodeURIComponent(key ?? "");
  if (!isServiceKey(kind, decoded)) return null;
  return { kind, key: decoded };
}

const STATUS: Record<string, number> = {
  not_found: 404,
  not_configured: 409,
  insufficient_credit: 402,
  unavailable: 409,
  conflict: 409,
};

function respond(result: { status: string } & Record<string, unknown>) {
  if (result.status === "activated" || result.status === "reenabled") {
    return NextResponse.json(result);
  }
  if (result.status === "already_active" || result.status === "already_disabled") {
    return NextResponse.json(result);
  }
  return NextResponse.json(result, { status: STATUS[result.status] ?? 409 });
}
