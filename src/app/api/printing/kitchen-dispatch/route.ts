import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { deploymentRole } from "@/lib/deployment-role";
import { kitchenDispatchOwner } from "@/lib/kitchen-dispatch";
import { classifyDeliveryOutcome, PRINTER_ERROR_MESSAGES, type PrinterErrorCode } from "@/lib/printing/errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BATCH = 10;

/**
 * A single runtime owns physical kitchen printing: local runtime for local
 * deployments, the desktop/site for hybrid, and the browser station for cloud.
 * The database claim is exclusive across tabs/devices; this endpoint never
 * sends bytes itself, it leases durable intents to the owner runtime, which
 * delivers them through the existing #815 print document/client pipeline.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.printingExecute);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ jobs: [] });
  const profile = await readDeploymentProfile(session.businessId);
  const ownerMode = kitchenDispatchOwner(profile.profile, deploymentRole());
  if (!ownerMode) return NextResponse.json({ jobs: [] });

  try {
    // A lost browser/desktop after a claim cannot safely be retried: bytes may
    // already have reached a spooler. Quarantine it as ambiguous for operator
    // review rather than risk an automatic duplicate print.
    await query(
      `UPDATE kitchen_dispatch_jobs
          SET status='ambiguous',claim_token=NULL,claim_until=NULL,
              last_error='claim_lease_expired',updated_at=now()
        WHERE location_id=$1 AND owner_mode=$2 AND status='claimed' AND claim_until<now()`,
      [location.id, ownerMode],
    );
    const { rows } = await query<{
      id: string;
      order_id: string;
      item_ids: string[];
      idempotency_key: string;
      claim_token: string;
    }>(
      `WITH due AS (
         SELECT id FROM kitchen_dispatch_jobs
          WHERE location_id=$1 AND owner_mode=$2 AND status='pending' AND available_at<=now()
          ORDER BY created_at,id
          FOR UPDATE SKIP LOCKED LIMIT $3
       )
       UPDATE kitchen_dispatch_jobs j
          SET status='claimed',claim_token=gen_random_uuid(),claimed_by=$4,
              claim_until=now()+interval '2 minutes',attempt_count=attempt_count+1,updated_at=now()
         FROM due WHERE j.id=due.id
       RETURNING j.id,j.order_id,j.item_ids,j.idempotency_key,j.claim_token`,
      [location.id, ownerMode, MAX_BATCH, session.sub],
    );
    return NextResponse.json({
      jobs: rows.map((row) => ({
        dispatchId: row.id,
        claimToken: row.claim_token,
        orderId: row.order_id,
        itemIds: row.item_ids,
        requestId: `kitchen-dispatch:${row.id}`,
      })),
    });
  } catch (cause) {
    console.error("claiming kitchen dispatch jobs failed", cause);
    return NextResponse.json({ error: "kitchen_dispatch_failed" }, { status: 500 });
  }
});

/** Record a real client delivery outcome and safely retry only confirmed non-delivery. */
export const PATCH = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.printingExecute);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: { dispatchId?: unknown; claimToken?: unknown; handedOff?: unknown; errorCode?: unknown; ambiguous?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (
    typeof body.dispatchId !== "string" || !UUID.test(body.dispatchId) ||
    typeof body.claimToken !== "string" || !UUID.test(body.claimToken) ||
    typeof body.handedOff !== "boolean" ||
    body.errorCode != null && (typeof body.errorCode !== "string" || !(body.errorCode in PRINTER_ERROR_MESSAGES)) ||
    body.ambiguous != null && typeof body.ambiguous !== "boolean"
  ) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const errorCode = body.errorCode as PrinterErrorCode | undefined;
  const delivery = classifyDeliveryOutcome({
    ok: body.handedOff,
    ...(errorCode ? { error: errorCode } : {}),
    ambiguous: body.ambiguous === true,
  });
  const retryable = delivery === "not_delivered" || delivery === "connector_unavailable";
  try {
    const { rows } = await query<{ id: string }>(
      `UPDATE kitchen_dispatch_jobs
          SET status=$5,
              available_at=CASE WHEN $5='pending' THEN now()+make_interval(secs => LEAST(900,15*power(2,LEAST(attempt_count-1,6))::int)) ELSE available_at END,
              claim_token=NULL,claim_until=NULL,claimed_by=NULL,
              last_error=$6,
              handed_off_at=CASE WHEN $5='handed_off' THEN now() ELSE handed_off_at END,
              updated_at=now()
        WHERE id=$1 AND location_id=$2 AND claim_token=$3 AND status='claimed'
          AND claim_until>now() AND claimed_by=$4
        RETURNING id`,
      [
        body.dispatchId,
        location.id,
        body.claimToken,
        session.sub,
        body.handedOff ? "handed_off" : retryable ? "pending" : "ambiguous",
        body.handedOff ? null : errorCode ?? "print_failed",
      ],
    );
    if (!rows[0]) return NextResponse.json({ error: "claim_expired" }, { status: 409 });
    return NextResponse.json({ ok: true, outcome: delivery, retryable });
  } catch (cause) {
    console.error("acknowledging kitchen dispatch failed", cause);
    return NextResponse.json({ error: "kitchen_dispatch_failed" }, { status: 500 });
  }
});
