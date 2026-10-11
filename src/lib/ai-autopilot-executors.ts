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
import { createStockCount, reverseStockCount } from "./stock-count-service";
import { createDraftPurchase, cancelDraftPurchase, PurchaseServiceError } from "./purchase-service";
import { applyOrderDiscount, normalizeDiscountInput } from "./order-discount-service";
import { MissingLedgerAccountError, recordExpense, reverseExpense, ExpenseError } from "./expense-service";
import { resolveBranchRef } from "./branch-service";
import { parseExpenseSettlement, PayablesInputError, type ExpenseSettlementInput } from "./payables-input";
import { parseExpenseAmount, parseExpenseVatAmount } from "./expense-input";
import { createDraft, deleteDraft, ManualJournalError } from "./manual-journal-service";
import { updateCustomer } from "./parties-service";
import { addCustomerNote, deleteCustomerNote, setCustomerTag } from "./crm-service";
import { isWasteReason, recordWaste } from "./waste-service";
import {
  createFormula,
  updateFormula,
  deleteFormula,
  setFormulaInput,
  deleteFormulaInput,
  recordProductionRun,
  reverseProductionRun,
  ProductionError,
} from "./production-service";
import { positiveQuantityText, rialText, type QuantityText, type RialText } from "./inventory-exact";
import { draftWebsitePost, updateWebsitePost, upsertWebsiteProduct } from "./website/content-service";
import { queueTriggeredMessageCampaign } from "./message-campaigns-service";
import type { PurchaseItemInput } from "./purchase-lines";
// Issue #883 package 2, batch A — accounting services (batch verbs).
import { AccountsError, createAccount, updateAccount } from "./accounts-service";
import { approveDraft, rejectDraft } from "./manual-journal-service";
import { ArError, receivePayment } from "./ar-service";
import { ApError, payBill, reverseApPayment } from "./ap-service";
import { ChequeError, recordCheque, transitionCheque } from "./cheques-service";
import { CHEQUE_ACTIONS } from "./cheques";
import { createInstallmentPlan, InstallmentError, payInstallmentItem } from "./installments-service";
import {
  completeReconciliation,
  createReconciliation,
  ReconciliationError,
  RECONCILABLE_ACCOUNTS,
  type ReconcilableAccount,
} from "./reconciliation-service";
import {
  accruePayroll,
  payPayroll,
  voidPayrollRun,
} from "./payroll-service";
import { PayrollError } from "./payroll-errors";
import { recordAdvance, voidAdvance } from "./payroll-advances-service";
import { createOrder } from "./order-mutations";
import type { CartItemInput } from "./order-cart";
import { ShiftError, openShift, closeOwnShift, closeShiftById } from "./shift-service";
import { randomUUID } from "crypto";
import { createCategory, updateCategory, createMenuItem, updateMenuItem } from "./menu-service";
import { assignBarcode } from "./inventory-item-barcodes-service";
import { createCustomer, createParty } from "./parties-service";
import { getSetting, SETTING_KEYS } from "./settings";
import { toggleNotePin, setConsent } from "./crm-service";
import { createBranch, updateBranch, deactivateBranch, reactivateBranch, BranchError } from "./branch-service";
import { upsertPromotion, setPromotionActive, issueGiftCard } from "./promotions-service";
import { createSupplierReturn } from "./supplier-return-service";
import { createSavedReport, deleteSavedReport, updateSavedReport } from "./reports-service";
import { listPipelines, createPipeline, updatePipeline, moveDealToStage, type StageMoveResult } from "./crm-pipeline-service";
import { saveLead, convertLead } from "./crm-lead-service";
import { upsertDeal, upsertCase, createActivity, updateActivity } from "./crm-service";
import { setCaseStatus } from "./crm-case-service";
import {
  createInventoryTransfer,
  shipInventoryTransfer,
  receiveInventoryTransfer,
  cancelInventoryTransfer,
} from "./transfer-service";
import { createWarehouseDocument, parseWarehouseDocumentLines, isWarehouseDocumentKind } from "./warehouse-document-service";
import { validateReportConfig, type ReportConfig } from "./reports";
import { createWorkspaceProject, updateWorkspaceProject, createWorkspaceTask, updateWorkspaceTask, WorkspaceError } from "./workspace";
import { workspaceAccessFlags } from "./workspace-shared";
import { effectivePermissions, parseOverrides } from "./permissions";
import type { Role } from "./auth-edge";
import { getGrowthSettings } from "./growth-settings-service";
import { createSegment, updateSegment, archiveSegment } from "./crm-segments-service";
import { setAutomationActive } from "./crm-automation-service";
import type { SegmentDefinition } from "./segments";
import type { ConsentChannel } from "./crm-shared";
import type { TaxSetting } from "./setup-state";
import {
  createFixedAsset,
  disposeFixedAsset,
  FixedAssetError,
  postDepreciation,
} from "./fixed-assets-service";

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

/**
 * Every row an executor creates says so, so an automated write never reads as
 * typed by hand. The string itself lives in the framework-free
 * `ai-provenance.ts`, because a screen that wants to show *who* drafted
 * something cannot import this module (it opens a database pool) — re-exported
 * here so no existing importer has to change.
 */
export { AUTOPILOT_NOTE_PREFIX } from "./ai-provenance";
import { AUTOPILOT_NOTE_PREFIX } from "./ai-provenance";

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

/**
 * The branch an automated write should file under: the one the payload named — by
 * id or by a name that belongs to exactly one of *this* business's active
 * branches — and otherwise the default `branch-service` states (oldest active).
 *
 * This file used to answer that question with a private copy of the query
 * `defaultBranchId` is. Two statements of one rule is how a later change lands in
 * only one of them, so both writing actions now go through the resolver, and the
 * fallback that is left is the one a person sees when they open the register.
 *
 * The expense action had no choice at all until now, so «اجارهٔ شعبهٔ شمال» was
 * recorded against whichever branch happened to be oldest: a request and a ledger
 * disagreeing quietly, which is the failure this whole issue is about, arriving
 * from the assistant's side. A wrong or ambiguous name is refused *here* rather
 * than passed on for `recordExpense` to reject, because the service's refusal is
 * right but arrives after the executor has already echoed a branch id back in its
 * result.
 */
async function chosenLocation(
  businessId: string,
  requested: string | null,
): Promise<{ locationId: string | null } | { error: string }> {
  const resolved = await resolveBranchRef(businessId, requested);
  if (resolved.ok) return { locationId: resolved.locationId };
  return { error: resolved.reason === "ambiguous" ? "ambiguous_location" : "invalid_location" };
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

  // A price inside this patch becomes canonical price history recorded as
  // `ai` — autopilot and MCP share this executor, and both are the assistant
  // acting on the owner's authorization (issue #844).
  const updated = await updateMenuItem(locationId, menuItemId, patch, ctx.businessId, {
    changedBy: ctx.authorizedByUserId,
    source: "ai",
  });
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
    if (err instanceof PurchaseServiceError) return fail(err.message);
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
  // The amount rule of the channel, not this file's generic integer reader: a
  // model that hands over ۱۵۰/۷ تومان gets the same refusal the API gives, and a
  // figure whose ×10 landed on a float artefact is read as the Rial it is (§5).
  const amount = parseExpenseAmount(ctx.payload.amount);
  const memo = str(ctx.payload.memo);
  if (!accountId || amount === null || !memo) return fail("invalid_payload");
  /*
   * The settlement is read through the same parser the form and the service use,
   * so an owed expense is not refused for the wrong reason here — a `paymentAccountId`
   * belongs to a paid expense, and a model that omits it for «پرداخت بعدی» is
   * right, not malformed (issue #832 §15: one rule, every channel).
   */
  let settlement: ExpenseSettlementInput;
  try {
    settlement = parseExpenseSettlement({
      settlement: ctx.payload.settlement,
      supplierId: ctx.payload.supplierId,
      dueDate: ctx.payload.dueDate,
    });
  } catch (err) {
    if (err instanceof PayablesInputError) return fail(err.message);
    throw err;
  }
  if (settlement.settlement === "paid" && !paymentAccountId) return fail("invalid_payload");

  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);

  try {
    const created = await recordExpense({
      businessId: ctx.businessId,
      locationId: branch.locationId,
      accountId,
      paymentAccountId: settlement.settlement === "credit" ? null : paymentAccountId,
      settlement: settlement.settlement,
      supplierId: settlement.supplierId,
      dueDate: settlement.dueDate,
      amount,
      expenseDate: str(ctx.payload.expenseDate),
      vendor: str(ctx.payload.vendor),
      partyId: str(ctx.payload.partyId) ?? undefined,
      vatAmount: parseExpenseVatAmount(ctx.payload.vatAmount ?? 0),
      memo: `${AUTOPILOT_NOTE_PREFIX}${memo}`,
      createdBy: ctx.authorizedByUserId,
    });
    return { ok: true, result: { expenseId: created.id, amount } };
  } catch (err) {
    if (err instanceof ExpenseError) return fail(err.message);
    if (err instanceof MissingLedgerAccountError) {
      // `POST /api/ledger/expenses` answers 409 `ledger_account_missing` for this
      // fact. Unmapped, the action reported the bare account code as its failure
      // reason — a number where the model should have read «this chart has no
      // Accounts Payable account to credit».
      return fail("ledger_account_missing");
    }
    return fail(err instanceof Error ? err.message : "expense_failed");
  }
};

/**
 * Undo an automated expense the way the register undoes any other: a mirrored
 * reversal, never a deletion (issue #832 §1, §15). Before 0211 there was no
 * honest one-click undo to offer for `expense.categorize` — `reverseEntry`
 * accepts only `source_type='manual'` — which is why the action advertised
 * itself as irreversible; it now shares the accountant's own correction path
 * rather than an automation-only one.
 */
const revertExpense: AutopilotReverter = async (ctx) => {
  const expenseId = str(ctx.result?.expenseId) ?? str(ctx.payload.expenseId);
  if (!expenseId) return fail("no_prior_state");
  if (!ctx.authorizedByUserId) return fail("no_authorizing_user");
  try {
    await reverseExpense({
      businessId: ctx.businessId,
      expenseId,
      actorId: ctx.authorizedByUserId,
      memo: `${AUTOPILOT_NOTE_PREFIX}ابطال هزینهٔ خودکار`,
    });
    return { ok: true, result: { expenseId, reversed: true } };
  } catch (err) {
    if (err instanceof ExpenseError) return fail(err.message);
    throw err;
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
    const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
    if ("error" in branch) return fail(branch.error);
    const created = await createDraft({
      businessId: ctx.businessId,
      locationId: branch.locationId,
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
      case "menuItemUpdate":
        return menuItemId ? await locationOfMenuItem(menuItemId) : null;
      // Batch C — the other menu/barcode writes resolve their branch from the
      // target row; party records are business-scoped facts (default branch).
      case "menuCategoryCreate":
      case "giftCardIssue":
      // A return inherits the issue branch the same way the voucher's route
      // resolves it from the payload.
      case "supplierReturnCreate": {
        // Gift cards name the issue branch in the payload (id-or-name, like the
        // route's resolveActiveLocation fallback); promotions and parties stay
        // business-scoped (default null ⇒ pinned consents refuse via the write
        // gate just like the rest).
        return str(payload.locationId);
      }
      case "menuCategoryUpdate": {
        const categoryId = str(payload.categoryId);
        if (!categoryId) return null;
        const { rows } = await query<{ location_id: string }>(
          `SELECT location_id FROM menu_categories WHERE id = $1`,
          [categoryId],
        );
        return rows[0]?.location_id ?? null;
      }
      case "menuItemCreate": {
        const categoryId = str(payload.categoryId);
        if (!categoryId) return null;
        const { rows } = await query<{ location_id: string }>(
          `SELECT location_id FROM menu_categories WHERE id = $1`,
          [categoryId],
        );
        return rows[0]?.location_id ?? null;
      }
      case "barcodeAssign": {
        const id = inventoryItemId;
        if (!id) return null;
        const location = await locationOfInventoryItems([id]);
        return location === "mixed" ? null : location;
      }
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
      // Issue #883 batch A — the accounting writes that name a branch in their
      // payload resolve it here so a branch-pinned MCP connection physically
      // cannot execute them for another branch; the rest (journal drafts,
      // accounts, cheques, payroll) are business-scoped facts with no branch.
      case "expenseReverse": {
        const expenseId = str(payload.expenseId);
        if (!expenseId) return null;
        const { rows } = await query<{ location_id: string | null }>(
          `SELECT location_id FROM expenses WHERE id = $1`,
          [expenseId],
        );
        return rows[0]?.location_id ?? null;
      }
      case "apPaymentReverse": {
        const paymentId = str(payload.paymentId);
        if (!paymentId) return null;
        const { rows } = await query<{ location_id: string | null }>(
          `SELECT location_id FROM ap_payments WHERE id = $1`,
          [paymentId],
        );
        return rows[0]?.location_id ?? null;
      }
      case "chequeTransition": {
        const chequeId = str(payload.chequeId);
        if (!chequeId) return null;
        const { rows } = await query<{ location_id: string | null }>(
          `SELECT location_id FROM cheques WHERE id = $1`,
          [chequeId],
        );
        return rows[0]?.location_id ?? null;
      }
      case "installmentItemPay": {
        const planId = str(payload.planId);
        if (!planId) return null;
        const { rows } = await query<{ location_id: string | null }>(
          `SELECT location_id FROM installments WHERE id = $1`,
          [planId],
        );
        return rows[0]?.location_id ?? null;
      }
      case "payrollRunPay":
      case "payrollRunVoid": {
        const runId = str(payload.runId);
        if (!runId) return null;
        const { rows } = await query<{ location_id: string | null }>(
          `SELECT location_id FROM payroll_runs WHERE id = $1`,
          [runId],
        );
        return rows[0]?.location_id ?? null;
      }
      case "fixedAssetDepreciate":
      case "fixedAssetDispose": {
        const fixedAssetId = str(payload.fixedAssetId);
        if (!fixedAssetId) return null;
        const { rows } = await query<{ location_id: string | null }>(
          `SELECT location_id FROM fixed_assets WHERE id = $1`,
          [fixedAssetId],
        );
        return rows[0]?.location_id ?? null;
      }
      case "shiftClose": {
        const shiftId = str(payload.shiftId);
        if (!shiftId) return null;
        const { rows } = await query<{ location_id: string | null }>(
          `SELECT location_id FROM employee_shifts WHERE id = $1`,
          [shiftId],
        );
        return rows[0]?.location_id ?? null;
      }
      case "orderCreate":
      case "shiftStart": {
        // The branch rides in the payload as the route accepts it (id or
        // null = primary); the consent check below compares sensibly against
        // it directly because these tools are branch-scoped by design.
        return str(payload.locationId);
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Issue #883 package 2, batch A — accounting executors.
//
// Same rule as every executor above: each calls the service function the
// ledger route handler calls, with `ctx.authorizedByUserId` handed over as the
// actor (`createdBy`). Payloads that point at an existing record name it by id
// and the service refuses 404/410 the same way the route answers; payloads
// that create money attach the branch the same way (`chosenLocation`).
// Nothing here writes SQL.
// ---------------------------------------------------------------------------

const actorOf = (ctx: AutopilotExecutorContext): string | null => ctx.authorizedByUserId;

const accountCreate: AutopilotExecutor = async (ctx) => {
  const code = str(ctx.payload.code);
  const name = str(ctx.payload.name);
  const type = str(ctx.payload.type);
  if (!code || !name || !type) return fail("invalid_payload");
  try {
    const created = await createAccount({
      businessId: ctx.businessId,
      code,
      name,
      type,
      parentId: str(ctx.payload.parentId),
      isContra: ctx.payload.isContra === true,
    });
    return { ok: true, result: created };
  } catch (err) {
    if (err instanceof AccountsError) return fail(err.message);
    throw err;
  }
};

const accountUpdate: AutopilotExecutor = async (ctx) => {
  const accountId = str(ctx.payload.accountId);
  if (!accountId) return fail("invalid_payload");
  try {
    await updateAccount({
      businessId: ctx.businessId,
      id: accountId,
      actorId: actorOf(ctx),
      name: str(ctx.payload.name) ?? undefined,
      parentId: ctx.payload.parentId === null ? null : (str(ctx.payload.parentId) ?? undefined),
      reparent: ctx.payload.parentId !== undefined,
    });
    return { ok: true, result: { accountId } };
  } catch (err) {
    if (err instanceof AccountsError) return fail(err.message);
    throw err;
  }
};

const accountDisable: AutopilotExecutor = async (ctx) => {
  const accountId = str(ctx.payload.accountId);
  if (!accountId) return fail("invalid_payload");
  try {
    await updateAccount({
      businessId: ctx.businessId,
      id: accountId,
      actorId: actorOf(ctx),
      isActive: ctx.payload.isActive === undefined ? false : ctx.payload.isActive === true,
    });
    return { ok: true, result: { accountId } };
  } catch (err) {
    if (err instanceof AccountsError) return fail(err.message);
    throw err;
  }
};

const journalDraftApprove: AutopilotExecutor = async (ctx) => {
  const draftId = str(ctx.payload.draftId);
  if (!draftId) return fail("invalid_payload");
  const actor = actorOf(ctx);
  if (!actor) return fail("no_authorizing_user");
  try {
    const posted = await approveDraft({ businessId: ctx.businessId, locationId: null, draftId, actorId: actor });
    return { ok: true, result: posted };
  } catch (err) {
    if (err instanceof ManualJournalError) return fail(err.message);
    throw err;
  }
};

const journalDraftReject: AutopilotExecutor = async (ctx) => {
  const draftId = str(ctx.payload.draftId);
  if (!draftId) return fail("invalid_payload");
  const actor = actorOf(ctx);
  if (!actor) return fail("no_authorizing_user");
  try {
    const rejected = await rejectDraft({
      businessId: ctx.businessId,
      draftId,
      actorId: actor,
      reason: str(ctx.payload.reason),
      requireReason: true,
    });
    return { ok: true, result: rejected };
  } catch (err) {
    if (err instanceof ManualJournalError) return fail(err.message);
    throw err;
  }
};

const expenseReverse: AutopilotExecutor = async (ctx) => {
  const expenseId = str(ctx.payload.expenseId);
  if (!expenseId) return fail("invalid_payload");
  const actor = actorOf(ctx);
  if (!actor) return fail("no_authorizing_user");
  try {
    const reversal = await reverseExpense({
      businessId: ctx.businessId,
      expenseId,
      actorId: actor,
      reversalDate: str(ctx.payload.reversalDate),
      memo: str(ctx.payload.memo),
    });
    return { ok: true, result: reversal as unknown as Record<string, unknown> };
  } catch (err) {
    if (err instanceof ExpenseError) return fail(err.message);
    throw err;
  }
};

const partyRef = (payload: Record<string, unknown>): { customerId: string | null; supplierId: string | null } => {
  // Accept the direction-shaped ids first, then the generic customer/supplier
  // pair — cheques carry their own constraint check, so a mispaired id
  // surfaces as the same error code the route answers, never a silent swap.
  return {
    customerId: str(payload.customerId),
    supplierId: str(payload.supplierId),
  };
};

const arReceiptRecord: AutopilotExecutor = async (ctx) => {
  const customerId = str(ctx.payload.customerId) ?? str(ctx.payload.partyId);
  const amount = int(ctx.payload.amount);
  const method = ctx.payload.method === "bank" ? "bank" : "cash";
  if (!customerId || amount === null) return fail("invalid_payload");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  try {
    const receipt = await receivePayment({
      businessId: ctx.businessId,
      locationId: branch.locationId,
      customerId,
      method,
      amount,
      receiptDate: str(ctx.payload.receiptDate),
      memo: str(ctx.payload.memo),
      createdBy: actorOf(ctx),
      cashAccountId: str(ctx.payload.cashAccountId),
      bankReference: str(ctx.payload.bankReference),
    });
    return { ok: true, result: receipt as unknown as Record<string, unknown> };
  } catch (err) {
    if (err instanceof ArError) return fail(err.message);
    if (err instanceof PayablesInputError) return fail(err.message);
    throw err;
  }
};

const apPaymentRecord: AutopilotExecutor = async (ctx) => {
  const supplierId = str(ctx.payload.supplierId) ?? str(ctx.payload.partyId);
  const amount = int(ctx.payload.amount);
  const method = ctx.payload.method === "bank" ? "bank" : "cash";
  if (!supplierId || amount === null) return fail("invalid_payload");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  try {
    const payment = await payBill({
      businessId: ctx.businessId,
      locationId: branch.locationId,
      supplierId,
      method,
      amount,
      paymentDate: str(ctx.payload.paymentDate),
      memo: str(ctx.payload.memo),
      clientRequestId: str(ctx.payload.clientRequestId) ?? crypto.randomUUID(),
      createdBy: actorOf(ctx),
      cashAccountId: str(ctx.payload.cashAccountId),
      bankReference: str(ctx.payload.bankReference),
    });
    return { ok: true, result: payment as unknown as Record<string, unknown> };
  } catch (err) {
    if (err instanceof ApError) return fail(err.message);
    if (err instanceof PayablesInputError) return fail(err.message);
    throw err;
  }
};

const apPaymentReverse: AutopilotExecutor = async (ctx) => {
  const paymentId = str(ctx.payload.paymentId);
  if (!paymentId) return fail("invalid_payload");
  const branch = await chosenLocation(ctx.businessId, null);
  if ("error" in branch) return fail(branch.error);
  try {
    const reversal = await reverseApPayment({
      businessId: ctx.businessId,
      locationId: branch.locationId,
      paymentId,
      actorId: actorOf(ctx),
      reversalDate: str(ctx.payload.reversalDate),
      memo: str(ctx.payload.memo),
    });
    return { ok: true, result: reversal as unknown as Record<string, unknown> };
  } catch (err) {
    if (err instanceof ApError) return fail(err.message);
    throw err;
  }
};

const chequeCreate: AutopilotExecutor = async (ctx) => {
  const direction = ctx.payload.direction === "payable" ? "payable" : "receivable";
  const amount = int(ctx.payload.amount);
  const serialNumber = str(ctx.payload.serialNumber);
  const bankName = str(ctx.payload.bankName);
  const dueDate = str(ctx.payload.dueDate);
  const { customerId, supplierId } = partyRef(ctx.payload);
  const counterpartyName = str(ctx.payload.counterpartyName);
  if (amount === null || !serialNumber || !bankName || !dueDate || !counterpartyName) {
    return fail("invalid_payload");
  }
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  try {
    const cheque = await recordCheque({
      businessId: ctx.businessId,
      locationId: branch.locationId,
      direction,
      serialNumber,
      sayadId: str(ctx.payload.sayadId),
      bankName,
      accountNumber: str(ctx.payload.accountNumber),
      amount,
      issueDate: str(ctx.payload.issueDate),
      dueDate,
      counterpartyName,
      customerId: direction === "receivable" ? customerId : customerId,
      supplierId,
      memo: str(ctx.payload.memo),
      createdBy: actorOf(ctx),
    });
    return { ok: true, result: cheque as unknown as Record<string, unknown> };
  } catch (err) {
    if (err instanceof ChequeError) return fail(err.message);
    throw err;
  }
};

const chequeTransition: AutopilotExecutor = async (ctx) => {
  const chequeId = str(ctx.payload.chequeId);
  const action = str(ctx.payload.action);
  if (!chequeId || !action || !CHEQUE_ACTIONS.includes(action as (typeof CHEQUE_ACTIONS)[number])) {
    return fail("invalid_payload");
  }
  const branch = await chosenLocation(ctx.businessId, null);
  if ("error" in branch) return fail(branch.error);
  try {
    const cheque = await transitionCheque({
      businessId: ctx.businessId,
      locationId: branch.locationId,
      chequeId,
      action: action as (typeof CHEQUE_ACTIONS)[number],
      endorsedToSupplierId: str(ctx.payload.endorsedToSupplierId),
      occurredOn: str(ctx.payload.occurredOn),
      memo: str(ctx.payload.memo),
      createdBy: actorOf(ctx),
    });
    return { ok: true, result: cheque as unknown as Record<string, unknown> };
  } catch (err) {
    if (err instanceof ChequeError) return fail(err.message);
    throw err;
  }
};

const installmentPlanCreate: AutopilotExecutor = async (ctx) => {
  const direction = ctx.payload.direction === "payable" ? "payable" : "receivable";
  const partyId = str(ctx.payload.partyId);
  const principal = int(ctx.payload.principal);
  const installmentCount = int(ctx.payload.installmentCount);
  const intervalMonths = int(ctx.payload.intervalMonths) ?? 1;
  const firstDueDate = str(ctx.payload.firstDueDate);
  if (principal === null || installmentCount === null || !firstDueDate) return fail("invalid_payload");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  try {
    const plan = await createInstallmentPlan({
      businessId: ctx.businessId,
      locationId: branch.locationId,
      direction,
      source: "party",
      partyId,
      principal,
      downPayment: int(ctx.payload.downPayment) ?? undefined,
      interestPercent: ctx.payload.interestPercent === undefined ? undefined : int(ctx.payload.interestPercent) ?? 0,
      lateFeePercent: ctx.payload.lateFeePercent === undefined ? undefined : int(ctx.payload.lateFeePercent) ?? 0,
      installmentCount,
      intervalMonths,
      firstDueDate,
      note: str(ctx.payload.note),
      createdBy: actorOf(ctx),
    });
    return { ok: true, result: plan };
  } catch (err) {
    if (err instanceof InstallmentError) return fail(err.message);
    throw err;
  }
};

const installmentItemPay: AutopilotExecutor = async (ctx) => {
  const planId = str(ctx.payload.planId);
  const itemId = str(ctx.payload.itemId);
  const method = ctx.payload.method === "bank" ? "bank" : "cash";
  if (!planId || !itemId) return fail("invalid_payload");
  const branch = await chosenLocation(ctx.businessId, null);
  if ("error" in branch) return fail(branch.error);
  try {
    await payInstallmentItem({
      businessId: ctx.businessId,
      locationId: branch.locationId,
      planId,
      itemId,
      method,
      memo: str(ctx.payload.memo),
      createdBy: actorOf(ctx),
    });
    return { ok: true, result: { planId, itemId } };
  } catch (err) {
    if (err instanceof InstallmentError) return fail(err.message);
    throw err;
  }
};

const reconciliationCreate: AutopilotExecutor = async (ctx) => {
  const accountCode = str(ctx.payload.accountCode);
  const statementDate = str(ctx.payload.statementDate);
  const statementBalance = int(ctx.payload.statementBalance);
  if (!accountCode || !statementDate || statementBalance === null) return fail("invalid_payload");
  if (!(RECONCILABLE_ACCOUNTS as readonly string[]).includes(accountCode)) return fail("invalid_payload");
  try {
    const recon = await createReconciliation({
      businessId: ctx.businessId,
      accountCode: accountCode as ReconcilableAccount,
      statementDate,
      statementBalance,
      createdBy: actorOf(ctx),
    });
    return { ok: true, result: recon as unknown as Record<string, unknown> };
  } catch (err) {
    if (err instanceof ReconciliationError) return fail(err.message);
    throw err;
  }
};

const reconciliationComplete: AutopilotExecutor = async (ctx) => {
  const reconciliationId = str(ctx.payload.reconciliationId);
  if (!reconciliationId) return fail("invalid_payload");
  const actor = actorOf(ctx);
  if (!actor) return fail("no_authorizing_user");
  try {
    const done = await completeReconciliation({
      businessId: ctx.businessId,
      reconciliationId,
      actorId: actor,
    });
    return { ok: true, result: done as unknown as Record<string, unknown> };
  } catch (err) {
    if (err instanceof ReconciliationError) return fail(err.message);
    throw err;
  }
};

const payrollRunAccrue: AutopilotExecutor = async (ctx) => {
  const periodKey = str(ctx.payload.periodKey);
  if (!periodKey) return fail("invalid_payload");
  try {
    const run = await accruePayroll({
      businessId: ctx.businessId,
      createdBy: actorOf(ctx),
      periodKey,
      accrualDate: str(ctx.payload.accrualDate),
      overtime: (ctx.payload.overtime as Record<string, unknown> | null) ?? null,
      idempotencyKey: str(ctx.payload.idempotencyKey),
    });
    return { ok: true, result: run as unknown as Record<string, unknown> };
  } catch (err) {
    if (err instanceof PayrollError) return fail(err.message);
    throw err;
  }
};

const payrollRunPay: AutopilotExecutor = async (ctx) => {
  const runId = str(ctx.payload.runId);
  if (!runId) return fail("invalid_payload");
  const method = str(ctx.payload.paymentAccountId) ? undefined : ctx.payload.method === "bank" ? "bank" : "cash";
  try {
    const run = await payPayroll({
      businessId: ctx.businessId,
      runId,
      method,
      paymentAccountId: str(ctx.payload.paymentAccountId),
      paidDate: str(ctx.payload.paidDate),
      actorId: actorOf(ctx),
    });
    return { ok: true, result: run as unknown as Record<string, unknown> };
  } catch (err) {
    if (err instanceof PayrollError) return fail(err.message);
    throw err;
  }
};

const payrollRunVoid: AutopilotExecutor = async (ctx) => {
  const runId = str(ctx.payload.runId);
  if (!runId) return fail("invalid_payload");
  try {
    const run = await voidPayrollRun({ businessId: ctx.businessId, runId, actorId: actorOf(ctx) });
    return { ok: true, result: run as unknown as Record<string, unknown> };
  } catch (err) {
    if (err instanceof PayrollError) return fail(err.message);
    throw err;
  }
};

const payrollAdvanceRecord: AutopilotExecutor = async (ctx) => {
  const userId = str(ctx.payload.userId);
  const amount = ctx.payload.amount;
  if (!userId || amount === undefined) return fail("invalid_payload");
  try {
    const advance = await recordAdvance({
      businessId: ctx.businessId,
      userId,
      amount,
      method: ctx.payload.method === "bank" ? "bank" : "cash",
      paymentAccountId: str(ctx.payload.paymentAccountId),
      advanceDate: str(ctx.payload.advanceDate),
      note: str(ctx.payload.note),
      createdBy: actorOf(ctx),
    });
    return { ok: true, result: advance as unknown as Record<string, unknown> };
  } catch (err) {
    if (err instanceof PayrollError) return fail(err.message);
    throw err;
  }
};

const payrollAdvanceVoid: AutopilotExecutor = async (ctx) => {
  const advanceId = str(ctx.payload.advanceId);
  if (!advanceId) return fail("invalid_payload");
  try {
    const advance = await voidAdvance({ businessId: ctx.businessId, advanceId, actorId: actorOf(ctx) });
    return { ok: true, result: advance as unknown as Record<string, unknown> };
  } catch (err) {
    if (err instanceof PayrollError) return fail(err.message);
    throw err;
  }
};

const fixedAssetCreate: AutopilotExecutor = async (ctx) => {
  const name = str(ctx.payload.name);
  const acquisitionDate = str(ctx.payload.acquisitionDate);
  const cost = int(ctx.payload.cost);
  const salvageValue = int(ctx.payload.salvageValue) ?? 0;
  const usefulLifeMonths = int(ctx.payload.usefulLifeMonths);
  if (!name || !acquisitionDate || cost === null || usefulLifeMonths === null) return fail("invalid_payload");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  try {
    const asset = await createFixedAsset({
      businessId: ctx.businessId,
      locationId: branch.locationId,
      name,
      acquisitionDate,
      inServiceDate: str(ctx.payload.inServiceDate),
      cost,
      salvageValue,
      usefulLifeMonths,
      createdBy: actorOf(ctx),
    });
    return { ok: true, result: asset as unknown as Record<string, unknown> };
  } catch (err) {
    if (err instanceof FixedAssetError) return fail(err.message);
    throw err;
  }
};

const fixedAssetDepreciate: AutopilotExecutor = async (ctx) => {
  const fixedAssetId = str(ctx.payload.fixedAssetId);
  if (!fixedAssetId) return fail("invalid_payload");
  try {
    const posted = await postDepreciation({
      businessId: ctx.businessId,
      fixedAssetId,
      periodKey: str(ctx.payload.periodKey),
      periodLabel: str(ctx.payload.periodLabel),
      entryDate: str(ctx.payload.entryDate),
      createdBy: actorOf(ctx),
    });
    return { ok: true, result: posted as unknown as Record<string, unknown> };
  } catch (err) {
    if (err instanceof FixedAssetError) return fail(err.message);
    throw err;
  }
};

const fixedAssetDispose: AutopilotExecutor = async (ctx) => {
  const fixedAssetId = str(ctx.payload.fixedAssetId);
  const kind = str(ctx.payload.kind);
  if (!fixedAssetId || kind !== "sale" && kind !== "write_off" && kind !== "retirement") {
    return fail("invalid_payload");
  }
  try {
    const disposal = await disposeFixedAsset({
      businessId: ctx.businessId,
      fixedAssetId,
      kind: kind as "sale" | "write_off" | "retirement",
      disposalDate: str(ctx.payload.disposalDate),
      proceeds: kind === "sale" ? int(ctx.payload.proceeds) : undefined,
      proceedsAccountId: str(ctx.payload.proceedsAccountId),
      reason: str(ctx.payload.reason),
      createdBy: actorOf(ctx),
    });
    return { ok: true, result: disposal as unknown as Record<string, unknown> };
  } catch (err) {
    if (err instanceof FixedAssetError) return fail(err.message);
    throw err;
  }
};


// ── Issue #883 package 2, batch B — POS operations executors ────────────────
// Each mirrors the smallest route its action names: /api/orders POST,
// /api/shifts/start, /api/shifts/end and /api/shifts/[id]/close POST. The
// constraint "route and tool share one service" is literal here; the checkout
// (settle) route is deliberately NOT an executor, since its posting
// orchestration lives inline in the route for now — see the coverage matrix
// note on pos.orders.
const orderCreate: AutopilotExecutor = async (ctx) => {
  const rawItems = Array.isArray(ctx.payload.items) ? ctx.payload.items : [];
  const items: CartItemInput[] = [];
  for (const item of rawItems) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const menuItemId = str(row.menuItemId);
    const quantity = typeof row.quantity === "number" && Number.isSafeInteger(row.quantity) ? row.quantity : null;
    if (!menuItemId || quantity === null || quantity <= 0) continue;
    const note = str(row.note) ?? str(row.notes);
    items.push(note ? { menuItemId, quantity, note } : { menuItemId, quantity });
  }
  if (items.length === 0) return fail("invalid_payload");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  const created = await createOrder({
    locationId: branch.locationId,
    type: ctx.payload.orderType === "dine_in" || ctx.payload.orderType === "delivery" ? ctx.payload.orderType : "takeaway",
    tableId: str(ctx.payload.tableId),
    customerId: str(ctx.payload.customerId),
    note: str(ctx.payload.note),
    discount: { type: null },
    items,
    openedBy: ctx.authorizedByUserId,
    clientRequestId: str(ctx.payload.clientOrderId) ?? str(ctx.payload.clientRequestId) ?? randomUUID(),
  });
  if (!created.ok) return fail(created.error);
  return { ok: true, result: created.data as unknown as Record<string, unknown> };
};

const roleOf = (ctx: AutopilotExecutorContext): "cashier" => "cashier";

const shiftStart: AutopilotExecutor = async (ctx) => {
  const actor = ctx.authorizedByUserId;
  if (!actor) return fail("no_authorizing_user");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  const openingFloat = int(ctx.payload.openingFloat);
  try {
    const shift = await openShift(actor, ctx.businessId, null, openingFloat, branch.locationId, roleOf(ctx));
    return { ok: true, result: shift as unknown as Record<string, unknown> };
  } catch (err) {
    if (err instanceof ShiftError) return fail(err.message);
    throw err;
  }
};

const shiftEnd: AutopilotExecutor = async (ctx) => {
  const actor = ctx.authorizedByUserId;
  if (!actor) return fail("no_authorizing_user");
  const closingFloat = int(ctx.payload.closingFloat);
  try {
    const result = await closeOwnShift(actor, ctx.businessId, closingFloat, roleOf(ctx));
    return { ok: true, result: result as unknown as Record<string, unknown> };
  } catch (err) {
    if (err instanceof ShiftError) return fail(err.message);
    throw err;
  }
};

const shiftClose: AutopilotExecutor = async (ctx) => {
  const shiftId = str(ctx.payload.shiftId);
  if (!shiftId) return fail("invalid_payload");
  const closingFloat = int(ctx.payload.closingFloat);
  try {
    const result = await closeShiftById(shiftId, ctx.businessId, ctx.authorizedByUserId, closingFloat, "manager");
    return { ok: true, result: result as unknown as Record<string, unknown> };
  } catch (err) {
    if (err instanceof ShiftError) return fail(err.message);
    throw err;
  }
};


// ── Issue #883 package 2, batch C — menu catalogue, barcodes, parties ───────
// Price/name structure of a menu and the barcode on a pack change what the
// till pads into each invoice line; the same rules the screens apply run in
// these services (uniqueness within branch, valid symbology, image asset in
// the tenant's own library).

const defaultTaxRateOf = async (businessId: string): Promise<number> => {
  const tax = await getSetting<TaxSetting>(businessId, SETTING_KEYS.tax);
  return tax?.defaultRate ?? 0;
};

const menuCategoryCreate: AutopilotExecutor = async (ctx) => {
  const name = str(ctx.payload.name);
  if (!name) return fail("invalid_payload");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  const result = await createCategory(branch.locationId, {
    name,
    taxRate: typeof ctx.payload.taxRate === "number" ? ctx.payload.taxRate : undefined,
    sortOrder: int(ctx.payload.sortOrder) ?? undefined,
  }, await defaultTaxRateOf(ctx.businessId));
  if (!result.ok) return fail(result.error);
  return { ok: true, result: { id: result.id } };
};

const menuCategoryUpdate: AutopilotExecutor = async (ctx) => {
  const categoryId = str(ctx.payload.categoryId);
  if (!categoryId) return fail("invalid_payload");
  const name = str(ctx.payload.name);
  const isActive = ctx.payload.isActive;
  if (name === null && isActive === undefined) return fail("invalid_payload");
  const { rows } = await query<{ location_id: string }>(`SELECT location_id FROM menu_categories WHERE id = $1`, [categoryId]);
  const locationId = rows[0]?.location_id;
  if (!locationId) return fail("not_found");
  // Branch consent: the category must live at a consented branch.
  const result = await updateCategory(locationId, categoryId, {
    name: name ?? undefined,
    taxRate: typeof ctx.payload.taxRate === "number" ? ctx.payload.taxRate : undefined,
    sortOrder: int(ctx.payload.sortOrder) ?? undefined,
    isActive: typeof isActive === "boolean" ? isActive : undefined,
  });
  if (!result.ok) return fail(result.error);
  return { ok: true, result: { id: categoryId } };
};

const menuItemCreate: AutopilotExecutor = async (ctx) => {
  const categoryId = str(ctx.payload.categoryId);
  const name = str(ctx.payload.name);
  const price = typeof ctx.payload.price === "number" && Number.isFinite(ctx.payload.price) ? ctx.payload.price : null;
  if (!categoryId || !name || price === null) return fail("invalid_payload");
  const { rows } = await query<{ location_id: string }>(`SELECT location_id FROM menu_categories WHERE id = $1`, [categoryId]);
  const locationId = rows[0]?.location_id;
  if (!locationId) return fail("not_found");
  const result = await createMenuItem(locationId, ctx.businessId, {
    categoryId,
    name,
    price,
    description: str(ctx.payload.description),
    sku: str(ctx.payload.sku),
    sortOrder: int(ctx.payload.sortOrder) ?? undefined,
  });
  if (!result.ok) return fail(result.error);
  return { ok: true, result: { id: result.id } };
};

const menuItemUpdate: AutopilotExecutor = async (ctx) => {
  const menuItemId = str(ctx.payload.menuItemId);
  if (!menuItemId) return fail("invalid_payload");
  const locationId = await locationOfMenuItem(menuItemId);
  if (!locationId) return fail("not_found");
  const name = str(ctx.payload.name);
  const description = str(ctx.payload.description);
  const sku = str(ctx.payload.sku);
  const price = typeof ctx.payload.price === "number" && Number.isFinite(ctx.payload.price) ? ctx.payload.price : null;
  const isActive = ctx.payload.isActive;
  if (name === null && description === null && sku === null && price === null && isActive === undefined) {
    return fail("invalid_payload");
  }
  const result = await updateMenuItem(locationId, menuItemId, {
    name: name ?? undefined,
    price: price ?? undefined,
    description,
    sku,
    isActive: typeof isActive === "boolean" ? isActive : undefined,
  }, ctx.businessId);
  if (!result.ok) return fail(result.error);
  return { ok: true, result: { id: menuItemId } };
};

const barcodeAssign: AutopilotExecutor = async (ctx) => {
  const inventoryItemId = str(ctx.payload.inventoryItemId);
  if (!inventoryItemId) return fail("invalid_payload");
  try {
    const rawSymbology = str(ctx.payload.symbology);
    const symbology =
      rawSymbology === "EAN13" || rawSymbology === "UPC" || rawSymbology === "internal"
        ? (rawSymbology as import("./barcode").BarcodeSymbology)
        : null;
    const assigned = await assignBarcode(inventoryItemId, {
      code: str(ctx.payload.code),
      symbology,
      note: str(ctx.payload.note),
    });
    return { ok: true, result: assigned as unknown as Record<string, unknown> };
  } catch (err) {
    return fail(err instanceof Error ? err.message : "barcode_assign_failed");
  }
};

const partyCustomerCreate: AutopilotExecutor = async (ctx) => {
  const name = str(ctx.payload.name);
  if (!name) return fail("invalid_payload");
  const created = await createCustomer(ctx.businessId, {
    name,
    phone: str(ctx.payload.phone),
    email: str(ctx.payload.email),
    address: str(ctx.payload.address),
    notes: str(ctx.payload.notes),
    birthday: str(ctx.payload.birthday),
    tags: Array.isArray(ctx.payload.tags) ? ctx.payload.tags.filter((t): t is string => typeof t === "string") : undefined,
  });
  return { ok: true, result: created as unknown as Record<string, unknown> };
};

const partySupplierCreate: AutopilotExecutor = async (ctx) => {
  const name = str(ctx.payload.name);
  if (!name) return fail("invalid_payload");
  const created = await createParty(ctx.businessId, {
    role: "Supplier",
    personType: "Real",
    displayName: name,
    firstName: name,
    phone: str(ctx.payload.phone),
    email: str(ctx.payload.email),
    address: str(ctx.payload.address),
    notes: str(ctx.payload.notes),
  });
  return { ok: true, result: created as unknown as Record<string, unknown> };
};


// ── Issue #883 package 2, batch D — CRM notes/consent/segments/automations ───
// The CRM file, consent registry and rules engine are business-scoped facts,
// not per-branch views, so their executors never name a branch; a pinned
// consent is refused by the catalogue pin rule (resolveExecutorLocationName
// returns null for these keys — see executorTargetLocation's default branch).

const crmNoteDelete: AutopilotExecutor = async (ctx) => {
  const noteId = str(ctx.payload.noteId);
  if (!noteId) return fail("invalid_payload");
  const deleted = await deleteCustomerNote(ctx.businessId, noteId, str(ctx.payload.customerId) ?? undefined);
  if (!deleted) return fail("not_found");
  return { ok: true, result: { noteId, deleted: true } };
};

const crmNotePin: AutopilotExecutor = async (ctx) => {
  const noteId = str(ctx.payload.noteId);
  const pinned = ctx.payload.pinned;
  if (!noteId || typeof pinned !== "boolean") return fail("invalid_payload");
  const updated = await toggleNotePin(ctx.businessId, noteId, pinned, str(ctx.payload.customerId) ?? undefined);
  if (!updated) return fail("not_found");
  return { ok: true, result: { noteId, pinned } };
};

const crmConsentSet: AutopilotExecutor = async (ctx) => {
  const customerId = str(ctx.payload.customerId);
  const channel = str(ctx.payload.channel);
  const granted = ctx.payload.granted;
  if (!customerId || (channel !== "sms" && channel !== "email") || typeof granted !== "boolean") {
    return fail("invalid_payload");
  }
  const outcome = await setConsent(ctx.businessId, customerId, {
    channel: channel as ConsentChannel,
    granted,
    source: "staff",
    note: str(ctx.payload.note) ?? "MCP connection",
    changedBy: actorOf(ctx) ?? "mcp",
  });
  if (!outcome) return fail("customer_not_found");
  return { ok: true, result: { customerId, channel, granted, changed: outcome.changed } };
};

const crmSegmentCreate: AutopilotExecutor = async (ctx) => {
  const name = str(ctx.payload.name);
  const definition = ctx.payload.definition;
  if (!name || !definition || typeof definition !== "object" || Array.isArray(definition)) {
    return fail("invalid_payload");
  }
  try {
    const created = await createSegment(ctx.businessId, {
      name,
      description: str(ctx.payload.description) ?? undefined,
      definition: definition as SegmentDefinition,
    });
    return { ok: true, result: { id: created.id, name: created.name } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : "segment_invalid");
  }
};

const crmSegmentUpdate: AutopilotExecutor = async (ctx) => {
  const segmentId = str(ctx.payload.segmentId);
  if (!segmentId) return fail("invalid_payload");
  const definition = ctx.payload.definition;
  if (definition !== undefined && (!definition || typeof definition !== "object" || Array.isArray(definition))) {
    return fail("invalid_payload");
  }
  try {
    const updated = await updateSegment(ctx.businessId, segmentId, {
      name: str(ctx.payload.name) ?? undefined,
      description: str(ctx.payload.description) ?? undefined,
      definition: definition as SegmentDefinition | undefined,
    });
    if (!updated) return fail("not_found");
    return { ok: true, result: { id: updated.id, name: updated.name } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : "segment_invalid");
  }
};

const crmSegmentArchive: AutopilotExecutor = async (ctx) => {
  const segmentId = str(ctx.payload.segmentId);
  if (!segmentId) return fail("invalid_payload");
  const archived = await archiveSegment(ctx.businessId, segmentId);
  if (!archived) return fail("not_found");
  return { ok: true, result: { segmentId, archived: true } };
};

const crmAutomationToggle: AutopilotExecutor = async (ctx) => {
  const automationId = str(ctx.payload.automationId);
  const isActive = ctx.payload.isActive;
  if (!automationId || typeof isActive !== "boolean") return fail("invalid_payload");
  // The route's audit actor is the session user; the MCP executor answers with
  // the authorizing user's name when resolvable, else their id — the audit row
  // still carries the actor, exactly the trace the screen's PATCH writes.
  const { rows } = await query<{ full_name: string | null }>(
    `SELECT full_name FROM users WHERE id = $1`,
    [ctx.authorizedByUserId],
  );
  const actorName = rows[0]?.full_name ?? ctx.authorizedByUserId ?? "mcp";
  const toggled = await setAutomationActive(ctx.businessId, automationId, isActive, {
    name: actorName,
    userId: ctx.authorizedByUserId,
  });
  if (!toggled) return fail("not_found");
  return { ok: true, result: { automationId, isActive } };
};


// ── Issue #883 package 2, batch E — branch structure (locations.manage) ─────
// Branch create/lifecycle reshape the business itself; mirror the routes'
// etiquette — always_approve in the registry — and reuse the service's own
// validation + ceiling/override checks so the screens and the connectors see
// the same errors.

const branchCreate: AutopilotExecutor = async (ctx) => {
  const name = str(ctx.payload.name);
  if (!name) return fail("invalid_payload");
  try {
    const created = await createBranch({
      businessId: ctx.businessId,
      name,
      address: str(ctx.payload.address),
      phone: str(ctx.payload.phone),
      timezone: str(ctx.payload.timezone) ?? undefined,
      color: str(ctx.payload.color),
      copyMenuFromLocationId: str(ctx.payload.copyMenuFromLocationId),
      actorId: ctx.authorizedByUserId,
    });
    return { ok: true, result: { locationId: created.locationId } };
  } catch (err) {
    if (err instanceof BranchError) return fail(err.message);
    throw err;
  }
};

const branchUpdate: AutopilotExecutor = async (ctx) => {
  const locationId = str(ctx.payload.branchId);
  if (!locationId) return fail("invalid_payload");
  try {
    await updateBranch({
      businessId: ctx.businessId,
      locationId,
      actorId: ctx.authorizedByUserId,
      name: str(ctx.payload.name) ?? undefined,
      address: ctx.payload.address === undefined ? undefined : str(ctx.payload.address),
      phone: ctx.payload.phone === undefined ? undefined : str(ctx.payload.phone),
      timezone: str(ctx.payload.timezone) ?? undefined,
      color: str(ctx.payload.color) ?? undefined,
    });
    return { ok: true, result: { branchId: locationId, updated: true } };
  } catch (err) {
    if (err instanceof BranchError) return fail(err.message);
    throw err;
  }
};

const branchLifecycle: AutopilotExecutor = async (ctx) => {
  const locationId = str(ctx.payload.branchId);
  const action = str(ctx.payload.action);
  if (!locationId || (action !== "deactivate" && action !== "reactivate")) {
    return fail("invalid_payload");
  }
  try {
    if (action === "deactivate") {
      await deactivateBranch(ctx.businessId, locationId, ctx.authorizedByUserId);
    } else {
      await reactivateBranch(ctx.businessId, locationId, ctx.authorizedByUserId);
    }
    return { ok: true, result: { branchId: locationId, action } };
  } catch (err) {
    if (err instanceof BranchError) return fail(err.message);
    throw err;
  }
};


// ── Issue #883 package 2, batch F — growth: promotions + gift cards ──────────
const promotionUpsert: AutopilotExecutor = async (ctx) => {
  const name = str(ctx.payload.name);
  const kind = str(ctx.payload.kind);
  const value = typeof ctx.payload.value === "number" && Number.isFinite(ctx.payload.value) ? ctx.payload.value : null;
  if (!name || (kind !== "percent" && kind !== "amount" && kind !== "bundle_price" && kind !== "buy_x_get_y") || value === null) {
    return fail("invalid_payload");
  }
  try {
    const saved = await upsertPromotion(ctx.businessId, {
      id: str(ctx.payload.promotionId) ?? undefined,
      name,
      kind: kind as "percent" | "amount" | "bundle_price" | "buy_x_get_y",
      value,
      minQuantity: int(ctx.payload.minQuantity),
      itemIds: Array.isArray(ctx.payload.itemIds)
        ? (ctx.payload.itemIds as unknown[]).filter((x): x is string => typeof x === "string")
        : undefined,
      activeFrom: str(ctx.payload.activeFrom),
      activeTo: str(ctx.payload.activeTo),
      daysOfWeek: Array.isArray(ctx.payload.daysOfWeek)
        ? (ctx.payload.daysOfWeek as unknown[]).filter((x): x is number => typeof x === "number")
        : undefined,
      timeFrom: str(ctx.payload.timeFrom),
      timeTo: str(ctx.payload.timeTo),
      isActive: typeof ctx.payload.isActive === "boolean" ? ctx.payload.isActive : undefined,
    });
    return { ok: true, result: { id: saved.id } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : "promotion_invalid");
  }
};

const promotionToggle: AutopilotExecutor = async (ctx) => {
  const promotionId = str(ctx.payload.promotionId);
  const isActive = ctx.payload.isActive;
  if (!promotionId || typeof isActive !== "boolean") return fail("invalid_payload");
  const toggled = await setPromotionActive(ctx.businessId, promotionId, isActive);
  if (!toggled) return fail("not_found");
  return { ok: true, result: { promotionId, isActive } };
};

const giftCardIssue: AutopilotExecutor = async (ctx) => {
  const code = str(ctx.payload.code);
  const initialValue = typeof ctx.payload.initialValue === "number" && Number.isFinite(ctx.payload.initialValue)
    ? ctx.payload.initialValue
    : null;
  if (!code || initialValue === null || initialValue <= 0) return fail("invalid_payload");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  const { giftCardValidityMonths } = await getGrowthSettings(ctx.businessId);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const issued = await issueGiftCard(client, {
      validityMonths: giftCardValidityMonths,
      businessId: ctx.businessId,
      locationId: branch.locationId,
      code,
      initialValue,
      createdBy: ctx.authorizedByUserId,
    });
    await client.query("COMMIT");
    return { ok: true, result: { id: issued.card.id, code: issued.card.code } };
  } catch (err) {
    await client.query("ROLLBACK");
    return fail(err instanceof Error ? err.message : "gift_card_failed");
  } finally {
    client.release();
  }
};


// ── Issue #883 package 2, batch G — supplier returns (purchases.manage) ─────
const supplierReturnCreate: AutopilotExecutor = async (ctx) => {
  const purchaseId = str(ctx.payload.purchaseId);
  const settlementMethod = str(ctx.payload.settlementMethod);
  const reason = str(ctx.payload.reason);
  const idempotencyKey = str(ctx.payload.idempotencyKey);
  const lines = Array.isArray(ctx.payload.lines) ? (ctx.payload.lines as Record<string, unknown>[]) : [];
  if (!purchaseId || !reason || !idempotencyKey || lines.length === 0) return fail("invalid_payload");
  if (settlementMethod !== "accounts_payable" && settlementMethod !== "cash" && settlementMethod !== "bank" && settlementMethod !== "supplier_receivable") {
    return fail("invalid_payload");
  }
  const parsedLines = lines.map((line) => ({
    purchaseItemId: str(line.purchaseItemId) ?? "",
    inventoryLotId: str(line.inventoryLotId),
    quantity: positiveQuantityText(str(line.quantity) ?? "0"),
  }));
  if (parsedLines.some((line) => !line.purchaseItemId)) return fail("invalid_payload");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  // The route passes the session role as the sync actor; the connection's
  // authorizing user plays that part here.
  // The route's POST never runs without a session user; a write with no
  // authorizer is a server bug, not a client one — fail loudly like the rest.
  if (!ctx.authorizedByUserId) return fail("unauthenticated");
  const { rows } = await query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [ctx.authorizedByUserId]);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await createSupplierReturn(client, {
      businessId: ctx.businessId,
      locationId: branch.locationId,
      purchaseId,
      settlementMethod: settlementMethod as "accounts_payable" | "cash" | "bank" | "supplier_receivable",
      reason,
      idempotencyKey,
      createdBy: ctx.authorizedByUserId,
      sync: { actorRole: (rows[0]?.role ?? "Owner") as Role },
      lines: parsedLines,
    });
    await client.query("COMMIT");
    return { ok: true, result: result as unknown as Record<string, unknown> };
  } catch (err) {
    await client.query("ROLLBACK");
    return fail(err instanceof Error ? err.message : "supplier_return_failed");
  } finally {
    client.release();
  }
};


// ── Issue #883 package 2, batch H — workspace projects/tasks ────────────────
// The services key every authorization decision on `owner.access` — the same
// flags `workspaceOwner(PERMISSIONS.x)` builds from the session's effective
// permissions; the executors rebuild exactly those flags for the authorizing
// user, so a connection whose authorizer lacks workspace.manage cannot do
// anything the screens would refuse them either.

async function workspaceOwnerFor(ctx: AutopilotExecutorContext) {
  const { rows } = await query<{
    full_name: string | null;
    role: Role;
    permissions: unknown;
    is_active: boolean;
    custom_role_permissions: string[] | null;
  }>(
    `SELECT u.full_name, u.role, u.permissions, u.is_active, u.custom_role_id,
            (SELECT CASE WHEN tr.is_active THEN ARRAY(SELECT jsonb_array_elements_text(tr.permissions)) END
               FROM tenant_roles tr WHERE tr.id = u.custom_role_id) AS custom_role_permissions
       FROM users u WHERE u.id = $1 AND u.business_id = $2`,
    [ctx.authorizedByUserId, ctx.businessId],
  );
  const member = rows[0];
  // No row, or an account that's off: the screens answer "not a member of
  // this business" either way, and so do we.
  if (!member || !member.is_active) return null;
  const access = workspaceAccessFlags(
    effectivePermissions(member.role, parseOverrides(member.permissions), member.custom_role_permissions),
  );
  return {
    businessId: ctx.businessId,
    actorUserId: ctx.authorizedByUserId as string,
    actorName: member.full_name ?? "",
    access,
  };
}
const projectCreate: AutopilotExecutor = async (ctx) => {
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    const created = await createWorkspaceProject(owner, {
      name: str(ctx.payload.name) ?? undefined,
      description: str(ctx.payload.description) ?? undefined,
      status: str(ctx.payload.status) ?? undefined,
      priority: str(ctx.payload.priority) ?? undefined,
      startDate: str(ctx.payload.startDate),
      endDate: str(ctx.payload.endDate),
      tags: Array.isArray(ctx.payload.tags) ? ctx.payload.tags : undefined,
      ownerUserId: str(ctx.payload.ownerUserId) ?? undefined,
      partyId: str(ctx.payload.partyId) ?? undefined,
      budgetRial: ctx.payload.budgetRial,
      templateKey: str(ctx.payload.templateKey) ?? undefined,
    });
    return { ok: true, result: { id: created.id, name: created.name } };
  } catch (err) {
    if (err instanceof WorkspaceError) return fail(err.code);
    throw err;
  }
};

const projectUpdate: AutopilotExecutor = async (ctx) => {
  const projectId = str(ctx.payload.projectId);
  if (!projectId) return fail("invalid_payload");
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    const updated = await updateWorkspaceProject(owner, projectId, {
      name: str(ctx.payload.name) ?? undefined,
      description: str(ctx.payload.description) ?? undefined,
      status: str(ctx.payload.status) ?? undefined,
      priority: str(ctx.payload.priority) ?? undefined,
      startDate: str(ctx.payload.startDate),
      endDate: str(ctx.payload.endDate),
      tags: Array.isArray(ctx.payload.tags) ? ctx.payload.tags : undefined,
    });
    if (!updated) return fail("project_not_found");
    return { ok: true, result: { id: updated.id, name: updated.name } };
  } catch (err) {
    if (err instanceof WorkspaceError) return fail(err.code);
    throw err;
  }
};

const taskCreate: AutopilotExecutor = async (ctx) => {
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  const projectId = str(ctx.payload.projectId);
  if (!projectId || !str(ctx.payload.title)) return fail("invalid_payload");
  try {
    const created = await createWorkspaceTask(owner, projectId, {
      title: str(ctx.payload.title) ?? undefined,
      description: str(ctx.payload.description) ?? undefined,
      assigneeUserId: str(ctx.payload.assigneeUserId) ?? undefined,
      priority: str(ctx.payload.priority) ?? undefined,
      dueDate: str(ctx.payload.dueDate) ?? undefined,
      phaseId: str(ctx.payload.phaseId) ?? undefined,
    });
    return { ok: true, result: { id: created.id, projectId, title: created.title } };
  } catch (err) {
    if (err instanceof WorkspaceError) return fail(err.code);
    throw err;
  }
};

const taskUpdate: AutopilotExecutor = async (ctx) => {
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  const taskId = str(ctx.payload.taskId);
  if (!taskId) return fail("invalid_payload");
  try {
    const updated = await updateWorkspaceTask(owner, taskId, {
      title: str(ctx.payload.title) ?? undefined,
      description: str(ctx.payload.description) ?? undefined,
      assigneeUserId:
        ctx.payload.assigneeUserId === undefined ? undefined : str(ctx.payload.assigneeUserId),
      dueDate: ctx.payload.dueDate === undefined ? undefined : str(ctx.payload.dueDate),
      phaseId: ctx.payload.phaseId === undefined ? undefined : str(ctx.payload.phaseId),
      priority: str(ctx.payload.priority) ?? undefined,
    });
    if (!updated) return fail("task_not_found");
    return { ok: true, result: { id: updated.id } };
  } catch (err) {
    if (err instanceof WorkspaceError) return fail(err.code);
    throw err;
  }
};

const taskStatus: AutopilotExecutor = async (ctx) => {
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  const taskId = str(ctx.payload.taskId);
  const status = str(ctx.payload.status);
  if (!taskId || !status) return fail("invalid_payload");
  try {
    const updated = await updateWorkspaceTask(owner, taskId, { status });
    if (!updated) return fail("task_not_found");
    return { ok: true, result: { id: updated.id, status } };
  } catch (err) {
    if (err instanceof WorkspaceError) return fail(err.code);
    throw err;
  }
};


// ── Issue #883 package 2, batch D — production formulas ─────────────────────
// All callers here write through createFormula/updateFormula/... — the same
// functions the routes use, ProductionError.code surfaced as the failure code
// like the route maps it. The run itself is inventory.production.run, which
// already ships a reversible executor; it is deliberately not duplicated.
function failProduction(err: unknown): AutopilotExecutionResult {
  if (err instanceof ProductionError) return fail(err.code);
  if (err instanceof Error && err.message === "invalid_rial") return fail("invalid_conversion_cost");
  if (err instanceof Error && (err.message === "invalid_quantity" || err.message === "invalid_input"))
    return fail("invalid_quantity");
  throw err;
}

const productionFormulaCreate: AutopilotExecutor = async (ctx) => {
  const name = str(ctx.payload.name);
  const outputInventoryItemId = str(ctx.payload.outputInventoryItemId);
  const outputQuantityRaw = ctx.payload.outputQuantity;
  const conversionCostRaw = ctx.payload.conversionCostRial;
  if (!name || !outputInventoryItemId || outputQuantityRaw == null) return fail("invalid_payload");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  try {
    const created = await createFormula({
      businessId: ctx.businessId,
      locationId: branch.locationId,
      name,
      outputInventoryItemId,
      // Text values, not numbers: the form posts strings and so do we — the
      // validators reject anything non-canonical with the route's own codes.
      outputQuantity: positiveQuantityText(String(outputQuantityRaw)),
      conversionCostRial: rialText(conversionCostRaw == null ? "0" : String(conversionCostRaw)),
      notes: str(ctx.payload.notes),
      createdBy: ctx.authorizedByUserId,
    });
    return { ok: true, result: { id: created.id, name } };
  } catch (err) {
    return failProduction(err);
  }
};

async function formulaLocationOf(formulaId: string): Promise<string | null> {
  const { rows } = await query<{ location_id: string }>(`SELECT location_id FROM production_formulas WHERE id = $1`, [formulaId]);
  return rows[0]?.location_id ?? null;
}

const productionFormulaUpdate: AutopilotExecutor = async (ctx) => {
  const formulaId = str(ctx.payload.formulaId);
  if (!formulaId) return fail("invalid_payload");
  const locationId = await formulaLocationOf(formulaId);
  if (!locationId) return fail("not_found");
  try {
    await updateFormula({
      locationId,
      formulaId,
      name: str(ctx.payload.name) ?? undefined,
      outputQuantity:
        ctx.payload.outputQuantity == null ? undefined : positiveQuantityText(String(ctx.payload.outputQuantity)),
      conversionCostRial:
        ctx.payload.conversionCostRial == null ? undefined : rialText(String(ctx.payload.conversionCostRial)),
      notes: ctx.payload.notes === null ? null : str(ctx.payload.notes) ?? undefined,
      isActive: typeof ctx.payload.isActive === "boolean" ? ctx.payload.isActive : undefined,
    });
    return { ok: true, result: { formulaId, updated: true } };
  } catch (err) {
    return failProduction(err);
  }
};

const productionFormulaDeactivate: AutopilotExecutor = async (ctx) => {
  const formulaId = str(ctx.payload.formulaId);
  if (!formulaId) return fail("invalid_payload");
  const locationId = await formulaLocationOf(formulaId);
  if (!locationId) return fail("not_found");
  try {
    await deleteFormula(locationId, formulaId);
    return { ok: true, result: { formulaId, deactivated: true } };
  } catch (err) {
    return failProduction(err);
  }
};

const productionFormulaInputSet: AutopilotExecutor = async (ctx) => {
  const formulaId = str(ctx.payload.formulaId);
  const inventoryItemId = str(ctx.payload.inventoryItemId);
  const quantityRaw = ctx.payload.quantity;
  if (!formulaId || !inventoryItemId || quantityRaw == null) return fail("invalid_payload");
  const locationId = await formulaLocationOf(formulaId);
  if (!locationId) return fail("not_found");
  try {
    await setFormulaInput({
      locationId,
      formulaId,
      inventoryItemId,
      quantity: positiveQuantityText(String(quantityRaw)),
    });
    return { ok: true, result: { formulaId, inventoryItemId } };
  } catch (err) {
    return failProduction(err);
  }
};

const productionFormulaInputDelete: AutopilotExecutor = async (ctx) => {
  const formulaId = str(ctx.payload.formulaId);
  const inventoryItemId = str(ctx.payload.inventoryItemId);
  if (!formulaId || !inventoryItemId) return fail("invalid_payload");
  const locationId = await formulaLocationOf(formulaId);
  if (!locationId) return fail("not_found");
  try {
    await deleteFormulaInput({ locationId, formulaId, inventoryItemId });
    return { ok: true, result: { formulaId, inventoryItemId, deleted: true } };
  } catch (err) {
    return failProduction(err);
  }
};

// ── Issue #883 package 2, batch K1 — CRM sales workflow (leads/deals/pipelines)
// All three services take an explicit actor { name, userId } — the same member
// row the workspace executors resolved first supplies it here too.
async function crmActor(ctx: AutopilotExecutorContext) {
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return null;
  return {
    name: owner.actorName || ctx.authorizedByUserId || "mcp",
    userId: ctx.authorizedByUserId,
  };
}

const crmLeadSave: AutopilotExecutor = async (ctx) => {
  const name = str(ctx.payload.name);
  if (!name) return fail("name_required");
  const actor = await crmActor(ctx);
  if (!actor) return fail("no_authorizing_user");
  const saved = await saveLead(
    ctx.businessId,
    {
      id: str(ctx.payload.id) ?? undefined,
      name,
      organization: str(ctx.payload.organization) ?? undefined,
      phone: str(ctx.payload.phone),
      email: str(ctx.payload.email),
      source: str(ctx.payload.source) ?? undefined,
      sourceDetail: str(ctx.payload.sourceDetail) ?? undefined,
      status: (str(ctx.payload.status) ?? undefined) as Parameters<typeof saveLead>[1]["status"],
      rating: (str(ctx.payload.rating) ?? undefined) as Parameters<typeof saveLead>[1]["rating"],
      ownerUserId: str(ctx.payload.ownerUserId),
      ownerName: str(ctx.payload.ownerName) ?? undefined,
      notes: str(ctx.payload.notes) ?? undefined,
      nextAction: str(ctx.payload.nextAction) ?? undefined,
      nextActionAt: str(ctx.payload.nextActionAt),
      qualificationReason: str(ctx.payload.qualificationReason) ?? undefined,
      disqualificationReason: str(ctx.payload.disqualificationReason) ?? undefined,
      utm: ctx.payload.utm as Record<string, unknown> | undefined,
    },
    actor,
  );
  if (!saved) return fail("name_required");
  return { ok: true, result: slimLead(saved) };
};

function slimLead(lead: NonNullable<Awaited<ReturnType<typeof saveLead>>>) {
  return { id: lead.id, name: lead.name, status: lead.status, rating: lead.rating };
}

const crmLeadConvert: AutopilotExecutor = async (ctx) => {
  const leadId = str(ctx.payload.leadId);
  if (!leadId) return fail("invalid_payload");
  const actor = await crmActor(ctx);
  if (!actor) return fail("no_authorizing_user");
  const result = await convertLead(
    ctx.businessId,
    leadId,
    {
      partyId: str(ctx.payload.partyId) ?? undefined,
      createDeal: ctx.payload.createDeal === true,
      dealTitle: str(ctx.payload.dealTitle) ?? undefined,
      dealValueRial: int(ctx.payload.dealValueRial) ?? undefined,
      dealExpectedCloseDate: str(ctx.payload.dealExpectedCloseDate),
      acknowledgeDuplicates: ctx.payload.acknowledgeDuplicates === true,
    },
    actor,
  );
  if (!result.ok) {
    // duplicates_found carries the candidate list — the client must show it to
    // a person and only retry with acknowledgeDuplicates: true. That rule is
    // the service's, surfaced here untouched.
    return {
      ok: false,
      errorCode: result.error,
      result: { error: result.error, duplicates: (result as { duplicates?: unknown[] }).duplicates },
    };
  }
  return { ok: true, result: result.dealId ? { partyId: result.partyId, dealId: result.dealId } : { partyId: result.partyId } };
};

const crmDealSave: AutopilotExecutor = async (ctx) => {
  const title = str(ctx.payload.title);
  if (!title) return fail("title_required");
  const deal = await upsertDeal(ctx.businessId, {
    id: str(ctx.payload.id) ?? undefined,
    title,
    description: str(ctx.payload.description) ?? undefined,
    customerId: str(ctx.payload.customerId),
    stageId: str(ctx.payload.stageId),
    valueRial: int(ctx.payload.valueRial) ?? undefined,
    probability: ctx.payload.probability === null ? null : int(ctx.payload.probability),
    expectedCloseDate: str(ctx.payload.expectedCloseDate),
    ownerUser: str(ctx.payload.ownerUser) ?? undefined,
    ownerUserId: str(ctx.payload.ownerUserId),
    source: str(ctx.payload.source) ?? undefined,
    lostReason: str(ctx.payload.lostReason),
    orderId: str(ctx.payload.orderId),
    createdById: ctx.authorizedByUserId,
  });
  return { ok: true, result: { id: deal.id, title: deal.title } };
};

const crmDealMoveStage: AutopilotExecutor = async (ctx) => {
  const dealId = str(ctx.payload.dealId);
  const stageId = str(ctx.payload.stageId);
  if (!dealId || !stageId) return fail("invalid_payload");
  const actor = await crmActor(ctx);
  if (!actor) return fail("no_authorizing_user");
  const result: StageMoveResult = await moveDealToStage(ctx.businessId, dealId, stageId, actor, {
    note: str(ctx.payload.note) ?? undefined,
    lostReason: str(ctx.payload.lostReason) ?? undefined,
    wonReason: str(ctx.payload.wonReason) ?? undefined,
  });
  if (!result.ok) return fail(result.error ?? "move_failed");
  return { ok: true, result: { dealId, stageId, secondsInPreviousStage: result.secondsInPreviousStage ?? null } };
};

const crmPipelineCreate: AutopilotExecutor = async (ctx) => {
  const name = str(ctx.payload.name);
  if (!name) return fail("name_required");
  const actor = await crmActor(ctx);
  if (!actor) return fail("no_authorizing_user");
  const result = await createPipeline(
    ctx.businessId,
    {
      name,
      description: str(ctx.payload.description) ?? undefined,
      isDefault: ctx.payload.isDefault === true,
    },
    actor,
  );
  if (!result.ok) return fail(result.error ?? "create_failed");
  return { ok: true, result: result.pipeline ? { id: result.pipeline.id, name: result.pipeline.name } : { name } };
};

const crmPipelineUpdate: AutopilotExecutor = async (ctx) => {
  const pipelineId = str(ctx.payload.pipelineId);
  if (!pipelineId) return fail("invalid_payload");
  const actor = await crmActor(ctx);
  if (!actor) return fail("no_authorizing_user");
  const result = await updatePipeline(
    ctx.businessId,
    pipelineId,
    {
      name: str(ctx.payload.name) ?? undefined,
      description: str(ctx.payload.description) ?? undefined,
      isDefault: ctx.payload.isDefault,
      archived: ctx.payload.archived,
    } as Parameters<typeof updatePipeline>[2],
    actor,
  );
  if (!result.ok) return fail(result.error ?? "update_failed");
  return { ok: true, result: { pipelineId, updated: true } };
};

// ── Issue #883 package 2, batch L — transfers & warehouse documents ─────────
// The four transfer states ride the same client-transaction services as the
// routes' BEGIN/COMMIT blocks; the document posts through the service's own
// transaction wrapper, exactly like the route.
const transferCreate: AutopilotExecutor = async (ctx) => {
  const destinationLocationId = str(ctx.payload.destinationLocationId);
  const idempotencyKey = str(ctx.payload.idempotencyKey);
  const rawLines = ctx.payload.lines;
  if (!destinationLocationId || !idempotencyKey || !Array.isArray(rawLines) || rawLines.length === 0) {
    return fail("invalid_payload");
  }
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  if (!ctx.authorizedByUserId) return fail("no_authorizing_user");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const lines = rawLines.map((raw) => {
      const line = raw as Record<string, unknown>;
      return {
        sourceInventoryItemId: str(line.sourceInventoryItemId) ?? "",
        destinationInventoryItemId: str(line.destinationInventoryItemId) ?? "",
        quantity: positiveQuantityText(String(line.quantity ?? "")),
      };
    });
    const result = await createInventoryTransfer(client, {
      businessId: ctx.businessId,
      sourceLocationId: branch.locationId,
      destinationLocationId,
      note: str(ctx.payload.note),
      idempotencyKey,
      createdBy: ctx.authorizedByUserId,
      lines,
    });
    await client.query("COMMIT");
    return { ok: true, result: { id: result.id, duplicate: result.duplicate } };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    const code = err instanceof Error ? err.message : "transfer_failed";
    return fail(code);
  } finally {
    client.release();
  }
};

type TransferLifecycle = (client: import("pg").PoolClient, params: {
  businessId: string;
  transferId: string;
  actorId: string;
}) => Promise<{ eventId: string | null; value: unknown }>;

function transferLifecycle(fn: TransferLifecycle): AutopilotExecutor {
  return async (ctx) => {
    const transferId = str(ctx.payload.transferId);
    if (!transferId) return fail("invalid_payload");
    if (!ctx.authorizedByUserId) return fail("no_authorizing_user");
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client, {
        businessId: ctx.businessId,
        transferId,
        actorId: ctx.authorizedByUserId,
      });
      await client.query("COMMIT");
      return { ok: true, result: { transferId, eventId: result.eventId, value: result.value } };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      const code = err instanceof Error ? err.message : "transfer_failed";
      return fail(code);
    } finally {
      client.release();
    }
  };
}

const transferShip: AutopilotExecutor = transferLifecycle((client, params) => shipInventoryTransfer(client, params));
const transferReceive: AutopilotExecutor = transferLifecycle((client, params) => receiveInventoryTransfer(client, params));
const transferCancel: AutopilotExecutor = transferLifecycle((client, params) => cancelInventoryTransfer(client, params));

const warehouseDocumentCreate: AutopilotExecutor = async (ctx) => {
  const kind = str(ctx.payload.kind);
  if (!kind || !isWarehouseDocumentKind(kind)) return fail("invalid_kind");
  const rawLines = ctx.payload.lines;
  if (!Array.isArray(rawLines) || rawLines.length === 0) return fail("no_items");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  let parsed;
  try {
    parsed = parseWarehouseDocumentLines(
      kind,
      rawLines as Array<{ inventoryItemId?: string; quantity?: string; unitCost?: string | number }>,
    );
  } catch (err) {
    return fail(err instanceof Error ? err.message : "bad_request");
  }
  try {
    const created = await createWarehouseDocument({
      businessId: ctx.businessId,
      locationId: branch.locationId,
      kind: parsed.kind,
      supplierId: str(ctx.payload.supplierId),
      recipient: str(ctx.payload.recipient),
      documentNumber: str(ctx.payload.documentNumber),
      note: str(ctx.payload.note),
      createdBy: ctx.authorizedByUserId,
      lines: parsed.lines,
    });
    return { ok: true, result: { id: created.id, totalValue: created.totalValue, kind } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : "warehouse_document_failed");
  }
};

// ── Issue #883 package 2, batch K3 — CRM service desk (cases & activities) ──
const crmCaseSave: AutopilotExecutor = async (ctx) => {
  const subject = str(ctx.payload.subject);
  if (!subject) return fail("subject_required");
  const saved = await upsertCase(ctx.businessId, {
    id: str(ctx.payload.id) ?? undefined,
    subject,
    body: str(ctx.payload.body) ?? undefined,
    customerId: (ctx.payload.customerId as string | null | undefined) ?? undefined,
    status: (str(ctx.payload.status) ?? undefined) as Parameters<typeof upsertCase>[1]["status"],
    priority: (str(ctx.payload.priority) ?? undefined) as Parameters<typeof upsertCase>[1]["priority"],
    category: str(ctx.payload.category) ?? undefined,
    orderId: (ctx.payload.orderId as string | null | undefined) ?? undefined,
    assigneeUserId: (ctx.payload.assigneeUserId as string | null | undefined) ?? undefined,
    assignedTo: str(ctx.payload.assignedTo) ?? undefined,
    resolution: str(ctx.payload.resolution) ?? undefined,
  });
  return { ok: true, result: { id: saved.id, subject: saved.subject } };
};

const crmCaseSetStatus: AutopilotExecutor = async (ctx) => {
  const caseId = str(ctx.payload.caseId);
  const status = str(ctx.payload.status);
  if (!caseId || !status) return fail("invalid_payload");
  const actor = await crmActor(ctx);
  if (!actor) return fail("no_authorizing_user");
  const result = await setCaseStatus(ctx.businessId, caseId, status, actor, {
    comment: str(ctx.payload.comment) ?? undefined,
    isInternal: ctx.payload.isInternal === true,
  });
  if (!result.ok) return fail(result.error ?? "status_failed");
  return { ok: true, result: { caseId, status } };
};

const crmActivityCreate: AutopilotExecutor = async (ctx) => {
  const kind = str(ctx.payload.kind);
  const subject = str(ctx.payload.subject);
  if (!kind || !subject) return fail("invalid_payload");
  const actor = await crmActor(ctx);
  if (!actor) return fail("no_authorizing_user");
  const created = await createActivity(ctx.businessId, {
    kind: kind as Parameters<typeof createActivity>[1]["kind"],
    subject,
    body: str(ctx.payload.body) ?? undefined,
    dueAt: (ctx.payload.dueAt as string | null | undefined) ?? undefined,
    customerId: (ctx.payload.customerId as string | null | undefined) ?? undefined,
    dealId: (ctx.payload.dealId as string | null | undefined) ?? undefined,
    caseId: (ctx.payload.caseId as string | null | undefined) ?? undefined,
    assigneeUserId: (ctx.payload.assigneeUserId as string | null | undefined) ?? undefined,
    assignedTo: str(ctx.payload.assignedTo) ?? undefined,
    createdBy: `${actor.name} · MCP`,
    completed: ctx.payload.completed === true,
  });
  return { ok: true, result: { id: created.id, subject: created.subject } };
};

const crmActivityUpdate: AutopilotExecutor = async (ctx) => {
  const activityId = str(ctx.payload.activityId);
  if (!activityId) return fail("invalid_payload");
  const updated = await updateActivity(ctx.businessId, activityId, {
    kind: (str(ctx.payload.kind) ?? undefined) as Parameters<typeof updateActivity>[2]["kind"],
    subject: str(ctx.payload.subject) ?? undefined,
    body: str(ctx.payload.body) ?? undefined,
    dueAt: (ctx.payload.dueAt as string | null | undefined) ?? undefined,
    assigneeUserId: (ctx.payload.assigneeUserId as string | null | undefined) ?? undefined,
    assignedTo: str(ctx.payload.assignedTo) ?? undefined,
    customerId: (ctx.payload.customerId as string | null | undefined) ?? undefined,
    completed: typeof ctx.payload.completed === "boolean" ? ctx.payload.completed : undefined,
  });
  if (!updated) return fail("not_found");
  return { ok: true, result: { activityId, updated: true } };
};

// ── Issue #883 package 2, batch J — saved reports ────────────────────────────
const reportSavedCreate: AutopilotExecutor = async (ctx) => {
  const name = str(ctx.payload.name);
  const config = ctx.payload.config;
  if (!name || !config || typeof config !== "object" || Array.isArray(config)) {
    return fail("invalid_payload");
  }
  // Same gate as POST /api/reports/saved: the builder's own validation, no
  // SQL-shaped anything — the view/metric/dimension whitelist lives there.
  const problems = validateReportConfig(config as ReportConfig);
  if (problems.length > 0) return fail(problems.join(" "));
  const id = await createSavedReport(ctx.businessId, ctx.authorizedByUserId, name, config as ReportConfig);
  return { ok: true, result: { id, name } };
};

const reportSavedUpdate: AutopilotExecutor = async (ctx) => {
  const savedReportId = str(ctx.payload.savedReportId);
  if (!savedReportId) return fail("invalid_payload");
  const name = str(ctx.payload.name);
  const config = ctx.payload.config;
  const patch: { name?: string; config?: ReportConfig } = {};
  if (name) patch.name = name;
  if (config !== undefined) {
    if (!config || typeof config !== "object" || Array.isArray(config)) return fail("invalid_payload");
    const problems = validateReportConfig(config as ReportConfig);
    if (problems.length > 0) return fail(problems.join(" "));
    patch.config = config as ReportConfig;
  }
  const updated = await updateSavedReport(ctx.businessId, savedReportId, patch);
  if (!updated) return fail("not_found");
  return { ok: true, result: { savedReportId, updated: true } };
};

const reportSavedDelete: AutopilotExecutor = async (ctx) => {
  const savedReportId = str(ctx.payload.savedReportId);
  if (!savedReportId) return fail("invalid_payload");
  const deleted = await deleteSavedReport(ctx.businessId, savedReportId);
  if (!deleted) return fail("not_found");
  return { ok: true, result: { savedReportId, deleted: true } };
};

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
  // ── Accounting writes (issue #883 package 2, batch A) ──────────────────────
  accountCreate,
  accountUpdate,
  accountDisable,
  journalDraftApprove,
  journalDraftReject,
  expenseReverse,
  arReceiptRecord,
  apPaymentRecord,
  apPaymentReverse,
  chequeCreate,
  chequeTransition,
  installmentPlanCreate,
  installmentItemPay,
  reconciliationCreate,
  reconciliationComplete,
  payrollRunAccrue,
  payrollRunPay,
  payrollRunVoid,
  payrollAdvanceRecord,
  payrollAdvanceVoid,
  fixedAssetCreate,
  fixedAssetDepreciate,
  fixedAssetDispose,
  orderCreate,
  shiftStart,
  shiftEnd,
  shiftClose,
  menuCategoryCreate,
  menuCategoryUpdate,
  menuItemCreate,
  menuItemUpdate,
  barcodeAssign,
  partyCustomerCreate,
  partySupplierCreate,
  promotionUpsert,
  promotionToggle,
  giftCardIssue,
  supplierReturnCreate,
  projectCreate,
  projectUpdate,
  taskCreate,
  taskUpdate,
  taskStatus,
  productionFormulaCreate,
  productionFormulaUpdate,
  productionFormulaDeactivate,
  productionFormulaInputSet,
  productionFormulaInputDelete,
  transferCreate,
  transferShip,
  transferReceive,
  transferCancel,
  warehouseDocumentCreate,
  crmCaseSave,
  crmCaseSetStatus,
  crmActivityCreate,
  crmActivityUpdate,
  crmLeadSave,
  crmLeadConvert,
  crmDealSave,
  crmDealMoveStage,
  crmPipelineCreate,
  crmPipelineUpdate,
  reportSavedCreate,
  reportSavedUpdate,
  reportSavedDelete,
  branchCreate,
  branchUpdate,
  branchLifecycle,
  crmNoteDelete,
  crmNotePin,
  crmConsentSet,
  crmSegmentCreate,
  crmSegmentUpdate,
  crmSegmentArchive,
  crmAutomationToggle,
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

  // The revert writes history too (source `ai`): it IS a real price change
  // back to the previous value, and history rows are never rewritten.
  const updated = await updateMenuItem(locationId, menuItemId, patch, ctx.businessId, {
    changedBy: ctx.authorizedByUserId,
    source: "ai",
    sourceRef: "revert",
  });
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
  expense: revertExpense,
};
