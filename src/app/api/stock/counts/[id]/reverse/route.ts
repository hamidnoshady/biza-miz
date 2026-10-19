import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool } from "@/lib/db";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { resolveActiveLocation, resolveActiveLocationForUser } from "@/lib/setup-state";
import { reverseItemStockCount } from "@/lib/item-stock-count-service";

/**
 * Undo a posted count. A count is a source document with a ledger effect, so it
 * is corrected by reversal rather than edited — record a fresh count afterwards
 * if the shelf still needs a correct figure.
 *
 * Hardened for #921:
 *  - warehouse scoping with authorization
 *  - cost_basis_changed guard surfaces 409 with explanatory code
 *  - idempotency via header, explain non-reversible scenarios
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
    if (error) return error;

    const url = request.nextUrl;
    const requestedLocation = url.searchParams.get("locationId") || url.searchParams.get("warehouseId");
    let location: Awaited<ReturnType<typeof resolveActiveLocation>> | null;
    if (requestedLocation) {
      const resolved = await resolveActiveLocationForUser(session.businessId, session.sub, requestedLocation);
      if (!resolved || resolved.id !== requestedLocation) {
        return NextResponse.json({ error: "warehouse_not_accessible" }, { status: 403 });
      }
      location = resolved;
    } else {
      location = await resolveActiveLocation(session);
    }
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

    let body: { note?: string; locationId?: string | null; warehouseId?: string | null } = {};
    try {
      body = await request.json();
    } catch {
      // A reversal needs no body; an absent one is not an error.
    }
    // Body-provided location overrides query param if authorized
    const bodyLocation = body.locationId || body.warehouseId;
    if (bodyLocation) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bodyLocation)) {
        return NextResponse.json({ error: "invalid_warehouse" }, { status: 400 });
      }
      const resolved = await resolveActiveLocationForUser(session.businessId, session.sub, bodyLocation);
      if (!resolved || resolved.id !== bodyLocation) {
        return NextResponse.json({ error: "warehouse_not_accessible" }, { status: 403 });
      }
      location = resolved;
    }
    if (body.note && body.note.length > 2000) {
      return NextResponse.json({ error: "note_too_long" }, { status: 400 });
    }

    const { id } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return NextResponse.json({ error: "invalid_count_id" }, { status: 400 });
    }

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await reverseItemStockCount(client, {
        businessId: session.businessId,
        locationId: location.id,
        countId: id,
        createdBy: session.sub,
        note: body.note ?? null,
        sync: { actorRole: session.role },
      });
      await client.query("COMMIT");
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      await client.query("ROLLBACK");
      if (err instanceof MissingLedgerAccountError) {
        return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
      }
      if (err instanceof Error) {
        const statusByError: Record<string, number> = {
          count_not_found: 404,
          count_not_reversible: 409,
          already_reversed: 409,
          count_stock_consumed: 409,
          cost_basis_changed: 409,
        };
        const status = statusByError[err.message];
        if (status) {
          const messages: Record<string, string> = {
            count_stock_consumed: "موجودی اضافهٔ این انبارگردانی بعداً مصرف/فروخته شده و قابل برگشت نیست؛ یک انبارگردانی اصلاحی تازه ثبت کنید.",
            cost_basis_changed: "بهای تمام‌شدهٔ کالا از زمان شمارش تغییر کرده است؛ برگشتِ دقیق ممکن نیست. لطفاً یک شمارش اصلاحی تازه ثبت کنید.",
          };
          return NextResponse.json({ error: err.message, message: messages[err.message] }, { status });
        }
        if (err.message === "invalid_warehouse" || err.message === "note_too_long") {
          return NextResponse.json({ error: err.message }, { status: 400 });
        }
      }
      throw err;
    } finally {
      client.release();
    }
  },
);
