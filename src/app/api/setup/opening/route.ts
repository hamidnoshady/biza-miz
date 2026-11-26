import { NextRequest, NextResponse } from "next/server";
import type { SessionPayload } from "@/lib/auth";
import { withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { memberAccessFor } from "@/lib/member-access";
import { getSetting, markStepDone, SETTING_KEYS } from "@/lib/settings";
import {
  resolveActiveLocation,
  requireManager,
  type CostingSetting,
} from "@/lib/setup-state";
import type { OpeningLine } from "@/lib/opening";
import { WELL_KNOWN_CODES } from "@/lib/coa-template";
import { loadSetupOpeningData } from "@/lib/setup-opening-service";
import { SETUP_OPENING_STATE_MESSAGES } from "@/lib/setup-opening";
import { postWizardOpeningBalances, WizardOpeningError } from "@/lib/setup-opening-posting";

/**
 * The wizard's final data step — opening balances: an opening inventory count
 * (F&B's perpetual stock) and a balanced opening journal entry. Numbered steps
 * are deliberately not used in this file any more: the sequence is
 * industry-shaped (see wizard-steps.ts), so "step 8" was only ever true for one
 * of the three shapes.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireManager();
  if (error) return error;

  /*
   * Issue #1583 — the old GET answered `{ accounts: [] }` when its read failed,
   * so the screen's empty picker could not tell "no chart" from "permission
   * denied" from "database unreachable". The payload now carries a structured
   * `state` and the screen renders that instead of an empty select. A thrown
   * read is still an error status (never a misleading 200), but it also carries
   * the same vocabulary so a retry has something to say.
   */
  try {
    const access = await memberAccessFor(session);
    const data = await loadSetupOpeningData({ session, access });
    return NextResponse.json(data);
  } catch (err) {
    console.error("[setup/opening] read failed", err);
    return NextResponse.json(
      {
        state: "unavailable",
        message: SETUP_OPENING_STATE_MESSAGES.unavailable,
      },
      { status: 503 },
    );
  }
});

interface OpeningInventoryRow {
  name?: string;
  unit?: string;
  quantity?: number;
  /** Rial per unit */
  unitCost?: number;
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireManager();
  if (error) return error;

  let body: {
    inventory?: { items?: OpeningInventoryRow[] };
    balances?: { lines?: OpeningLine[]; autoOffset?: boolean };
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.inventory) return openingInventory(session, body.inventory);
  if (body.balances) return openingBalances(session, body.balances);
  return NextResponse.json({ error: "bad_request" }, { status: 400 });
});

/** The wizard's opening journal goes through the canonical posting service. */
async function openingBalances(
  session: SessionPayload,
  payload: { lines?: OpeningLine[]; autoOffset?: boolean },
) {
  try {
    const result = await postWizardOpeningBalances({
      session,
      lines: payload.lines,
      autoOffset: payload.autoOffset,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof WizardOpeningError) {
      return NextResponse.json(
        { error: err.message, ...(err.details ?? {}) },
        { status: err.status },
      );
    }
    throw err;
  }
}

/**
 * Opening physical count: creates inventory items and one 'adjustment' stock
 * movement each. This is the business's first inventory transaction, so it
 * also locks the costing method.
 */
async function openingInventory(
  session: SessionPayload,
  payload: { items?: OpeningInventoryRow[] },
) {
  const businessId = session.businessId;
  const userId = session.sub;
  const items = payload.items ?? [];
  if (items.length === 0) {
    return NextResponse.json({ error: "no_items" }, { status: 400 });
  }
  for (const it of items) {
    const qty = Number(it.quantity);
    const cost = Number(it.unitCost ?? 0);
    if (
      !it.name?.trim() ||
      !Number.isFinite(qty) ||
      qty <= 0 ||
      !Number.isSafeInteger(cost) ||
      cost < 0
    ) {
      return NextResponse.json({ error: "invalid_item" }, { status: 400 });
    }
  }

  const costing = await getSetting<CostingSetting>(businessId, SETTING_KEYS.costing);
  if (!costing) {
    return NextResponse.json({ error: "costing_not_set" }, { status: 409 });
  }
  // سیستم ادواری: opening stock is not a priced stock movement — it is the
  // business's first period-end count (see periodic-closing-service.ts), so
  // this perpetual instrument is closed off rather than half-supported.
  if (costing.system === "periodic") {
    return NextResponse.json({ error: "periodic_system_unsupported" }, { status: 409 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let totalValue = 0n;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: prior } = await client.query<{id:string}>(
      "SELECT id FROM inventory_events WHERE business_id=$1 AND event_type='opening' FOR UPDATE",[businessId]);
    if (prior.length) {
      // Issue #808 §9: this branch used to roll back and return success without
      // touching the progress marker — so a retry after a failed progress write
      // reported "done, idempotent" forever while `setup.progress` stayed
      // behind. The domain state is the truth here, so the marker is repaired
      // from it, in the same transaction.
      const progress = await markStepDone(businessId, "opening", client);
      await client.query("COMMIT");
      return NextResponse.json({ ok: true, eventId: prior[0].id, idempotent: true, progress });
    }
    const { rows: eventRows } = await client.query<{id:string}>(
      `INSERT INTO inventory_events(business_id,location_id,event_type,source_type,created_by)
       VALUES($1,$2,'opening','setup_opening',$3) RETURNING id`,[businessId,location.id,userId]);
    const eventId=eventRows[0].id;
    for (const it of items) {
      const name = it.name!.trim();
      const unit = it.unit?.trim() || "unit";
      const qty = Number(it.quantity);
      const cost = Number(it.unitCost ?? 0);

      const { rows: existing } = await client.query(
        "SELECT id FROM inventory_items WHERE location_id = $1 AND name = $2",
        [location.id, name],
      );
      const itemId: string = existing.length
        ? existing[0].id
        : (
            await client.query(
              "INSERT INTO inventory_items (location_id, name, unit) VALUES ($1, $2, $3) RETURNING id",
              [location.id, name, unit],
            )
          ).rows[0].id;

      const { rows: movement } = await client.query<{value:string}>(
        `INSERT INTO stock_movements
           (location_id, inventory_item_id, type, quantity, unit_cost, source_type, source_id, note, created_by, inventory_event_id)
         VALUES ($1, $2, 'adjustment', $3, $4, 'opening', $5, 'شمارش افتتاحیه', $6, $5)
         RETURNING round(quantity*unit_cost)::bigint::text value`,
        [location.id, itemId, String(qty), String(cost), eventId, userId],
      );
      totalValue += BigInt(movement[0].value);
      if (costing.method !== "weighted_average") await client.query(
        `INSERT INTO inventory_lots(location_id,inventory_item_id,remaining_qty,unit_cost,source_type,source_id,inventory_event_id)
         VALUES($1,$2,$3,$4,'opening',$5,$5)`,[location.id,itemId,String(qty),String(cost),eventId]);
      else await client.query("UPDATE inventory_items SET avg_cost=$2 WHERE id=$1",[itemId,String(cost)]);
    }
    const {rows: accounts}=await client.query<{id:string;code:string}>(
      "SELECT id,code FROM accounts WHERE business_id=$1 AND code=ANY($2::text[]) AND is_active",[businessId,[WELL_KNOWN_CODES.inventory,WELL_KNOWN_CODES.openingEquity]]);
    const byCode=new Map(accounts.map(a=>[a.code,a.id]));
    if (!byCode.has(WELL_KNOWN_CODES.inventory)||!byCode.has(WELL_KNOWN_CODES.openingEquity)) throw new Error("opening_accounts_missing");
    const {rows: entries}=await client.query<{id:string}>(
      `INSERT INTO journal_entries(business_id,location_id,entry_date,memo,source_type,source_id,created_by,posting_kind,inventory_event_id)
       VALUES($1,$2,CURRENT_DATE,'موجودی افتتاحیه','opening_inventory',$3,$4,'inventory',$3) RETURNING id`,[businessId,location.id,eventId,userId]);
    await client.query(`INSERT INTO journal_lines(entry_id,account_id,debit,credit) VALUES($1,$2,$3,0),($1,$4,0,$3)`,
      [entries[0].id,byCode.get(WELL_KNOWN_CODES.inventory),totalValue.toString(),byCode.get(WELL_KNOWN_CODES.openingEquity)]);
    await client.query("SELECT set_config('app.fiscal_constructing_entry_id', '', true)");
    await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1",[eventId]);
    if (!costing.lockedAt) await client.query(
      `UPDATE settings SET value=jsonb_set(value,'{lockedAt}',to_jsonb(now()::text)),updated_at=now()
       WHERE business_id=$1 AND location_id IS NULL AND key=$2`,[businessId,SETTING_KEYS.costing]);
    // The marker commits with the rows it describes (issue #808 §6): a failure
    // to write it rolls the whole opening event back, so the two can never
    // disagree in the direction that silently skips the step.
    const progress = await markStepDone(businessId, "opening", client);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, totalValue: totalValue.toString(), progress });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
