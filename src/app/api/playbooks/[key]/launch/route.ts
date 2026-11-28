import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { isAppAvailable } from "@/lib/app-availability-service";
import { isModuleEnabled } from "@/lib/industry-guard";
import { playbookByKey } from "@/lib/playbooks/catalog";
import { resolveAdaptiveContextForMember } from "@/lib/adaptive-context-service";
import { evaluateEligibility } from "@/lib/playbooks/eligibility";
import { buildPreflightForTemplate } from "@/lib/playbooks/preflight-service";
import { validateQuickInputs } from "@/lib/playbooks/quick-input";
import { launchPlaybookInstance } from "@/lib/playbooks/instances";
import type { AppKey } from "@/lib/apps";

/**
 * Guided quick-launch (issue #1590 §Wave 3). **Never** auto-executes merely
 * because a card was opened. Server re-checks, in order:
 *   1. member permission `launchPermission` (requirePermission; never UI-only)
 *   2. owning app enabled + required modules enabled
 *   3. eligibility (authorization + industry + readiness)
 *   4. typed quick-input validation (closed schema)
 *   5. safety/cost preflight NOT blocked
 *   6. explicit approval flag when `requiresApproval`
 *   7. idempotency key → no duplicate tasks/sends/rewards on retry/replay
 *
 * CRM playbooks create canonical CRM tasks/queues/saved views; Growth reuses
 * canonical #901/Phase-37 services; **nothing posts to accounting here.**
 */
export const POST = withTenantScope(async (request: NextRequest, { params }: { params: Promise<{ key: string }> }) => {
  const { key } = await params;
  const template = playbookByKey(decodeURIComponent(key));
  if (!template || template.publicationState !== "published" || template.availability === "coming_later") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    inputs?: unknown;
    idempotencyKey?: string;
    approval?: boolean;
    branchId?: string | null;
    execute?: boolean;
  };

  // 1. permission — re-checked server-side, NOT inferred from UI.
  const { session, error, membership } = await requirePermission(template.launchPermission);
  if (error) return error;

  const businessId = session.businessId;

  // 2. owning app + modules enabled (never a dead-end launch).
  const appKey: AppKey = template.executionBinding.executor === "crm" ? "crm" : "growth";
  if (!(await isAppAvailable(businessId, appKey))) return NextResponse.json({ error: "app_disabled" }, { status: 403 });
  for (const app of template.requiredCapabilities.apps) {
    if (!(await isAppAvailable(businessId, app))) return NextResponse.json({ error: "app_disabled", app }, { status: 403 });
  }
  for (const moduleKey of template.requiredCapabilities.modules) {
    if (!(await isModuleEnabled(businessId, moduleKey))) return NextResponse.json({ error: "module_disabled", module: moduleKey }, { status: 403 });
  }

  const ctx = await resolveAdaptiveContextForMember({ businessId, userId: session.sub });

  // 3. eligibility.
  const eligibility = evaluateEligibility(template, ctx);
  if (!eligibility.visible) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!eligibility.launchable) return NextResponse.json({ error: "not_launchable", reasons: eligibility.reasons }, { status: 409 });

  // 4. typed inputs (closed schema; reject unknown; integer-Rial money).
  const validated = validateQuickInputs(template, body.inputs ?? {});
  if (!validated.ok) return NextResponse.json({ error: "invalid_inputs", problems: validated.problems }, { status: 422 });

  // 5. safety/cost preflight must not be blocked.
  const preflight = await buildPreflightForTemplate(template, ctx, body.inputs ?? {}, { hasOnline: true, businessId });
  if (preflight.blocked) return NextResponse.json({ error: "preflight_blocked", blockedReasonsFa: preflight.blockedReasonsFa, preflight }, { status: 409 });

  // 6. explicit approval for anything requiring it (incl. outbound/financial).
  const execute = body.execute !== false;
  if (template.executionBinding.requiresApproval && execute) {
    if (body.approval !== true) return NextResponse.json({ error: "approval_required" }, { status: 409 });
  }

  // 7. idempotency — stable key; retry/replay returns existing instance, no double-exec.
  const idempotencyKey = (body.idempotencyKey ?? "").toString().trim();
  if (!idempotencyKey) return NextResponse.json({ error: "idempotency_key_required" }, { status: 422 });
  if (idempotencyKey.length > 200) return NextResponse.json({ error: "idempotency_key_too_long" }, { status: 422 });

  try {
    const result = await launchPlaybookInstance({
      businessId,
      template,
      branchId: body.branchId ?? null,
      config: { inputs: validated.values },
      initiatorUserId: session.sub,
      approverUserId: template.executionBinding.requiresApproval ? session.sub : null,
      idempotencyKey,
      executorInputs: validated.values,
      actorName: membership?.role ?? "",
      execute,
    });
    return NextResponse.json(
      { instance: result.instance, duplicate: result.duplicate, execution: result.execution ?? null },
      { status: result.duplicate ? 200 : 201 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "execution_error";
    // Truthful failure; instance recorded as `failed` where possible. No fake success.
    return NextResponse.json({ error: "execution_failed", detail: msg }, { status: 500 });
  }
});
