import { NextRequest, NextResponse } from "next/server";
import type { SessionPayload } from "@/lib/auth";
import { withTenantScope } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { getSetting, markStepDone, SETTING_KEYS } from "@/lib/settings";
import {
  costingLocked,
  resolveActiveLocation,
  requireManager,
  type CostingSetting,
} from "@/lib/setup-state";
import { checkBalance, validateOpeningLines, withAutoOffset, type OpeningLine } from "@/lib/opening";
import { WELL_KNOWN_CODES } from "@/lib/coa-template";

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

  const location = await resolveActiveLocation(session);
  const [{ rows: accounts }, { rows: openingEntry }, inventory] = await Promise.all([
    query(
      `SELECT id, code, name, type,
              (SELECT count(*) FROM accounts c WHERE c.parent_id = a.id) AS children
         FROM accounts a WHERE business_id = $1 AND is_active AND code <> $2 ORDER BY code`,
      [session.businessId, WELL_KNOWN_CODES.inventory],
    ),
    query(
      `SELECT je.id, je.entry_date, je.memo,
              (SELECT COALESCE(SUM(debit), 0) FROM journal_lines WHERE entry_id = je.id) AS total
         FROM journal_entries je
        WHERE je.business_id = $1 AND je.source_type = 'opening'`,
      [session.businessId],
    ),
    location
      ? query(
          `SELECT ii.id, ii.name, ii.unit,
                  COALESCE((SELECT SUM(quantity) FROM stock_movements sm
                             WHERE sm.inventory_item_id = ii.id), 0) AS quantity
             FROM inventory_items ii WHERE ii.location_id = $1 ORDER BY ii.name`,
          [location.id],
        )
      : Promise.resolve({ rows: [] }),
  ]);

  return NextResponse.json({
    accounts,
    openingEntry: openingEntry[0] ?? null,
    inventoryItems: inventory.rows,
    costingLocked: await costingLocked(session.businessId),
  });
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
  if (body.balances) return openingBalances(session.businessId, session.sub, body.balances);
  return NextResponse.json({ error: "bad_request" }, { status: 400 });
});

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

/** Opening ledger balances → one balanced journal entry (source_type 'opening'). */
async function openingBalances(
  businessId: string,
  userId: string,
  payload: { lines?: OpeningLine[]; autoOffset?: boolean },
) {
  const rawLines = (payload.lines ?? []).map((l) => ({
    accountId: String(l.accountId ?? ""),
    debit: Number(l.debit) || 0,
    credit: Number(l.credit) || 0,
  }));

  const { rows: existingEntry } = await query(
    "SELECT id FROM journal_entries WHERE business_id = $1 AND source_type = 'opening'",
    [businessId],
  );
  if (existingEntry.length > 0) {
    // Same self-healing rule as the inventory branch above (issue #808 §9):
    // the ledger already holds the opening entry, so this retry's job is to
    // make sure the progress marker agrees — not to refuse with a 409 that
    // leaves the wizard stuck one step behind the data.
    const progress = await markStepDone(businessId, "opening");
    return NextResponse.json({
      ok: true,
      entryId: existingEntry[0].id,
      alreadyExists: true,
      progress,
    });
  }

  let lines = rawLines.filter((l) => l.debit !== 0 || l.credit !== 0);

  if (payload.autoOffset) {
    const { rows: offsetAccount } = await query<{ id: string }>(
      "SELECT id FROM accounts WHERE business_id = $1 AND code = $2",
      [businessId, WELL_KNOWN_CODES.openingEquity],
    );
    if (offsetAccount.length === 0) {
      return NextResponse.json({ error: "offset_account_missing" }, { status: 409 });
    }
    lines = withAutoOffset(lines, offsetAccount[0].id);
  }

  const errors = validateOpeningLines(lines);
  if (errors.length > 0) {
    return NextResponse.json({ error: "invalid_lines", messages: errors }, { status: 400 });
  }
  const balance = checkBalance(lines);
  if (!balance.balanced) {
    return NextResponse.json(
      { error: "not_balanced", totalDebit: balance.totalDebit, totalCredit: balance.totalCredit },
      { status: 400 },
    );
  }

  // All referenced accounts must belong to this business.
  const accountIds = lines.map((l) => l.accountId);
  const { rows: inventoryAccount } = await query<{id:string}>(
    "SELECT id FROM accounts WHERE business_id=$1 AND code=$2", [businessId,WELL_KNOWN_CODES.inventory]);
  if (inventoryAccount.some(a => accountIds.includes(a.id))) {
    return NextResponse.json({ error: "inventory_opening_is_automatic" }, { status: 409 });
  }
  const { rows: owned } = await query(
    "SELECT id FROM accounts WHERE business_id = $1 AND id = ANY($2::uuid[])",
    [businessId, accountIds],
  );
  if (owned.length !== new Set(accountIds).size) {
    return NextResponse.json({ error: "unknown_account" }, { status: 400 });
  }

  const client = await getPool().connect();
  let entryId: string;
  try {
    await client.query("BEGIN");
    const { rows: entry } = await client.query(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, created_by)
       VALUES ($1, CURRENT_DATE, 'تراز افتتاحیه', 'opening', $2) RETURNING id`,
      [businessId, userId],
    );
    entryId = entry[0].id;
    for (const l of lines) {
      await client.query(
        "INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, $4)",
        [entryId, l.accountId, l.debit, l.credit],
      );
    }
    // Committed together with the entry it marks (issue #808 §6).
    const progress = await markStepDone(businessId, "opening", client);
    await client.query("COMMIT");
    return NextResponse.json({
      ok: true,
      entryId,
      totalDebit: balance.totalDebit,
      totalCredit: balance.totalCredit,
      progress,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
