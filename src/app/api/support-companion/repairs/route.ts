import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { requireCompanionSession } from "@/lib/support-companion/companion-auth";
import { getRepairRun, transitionRepairRun } from "@/lib/support-companion/repair-catalog";
import { consentAllows } from "@/lib/support-companion/consent";

/** Execution-side repair transitions from the verified companion:
 * `executing`, `verifying`, `succeeded` (postcheck verification required),
 * `failed`, `rolled_back`, `recovery_required`, `blocked`, `cancelled`.
 * Requires the session's `repair.execute` scope plus live customer consent
 * for repairs; the catalog hash is re-verified on the way in. */
export async function POST(request: NextRequest) {
  const auth = await requireCompanionSession(request);
  if ("response" in auth) return auth.response;
  const session = auth.session;
  if (!session.scope.includes("repair.execute")) {
    return NextResponse.json({ error: "scope_insufficient" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const runId = typeof body.runId === "string" ? body.runId : "";
  const to = typeof body.state === "string" ? body.state : "";
  if (!runId || !to) {
    return NextResponse.json({ error: "run_and_state_required" }, { status: 400 });
  }
  const EXECUTION_STATES = new Set([
    "executing",
    "verifying",
    "succeeded",
    "failed",
    "rolled_back",
    "recovery_required",
    "blocked",
    "cancelled",
  ]);
  if (!EXECUTION_STATES.has(to)) {
    return NextResponse.json({ error: "invalid_state" }, { status: 400 });
  }

  const transitioned = await withTenant(session.businessId, async () => {
    const current = await getRepairRun(session.businessId, runId);
    if (
      !current ||
      current.ticketId !== session.ticketId ||
      current.installationId !== session.installationId
    ) {
      return { ok: false as const, error: "not_found" };
    }
    const consented = await consentAllows(session.businessId, session.installationId, "repair");
    if (!consented) return { ok: false as const, error: "consent_missing" };
    const asRecord = (value: unknown): Record<string, unknown> | undefined =>
      value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
    const asArray = (value: unknown): unknown[] | undefined =>
      Array.isArray(value) ? value : undefined;
    return transitionRepairRun(session.businessId, runId, to, {
      consentRef: asRecord(body.consentRef),
      preconditionResults: asArray(body.preconditionResults),
      backupRef: typeof body.backupRef === "string" ? body.backupRef : undefined,
      beforeFindings: asArray(body.beforeFindings),
      afterFindings: asArray(body.afterFindings),
      verification: asRecord(body.verification),
      receipt: asRecord(body.receipt),
    });
  });

  if (!transitioned.ok) {
    const status =
      transitioned.error === "run_not_found" || transitioned.error === "not_found" ? 404 : 409;
    return NextResponse.json({ error: transitioned.error }, { status });
  }
  return NextResponse.json({ run: transitioned.run });
}
