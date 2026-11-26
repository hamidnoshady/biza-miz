import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { readPlatformIdentityAssurance } from "@/lib/iam/global-identity-service";
import {
  purchaseReadinessDeniedPayload,
  purchaseReadinessForAssurance,
} from "@/lib/identity-billing-contract";
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
import {
  enforceCommercialServiceAccess,
  resolveCommercialAvailability,
} from "@/lib/billing/resolver/access";
import { purchaseServiceTerm, quoteServiceTerm } from "@/lib/billing/resolver/service";
import { isServiceTermMonths } from "@/lib/billing/resolver/prepaid";

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

  const [activation, quote, policy, wizard, journal, runtime, commercial] = await Promise.all([
    getServiceActivation(session.businessId, fullIdentity),
    quoteService(session.businessId, fullIdentity),
    effectiveRetentionPolicy(session.businessId, identity.kind, identity.key),
    getServiceWizardState(session.businessId, fullIdentity),
    listServicePurgeJournal(session.businessId),
    listServiceRuntimeSummary(session.businessId),
    // #1380's UI contract: every availability axis stays separate, plus the
    // published prepaid term offers for this service (never a guessed price).
    resolveCommercialAvailability({ businessId: session.businessId, identity: fullIdentity }),
  ]);

  return NextResponse.json({
    identity: fullIdentity,
    activation,
    quote,
    commercial,
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

type ServiceAction =
  | "activate"
  | "disable"
  | "reenable"
  | "settle"
  | "term_quote"
  | "term_purchase";

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
    termMonths?: unknown;
    offerId?: unknown;
    expectedNetRial?: unknown;
    autoRenew?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const action = body.action;
  if (
    action !== "activate" &&
    action !== "disable" &&
    action !== "reenable" &&
    action !== "settle" &&
    action !== "term_quote" &&
    action !== "term_purchase"
  ) {
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

  // ESH-193: commercial availability is checked at this server boundary, not
  // only in the UI, for the actions that can start or extend a paid service.
  // `disable` and `settle` stay reachable: stopping a service must never be
  // blocked, and settlement already refuses to bill beyond the wallet.
  const gated = action === "activate" || action === "reenable" || action === "term_purchase";
  if (gated) {
    // ESH-199 / #1384 — commercial service activation and prepaid term
    // purchases share the exact global verified-mobile gate used by
    // `/api/billing/payments`. `disable`, `settle` and `term_quote` remain
    // reachable without phone verification.
    const assurance = session.platformUserId
      ? await readPlatformIdentityAssurance(session.platformUserId)
      : null;
    const readiness = purchaseReadinessForAssurance(assurance);
    if (!readiness.ok) {
      return NextResponse.json(purchaseReadinessDeniedPayload(readiness), { status: 403 });
    }

    const access = await enforceCommercialServiceAccess({
      businessId,
      identity: fullIdentity,
      intent: action === "activate" || action === "reenable" ? "activate" : "use",
    });
    if (!access.allowed) {
      return NextResponse.json(
        {
          error: access.reason,
          commercial: access.availability,
          shortfallRial: access.walletShortfallRial,
        },
        { status: access.reason === "unpaid_service" ? 402 : 409 },
      );
    }
  }

  if (action === "term_quote" || action === "term_purchase") {
    const termMonths = body.termMonths;
    if (!isServiceTermMonths(termMonths)) {
      return NextResponse.json({ error: "invalid_term" }, { status: 400 });
    }
    if (action === "term_quote") {
      const quote = await quoteServiceTerm({ businessId, identity: fullIdentity, termMonths });
      return NextResponse.json({ quote }, { status: quote.ok ? 200 : 409 });
    }
    const offerId = typeof body.offerId === "string" ? body.offerId : "";
    const expectedNetRial = Number(body.expectedNetRial);
    if (!offerId || !Number.isSafeInteger(expectedNetRial) || expectedNetRial < 0) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const purchase = await purchaseServiceTerm({
      businessId,
      identity: fullIdentity,
      termMonths,
      expectedOfferId: offerId,
      expectedNetRial,
      actorPlatformUserId: session.platformUserId ?? null,
      autoRenew: body.autoRenew === true,
    });
    if (purchase.status === "purchased") return NextResponse.json({ purchase });
    if (purchase.status === "insufficient_credit") {
      return NextResponse.json(
        { error: "insufficient_credit", requiredRial: purchase.requiredRial, balanceRial: purchase.balanceRial },
        { status: 402 },
      );
    }
    return NextResponse.json({ error: purchase.reason }, { status: 409 });
  }

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
