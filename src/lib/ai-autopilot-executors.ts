/**
 * Phase 31 — the server-side half of autopilot.
 *
 * Every ACTION_CATALOG entry carries an HTTP endpoint meant for the *browser*
 * to fetch with the signed-in user's own session cookie. A background tick has
 * no request, no session and no cookie, so it cannot use that path at all.
 * Each executor below therefore calls the SAME service function the route
 * handler calls — never an internal HTTP loopback, never a second mutation
 * path. The caller runs them inside withTenant(businessId, …), so RLS is
 * already the tenant boundary here exactly as it is in a request.
 *
 * Two rules this file enforces by what it does NOT import:
 *   - `approveDraft` is never imported. A journal entry is only ever DRAFTED
 *     here, into Phase 16's existing human approval queue (Decision 1).
 *   - No message gateway, phone number or send path is imported. Autopilot
 *     writes internal records only; nothing reaches a customer (Decision 2).
 */
import { getPool, query } from "./db";
import type { AutopilotExecutorKey } from "./ai";
import { updateMenuItem } from "./menu-service";
import { createStockCount, reverseStockCount } from "./stock-count-service";
import { createDraftPurchase, cancelDraftPurchase, PurchaseServiceError } from "./purchase-service";
import { applyOrderDiscount, normalizeDiscountInput } from "./order-discount-service";
import { recordExpense, ExpenseError } from "./expense-service";
import { createDraft, deleteDraft, ManualJournalError } from "./manual-journal-service";
import { updateCustomer } from "./parties-service";
import { addCustomerNote, deleteCustomerNote, setCustomerTag } from "./crm-service";
import { isWasteReason, recordWaste } from "./waste-service";
import { recordProductionRun, reverseProductionRun, ProductionError } from "./production-service";
import { positiveQuantityText, type QuantityText, type RialText } from "./inventory-exact";
import { draftWebsitePost, updateWebsitePost, upsertWebsiteProduct } from "./website/content-service";
import { queueTriggeredMessageCampaign } from "./message-campaigns-service";
import type { PurchaseItemInput } from "./purchase-lines";

export interface AutopilotExecutionResult {
  ok: boolean;
  /** Persisted to ai_action_audit.prior_state — read inside the write's own transaction. */
  priorState?: Record<string, unknown>;
  result: Record<string, unknown>;
  errorCode?: string;
}

export interface AutopilotExecutorContext {
  businessId: string;
  /** The owner/manager who switched this category on; every write is theirs. */
  authorizedByUserId: string | null;
  payload: Record<string, unknown>;
}

export type AutopilotExecutor = (ctx: AutopilotExecutorContext) => Promise<AutopilotExecutionResult>;

export interface AutopilotReverterContext {
  businessId: string;
  authorizedByUserId: string | null;
  payload: Record<string, unknown>;
  priorState: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
}

export type AutopilotReverter = (ctx: AutopilotReverterContext) => Promise<AutopilotExecutionResult>;

/** Every row an executor creates says so, so an automated write never reads as typed by hand. */
export const AUTOPILOT_NOTE_PREFIX = "ثبت خودکار دستیار — ";

function fail(errorCode: string): AutopilotExecutionResult {
  return { ok: false, result: { error: errorCode }, errorCode };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function int(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) ? parsed : null;
}

function noteWith(value: unknown): string {
  const base = str(value);
  return base ? `${AUTOPILOT_NOTE_PREFIX}${base}` : AUTOPILOT_NOTE_PREFIX.trim();
}

// ---------------------------------------------------------------------------
// Branch resolution
//
// resolveActiveLocation(session) is unusable without a request, and guessing a
// "primary branch" would let a write land in the wrong shop. Each executor
// resolves the branch from the target row instead, which RLS has already
// bounded to this tenant.
// ---------------------------------------------------------------------------

async function locationOfMenuItem(menuItemId: string): Promise<string | null> {
  const { rows } = await query<{ location_id: string }>(
    `SELECT l.id AS location_id
       FROM menu_items m JOIN locations l ON l.id = m.location_id
      WHERE m.id = $1`,
    [menuItemId],
  );
  return rows[0]?.location_id ?? null;
}

async function locationOfOrder(orderId: string): Promise<string | null> {
  const { rows } = await query<{ location_id: string }>(`SELECT location_id FROM orders WHERE id = $1`, [orderId]);
  return rows[0]?.location_id ?? null;
}

/**
 * A stock count and a purchase order are each a single-branch document, so a
 * payload whose items span branches is refused rather than silently split or
 * assigned to whichever branch happened to come first.
 */
async function locationOfInventoryItems(itemIds: string[]): Promise<string | null | "mixed"> {
  if (itemIds.length === 0) return null;
  const { rows } = await query<{ location_id: string }>(
    `SELECT DISTINCT location_id FROM inventory_items WHERE id = ANY($1::uuid[])`,
    [itemIds],
  );
  if (rows.length === 0) return null;
  if (rows.length > 1) return "mixed";
  return rows[0].location_id;
}

/** For rows whose location_id is nullable (expenses, journal drafts). */
async function defaultLocation(businessId: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM locations WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1`,
    [businessId],
  );
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

const menuItemPatch: AutopilotExecutor = async (ctx) => {
  const menuItemId = str(ctx.payload.menuItemId);
  if (!menuItemId) return fail("invalid_payload");
  const locationId = await locationOfMenuItem(menuItemId);
  if (!locationId) return fail("not_found");

  const { rows: before } = await query<{ price: string; is_active: boolean; name: string }>(
    `SELECT price::text AS price, is_active, name FROM menu_items WHERE id = $1 AND location_id = $2`,
    [menuItemId, locationId],
  );
  if (!before[0]) return fail("not_found");

  const patch: { price?: number; isActive?: boolean } = {};
  if (ctx.payload.price !== undefined) {
    const price = int(ctx.payload.price);
    if (price === null || price <= 0) return fail("invalid_payload");
    patch.price = price;
  }
  if (ctx.payload.isActive !== undefined) {
    if (typeof ctx.payload.isActive !== "boolean") return fail("invalid_payload");
    patch.isActive = ctx.payload.isActive;
  }
  if (patch.price === undefined && patch.isActive === undefined) return fail("invalid_payload");

  const updated = await updateMenuItem(locationId, menuItemId, patch);
  if (!updated.ok) return fail(updated.error);
  return {
    ok: true,
    priorState: { menuItemId, name: before[0].name, price: Number(before[0].price), isActive: before[0].is_active },
    result: { menuItemId, locationId, applied: patch },
  };
};

const stockCount: AutopilotExecutor = async (ctx) => {
  const rawLines = Array.isArray(ctx.payload.lines) ? (ctx.payload.lines as Record<string, unknown>[]) : null;
  if (!rawLines || rawLines.length === 0) return fail("invalid_payload");
  const itemIds = rawLines.map((line) => str(line.inventoryItemId)).filter((id): id is string => Boolean(id));
  if (itemIds.length !== rawLines.length) return fail("invalid_payload");

  const locationId = await locationOfInventoryItems(itemIds);
  if (locationId === "mixed") return fail("autopilot_mixed_location");
  if (!locationId) return fail("not_found");

  // On hand is derived from the append-only stock ledger, which is the only
  // place a quantity lives: `inventory_items` carries cost and settings, never
  // a quantity column. Reading a stale/nonexistent `inventory_items.quantity`
  // here would snapshot the wrong "before" figure for the count.
  const { rows: before } = await query<{ id: string; name: string; quantity: string }>(
    `SELECT i.id, i.name,
            trim_scale(COALESCE(sm.total, 0))::text AS quantity
       FROM inventory_items i
       LEFT JOIN LATERAL (
         SELECT sum(quantity) AS total FROM stock_movements WHERE inventory_item_id = i.id
       ) sm ON true
      WHERE i.id = ANY($1::uuid[])`,
    [itemIds],
  );

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const created = await createStockCount(client, {
      businessId: ctx.businessId,
      locationId,
      note: noteWith(ctx.payload.note),
      lines: rawLines.map((line) => ({
        inventoryItemId: String(line.inventoryItemId),
        countedQty: line.countedQty as string | number,
      })),
      createdBy: ctx.authorizedByUserId,
    });
    await client.query("COMMIT");
    return {
      ok: true,
      priorState: { locationId, items: before.map((r) => ({ id: r.id, name: r.name, quantity: r.quantity })) },
      result: { stockCountId: created.id, locationId },
    };
  } catch (err) {
    await client.query("ROLLBACK");
    return fail(err instanceof Error ? err.message : "stock_count_failed");
  } finally {
    client.release();
  }
};

const draftPurchase: AutopilotExecutor = async (ctx) => {
  const rawItems = Array.isArray(ctx.payload.items) ? (ctx.payload.items as Record<string, unknown>[]) : null;
  if (!rawItems || rawItems.length === 0) return fail("invalid_payload");
  const itemIds = rawItems.map((item) => str(item.inventoryItemId)).filter((id): id is string => Boolean(id));
  if (itemIds.length !== rawItems.length) return fail("invalid_payload");

  const locationId = await locationOfInventoryItems(itemIds);
  if (locationId === "mixed") return fail("autopilot_mixed_location");
  if (!locationId) return fail("not_found");

  try {
    const created = await createDraftPurchase({
      locationId,
      supplierId: str(ctx.payload.supplierId),
      note: noteWith(ctx.payload.note),
      purchaseDate: null,
      items: rawItems as unknown as PurchaseItemInput[],
      createdBy: ctx.authorizedByUserId,
    });
    return {
      ok: true,
      priorState: { locationId },
      result: { purchaseId: created.id, total: created.total, locationId, status: "draft" },
    };
  } catch (err) {
    if (err instanceof PurchaseServiceError) return fail(err.code);
    return fail(err instanceof Error ? err.message : "draft_purchase_failed");
  }
};

const orderDiscount: AutopilotExecutor = async (ctx) => {
  const orderId = str(ctx.payload.orderId);
  if (!orderId) return fail("invalid_payload");
  const raw = ctx.payload.discount;
  if (!raw || typeof raw !== "object") return fail("invalid_payload");
  // Re-validated with the route's own validator: a model-authored payload is
  // never trusted more than a browser-authored one.
  const discount = normalizeDiscountInput(raw as { type?: "percent" | "amount" | null; value?: number });
  if (!discount) return fail("invalid_discount");

  const locationId = await locationOfOrder(orderId);
  if (!locationId) return fail("not_found");

  const applied = await applyOrderDiscount({ locationId, orderId, discount });
  if (!applied.ok) return fail(applied.error);
  return {
    ok: true,
    priorState: { orderId, locationId, ...applied.prior },
    result: { orderId, locationId, totals: applied.totals as unknown as Record<string, unknown> },
  };
};

const expense: AutopilotExecutor = async (ctx) => {
  const accountId = str(ctx.payload.accountId);
  const paymentAccountId = str(ctx.payload.paymentAccountId);
  const amount = int(ctx.payload.amount);
  const memo = str(ctx.payload.memo);
  if (!accountId || !paymentAccountId || amount === null || !memo) return fail("invalid_payload");

  try {
    const created = await recordExpense({
      businessId: ctx.businessId,
      locationId: await defaultLocation(ctx.businessId),
      accountId,
      paymentAccountId,
      amount,
      expenseDate: str(ctx.payload.expenseDate),
      vendor: str(ctx.payload.vendor),
      memo: `${AUTOPILOT_NOTE_PREFIX}${memo}`,
      createdBy: ctx.authorizedByUserId,
    });
    return { ok: true, result: { expenseId: created.id, amount } };
  } catch (err) {
    if (err instanceof ExpenseError) return fail(err.message);
    return fail(err instanceof Error ? err.message : "expense_failed");
  }
};

const journalDraft: AutopilotExecutor = async (ctx) => {
  const memo = str(ctx.payload.memo);
  const lines = Array.isArray(ctx.payload.lines) ? (ctx.payload.lines as Record<string, unknown>[]) : null;
  if (!memo || !lines || lines.length === 0) return fail("invalid_payload");
  if (!ctx.authorizedByUserId) return fail("no_authorizing_user");

  try {
    // createDraft only — the entry lands in Phase 16's approval queue and a
    // human still approves it. Never approveDraft (Decision 1).
    const created = await createDraft({
      businessId: ctx.businessId,
      locationId: await defaultLocation(ctx.businessId),
      entryDate: str(ctx.payload.entryDate),
      memo: `${AUTOPILOT_NOTE_PREFIX}${memo}`,
      lines: lines.map((line) => ({
        accountId: String(line.accountId ?? ""),
        debit: Number(line.debit ?? 0),
        credit: Number(line.credit ?? 0),
      })),
      createdBy: ctx.authorizedByUserId,
    });
    return { ok: true, result: { draftId: created.id, posted: false } };
  } catch (err) {
    if (err instanceof ManualJournalError) return fail(err.message);
    return fail(err instanceof Error ? err.message : "journal_draft_failed");
  }
};

const customerNote: AutopilotExecutor = async (ctx) => {
  const customerId = str(ctx.payload.customerId);
  const notes = str(ctx.payload.notes);
  if (!customerId || !notes) return fail("invalid_payload");

  const { rows: before } = await query<{ notes: string | null; name: string }>(
    `SELECT notes, name FROM parties WHERE id = $1 AND business_id = $2`,
    [customerId, ctx.businessId],
  );
  if (!before[0]) return fail("not_found");

  const updated = await updateCustomer(ctx.businessId, customerId, { notes });
  if (!updated) return fail("not_found");
  return {
    ok: true,
    priorState: { customerId, notes: before[0].notes, name: before[0].name },
    result: { customerId },
  };
};

/**
 * Phase 36 — put one tag on a customer, or take one off.
 *
 * The narrowness is deliberate. `customerNote` above has to read the whole
 * `notes` field, concatenate, and write it back, which is why its undo has to
 * stash the previous text; this one names a single tag and the database does
 * the rest, so a concurrent tag by a person at the counter survives. Undo is
 * exactly the inverse call.
 */
const customerTag: AutopilotExecutor = async (ctx) => {
  const customerId = str(ctx.payload.customerId);
  const tag = str(ctx.payload.tag);
  const action = str(ctx.payload.action);
  if (!customerId || !tag || (action !== "add" && action !== "remove")) return fail("invalid_payload");

  const tags = await setCustomerTag(ctx.businessId, customerId, tag, action);
  if (tags === null) return fail("not_found");
  return { ok: true, priorState: { customerId, tag, action }, result: { customerId, tags } };
};

/**
 * Phase 36 — append a dated, attributed note to a customer's file.
 *
 * Distinct from `customerNote`, which rewrites the single free-text field on
 * the customer record. This one only ever inserts, so it cannot destroy what
 * someone else wrote, and the undo is a delete of the row it created rather
 * than a restoration of prior text.
 */
const crmCustomerNote: AutopilotExecutor = async (ctx) => {
  const customerId = str(ctx.payload.customerId);
  const body = str(ctx.payload.body);
  if (!customerId || !body) return fail("invalid_payload");

  const { rows } = await query<{ id: string }>(
    `SELECT id FROM parties WHERE id = $1 AND business_id = $2`,
    [customerId, ctx.businessId],
  );
  if (!rows[0]) return fail("not_found");

  const note = await addCustomerNote(ctx.businessId, customerId, {
    body,
    isPinned: ctx.payload.isPinned === true,
    createdBy: `${AUTOPILOT_NOTE_PREFIX}دستیار`,
  });
  // `addCustomerNote` now also refuses a customer already merged into
  // another one (the pre-check above only confirmed the row exists, not that
  // it's still the live one) — same `not_found`-shaped failure as the row
  // never existing, since from here the two are indistinguishable in effect.
  if (!note) return fail("not_found");
  return { ok: true, result: { customerId, noteId: note.id } };
};

/**
 * Phase 32. Reached only from a coworker job — `inventory.waste.log` is
 * `coworkerOnly`, so a model that decided on its own that some stock should go
 * can never get here. What makes this a legitimate unattended write is that the
 * owner wrote down *which item and why* when they created the job; the quantity
 * is the template builder's, read from the stock table at fire time.
 */
const wasteLog: AutopilotExecutor = async (ctx) => {
  const inventoryItemId = str(ctx.payload.inventoryItemId);
  const reason = ctx.payload.reason;
  if (!inventoryItemId || !isWasteReason(reason)) return fail("invalid_payload");

  let quantity: QuantityText;
  try {
    quantity = positiveQuantityText(String(ctx.payload.quantity ?? ""));
  } catch {
    return fail("invalid_quantity");
  }

  // On hand is summed from the append-only stock ledger; `inventory_items`
  // holds cost and settings, never a quantity column.
  const { rows } = await query<{ location_id: string; name: string; quantity: string; unit: string }>(
    `SELECT i.location_id, i.name, i.unit,
            trim_scale(COALESCE(sm.total, 0))::text AS quantity
       FROM inventory_items i
       LEFT JOIN LATERAL (
         SELECT sum(quantity) AS total FROM stock_movements WHERE inventory_item_id = i.id
       ) sm ON true
      WHERE i.id = $1`,
    [inventoryItemId],
  );
  const item = rows[0];
  if (!item) return fail("not_found");

  try {
    const recorded = await recordWaste({
      businessId: ctx.businessId,
      locationId: item.location_id,
      inventoryItemId,
      quantity,
      reason,
      note: noteWith(ctx.payload.note),
      createdBy: ctx.authorizedByUserId,
    });
    return {
      ok: true,
      // There is no one-click undo for a write-off (ACTION_CATALOG says so),
      // but the prior quantity is still what a human needs to correct it with a
      // stock count, so it is captured all the same.
      priorState: { inventoryItemId, name: item.name, quantity: item.quantity, unit: item.unit },
      result: {
        inventoryEventId: recorded.inventoryEventId,
        postedCost: recorded.postedCost,
        locationId: item.location_id,
      },
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : "waste_failed");
  }
};

const productionRun: AutopilotExecutor = async (ctx) => {
  const formulaId = str(ctx.payload.formulaId);
  const batchesRaw = str(ctx.payload.batches);
  if (!formulaId || !batchesRaw) return fail("invalid_payload");

  let batches: QuantityText;
  try {
    batches = positiveQuantityText(batchesRaw);
  } catch {
    return fail("invalid_quantity");
  }

  const { rows } = await query<{ location_id: string; name: string }>(
    `SELECT location_id, name FROM production_formulas WHERE id = $1`,
    [formulaId],
  );
  const formula = rows[0];
  if (!formula) return fail("not_found");

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const recorded = await recordProductionRun(client, {
      businessId: ctx.businessId,
      locationId: formula.location_id,
      formulaId,
      batches,
      outputQuantity: str(ctx.payload.outputQuantity) as QuantityText | null,
      conversionCostRial: null,
      note: noteWith(ctx.payload.note),
      createdBy: ctx.authorizedByUserId,
    });
    await client.query("COMMIT");
    return {
      ok: true,
      priorState: { formulaId, formulaName: formula.name, locationId: formula.location_id },
      result: {
        productionRunId: recorded.id,
        locationId: formula.location_id,
        totalCostRial: recorded.totalCostRial,
      },
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err instanceof ProductionError) return fail(err.message);
    return fail(err instanceof Error ? err.message : "production_run_failed");
  } finally {
    client.release();
  }
};

/**
 * Phase 38 — the website's three drafting writes. None of them makes anything
 * public: `draftPost` lands as a draft by adapter contract, `updatePost`
 * cannot touch the publish state, and a product upsert on the site is a
 * catalogue row a human still reviews. `website.post.publish` has NO executor
 * here, and must not get one — that click is a person's.
 */
const websitePostDraft: AutopilotExecutor = async (ctx) => {
  const title = str(ctx.payload.title);
  const body = str(ctx.payload.body);
  if (!title || !body) return fail("invalid_payload");
  const result = await draftWebsitePost(ctx.businessId, {
    title,
    body,
    excerpt: str(ctx.payload.excerpt) ?? undefined,
  });
  if (!result.ok) return fail(result.error);
  return { ok: true, result: { postId: result.data.id, slug: result.data.slug, status: result.data.status } };
};

const websitePostUpdate: AutopilotExecutor = async (ctx) => {
  const postId = str(ctx.payload.postId);
  if (!postId) return fail("invalid_payload");
  const result = await updateWebsitePost(ctx.businessId, postId, {
    ...(str(ctx.payload.title) ? { title: str(ctx.payload.title)! } : {}),
    ...(str(ctx.payload.body) ? { body: str(ctx.payload.body)! } : {}),
    ...(typeof ctx.payload.excerpt === "string" ? { excerpt: ctx.payload.excerpt } : {}),
  });
  if (!result.ok) return fail(result.error);
  return { ok: true, result: { postId: result.data.id, status: result.data.status } };
};

const websiteProductUpsert: AutopilotExecutor = async (ctx) => {
  const title = str(ctx.payload.title);
  const priceRial = int(ctx.payload.priceRial);
  if (!title || priceRial === null || priceRial <= 0) return fail("invalid_payload");
  const stock = ctx.payload.stock === undefined ? undefined : int(ctx.payload.stock);
  if (stock === null) return fail("invalid_payload");
  const result = await upsertWebsiteProduct(ctx.businessId, {
    remoteId: str(ctx.payload.remoteId) ?? undefined,
    title,
    sku: str(ctx.payload.sku) ?? undefined,
    summary: str(ctx.payload.summary) ?? undefined,
    priceRial,
    ...(stock !== undefined ? { stock } : {}),
  });
  if (!result.ok) return fail(result.error);
  return { ok: true, result: { remoteId: result.data.id, title: result.data.title, priceRial: result.data.priceRial } };
};

/** Coworker-only: create an outbox-backed single-recipient campaign, never provider I/O. */
const triggeredMessageCampaign: AutopilotExecutor = async (ctx) => {
  const customerId = str(ctx.payload.customerId);
  const templateId = str(ctx.payload.templateId);
  const channel = ctx.payload.channel === "sms" || ctx.payload.channel === "email" ? ctx.payload.channel : null;
  const eventKind = str(ctx.payload.eventKind);
  if (!customerId || !templateId || !channel || !eventKind) return fail("invalid_payload");
  try {
    const queued = await queueTriggeredMessageCampaign({
      businessId: ctx.businessId, customerId, templateId, channel,
      projectId: str(ctx.payload.projectId) ?? undefined,
      triggerLabel: `پیام رویدادی: ${eventKind}`,
    });
    return { ok: true, result: { campaignId: queued.campaignId, costRial: queued.costRial, queued: true } };
  } catch (error) {
    return fail(error instanceof Error ? error.message : "message_queue_failed");
  }
};

/**
 * Issue #812 §13 — the branch an executor will write into, resolved from the
 * payload BEFORE the write runs, so the central authority gate can check the
 * authorizing member's CURRENT branch scope against it.
 *
 * Returns null when the executor's target is business-wide rather than
 * branch-local (a website draft, a customer note), in which case there is no
 * branch scope to check. Never throws: an unresolvable target is a
 * business-wide write as far as scope is concerned, and the executor's own
 * resolution is still the authority on whether the row exists.
 */
export async function executorTargetLocation(
  executorKey: AutopilotExecutorKey | undefined,
  payload: Record<string, unknown>,
): Promise<string | null> {
  if (!executorKey) return null;
  const menuItemId = str(payload.menuItemId);
  const orderId = str(payload.orderId);
  const inventoryItemId = str(payload.inventoryItemId);
  try {
    switch (executorKey) {
      case "menuItemPatch":
        return menuItemId ? await locationOfMenuItem(menuItemId) : null;
      case "orderDiscount":
        return orderId ? await locationOfOrder(orderId) : null;
      case "stockCount":
      case "draftPurchase":
      case "wasteLog":
      case "productionRun": {
        const ids = Array.isArray(payload.lines)
          ? (payload.lines as Record<string, unknown>[])
              .map((line) => str(line.inventoryItemId))
              .filter((id): id is string => Boolean(id))
          : [];
        if (ids.length === 0 && inventoryItemId) ids.push(inventoryItemId);
        if (ids.length === 0) return null;
        const location = await locationOfInventoryItems(ids);
        return location === "mixed" ? null : location;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export const AUTOPILOT_EXECUTORS: Record<AutopilotExecutorKey, AutopilotExecutor> = {
  menuItemPatch,
  stockCount,
  draftPurchase,
  orderDiscount,
  expense,
  journalDraft,
  customerNote,
  customerTag,
  crmCustomerNote,
  wasteLog,
  productionRun,
  websitePostDraft,
  websitePostUpdate,
  websiteProductUpsert,
  triggeredMessageCampaign,
};

// ---------------------------------------------------------------------------
// Reverters — the one-click undo behind an applied autopilot action.
//
// `expense` has no entry here on purpose: reverseEntry only accepts a
// source_type of 'manual', which an expense's journal entry is not, so there is
// no honest one-click undo to offer. The UI shows none for it.
// ---------------------------------------------------------------------------

const revertMenuItemPatch: AutopilotReverter = async (ctx) => {
  const prior = ctx.priorState;
  const menuItemId = str(prior?.menuItemId) ?? str(ctx.payload.menuItemId);
  if (!prior || !menuItemId) return fail("no_prior_state");
  const locationId = await locationOfMenuItem(menuItemId);
  if (!locationId) return fail("not_found");

  const patch: { price?: number; isActive?: boolean } = {};
  if (typeof prior.price === "number") patch.price = prior.price;
  if (typeof prior.isActive === "boolean") patch.isActive = prior.isActive;
  if (patch.price === undefined && patch.isActive === undefined) return fail("no_prior_state");

  const updated = await updateMenuItem(locationId, menuItemId, patch);
  if (!updated.ok) return fail(updated.error);
  return { ok: true, result: { menuItemId, restored: patch } };
};

const revertStockCount: AutopilotReverter = async (ctx) => {
  const countId = str(ctx.result?.stockCountId);
  const locationId = str(ctx.result?.locationId);
  if (!countId || !locationId) return fail("no_prior_state");

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const reversal = await reverseStockCount(client, {
      businessId: ctx.businessId,
      locationId,
      countId,
      createdBy: ctx.authorizedByUserId,
      note: `${AUTOPILOT_NOTE_PREFIX}برگشت شمارش خودکار`,
    });
    await client.query("COMMIT");
    return { ok: true, result: { reversalCountId: reversal.id, eventId: reversal.eventId } };
  } catch (err) {
    await client.query("ROLLBACK");
    return fail(err instanceof Error ? err.message : "stock_count_reversal_failed");
  } finally {
    client.release();
  }
};

const revertDraftPurchase: AutopilotReverter = async (ctx) => {
  const purchaseId = str(ctx.result?.purchaseId);
  const locationId = str(ctx.result?.locationId);
  if (!purchaseId || !locationId) return fail("no_prior_state");
  const cancelled = await cancelDraftPurchase(locationId, purchaseId);
  return cancelled ? { ok: true, result: { purchaseId, status: "cancelled" } } : fail("purchase_not_draft");
};

const revertOrderDiscount: AutopilotReverter = async (ctx) => {
  const orderId = str(ctx.priorState?.orderId) ?? str(ctx.payload.orderId);
  const locationId = str(ctx.priorState?.locationId);
  if (!orderId || !locationId) return fail("no_prior_state");

  const priorType = ctx.priorState?.discountType;
  const priorValue = Number(ctx.priorState?.discountValue ?? 0);
  const discount =
    priorType === "percent" || priorType === "amount"
      ? ({ type: priorType, value: priorValue } as const)
      : ({ type: null } as const);

  // Refuses once the bill is settled: recomputeOrderTotals only applies to an
  // open order, which is why this action is marked revertible "while_open".
  const applied = await applyOrderDiscount({ locationId, orderId, discount });
  if (!applied.ok) return fail(applied.error);
  return { ok: true, result: { orderId, restored: discount } };
};

const revertJournalDraft: AutopilotReverter = async (ctx) => {
  const draftId = str(ctx.result?.draftId);
  if (!draftId) return fail("no_prior_state");
  try {
    await deleteDraft(ctx.businessId, draftId);
    return { ok: true, result: { draftId, deleted: true } };
  } catch (err) {
    if (err instanceof ManualJournalError) return fail(err.message);
    throw err;
  }
};

const revertCustomerNote: AutopilotReverter = async (ctx) => {
  const customerId = str(ctx.priorState?.customerId) ?? str(ctx.payload.customerId);
  if (!customerId || !ctx.priorState) return fail("no_prior_state");
  const prior = ctx.priorState.notes;
  const restored = await updateCustomer(ctx.businessId, customerId, {
    notes: typeof prior === "string" ? prior : "",
  });
  return restored ? { ok: true, result: { customerId, restored: true } } : fail("not_found");
};

const revertCustomerTag: AutopilotReverter = async (ctx) => {
  const customerId = str(ctx.priorState?.customerId) ?? str(ctx.payload.customerId);
  const tag = str(ctx.priorState?.tag) ?? str(ctx.payload.tag);
  const action = str(ctx.priorState?.action) ?? str(ctx.payload.action);
  if (!customerId || !tag || !action) return fail("no_prior_state");
  // The inverse call, which is the whole reason this action is safe to
  // automate: removing a tag that was added restores the exact prior state,
  // whatever else has happened to the customer's other tags in between.
  const tags = await setCustomerTag(
    ctx.businessId,
    customerId,
    tag,
    action === "add" ? "remove" : "add",
  );
  return tags === null ? fail("not_found") : { ok: true, result: { customerId, tags } };
};

const revertCrmCustomerNote: AutopilotReverter = async (ctx) => {
  const noteId = str(ctx.result?.noteId);
  if (!noteId) return fail("no_prior_state");
  const removed = await deleteCustomerNote(ctx.businessId, noteId);
  return removed ? { ok: true, result: { noteId, removed: true } } : fail("not_found");
};

const revertProductionRun: AutopilotReverter = async (ctx) => {
  const runId = str(ctx.result?.productionRunId);
  const locationId = str(ctx.result?.locationId);
  if (!runId || !locationId) return fail("no_prior_state");

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Phase 29's own reversal — which refuses once the batch has been sold, so
    // an undo can never conjure back stock a customer already took away.
    const reversal = await reverseProductionRun(client, {
      businessId: ctx.businessId,
      locationId,
      runId,
      note: `${AUTOPILOT_NOTE_PREFIX}برگشت تولید خودکار`,
      createdBy: ctx.authorizedByUserId,
    });
    await client.query("COMMIT");
    return { ok: true, result: { reversalRunId: reversal.id } };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err instanceof ProductionError) return fail(err.message);
    return fail(err instanceof Error ? err.message : "production_reversal_failed");
  } finally {
    client.release();
  }
};

export const AUTOPILOT_REVERTERS: Partial<Record<AutopilotExecutorKey, AutopilotReverter>> = {
  menuItemPatch: revertMenuItemPatch,
  stockCount: revertStockCount,
  draftPurchase: revertDraftPurchase,
  orderDiscount: revertOrderDiscount,
  journalDraft: revertJournalDraft,
  customerNote: revertCustomerNote,
  customerTag: revertCustomerTag,
  crmCustomerNote: revertCrmCustomerNote,
  productionRun: revertProductionRun,
};
