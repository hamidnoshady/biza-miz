/**
 * GH #1567 F7 — mandatory human approval for AI-initiated financial and stock
 * writes, in every business type (owner decision 2026-11-25).
 *
 * The rule, in one place:
 *
 *   An AI-initiated write that sells, refunds, takes or makes a payment,
 *   posts to the ledger, moves stock, or commits a purchase NEVER runs until
 *   a human has approved that exact request. MCP `apply` mode, an enabled
 *   autopilot category, an `auto_apply` automation and a coworker job are
 *   all AI initiation: none of them substitutes for the human.
 *
 * Exempt: reads (never reach a write path), drafts that a human still has
 * to post through their own reviewed step, and master data / configuration
 * with no ledger or stock effect. Every exemption of a verb that carries a
 * financial or stock permission is listed below WITH its reason, and
 * `ai-approval-policy.test.ts` fails when a new verb carrying such a
 * permission is neither classified nor exempted — a new AI tool cannot
 * silently land on the "applies immediately" side.
 *
 * Human flows are untouched: POS screens, purchase screens and the
 * deterministic Woo/Eshobe ingestion never go through an AI executor.
 *
 * This module is pure (no DB). The DB half — recording an approval bound to
 * payload, actor, tenant and expiry, and consuming it exactly once at the
 * executor boundary — is `ai-human-approval.ts`.
 */
import { mcpWriteRegistryEntry } from "./mcp/registry";

export const AI_APPROVAL_CLASSES = ["sale", "refund", "payment", "posting", "stock", "purchase"] as const;
export type AiApprovalClass = (typeof AI_APPROVAL_CLASSES)[number];

/**
 * F7 classification of verbs that previously followed the connection's
 * write mode (or ran unattended) although they move money or stock. Each is
 * also `always_approve` / `high` in the MCP registry (asserted by the test),
 * so MCP descriptors, the verb inventory and the coverage matrix all tell
 * the client the truth.
 */
export const AI_HUMAN_APPROVAL_ACTIONS: Readonly<Record<string, AiApprovalClass>> = {
  // Sales — revenue + COGS + stock relief in one transaction, or an order
  // whose total a discount changes.
  "order.create": "sale",
  "order.discount.apply": "sale",
  "accessories.item.sell": "sale",
  "fashion_apparel.item.sell": "sale",
  "haberdashery.item.sell": "sale",
  "tools_fittings.item.sell": "sale",
  "wholesale.item.sell": "sale",
  // Stock — quantity or carrying value moves.
  "accessories.stock.update": "stock",
  "cosmetics.stock.update": "stock",
  "cosmetics.batch.receive": "stock",
  "cosmetics.tester.open": "stock",
  "fashion_apparel.stock.update": "stock",
  "haberdashery.stock.update": "stock",
  "tools_fittings.stock.update": "stock",
  "wholesale.stock.update": "stock",
  "inventory.adjustment.propose": "stock",
  "inventory.count.edit": "stock",
  "inventory.waste.log": "stock",
  "jewelry.item.create": "stock",
  "jewelry.item.update": "stock",
  "jewelry.item.consign": "stock",
  // Purchases — the order is committed to (or withdrawn from) a supplier.
  "purchase.lifecycle": "purchase",
  // Payments — money instruments and settlement schedules.
  "cheque.create": "payment",
  "installment.plan.create": "payment",
  "shift.close": "payment",
  // Postings — the books or a booking period change.
  "businessDay.close": "posting",
  "businessDay.reopen": "posting",
  "fixed-asset.create": "posting",
  "fixed-asset.set_acquisition": "posting",
};

export type AiApprovalExemptReason =
  | "draft"
  | "master_data"
  | "no_ledger_effect"
  | "configuration"
  | "integration_retry"
  | "attendance";

/**
 * Verbs that carry a financial/stock permission but are deliberately NOT
 * gated, each with why. A draft here is one a human must still post through
 * a reviewed step (and that step, when AI-initiated, is itself gated).
 */
export const AI_APPROVAL_EXEMPT: Readonly<Record<string, { reason: AiApprovalExemptReason; note: string }>> = {
  "inventory.reorder.draftPO": { reason: "draft", note: "draft purchase order; ordering and receiving are gated" },
  "purchase.update": { reason: "draft", note: "rewrites a draft purchase only; receive/lifecycle are gated" },
  "transfer.create": { reason: "draft", note: "transfer draft; ship/receive/cancel are always_approve" },
  "journal.manual.propose": { reason: "draft", note: "journal draft; posting needs ledger.approve on the draft queue" },
  "journal.draft.reject": { reason: "draft", note: "rejecting a draft posts nothing" },
  "supplier.update": { reason: "master_data", note: "supplier card" },
  "supplier.archive": { reason: "master_data", note: "supplier card" },
  "inventory.item.save": { reason: "master_data", note: "item master; no quantity or value" },
  "inventory.item.delete": { reason: "master_data", note: "referenced items deactivate instead" },
  "accessories.item.create": { reason: "master_data", note: "catalogue only since F2 (no stock)" },
  "cosmetics.item.create": { reason: "master_data", note: "catalogue only since F2 (no stock)" },
  "cosmetics.matrix.create": { reason: "master_data", note: "variant family, no stock" },
  "cosmetics.brand.create": { reason: "master_data", note: "brand list" },
  "cosmetics.profile.update": { reason: "master_data", note: "item profile" },
  "fashion_apparel.item.create": { reason: "master_data", note: "catalogue only since F2 (no stock)" },
  "haberdashery.item.create": { reason: "master_data", note: "catalogue only since F2 (no stock)" },
  "tools_fittings.item.create": { reason: "master_data", note: "catalogue only since F2 (no stock)" },
  "wholesale.item.create": { reason: "master_data", note: "catalogue only since F2 (no stock)" },
  "jewelry.consignor.create": { reason: "master_data", note: "consignor card" },
  "jewelry.stone.add": { reason: "master_data", note: "stone description on an item" },
  "barcode.assign": { reason: "master_data", note: "barcode label" },
  "barcode.bulkMint": { reason: "master_data", note: "barcode labels" },
  "priceList.create": { reason: "master_data", note: "price list; a sale is gated separately" },
  "priceList.delete": { reason: "master_data", note: "price list" },
  "priceList.entries.save": { reason: "master_data", note: "price list" },
  "priceList.rename": { reason: "master_data", note: "price list" },
  "product.attribute.create": { reason: "master_data", note: "attribute definitions" },
  "product.attribute.update": { reason: "master_data", note: "attribute definitions" },
  "production.formula.create": { reason: "master_data", note: "BOM; production runs are always_approve" },
  "production.formula.update": { reason: "master_data", note: "BOM" },
  "production.formula.deactivate": { reason: "master_data", note: "BOM" },
  "production.formulaInput.set": { reason: "master_data", note: "BOM" },
  "production.formulaInput.delete": { reason: "master_data", note: "BOM" },
  "account.create": { reason: "master_data", note: "chart of accounts; nothing posts" },
  "account.update": { reason: "master_data", note: "chart of accounts" },
  "account.disable": { reason: "master_data", note: "chart of accounts" },
  "account.delete": { reason: "master_data", note: "only unused accounts delete" },
  "settings.accounts.save": { reason: "configuration", note: "posting-account mapping" },
  "reconciliation.create": { reason: "no_ledger_effect", note: "opens a bank reconciliation worksheet" },
  "reconciliation.line.clear": { reason: "no_ledger_effect", note: "ticks worksheet lines; posts nothing" },
  "shift.start": { reason: "attendance", note: "staff attendance clock" },
  "shift.end": { reason: "attendance", note: "staff attendance clock" },
};

/**
 * Permissions that mark a verb as touching money, the books or stock. A verb
 * carrying one must be gated (classified or registry `always_approve`) or
 * explicitly exempted above.
 */
export const AI_APPROVAL_FINANCIAL_PERMISSIONS: ReadonlySet<string> = new Set([
  "orders.create",
  "orders.discount",
  "orders.amend_closed",
  "payments.refund",
  "inventory.adjust",
  "purchases.manage",
  "ledger.approve",
  "ledger.propose",
  "ledger.close_period",
  "accounts.edit",
  "finance.assets_manage",
  "finance.cheques_manage",
  "finance.installments_manage",
  "finance.reconciliation_manage",
  "finance.expenses_manage",
  "finance.receivables_manage",
  "finance.payables_manage",
  "store_credit.issue",
  "store_credit.payout",
  "gift_cards.issue",
  "gift_cards.redeem",
  "loyalty.redeem",
  "payroll.manage",
  "shifts.manage",
  "shifts.self",
]);

/** True when an AI-initiated `actionType` must wait for a human. */
export function requiresHumanApproval(actionType: string): boolean {
  if (Object.prototype.hasOwnProperty.call(AI_HUMAN_APPROVAL_ACTIONS, actionType)) return true;
  return mcpWriteRegistryEntry(actionType)?.approval === "always_approve";
}

/** The class recorded on the audit row (`posting` for registry step-ups). */
export function aiApprovalClass(actionType: string): AiApprovalClass | null {
  if (Object.prototype.hasOwnProperty.call(AI_HUMAN_APPROVAL_ACTIONS, actionType)) {
    return AI_HUMAN_APPROVAL_ACTIONS[actionType];
  }
  return requiresHumanApproval(actionType) ? "posting" : null;
}

/** A queued proposal must be decided within this window, or it lapses. */
export const AI_APPROVAL_TTL_HOURS = 72;
/** An approval must be spent by the executor within this window. */
export const AI_APPROVAL_EXECUTION_WINDOW_SECONDS = 600;

