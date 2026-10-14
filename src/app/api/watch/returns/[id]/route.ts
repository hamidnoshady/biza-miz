import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getPool } from "@/lib/db";
import {
  cancelSerialReturn,
  dispositionSerialReturn,
  receiveSerialReturn,
  SERIAL_RETURN_DISPOSITIONS,
  SERIAL_RETURN_REFUND_METHODS,
  SerialReturnError,
  type SerialReturnDisposition,
  type SerialReturnRefundMethod,
} from "@/lib/watch-return-service";

/**
 * Advances one serial return through its lifecycle:
 * - `{action: "receive"}` — the physical unit is in hand (inspection notes).
 * - `{action: "cancel"}` — the claim never completed; sale untouched.
 * - `{action: "disposition", disposition, refundMethod}` — the
 *   manager-approved completion: explicit disposition of the unit plus the
 *   full, atomic financial reversal. Requires BOTH orders.void (the
 *   manager-approval the issue demands — this unwinds a completed sale) and
 *   payments.refund (money actually leaves through it).
 */
export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;

    let body: {
      action?: string;
      inspectionNotes?: string | null;
      disposition?: string;
      refundMethod?: string;
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const action = body.action;
    if (action !== "receive" && action !== "cancel" && action !== "disposition") {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }

    // Receiving/cancelling is shop-floor work; dispositioning is the
    // manager-approved financial act.
    const { session, error } =
      action === "disposition"
        ? await requirePermission(PERMISSIONS.ordersVoid)
        : await requirePermission(PERMISSIONS.inventoryAdjust);
    if (error) return error;
    if (action === "disposition") {
      const { error: refundError } = await requirePermission(PERMISSIONS.paymentsRefund);
      if (refundError) return refundError;
    }
    const industryError = await requireIndustryForApi(session, "watch");
    if (industryError) return industryError;

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

    if (action === "disposition") {
      if (!SERIAL_RETURN_DISPOSITIONS.includes(body.disposition as SerialReturnDisposition)) {
        return NextResponse.json({ error: "invalid_disposition" }, { status: 400 });
      }
      if (!SERIAL_RETURN_REFUND_METHODS.includes(body.refundMethod as SerialReturnRefundMethod)) {
        return NextResponse.json({ error: "invalid_refund_method" }, { status: 400 });
      }
    }

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      let payload: Record<string, unknown> = { ok: true };
      if (action === "receive") {
        await receiveSerialReturn(client, {
          businessId: session.businessId,
          returnId: id,
          inspectionNotes: body.inspectionNotes ?? null,
          actorId: session.sub,
        });
      } else if (action === "cancel") {
        await cancelSerialReturn(client, {
          businessId: session.businessId,
          returnId: id,
          actorId: session.sub,
        });
      } else {
        const result = await dispositionSerialReturn(client, {
          businessId: session.businessId,
          locationId: location.id,
          returnId: id,
          disposition: body.disposition as SerialReturnDisposition,
          refundMethod: body.refundMethod as SerialReturnRefundMethod,
          inspectionNotes: body.inspectionNotes ?? null,
          approvedBy: session.sub,
        });
        payload = { ok: true, ...result };
      }
      await client.query("COMMIT");
      return NextResponse.json(payload);
    } catch (err) {
      await client.query("ROLLBACK");
      if (err instanceof SerialReturnError) {
        return NextResponse.json({ error: "return_failed", message: err.message }, { status: err.status });
      }
      throw err;
    } finally {
      client.release();
    }
  },
);
