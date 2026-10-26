import { NextRequest, NextResponse } from "next/server";
import {
  platformAudit,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import {
  createKavenegarManagementClient,
  enqueueManagedAccountJob,
  getManagedServiceConsoleSnapshot,
  probeCustomerManagementEligibility,
  transferManagedCredit,
  type ProvisioningJobKind,
} from "@/lib/kavenegar/provisioning-service";
import { isValidSenderLines, saveManagedChildPolicy } from "@/lib/kavenegar/policy";
import { fundManagedChild, getManagedMarginReport } from "@/lib/kavenegar/pricing-service";
import { listReconciliationRuns, reconcileManagedChild } from "@/lib/kavenegar/reconciliation-service";
import { submitLookupTemplate, syncLookupTemplates } from "@/lib/kavenegar/template-service";

/**
 * Issue #902 — the Superadmin control plane for managed SMS accounts.
 *
 * Everything here is provider-facing and therefore Superadmin-only, behind
 * `messaging.manage` (the capability that already owns SMS/email technical
 * configuration). Two rules shape the surface:
 *
 *   * **Reads never return a credential.** `getManagedServiceConsoleSnapshot`
 *     ships `keyHint` (last four) and no ciphertext, plaintext, provider error
 *     body or password. Provider names/tariffs ARE present — this is the one
 *     place they are allowed.
 *   * **Writes enqueue, they do not call the provider inline.** A create can
 *     take seconds and may be ambiguous; the durable job is what makes it
 *     recoverable. The single exception is the eligibility probe, which is an
 *     explicit operator action whose whole point is the live answer.
 *
 * Tenant-facing readiness is deliberately NOT here: it comes from
 * `/api/messaging` as the contract's provider-free shape.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformCapability("messaging.manage");
  if (error) return error;

  const until = new Date();
  const since = new Date(until.getTime() - 30 * 24 * 60 * 60_000);
  const [snapshot, margin, reconciliation] = await Promise.all([
    getManagedServiceConsoleSnapshot(),
    getManagedMarginReport({ since, until }),
    listReconciliationRuns({ limit: 25 }),
  ]);
  return NextResponse.json({
    ...snapshot,
    // Wholesale vs. retail over the last 30 days. Retail is Billing's number,
    // provider cost is theirs; this screen only compares them.
    margin,
    // Stored evidence, drift first. Provider detail is allowed on this surface;
    // it never travels to a tenant.
    reconciliation,
  });
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("messaging.manage");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "";
  const businessId = typeof body.businessId === "string" ? body.businessId : "";

  if (action === "policy") {
    if (body.senderLines !== undefined && typeof body.senderLines === "string" && !isValidSenderLines(body.senderLines)) {
      return NextResponse.json({ error: "invalid_sender_lines" }, { status: 400 });
    }
    if (body.planId !== undefined && body.planId !== null && !isPositiveInteger(body.planId)) {
      return NextResponse.json({ error: "invalid_plan_id" }, { status: 400 });
    }
    if (
      body.minAllowedCreditRial !== undefined &&
      !isNonNegativeInteger(body.minAllowedCreditRial)
    ) {
      return NextResponse.json({ error: "invalid_min_credit" }, { status: 400 });
    }
    if (
      body.fundingBufferMessages !== undefined &&
      !isNonNegativeInteger(body.fundingBufferMessages)
    ) {
      return NextResponse.json({ error: "invalid_funding_buffer" }, { status: 400 });
    }
    for (const key of ["fundingChildCapRial", "fundingDailyCapRial", "fundingMasterFloorRial"] as const) {
      if (body[key] !== undefined && body[key] !== null && !isNonNegativeInteger(body[key])) {
        return NextResponse.json({ error: "invalid_funding_cap" }, { status: 400 });
      }
    }

    const policy = await saveManagedChildPolicy({
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      planId:
        body.planId === null
          ? null
          : body.planId === undefined
            ? undefined
            : Number(body.planId),
      minAllowedCreditRial:
        body.minAllowedCreditRial === undefined ? undefined : Number(body.minAllowedCreditRial),
      senderLines: typeof body.senderLines === "string" ? body.senderLines : undefined,
      note: typeof body.note === "string" ? body.note : body.note === null ? null : undefined,
      fundingBufferMessages:
        body.fundingBufferMessages === undefined ? undefined : Number(body.fundingBufferMessages),
      fundingChildCapRial: optionalNumberOrNull(body.fundingChildCapRial),
      fundingDailyCapRial: optionalNumberOrNull(body.fundingDailyCapRial),
      fundingMasterFloorRial:
        body.fundingMasterFloorRial === undefined ? undefined : Number(body.fundingMasterFloorRial),
    });
    await platformAudit({
      adminId: session.padmin,
      action: "sms.managed_account.policy",
      entity: "platform_sms_config",
      entityId: "1",
      payload: {
        enabled: policy.enabled,
        planId: policy.planId,
        minAllowedCreditRial: policy.minAllowedCreditRial,
        senderLineCount: policy.senderLines.length,
        fundingBufferMessages: policy.fundingBufferMessages,
        fundingChildCapRial: policy.fundingChildCapRial,
        fundingDailyCapRial: policy.fundingDailyCapRial,
        fundingMasterFloorRial: policy.fundingMasterFloorRial,
      },
    });
    return NextResponse.json({ policy });
  }

  if (action === "probe") {
    const result = await probeCustomerManagementEligibility();
    await platformAudit({
      adminId: session.padmin,
      action: "sms.managed_account.probe",
      entity: "kavenegar_business_accounts",
      payload: { eligible: result.eligible, code: result.code },
    });
    return NextResponse.json(result);
  }

  if (action === "transfer") {
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
    if (!UUID.test(businessId) || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      return NextResponse.json({ error: "invalid_transfer_request" }, { status: 400 });
    }
    if (!isSignedInteger(body.amountRial) || Math.abs(Number(body.amountRial)) < 1_000) {
      return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
    }
    try {
      const result = await transferManagedCredit({
        businessId,
        amountRial: Number(body.amountRial),
        idempotencyKey,
        requestedBy: session.padmin,
        reason: typeof body.reason === "string" ? body.reason.slice(0, 200) : undefined,
      });
      await platformAudit({
        adminId: session.padmin,
        businessId,
        action: "sms.managed_account.transfer",
        entity: "kavenegar_credit_transfers",
        entityId: result.transfer.id,
        payload: {
          amountRial: Number(result.transfer.amount_rial),
          state: result.transfer.state,
          duplicate: result.duplicate,
        },
      });
      return NextResponse.json({
        transfer: {
          id: result.transfer.id,
          state: result.transfer.state,
          amountRial: Number(result.transfer.amount_rial),
          balanceAfterRial:
            result.transfer.balance_after_rial === null ? null : Number(result.transfer.balance_after_rial),
        },
        duplicate: result.duplicate,
      });
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "transfer_failed";
      return NextResponse.json({ error: code }, { status: 409 });
    }
  }

  if (action === "fund") {
    if (!UUID.test(businessId)) {
      return NextResponse.json({ error: "invalid_business" }, { status: 400 });
    }
    const masterBalanceRial =
      body.masterBalanceRial === undefined || body.masterBalanceRial === null
        ? null
        : isNonNegativeInteger(body.masterBalanceRial)
          ? Number(body.masterBalanceRial)
          : null;
    // A supplied-but-invalid balance must not silently become "unknown": that
    // would bypass a configured master floor.
    if (body.masterBalanceRial !== undefined && body.masterBalanceRial !== null && masterBalanceRial === null) {
      return NextResponse.json({ error: "invalid_master_balance" }, { status: 400 });
    }
    const execution = await fundManagedChild({
      businessId,
      client: await createKavenegarManagementClient(),
      masterBalanceRial,
    });
    if (!execution) return NextResponse.json({ error: "account_missing" }, { status: 404 });
    await platformAudit({
      adminId: session.padmin,
      businessId,
      action: "sms.managed_account.fund",
      entity: "kavenegar_credit_transfers",
      entityId: execution.transfer?.id ?? businessId,
      payload: {
        decision: execution.plan.decision.reason,
        amountRial: execution.transfer?.amountRial ?? 0,
        state: execution.transfer?.state ?? "none",
        duplicate: execution.duplicate,
      },
    });
    return NextResponse.json({
      decision: execution.plan.decision,
      transferredTodayRial: execution.plan.transferredTodayRial,
      unresolvedTransferRial: execution.plan.unresolvedTransferRial,
      transfer: execution.transfer,
      duplicate: execution.duplicate,
    });
  }

  if (action === "reconcile") {
    if (!UUID.test(businessId)) {
      return NextResponse.json({ error: "invalid_business" }, { status: 400 });
    }
    const run = await reconcileManagedChild({
      businessId,
      client: await createKavenegarManagementClient(),
    });
    if (!run) return NextResponse.json({ error: "account_missing" }, { status: 404 });
    await platformAudit({
      adminId: session.padmin,
      businessId,
      action: "sms.managed_account.reconcile",
      entity: "kavenegar_reconciliation_runs",
      entityId: run.id,
      payload: {
        state: run.state,
        deltaRial: run.delta_rial === null ? null : Number(run.delta_rial),
        providerCostRial: Number(run.provider_cost_rial),
      },
    });
    return NextResponse.json({ run });
  }

  if (action === "template_submit") {
    const templateId = typeof body.templateId === "string" ? body.templateId : "";
    if (!UUID.test(templateId)) {
      return NextResponse.json({ error: "invalid_template" }, { status: 400 });
    }
    const template = await submitLookupTemplate({
      templateId,
      client: await createKavenegarManagementClient(),
      primaryLineNumber: typeof body.primaryLineNumber === "string" ? body.primaryLineNumber : undefined,
    });
    await platformAudit({
      adminId: session.padmin,
      businessId: template.business_id,
      action: "sms.managed_account.template_submit",
      entity: "kavenegar_lookup_templates",
      entityId: template.id,
      payload: { state: template.state, providerTemplateId: template.provider_template_id },
    });
    return NextResponse.json({ template });
  }

  if (action === "template_sync") {
    if (!UUID.test(businessId)) {
      return NextResponse.json({ error: "invalid_business" }, { status: 400 });
    }
    const result = await syncLookupTemplates({
      businessId,
      client: await createKavenegarManagementClient(),
    });
    await platformAudit({
      adminId: session.padmin,
      businessId,
      action: "sms.managed_account.template_sync",
      entity: "kavenegar_lookup_templates",
      entityId: businessId,
      payload: result,
    });
    return NextResponse.json(result);
  }

  const jobKind = jobKindFor(action);
  if (!jobKind) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (!UUID.test(businessId)) return NextResponse.json({ error: "invalid_business" }, { status: 400 });

  const result = await enqueueManagedAccountJob({
    businessId,
    kind: jobKind,
    requestedBy: session.padmin,
  });
  await platformAudit({
    adminId: session.padmin,
    businessId,
    action: `sms.managed_account.${action}`,
    entity: "kavenegar_business_accounts",
    entityId: businessId,
    payload: { kind: jobKind, enqueued: result.enqueued, state: result.state },
  });
  return NextResponse.json(result);
});

function jobKindFor(action: string): ProvisioningJobKind | null {
  switch (action) {
    case "provision":
      return "provision";
    case "sync":
      return "sync";
    case "suspend":
      return "suspend";
    case "reactivate":
      return "reactivate";
    case "rotate_key":
      return "rotate_key";
    case "adopt":
      return "adopt";
    default:
      return null;
  }
}

function isPositiveInteger(value: unknown): boolean {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0;
}

function isNonNegativeInteger(value: unknown): boolean {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0;
}

function optionalNumberOrNull(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function isSignedInteger(value: unknown): boolean {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number);
}
