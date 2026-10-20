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
import { createStockCount, editStockCount, reverseStockCount } from "./stock-count-service";
import { saveMessageTemplate, pauseMessageCampaign, resumeMessageCampaign, launchMessageCampaign } from "./message-campaigns-service";
import { redeemGiftCard, expireGiftCards } from "./promotions-service";
import { redeemPoints, issueStoreCredit, useStoreCredit as payOutStoreCredit, storeCreditBalance, upsertProgram } from "./loyalty-service";
import { openSession, releaseSessionWithoutOrders, mergeTableIntoSession, setSessionGuests } from "./table-session-service";
import { broadcast } from "./realtime";
import { getBackupConfig, setBackupConfig, runBackupNow, restoreAvailable, restoreFromArtifact } from "./backup-service";
import { chargeForFeature } from "./billing-guard";
import { DeviceError, renameDevice, revokeDevice, listDevices, findActiveDeviceId } from "./device-service";
import { updateAttributeDefinition, deleteAttributeDefinition } from "./product-attributes-service";
import { parseAttributeDefinitionInput } from "./product-attributes";
import { deleteWeightBarcodeTemplate } from "./weight-barcode-templates-service";
import { requestApproval, decideApproval, approvalSubjectType } from "./workspace";
import { decideEstimateApproval } from "./aec-boq-service";
import { decideCertificateApproval, decideVariationApproval } from "./aec-commercial-service";
import { decideCommitmentApproval, decideMaterialRequestApproval } from "./aec-procurement-service";
import { decideSubmittalApproval } from "./aec-rfi-service";
// Batch BJ — the extracted money lanes of /api/orders/[id]/{amend,returns}.
import { amendClosedOrder, OrderAmendmentError } from "./order-amendment-service";
import { validateAmendment, type AmendmentInput } from "./order-amendments";
import { createCustomerReturn } from "./customer-return-service";
import { appendSyncOutboxEvent } from "./sync-outbox";
import { recordNotification } from "./notification-events";
import { notificationDedupeKey } from "./notifications";
import { tomanText } from "./ai-labels";
// Batch BH — the AEC registers (src/app/api/aec/**). Each generic verb
// dispatches the entity lane with the exact route capability gate.
import {
  AecError,
  addProjectParticipant,
  removeProjectParticipant,
  saveBusinessAecProfile,
  saveProjectAecProfile,
  updateProjectParticipant,
} from "./aec-service";
import {
  addSubmittalRevision,
  applyRfiAction,
  closeSubmittalRevision,
  createRfi,
  createSubmittal,
  decideSubmittalRevision,
  deleteRfi,
  deleteSubmittal,
  deleteSubmittalRevision,
  rfiProjectId,
  startSubmittalReview,
  submittalProjectId,
  submittalRevisionProjectId,
  submitSubmittalRevision,
  updateRfi,
  updateSubmittal,
  updateSubmittalRevision,
} from "./aec-rfi-service";
import {
  applySiteIssueAction,
  applySiteLogAction,
  createChecklist,
  createSiteIssue,
  createSiteLog,
  deleteChecklist,
  deleteSiteIssue,
  deleteSiteLog,
  siteIssueProjectId,
  siteLogProjectId,
  updateChecklist,
  updateSiteIssue,
  updateSiteLog,
} from "./aec-site-service";
import { isSiteIssueAction, siteIssueActionNeedsApproval } from "./aec-site";
import { isSubmittalDecision } from "./aec-rfi";
import {
  approveEstimateVersion,
  createEstimate,
  createEstimateVersion,
  deleteEstimate,
  estimateProjectId,
  returnEstimateVersion,
  saveDraftVersion,
  startEstimateReview,
  submitEstimateVersion,
  updateEstimate,
  versionContextProjectId,
} from "./aec-boq-service";
import {
  applyCertificateAction,
  applyVariationAction,
  certificateProjectId,
  contractProjectId,
  createCertificate,
  createVariation,
  deleteCertificate,
  deleteVariation,
  saveContractCommercial,
  updateCertificate,
  updateVariation,
  variationProjectId,
} from "./aec-commercial-service";
import {
  isCertificateAction,
  isVariationAction,
  certificateActionNeedsApproval,
  variationActionNeedsApproval,
} from "./aec-commercial";
import {
  addRevision,
  acknowledgeTransmittal,
  createDrawing,
  createTransmittal,
  deleteDrawing,
  deleteRevision,
  deleteTransmittal,
  drawingProjectId,
  issueTransmittal,
  revisionProjectId,
  transmittalProjectId,
  updateDrawing,
  updateRevision,
  updateTransmittal,
} from "./aec-doc-service";
import {
  applyCommitmentAction,
  applyMaterialRequestAction,
  applyQuotationAction,
  applyRfqAction,
  commitmentProjectId,
  createCommitment,
  createMaterialRequest,
  createRfq,
  deleteCommitment,
  deleteMaterialRequest,
  deleteQuotation,
  deleteRfq,
  quotationProjectId,
  recordDelivery,
  recordQuotation,
  requestProjectId,
  rfqProjectId,
  updateCommitment,
  updateMaterialRequest,
  updateQuotation,
  updateRfq,
} from "./aec-procurement-service";
import {
  isCommitmentAction,
  isMaterialRequestAction,
  isQuotationAction,
  isRfqAction,
  commitmentActionNeedsApproval,
  materialRequestActionNeedsApproval,
  quotationActionNeedsApproval,
  rfqActionNeedsApproval,
} from "./aec-procurement";
import { createItem, createVariantChild, getItem, setWeightAttributes, getWeightAttributes, addStone, removeStone } from "./items-service";
import { validateVariantAttributes, type VariantAttributeInput } from "./items";
import { createBrand, updateItemProfile, type ItemProfileInput } from "./item-brands-service";
import {
  receiveBatch as receiveCosmeticBatch,
  openTester as openCosmeticTester,
  createVariantMatrix as createCosmeticMatrix,
  receiveStock as receiveCosmeticStock,
  setUnitPrice as setCosmeticUnitPrice,
} from "./cosmetics-service";
import {
  sellAccessoryUnits,
  receiveStock as receiveAccessoryStock,
  setUnitPrice as setAccessoryUnitPrice,
  setInitialUnitCost,
  type ItemStock,
} from "./accessories-service";
import type { MatrixAxis } from "./variant-matrix";
import type { SettlementMethod } from "./ledger";
import {
  sellTradeGoodsUnits,
  receiveTradeGoodsStock,
  setTradeGoodsUnitPrice,
} from "./trade-goods-service";
import type { TradeGoodsIndustry } from "./trade-goods";
import { findEntity } from "./data-transfer/registry";
import type { EntityDefinition, ExportFormat } from "./data-transfer/types";
import {
  listScheduledExports,
  createScheduledExport,
  updateScheduledExport,
  deleteScheduledExport,
  runScheduledExport,
  ScheduleError,
  type SaveScheduleInput,
} from "./data-transfer/schedule-service";
import {
  getExportTemplate,
  createExportTemplate,
  updateExportTemplate,
  deleteExportTemplate,
  getMappingTemplate,
  createMappingTemplate,
  updateMappingTemplate,
  deleteMappingTemplate,
  TemplateError,
} from "./data-transfer/templates-service";
import { getExportJob, ExportError } from "./data-transfer/export-service";
import { getImportJob, queueImportJob, retryFailedRows, ImportError } from "./data-transfer/import-service";
import { memberAccessFor, type MemberAccess } from "./member-access";
import { PERMISSIONS } from "./permissions";
import type { SessionPayload } from "./auth";
import { validateWeightAttributes } from "./gold";
import { markAsConsigned, createConsignor, payConsignor } from "./consignment-service";
import { recordItemEvent } from "./item-audit-service";
import { sellWeightedItem } from "./gold-sales-service";
import { buyBackGold, openLayaway, payLayaway, completeLayaway } from "./jewelry-flagship-service";
import { isPurity } from "./gold";
import { recordGoldPrice, getGoldPrice } from "./gold-prices-service";
import { mintMissingBarcodes } from "./inventory-item-barcodes-service";
import { resolveSectionId, validWaiterId } from "./floor";
import { canTransitionTable, type TableStatus } from "./table-sessions";
import { canKitchenBump, canMarkServed, type OrderItemStatus } from "./order-item-status";
import { recordCoworkerEvent } from "./ai-coworker-events";
import { recordOrderStateStandalone } from "./order-state-sync";
import { createNrvWriteDown, reverseNrvWriteDown } from "./nrv-service";
import {
  createAutomation,
  updateAutomation,
  deleteAutomation,
  getAutomation,
  runAutomationNow,
} from "./ai-automations-service";
import {
  createCoworkerJob,
  updateCoworkerJob,
  deleteCoworkerJob,
  runCoworkerJobNow,
} from "./ai-coworker-service";
import { coworkerErrorMessage } from "./ai-coworker";
import { validateMemoryInput, createMemoryEntry, deleteMemoryEntry, type MemoryScope } from "./ai-memory";
import { setSetting } from "./settings";
import { normalizeBranchName } from "./branch-input";
import {
  DEFAULT_COST_DRIFT_THRESHOLD_PERCENT,
  MAX_COST_DRIFT_THRESHOLD_PERCENT,
  MAX_OVERHEAD_PERCENT,
  getEffectiveOverheadRate,
  getPricingConfig,
  setPricingConfig,
  type PricingConfig,
} from "./pricing-service";
import { getMfaPolicy, setMfaPolicy } from "./mfa-policy";
import { setOnlinePlatformsConfig } from "./online-platforms-service";
import { MAX_ONLINE_PLATFORM_COMMISSION_PERCENT, validCommissionPercent } from "./online-platforms";
import { validateAccounts, nextAccountLevel, type AccountLevel } from "./coa-template";
import {
  validatePaymentMethodInput,
  MAX_PAYMENT_METHOD_NAME,
  CUSTOM_PAYMENT_SETTLEMENTS,
  isPaymentSettlement,
  type PaymentMethodInput,
} from "./payment-methods";
import {
  createPaymentMethod,
  listPaymentMethods,
  reorderPaymentMethods,
  paymentMethodsByIds,
  updatePaymentMethod,
  paymentCountForMethod,
  deletePaymentMethod,
  type PaymentMethodPatch,
} from "./payment-methods-service";
import { parsePrinterInput, type ExistingPrinter } from "./printing/printer-input";
import { PRINTER_COLUMNS } from "./printing/printer-columns";
import { connectionJsonOf } from "./printing/types";
import {
  createPrintTemplate,
  updatePrintTemplate,
  deletePrintTemplate,
  getPrintTemplate,
} from "./print-templates-service";
import { builtInTemplate } from "./print-template";
import { loadRoutablePrinters } from "./printing/plan";
import { isDocType, printerAcceptsDocument } from "./printing/routing";
import {
  testConnection,
  wooClientFor,
} from "./integrations/connections-service";
import { testHolooConnection } from "./integrations/holoo/connection-service";
import { isHoloo } from "./integrations/provider-registry";
import {
  syncProducts,
  syncOrders,
  syncCustomers,
} from "./integrations/sync-service";
import { enqueuePluginExport } from "./integrations/plugin-service";
import { enqueueContentExport, syncWpContentRest } from "./integrations/wp-content-service";
import { enqueueExport } from "./integrations/woo-ops-service";
import { drainOutbox, refreshOutboxForConnection } from "./integrations/outbox-service";
import { writeIntegrationAudit } from "./integrations/audit";
import { pluginSupportsJobType } from "./integrations/plugin-capabilities";
import { upsertWpContent, type WpContentPayload } from "./integrations/wp-content-service";
import { parseWpMediaCreateInput } from "./integrations/wp-media";
import { saveWebsiteSetup, type WebsiteSetupPatch } from "./website/setup-service";
import { saveOwnerThemeSettings } from "./cms/owner-bridge";
import { cmsPurgeCdn } from "./cms/website-service";
import {
  createCmsProduct,
  updateCmsProduct,
  deleteCmsProduct,
  deleteCmsPost,
  updateCmsMediaAlt,
  deleteCmsMedia,
} from "./cms/website-service";
import {
  decryptReservationPhones,
  encryptReservationPhone,
  lockTableForReservationWrite,
  parseDate as parseReservationDate,
  tableConflicts,
} from "./reservation-service";
import { preparePurchaseLines, purchaseDateOrNull, PurchaseLineError } from "./purchase-lines";
import {
  supplierInvoiceOrError,
  SUPPLIER_INVOICE_DUE_DATE_SQL,
} from "./purchase-service";
import {
  receivePurchaseInTransaction,
  PURCHASE_SETTLEMENT_METHODS,
  type PurchaseSettlementMethod,
} from "./purchase-receive-service";
import {
  getBusinessDayStatus,
  closeBusinessDay,
  reopenBusinessDay,
  setBusinessDayStart,
  BusinessDayError,
} from "./business-day-service";
import { isValidStartMinutes, parseStartTime } from "./business-day";
import { upsertCommissionRule, setCommissionRuleActive, type CommissionRuleInput } from "./commission-service";
import {
  createCourier,
  setCourierActive,
  assignCourier,
  transitionDelivery,
} from "./delivery-service";
import { isDeliveryStatus } from "./delivery";
import { runRollupPush, setRollupLocationActive } from "./rollup-service";
import { createDraftPurchase, cancelDraftPurchase, PurchaseServiceError } from "./purchase-service";
import { applyOrderDiscount, normalizeDiscountInput } from "./order-discount-service";
import type { OrderActor } from "./order-control-service";
import type { Role as OrderControlRole } from "./auth";
import { MissingLedgerAccountError, recordExpense, reverseExpense, ExpenseError } from "./expense-service";
import { MIN_REASON_LENGTH, MAX_REASON_LENGTH } from "./order-amendments";
import { voidRetailInvoice, RetailInvoiceVoidError } from "./retail-invoice-void-service";
import { updateCmsOrderStatus } from "./cms/website-service";
import { listConnections, getConnection } from "./integrations/connections-service";
import { retryWpQueueRow, retryAllFailedWpQueue, flushWpOutbox } from "./integrations/wp-manager-service";
import { updateCmsSiteDomain } from "./cms/website-service";
import { createAttributeDefinition } from "./product-attributes-service";

import {
  createMediaCollection,
  renameMediaCollection,
  deleteMediaCollection,
  addAssetToCollection,
  removeAssetFromCollection,
  softDeleteMediaAsset,
  restoreMediaAsset,
} from "./media-service";
import { createWeightBarcodeTemplate } from "./weight-barcode-templates-service";
import { resolveBranchRef } from "./branch-service";
import { parseExpenseSettlement, PayablesInputError, type ExpenseSettlementInput } from "./payables-input";
import { parseExpenseAmount, parseExpenseVatAmount } from "./expense-input";
import { createDraft, deleteDraft, ManualJournalError, reverseEntry, MANUAL_MEMO_MAX } from "./manual-journal-service";

import { updateCustomer } from "./parties-service";
import { partyWriteAudienceForActor } from "./member-access";
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
import { AccountsError, createAccount, updateAccount, deleteAccount } from "./accounts-service";
import { savePayrollSettings, setStaffPayTerms, type StaffPayTermsPatch } from "./payroll-service";
import { PAY_TERMS } from "./payroll-types";
import { fiscalPeriodLockErrorCode } from "./fiscal-periods";


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
  setLineCleared,
  setLinesCleared,
  type ReconcilableAccount,
} from "./reconciliation-service";
import {
  accruePayroll,
  payPayroll,
  voidPayrollRun,
} from "./payroll-service";
import { PayrollError } from "./payroll-errors";
import { parseLineClearanceRequest } from "./bank-reconciliation";
import { createFiscalYear, setPeriodStatus, FiscalPeriodError } from "./fiscal-periods-service";
import { closeFiscalYear } from "./closing-service";

import { isUuid } from "./uuid";
import { recordAdvance, voidAdvance } from "./payroll-advances-service";
import { createOrder } from "./order-mutations";
import type { CartItemInput } from "./order-cart";
import { ShiftError, openShift, closeOwnShift, closeShiftById } from "./shift-service";
import { randomUUID } from "crypto";
import { createCategory, updateCategory, createMenuItem, updateMenuItem } from "./menu-service";
import { assignBarcode } from "./inventory-item-barcodes-service";
import { createCustomer, createParty, getCustomer } from "./parties-service";
import { getSetting, SETTING_KEYS } from "./settings";
import { toggleNotePin, deleteDeal, deleteCase } from "./crm-service";
import { createBranch, updateBranch, deactivateBranch, reactivateBranch, BranchError } from "./branch-service";
import { upsertPromotion, setPromotionActive, issueGiftCard } from "./promotions-service";
import { createSupplierReturn } from "./supplier-return-service";
import { createSavedReport, deleteSavedReport, updateSavedReport } from "./reports-service";
import { listPipelines, createPipeline, updatePipeline, moveDealToStage, type StageMoveResult } from "./crm-pipeline-service";
import { saveLead } from "./crm-lead-service";
import { upsertDeal, upsertCase, createActivity, updateActivity } from "./crm-service";
import { setCaseStatus } from "./crm-case-service";
import {
  createInventoryTransfer,
  shipInventoryTransfer,
  receiveInventoryTransfer,
  cancelInventoryTransfer,
} from "./transfer-service";
import { createWarehouseDocument, parseWarehouseDocumentLines, isWarehouseDocumentKind } from "./warehouse-document-service";
import { listCalendar, createEvent, updateEvent, deleteEvent, addComment, createDocument, updateDocument, deleteDocument, saveTemplate, archiveTemplate } from "./workspace";
import {
  createPriceList,
  renamePriceList,
  deletePriceList,
  savePriceEntries,
  quickUpdatePrices,
  validateQuickUpdateScope,

  type QuickUpdateScope,
  type QuickUpdateTarget,
} from "./price-lists-service";
import { validateReportConfig, type ReportConfig } from "./reports";
import {
  createWorkspaceProject,
  updateWorkspaceProject,
  createWorkspaceTask,
  updateWorkspaceTask,
  requireProjectCapability,
  setMember,
  removeMember,
  addPhase,
  applyTemplate,
  listTemplates,
  listPhases,
  getWorkspaceProject,
  createContract,
  getContract,
  updateContract,
  deleteContract,
  transitionContract,
  resolveWorkspaceSubject,
  WorkspaceError,
  type ContractInput,
} from "./workspace";
import { workspaceAccessFlags } from "./workspace-shared";
import { effectivePermissions, parseOverrides } from "./permissions";
import type { Role } from "./auth-edge";
import { getGrowthSettings } from "./growth-settings-service";
import { createSegment, updateSegment, archiveSegment } from "./crm-segments-service";
import { setAutomationActive } from "./crm-automation-service";
import {
  saveCustomField,
  archiveCustomField,
  CUSTOM_FIELD_TARGETS,
  type CustomFieldTarget,
  type CustomFieldType,
} from "./crm-custom-fields-service";
import type { SegmentDefinition } from "./segments";
import type { TaxSetting } from "./setup-state";
import { resolveActiveLocation } from "./setup-state";
import {
  createFixedAsset,
  disposeFixedAsset,
  FixedAssetError,
  postDepreciation,
  setFixedAssetAcquisition,
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

async function orderActorForAutopilot(ctx: { businessId: string; authorizedByUserId: string | null }): Promise<(OrderActor & { userId: string }) | null> {
  if (!ctx.authorizedByUserId) return null;
  const { rows } = await query<{ role: OrderControlRole }>(
    `SELECT role FROM users WHERE id=$1 AND business_id=$2`,
    [ctx.authorizedByUserId, ctx.businessId],
  );
  const role = rows[0]?.role;
  if (!role) return null;
  return { userId: ctx.authorizedByUserId, role, businessId: ctx.businessId };
}

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

  const actor = await orderActorForAutopilot(ctx);
  if (!actor) return fail("no_authorizing_user");
  const applied = await applyOrderDiscount({ locationId, orderId, discount, actor });
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

  const { rows: before } = await query<{ notes: string | null; name: string; roles: string[] }>(
    `SELECT notes, name, roles FROM parties WHERE id = $1 AND business_id = $2`,
    [customerId, ctx.businessId],
  );
  if (!before[0]) return fail("not_found");

  /*
   * Issue #947 (item 2) — an automation writes as the member who switched it on
   * (`authorizedByUserId`, «every write is theirs»), so it is held to that member's
   * audience exactly as their browser session is. `notes` is one of the fields
   * `team.view` withholds on a *staff* file, and the failing mode here is silent: the
   * service would keep the stored note and report success, leaving an automation that
   * believes it wrote something and a person who never sees it. So the refusal is
   * explicit, with a code the run's history shows.
   */
  const audience = await partyWriteAudienceForActor(ctx.businessId, ctx.authorizedByUserId);
  if (
    before[0].roles?.includes("employee") &&
    audience &&
    !audience.personnel
  ) {
    return fail("staff_file_requires_team_access");
  }

  const updated = await updateCustomer(ctx.businessId, customerId, { notes }, {
    actorId: ctx.authorizedByUserId,
    ...(audience ? { audience } : {}),
  });
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
  const method = ctx.payload.method === "bank" || ctx.payload.method === "clearing" ? ctx.payload.method : "cash";
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
      idempotencyKey: str(ctx.payload.idempotencyKey) ?? crypto.randomUUID(),
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
  try {
    const cheque = await transitionCheque({
      businessId: ctx.businessId,
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

// ── Issue #883 package 2, batch AR — CRM custom fields close crm.config ───
/** The audit actor of the CRM routes — the authorizing user's name, else id (the batch-D convention). */
async function crmAuditActor(ctx: AutopilotExecutorContext): Promise<{ name: string; userId: string | null }> {
  const { rows } = await query<{ full_name: string | null }>(
    `SELECT full_name FROM users WHERE id = $1`,
    [ctx.authorizedByUserId],
  );
  return { name: rows[0]?.full_name ?? ctx.authorizedByUserId ?? "mcp", userId: ctx.authorizedByUserId };
}
const crmCustomFieldSave: AutopilotExecutor = async (ctx) => {
  const target = str(ctx.payload.target);
  if (!target || !(CUSTOM_FIELD_TARGETS as readonly string[]).includes(target)) {
    return fail("custom_field_target_invalid");
  }
  const actor = await crmAuditActor(ctx);
  const result = await saveCustomField(
    ctx.businessId,
    {
      id: str(ctx.payload.id) ?? undefined,
      target: target as CustomFieldTarget,
      key: str(ctx.payload.key) ?? undefined,
      label: str(ctx.payload.label) ?? "",
      fieldType: (str(ctx.payload.fieldType) ?? "text") as CustomFieldType,
      options: Array.isArray(ctx.payload.options)
        ? ctx.payload.options.filter((o): o is string => typeof o === "string")
        : undefined,
      isRequired: typeof ctx.payload.isRequired === "boolean" ? ctx.payload.isRequired : undefined,
      helpText: str(ctx.payload.helpText) ?? undefined,
      displayOrder: typeof ctx.payload.displayOrder === "number" ? ctx.payload.displayOrder : undefined,
    },
    actor,
  );
  if (!result.ok) return { ok: false, result: { error: result.error }, errorCode: result.error };
  return { ok: true, result: { field: result.field } };
};
const crmCustomFieldArchive: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const actor = await crmAuditActor(ctx);
  const archived = await archiveCustomField(ctx.businessId, id, actor);
  if (!archived) return fail("custom_field_not_found");
  return { ok: true, result: { result: "archived" } };
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

// ── Issue #883 package 2, batch N2b — workspace documents & templates ───────
const workspaceDocumentInput = (ctx: AutopilotExecutorContext) => ({
  title: str(ctx.payload.title) ?? undefined,
  description: str(ctx.payload.description) ?? undefined,
  mediaAssetId: (ctx.payload.mediaAssetId as string | null | undefined) ?? undefined,
  projectId: (ctx.payload.projectId as string | null | undefined) ?? undefined,
  taskId: (ctx.payload.taskId as string | null | undefined) ?? undefined,
  contractId: (ctx.payload.contractId as string | null | undefined) ?? undefined,
  partyId: (ctx.payload.partyId as string | null | undefined) ?? undefined,
  journalEntryId: (ctx.payload.journalEntryId as string | null | undefined) ?? undefined,
  status: (str(ctx.payload.status) ?? undefined) as string | undefined,
  tags: Array.isArray(ctx.payload.tags) ? ctx.payload.tags : undefined,
});

const workspaceDocumentCreate: AutopilotExecutor = async (ctx) => {
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    const doc = await createDocument(owner, {
      ...workspaceDocumentInput(ctx),
      supersedesId: (ctx.payload.supersedesId as string | null | undefined) ?? undefined,
    });
    return { ok: true, result: { id: doc.id, title: doc.title, version: doc.version } };
  } catch (err) {
    return failWorkspace(err);
  }
};

const workspaceDocumentUpdate: AutopilotExecutor = async (ctx) => {
  const documentId = str(ctx.payload.documentId);
  if (!documentId) return fail("invalid_payload");
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    const doc = await updateDocument(owner, documentId, workspaceDocumentInput(ctx));
    if (!doc) return fail("document_not_found");
    return { ok: true, result: { id: doc.id, title: doc.title, version: doc.version } };
  } catch (err) {
    return failWorkspace(err);
  }
};

const workspaceDocumentDelete: AutopilotExecutor = async (ctx) => {
  const documentId = str(ctx.payload.documentId);
  if (!documentId) return fail("invalid_payload");
  const deleted = await deleteDocument(ctx.businessId, documentId);
  if (!deleted) return fail("document_not_found");
  return { ok: true, result: { documentId, deleted: true } };
};

const workspaceTemplateSave: AutopilotExecutor = async (ctx) => {
  const name = str(ctx.payload.name);
  if (!name) return fail("invalid_payload");
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    const templates = await saveTemplate(owner, {
      key: str(ctx.payload.key) ?? undefined,
      name,
      description: str(ctx.payload.description) ?? undefined,
      projectType: (ctx.payload.projectType as string | null | undefined) ?? undefined,
      phases: ctx.payload.phases,
      defaultTasks: ctx.payload.defaultTasks,
    });
    const saved = templates.find((t) => t.key === (str(ctx.payload.key) ?? undefined)) ?? templates[templates.length - 1];
    return { ok: true, result: { key: saved?.key, name: saved?.name, count: templates.length } };
  } catch (err) {
    return failWorkspace(err);
  }
};

const workspaceTemplateArchive: AutopilotExecutor = async (ctx) => {
  const templateKey = str(ctx.payload.templateKey);
  if (!templateKey) return fail("invalid_payload");
  await archiveTemplate(ctx.businessId, templateKey);
  return { ok: true, result: { templateKey, archived: true } };
};

// ── Issue #883 package 2, batch N2a — workspace calendar & comments ─────────
// These services throw WorkspaceError (code, like the guard's map), beside
// boolean returns. The owner is the batch-H member row: the routes build the
// very same shape from the session.
function failWorkspace(err: unknown): AutopilotExecutionResult {
  if (err instanceof WorkspaceError) return fail(err.code);
  throw err;
}

const workspaceEventCreate: AutopilotExecutor = async (ctx) => {
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    const entries = await createEvent(owner, {
      title: str(ctx.payload.title) ?? undefined,
      description: str(ctx.payload.description) ?? undefined,
      kind: (str(ctx.payload.kind) ?? undefined) as Parameters<typeof createEvent>[1]["kind"],
      eventDate: ctx.payload.eventDate as string,
      startTime: (ctx.payload.startTime as string | null | undefined) ?? undefined,
      endTime: (ctx.payload.endTime as string | null | undefined) ?? undefined,
      location: str(ctx.payload.location) ?? undefined,
      projectId: (ctx.payload.projectId as string | null | undefined) ?? undefined,
      taskId: (ctx.payload.taskId as string | null | undefined) ?? undefined,
    });
    const created = entries[entries.length - 1];
    return { ok: true, result: { id: created?.id, title: created?.title } };
  } catch (err) {
    return failWorkspace(err);
  }
};

const workspaceEventUpdate: AutopilotExecutor = async (ctx) => {
  const eventId = str(ctx.payload.eventId);
  if (!eventId) return fail("invalid_payload");
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    const updated = await updateEvent(owner, eventId, {
      title: str(ctx.payload.title) ?? undefined,
      description: str(ctx.payload.description) ?? undefined,
      kind: (str(ctx.payload.kind) ?? undefined) as Parameters<typeof updateEvent>[2]["kind"],
      eventDate: typeof ctx.payload.eventDate === "string" ? ctx.payload.eventDate : undefined,
      startTime: (ctx.payload.startTime as string | null | undefined) ?? undefined,
      endTime: (ctx.payload.endTime as string | null | undefined) ?? undefined,
      location: str(ctx.payload.location) ?? undefined,
      projectId: (ctx.payload.projectId as string | null | undefined) ?? undefined,
    });
    if (!updated) return fail("event_not_found");
    return { ok: true, result: { eventId, updated: true } };
  } catch (err) {
    return failWorkspace(err);
  }
};

const workspaceEventDelete: AutopilotExecutor = async (ctx) => {
  const eventId = str(ctx.payload.eventId);
  if (!eventId) return fail("invalid_payload");
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    const deleted = await deleteEvent(owner, eventId);
    if (!deleted) return fail("event_not_found");
    return { ok: true, result: { eventId, deleted: true } };
  } catch (err) {
    return failWorkspace(err);
  }
};

const workspaceCommentAdd: AutopilotExecutor = async (ctx) => {
  const subjectType = str(ctx.payload.subjectType);
  const subjectId = str(ctx.payload.subjectId);
  const body = str(ctx.payload.body);
  if (!subjectType || !subjectId || !body) return fail("invalid_payload");
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    const comments = await addComment(
      owner,
      subjectType as Parameters<typeof addComment>[1],
      subjectId,
      body,
    );
    const last = comments[comments.length - 1];
    return { ok: true, result: { id: (last as { id?: string } | undefined)?.id, subjectType, subjectId } };
  } catch (err) {
    return failWorkspace(err);
  }
};

// ── Issue #883 package 2, batch M — price lists & entries ───────────────────
// Services answer {list?, error?}/boolean/number — the routes' own branching,
// so executors fail() with the identical code rather than translating.
const priceListCreate: AutopilotExecutor = async (ctx) => {
  const name = str(ctx.payload.name);
  if (!name) return fail("invalid_payload");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  const result = await createPriceList({
    locationId: branch.locationId,
    name,
    currency: str(ctx.payload.currency) ?? undefined,
  });
  if (result.error) return fail(result.error);
  return { ok: true, result: { priceListId: result.list?.id, name: result.list?.name } };
};

const priceListRename: AutopilotExecutor = async (ctx) => {
  const priceListId = str(ctx.payload.priceListId);
  const name = str(ctx.payload.name);
  if (!priceListId || !name) return fail("invalid_payload");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  const result = await renamePriceList(priceListId, name, branch.locationId);
  if (result.error) return fail(result.error);
  return { ok: true, result: { priceListId, name: result.list?.name } };
};

const priceListDelete: AutopilotExecutor = async (ctx) => {
  const priceListId = str(ctx.payload.priceListId);
  if (!priceListId) return fail("invalid_payload");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  const deleted = await deletePriceList(priceListId, branch.locationId);
  if (!deleted) return fail("not_found");
  return { ok: true, result: { priceListId, deleted: true } };
};

const priceListQuickUpdate: AutopilotExecutor = async (ctx) => {
  const target = ctx.payload.target as QuickUpdateTarget | undefined;
  const mode = str(ctx.payload.mode);
  const value = ctx.payload.value;
  if (!target || typeof target !== "object" || (mode !== "percent" && mode !== "amount")) return fail("invalid_payload");
  if (typeof value !== "number" || !Number.isFinite(value)) return fail("invalid_value");
  if (target.kind === "list" && !str(target.priceListId)) return fail("invalid_target");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  // F03: an AI caller must name its scope. `itemIds: []` (or no ids at all) is
  // not "every item" — only `scope: { kind: "all" }` is, and it is explicit.
  const requestedScope = ctx.payload.scope;
  let scope: QuickUpdateScope;
  if (requestedScope !== undefined) {
    const parsed = validateQuickUpdateScope(requestedScope);
    if (!parsed.ok) return fail(parsed.error);
    scope = parsed.scope;
  } else if (Array.isArray(ctx.payload.itemIds) && ctx.payload.itemIds.length > 0) {
    const parsed = validateQuickUpdateScope({ kind: "selected", itemIds: ctx.payload.itemIds });
    if (!parsed.ok) return fail(parsed.error);
    scope = parsed.scope;
  } else {
    return fail("missing_scope");
  }
  const itemIds = scope.kind === "selected" ? scope.itemIds ?? [] : [];
  const outcome = await quickUpdatePrices({
    target,
    mode,
    value,
    round: ctx.payload.round === true,
    itemIds,
    scope,
    locationId: branch.locationId,
    businessId: ctx.businessId,
    actorId: ctx.authorizedByUserId,
    source: "ai",
  });
  return { ok: true, result: { moved: outcome.changed, skipped: outcome.skipped } };
};

/** The one connected woo shop a write names (explicit id, or the single one). */
async function resolveWpOwnerConnection(
  businessId: string,
  explicitId: string | null,
): Promise<{ id: string } | { error: string }> {
  if (explicitId) {
    const conn = await getConnection(businessId, explicitId);
    if (!conn || conn.provider !== "woocommerce") return { error: "not_found" };
    return { id: conn.id };
  }
  const connections = (await listConnections(businessId)).filter((c) => c.provider === "woocommerce");
  if (connections.length === 0) return { error: "not_connected" };
  if (connections.length > 1) return { error: "connection_required" };
  return { id: connections[0].id };
}


// ── Issue #883 package 2, batch AM — consignor directory close-out ──────
// Mirrors POST /api/jewelry/consignors 1:1: name required (service trims and
// rejects empties), phone/notes optional-null, envelope { ok, consignor }.
const jewelryConsignorCreate: AutopilotExecutor = async (ctx) => {
  const name = str(ctx.payload.name);
  if (!name) return fail("missing_fields");
  try {
    const consignor = await createConsignor(ctx.businessId, {
      name,
      phone: str(ctx.payload.phone) ?? null,
      notes: str(ctx.payload.notes) ?? null,
    });
    return { ok: true, result: { ok: true, consignor } };
  } catch (err) {
    return { ok: false, result: { error: "validation_failed", message: (err as Error).message }, errorCode: "validation_failed" };
  }
};

// ── Issue #883 package 2, batch AN — cosmetics & accessories lanes ───────
// Same discipline as AL1/AL2: every executor mirrors its route 1:1 — the
// same validation order, the same client transaction where the route has
// one, the same error envelope, the same item-audit events.
async function verticalLocation(ctx: AutopilotExecutorContext): Promise<{ locationId: string } | AutopilotExecutionResult> {
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("no_location");
  return { locationId: branch.locationId };
}
function variantAttributesFrom(payload: unknown): VariantAttributeInput[] | null {
  if (payload == null) return [];
  if (!Array.isArray(payload)) return null;
  const attrs: VariantAttributeInput[] = [];
  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null) return null;
    const name = (entry as Record<string, unknown>).name;
    const value = (entry as Record<string, unknown>).value;
    if (typeof name !== "string" || typeof value !== "string") return null;
    attrs.push({ name, value });
  }
  return attrs;
}
/** Shared by cosmetics.item.create and accessories.item.create — the two routes are byte-identical in contract. */
async function createVariantItem(ctx: AutopilotExecutorContext): Promise<AutopilotExecutionResult> {
  const name = str(ctx.payload.name);
  if (!name) return fail("missing_fields");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const sku = str(ctx.payload.sku) ?? null;
  const parentItemId = str(ctx.payload.parentItemId);
  if (!parentItemId) {
    const item = await createItem({ locationId: branch.locationId, name, sku, kind: "variant_parent" });
    return { ok: true, result: { ok: true, item } };
  }
  const parent = await getItem(parentItemId);
  if (!parent || parent.locationId !== branch.locationId || parent.kind !== "variant_parent") {
    return fail("item_not_found");
  }
  const attributes = variantAttributesFrom(ctx.payload.attributes);
  if (!attributes) return { ok: false, result: { error: "bad_request" }, errorCode: "bad_request" };
  const attributeErrors = validateVariantAttributes(attributes);
  if (attributeErrors.length > 0) {
    return { ok: false, result: { error: "invalid_attributes", message: attributeErrors.join("؛ ") }, errorCode: "invalid_attributes" };
  }
  const item = await createVariantChild(parent.id, branch.locationId, name, sku, attributes);
  return { ok: true, result: { ok: true, item } };
}
const cosmeticsBrandCreate: AutopilotExecutor = async (ctx) => {
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  try {
    const brand = await createBrand(branch.locationId, {
      name: str(ctx.payload.name) ?? "",
      country: str(ctx.payload.country),
      productLine: str(ctx.payload.productLine),
    });
    return { ok: true, result: { ok: true, brand } };
  } catch (err) {
    return { ok: false, result: { error: "validation_failed", message: (err as Error).message }, errorCode: "validation_failed" };
  }
};
const cosmeticsItemCreate: AutopilotExecutor = async (ctx) => createVariantItem(ctx);
const cosmeticsBatchReceive: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id) ?? str(ctx.payload.itemId);
  if (!id) return fail("missing_fields");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const item = await getItem(id);
  if (!item || item.locationId !== branch.locationId) return fail("item_not_found");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const batch = await receiveCosmeticBatch(client, {
      itemId: id,
      batchNumber: str(ctx.payload.batchNumber) ?? "",
      expiryDate: str(ctx.payload.expiryDate),
      quantity: str(ctx.payload.quantity) ?? "0",
      unitCost: Number(ctx.payload.unitCost ?? 0),
      supplierReference: str(ctx.payload.supplierReference),
    });
    // The route records the audit event on the pool (not the tx client) —
    // mirrored deliberately so behaviour matches byte-for-byte.
    await recordItemEvent({
      businessId: ctx.businessId,
      locationId: item.locationId,
      itemId: id,
      eventType: "item.batch_received",
      payload: {
        batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate,
        quantity: batch.quantity,
        unitCost: batch.unitCost,
      },
      createdBy: ctx.authorizedByUserId,
    });
    await client.query("COMMIT");
    return { ok: true, result: { ok: true, batch } };
  } catch (err) {
    await client.query("ROLLBACK");
    return { ok: false, result: { error: "validation_failed", message: (err as Error).message }, errorCode: "validation_failed" };
  } finally {
    client.release();
  }
};
/** Shared by cosmetics.stock.update and accessories.stock.update — same shape, only the accessory lane adds the opening-cost branch. */
const stockUpdateExecutor = (opts: {
  receive: (itemId: string, input: { quantity: string; unitCost: number }) => Promise<ItemStock>;
  setPrice: (itemId: string, unitPrice: number) => Promise<unknown>;
  withInitialCost?: boolean;
}): AutopilotExecutor => async (ctx) => {
  const id = str(ctx.payload.id) ?? str(ctx.payload.itemId);
  if (!id) return fail("missing_fields");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const item = await getItem(id);
  if (!item || item.locationId !== branch.locationId) return fail("item_not_found");
  try {
    const hasUnitPrice = ctx.payload.unitPrice != null;
    const hasQuantity = ctx.payload.quantity != null;
    if (hasUnitPrice) {
      await opts.setPrice(id, Number(ctx.payload.unitPrice));
      await recordItemEvent({
        businessId: ctx.businessId,
        locationId: item.locationId,
        itemId: id,
        eventType: "item.price_changed",
        payload: { unitPrice: Number(ctx.payload.unitPrice) },
        createdBy: ctx.authorizedByUserId,
      });
    }
    const stock = hasQuantity
      ? await opts.receive(id, { quantity: String(ctx.payload.quantity), unitCost: Number(ctx.payload.unitCost ?? 0) })
      : null;
    if (opts.withInitialCost && !hasQuantity && ctx.payload.unitCost != null) {
      await setInitialUnitCost(id, Number(ctx.payload.unitCost));
    }
    if (stock) {
      await recordItemEvent({
        businessId: ctx.businessId,
        locationId: item.locationId,
        itemId: id,
        eventType: "item.stock_received",
        payload: {
          quantity: String(ctx.payload.quantity),
          unitCost: Number(ctx.payload.unitCost ?? 0),
          quantityOnHand: stock.quantity,
          averageUnitCost: stock.unitCost,
        },
        createdBy: ctx.authorizedByUserId,
      });
    }
    return { ok: true, result: { ok: true, stock } };
  } catch (err) {
    return { ok: false, result: { error: "validation_failed", message: (err as Error).message }, errorCode: "validation_failed" };
  }
};
const cosmeticsStockUpdate = stockUpdateExecutor({ receive: receiveCosmeticStock, setPrice: setCosmeticUnitPrice });
const accessoriesStockUpdate = stockUpdateExecutor({
  receive: receiveAccessoryStock,
  setPrice: setAccessoryUnitPrice,
  withInitialCost: true,
});
const cosmeticsTesterOpen: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id) ?? str(ctx.payload.itemId);
  if (!id) return fail("missing_fields");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const item = await getItem(id);
  if (!item || item.locationId !== branch.locationId) return fail("item_not_found");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await openCosmeticTester(client, {
      businessId: ctx.businessId,
      locationId: item.locationId,
      itemId: id,
      createdBy: ctx.authorizedByUserId,
    });
    await client.query("COMMIT");
    return { ok: true, result: { ok: true, ...(result as object) } };
  } catch (err) {
    await client.query("ROLLBACK");
    return { ok: false, result: { error: "tester_failed", message: (err as Error).message }, errorCode: "tester_failed" };
  } finally {
    client.release();
  }
};
const cosmeticsProfileUpdate: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id) ?? str(ctx.payload.itemId);
  if (!id) return fail("missing_fields");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const item = await getItem(id);
  if (!item || item.locationId !== branch.locationId) return fail("item_not_found");
  const tags = Array.isArray(ctx.payload.tags) ? ctx.payload.tags.filter((t): t is string => typeof t === "string") : [];
  const profile: ItemProfileInput = {
    brandId: str(ctx.payload.brandId),
    ircCode: str(ctx.payload.ircCode),
    healthPermit: str(ctx.payload.healthPermit),
    authenticityRegistration: str(ctx.payload.authenticityRegistration),
    tags,
  };
  try {
    await updateItemProfile(id, profile);
    await recordItemEvent({
      businessId: ctx.businessId,
      locationId: item.locationId,
      itemId: id,
      eventType: "item.profile_changed",
      payload: {
        brandId: profile.brandId ?? null,
        ircCode: profile.ircCode ?? null,
        healthPermit: profile.healthPermit ?? null,
        authenticityRegistration: profile.authenticityRegistration ?? null,
        tags,
      },
      createdBy: ctx.authorizedByUserId,
    });
    return { ok: true, result: { ok: true } };
  } catch (err) {
    return { ok: false, result: { error: "validation_failed", message: (err as Error).message }, errorCode: "validation_failed" };
  }
};
const cosmeticsMatrixCreate: AutopilotExecutor = async (ctx) => {
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const axisOf = (raw: unknown): MatrixAxis => {
    const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    return {
      name: typeof o.name === "string" ? o.name : "",
      values: Array.isArray(o.values) ? o.values.filter((v): v is string => typeof v === "string") : [],
    };
  };
  try {
    const result = await createCosmeticMatrix({
      locationId: branch.locationId,
      parentName: str(ctx.payload.parentName) ?? "",
      parentSku: str(ctx.payload.parentSku),
      axisA: axisOf(ctx.payload.axisA),
      axisB: axisOf(ctx.payload.axisB),
    });
    return { ok: true, result: { ok: true, ...result } };
  } catch (err) {
    return { ok: false, result: { error: "validation_failed", message: (err as Error).message }, errorCode: "validation_failed" };
  }
};
const accessoriesItemCreate: AutopilotExecutor = async (ctx) => createVariantItem(ctx);
const accessoriesItemSell: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id) ?? str(ctx.payload.itemId);
  if (!id) return fail("missing_fields");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const item = await getItem(id);
  if (!item || item.locationId !== branch.locationId) return fail("item_not_found");
  const paymentMethod = str(ctx.payload.paymentMethod) as SettlementMethod | null;
  if (paymentMethod !== "cash" && paymentMethod !== "bank" && paymentMethod !== "credit") {
    return fail("invalid_payment_method");
  }
  const vatPercent = Number(ctx.payload.vatPercent ?? 0);
  if (!Number.isFinite(vatPercent)) return { ok: false, result: { error: "bad_request" }, errorCode: "bad_request" };
  if (!ctx.authorizedByUserId) return fail("unauthenticated");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await sellAccessoryUnits(client, {
      businessId: ctx.businessId,
      locationId: branch.locationId,
      itemId: id,
      quantity: str(ctx.payload.quantity) ?? "1",
      unitPrice: ctx.payload.unitPrice != null ? Number(ctx.payload.unitPrice) : undefined,
      discount: Number(ctx.payload.discount ?? 0),
      vatPercent,
      paymentMethod,
      createdBy: ctx.authorizedByUserId,
    });
    await client.query("COMMIT");
    return { ok: true, result: { ok: true, ...(result as object) } };
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof MissingLedgerAccountError) {
      return { ok: false, result: { error: "ledger_account_missing", code: err.code }, errorCode: "ledger_account_missing" };
    }
    return { ok: false, result: { error: "validation_failed", message: (err as Error).message }, errorCode: "validation_failed" };
  } finally {
    client.release();
  }
};

// ── Issue #883 package 2, batch AO — trade-goods verticals ───────────────
// wholesale / tools_fittings / haberdashery share one route implementation
// (trade-goods-routes.ts), so they share one executor family: item-create is
// the same two-shape builder as the cosmetics/accessories lanes, stock-update
// adds the opening-cost branch, and the sell factory brands its sale with
// the trade — exactly the routes' transaction and error envelopes.
const tradeGoodsSellExecutor = (trade: TradeGoodsIndustry): AutopilotExecutor => async (ctx) => {
  const id = str(ctx.payload.id) ?? str(ctx.payload.itemId);
  if (!id) return fail("missing_fields");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const item = await getItem(id);
  if (!item || item.locationId !== branch.locationId) return fail("item_not_found");
  const paymentMethod = str(ctx.payload.paymentMethod) as SettlementMethod | null;
  if (paymentMethod !== "cash" && paymentMethod !== "bank" && paymentMethod !== "credit") {
    return fail("invalid_payment_method");
  }
  const vatPercent = Number(ctx.payload.vatPercent ?? 0);
  if (!Number.isFinite(vatPercent)) return { ok: false, result: { error: "bad_request" }, errorCode: "bad_request" };
  if (!ctx.authorizedByUserId) return fail("unauthenticated");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await sellTradeGoodsUnits(client, {
      trade,
      businessId: ctx.businessId,
      locationId: branch.locationId,
      itemId: id,
      quantity: str(ctx.payload.quantity) ?? "1",
      unitPrice: ctx.payload.unitPrice != null ? Number(ctx.payload.unitPrice) : undefined,
      discount: Number(ctx.payload.discount ?? 0),
      vatPercent,
      paymentMethod,
      createdBy: ctx.authorizedByUserId,
    });
    await client.query("COMMIT");
    return { ok: true, result: { ok: true, ...(result as object) } };
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof MissingLedgerAccountError) {
      return { ok: false, result: { error: "ledger_account_missing", code: err.code }, errorCode: "ledger_account_missing" };
    }
    return { ok: false, result: { error: "validation_failed", message: (err as Error).message }, errorCode: "validation_failed" };
  } finally {
    client.release();
  }
};
const tradeGoodsStockExecutor = (): AutopilotExecutor =>
  stockUpdateExecutor({ receive: receiveTradeGoodsStock, setPrice: setTradeGoodsUnitPrice, withInitialCost: true });
const wholesaleItemCreate: AutopilotExecutor = createVariantItem;
const wholesaleItemSell = tradeGoodsSellExecutor("wholesale");
const wholesaleStockUpdate = tradeGoodsStockExecutor();
const toolsFittingsItemCreate: AutopilotExecutor = createVariantItem;
const toolsFittingsItemSell = tradeGoodsSellExecutor("tools_fittings");
const toolsFittingsStockUpdate = tradeGoodsStockExecutor();
const haberdasheryItemCreate: AutopilotExecutor = createVariantItem;
const haberdasheryItemSell = tradeGoodsSellExecutor("haberdashery");
const haberdasheryStockUpdate = tradeGoodsStockExecutor();

// ── Issue #883 package 2, batch AS — barcode bulk mint ─────────────────────
// Mirrors POST /api/inventory/barcodes/bulk: one transaction, idempotent, the
// same barcode_failed envelope the route answers on a rollback.
const barcodeBulkMint: AutopilotExecutor = async (ctx) => {
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await mintMissingBarcodes(client, branch.locationId);
    await client.query("COMMIT");
    return { ok: true, result: { ok: true, ...(result as object) } };
  } catch (err) {
    await client.query("ROLLBACK");
    return { ok: false, result: { error: "barcode_failed", message: (err as Error).message }, errorCode: "barcode_failed" };
  } finally {
    client.release();
  }
};

// ── Issue #883 package 2, batch AV — dining floor plan ──────────────────────
// Structural edits and operational status use two different capability keys —
// the verbs are split the same way the routes split the guards, and a chat
// payload can't accidentally mix them.
const clampTablePos = (v: unknown, def: number) => (Number.isFinite(v) ? Math.max(0, Math.round(Number(v))) : def);
const clampTableSize = (v: unknown, def: number) =>
  Number.isFinite(v) ? Math.min(400, Math.max(30, Math.round(Number(v)))) : def;
const tableEdit: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  if (!id) {
    // ── POST /api/tables ──
    const name = str(ctx.payload.name)?.trim();
    const capacity = Number.isFinite(ctx.payload.capacity) ? Number(ctx.payload.capacity) : 2;
    if (!name || capacity <= 0) return fail("missing_fields");
    const shape = ctx.payload.shape === "circle" ? "circle" : "rect";
    const { rows: dup } = await query("SELECT id FROM dining_tables WHERE location_id = $1 AND name = $2", [
      branch.locationId, name,
    ]);
    if (dup.length > 0) return fail("table_exists");
    const sectionId = await resolveSectionId(branch.locationId, ctx.payload.sectionId === undefined ? undefined : str(ctx.payload.sectionId));
    if (sectionId === false) return fail("section_not_found");
    const { rows } = await query<{ id: string }>(
      `INSERT INTO dining_tables (location_id, name, zone, section_id, capacity, sort_order,
              pos_x, pos_y, width, height, shape)
       SELECT $1, $2, $3, $4, $5, COALESCE(MAX(sort_order) + 1, 0), $6, $7, $8, $9, $10
         FROM dining_tables WHERE location_id = $1
       RETURNING id`,
      [
        branch.locationId, name, str(ctx.payload.zone)?.trim() || null, sectionId, capacity,
        clampTablePos(ctx.payload.posX, 20), clampTablePos(ctx.payload.posY, 20),
        clampTableSize(ctx.payload.width, 80), clampTableSize(ctx.payload.height, 80), shape,
      ],
    );
    return { ok: true, result: { ok: true, id: rows[0]?.id } };
  }
  // ── PATCH /api/tables/[id], structural fields only ──
  const { rows: existing } = await query<{ id: string }>(
    "SELECT id FROM dining_tables WHERE id = $1 AND location_id = $2",
    [id, branch.locationId],
  );
  if (existing.length === 0) return fail("table_not_found");
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const set = (col: string, val: unknown) => { fields.push(`${col} = $${++i}`); values.push(val); };
  if (ctx.payload.name !== undefined) {
    const name = str(ctx.payload.name)?.trim();
    if (!name) return fail("missing_fields");
    const { rows: dup } = await query(
      "SELECT id FROM dining_tables WHERE location_id = $1 AND name = $2 AND id <> $3",
      [branch.locationId, name, id],
    );
    if (dup.length > 0) return fail("table_exists");
    set("name", name);
  }
  if (ctx.payload.zone !== undefined) set("zone", str(ctx.payload.zone)?.trim() || null);
  if (ctx.payload.sectionId !== undefined) {
    const sectionId = await resolveSectionId(branch.locationId, str(ctx.payload.sectionId));
    if (sectionId === false) return fail("section_not_found");
    set("section_id", sectionId);
  }
  if (ctx.payload.capacity !== undefined) {
    const capacity = Number(ctx.payload.capacity);
    if (!Number.isFinite(capacity) || capacity <= 0) return fail("missing_fields");
    set("capacity", capacity);
  }
  if (ctx.payload.isActive !== undefined) set("is_active", Boolean(ctx.payload.isActive));
  if (ctx.payload.posX !== undefined) set("pos_x", clampTablePos(ctx.payload.posX, 0));
  if (ctx.payload.posY !== undefined) set("pos_y", clampTablePos(ctx.payload.posY, 0));
  if (ctx.payload.width !== undefined) set("width", clampTableSize(ctx.payload.width, 80));
  if (ctx.payload.height !== undefined) set("height", clampTableSize(ctx.payload.height, 80));
  if (ctx.payload.shape !== undefined) set("shape", ctx.payload.shape === "circle" ? "circle" : "rect");
  if (fields.length === 0) return fail("bad_request");
  await query(`UPDATE dining_tables SET ${fields.join(", ")} WHERE id = $1`, [id, ...values]);
  return { ok: true, result: { ok: true } };
};
const tableStatus: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  const to = str(ctx.payload.status) as TableStatus | null;
  if (!id || !to) return fail("missing_fields");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const { rows: existing } = await query<{ id: string; status: TableStatus }>(
    "SELECT id, status FROM dining_tables WHERE id = $1 AND location_id = $2",
    [id, branch.locationId],
  );
  if (existing.length === 0) return fail("table_not_found");
  // bill_requested stays unset-able exactly like the route; seating is the
  // session's verb, refused with the route's own code.
  const validTargets: TableStatus[] = ["free", "seated", "cleaning", "out_of_service"];
  if (!validTargets.includes(to)) return fail("invalid_status");
  if (existing[0].status !== to && !canTransitionTable(existing[0].status, to)) return fail("invalid_transition");
  if (to === "seated") return fail("seat_via_session");
  await query("UPDATE dining_tables SET status = $2 WHERE id = $1", [id, to]);
  broadcast(branch.locationId, { type: "table.status", tableId: id, status: to });
  return { ok: true, result: { ok: true } };
};
const tableDelete: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const { rows: existing } = await query("SELECT id FROM dining_tables WHERE id = $1 AND location_id = $2", [
    id, branch.locationId,
  ]);
  if (existing.length === 0) return fail("table_not_found");
  const { rows: active } = await query(
    "SELECT 1 FROM table_session_tables WHERE table_id = $1 AND released_at IS NULL", [id],
  );
  if (active.length > 0) return fail("table_in_use");
  await query("UPDATE dining_tables SET is_active = false, section_id = NULL, status = 'free' WHERE id = $1", [id]);
  return { ok: true, result: { ok: true } };
};

// ── Issue #883 package 2, batch AT — purchases & suppliers close-out ────────
// The whole cluster answers to purchasesManage and the pinned branch; every
// step is the [id] routes' own SQL/run sequence so the envelopes stay exact.
const purchaseUpdate: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const supplierId = str(ctx.payload.supplierId);
  // Route order: supplier existence first (its own 404), then the parse step.
  if (supplierId) {
    const { rows: supplier } = await query(
      "SELECT id FROM suppliers WHERE id = $1 AND location_id = $2",
      [supplierId, branch.locationId],
    );
    if (supplier.length === 0) return fail("supplier_not_found");
  }
  let lines: Awaited<ReturnType<typeof preparePurchaseLines>>["lines"];
  let total: string;
  let purchaseDate: string | null;
  let invoice: ReturnType<typeof supplierInvoiceOrError> | null = null;
  try {
    purchaseDate = purchaseDateOrNull(ctx.payload.purchaseDate);
    ({ lines, total } = await preparePurchaseLines(
      Array.isArray(ctx.payload.items) ? (ctx.payload.items as never) : [],
      branch.locationId,
    ));
    if (ctx.payload.invoice !== undefined) invoice = supplierInvoiceOrError(ctx.payload.invoice);
  } catch (err) {
    if (err instanceof PurchaseLineError || err instanceof PurchaseServiceError) {
      return { ok: false, result: { error: err.code }, errorCode: err.code };
    }
    throw err;
  }
  const note = ctx.payload.note === undefined ? undefined : str(ctx.payload.note);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: locked } = await client.query<{ status: string }>(
      "SELECT status::text AS status FROM purchases WHERE id = $1 AND location_id = $2 FOR UPDATE",
      [id, branch.locationId],
    );
    const purchase = locked[0];
    if (!purchase) { await client.query("ROLLBACK"); return fail("not_found"); }
    if (purchase.status === "received") { await client.query("ROLLBACK"); return fail("purchase_received_cannot_edit"); }
    if (purchase.status === "cancelled") { await client.query("ROLLBACK"); return fail("purchase_cancelled_cannot_edit"); }
    // A cleared date means "leave the stored date alone" — the route's comment,
    // verbatim semantics via COALESCE.
    await client.query(
      `UPDATE purchases SET supplier_id = $2, note = $3, total = $4,
              purchase_date = COALESCE($6::date, purchase_date)
        WHERE id = $1 AND location_id = $5`,
      [id, supplierId || null, note?.trim() || null, total, branch.locationId, purchaseDate],
    );
    if (invoice) {
      await client.query(
        `UPDATE purchases
            SET supplier_invoice_number = $2, supplier_invoice_date = $3::date, vat_amount = $4,
                payment_terms_days = $5::integer,
                payment_due_date = ${SUPPLIER_INVOICE_DUE_DATE_SQL("$6", "$5", "$3", "purchase_date")}
          WHERE id = $1`,
        [id, invoice.invoiceNumber, invoice.invoiceDate, invoice.vatAmount, invoice.paymentTermsDays, invoice.dueDate],
      );
    }
    await client.query("DELETE FROM purchase_items WHERE purchase_id = $1", [id]);
    for (const line of lines) {
      await client.query(
        `INSERT INTO purchase_items (purchase_id, inventory_item_id, quantity, unit_cost, extended_cost)
         VALUES ($1, $2, $3, $4::numeric / $3::numeric, $4)`,
        [id, line.inventoryItemId, line.baseQty, line.totalCost],
      );
    }
    await client.query("COMMIT");
    return { ok: true, result: { ok: true, total } };
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => {});
    throw cause;
  } finally {
    client.release();
  }
};
// The route's draft -> ordered -> received | cancelled ladder, minus the
// received step (its own always_approve verb below).
const PURCHASE_TRANSITIONS: Record<string, string[]> = {
  draft: ["ordered", "received", "cancelled"],
  ordered: ["received", "cancelled"],
  received: [],
  cancelled: [],
};
const purchaseLifecycle: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  const nextStatus = str(ctx.payload.action);
  if (!id || (nextStatus !== "ordered" && nextStatus !== "cancelled")) return fail("invalid_transition");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: string }>(
      "SELECT status::text AS status FROM purchases WHERE id=$1 AND location_id=$2 FOR UPDATE",
      [id, branch.locationId],
    );
    const purchase = rows[0];
    if (!purchase) { await client.query("ROLLBACK"); return fail("not_found"); }
    if (!(PURCHASE_TRANSITIONS[purchase.status] ?? []).includes(nextStatus)) {
      await client.query("ROLLBACK");
      return fail("invalid_transition");
    }
    await client.query(
      `UPDATE purchases SET status=$2::purchase_status,
              ordered_at=CASE WHEN $2::purchase_status='ordered' THEN now() ELSE ordered_at END
        WHERE id=$1`,
      [id, nextStatus],
    );
    await client.query("COMMIT");
    return { ok: true, result: { ok: true, status: nextStatus } };
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => {});
    throw cause;
  } finally {
    client.release();
  }
};
// The PATCH {status:"received"} branch — stock-in + weighted-average roll +
// journal, the route's exact run through receivePurchaseInTransaction.
const purchaseReceive: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const settlementMethod: PurchaseSettlementMethod = PURCHASE_SETTLEMENT_METHODS.includes(
    str(ctx.payload.settlementMethod) as PurchaseSettlementMethod,
  )
    ? (str(ctx.payload.settlementMethod) as PurchaseSettlementMethod)
    : "credit";
  const supplierId = str(ctx.payload.supplierId) || null;
  const { rows: roleRows } = await query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [
    ctx.authorizedByUserId,
  ]);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const received = await receivePurchaseInTransaction(client, {
      businessId: ctx.businessId,
      locationId: branch.locationId,
      purchaseId: id,
      settlementMethod,
      supplierId,
      createdBy: ctx.authorizedByUserId,
      sync: { actorRole: (roleRows[0]?.role ?? "Owner") as Role },
    });
    await client.query("COMMIT");
    return { ok: true, result: { ok: true, ...received } };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    const code = err instanceof Error ? err.message : "apply_failed";
    return { ok: false, result: { error: code }, errorCode: code };
  } finally {
    client.release();
  }
};
const purchaseDelete: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: string }>(
      "SELECT status::text AS status FROM purchases WHERE id = $1 AND location_id = $2 FOR UPDATE",
      [id, branch.locationId],
    );
    const purchase = rows[0];
    if (!purchase) { await client.query("ROLLBACK"); return fail("not_found"); }
    if (purchase.status === "received") {
      await client.query("ROLLBACK");
      return fail("purchase_received_cannot_delete");
    }
    await client.query("DELETE FROM purchases WHERE id = $1 AND location_id = $2", [id, branch.locationId]);
    await client.query("COMMIT");
    return { ok: true, result: { ok: true, deleted: true } };
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => {});
    throw cause;
  } finally {
    client.release();
  }
};
// ownedSupplier() from the suppliers [id] route: the supplier must belong to
// the pinned branch, and its full edit semantics come after.
const supplierUpdate: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const { rows: owned } = await query<{ id: string; party_id: string | null }>(
    "SELECT id, party_id FROM suppliers WHERE id = $1 AND location_id = $2",
    [id, branch.locationId],
  );
  if (!owned[0]) return fail("not_found");
  const name = ctx.payload.name === undefined ? undefined : str(ctx.payload.name);
  const phone = ctx.payload.phone === undefined ? undefined : str(ctx.payload.phone);
  if (owned[0].party_id && (name !== undefined || phone !== undefined)) {
    return fail("supplier_identity_on_party");
  }
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const set = (col: string, val: unknown) => { fields.push(`${col} = $${++i}`); values.push(val); };
  if (name !== undefined) {
    const trimmed = (name ?? "").trim();
    if (!trimmed) return fail("missing_fields");
    set("name", trimmed);
  }
  if (phone !== undefined) set("phone", phone?.trim() || null);
  if (ctx.payload.notes !== undefined) set("notes", str(ctx.payload.notes)?.trim() || null);
  if (ctx.payload.isActive !== undefined) set("is_active", Boolean(ctx.payload.isActive));
  if (fields.length === 0) return fail("bad_request");
  await query(`UPDATE suppliers SET ${fields.join(", ")} WHERE id = $1`, [id, ...values]);
  return { ok: true, result: { ok: true } };
};
const supplierArchive: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const { rows: owned } = await query<{ id: string }>(
    "SELECT id FROM suppliers WHERE id = $1 AND location_id = $2",
    [id, branch.locationId],
  );
  if (!owned[0]) return fail("not_found");
  const { rows: refs } = await query("SELECT 1 FROM purchases WHERE supplier_id = $1 LIMIT 1", [id]);
  if (refs.length > 0) {
    await query("UPDATE suppliers SET is_active = false WHERE id = $1", [id]);
    return { ok: true, result: { ok: true, deactivated: true } };
  }
  await query("DELETE FROM suppliers WHERE id = $1", [id]);
  return { ok: true, result: { ok: true, deactivated: false } };
};

// ── Issue #883 package 2, batch AW — reservations ───────────────────────────
/** The [id] route's loadReservation: location-scoped, phone decrypted once. */
async function reservationForExecutor(businessId: string, locationId: string, id: string) {
  const { rows } = await query<{
    id: string; table_id: string | null; customer_name: string; customer_phone: string | null;
    party_size: number; reserved_at: string; duration_minutes: number; status: string;
    seated_session_id: string | null;
  }>(
    `SELECT id, table_id, customer_name, customer_phone, party_size, reserved_at,
            duration_minutes, status, seated_session_id
       FROM reservations WHERE id = $1 AND location_id = $2`,
    [id, locationId],
  );
  if (!rows[0]) return null;
  const [reservation] = await decryptReservationPhones(businessId, rows);
  return reservation;
}
const reservationCreate: AutopilotExecutor = async (ctx) => {
  const customerName = str(ctx.payload.customerName)?.trim();
  if (!customerName) return fail("missing_fields");
  const reservedAt = parseReservationDate(str(ctx.payload.reservedAt));
  if (!reservedAt) return fail("invalid_time");
  if (reservedAt.getTime() < Date.now() - 60 * 60 * 1000) return fail("time_in_past");
  const partySize = Number.isFinite(ctx.payload.partySize) && Number(ctx.payload.partySize) > 0 ? Number(ctx.payload.partySize) : 0;
  if (partySize <= 0) return fail("invalid_party_size");
  const duration =
    Number.isFinite(ctx.payload.durationMinutes) && Number(ctx.payload.durationMinutes) > 0
      ? Math.min(600, Math.max(15, Math.round(Number(ctx.payload.durationMinutes))))
      : 90;
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const tableId = str(ctx.payload.tableId) ?? null;
  const customerPhone = str(ctx.payload.customerPhone)?.trim() || null;
  const phoneCipher = await encryptReservationPhone(ctx.businessId, customerPhone);
  // A booked table takes its advisory lock around check+insert, exactly the
  // route's two-simultaneous-diners argument.
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (tableId) {
      await lockTableForReservationWrite(client, branch.locationId, tableId);
      const { rows: table } = await client.query(
        "SELECT id FROM dining_tables WHERE id = $1 AND location_id = $2 AND is_active",
        [tableId, branch.locationId],
      );
      if (table.length === 0) { await client.query("ROLLBACK"); return fail("table_not_found"); }
      const conflicts = await tableConflicts(branch.locationId, tableId, reservedAt, duration, null, client);
      if (conflicts.length > 0 && !ctx.payload.allowConflict) {
        await client.query("ROLLBACK");
        return { ok: false, result: { error: "reservation_conflict", conflicts }, errorCode: "reservation_conflict" };
      }
    }
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO reservations
          (location_id, table_id, customer_name, customer_phone, party_size, reserved_at, duration_minutes, note, created_by,
           customer_phone_enc, customer_phone_bidx)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        branch.locationId, tableId, customerName, customerPhone, partySize, reservedAt.toISOString(),
        duration, str(ctx.payload.note)?.trim() || null, ctx.authorizedByUserId, phoneCipher.enc, phoneCipher.bidx,
      ],
    );
    await client.query("COMMIT");
    return { ok: true, result: { ok: true, id: rows[0].id } };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};
const reservationEdit: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const reservation = await reservationForExecutor(ctx.businessId, branch.locationId, id);
  if (!reservation) return fail("reservation_not_found");
  if (reservation.status !== "booked") return fail("reservation_not_booked");
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const set = (col: string, val: unknown) => { fields.push(`${col} = $${++i}`); values.push(val); };
  let effectiveTableId = reservation.table_id;
  let effectiveReservedAt = new Date(reservation.reserved_at);
  let effectiveDuration = reservation.duration_minutes;
  if (ctx.payload.tableId !== undefined) {
    const tableId = str(ctx.payload.tableId);
    if (tableId) {
      const { rows } = await query("SELECT id FROM dining_tables WHERE id = $1 AND location_id = $2 AND is_active", [
        tableId, branch.locationId,
      ]);
      if (rows.length === 0) return fail("table_not_found");
    }
    effectiveTableId = tableId || null;
    set("table_id", effectiveTableId);
  }
  if (ctx.payload.reservedAt !== undefined) {
    const d = parseReservationDate(str(ctx.payload.reservedAt));
    if (!d) return fail("invalid_time");
    effectiveReservedAt = d;
    set("reserved_at", d.toISOString());
  }
  if (ctx.payload.durationMinutes !== undefined) {
    if (!Number.isFinite(ctx.payload.durationMinutes) || Number(ctx.payload.durationMinutes) <= 0) return fail("bad_request");
    effectiveDuration = Math.min(600, Math.max(15, Math.round(Number(ctx.payload.durationMinutes))));
    set("duration_minutes", effectiveDuration);
  }
  if (ctx.payload.customerName !== undefined) {
    const name = str(ctx.payload.customerName)?.trim();
    if (!name) return fail("missing_fields");
    set("customer_name", name);
  }
  if (ctx.payload.customerPhone !== undefined) {
    // Written as a triple — the BEFORE UPDATE trigger would otherwise drop
    // the blind index and take the booking out of phone lookup (the route's
    // comment, mirrored).
    const phone = str(ctx.payload.customerPhone)?.trim() || null;
    const cipher = await encryptReservationPhone(ctx.businessId, phone);
    set("customer_phone", phone);
    set("customer_phone_enc", cipher.enc);
    set("customer_phone_bidx", cipher.bidx);
  }
  if (ctx.payload.partySize !== undefined) {
    const n = Number(ctx.payload.partySize);
    if (!Number.isFinite(n) || n <= 0) return fail("invalid_party_size");
    set("party_size", Math.round(n));
  }
  if (ctx.payload.note !== undefined) set("note", str(ctx.payload.note)?.trim() || null);
  if (fields.length === 0) return fail("bad_request");
  set("updated_at", new Date().toISOString());
  const recheckOverlap =
    effectiveTableId &&
    (ctx.payload.tableId !== undefined || ctx.payload.reservedAt !== undefined || ctx.payload.durationMinutes !== undefined);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (recheckOverlap) {
      await lockTableForReservationWrite(client, branch.locationId, effectiveTableId!);
      const conflicts = await tableConflicts(
        branch.locationId, effectiveTableId!, effectiveReservedAt, effectiveDuration, reservation.id, client,
      );
      if (conflicts.length > 0 && !ctx.payload.allowConflict) {
        await client.query("ROLLBACK");
        return { ok: false, result: { error: "reservation_conflict", conflicts }, errorCode: "reservation_conflict" };
      }
    }
    await client.query(`UPDATE reservations SET ${fields.join(", ")} WHERE id = $1`, [reservation.id, ...values]);
    await client.query("COMMIT");
    return { ok: true, result: { ok: true } };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};
const reservationLifecycle: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  const action = str(ctx.payload.action);
  if (!id || (action !== "cancel" && action !== "no_show" && action !== "seat")) return fail("bad_request");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const reservation = await reservationForExecutor(ctx.businessId, branch.locationId, id);
  if (!reservation) return fail("reservation_not_found");
  if (action === "cancel" || action === "no_show") {
    if (reservation.status !== "booked") return fail("reservation_not_booked");
    const to = action === "cancel" ? "cancelled" : "no_show";
    await query("UPDATE reservations SET status = $2::reservation_status, updated_at = now() WHERE id = $1", [id, to]);
    return { ok: true, result: { ok: true } };
  }
  // seat — the table session opens server-side with the reservation as its
  // party, broadcast included, exactly like the floor does it.
  if (reservation.status !== "booked") return fail("reservation_not_booked");
  const tableIds = (Array.isArray(ctx.payload.tableIds) ? ctx.payload.tableIds.map((t) => String(t)).filter(Boolean) : []).length
    ? (ctx.payload.tableIds as unknown[]).map((t) => String(t)).filter(Boolean)
    : reservation.table_id
      ? [reservation.table_id]
      : [];
  if (tableIds.length === 0) return fail("table_required");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { id: sessionId } = await openSession(client, {
      locationId: branch.locationId,
      tableIds,
      partySize: reservation.party_size,
      guestName: reservation.customer_name,
      guestPhone: reservation.customer_phone,
      reservationId: reservation.id,
      openedBy: ctx.authorizedByUserId ?? "",
    });
    await client.query(
      "UPDATE reservations SET status = 'seated', seated_session_id = $2, updated_at = now() WHERE id = $1",
      [reservation.id, sessionId],
    );
    await client.query("COMMIT");
    broadcast(branch.locationId, { type: "table_session.updated", sessionId });
    return { ok: true, result: { ok: true, sessionId } };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // openSession refuses with coded errors (table busy etc.) — forward them
    // the way the route does.
    const code = (err as { code?: string }).code;
    if (code) return { ok: false, result: { error: code }, errorCode: code };
    throw err;
  } finally {
    client.release();
  }
};
const reservationDelete: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const reservation = await reservationForExecutor(ctx.businessId, branch.locationId, id);
  if (!reservation) return fail("reservation_not_found");
  await query("DELETE FROM reservations WHERE id = $1", [id]);
  return { ok: true, result: { ok: true } };
};

// ── Issue #883 package 2, batch AX — kitchen & floor queues ────────────────
/** The author's membership role — the value session.role carries on a route. */
async function authorMembershipRole(ctx: AutopilotExecutorContext): Promise<string> {
  if (!ctx.authorizedByUserId) return "Owner";
  const { rows } = await query<{ role: string }>(
    `SELECT m.role FROM memberships m WHERE m.user_id = $1 AND m.business_id = $2 ORDER BY m.created_at LIMIT 1`,
    [ctx.authorizedByUserId, ctx.businessId],
  );
  return rows[0]?.role ?? "Owner";
}
const floorSectionCreate: AutopilotExecutor = async (ctx) => {
  const name = str(ctx.payload.name)?.trim();
  if (!name) return fail("missing_fields");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const { rows: dup } = await query("SELECT id FROM floor_sections WHERE location_id = $1 AND name = $2", [
    branch.locationId, name,
  ]);
  if (dup.length > 0) return fail("section_exists");
  // Issue #947 (consumer seam): `validWaiterId` now asks the shared eligibility
  // resolver, which is business-scoped — the same contract the floor routes and the
  // picker use, so an MCP-created section cannot be assigned to a member the floor
  // screen would refuse (or vice versa).
  const waiterId = await validWaiterId(ctx.businessId, branch.locationId, ctx.payload.assignedWaiterId === undefined ? undefined : str(ctx.payload.assignedWaiterId));
  if (waiterId === false) return fail("waiter_not_found");
  const { rows } = await query<{ id: string }>(
    `INSERT INTO floor_sections (location_id, name, color, assigned_waiter_id, sort_order)
     SELECT $1, $2, $3, $4, COALESCE(MAX(sort_order) + 1, 0)
       FROM floor_sections WHERE location_id = $1
     RETURNING id`,
    [branch.locationId, name, str(ctx.payload.color)?.trim() || null, waiterId],
  );
  return { ok: true, result: { ok: true, id: rows[0].id } };
};
const floorSectionUpdate: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const { rows: owned } = await query("SELECT id FROM floor_sections WHERE id = $1 AND location_id = $2", [
    id, branch.locationId,
  ]);
  if (!owned[0]) return fail("section_not_found");
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const set = (col: string, val: unknown) => { fields.push(`${col} = $${++i}`); values.push(val); };
  if (ctx.payload.name !== undefined) {
    const name = str(ctx.payload.name)?.trim();
    if (!name) return fail("missing_fields");
    const { rows: dup } = await query(
      "SELECT id FROM floor_sections WHERE location_id = $1 AND name = $2 AND id <> $3",
      [branch.locationId, name, id],
    );
    if (dup.length > 0) return fail("section_exists");
    set("name", name);
  }
  if (ctx.payload.color !== undefined) set("color", str(ctx.payload.color)?.trim() || null);
  if (ctx.payload.assignedWaiterId !== undefined) {
    const waiterId = await validWaiterId(ctx.businessId, branch.locationId, str(ctx.payload.assignedWaiterId));
    if (waiterId === false) return fail("waiter_not_found");
    set("assigned_waiter_id", waiterId);
  }
  if (ctx.payload.sortOrder !== undefined && Number.isFinite(ctx.payload.sortOrder)) set("sort_order", Number(ctx.payload.sortOrder));
  if (fields.length === 0) return fail("bad_request");
  await query(`UPDATE floor_sections SET ${fields.join(", ")} WHERE id = $1`, [id, ...values]);
  return { ok: true, result: { ok: true } };
};
const floorSectionDelete: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const { rows: owned } = await query("SELECT id FROM floor_sections WHERE id = $1 AND location_id = $2", [
    id, branch.locationId,
  ]);
  if (!owned[0]) return fail("section_not_found");
  await query("DELETE FROM floor_sections WHERE id = $1", [id]);
  return { ok: true, result: { ok: true } };
};
// The kitchen "bump" (sent→preparing→ready) and waiter/cashier "served"
// (ready→served) — both role gates re-applied with the author's membership
// role; the coworker event fires only when the final unready line lands.
const kitchenItemStatus: AutopilotExecutor = async (ctx) => {
  const itemId = str(ctx.payload.itemId) ?? str(ctx.payload.id);
  const to = str(ctx.payload.status) as OrderItemStatus | null;
  if (!itemId || (to !== "preparing" && to !== "ready" && to !== "served")) return fail("invalid_status");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const role = await authorMembershipRole(ctx);
  const { rows } = await query<{ id: string; status: OrderItemStatus; order_id: string }>(
    `SELECT oi.id, oi.status, oi.order_id
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.id = $1 AND oi.location_id = $2 AND o.status = 'open'`,
    [itemId, branch.locationId],
  );
  const item = rows[0];
  if (!item) return fail("item_not_found");
  const canKitchen = ["owner", "manager", "kitchen"].includes(role) && canKitchenBump(item.status, to);
  const canServe = ["owner", "manager", "waiter", "cashier"].includes(role) && canMarkServed(item.status, to);
  if (!canKitchen && !canServe) return fail("invalid_transition");
  if (to === "ready") {
    await query("UPDATE order_items SET status = $2, ready_at = now() WHERE id = $1", [itemId, to]);
  } else {
    await query("UPDATE order_items SET status = $2 WHERE id = $1", [itemId, to]);
  }
  broadcast(branch.locationId, { type: "order.item_status", orderId: item.order_id, itemId, status: to });
  await recordOrderStateStandalone({
    locationId: branch.locationId,
    orderId: item.order_id,
    actor: { userId: ctx.authorizedByUserId ?? "", role: role as Role },
  });
  if (to === "ready") {
    const { rows: readyOrders } = await query<{ customer_id: string }>(
      `SELECT o.customer_id FROM orders o
        WHERE o.id = $1 AND o.customer_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM order_items oi
                           WHERE oi.order_id = o.id AND oi.status NOT IN ('ready', 'served'))`,
      [item.order_id],
    );
    if (readyOrders[0]) await recordCoworkerEvent({
      businessId: ctx.businessId, locationId: branch.locationId, kind: "order_ready",
      payload: { customerId: readyOrders[0].customer_id, orderId: item.order_id },
      dedupeKey: `order-ready:${item.order_id}`,
    });
  }
  return { ok: true, result: { ok: true } };
};

// ── Issue #883 package 2, batch AY — waste & NRV write-downs ───────────────
// All three post ledgers; the registry steps every one of them up to explicit
// approval. error envelopes stay word-for-word the routes'.
const wasteRecord: AutopilotExecutor = async (ctx) => {
  let quantity: string;
  try {
    quantity = positiveQuantityText(String(ctx.payload.quantity ?? ""));
  } catch {
    return fail("invalid_quantity");
  }
  const inventoryItemId = str(ctx.payload.inventoryItemId);
  if (!inventoryItemId) return fail("invalid_item");
  if (!isWasteReason(str(ctx.payload.reason))) return fail("invalid_waste_reason");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  const { rows: item } = await query(
    "SELECT id FROM inventory_items WHERE id = $1 AND location_id = $2 AND is_active",
    [inventoryItemId, branch.locationId],
  );
  if (item.length === 0) return fail("item_not_found");
  const role = await authorMembershipRole(ctx);
  try {
    const recorded = await recordWaste({
      businessId: ctx.businessId,
      locationId: branch.locationId,
      inventoryItemId,
      quantity: quantity as QuantityText,
      reason: str(ctx.payload.reason) as NonNullable<Parameters<typeof recordWaste>[0]["reason"]>,
      note: str(ctx.payload.note)?.trim() || null,
      createdBy: ctx.authorizedByUserId,
      sync: { actorRole: role as Role },
    });
    return { ok: true, result: { ok: true, totalCost: recorded.postedCost } };
  } catch (err) {
    if (err instanceof MissingLedgerAccountError) {
      return { ok: false, result: { error: "ledger_account_missing", code: err.code }, errorCode: "ledger_account_missing" };
    }
    if (err instanceof Error && err.message === "periodic_system_unsupported") return fail(err.message);
    throw err;
  }
};
const writeDownCreate: AutopilotExecutor = async (ctx) => {
  if (!ctx.authorizedByUserId) return fail("unauthenticated");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  try {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await createNrvWriteDown(client, {
        businessId: ctx.businessId, locationId: branch.locationId, createdBy: ctx.authorizedByUserId,
        valuationDate: str(ctx.payload.valuationDate) ?? "", reason: str(ctx.payload.reason) ?? "",
        idempotencyKey: str(ctx.payload.idempotencyKey) ?? "",
        lines: (Array.isArray(ctx.payload.lines) ? ctx.payload.lines : []).map((line) => {
          const l = line as Record<string, unknown>;
          return { inventoryItemId: String(l.inventoryItemId ?? ""), nrvValueRial: rialText(String(l.nrvValueRial ?? "")) };
        }),
      });
      await client.query("COMMIT");
      return { ok: true, result: { ok: true, ...result } };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      return { ok: false, result: { error: (err as Error).message }, errorCode: (err as Error).message };
    } finally {
      client.release();
    }
  } catch (err) {
    return { ok: false, result: { error: (err as Error).message }, errorCode: (err as Error).message };
  }
};
const writeDownReverse: AutopilotExecutor = async (ctx) => {
  if (!ctx.authorizedByUserId) return fail("unauthenticated");
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const branch = await verticalLocation(ctx);
  if ("ok" in branch) return branch;
  try {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await reverseNrvWriteDown(client, {
        businessId: ctx.businessId, locationId: branch.locationId, originalId: id, createdBy: ctx.authorizedByUserId,
        reason: str(ctx.payload.reason) ?? "",
        idempotencyKey: str(ctx.payload.idempotencyKey) ?? "",
        amounts: Array.isArray(ctx.payload.amounts)
          ? (ctx.payload.amounts as Record<string, unknown>[]).map((line) => ({
              inventoryItemId: String(line.inventoryItemId ?? ""), amountRial: rialText(String(line.amountRial ?? "")),
            }))
          : undefined,
      });
      await client.query("COMMIT");
      return { ok: true, result: { ok: true, ...result } };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      return { ok: false, result: { error: (err as Error).message }, errorCode: (err as Error).message };
    } finally {
      client.release();
    }
  } catch (err) {
    return { ok: false, result: { error: (err as Error).message }, errorCode: (err as Error).message };
  }
};

// ── Issue #883 package 2, batch AZ — the AI centre's config records ─────────
// The owner-only-auto rule: a manager may create these, but only an owner may
// ask for unattended application — the routes' rule, rechecked with the
// author's membership role.
function copyIfDefined(target: Record<string, unknown>, payload: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) if (payload[key] !== undefined) target[key] = payload[key];
  return target;
}
const aiAutomationSave: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  const approvalMode = str(ctx.payload.approvalMode);
  if (approvalMode === "auto" && (await authorMembershipRole(ctx)) !== "owner") return fail("owner_required");
  const input = copyIfDefined({}, ctx.payload, [
    "name", "locationId", "projectId", "triggerKind", "eventKind", "scheduleHour", "scheduleWeekday",
    "conditions", "actionType", "actionPayload", "approvalMode", "enabled",
  ]);
  const result = id
    ? await updateAutomation(ctx.businessId, id, input, { authorizedBy: ctx.authorizedByUserId })
    : await createAutomation(ctx.businessId, input, { userId: ctx.authorizedByUserId, authorizedBy: ctx.authorizedByUserId });
  if (!result.ok) return { ok: false, result: { error: (result as { error?: string; errors?: string[] }).error ?? (result as { errors?: string[] }).errors?.[0] ?? "invalid_automation", errors: (result as { errors?: string[] }).errors }, errorCode: "invalid_automation" };
  return { ok: true, result };
};
const aiAutomationDelete: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const removed = await deleteAutomation(ctx.businessId, id);
  if (!removed) return fail("not_found");
  return { ok: true, result: { ok: true } };
};
const aiAutomationRun: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const automation = await getAutomation(ctx.businessId, id);
  if (!automation) return fail("not_found");
  if (!automation.enabled) return fail("automation_disabled");
  if (automation.approvalMode === "auto" && (await authorMembershipRole(ctx)) !== "owner") {
    return fail("owner_required");
  }
  const run = await runAutomationNow(ctx.businessId, id);
  if (!run) return fail("not_found");
  return { ok: true, result: { run } };
};
const coworkerJobSave: AutopilotExecutor = async (ctx) => {
  if (!ctx.authorizedByUserId) return fail("unauthenticated");
  const id = str(ctx.payload.id);
  const approvalMode = str(ctx.payload.approvalMode);
  if (approvalMode === "auto" && (await authorMembershipRole(ctx)) !== "owner") return fail("owner_required");
  const input = copyIfDefined({}, ctx.payload, [
    "templateKey", "title", "locationId", "projectId", "triggerKind", "eventKind", "scheduleHour", "scheduleWeekday",
    "params", "approvalMode", "enabled",
  ]);
  const result: { ok: boolean; errors?: string[]; job?: unknown } = id
    ? await updateCoworkerJob(ctx.businessId, id, input, ctx.authorizedByUserId)
    : await createCoworkerJob(ctx.businessId, input, ctx.authorizedByUserId);
  if (!result.ok) {
    const errors = result.errors ?? ["invalid_job"];
    return { ok: false, result: { error: errors[0], errors, messages: errors.map(coworkerErrorMessage) }, errorCode: errors[0] };
  }
  return { ok: true, result: { job: result.job } };
};
const coworkerJobDelete: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const removed = await deleteCoworkerJob(ctx.businessId, id);
  if (!removed) return fail("coworker_job_not_found");
  return { ok: true, result: { ok: true } };
};
const coworkerJobRun: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const result = await runCoworkerJobNow(ctx.businessId, id);
  if (!result.ok) {
    return { ok: false, result: { error: result.error, message: coworkerErrorMessage(result.error) }, errorCode: result.error };
  }
  return { ok: true, result: { ok: true, runIds: result.runIds } };
};
// Memory is project-aware: a project-scoped write re-checks the author's
// workspace role with requireProjectCapability, mirroring the routes'
// owner|creator|member access probe.
const MEMORY_SCOPES = ["tenant", "app", "project"] as const;
async function memoryScopeCheck(ctx: AutopilotExecutorContext, scope: MemoryScope, projectId: string | null): Promise<AutopilotExecutionResult | null> {
  if (scope !== "project" || !projectId) return null;
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("forbidden");
  try {
    await requireProjectCapability(owner, projectId, "view");
    return null;
  } catch {
    return fail("forbidden");
  }
}
const memoryAdd: AutopilotExecutor = async (ctx) => {
  const raw = str(ctx.payload.scope);
  const scope = (raw ?? "tenant") as MemoryScope;
  if (!(MEMORY_SCOPES as readonly string[]).includes(scope)) return fail("bad_scope");
  const projectId = str(ctx.payload.projectId);
  const denied = await memoryScopeCheck(ctx, scope, projectId);
  if (denied) return denied;
  const validation = validateMemoryInput({
    businessId: ctx.businessId,
    scope,
    appKey: scope === "app" ? str(ctx.payload.appKey) : null,
    projectId: scope === "project" ? projectId : null,
    content: str(ctx.payload.content) ?? "",
    source: "user",
    createdBy: ctx.authorizedByUserId,
  });
  if (!validation.ok) return fail(validation.error);
  try {
    const entry = await createMemoryEntry({
      businessId: ctx.businessId,
      scope,
      appKey: scope === "app" ? str(ctx.payload.appKey) : null,
      projectId: scope === "project" ? projectId : null,
      content: str(ctx.payload.content) ?? "",
      source: "user",
      createdBy: ctx.authorizedByUserId,
    });
    return { ok: true, result: { entry } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal_error";
    return fail(message);
  }
};
const memoryDelete: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("id_required");
  const raw = str(ctx.payload.scope);
  const scope = (raw ?? "tenant") as MemoryScope;
  if (!(MEMORY_SCOPES as readonly string[]).includes(scope)) return fail("bad_scope");
  const projectId = str(ctx.payload.projectId);
  const denied = await memoryScopeCheck(ctx, scope, projectId);
  if (denied) return denied;
  const removed = await deleteMemoryEntry({ id, businessId: ctx.businessId, scope });
  if (!removed) return fail("not_found");
  return { ok: true, result: { ok: true } };
};

// ── Issue #883 package 2, batch BA — the settings doc-lane saves ────────────
// Every mirror keeps the route's own merge-and-validate order, the route's
// error names, and the route's transactions.
const SETTINGS_MAX_NAME = 200;
interface BusinessPrefsBean { currencyDisplay: "rial" | "toman"; language: "fa"; calendar: "jalali" }
interface BusinessProfileBean { legalName?: string; taxId?: string; email?: string; website?: string; receiptFooter?: string }
const settingsBusinessSave: AutopilotExecutor = async (ctx) => {
  const businessName = str(ctx.payload.businessName);
  const locationName = str(ctx.payload.locationName);
  if (!businessName || !locationName) return fail("missing_fields");
  const address = str(ctx.payload.address);
  const phone = str(ctx.payload.phone);
  const legalName = str(ctx.payload.legalName);
  const taxId = str(ctx.payload.taxId);
  const website = str(ctx.payload.website);
  const receiptFooter = str(ctx.payload.receiptFooter);
  // The route keeps per-field caps: name 200, address 500, phone 30,
  // taxId 50, website 200, receiptFooter 500 — re-implemented here with the
  // same thresholds so a too-long write fails with the same error.
  if (
    (businessName?.length ?? 0) > SETTINGS_MAX_NAME ||
    (address?.length ?? 0) > 500 ||
    (phone?.length ?? 0) > 30 ||
    (legalName?.length ?? 0) > SETTINGS_MAX_NAME ||
    (taxId?.length ?? 0) > 50 ||
    (website?.length ?? 0) > 200 ||
    (receiptFooter?.length ?? 0) > 500
  ) {
    return fail("field_too_long");
  }
  const email = str(ctx.payload.email);
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return fail("invalid_email");

  const location = ctx.authorizedByUserId
    ? await resolveActiveLocation({
        sub: ctx.authorizedByUserId,
        businessId: ctx.businessId,
        locationId: null,
      } as SessionPayload)
    : null;
  if (!location) return fail("no_location");

  const prefs: BusinessPrefsBean = {
    currencyDisplay: ctx.payload.currencyDisplay === "rial" ? "rial" : "toman",
    language: "fa",
    calendar: "jalali",
  };
  const profile: BusinessProfileBean = {
    legalName: legalName || undefined,
    taxId: taxId || undefined,
    email: email || undefined,
    website: website || undefined,
    receiptFooter: receiptFooter || undefined,
  };

  // Branch edits go through the branch screen's audited, duplicate-checked
  // updateBranch — never straight SQL on locations.
  const normalizedLocationName = normalizeBranchName(locationName);
  const branchInput: { name?: string; address?: string | null; phone?: string | null } = {};
  if (normalizedLocationName !== location.name) branchInput.name = normalizedLocationName;
  if ((address || null) !== location.address) branchInput.address = address || null;
  if ((phone || null) !== location.phone) branchInput.phone = phone || null;
  if (Object.keys(branchInput).length > 0) {
    try {
      await updateBranch({
        businessId: ctx.businessId,
        locationId: location.id,
        actorId: ctx.authorizedByUserId ?? "",
        ...branchInput,
      });
    } catch (err) {
      if (err instanceof BranchError) return fail(err.message);
      throw err;
    }
  }

  const { rows: beforeRows } = await query<{ name: string }>(
    "SELECT name FROM businesses WHERE id = $1",
    [ctx.businessId],
  );
  const beforeProfile = await getSetting<BusinessProfileBean>(ctx.businessId, SETTING_KEYS.businessProfile);
  const beforePrefs = await getSetting<BusinessPrefsBean>(ctx.businessId, SETTING_KEYS.businessPrefs);
  const beforeName = beforeRows[0]?.name;

  await query("UPDATE businesses SET name = $1 WHERE id = $2", [businessName, ctx.businessId]);
  await Promise.all([
    setSetting(ctx.businessId, SETTING_KEYS.businessPrefs, prefs),
    setSetting(ctx.businessId, SETTING_KEYS.businessProfile, profile),
  ]);

  const changed: Record<string, unknown> = {};
  if (businessName !== beforeName) changed.businessName = businessName;
  if (prefs.currencyDisplay !== beforePrefs?.currencyDisplay) changed.currencyDisplay = prefs.currencyDisplay;
  for (const key of ["legalName", "taxId", "email", "website", "receiptFooter"] as const) {
    const value = profile[key];
    if (value !== beforeProfile?.[key]) changed[key] = value ?? null;
  }
  if (Object.keys(changed).length > 0) {
    await query(
      `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, $3, 'settings.business.update', 'settings', 'business', $4)`,
      [ctx.businessId, location.id, ctx.authorizedByUserId, JSON.stringify(changed)],
    );
  }
  return { ok: true, result: { ok: true } };
};
function parseOptionalPercent(
  value: unknown,
  max: number,
): { ok: true; value: number | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= max) {
    return { ok: false };
  }
  return { ok: true, value };
}
const settingsPricingSave: AutopilotExecutor = async (ctx) => {
  const body = ctx.payload;
  const existing = await getPricingConfig(ctx.businessId);
  const defaultMarginPercent = parseOptionalPercent(
    body.defaultMarginPercent !== undefined ? body.defaultMarginPercent : existing.defaultMarginPercent,
    100,
  );
  if (!defaultMarginPercent.ok) return fail("invalid_margin");
  const fallbackOverheadPercent = parseOptionalPercent(
    body.fallbackOverheadPercent !== undefined ? body.fallbackOverheadPercent : existing.fallbackOverheadPercent,
    MAX_OVERHEAD_PERCENT,
  );
  if (!fallbackOverheadPercent.ok) return fail("invalid_overhead");
  const rawMode = body.overheadMode !== undefined ? body.overheadMode : existing.overheadMode ?? "automatic";
  if (rawMode !== "automatic" && rawMode !== "manual") return fail("invalid_overhead_mode");
  const overheadMode = rawMode;
  if (overheadMode === "manual" && fallbackOverheadPercent.value === null) {
    return fail("manual_overhead_required");
  }
  const driftCandidate =
    body.costDriftThresholdPercent !== undefined
      ? body.costDriftThresholdPercent
      : existing.costDriftThresholdPercent ?? DEFAULT_COST_DRIFT_THRESHOLD_PERCENT;
  const costDriftThresholdPercent =
    typeof driftCandidate === "number" &&
    Number.isFinite(driftCandidate) &&
    driftCandidate > 0 &&
    driftCandidate < MAX_COST_DRIFT_THRESHOLD_PERCENT
      ? driftCandidate
      : null;
  if (costDriftThresholdPercent === null) return fail("invalid_drift_threshold");
  const pricing: PricingConfig = {
    defaultMarginPercent: defaultMarginPercent.value,
    fallbackOverheadPercent: fallbackOverheadPercent.value,
    overheadMode,
    costDriftThresholdPercent,
  };
  await setPricingConfig(ctx.businessId, pricing);
  let effective: unknown = null;
  try {
    effective = await getEffectiveOverheadRate(ctx.businessId, pricing);
  } catch {
    effective = null; // explanatory status — must not block the setting save
  }
  return { ok: true, result: { ok: true, pricing, effectiveOverhead: effective } };
};
const settingsTaxSave: AutopilotExecutor = async (ctx) => {
  const defaultRate = Number(ctx.payload.defaultRate);
  if (!Number.isFinite(defaultRate) || defaultRate < 0 || defaultRate > 100) return fail("invalid_rate");
  const categories = Array.isArray(ctx.payload.categories) ? ctx.payload.categories : [];
  const parsedCategories: { id: string; taxRate: number }[] = [];
  for (const category of categories as { id?: unknown; taxRate?: unknown }[]) {
    const rate = Number(category?.taxRate);
    if (typeof category?.id !== "string" || !category.id || !Number.isFinite(rate) || rate < 0 || rate > 100) {
      return fail("invalid_category_rate");
    }
    parsedCategories.push({ id: category.id, taxRate: rate });
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO settings (business_id, location_id, key, value)
       VALUES ($1, NULL, $2, $3)
       ON CONFLICT (business_id, location_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [ctx.businessId, SETTING_KEYS.tax, JSON.stringify({ defaultRate })],
    );
    for (const category of parsedCategories) {
      await client.query(
        `UPDATE menu_categories mc
            SET tax_rate = $1
           FROM locations l
          WHERE mc.id = $2 AND l.id = mc.location_id AND l.business_id = $3`,
        [category.taxRate, category.id, ctx.businessId],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { ok: true, result: { ok: true } };
};
const settingsOnlinePlatformsSave: AutopilotExecutor = async (ctx) => {
  if (!Object.prototype.hasOwnProperty.call(ctx.payload, "snappfoodCommissionPercent")) {
    return fail("missing_fields");
  }
  let snappfood: { commissionPercent: number } | null = null;
  const rawCommission = ctx.payload.snappfoodCommissionPercent;
  if (rawCommission !== null && rawCommission !== undefined) {
    if (!validCommissionPercent(rawCommission)) {
      return { ok: false, result: { error: "invalid_commission_percent", max: MAX_ONLINE_PLATFORM_COMMISSION_PERCENT }, errorCode: "invalid_commission_percent" };
    }
    snappfood = { commissionPercent: rawCommission };
  }
  await setOnlinePlatformsConfig(ctx.businessId, { snappfood });
  return { ok: true, result: { ok: true } };
};
const settingsMfaPolicySave: AutopilotExecutor = async (ctx) => {
  // A payload that names only one knob keeps the other as it is stored.
  const current = await getMfaPolicy(ctx.businessId);
  const policy = await setMfaPolicy(ctx.businessId, {
    requireForManagers:
      typeof ctx.payload.requireForManagers === "boolean" ? ctx.payload.requireForManagers : current.requireForManagers,
    requireForAccountants:
      typeof ctx.payload.requireForAccountants === "boolean"
        ? ctx.payload.requireForAccountants
        : current.requireForAccountants,
  });
  return { ok: true, result: { policy } };
};
// The chart-of-accounts swap is the route's own guarded transaction: any
// journal line anywhere veto's it, parent/child loops and over-deep trees are
// rejected with the same Persian messages, all-or-nothing.
const settingsAccountsSave: AutopilotExecutor = async (ctx) => {
  const rawAccounts = Array.isArray(ctx.payload.accounts) ? ctx.payload.accounts : [];
  const accounts = (rawAccounts as Record<string, unknown>[]).map((account) => ({
    code: String(account?.code ?? "").trim(),
    name: String(account?.name ?? "").trim(),
    type: account?.type,
    parentCode: account?.parentCode ? String(account.parentCode).trim() : undefined,
    isContra: Boolean(account?.isContra),
  })) as Parameters<typeof validateAccounts>[0];
  const messages = validateAccounts(accounts);
  if (messages.length > 0) {
    return { ok: false, result: { error: "invalid_accounts", messages }, errorCode: "invalid_accounts" };
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: used } = await client.query(
      `SELECT 1 FROM journal_lines jl
        JOIN accounts a ON a.id = jl.account_id
       WHERE a.business_id = $1 LIMIT 1`,
      [ctx.businessId],
    );
    if (used.length > 0) {
      await client.query("ROLLBACK");
      return fail("accounts_in_use");
    }
    await client.query("DELETE FROM accounts WHERE business_id = $1", [ctx.businessId]);
    const idByCode = new Map<string, string>();
    const levelByCode = new Map<string, AccountLevel>();
    const pending = [...accounts];
    while (pending.length > 0) {
      const ready = pending.filter((account) => !account.parentCode || idByCode.has(account.parentCode));
      if (ready.length === 0) {
        await client.query("ROLLBACK");
        return {
          ok: false,
          result: { error: "invalid_accounts", messages: ["ساختار والد/فرزند حساب‌ها حلقه دارد."] },
          errorCode: "invalid_accounts",
        };
      }
      for (const account of ready) {
        const parentLevel = account.parentCode ? (levelByCode.get(account.parentCode) ?? null) : null;
        const level = nextAccountLevel(parentLevel);
        if (!level) {
          await client.query("ROLLBACK");
          return {
            ok: false,
            result: { error: "invalid_accounts", messages: ["ساختار حساب‌ها از سطح «تفصیلی» عمیق‌تر است."] },
            errorCode: "invalid_accounts",
          };
        }
        const result = await client.query(
          `INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            ctx.businessId,
            account.parentCode ? idByCode.get(account.parentCode) : null,
            account.code,
            account.name,
            account.type,
            level,
            account.isContra,
          ],
        );
        idByCode.set(account.code, result.rows[0].id);
        levelByCode.set(account.code, level);
        pending.splice(pending.indexOf(account), 1);
      }
    }
    await client.query("COMMIT");
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => {});
    throw cause;
  } finally {
    client.release();
  }
  return { ok: true, result: { ok: true, created: accounts.length } };
};

// ── Issue #883 package 2, batch BA-2 — the settings registry lanes ──────────
const paymentMethodCreate: AutopilotExecutor = async (ctx) => {
  const parsed = validatePaymentMethodInput(ctx.payload as unknown as Record<string, unknown> as PaymentMethodInput);
  if (!parsed.ok) return fail(parsed.error);
  const paymentMethod = await createPaymentMethod(ctx.businessId, parsed.value);
  return { ok: true, result: { paymentMethod } };
};
function booleanPatch(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
const paymentMethodUpdate: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const existing = (await paymentMethodsByIds(ctx.businessId, [id])).get(id);
  if (!existing) return fail("payment_method_not_found");
  const input = ctx.payload;
  const patch: PaymentMethodPatch = {};
  if (input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length > MAX_PAYMENT_METHOD_NAME) return fail("invalid_name");
    patch.name = name;
  }
  if (input.settlement !== undefined) {
    if (existing.isBuiltin) return fail("builtin_settlement_locked");
    if (!isPaymentSettlement(input.settlement) || !CUSTOM_PAYMENT_SETTLEMENTS.includes(input.settlement)) {
      return fail("invalid_settlement");
    }
    if (input.settlement !== existing.settlement && (await paymentCountForMethod(ctx.businessId, id)) > 0) {
      return fail("payment_method_settlement_locked");
    }
    patch.settlement = input.settlement;
  }
  for (const key of ["isActive", "opensDrawer", "requiresReference"] as const) {
    if (input[key] === undefined) continue;
    const value = booleanPatch(input[key]);
    if (value === null) return fail("bad_request");
    patch[key] = value;
  }
  if (Object.keys(patch).length === 0) return fail("bad_request");
  if (patch.isActive === false && existing.isActive) {
    const all = await listPaymentMethods(ctx.businessId, { includeInactive: true });
    if (!all.some((method) => method.id !== id && method.isActive)) {
      return fail("last_active_payment_method");
    }
  }
  const updated = await updatePaymentMethod(ctx.businessId, id, patch);
  if (!updated) return fail("payment_method_not_found");
  return { ok: true, result: { paymentMethod: updated } };
};
const paymentMethodDelete: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const existing = (await paymentMethodsByIds(ctx.businessId, [id])).get(id);
  if (!existing) return fail("payment_method_not_found");
  if (existing.isBuiltin) return fail("builtin_payment_method");
  if ((await paymentCountForMethod(ctx.businessId, id)) > 0) return fail("payment_method_in_use");
  if (existing.isActive) {
    const all = await listPaymentMethods(ctx.businessId, { includeInactive: true });
    if (!all.some((method) => method.id !== id && method.isActive)) {
      return fail("last_active_payment_method");
    }
  }
  const deleted = await deletePaymentMethod(ctx.businessId, id);
  if (!deleted) {
    if ((await paymentCountForMethod(ctx.businessId, id)) > 0) return fail("payment_method_in_use");
    return fail("payment_method_not_found");
  }
  return { ok: true, result: { ok: true } };
};
const paymentMethodReorder: AutopilotExecutor = async (ctx) => {
  const order = ctx.payload.order;
  if (!Array.isArray(order) || order.some((id) => typeof id !== "string")) return fail("bad_request");
  if (!(await reorderPaymentMethods(ctx.businessId, order as string[]))) {
    return fail("invalid_payment_method_order");
  }
  return { ok: true, result: { paymentMethods: await listPaymentMethods(ctx.businessId, { includeInactive: true }) } };
};
// Printers/Templates/Rules resolve the ACTIVE branch the same way their
// routes do (the settings screens operate per branch).
async function settingsActiveLocation(ctx: AutopilotExecutorContext) {
  if (!ctx.authorizedByUserId) return null;
  return resolveActiveLocation({
    sub: ctx.authorizedByUserId,
    businessId: ctx.businessId,
    locationId: null,
  } as SessionPayload);
}
const printerCreate: AutopilotExecutor = async (ctx) => {
  const input = parsePrinterInput(ctx.payload as unknown as Record<string, unknown>);
  if (!input) return fail("invalid_printer");
  const location = await settingsActiveLocation(ctx);
  if (!location) return fail("no_location");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (input.isDefault) {
      await client.query(
        `UPDATE printers SET is_default = false WHERE location_id = $1 AND kind = $2`,
        [location.id, input.kind],
      );
    }
    const { rows } = await client.query(
      `INSERT INTO printers
         (location_id, name, kind, connection, is_active, printer_class, supports_drawer, supports_cut, is_default, paper, paper_width_mm)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${PRINTER_COLUMNS}`,
      [
        location.id,
        input.name,
        input.kind,
        JSON.stringify(connectionJsonOf(input.connection)),
        input.isActive,
        input.printerClass,
        input.openDrawer,
        input.supportsCut,
        input.isDefault,
        input.paper,
        input.paperWidthMm,
      ],
    );
    await client.query("COMMIT");
    return { ok: true, result: { printer: rows[0] } };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return fail("printer_save_failed");
  } finally {
    client.release();
  }
};
const printerUpdate: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const location = await settingsActiveLocation(ctx);
  if (!location) return fail("no_location");
  const { rows: existingRows } = await query<{
    id: string; name: string; kind: ExistingPrinter["kind"]; connection: Record<string, unknown>; is_active: boolean;
    paper: string | null; paper_width_mm: number | null; supports_drawer: boolean | null;
    supports_cut: boolean | null; is_default: boolean | null;
  }>(
    `SELECT ${PRINTER_COLUMNS} FROM printers WHERE id = $1 AND location_id = $2`,
    [id, location.id],
  );
  const existing = existingRows[0] as (typeof existingRows)[number] | undefined;
  if (!existing) return fail("printer_not_found");
  const fallback: ExistingPrinter = {
    name: existing.name,
    kind: existing.kind,
    connection: existing.connection,
    is_active: existing.is_active,
    paper: existing.paper ?? null,
    paper_width_mm: existing.paper_width_mm ?? null,
    supports_drawer: existing.supports_drawer ?? null,
    supports_cut: existing.supports_cut ?? null,
    is_default: existing.is_default ?? null,
  };
  const patch = { ...ctx.payload };
  delete patch.id;
  const input = parsePrinterInput(patch as unknown as Record<string, unknown>, fallback);
  if (!input) return fail("invalid_printer");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (input.isDefault) {
      await client.query(
        `UPDATE printers SET is_default = false WHERE location_id = $1 AND kind = $2 AND id <> $3`,
        [location.id, input.kind, id],
      );
    }
    const { rows } = await client.query(
      `UPDATE printers
          SET name = $1, kind = $2, connection = $3, is_active = $4,
              printer_class = $5, supports_drawer = $6, supports_cut = $7,
              is_default = $8, paper = $9, paper_width_mm = $10
        WHERE id = $11 AND location_id = $12
        RETURNING ${PRINTER_COLUMNS}`,
      [
        input.name,
        input.kind,
        JSON.stringify(connectionJsonOf(input.connection)),
        input.isActive,
        input.printerClass,
        input.openDrawer,
        input.supportsCut,
        input.isDefault,
        input.paper,
        input.paperWidthMm,
        id,
        location.id,
      ],
    );
    await client.query("COMMIT");
    if (rows.length === 0) return fail("printer_not_found");
    return { ok: true, result: { printer: rows[0] } };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return fail("printer_save_failed");
  } finally {
    client.release();
  }
};
const printerDelete: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const location = await settingsActiveLocation(ctx);
  if (!location) return fail("no_location");
  const { rows } = await query("DELETE FROM printers WHERE id = $1 AND location_id = $2 RETURNING id", [id, location.id]);
  if (rows.length === 0) return fail("printer_not_found");
  return { ok: true, result: { ok: true } };
};
const printTemplateSave: AutopilotExecutor = async (ctx) => {
  const location = await settingsActiveLocation(ctx);
  if (!location) return fail("no_location");
  const id = str(ctx.payload.id);
  if (id) {
    const result = await updatePrintTemplate({
      locationId: location.id,
      id,
      template: ctx.payload.template,
      isDefault: typeof ctx.payload.isDefault === "boolean" ? ctx.payload.isDefault : undefined,
    });
    if (result.error) return fail(result.error);
    return { ok: true, result: { template: result.template } };
  }
  const result = await createPrintTemplate({
    locationId: location.id,
    template: ctx.payload.template,
    isDefault: ctx.payload.isDefault === true,
  });
  if (result.error) return fail(result.error);
  return { ok: true, result: { template: result.template } };
};
const printTemplateDelete: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const location = await settingsActiveLocation(ctx);
  if (!location) return fail("no_location");
  const removed = await deletePrintTemplate(location.id, id);
  if (!removed) return fail("template_not_found");
  return { ok: true, result: { ok: true } };
};
const settingsPrintRulesSave: AutopilotExecutor = async (ctx) => {
  const location = await settingsActiveLocation(ctx);
  if (!location) return fail("no_location");
  if (!isDocType(ctx.payload.documentType)) return fail("bad_request");
  const documentType = ctx.payload.documentType;
  let templateKey: string | null = null;
  let templateId: string | null = null;
  const requestedId = typeof ctx.payload.templateId === "string" && ctx.payload.templateId.trim() ? ctx.payload.templateId.trim() : null;
  const requestedKey = typeof ctx.payload.templateKey === "string" && ctx.payload.templateKey.trim() ? ctx.payload.templateKey.trim() : null;
  if (requestedId) {
    const saved = await getPrintTemplate(location.id, requestedId);
    if (!saved) return fail("template_not_found");
    if (saved.docType !== documentType) return fail("incompatible_template");
    templateId = saved.id;
  } else if (requestedKey) {
    const builtIn = builtInTemplate(requestedKey);
    if (builtIn) {
      if (builtIn.docType !== documentType) return fail("incompatible_template");
      templateKey = builtIn.key;
    } else {
      const saved = await getPrintTemplate(location.id, requestedKey);
      if (!saved) return fail("template_not_found");
      if (saved.docType !== documentType) return fail("incompatible_template");
      templateId = saved.id;
    }
  }
  const { routable } = await loadRoutablePrinters(location.id);
  const printerId = typeof ctx.payload.printerId === "string" && ctx.payload.printerId ? ctx.payload.printerId : null;
  const rawFallbackPrinterId =
    typeof ctx.payload.fallbackPrinterId === "string" && ctx.payload.fallbackPrinterId ? ctx.payload.fallbackPrinterId : null;
  const printerError = (id: string | null, role: "primary" | "fallback"): AutopilotExecutionResult | null => {
    if (!id) return null;
    const printer = routable.find((item) => item.id === id);
    if (!printer) return { ok: false, result: { error: "printer_not_found", role }, errorCode: "printer_not_found" };
    if (!printerAcceptsDocument(printer, documentType)) {
      return { ok: false, result: { error: "incompatible_printer", role, printerName: printer.name }, errorCode: "incompatible_printer" };
    }
    return null;
  };
  const primaryError = printerError(printerId, "primary");
  if (primaryError) return primaryError;
  const fallbackError = printerError(rawFallbackPrinterId, "fallback");
  if (fallbackError) return fallbackError;
  if (printerId && rawFallbackPrinterId && printerId === rawFallbackPrinterId) {
    return fail("duplicate_fallback_printer");
  }
  const fallbackPrinterId = printerId ? rawFallbackPrinterId : null;
  try {
    await query(
      `INSERT INTO print_rules (location_id, document_type, template_key, template_id, printer_id, fallback_printer_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (location_id, document_type) DO UPDATE
         SET template_key = EXCLUDED.template_key,
             template_id = EXCLUDED.template_id,
             printer_id = EXCLUDED.printer_id,
             fallback_printer_id = EXCLUDED.fallback_printer_id,
             updated_at = now()`,
      [location.id, documentType, templateKey, templateId, printerId, fallbackPrinterId],
    );
    return { ok: true, result: { ok: true, rule: { documentType, templateKey, templateId, printerId, fallbackPrinterId } } };
  } catch {
    return fail("print_rules_failed");
  }
};

// ── Issue #883 package 2, batch BB — the verb-shaped integration lanes ──────
// Connection provisioning/migration never maps onto MCP: those payloads carry
// SQL credentials, link tokens and desktop keys (config.data's provider row
// carries the same design note). What follows is the operational half the
// routes expose as plain buttons.
const integrationsSyncProducts: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.connectionId);
  if (!id) return fail("missing_fields");
  const connection = await getConnection(ctx.businessId, id);
  if (!connection || connection.provider !== "woocommerce") return fail("not_found");
  if (!connection.sync_products) return fail("sync_products_disabled");
  if (connection.status === "paused") return fail("connection_paused");
  if (connection.link_mode === "plugin") {
    await enqueuePluginExport(ctx.businessId, id, "catalogue_export");
    await enqueueContentExport(ctx.businessId, id);
    return { ok: true, result: { ok: true, queued: true } };
  }
  try {
    const outcome = await syncProducts(ctx.businessId, id);
    try {
      await syncWpContentRest(connection, wooClientFor(connection));
    } catch (err) {
      return { ok: true, result: { ok: true, ...outcome, contentError: (err as Error).message } };
    }
    return { ok: true, result: { ok: true, ...outcome } };
  } catch (err) {
    if ((err as Error).message === "not_found") return fail("not_found");
    return fail((err as Error).message);
  }
};
const integrationsSyncOrders: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.connectionId);
  if (!id) return fail("missing_fields");
  const connection = await getConnection(ctx.businessId, id);
  if (!connection || connection.provider !== "woocommerce") return fail("not_found");
  if (!connection.sync_orders) return fail("sync_orders_disabled");
  if (connection.status === "paused") return fail("connection_paused");
  let sinceDays: number | undefined;
  if (typeof ctx.payload.sinceDays === "number" && Number.isFinite(ctx.payload.sinceDays)) {
    sinceDays = Math.min(365, Math.max(1, Math.round(ctx.payload.sinceDays)));
  }
  if (connection.link_mode === "plugin") {
    await enqueueExport(ctx.businessId, id, "orders_export", sinceDays === undefined ? {} : { sinceDays });
    return { ok: true, result: { ok: true, queued: true } };
  }
  try {
    const outcome = await syncOrders(ctx.businessId, id, sinceDays === undefined ? {} : { sinceDays });
    return { ok: true, result: { ok: true, ...outcome } };
  } catch (err) {
    if ((err as Error).message === "not_found") return fail("not_found");
    return fail((err as Error).message);
  }
};
const integrationsSyncCustomers: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.connectionId);
  if (!id) return fail("missing_fields");
  const connection = await getConnection(ctx.businessId, id);
  if (!connection || connection.provider !== "woocommerce") return fail("not_found");
  if (!connection.sync_customers) return fail("sync_customers_disabled");
  if (connection.status === "paused") return fail("connection_paused");
  if (connection.link_mode === "plugin") {
    await enqueuePluginExport(ctx.businessId, id, "customer_export");
    return { ok: true, result: { ok: true, queued: true } };
  }
  try {
    const outcome = await syncCustomers(ctx.businessId, id);
    return { ok: true, result: { ok: true, ...outcome } };
  } catch (err) {
    if ((err as Error).message === "not_found") return fail("not_found");
    return fail((err as Error).message);
  }
};
const integrationsSyncInventory: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.connectionId);
  if (!id) return fail("missing_fields");
  const connection = await getConnection(ctx.businessId, id);
  if (!connection) return fail("not_found");
  try {
    await refreshOutboxForConnection(connection);
    if (connection.link_mode === "plugin") {
      return { ok: true, result: { ok: true, queued: true } };
    }
    await drainOutbox(connection);
    return { ok: true, result: { ok: true } };
  } catch (err) {
    return fail((err as Error).message);
  }
};
const integrationsConnectionTest: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.connectionId);
  if (!id) return fail("missing_fields");
  const connection = await getConnection(ctx.businessId, id);
  if (!connection) return fail("not_found");
  if (isHoloo(connection)) {
    const result = await testHolooConnection(ctx.businessId, id);
    if (!result.ok) return fail(result.error ?? "integration_test_failed");
    return {
      ok: true,
      result: {
        ok: true,
        version: result.version,
        fingerprint: result.fingerprint,
        profile: result.profile ?? null,
        diagnostics: result.diagnostics ?? [],
        migrationReady: Boolean(result.profile),
      },
    };
  }
  const result = await testConnection(ctx.businessId, id);
  if (!result.ok) return fail(result.error ?? "integration_test_failed");
  return { ok: true, result: { ok: true } };
};

// ── Issue #883 package 2, batch BC — the secretless CMS ops ─────────────────
const websiteSetupSave: AutopilotExecutor = async (ctx) => {
  const patch = copyIfDefined({}, ctx.payload, [
    "domain", "domainMode", "domainYears", "cdnProvider", "cdnStatus", "cdnNote",
    "siteType", "siteName", "planKey",
  ]) as unknown as WebsiteSetupPatch;
  const result = await saveWebsiteSetup(ctx.businessId, patch);
  if (!result.ok) return fail(result.error);
  return { ok: true, result: { setup: result.data } };
};
const websiteDesignThemeSave: AutopilotExecutor = async (ctx) => {
  const result = await saveOwnerThemeSettings(ctx.businessId, {
    values:
      ctx.payload.values && typeof ctx.payload.values === "object" && !Array.isArray(ctx.payload.values)
        ? (ctx.payload.values as Record<string, string>)
        : undefined,
    clear: Array.isArray(ctx.payload.clear)
      ? ctx.payload.clear.filter((v): v is string => typeof v === "string")
      : undefined,
  });
  if (!result.ok) return fail(result.error);
  return { ok: true, result: { settings: result.data } };
};
const websiteCdnPurge: AutopilotExecutor = async (ctx) => {
  const urls =
    Array.isArray(ctx.payload.urls) && ctx.payload.urls.every((url) => typeof url === "string")
      ? (ctx.payload.urls as string[])
      : undefined;
  const result = await cmsPurgeCdn(ctx.businessId, urls);
  if (!result.ok) return fail(result.error);
  return { ok: true, result: { ok: true } };
};

// ── Issue #883 package 2, batch BD — the CMS content-record verbs ───────────
const websiteProductCreate: AutopilotExecutor = async (ctx) => {
  const result = await createCmsProduct(ctx.businessId, {
    title: typeof ctx.payload.title === "string" ? ctx.payload.title : "",
    price: typeof ctx.payload.price === "number" ? ctx.payload.price : NaN,
    summary: typeof ctx.payload.summary === "string" ? ctx.payload.summary : undefined,
    image: typeof ctx.payload.image === "string" ? ctx.payload.image : undefined,
    sku: typeof ctx.payload.sku === "string" ? ctx.payload.sku : undefined,
    trackInventory: typeof ctx.payload.trackInventory === "boolean" ? ctx.payload.trackInventory : undefined,
    inventory: typeof ctx.payload.inventory === "number" ? ctx.payload.inventory : undefined,
    compareAtPrice: typeof ctx.payload.compareAtPrice === "number" ? ctx.payload.compareAtPrice : undefined,
  });
  if (!result.ok) return fail(result.error);
  return { ok: true, result: { product: result.data } };
};
const websiteProductUpdate: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const result = await updateCmsProduct(ctx.businessId, id, {
    ...(typeof ctx.payload.title === "string" ? { title: ctx.payload.title } : {}),
    ...(typeof ctx.payload.price === "number" ? { price: ctx.payload.price } : {}),
    ...(typeof ctx.payload.summary === "string" ? { summary: ctx.payload.summary } : {}),
    ...(typeof ctx.payload.image === "string" ? { image: ctx.payload.image } : {}),
    ...(typeof ctx.payload.sku === "string" ? { sku: ctx.payload.sku } : {}),
    ...(typeof ctx.payload.trackInventory === "boolean" ? { trackInventory: ctx.payload.trackInventory } : {}),
    ...(typeof ctx.payload.inventory === "number" ? { inventory: ctx.payload.inventory } : {}),
    ...(typeof ctx.payload.compareAtPrice === "number" ? { compareAtPrice: ctx.payload.compareAtPrice } : {}),
  });
  if (!result.ok) return fail(result.error);
  return { ok: true, result: { product: result.data } };
};
const websiteProductDelete: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const result = await deleteCmsProduct(ctx.businessId, id);
  if (!result.ok) return fail(result.error);
  return { ok: true, result: { deleted: true } };
};
const websitePostDelete: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const result = await deleteCmsPost(ctx.businessId, id);
  if (!result.ok) return fail(result.error);
  return { ok: true, result: { deleted: true } };
};
const websiteMediaUpdate: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id || typeof ctx.payload.alt !== "string") return fail("bad_request");
  const result = await updateCmsMediaAlt(ctx.businessId, id, ctx.payload.alt);
  if (!result.ok) return fail(result.error);
  return { ok: true, result: { media: result.data } };
};
const websiteMediaDelete: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const force = ctx.payload.force === true;
  const result = await deleteCmsMedia(ctx.businessId, id);
  if (!result.ok) {
    if (!force && result.error === "cms_error") {
      return {
        ok: false,
        result: { error: "media_in_use", message: "این فایل ممکن است در صفحه یا محصولی استفاده شده باشد." },
        errorCode: "media_in_use",
      };
    }
    return fail(result.error);
  }
  return { ok: true, result: { deleted: true } };
};

// ── Issue #883 package 2, batch BE — the WooCommerce manager ────────────────
const wpContentSync: AutopilotExecutor = async (ctx) => {
  const connectionId = str(ctx.payload.connectionId);
  if (!connectionId) return fail("missing_connection");
  const connection = await getConnection(ctx.businessId, connectionId);
  if (!connection || connection.provider !== "woocommerce") return fail("not_found");
  if (connection.status === "paused") return fail("connection_paused");
  if (connection.link_mode === "plugin") {
    await enqueueContentExport(ctx.businessId, connectionId);
    return { ok: true, result: { ok: true, queued: true } };
  }
  try {
    const client = wooClientFor(connection);
    const outcome = await syncWpContentRest(connection, client);
    return { ok: true, result: { ok: true, ...outcome } };
  } catch (err) {
    return fail((err as Error).message);
  }
};
const WP_CONTENT_FIELDS = ["title", "content", "excerpt", "slug", "status"] as const;
const WP_ALLOWED_STATUS = ["publish", "draft", "pending", "private", "future"] as const;
const WP_FIELD_LIMITS: Partial<Record<(typeof WP_CONTENT_FIELDS)[number], number>> = {
  title: 500,
  slug: 200,
  excerpt: 20_000,
  content: 1_500_000,
};
const wpPostSave: AutopilotExecutor = async (ctx) => {
  const connectionId = str(ctx.payload.connectionId);
  if (!connectionId) return fail("missing_connection");
  if (ctx.payload.post_type !== "post" && ctx.payload.post_type !== "page") {
    return fail("invalid_content_type");
  }
  const postType = ctx.payload.post_type;
  const remoteId = ctx.payload.id === undefined ? undefined : String(ctx.payload.id).trim();
  const numericRemoteId = remoteId === undefined ? undefined : Number(remoteId);
  if (remoteId !== undefined && (!/^[1-9]\d*$/.test(remoteId) || !Number.isSafeInteger(numericRemoteId) || (numericRemoteId ?? 0) <= 0)) {
    return fail("invalid_id");
  }
  const body = ctx.payload as unknown as Record<string, unknown>;
  const patch: Record<string, string> = {};
  for (const field of WP_CONTENT_FIELDS) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== "string") return fail("invalid_field");
    const value = body[field] as string;
    const limit = WP_FIELD_LIMITS[field];
    if (limit && value.length > limit) return fail(`${field}_too_long`);
    patch[field] = value;
  }
  if (patch.status && !(WP_ALLOWED_STATUS as readonly string[]).includes(patch.status)) {
    return fail("invalid_status");
  }
  if (Object.keys(patch).length === 0) return fail("empty_patch");
  if (!remoteId && !patch.title?.trim()) return fail("title_required");
  if (patch.title !== undefined && !patch.title.trim()) return fail("title_required");

  const connection = await getConnection(ctx.businessId, connectionId);
  if (!connection || connection.provider !== "woocommerce") return fail("not_found");
  if (connection.status === "paused") return fail("connection_paused");

  if (connection.link_mode === "plugin") {
    // Same stranded-job rule as the route: queueing post_upsert past an older
    // plugin leaves a row nothing ever picks up — refuse honestly.
    if (!pluginSupportsJobType(connection.plugin_capabilities, "post_upsert")) {
      return fail("plugin_content_unsupported");
    }
    const outboxRemoteId = remoteId ?? `new-${randomUUID()}`;
    const operationId = remoteId ? null : `wp-post:${connectionId}:${outboxRemoteId}`;
    const jobPayload = { ...patch, post_type: postType, ...(remoteId ? { id: remoteId } : {}), ...(operationId ? { __operationId: operationId } : {}) };
    await query(
      `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload, operation_id)
       VALUES ($1, $2, 'post_upsert', $3, $4::jsonb, $5)
       ON CONFLICT (connection_id, entity_type, remote_id)
       DO UPDATE SET payload = EXCLUDED.payload, operation_id = COALESCE(integration_outbox_events.operation_id, EXCLUDED.operation_id), status = 'pending', attempts = 0,
                     next_attempt_at = now(), last_error = NULL, leased_until = NULL, updated_at = now()`,
      [ctx.businessId, connectionId, outboxRemoteId, JSON.stringify(jobPayload), operationId],
    );
    await writeIntegrationAudit({
      businessId: ctx.businessId,
      connectionId,
      action: "content.post_upsert_queued",
      entityType: "post_upsert",
      remoteId: outboxRemoteId,
    });
    return { ok: true, result: { ok: true, queued: true } };
  }

  try {
    const client = wooClientFor(connection);
    const wpEndpoint = postType === "page" ? "pages" : "posts";
    const result = await client.wpUpsertPost(wpEndpoint, patch, numericRemoteId);
    const savedId = String(result.id ?? numericRemoteId ?? "");
    if (!/^[1-9]\d*$/.test(savedId)) throw new Error("invalid_wordpress_response");
    const resultPayload = {
      ...result,
      type: typeof result.type === "string" ? result.type : postType,
      id: savedId,
    } as WpContentPayload;
    await upsertWpContent(connection, resultPayload);
    await writeIntegrationAudit({
      businessId: ctx.businessId,
      connectionId,
      action: "content.post_saved",
      entityType: postType,
      remoteId: savedId,
    });
    return { ok: true, result: { ok: true, queued: false, remoteId: savedId } };
  } catch (err) {
    return fail((err as Error).message);
  }
};
const wpMediaCreate: AutopilotExecutor = async (ctx) => {
  const connectionId = str(ctx.payload.connectionId);
  if (!connectionId) return fail("missing_connection");
  const parsed = parseWpMediaCreateInput(ctx.payload as unknown as Record<string, unknown>);
  if (!parsed.ok) return fail(parsed.error);
  const connection = await getConnection(ctx.businessId, connectionId);
  if (!connection || connection.provider !== "woocommerce") return fail("not_found");
  if (connection.status === "paused") return fail("connection_paused");
  if (connection.link_mode !== "plugin") return fail("media_rest_unsupported");
  if (!pluginSupportsJobType(connection.plugin_capabilities, "media_create")) {
    return fail("plugin_media_unsupported");
  }
  const outboxRemoteId = `new-${randomUUID()}`;
  const operationId = `wp-media:${connectionId}:${outboxRemoteId}`;
  const jobPayload = {
    url: parsed.input.url,
    ...(parsed.input.title ? { title: parsed.input.title } : {}),
    __operationId: operationId,
  };
  await query(
    `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload, operation_id)
     VALUES ($1, $2, 'media_create', $3, $4::jsonb, $5)`,
    [ctx.businessId, connectionId, outboxRemoteId, JSON.stringify(jobPayload), operationId],
  );
  await writeIntegrationAudit({
    businessId: ctx.businessId,
    connectionId,
    action: "content.media_create_queued",
    entityType: "media_create",
    remoteId: outboxRemoteId,
  });
  return { ok: true, result: { ok: true, queued: true } };
};

// ── Issue #883 package 2, batch BF — the misc row's plain ops ───────────────
const commissionRuleSave: AutopilotExecutor = async (ctx) => {
  const body = ctx.payload as unknown as CommissionRuleInput;
  if (!body.employeeId || !body.kind || !body.basis) return fail("missing_fields");
  try {
    const rule = await upsertCommissionRule(ctx.businessId, body);
    return { ok: true, result: { ok: true, rule } };
  } catch (err) {
    return { ok: false, result: { error: "validation_failed", message: (err as Error).message }, errorCode: "validation_failed" };
  }
};
const commissionRuleSetActive: AutopilotExecutor = async (ctx) => {
  const ruleId = str(ctx.payload.ruleId);
  if (!ruleId || typeof ctx.payload.isActive !== "boolean") return fail("missing_fields");
  try {
    await setCommissionRuleActive(ctx.businessId, ruleId, ctx.payload.isActive);
    return { ok: true, result: { ok: true } };
  } catch (err) {
    return { ok: false, result: { error: "not_found", message: (err as Error).message }, errorCode: "not_found" };
  }
};
const courierCreate: AutopilotExecutor = async (ctx) => {
  const location = await settingsActiveLocation(ctx);
  if (!location) return fail("no_location");
  const result = await createCourier(location.id, {
    name: str(ctx.payload.name) ?? "",
    phone: str(ctx.payload.phone),
  });
  if (!result.ok) return fail(result.error);
  return { ok: true, result: { ok: true, courier: result.data } };
};
const courierSetActive: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id || typeof ctx.payload.isActive !== "boolean") return fail("bad_request");
  const location = await settingsActiveLocation(ctx);
  if (!location) return fail("no_location");
  const result = await setCourierActive(location.id, id, ctx.payload.isActive);
  if (!result.ok) return fail(result.error);
  return { ok: true, result: { ok: true, courier: result.data } };
};
const deliveryAssign: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const location = await settingsActiveLocation(ctx);
  if (!location) return fail("no_location");
  const courierId = typeof ctx.payload.courierId === "string" ? ctx.payload.courierId : null;
  const result = await assignCourier(location.id, id, courierId);
  if (!result.ok) return fail(result.error);
  broadcast(location.id, { type: "order.updated", orderId: result.data.order_id });
  return { ok: true, result: { ok: true, delivery: result.data } };
};
const deliveryStatusSet: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  if (typeof ctx.payload.status !== "string" || !isDeliveryStatus(ctx.payload.status)) return fail("invalid_delivery_status");
  const status = ctx.payload.status;
  const location = await settingsActiveLocation(ctx);
  if (!location) return fail("no_location");
  const result = await transitionDelivery(location.id, id, status);
  if (!result.ok) return fail(result.error);
  broadcast(location.id, { type: "order.updated", orderId: result.data.order_id });
  return { ok: true, result: { ok: true, delivery: result.data } };
};
const businessDayClose: AutopilotExecutor = async (ctx) => {
  const location = await settingsActiveLocation(ctx);
  if (!location) return fail("no_location");
  try {
    const businessDay = await closeBusinessDay(
      location.id,
      ctx.businessId,
      ctx.authorizedByUserId ?? "",
      (typeof ctx.payload.note === "string" ? ctx.payload.note.trim() : "") || null,
    );
    return { ok: true, result: { businessDay } };
  } catch (err) {
    if (err instanceof BusinessDayError) return fail(err.message);
    throw err;
  }
};
const businessDayReopen: AutopilotExecutor = async (ctx) => {
  const location = await settingsActiveLocation(ctx);
  if (!location) return fail("no_location");
  try {
    const businessDay = await reopenBusinessDay(location.id, ctx.businessId, ctx.authorizedByUserId ?? "");
    return { ok: true, result: { businessDay } };
  } catch (err) {
    if (err instanceof BusinessDayError) return fail(err.message);
    throw err;
  }
};
const businessDayConfigSave: AutopilotExecutor = async (ctx) => {
  let startMinutes: number | null;
  if (ctx.payload.startTime !== undefined) {
    const text = (typeof ctx.payload.startTime === "string" ? ctx.payload.startTime : "").trim();
    if (text === "") {
      startMinutes = null;
    } else {
      const parsed = parseStartTime(text);
      if (parsed === null) return fail("invalid_start_time");
      startMinutes = parsed;
    }
  } else if (ctx.payload.startMinutes === null) {
    startMinutes = null;
  } else if (isValidStartMinutes(ctx.payload.startMinutes)) {
    startMinutes = ctx.payload.startMinutes as number;
  } else {
    return fail("invalid_start_time");
  }
  const location = await settingsActiveLocation(ctx);
  if (!location) return fail("no_location");
  try {
    const businessDay = await setBusinessDayStart(location.id, ctx.businessId, ctx.authorizedByUserId ?? "", startMinutes);
    return { ok: true, result: { businessDay } };
  } catch (err) {
    if (err instanceof BusinessDayError) return fail(err.message);
    throw err;
  }
};
const rollupPush: AutopilotExecutor = async (ctx) => {
  const result = await runRollupPush(ctx.businessId);
  return { ok: true, result: { result } };
};
const rollupLocationSetActive: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id || typeof ctx.payload.isActive !== "boolean") return fail("missing_fields");
  const updated = await setRollupLocationActive(ctx.businessId, id, ctx.payload.isActive);
  if (!updated) return fail("not_found");
  return { ok: true, result: { ok: true } };
};

// ── Issue #883 package 2, batch BG — stock-item masters ─────────────────────
async function inventoryOwnedItemLocation(ctx: AutopilotExecutorContext, id: string) {
  const location = await settingsActiveLocation(ctx);
  if (!location) return null;
  const { rows } = await query<{ id: string }>("SELECT id FROM inventory_items WHERE id = $1 AND location_id = $2", [id, location.id]);
  return rows[0] ? location : null;
}
const inventoryItemSave: AutopilotExecutor = async (ctx) => {
  const body = ctx.payload;
  const id = str(body.id);
  if (!id) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const unit = typeof body.unit === "string" ? body.unit.trim() : "";
    if (!name || !unit) return fail("missing_fields");
    if (
      (body.sku !== undefined && body.sku !== null && typeof body.sku !== "string") ||
      (body.purchaseUnit !== undefined && body.purchaseUnit !== null && typeof body.purchaseUnit !== "string")
    ) {
      return fail("bad_request");
    }
    const reorderLevel = body.reorderLevel === undefined || body.reorderLevel === null ? null : Number(body.reorderLevel);
    if (reorderLevel !== null && (!Number.isFinite(reorderLevel) || reorderLevel < 0)) {
      return fail("invalid_reorder_level");
    }
    const purchaseUnitFactor = body.purchaseUnitFactor === undefined ? 1 : Number(body.purchaseUnitFactor);
    if (!Number.isFinite(purchaseUnitFactor) || purchaseUnitFactor <= 0) {
      return fail("invalid_purchase_unit_factor");
    }
    const location = await settingsActiveLocation(ctx);
    if (!location) return fail("no_location");
    const { rows } = await query<{ id: string }>(
      `INSERT INTO inventory_items (location_id, name, sku, unit, reorder_level, purchase_unit, purchase_unit_factor)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        location.id,
        name,
        typeof body.sku === "string" ? body.sku.trim() || null : null,
        unit,
        reorderLevel,
        typeof body.purchaseUnit === "string" ? body.purchaseUnit.trim() || null : null,
        purchaseUnitFactor,
      ],
    );
    return { ok: true, result: { ok: true, id: rows[0].id } };
  }

  const location = await inventoryOwnedItemLocation(ctx, id);
  if (!location) return fail("item_not_found");
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const setField = (col: string, val: unknown) => {
    fields.push(`${col} = $${++i}`);
    values.push(val);
  };
  if (body.name !== undefined) {
    if (typeof body.name !== "string") return fail("bad_request");
    const name = body.name.trim();
    if (!name) return fail("missing_fields");
    setField("name", name);
  }
  if (body.unit !== undefined) {
    if (typeof body.unit !== "string") return fail("bad_request");
    const unit = body.unit.trim();
    if (!unit) return fail("missing_fields");
    setField("unit", unit);
  }
  if (body.sku !== undefined) {
    if (body.sku !== null && typeof body.sku !== "string") return fail("bad_request");
    setField("sku", body.sku?.trim() || null);
  }
  if (body.reorderLevel !== undefined) {
    const reorderLevel = body.reorderLevel === null ? null : Number(body.reorderLevel);
    if (reorderLevel !== null && (!Number.isFinite(reorderLevel) || reorderLevel < 0)) {
      return fail("invalid_reorder_level");
    }
    setField("reorder_level", reorderLevel);
  }
  if (body.purchaseUnit !== undefined) {
    if (body.purchaseUnit !== null && typeof body.purchaseUnit !== "string") return fail("bad_request");
    setField("purchase_unit", body.purchaseUnit?.trim() || null);
  }
  if (body.purchaseUnitFactor !== undefined) {
    const factor = Number(body.purchaseUnitFactor);
    if (!Number.isFinite(factor) || factor <= 0) {
      return fail("invalid_purchase_unit_factor");
    }
    setField("purchase_unit_factor", factor);
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") return fail("bad_request");
    setField("is_active", body.isActive);
  }
  if (body.imageMediaId !== undefined) {
    if (body.imageMediaId) {
      const { rows: media } = await query(
        "SELECT id FROM media_assets WHERE id = $1 AND kind = 'image'",
        [body.imageMediaId],
      );
      if (media.length === 0) return fail("bad_request");
    }
    setField("image_media_id", body.imageMediaId || null);
  }
  if (fields.length === 0) return fail("bad_request");
  await query(`UPDATE inventory_items SET ${fields.join(", ")} WHERE id = $1`, [id, ...values]);
  return { ok: true, result: { ok: true } };
};
const inventoryItemDelete: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const location = await inventoryOwnedItemLocation(ctx, id);
  if (!location) return fail("item_not_found");
  const { rows: refs } = await query(
    `SELECT 1 FROM menu_item_ingredients WHERE inventory_item_id = $1
     UNION ALL SELECT 1 FROM modifier_ingredients WHERE inventory_item_id = $1
     UNION ALL SELECT 1 FROM stock_movements WHERE inventory_item_id = $1
     LIMIT 1`,
    [id],
  );
  if (refs.length > 0) {
    await query("UPDATE inventory_items SET is_active = false WHERE id = $1", [id]);
    return { ok: true, result: { ok: true, deactivated: true } };
  }
  await query("DELETE FROM inventory_items WHERE id = $1", [id]);
  return { ok: true, result: { ok: true, deactivated: false } };
};

// ── Issue #883 package 2, batch AQ — workspace projects close + contracts ─
// Every lane mirrors its route: the workspace engine key is the MCP
// capability; requireProjectCapability/resolveWorkspaceSubject re-runs the
// project/subject second half the routes do, on the authorizing user's
// rebuilt access flags. WorkspaceError codes pass through verbatim.
const projectMemberSet: AutopilotExecutor = async (ctx) => {
  const projectId = str(ctx.payload.projectId) ?? str(ctx.payload.id);
  const userId = str(ctx.payload.userId);
  if (!projectId || !userId) return fail("missing_fields");
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    await requireProjectCapability(owner, projectId, "manage");
    const members = await setMember(owner, projectId, userId, str(ctx.payload.role) ?? "viewer");
    return { ok: true, result: { members } };
  } catch (err) {
    if (err instanceof WorkspaceError) return fail(err.code);
    throw err;
  }
};
const projectMemberRemove: AutopilotExecutor = async (ctx) => {
  const projectId = str(ctx.payload.projectId) ?? str(ctx.payload.id);
  const userId = str(ctx.payload.userId);
  if (!projectId || !userId) return fail("missing_fields");
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    await requireProjectCapability(owner, projectId, "manage");
    const members = await removeMember(owner, projectId, userId);
    return { ok: true, result: { members } };
  } catch (err) {
    if (err instanceof WorkspaceError) return fail(err.code);
    throw err;
  }
};
const projectPhaseCreate: AutopilotExecutor = async (ctx) => {
  const projectId = str(ctx.payload.projectId) ?? str(ctx.payload.id);
  if (!projectId) return fail("missing_fields");
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    await requireProjectCapability(owner, projectId, "manage");
    const templateKey = str(ctx.payload.templateKey);
    if (templateKey) {
      const templates = await listTemplates(ctx.businessId);
      const template = templates.find((t) => t.key === templateKey);
      if (!template) return fail("template_not_found");
      const project = await getWorkspaceProject(ctx.businessId, projectId);
      const mode = ctx.payload.mode === "replace" ? "replace" : "merge";
      const dryRun = ctx.payload.dryRun === true;
      const plan = await applyTemplate(owner, projectId, template, project?.startDate ?? null, { mode, dryRun });
      if (dryRun) return { ok: true, result: { plan } };
      return { ok: true, result: { phases: await listPhases(projectId), plan } };
    }
    const phases = await addPhase(owner, projectId, {
      name: String(ctx.payload.name ?? ""),
      startDate: ctx.payload.startDate,
      endDate: ctx.payload.endDate,
    });
    return { ok: true, result: { phases } };
  } catch (err) {
    if (err instanceof WorkspaceError) return fail(err.code);
    throw err;
  }
};
function contractInputFrom(payload: Record<string, unknown>, forCreate: boolean): { id?: string } & ContractInput {
  const out: { id?: string } & ContractInput = {};
  for (const key of [
    "title",
    "contractType",
    "projectId",
    "partyId",
    "valueRial",
    "startDate",
    "endDate",
    "status",
    "reminderDays",
    "notes",
  ] as const) {
    if (payload[key] !== undefined) (out as Record<string, unknown>)[key] = payload[key];
  }
  if (forCreate && out.title === undefined) out.title = "";
  return out;
}
const contractCreate: AutopilotExecutor = async (ctx) => {
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    const { id: _id, ...input } = contractInputFrom(ctx.payload, true);
    const contract = await createContract(owner, input);
    return { ok: true, result: { contract } };
  } catch (err) {
    if (err instanceof WorkspaceError) return fail(err.code);
    throw err;
  }
};
const contractUpdate: AutopilotExecutor = async (ctx) => {
  const contractId = str(ctx.payload.contractId) ?? str(ctx.payload.id);
  if (!contractId) return fail("missing_fields");
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    await resolveWorkspaceSubject(owner, "contract", contractId, "edit");
    const { id: _id, ...input } = contractInputFrom(ctx.payload, false);
    const contract = await updateContract(owner, contractId, input);
    return { ok: true, result: { contract } };
  } catch (err) {
    if (err instanceof WorkspaceError) return fail(err.code);
    throw err;
  }
};
const contractDelete: AutopilotExecutor = async (ctx) => {
  const contractId = str(ctx.payload.contractId) ?? str(ctx.payload.id);
  if (!contractId) return fail("missing_fields");
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    await resolveWorkspaceSubject(owner, "contract", contractId, "edit");
    const deleted = await deleteContract(owner.businessId, contractId);
    return { ok: true, result: { deleted } };
  } catch (err) {
    if (err instanceof WorkspaceError) return fail(err.code);
    throw err;
  }
};
const contractLifecycle: AutopilotExecutor = async (ctx) => {
  const contractId = str(ctx.payload.contractId) ?? str(ctx.payload.id);
  if (!contractId) return fail("missing_fields");
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    await resolveWorkspaceSubject(owner, "contract", contractId, "edit");
    const contract = await transitionContract(owner, contractId, String(ctx.payload.action ?? ""), {
      endDate: ctx.payload.endDate,
    });
    return { ok: true, result: { contract } };
  } catch (err) {
    if (err instanceof WorkspaceError) return fail(err.code);
    throw err;
  }
};

// ── Issue #883 package 2, batch AP — data-transfer config lanes ──────────
// Mirrors /api/data/* including the two-key rule: the MCP capability already
// enforces the engine key (data.export / data.import); the executor re-runs
// the caller's effective membership for the entity's own key — the exact
// second half of entityAccess in the route guard. Service errors boil down to
// the same { error: code } envelope handleDataError produces, and like it we
// rethrow anything that is not one of the four engine errors.
async function dataMemberAccess(ctx: AutopilotExecutorContext): Promise<MemberAccess | null> {
  if (!ctx.authorizedByUserId) return null;
  return memberAccessFor({
    sub: ctx.authorizedByUserId,
    businessId: ctx.businessId,
    locationId: null,
  } as SessionPayload);
}
function dataEngineError(err: unknown): AutopilotExecutionResult | null {
  if (err instanceof ImportError || err instanceof ExportError || err instanceof TemplateError || err instanceof ScheduleError) {
    return { ok: false, result: { error: err.code }, errorCode: err.code };
  }
  return null;
}
async function dataEntityGate(
  ctx: AutopilotExecutorContext,
  entityKeyRaw: unknown,
  direction: "import" | "export",
): Promise<{ entity: EntityDefinition } | AutopilotExecutionResult> {
  const entity = findEntity(typeof entityKeyRaw === "string" && entityKeyRaw.length > 0 ? entityKeyRaw : null);
  if (!entity) return fail("unknown_entity");
  const required = direction === "import" ? entity.importPermission : entity.exportPermission;
  if (!required) return fail("entity_not_importable");
  const access = await dataMemberAccess(ctx);
  if (!access?.isActive || !access.permissions.has(required)) {
    return { ok: false, result: { error: "forbidden", requires: required }, errorCode: "forbidden" };
  }
  return { entity };
}
const DATA_FORMATS = ["csv", "xlsx", "pdf", "json"] as const;
const DATA_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
const dataStringList = (raw: unknown): string[] | undefined =>
  Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : undefined;
const dataFiltersFrom = (raw: unknown): Record<string, unknown> | undefined =>
  raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
const dataScheduleCreate: AutopilotExecutor = async (ctx) => {
  const gate = await dataEntityGate(ctx, ctx.payload.entity, "export");
  if (!("entity" in gate)) return gate;
  const { entity } = gate;
  const format = (DATA_FORMATS as readonly string[]).includes(String(ctx.payload.format))
    ? (String(ctx.payload.format) as SaveScheduleInput["format"])
    : "xlsx";
  const frequency = (DATA_FREQUENCIES as readonly string[]).includes(String(ctx.payload.frequency))
    ? (String(ctx.payload.frequency) as SaveScheduleInput["frequency"])
    : "daily";
  let locationId: string | null = null;
  if (entity.locationScoped) {
    const branch = await verticalLocation(ctx);
    if ("ok" in branch) return branch;
    locationId = branch.locationId;
  }
  try {
    const schedule = await createScheduledExport({
      businessId: ctx.businessId,
      locationId,
      entityKey: entity.key,
      name: String(ctx.payload.name ?? ""),
      format,
      frequency,
      hourLocal: typeof ctx.payload.hourLocal === "number" ? ctx.payload.hourLocal : 7,
      weekday: typeof ctx.payload.weekday === "number" ? ctx.payload.weekday : null,
      dayOfMonth: typeof ctx.payload.dayOfMonth === "number" ? ctx.payload.dayOfMonth : null,
      fields: dataStringList(ctx.payload.fields) ?? [],
      filters: dataFiltersFrom(ctx.payload.filters) ?? {},
      deliverEmail: typeof ctx.payload.deliverEmail === "string" ? ctx.payload.deliverEmail : "",
      deliverStore: ctx.payload.deliverStore !== false,
      actorUserId: ctx.authorizedByUserId,
    });
    return { ok: true, result: { schedule } };
  } catch (err) {
    const mapped = dataEngineError(err);
    if (mapped) return mapped;
    throw err;
  }
};
async function dataScheduleOwned(
  ctx: AutopilotExecutorContext,
): Promise<
  | { ok: false; error: AutopilotExecutionResult }
  | { ok: true; existing: Awaited<ReturnType<typeof listScheduledExports>>[number]; entity: EntityDefinition }
> {
  const id = str(ctx.payload.id);
  if (!id) return { ok: false, error: fail("missing_fields") };
  // Exactly the route's loader: schedule-service exposes no single-get, so
  // the route builds it from the listing — same here.
  const schedules = await listScheduledExports(ctx.businessId);
  const existing = schedules.find((schedule) => schedule.id === id) ?? null;
  if (!existing) return { ok: false, error: fail("schedule_not_found") };
  const gate = await dataEntityGate(ctx, existing.entityKey, "export");
  if (!("entity" in gate)) return { ok: false, error: gate };
  return { ok: true, existing, entity: gate.entity };
}
const dataScheduleUpdate: AutopilotExecutor = async (ctx) => {
  const owned = await dataScheduleOwned(ctx);
  if (!owned.ok) return owned.error;
  try {
    const schedule = await updateScheduledExport(ctx.businessId, owned.existing.id, {
      name: typeof ctx.payload.name === "string" ? ctx.payload.name : undefined,
      format: typeof ctx.payload.format === "string" ? (ctx.payload.format as SaveScheduleInput["format"]) : undefined,
      frequency: typeof ctx.payload.frequency === "string" ? (ctx.payload.frequency as SaveScheduleInput["frequency"]) : undefined,
      hourLocal: typeof ctx.payload.hourLocal === "number" ? ctx.payload.hourLocal : undefined,
      weekday: typeof ctx.payload.weekday === "number" ? ctx.payload.weekday : undefined,
      dayOfMonth: typeof ctx.payload.dayOfMonth === "number" ? ctx.payload.dayOfMonth : undefined,
      fields: dataStringList(ctx.payload.fields),
      filters: dataFiltersFrom(ctx.payload.filters),
      deliverEmail: typeof ctx.payload.deliverEmail === "string" ? ctx.payload.deliverEmail : undefined,
      deliverStore: typeof ctx.payload.deliverStore === "boolean" ? ctx.payload.deliverStore : undefined,
      isActive: typeof ctx.payload.isActive === "boolean" ? ctx.payload.isActive : undefined,
    });
    return { ok: true, result: { schedule } };
  } catch (err) {
    const mapped = dataEngineError(err);
    if (mapped) return mapped;
    throw err;
  }
};
const dataScheduleRun: AutopilotExecutor = async (ctx) => {
  const owned = await dataScheduleOwned(ctx);
  if (!owned.ok) return owned.error;
  try {
    const result = await runScheduledExport(ctx.businessId, owned.existing.id);
    return { ok: true, result: { ...(result as Record<string, unknown>) } };
  } catch (err) {
    const mapped = dataEngineError(err);
    if (mapped) return mapped;
    throw err;
  }
};
const dataScheduleDelete: AutopilotExecutor = async (ctx) => {
  const owned = await dataScheduleOwned(ctx);
  if (!owned.ok) return owned.error;
  try {
    const ok = await deleteScheduledExport(ctx.businessId, owned.existing.id);
    return { ok: true, result: { ok } };
  } catch (err) {
    const mapped = dataEngineError(err);
    if (mapped) return mapped;
    throw err;
  }
};
const dataTemplateKind = (payload: Record<string, unknown>): "export" | "mapping" =>
  payload.kind === "export" ? "export" : "mapping";
async function dataTemplateEngineGate(ctx: AutopilotExecutorContext, kind: "export" | "mapping"): Promise<AutopilotExecutionResult | null> {
  // The route picks its engine key from the kind; the MCP capability can only
  // hold the looser one, so the executor re-runs the kind-matching engine key.
  const required = kind === "export" ? PERMISSIONS.dataExport : PERMISSIONS.dataImport;
  const access = await dataMemberAccess(ctx);
  if (!access?.isActive || !access.permissions.has(required)) {
    return { ok: false, result: { error: "forbidden" }, errorCode: "forbidden" };
  }
  return null;
}
const dataTemplateCreate: AutopilotExecutor = async (ctx) => {
  const kind = dataTemplateKind(ctx.payload);
  const engineError = await dataTemplateEngineGate(ctx, kind);
  if (engineError) return engineError;
  const gate = await dataEntityGate(ctx, ctx.payload.entity, kind === "export" ? "export" : "import");
  if (!("entity" in gate)) return gate;
  try {
    const base = {
      businessId: ctx.businessId,
      entityKey: gate.entity.key,
      name: String(ctx.payload.name ?? ""),
      description: typeof ctx.payload.description === "string" ? ctx.payload.description : "",
      actorUserId: ctx.authorizedByUserId,
    };
    if (kind === "export") {
      const template = await createExportTemplate({
        ...base,
        format: typeof ctx.payload.format === "string" ? (ctx.payload.format as ExportFormat) : "xlsx",
        fields: dataStringList(ctx.payload.fields) ?? [],
        filters: dataFiltersFrom(ctx.payload.filters) ?? {},
      });
      return { ok: true, result: { template } };
    }
    const template = await createMappingTemplate({
      ...base,
      mapping: (ctx.payload.mapping as Parameters<typeof createMappingTemplate>[0]["mapping"]) ?? { columns: [] },
      options: (ctx.payload.options as Parameters<typeof createMappingTemplate>[0]["options"]) ?? {},
    });
    return { ok: true, result: { template } };
  } catch (err) {
    const mapped = dataEngineError(err);
    if (mapped) return mapped;
    throw err;
  }
};
async function dataTemplateOwned(
  ctx: AutopilotExecutorContext,
  kind: "export" | "mapping",
): Promise<{ ok: false; error: AutopilotExecutionResult } | { ok: true; existing: { id: string } }> {
  const id = str(ctx.payload.id);
  if (!id) return { ok: false, error: fail("missing_fields") };
  const existing =
    kind === "export" ? await getExportTemplate(ctx.businessId, id) : await getMappingTemplate(ctx.businessId, id);
  if (!existing) return { ok: false, error: fail("template_not_found") };
  const gate = await dataEntityGate(ctx, existing.entityKey, kind === "export" ? "export" : "import");
  if (!("entity" in gate)) return { ok: false, error: gate };
  return { ok: true, existing };
}
const dataTemplateUpdate: AutopilotExecutor = async (ctx) => {
  const kind = dataTemplateKind(ctx.payload);
  const engineError = await dataTemplateEngineGate(ctx, kind);
  if (engineError) return engineError;
  const owned = await dataTemplateOwned(ctx, kind);
  if (!owned.ok) return owned.error;
  try {
    if (kind === "export") {
      const template = await updateExportTemplate(ctx.businessId, owned.existing.id, {
        name: typeof ctx.payload.name === "string" ? ctx.payload.name : undefined,
        description: typeof ctx.payload.description === "string" ? ctx.payload.description : undefined,
        format: typeof ctx.payload.format === "string" ? (ctx.payload.format as ExportFormat) : undefined,
        fields: dataStringList(ctx.payload.fields),
        filters: dataFiltersFrom(ctx.payload.filters),
      });
      return { ok: true, result: { template } };
    }
    const template = await updateMappingTemplate(ctx.businessId, owned.existing.id, {
      name: typeof ctx.payload.name === "string" ? ctx.payload.name : undefined,
      description: typeof ctx.payload.description === "string" ? ctx.payload.description : undefined,
      mapping: (ctx.payload.mapping as Parameters<typeof updateMappingTemplate>[2]["mapping"]) ?? undefined,
      options: (ctx.payload.options as Parameters<typeof updateMappingTemplate>[2]["options"]) ?? undefined,
    });
    return { ok: true, result: { template } };
  } catch (err) {
    const mapped = dataEngineError(err);
    if (mapped) return mapped;
    throw err;
  }
};
const dataTemplateDelete: AutopilotExecutor = async (ctx) => {
  const kind = dataTemplateKind(ctx.payload);
  const engineError = await dataTemplateEngineGate(ctx, kind);
  if (engineError) return engineError;
  const owned = await dataTemplateOwned(ctx, kind);
  if (!owned.ok) return owned.error;
  try {
    const ok =
      kind === "export"
        ? await deleteExportTemplate(ctx.businessId, owned.existing.id)
        : await deleteMappingTemplate(ctx.businessId, owned.existing.id);
    return { ok: true, result: { ok } };
  } catch (err) {
    const mapped = dataEngineError(err);
    if (mapped) return mapped;
    throw err;
  }
};
const dataImportRun: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id);
  if (!id) return fail("missing_fields");
  const job = await getImportJob(ctx.businessId, id);
  if (!job) return fail("job_not_found");
  const gate = await dataEntityGate(ctx, job.entityKey, "import");
  if (!("entity" in gate)) return gate;
  const action = str(ctx.payload.action) ?? "run";
  try {
    if (action === "retry") {
      const retryJob = await retryFailedRows(ctx.businessId, id);
      return { ok: true, result: { job: retryJob } };
    }
    if (action === "run") {
      const queuedJob = await queueImportJob(ctx.businessId, id);
      return { ok: true, result: { job: queuedJob } };
    }
    return fail("unknown_action");
  } catch (err) {
    const mapped = dataEngineError(err);
    if (mapped) return mapped;
    throw err;
  }
};

// ── Issue #883 package 2, batch AL2 — jewelry money lanes ────────────────
// Every verb mirrors its route 1:1: same client transaction, same ledger
// error convention (MissingLedgerAccountError → ledger_account_missing),
// same failure envelope the gold screens show ({*_failed, message}).
const jewelryFailEnv = (err: unknown, code: "pay_failed" | "complete_failed" | "validation_failed"): AutopilotExecutionResult => {
  if (err instanceof MissingLedgerAccountError) {
    return { ok: false, result: { error: "ledger_account_missing", code: err.code }, errorCode: "ledger_account_missing" };
  }
  return { ok: false, result: { error: code, message: (err as Error).message }, errorCode: code };
};
const jewelryItemSell: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id) ?? str(ctx.payload.itemId);
  if (!id) return fail("missing_fields");
  const makingChargeType = str(ctx.payload.makingChargeType);
  if (makingChargeType !== "percent" && makingChargeType !== "fixed") return fail("invalid_making_charge");
  const makingChargeValue = Number(ctx.payload.makingChargeValue);
  const profitPercent = Number(ctx.payload.profitPercent);
  const vatPercent = Number(ctx.payload.vatPercent);
  if (![makingChargeValue, profitPercent, vatPercent].every(Number.isFinite)) return fail("bad_request");
  const paymentMethod = str(ctx.payload.paymentMethod);
  if (paymentMethod !== "cash" && paymentMethod !== "bank" && paymentMethod !== "credit") return fail("invalid_payment_method");
  const branch = await jewelryLocation(ctx);
  if ("ok" in branch) return branch;
  const item = await getItem(id);
  if (!item || item.locationId !== branch.locationId) return fail("item_not_found");
  if (!ctx.authorizedByUserId) return fail("unauthenticated");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await sellWeightedItem(client, {
      businessId: ctx.businessId,
      locationId: branch.locationId,
      itemId: id,
      makingCharge: { type: makingChargeType, value: makingChargeValue },
      profitPercent,
      vatPercent,
      paymentMethod,
      createdBy: ctx.authorizedByUserId,
    });
    await client.query("COMMIT");
    return { ok: true, result: { ok: true, ...(result as object) } };
  } catch (err) {
    await client.query("ROLLBACK");
    return jewelryFailEnv(err, "validation_failed");
  } finally {
    client.release();
  }
};
const jewelryBuybackCreate: AutopilotExecutor = async (ctx) => {
  const purity = str(ctx.payload.purity);
  const grossWeight = str(ctx.payload.grossWeight) ?? "";
  if (!purity || !grossWeight) return fail("missing_fields");
  if (!isPurity(purity)) return fail("invalid_purity");
  const price = await getGoldPrice(ctx.businessId, purity);
  if (!price || price.buyPricePerGram == null) {
    return { ok: false, result: { error: "no_buy_rate", message: "نرخ خرید امروز برای این عیار ثبت نشده است." }, errorCode: "no_buy_rate" };
  }
  const branch = await jewelryLocation(ctx);
  if ("ok" in branch) return branch;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await buyBackGold(client, {
      businessId: ctx.businessId,
      locationId: branch.locationId,
      customerId: str(ctx.payload.customerId) ?? null,
      purity: purity as never,
      grossWeight,
      karsorPercent: Number(ctx.payload.karsorPercent ?? 0),
      buyPricePerGram: price.buyPricePerGram,
      createdBy: ctx.authorizedByUserId,
    });
    await client.query("COMMIT");
    return { ok: true, result: { ok: true, ...(result as object) } };
  } catch (err) {
    await client.query("ROLLBACK");
    return jewelryFailEnv(err, "validation_failed");
  } finally {
    client.release();
  }
};
const jewelryLayawayCreate: AutopilotExecutor = async (ctx) => {
  const customerId = str(ctx.payload.customerId);
  const grams = str(ctx.payload.grams) ?? str(ctx.payload.grams?.toString());
  if (!customerId || !grams) return fail("missing_fields");
  const pricePerGram = Number(ctx.payload.pricePerGram ?? 0);
  const depositRial = Number(ctx.payload.depositRial ?? 0);
  const branch = await jewelryLocation(ctx);
  if ("ok" in branch) return branch;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const plan = await openLayaway(client, {
      businessId: ctx.businessId,
      locationId: branch.locationId,
      customerId,
      itemId: str(ctx.payload.itemId) ?? null,
      grams,
      pricePerGram,
      depositRial,
      promisedDate: (ctx.payload.promisedDate as string | null | undefined) ?? null,
      createdBy: ctx.authorizedByUserId,
    });
    await client.query("COMMIT");
    return { ok: true, result: { plan: { ...(plan as object) } } };
  } catch (err) {
    await client.query("ROLLBACK");
    return jewelryFailEnv(err, "validation_failed");
  } finally {
    client.release();
  }
};
const jewelryLayawayPay: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id) ?? str(ctx.payload.planId);
  const amount = Number(ctx.payload.amount ?? 0);
  if (!id) return fail("missing_fields");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const plan = await payLayaway(client, {
      businessId: ctx.businessId,
      planId: id,
      amount,
      createdBy: ctx.authorizedByUserId,
    });
    await client.query("COMMIT");
    return { ok: true, result: { ok: true, plan: { ...(plan as object) } } };
  } catch (err) {
    await client.query("ROLLBACK");
    return jewelryFailEnv(err, "pay_failed");
  } finally {
    client.release();
  }
};
const jewelryLayawayComplete: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id) ?? str(ctx.payload.planId);
  if (!id) return fail("missing_fields");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const plan = await completeLayaway(client, {
      businessId: ctx.businessId,
      planId: id,
      createdBy: ctx.authorizedByUserId,
    });
    await client.query("COMMIT");
    return { ok: true, result: { ok: true, plan: { ...(plan as object) } } };
  } catch (err) {
    await client.query("ROLLBACK");
    return jewelryFailEnv(err, "complete_failed");
  } finally {
    client.release();
  }
};
const jewelryConsignorPayout: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id) ?? str(ctx.payload.consignorId);
  const amount = Number(ctx.payload.amount);
  const paymentMethod = str(ctx.payload.paymentMethod) === "bank" ? "bank" : "cash";
  if (!id) return fail("missing_fields");
  const branch = await jewelryLocation(ctx);
  if ("ok" in branch) return branch;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await payConsignor(client, {
      businessId: ctx.businessId,
      locationId: branch.locationId,
      consignorId: id,
      amount,
      paymentMethod,
      createdBy: ctx.authorizedByUserId,
    });
    await client.query("COMMIT");
    return { ok: true, result: { ok: true, ...(result as object) } };
  } catch (err) {
    await client.query("ROLLBACK");
    return jewelryFailEnv(err, "validation_failed");
  } finally {
    client.release();
  }
};
const jewelryPriceRecord: AutopilotExecutor = async (ctx) => {
  const purity = str(ctx.payload.purity) ?? "";
  const pricePerGram = Number(ctx.payload.pricePerGram);
  if (!Number.isFinite(pricePerGram)) return fail("bad_request");
  try {
    const price = await recordGoldPrice({
      businessId: ctx.businessId,
      purity,
      pricePerGram,
      createdBy: ctx.authorizedByUserId,
    });
    return { ok: true, result: { ok: true, price: { ...(price as object) } } };
  } catch (err) {
    return { ok: false, result: { error: "validation_failed", message: (err as Error).message }, errorCode: "validation_failed" };
  }
};

// ── Issue #883 package 2, batch AL1 — jewelry catalog ────────────────────
// The routes validate weight inputs BEFORE any write and mirror every write
// with an item-audit event; both land here verbatim so the timeline on the
// item screen is identical whether the change came from the till or chat.
async function jewelryLocation(ctx: AutopilotExecutorContext): Promise<{ locationId: string } | AutopilotExecutionResult> {
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  return { locationId: branch.locationId };
}
const jewelryItemCreate: AutopilotExecutor = async (ctx) => {
  const name = str(ctx.payload.name);
  if (!name) return fail("missing_fields");
  if (name.length > 200) return fail("item_name_too_long");
  const weightInput = {
    purity: str(ctx.payload.purity) ?? "",
    grossWeight: str(ctx.payload.grossWeight) ?? "",
    netWeight: str(ctx.payload.netWeight) ?? "",
    unitCostPerGram:
      typeof ctx.payload.unitCostPerGram === "number" ? ctx.payload.unitCostPerGram : ctx.payload.unitCostPerGram ?? null,
  } as Parameters<typeof validateWeightAttributes>[0];
  const weightErrors = validateWeightAttributes(weightInput);
  if (weightErrors.length > 0) {
    return { ok: false, result: { error: "invalid_weight_attributes", message: weightErrors.join("؛ ") }, errorCode: "invalid_weight_attributes" };
  }
  const branch = await jewelryLocation(ctx);
  if ("ok" in branch) return branch;
  const item = await createItem({
    locationId: branch.locationId,
    name,
    sku: str(ctx.payload.sku) ?? null,
    tracking: "weight",
  });
  const weightAttrs = await setWeightAttributes(item.id, weightInput);
  await recordItemEvent({
    businessId: ctx.businessId,
    locationId: branch.locationId,
    itemId: item.id,
    eventType: "item.created",
    actorUserId: ctx.authorizedByUserId,
    payload: { name, ...weightInput },
  } as never);
  return { ok: true, result: { item: { ...(item as object) }, weightAttributes: { ...(weightAttrs as object) } } };
};
const jewelryItemUpdate: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id) ?? str(ctx.payload.itemId);
  if (!id) return fail("missing_fields");
  const item = await getItem(id);
  if (!item) return fail("item_not_found");
  const current = await getWeightAttributes(id);
  if (!current) return fail("item_not_found");
  const input = {
    purity: str(ctx.payload.purity) ?? current.purity,
    grossWeight: str(ctx.payload.grossWeight) ?? current.grossWeight,
    netWeight: str(ctx.payload.netWeight) ?? current.netWeight,
    unitCostPerGram:
      ctx.payload.unitCostPerGram !== undefined
        ? (ctx.payload.unitCostPerGram as number | null)
        : current.unitCostPerGram,
  } as Parameters<typeof validateWeightAttributes>[0];
  const weightErrors = validateWeightAttributes(input);
  if (weightErrors.length > 0) {
    return { ok: false, result: { error: "invalid_weight_attributes", message: weightErrors.join("؛ ") }, errorCode: "invalid_weight_attributes" };
  }
  const weightAttrs = await setWeightAttributes(id, input);
  await recordItemEvent({
    businessId: ctx.businessId,
    locationId: item.locationId,
    itemId: id,
    eventType: "item.weight_attrs_updated",
    actorUserId: ctx.authorizedByUserId,
    payload: { ...input },
  } as never);
  return { ok: true, result: { weightAttributes: { ...(weightAttrs as object) } } };
};
const jewelryStoneAdd: AutopilotExecutor = async (ctx) => {
  const itemId = str(ctx.payload.itemId) ?? str(ctx.payload.id);
  const stoneType = str(ctx.payload.stoneType) ?? "";
  const carat = str(ctx.payload.carat) ?? "";
  const cost = typeof ctx.payload.cost === "number" && Number.isFinite(ctx.payload.cost) ? ctx.payload.cost : null;
  if (!itemId || cost === null) return fail("missing_fields");
  const branch = await jewelryLocation(ctx);
  if ("ok" in branch) return branch;
  const item = await getItem(itemId);
  if (!item || item.locationId !== branch.locationId) return fail("item_not_found");
  try {
    const stone = await addStone(itemId, { stoneType, carat, cost });
    await recordItemEvent({
      businessId: ctx.businessId,
      locationId: branch.locationId,
      itemId,
      eventType: "item.stone_added",
      actorUserId: ctx.authorizedByUserId,
      payload: { stoneId: (stone as { id?: string }).id, stoneType, carat, cost },
    } as never);
    return { ok: true, result: { stone: { ...(stone as object) } } };
  } catch (err) {
    return { ok: false, result: { error: "validation_failed", message: (err as Error).message }, errorCode: "validation_failed" };
  }
};
const jewelryStoneDelete: AutopilotExecutor = async (ctx) => {
  const itemId = str(ctx.payload.itemId) ?? str(ctx.payload.id);
  const stoneId = str(ctx.payload.stoneId);
  if (!itemId || !stoneId) return fail("missing_fields");
  const branch = await jewelryLocation(ctx);
  if ("ok" in branch) return branch;
  const item = await getItem(itemId);
  if (!item || item.locationId !== branch.locationId) return fail("item_not_found");
  const removed = await removeStone(stoneId, itemId);
  if (!removed) return fail("stone_not_found");
  await recordItemEvent({
    businessId: ctx.businessId,
    locationId: branch.locationId,
    itemId,
    eventType: "item.stone_removed",
    actorUserId: ctx.authorizedByUserId,
    payload: { stoneId },
  } as never);
  return { ok: true, result: { ok: true } };
};
const jewelryItemConsign: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id) ?? str(ctx.payload.itemId);
  const consignorId = str(ctx.payload.consignorId);
  if (!id || !consignorId) return fail("missing_fields");
  const branch = await jewelryLocation(ctx);
  if ("ok" in branch) return branch;
  const item = await getItem(id);
  if (!item || item.locationId !== branch.locationId) return fail("item_not_found");
  try {
    const consignment = await markAsConsigned(id, consignorId);
    await recordItemEvent({
      businessId: ctx.businessId,
      locationId: branch.locationId,
      itemId: id,
      eventType: "item.consigned",
      actorUserId: ctx.authorizedByUserId,
      payload: { consignorId: (consignment as { consignorId?: string }).consignorId ?? consignorId },
    } as never);
    return { ok: true, result: { ok: true, consignment: { ...(consignment as object) } } };
  } catch (err) {
    return { ok: false, result: { error: "validation_failed", message: (err as Error).message }, errorCode: "validation_failed" };
  }
};

// ── Issue #883 package 2, batch AK — workspace approvals ─────────────────
// The decide executor mirrors the route's subject-type dispatch exactly:
// every commercial subject runs through ITS register's decide service so the
// queue and the register screen record one identical decision.
const WORKSPACE_DECISIONS = new Set(["approved", "rejected", "changes_requested", "cancelled"]);
const workspaceApprovalRequest: AutopilotExecutor = async (ctx) => {
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("not_business_member");
  const subjectType = str(ctx.payload.subjectType);
  const subjectId = str(ctx.payload.subjectId);
  if (!subjectType || !subjectId) return fail("missing_fields");
  const approval = await requestApproval(owner, {
    subjectType,
    subjectId,
    projectId: ctx.payload.projectId === undefined ? undefined : (str(ctx.payload.projectId) ?? null),
    title: str(ctx.payload.title) ?? undefined,
    approverUserId: ctx.payload.approverUserId === undefined ? undefined : (str(ctx.payload.approverUserId) ?? null),
    dueDate: ctx.payload.dueDate,
    note: str(ctx.payload.note) ?? undefined,
  });
  return { ok: true, result: { approval: { ...(approval as object) } } };
};
const workspaceApprovalDecide: AutopilotExecutor = async (ctx) => {
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("not_business_member");
  const id = str(ctx.payload.id) ?? str(ctx.payload.approvalId);
  const decision = str(ctx.payload.decision);
  if (!id) return fail("missing_fields");
  if (!decision || !WORKSPACE_DECISIONS.has(decision)) return fail("invalid_decision");
  const note = str(ctx.payload.note) ?? "";
  const d = decision as "approved" | "rejected" | "changes_requested" | "cancelled";
  const subjectType = await approvalSubjectType(owner.businessId, id);
  if (subjectType === "estimate_version") {
    const result = await decideEstimateApproval(owner, id, d, note);
    if (!result.applied) return fail("approval_not_pending");
    return { ok: true, result: { approval: null, estimateVersionId: result.versionId } };
  }
  if (subjectType === "submittal_revision") {
    const result = await decideSubmittalApproval(owner, id, d, note);
    if (!result.applied) return fail("approval_not_pending");
    return { ok: true, result: { approval: null, submittalRevisionId: result.revisionId } };
  }
  if (subjectType === "variation") {
    const result = await decideVariationApproval(owner, id, d, note);
    if (!result.applied) return fail("approval_not_pending");
    return { ok: true, result: { approval: null, variationId: (result as unknown as Record<string, unknown>).variationId ?? id } };
  }
  if (subjectType === "material_request") {
    const result = await decideMaterialRequestApproval(owner, id, d, note);
    if (!result.applied) return fail("approval_not_pending");
    return { ok: true, result: { approval: null, materialRequestId: result.requestId } };
  }
  if (subjectType === "commitment") {
    const result = await decideCommitmentApproval(owner, id, d, note);
    if (!result.applied) return fail("approval_not_pending");
    return { ok: true, result: { approval: null, commitmentId: result.commitmentId } };
  }
  if (subjectType === "payment_certificate") {
    const result = await decideCertificateApproval(owner, id, d, note);
    if (!result.applied) return fail("approval_not_pending");
    return { ok: true, result: { approval: null, certificateId: result.certificateId } };
  }
  const approval = await decideApproval(owner, id, d, note);
  if (!approval) return fail("approval_not_pending");
  return { ok: true, result: { approval: { ...(approval as object) } } };
};

// ── Issue #883 package 2, batch AJ — product attributes & price entries ───
// savePriceEntries applies per-cell optimistic concurrency (expectedVersion)
// and returns survived-cell count + the exact conflicting cells, so the
// model answers "done except these two, someone edited them first".
const productAttributeUpdate: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id) ?? str(ctx.payload.attributeId);
  if (!id) return fail("missing_fields");
  const rawPatch: Record<string, unknown> = { version: ctx.payload.version };
  for (const field of ["name", "options", "isActive"] as const) {
    if (Object.hasOwn(ctx.payload, field)) rawPatch[field] = ctx.payload[field];
  }
  const parsed = parseAttributeDefinitionInput(rawPatch, "patch");
  if (!parsed.ok) return fail("validation_failed");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  const { definition, error: updateError, current } = await updateAttributeDefinition(
    id,
    branch.locationId,
    { ...parsed.data, version: parsed.data.version! },
    ctx.businessId,
  );
  if (updateError || !definition) return fail(updateError ?? (current ? "edit_conflict" : "attribute_not_found"));
  return { ok: true, result: { definition: { ...(definition as object) } } };
};
const productAttributeDelete: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id) ?? str(ctx.payload.attributeId);
  if (!id) return fail("missing_fields");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  const result = await deleteAttributeDefinition(id, branch.locationId, ctx.businessId);
  if (result.error) return fail(result.error);
  return { ok: true, result: { ok: true } };
};
const barcodeTemplateDelete: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id) ?? str(ctx.payload.templateId);
  if (!id) return fail("missing_fields");
  const deleted = await deleteWeightBarcodeTemplate(id);
  if (!deleted) return fail("template_not_found");
  return { ok: true, result: { ok: true } };
};
const priceListEntriesSave: AutopilotExecutor = async (ctx) => {
  const raw = Array.isArray(ctx.payload.updates) ? (ctx.payload.updates as Record<string, unknown>[]) : [];
  if (raw.length === 0) return fail("missing_fields");
  if (raw.length > 200) return fail("updates_too_large");
  const updates = raw.map((u) => ({
    priceListId: String(u.priceListId ?? ""),
    itemId: String(u.itemId ?? ""),
    priceRial:
      u.priceRial === null || u.priceRial === undefined ? (u.priceRial as number | null | undefined) : Number(u.priceRial),
    expectedVersion: u.expectedVersion === undefined ? undefined : String(u.expectedVersion),
  }));
  if (updates.some((u) => !isUuid(u.priceListId) || !isUuid(u.itemId))) return fail("invalid_update");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  const { touched, conflicts } = await savePriceEntries(updates as never, {
    locationId: branch.locationId,
    businessId: ctx.businessId,
    userId: ctx.authorizedByUserId,
  });
  return { ok: true, result: { ok: true, touched, conflicts } };
};

// ── Issue #883 package 2, batch AI — device rename / revoke ───────────────
// renameDevice / revokeDevice take the actor id and throw typed DeviceError
// whose {message, status} the route surfaces verbatim — same mapping here.
const deviceFail = (err: unknown): AutopilotExecutionResult => {
  if (err instanceof DeviceError) return fail(err.message);
  throw err;
};
const deviceRename: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id) ?? str(ctx.payload.deviceId);
  const label = str(ctx.payload.label);
  if (!id || !label) return fail("invalid_label");
  try {
    const device = await renameDevice(id, ctx.businessId, ctx.authorizedByUserId, label);
    return { ok: true, result: { device: { ...(device as object) } } };
  } catch (err) {
    return deviceFail(err);
  }
};
const deviceRevoke: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id) ?? str(ctx.payload.deviceId);
  if (!id) return fail("missing_fields");
  try {
    await revokeDevice(id, ctx.businessId, ctx.authorizedByUserId);
    return { ok: true, result: { ok: true } };
  } catch (err) {
    return deviceFail(err);
  }
};

// ── Issue #883 package 2, batch AH — backup config, manual run, restore ───
// run-now rides the route's own billing gate (chargeForFeature) so a priced
// run charges the wallet exactly once, same as the button. Restore is the
// whole-database replacement the Owner-only route performs; verifyOnly maps
// to the route's apply:false (validate into scratch, touch nothing).
const backupConfigSet: AutopilotExecutor = async (ctx) => {
  const payload = { ...(ctx.payload as Record<string, unknown>) };
  if (payload.passphrase === "" || payload.passphrase === undefined) {
    const current = await getBackupConfig(ctx.businessId);
    if (current) payload.passphrase = (current as { passphrase?: string }).passphrase;
  }
  try {
    await setBackupConfig(ctx.businessId, payload as never);
    return { ok: true, result: { ok: true } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.startsWith("invalid_") || message.includes("required")) return fail("bad_request");
    throw err;
  }
};
const backupRunNow: AutopilotExecutor = async (ctx) => {
  const gate = await chargeForFeature(ctx.businessId, "backup", {
    note: "پشتیبان‌گیری دستی",
    userId: ctx.authorizedByUserId ?? null,
  });
  if (!gate.ok) {
    return { ok: false, result: { error: "backup_not_chargeable", detail: gate.response }, errorCode: "backup_not_chargeable" };
  }
  const result = await runBackupNow(ctx.businessId);
  return { ok: true, result: { result: { ...(result as object) }, charged: gate.charged ?? null, balanceRial: gate.balanceRial ?? null } };
};
const backupRestoreApply: AutopilotExecutor = async (ctx) => {
  const artifactId = str(ctx.payload.artifactId) ?? str(ctx.payload.id);
  if (!artifactId) return fail("missing_artifact");
  if (!(await restoreAvailable())) return fail("restore_not_available");
  const apply = !(ctx.payload.verifyOnly === true);
  const outcome = await restoreFromArtifact(ctx.businessId, {
    source: "artifact",
    artifactId,
    passphrase: str(ctx.payload.passphrase) ?? undefined,
    apply,
  } as never);
  return { ok: true, result: { applied: apply, outcome: { ...(outcome as object) } } };
};

// ── Issue #883 package 2, batch AF — table sessions ───────────────────────
// The two session handlers the floormaps use. Errors arrive from the client-
// transaction services as thrown {code, status} errors, exactly as the routes
// catch them, so the model sees the floor screen's own codes.
function thrownCode(err: unknown): AutopilotExecutionResult {
  const code = (err as { code?: string }).code;
  if (code) return fail(code);
  throw err;
}
const tableSessionOpen: AutopilotExecutor = async (ctx) => {
  const rawIds = Array.isArray(ctx.payload.tableIds)
    ? (ctx.payload.tableIds as unknown[]).map(String).filter(Boolean)
    : ctx.payload.tableId !== undefined
      ? [String(ctx.payload.tableId)]
      : [];
  const tableIds = [...new Set(rawIds)];
  if (tableIds.length === 0) return fail("table_required");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  const partySizeRaw = Number(ctx.payload.partySize);
  const partySize = Number.isFinite(partySizeRaw) && partySizeRaw > 0 ? partySizeRaw : null;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { id } = await openSession(client, {
      locationId: branch.locationId,
      tableIds,
      partySize,
      guestName: str(ctx.payload.guestName) ?? null,
      guestPhone: str(ctx.payload.guestPhone) ?? null,
      openedBy: ctx.authorizedByUserId,
    });
    await client.query("COMMIT");
    // Route parity: the live floor view listens for this exact event.
    broadcast(branch.locationId, { type: "table_session.updated", sessionId: id });
    return { ok: true, result: { ok: true, id } };
  } catch (err) {
    await client.query("ROLLBACK");
    return thrownCode(err);
  } finally {
    client.release();
  }
};
const tableSessionUpdate: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id) ?? str(ctx.payload.sessionId);
  const action = str(ctx.payload.action);
  if (!id) return fail("missing_fields");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  if (action === "set_note") {
    const { rows } = await query<{ id: string }>(
      "UPDATE table_sessions SET note = $3 WHERE id = $1 AND location_id = $2 AND status = 'open' RETURNING id",
      [id, branch.locationId, str(ctx.payload.note) ?? null],
    );
    if (rows.length === 0) return fail("session_not_found");
    return { ok: true, result: { ok: true } };
  }
  if (action !== "set_guests" && action !== "release" && action !== "merge") return fail("bad_request");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (action === "set_guests") {
      const customerIds = Array.isArray(ctx.payload.customerIds) ? ctx.payload.customerIds : [];
      await setSessionGuests(client, {
        businessId: ctx.businessId,
        locationId: branch.locationId,
        sessionId: id,
        customerIds: customerIds as (string | null | undefined)[],
      });
    } else if (action === "release") {
      await releaseSessionWithoutOrders(client, branch.locationId, id, ctx.authorizedByUserId);
    } else {
      const newTableId = str(ctx.payload.tableId);
      if (!newTableId) return fail("table_required");
      await mergeTableIntoSession(client, branch.locationId, id, newTableId);
    }
    await client.query("COMMIT");
    broadcast(branch.locationId, { type: "table_session.updated", sessionId: id });
    return { ok: true, result: { ok: true } };
  } catch (err) {
    await client.query("ROLLBACK");
    return thrownCode(err);
  } finally {
    client.release();
  }
};

// ── Issue #883 package 2, batch AE — loyalty wallet lanes ─────────────────
// Same pattern the routes use: one client transaction per movement, and the
// route's composite failure shape ({error, message}) preserved verbatim —
// the wallet screens surface that message to the operator.
const loyaltyFail = (err: unknown, code: "redeem_failed" | "store_credit_failed"): AutopilotExecutionResult => ({
  ok: false,
  result: { error: code, message: (err as Error).message },
  errorCode: code,
});
const loyaltyPointsRedeem: AutopilotExecutor = async (ctx) => {
  const customerId = str(ctx.payload.customerId) ?? str(ctx.payload.id);
  const points = typeof ctx.payload.points === "number" && Number.isFinite(ctx.payload.points) ? Math.round(ctx.payload.points) : null;
  if (!customerId || points === null || points <= 0) return fail("missing_fields");
  const customer = await getCustomer(ctx.businessId, customerId);
  if (!customer) return fail("customer_not_found");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  const businessDay = await getBusinessDayStatus(branch.locationId);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await redeemPoints(client, {
      businessId: ctx.businessId,
      locationId: branch.locationId,
      customerId,
      points,
      businessDate: businessDay?.businessDate,
      createdBy: ctx.authorizedByUserId,
    });
    await client.query("COMMIT");
    return { ok: true, result: { ok: true, ...result } };
  } catch (err) {
    await client.query("ROLLBACK");
    return loyaltyFail(err, "redeem_failed");
  } finally {
    client.release();
  }
};
const loyaltyStoreCreditIssue: AutopilotExecutor = async (ctx) => {
  const customerId = str(ctx.payload.customerId) ?? str(ctx.payload.id);
  const amount = typeof ctx.payload.amount === "number" && Number.isFinite(ctx.payload.amount) ? ctx.payload.amount : null;
  if (!customerId || amount === null || amount <= 0) return fail("bad_request");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  const customer = await getCustomer(ctx.businessId, customerId);
  if (!customer) return fail("customer_not_found");
  const businessDay = await getBusinessDayStatus(branch.locationId);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await issueStoreCredit(client, {
      businessId: ctx.businessId,
      locationId: branch.locationId,
      customerId,
      amount,
      reason: str(ctx.payload.reason) ?? null,
      businessDate: businessDay?.businessDate,
      createdBy: ctx.authorizedByUserId,
    });
    const balance = await storeCreditBalance(ctx.businessId, customerId, client);
    await client.query("COMMIT");
    return { ok: true, result: { ok: true, balance } };
  } catch (err) {
    await client.query("ROLLBACK");
    return loyaltyFail(err, "store_credit_failed");
  } finally {
    client.release();
  }
};
const loyaltyStoreCreditUse: AutopilotExecutor = async (ctx) => {
  const customerId = str(ctx.payload.customerId) ?? str(ctx.payload.id);
  const amount = typeof ctx.payload.amount === "number" && Number.isFinite(ctx.payload.amount) ? ctx.payload.amount : null;
  const paymentMethod = str(ctx.payload.paymentMethod);
  if (!customerId || amount === null || amount <= 0) return fail("bad_request");
  if (paymentMethod !== "cash" && paymentMethod !== "bank") return fail("bad_request");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  const customer = await getCustomer(ctx.businessId, customerId);
  if (!customer) return fail("customer_not_found");
  const businessDay = await getBusinessDayStatus(branch.locationId);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await payOutStoreCredit(client, {
      businessId: ctx.businessId,
      locationId: branch.locationId,
      customerId,
      amount,
      paymentMethod,
      businessDate: businessDay?.businessDate,
      createdBy: ctx.authorizedByUserId,
    });
    await client.query("COMMIT");
    return { ok: true, result: { ok: true, balance: result.balance } };
  } catch (err) {
    await client.query("ROLLBACK");
    return loyaltyFail(err, "store_credit_failed");
  } finally {
    client.release();
  }
};
const loyaltyProgramUpsert: AutopilotExecutor = async (ctx) => {
  const name = str(ctx.payload.name);
  if (!name) return fail("missing_fields");
  const program = await upsertProgram(ctx.businessId, {
    name,
    earnPointsPer100000: typeof ctx.payload.earnPointsPer100000 === "number" ? ctx.payload.earnPointsPer100000 : undefined,
    pointValueRial: typeof ctx.payload.pointValueRial === "number" ? ctx.payload.pointValueRial : undefined,
    pointsExpiryDays:
      ctx.payload.pointsExpiryDays === null
        ? null
        : typeof ctx.payload.pointsExpiryDays === "number"
          ? ctx.payload.pointsExpiryDays
          : undefined,
    isActive: typeof ctx.payload.isActive === "boolean" ? ctx.payload.isActive : undefined,
    isDefault: typeof ctx.payload.isDefault === "boolean" ? ctx.payload.isDefault : undefined,
  });
  return { ok: true, result: { program: { ...(program as object) } } };
};

// ── Issue #883 package 2, batch AD — CRM deal & case deletes ──────────────
// Save / move-stage / set-status verbs + executors already exist from the
// earlier CRM package; only the irreversible deletes were missing.
const crmDealDelete: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id) ?? str(ctx.payload.dealId);
  if (!id) return fail("missing_fields");
  const deleted = await deleteDeal(ctx.businessId, id);
  if (!deleted) return fail("deal_not_found");
  return { ok: true, result: { result: "deleted" } };
};
const crmCaseDelete: AutopilotExecutor = async (ctx) => {
  const id = str(ctx.payload.id) ?? str(ctx.payload.caseId);
  if (!id) return fail("missing_fields");
  const deleted = await deleteCase(ctx.businessId, id);
  if (!deleted) return fail("case_not_found");
  return { ok: true, result: { result: "deleted" } };
};

// ── Issue #883 package 2, batch AC — gift-card money movements ─────────────
// Both mirror the routes' client transactions. Redeem preserves the route's
// simple failure shape ({redeem_failed} with the reason); the expiry run is
// a deliberate bulk tick, one expiry event per due card inside one transaction.
const giftCardRedeem: AutopilotExecutor = async (ctx) => {
  const code = str(ctx.payload.code);
  const amount = typeof ctx.payload.amount === "number" && Number.isFinite(ctx.payload.amount) ? ctx.payload.amount : null;
  if (!code || amount === null || amount <= 0) return fail("missing_fields");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  if (!ctx.authorizedByUserId) return fail("unauthenticated");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await redeemGiftCard(client, {
      businessId: ctx.businessId,
      locationId: branch.locationId,
      code,
      amount,
      createdBy: ctx.authorizedByUserId,
    });
    await client.query("COMMIT");
    return { ok: true, result: { ok: true, balance: result.balance } };
  } catch (err) {
    await client.query("ROLLBACK");
    return { ok: false, result: { error: "redeem_failed", message: (err as Error).message }, errorCode: "redeem_failed" };
  } finally {
    client.release();
  }
};
const giftCardExpireRun: AutopilotExecutor = async (ctx) => {
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await expireGiftCards(client, {
      businessId: ctx.businessId,
      locationId: branch.locationId,
      createdBy: ctx.authorizedByUserId ?? null,
    });
    await client.query("COMMIT");
    return { ok: true, result: { cards: result.cards, totalRial: result.totalRial } };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

// ── Issue #883 package 2, batch AB — messaging templates & send-lane ───────
// The route's known-code list (startsWith matches included) is the executor's
// code map: every service refusal reaches the model as the campaign screen's
// own error text, never a wrapped 500.
const MESSAGING_CODES = [
  "invalid_template", "invalid_campaign", "not_found", "campaign_needs_segment",
  "campaign_already_launched", "campaign_audience_limit_exceeded", "campaign_has_no_recipients",
  "no_reachable_customer", "messaging_not_configured", "template_not_found", "invalid_amount",
  "invalid_template_body", "invalid_template_name",
];
function failMessaging(err: unknown): AutopilotExecutionResult {
  const message = err instanceof Error ? err.message : "";
  if (
    MESSAGING_CODES.some((code) => message.startsWith(code)) ||
    message.startsWith("message_variable_missing") ||
    message.startsWith("unknown_template_variable")
  ) {
    return fail(message);
  }
  throw err;
}
const messagingTemplateSave: AutopilotExecutor = async (ctx) => {
  const channel = str(ctx.payload.channel);
  const name = str(ctx.payload.name);
  const body = typeof ctx.payload.body === "string" ? ctx.payload.body : null;
  if ((channel !== "sms" && channel !== "email") || !name || body === null) return fail("invalid_payload");
  try {
    const template = await saveMessageTemplate(ctx.businessId, {
      channel,
      name,
      subject: channel === "email" ? str(ctx.payload.subject) ?? undefined : undefined,
      body,
    });
    return { ok: true, result: { template: { ...template } } };
  } catch (err) {
    return failMessaging(err);
  }
};
const messagingCampaignPause: AutopilotExecutor = async (ctx) => {
  const campaignId = str(ctx.payload.campaignId) ?? str(ctx.payload.id);
  if (!campaignId) return fail("campaign_required");
  try {
    await pauseMessageCampaign(ctx.businessId, campaignId);
    return { ok: true, result: { ok: true, campaignId, status: "paused" } };
  } catch (err) {
    return failMessaging(err);
  }
};
const messagingCampaignResume: AutopilotExecutor = async (ctx) => {
  const campaignId = str(ctx.payload.campaignId) ?? str(ctx.payload.id);
  if (!campaignId) return fail("campaign_required");
  try {
    await resumeMessageCampaign(ctx.businessId, campaignId);
    return { ok: true, result: { ok: true, campaignId } };
  } catch (err) {
    return failMessaging(err);
  }
};
const messagingCampaignLaunch: AutopilotExecutor = async (ctx) => {
  const campaignId = str(ctx.payload.campaignId) ?? str(ctx.payload.id);
  if (!campaignId) return fail("campaign_required");
  const creditRial =
    typeof ctx.payload.creditRial === "number" && Number.isSafeInteger(ctx.payload.creditRial)
      ? ctx.payload.creditRial
      : undefined;
  const discountCode = str(ctx.payload.discountCode) ?? undefined;
  try {
    const launch = await launchMessageCampaign(ctx.businessId, campaignId, { creditRial, discountCode });
    return { ok: true, result: { launch: { ...(launch as object) } } };
  } catch (err) {
    return failMessaging(err);
  }
};

// ── Issue #883 package 2, batch AA — stock-count edit & reverse ────────────
// Both ride the client-transaction services the routes call, with the own
// count's stored branch (never a guessed one) and the caller's exact code
// map from the route table. A count edit reverses and re-records in one
// transaction; a count reverse restores stock and mirrors the entries.
const countEditErrorCodes = new Set([
  "count_not_found", "count_not_reversible", "already_reversed", "count_layer_settled",
  "count_stock_consumed", "stock_count_reversal_inconsistent", "no_items",
  "invalid_item", "invalid_quantity", "quantity_precision_exceeded", "duplicate_item",
  "item_not_found",
]);
function failCountEdit(err: unknown): AutopilotExecutionResult {
  if (err instanceof MissingLedgerAccountError) return fail("ledger_account_missing");
  const message = err instanceof Error ? err.message : "";
  if (countEditErrorCodes.has(message)) return fail(message);
  throw err;
}
async function stockCountLocation(businessId: string, countId: string): Promise<string | null> {
  const { rows } = await query<{ location_id: string }>(
    `SELECT location_id FROM stock_counts WHERE id = $1 AND business_id = $2`,
    [countId, businessId],
  );
  return rows[0]?.location_id ?? null;
}
const inventoryCountEdit: AutopilotExecutor = async (ctx) => {
  const countId = str(ctx.payload.countId) ?? str(ctx.payload.id);
  if (!countId) return fail("missing_fields");
  if (!ctx.authorizedByUserId) return fail("unauthenticated");
  const { rows: roleRows } = await query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [
    ctx.authorizedByUserId,
  ]);
  const locationId = await stockCountLocation(ctx.businessId, countId);
  if (!locationId) return fail("count_not_found");
  const rawLines = Array.isArray(ctx.payload.lines)
    ? (ctx.payload.lines as Record<string, unknown>[]).map((line) => ({
        inventoryItemId: String(line.inventoryItemId),
        countedQty: line.countedQty as string | number,
      }))
    : [];
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await editStockCount(client, {
      businessId: ctx.businessId,
      locationId,
      countId,
      note: ctx.payload.note === undefined ? undefined : str(ctx.payload.note) ?? null,
      lines: rawLines,
      createdBy: ctx.authorizedByUserId,
      sync: { actorRole: (roleRows[0]?.role ?? "Owner") as Role },
    });
    await client.query("COMMIT");
    return { ok: true, result: { ok: true, ...(result as object) } };
  } catch (err) {
    await client.query("ROLLBACK");
    return failCountEdit(err);
  } finally {
    client.release();
  }
};
const inventoryCountReverse: AutopilotExecutor = async (ctx) => {
  const countId = str(ctx.payload.countId) ?? str(ctx.payload.id);
  if (!countId) return fail("missing_fields");
  if (!ctx.authorizedByUserId) return fail("unauthenticated");
  const { rows: roleRows } = await query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [
    ctx.authorizedByUserId,
  ]);
  const locationId = await stockCountLocation(ctx.businessId, countId);
  if (!locationId) return fail("count_not_found");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await reverseStockCount(client, {
      businessId: ctx.businessId,
      locationId,
      countId,
      createdBy: ctx.authorizedByUserId,
      sync: { actorRole: (roleRows[0]?.role ?? "Owner") as Role },
    });
    await client.query("COMMIT");
    return { ok: true, result: { ok: true, id: result.id } };
  } catch (err) {
    await client.query("ROLLBACK");
    return failCountEdit(err);
  } finally {
    client.release();
  }
};

// ── Issue #883 package 2, batch Z5 — manual-entry reversal ─────────────────
// Mirrors the reverse route one-for-one: isUuid guard first (a normal 404,
// never a Postgres cast error), memo bound, the approver's branch passed as
// the fallback only — the reversal documents travel on the ORIGINAL entry's
// own branch, by the service's explicit design, even in hybrid deployments.
const journalEntryReverse: AutopilotExecutor = async (ctx) => {
  const entryId = str(ctx.payload.entryId) ?? str(ctx.payload.id);
  if (!entryId) return fail("missing_fields");
  if (!isUuid(entryId)) return fail("entry_not_found");
  const memo = ctx.payload.memo === undefined || ctx.payload.memo === null ? undefined : str(ctx.payload.memo) ?? undefined;
  if (typeof memo === "string" && memo.length > MANUAL_MEMO_MAX) return fail("memo_too_long");
  const entryDate = typeof ctx.payload.entryDate === "string" ? ctx.payload.entryDate : undefined;
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!ctx.authorizedByUserId) return fail("unauthenticated");
  // The route passes `session.role` as the sync actor; the connection's
  // authorizing user plays that part here (same shape as supplier returns).
  const { rows: roleRows } = await query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [
    ctx.authorizedByUserId,
  ]);
  try {
    const result = await reverseEntry({
      businessId: ctx.businessId,
      locationId: branch.locationId,
      entryId,
      actorId: ctx.authorizedByUserId,
      memo,
      entryDate,
      sync: { actorRole: (roleRows[0]?.role ?? "Owner") as Role },
    });
    return { ok: true, result: { ...result } };
  } catch (err) {
    if (err instanceof ManualJournalError) return fail(err.message);
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return fail(lockCode);
    throw err;
  }
};

// ── Issue #883 package 2, batch Z4 — the fiscal calendar ───────────────────
// FiscalPeriodError carries status AND optional details the screen reads
// (which period blocks a close; overlap window); surface both, exactly the
// response payrollErrorResponse keeps for payroll.
function failFiscal(err: unknown): AutopilotExecutionResult {
  if (err instanceof FiscalPeriodError) {
    return {
      ok: false,
      result: { error: err.message, ...(err.details ?? {}) },
      errorCode: err.message,
    };
  }
  if (err instanceof MissingLedgerAccountError) return fail("ledger_account_missing");
  throw err;
}
const fiscalYearCreate: AutopilotExecutor = async (ctx) => {
  const jy = typeof ctx.payload.jy === "number" && Number.isInteger(ctx.payload.jy) ? ctx.payload.jy : null;
  if (jy === null) return fail("invalid_jalali_year");
  try {
    const year = await createFiscalYear(ctx.businessId, jy);
    return { ok: true, result: { year: { ...(year as object) } } };
  } catch (err) {
    return failFiscal(err);
  }
};
const fiscalPeriodSetStatus: AutopilotExecutor = async (ctx) => {
  const periodId = str(ctx.payload.periodId) ?? str(ctx.payload.id);
  const status = str(ctx.payload.status);
  if (!periodId || (status !== "open" && status !== "soft_closed" && status !== "locked")) {
    return fail("invalid_status");
  }
  if (!ctx.authorizedByUserId) return fail("no_authorizing_user");
  try {
    const period = await setPeriodStatus(ctx.businessId, periodId, status, ctx.authorizedByUserId);
    return { ok: true, result: { period: { ...(period as object) } } };
  } catch (err) {
    return failFiscal(err);
  }
};
const fiscalYearClose: AutopilotExecutor = async (ctx) => {
  const fiscalYearId = str(ctx.payload.fiscalYearId) ?? str(ctx.payload.id);
  if (!fiscalYearId) return fail("missing_fields");
  if (!ctx.authorizedByUserId) return fail("no_authorizing_user");
  try {
    const result = await closeFiscalYear(ctx.businessId, fiscalYearId, ctx.authorizedByUserId);
    return { ok: true, result: { ...(result as object) } };
  } catch (err) {
    return failFiscal(err);
  }
};

// ── Issue #883 package 2, batch Z3 — reconciliation line clearance ─────────
// The payload flows through the shared parseLineClearanceRequest parser, so
// its disciplines (boolean required, batch wins, empty/over-size batches
// refused, never partly applied) are guaranteed identical to the route.
const reconciliationLineClear: AutopilotExecutor = async (ctx) => {
  const reconciliationId = str(ctx.payload.reconciliationId) ?? str(ctx.payload.id);
  if (!reconciliationId) return fail("missing_fields");
  const parsed = parseLineClearanceRequest({
    cleared: ctx.payload.cleared,
    journalLineId: ctx.payload.journalLineId,
    journalLineIds: ctx.payload.journalLineIds,
  });
  if (!parsed.ok) return fail(parsed.error);
  try {
    if (parsed.value.kind === "batch") {
      const { changed } = await setLinesCleared({
        businessId: ctx.businessId,
        reconciliationId,
        journalLineIds: parsed.value.journalLineIds,
        cleared: parsed.value.cleared,
      });
      return { ok: true, result: { ok: true, changed } };
    }
    await setLineCleared({
      businessId: ctx.businessId,
      reconciliationId,
      journalLineId: parsed.value.journalLineId,
      cleared: parsed.value.cleared,
    });
    return { ok: true, result: { ok: true } };
  } catch (err) {
    if (err instanceof ReconciliationError) return fail(err.message);
    throw err;
  }
};

// ── Issue #883 package 2, batch Z2 — payroll settings & staff pay terms ────
// Both mirror the payroll-http error contract (PayrollError keeps its status
// AND the extra `details` a screen uses to name what field/member blew up;
// MissingLedgerAccountError and fiscal locks keep their distinct codes).
// Pay terms are filtered key-by-key EXACTLY like the route: a non-number
// value can never silently «clear» somebody's wage.
function failPayroll(err: unknown): AutopilotExecutionResult {
  if (err instanceof PayrollError) {
    return { ok: false, result: { error: err.message, ...(err.details ?? {}) }, errorCode: err.message };
  }
  if (err instanceof MissingLedgerAccountError) return fail("ledger_account_missing");
  const lockCode = fiscalPeriodLockErrorCode(err);
  if (lockCode) return fail(lockCode);
  throw err;
}
const payrollSettingsUpdate: AutopilotExecutor = async (ctx) => {
  if (ctx.payload.settings == null || typeof ctx.payload.settings !== "object" || Array.isArray(ctx.payload.settings)) {
    return fail("bad_request");
  }
  try {
    const settings = await savePayrollSettings(ctx.businessId, ctx.payload.settings);
    return { ok: true, result: { settings: { ...(settings as object) } } };
  } catch (err) {
    return failPayroll(err);
  }
};
const payrollStaffTerms: AutopilotExecutor = async (ctx) => {
  const userId = str(ctx.payload.userId);
  const terms = ctx.payload.terms;
  if (!userId || terms == null || typeof terms !== "object" || Array.isArray(terms)) return fail("bad_request");
  const patch: StaffPayTermsPatch = {};
  for (const term of PAY_TERMS) {
    if (!(term in terms)) continue;
    const raw = (terms as Record<string, unknown>)[term];
    if (raw === null && term === "monthlyWage") patch[term] = null;
    else if (typeof raw === "number" && Number.isFinite(raw)) patch[term] = raw;
    else return fail("invalid_amount");
  }
  if (Object.keys(patch).length === 0) return fail("bad_request");
  try {
    await setStaffPayTerms({
      businessId: ctx.businessId,
      userId,
      patch,
      actorId: ctx.authorizedByUserId ?? null,
    });
    return { ok: true, result: { ok: true, userId } };
  } catch (err) {
    return failPayroll(err);
  }
};

// ── Issue #883 package 2, batch Z — fixed-asset acquisition link ───────────
// Byte-for-byte the PATCH route: enum/source validation and not-found are
// the service's, surfacing as FixedAssetError codes.
const fixedAssetSetAcquisition: AutopilotExecutor = async (ctx) => {
  const fixedAssetId = str(ctx.payload.fixedAssetId) ?? str(ctx.payload.id);
  const acquisitionSource = str(ctx.payload.acquisitionSource);
  if (!fixedAssetId || !acquisitionSource) return fail("missing_fields");
  const acquisitionEntryId = ctx.payload.acquisitionEntryId == null ? null : str(ctx.payload.acquisitionEntryId);
  try {
    const fixedAsset = await setFixedAssetAcquisition({
      businessId: ctx.businessId,
      fixedAssetId,
      acquisitionSource,
      acquisitionEntryId,
    });
    return { ok: true, result: { fixedAsset: { ...(fixedAsset as object) } } };
  } catch (err) {
    if (err instanceof FixedAssetError) return fail(err.message);
    throw err;
  }
};

// ── Issue #883 package 2, batch Y2 — chart-of-accounts delete ──────────────
// The service owns every refusal (well-known codes, postings, draft lines,
// child accounts, lost races) and names it with the route's own codes.
const accountDelete: AutopilotExecutor = async (ctx) => {
  const accountId = str(ctx.payload.accountId) ?? str(ctx.payload.id);
  if (!accountId) return fail("missing_fields");
  try {
    await deleteAccount(ctx.businessId, accountId);
    return { ok: true, result: { ok: true, accountId } };
  } catch (err) {
    if (err instanceof AccountsError) return fail(err.message);
    throw err;
  }
};

// ── Issue #883 package 2, batch X — media library organisation ─────────────
// Collections are a grouping layer: create/rename/delete never touch stored
// bytes. The trash is soft (recoverable by media.asset.restore); the HARD
// delete — which removes the storage object for good — deliberately stays
// screen-only (coverage-matrix note).
const mediaCollectionCreate: AutopilotExecutor = async (ctx) => {
  const name = str(ctx.payload.name);
  if (!name) return fail("missing_fields");
  const description = ctx.payload.description === undefined || ctx.payload.description === null ? null : str(ctx.payload.description);
  const record = await createMediaCollection(ctx.businessId, ctx.authorizedByUserId ?? null, name, description);
  return { ok: true, result: { collection: { ...record } } };
};
const mediaCollectionRename: AutopilotExecutor = async (ctx) => {
  const collectionId = str(ctx.payload.collectionId) ?? str(ctx.payload.id);
  const name = str(ctx.payload.name);
  if (!collectionId || !name) return fail("missing_fields");
  const description =
    ctx.payload.description === undefined ? undefined : ctx.payload.description === null ? null : str(ctx.payload.description);
  const ok = await renameMediaCollection(ctx.businessId, collectionId, name, description);
  if (!ok) return fail("collection_not_found");
  return { ok: true, result: { ok: true, collectionId } };
};
const mediaCollectionDelete: AutopilotExecutor = async (ctx) => {
  const collectionId = str(ctx.payload.collectionId) ?? str(ctx.payload.id);
  if (!collectionId) return fail("missing_fields");
  const ok = await deleteMediaCollection(ctx.businessId, collectionId);
  if (!ok) return fail("collection_not_found");
  return { ok: true, result: { ok: true, collectionId } };
};
const mediaAssetSetCollection: AutopilotExecutor = async (ctx) => {
  const assetId = str(ctx.payload.assetId);
  const collectionId = str(ctx.payload.collectionId);
  const action = str(ctx.payload.action);
  if (!assetId || !collectionId || (action !== "add" && action !== "remove")) return fail("invalid_payload");
  const ok =
    action === "add"
      ? await addAssetToCollection(ctx.businessId, collectionId, assetId, ctx.authorizedByUserId ?? null)
      : await removeAssetFromCollection(ctx.businessId, collectionId, assetId);
  if (!ok) return fail("membership_not_found");
  return { ok: true, result: { ok: true, assetId, collectionId, action } };
};
const mediaAssetTrash: AutopilotExecutor = async (ctx) => {
  const assetId = str(ctx.payload.assetId) ?? str(ctx.payload.id);
  if (!assetId) return fail("missing_fields");
  const ok = await softDeleteMediaAsset(ctx.businessId, assetId);
  if (!ok) return fail("asset_not_found");
  return { ok: true, result: { ok: true, assetId, trashed: true } };
};
const mediaAssetRestore: AutopilotExecutor = async (ctx) => {
  const assetId = str(ctx.payload.assetId) ?? str(ctx.payload.id);
  if (!assetId) return fail("missing_fields");
  const ok = await restoreMediaAsset(ctx.businessId, assetId);
  if (!ok) return fail("asset_not_found");
  return { ok: true, result: { ok: true, assetId, restored: true } };
};

// ── Issue #883 package 2, batch V — product masters ────────────────────────
// Thin mirrors of the attribute/barcode-template routes: service returns
// {definition?,error?} / {template?,error?} pairs with the route's own codes.
const productAttributeCreate: AutopilotExecutor = async (ctx) => {
  const rawInput: Record<string, unknown> = {};
  for (const field of ["name", "options", "isActive"] as const) {
    if (Object.hasOwn(ctx.payload, field)) rawInput[field] = ctx.payload[field];
  }
  const parsed = parseAttributeDefinitionInput(rawInput, "create");
  if (!parsed.ok) return fail("validation_failed");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  const result = await createAttributeDefinition({
    businessId: ctx.businessId,
    locationId: branch.locationId,
    name: parsed.data.name!,
    options: parsed.data.options ?? [],
    isActive: parsed.data.isActive ?? true,
  });
  if (result.error) return fail(result.error);
  return { ok: true, result: { definition: result.definition } };
};
const barcodeTemplateCreate: AutopilotExecutor = async (ctx) => {
  const prefix = str(ctx.payload.prefix);
  const weightUnit = str(ctx.payload.weightUnit);
  if (!prefix || !weightUnit) return fail("missing_fields");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  const result = await createWeightBarcodeTemplate({ locationId: branch.locationId, prefix, weightUnit });
  if (result.error) return fail(result.error);
  return { ok: true, result: { template: result.template } };
};

// ── Issue #883 package 2, batch T — the site's domain switch ───────────────
// One remote call; the service normalises the input (trim/lowercase/strip
// dot) before the format check, so all the executor passes is the raw string.
const websiteDomainSet: AutopilotExecutor = async (ctx) => {
  const domain = str(ctx.payload.domain);
  if (!domain) return fail("invalid_payload");
  const result = await updateCmsSiteDomain(ctx.businessId, domain);
  if (!result.ok) return fail(result.error);
  return { ok: true, result: { ...result.data } };
};

// ── Issue #883 package 2, batch S — WooCommerce queue re-pends ─────────────
// A retry only resets an event that was already approved when it first moved
// to the shop; flush just wakes the drainer ahead of its timer. Neither can
// create data on the site the owner has not produced themselves.
const wpQueueRetry: AutopilotExecutor = async (ctx) => {
  const queueRowId = str(ctx.payload.queueRowId) ?? str(ctx.payload.rowId) ?? str(ctx.payload.id);
  if (!queueRowId) return fail("invalid_payload");
  const conn = await resolveWpOwnerConnection(ctx.businessId, str(ctx.payload.connectionId));
  if ("error" in conn) return fail(conn.error);
  const direction = str(ctx.payload.direction);
  const result = await retryWpQueueRow(ctx.businessId, conn.id, queueRowId, direction === "in" ? "in" : direction === "out" ? "out" : undefined);
  if (!result.ok) return fail(result.error ?? "retry_failed");
  return { ok: true, result: { status: result.status ?? "pending", connectionId: conn.id } };
};
const wpQueueRetryAllFailed: AutopilotExecutor = async (ctx) => {
  const conn = await resolveWpOwnerConnection(ctx.businessId, str(ctx.payload.connectionId));
  if ("error" in conn) return fail(conn.error);
  const result = await retryAllFailedWpQueue(ctx.businessId, conn.id);
  if (!result.ok) return fail("retry_failed");
  return { ok: true, result: { outboxRetried: result.outboxRetried, inboxRetried: result.inboxRetried, connectionId: conn.id } };
};
const wpQueueFlush: AutopilotExecutor = async (ctx) => {
  const conn = await resolveWpOwnerConnection(ctx.businessId, str(ctx.payload.connectionId));
  if ("error" in conn) return fail(conn.error);
  const result = await flushWpOutbox(ctx.businessId, conn.id);
  if (!result.ok) return fail("flush_failed");
  return { ok: true, result: { ...result, connectionId: conn.id } };
};

// ── Issue #883 package 2, batch R — website order status ───────────────────
// The route is three lines of guard around this service; the service already
// normalises every refusal to WebsiteResult codes, so the executor is a
// pass-through by exact parity (status enum enforced service-side).
const websiteOrderStatus: AutopilotExecutor = async (ctx) => {
  const orderId = str(ctx.payload.orderId) ?? str(ctx.payload.id);
  const status = str(ctx.payload.status);
  if (!orderId || !status) return fail("invalid_payload");
  const result = await updateCmsOrderStatus(ctx.businessId, orderId, status);
  if (!result.ok) return fail(result.error);
  return { ok: true, result: { order: { ...result.data } } };
};

// ── Issue #883 package 2, batch Q — retail invoice void ────────────────────
// Mirrors POST /api/sales/invoices/[id]/void one-for-one: mandatory reason in
// the amendment bounds, one chosen branch, the reversal service inside a
// single client transaction, the service's own error codes back to the model.
// The floor broadcast the route emits after COMMIT has no socket here; every
// state it announces is already durable inside this transaction.
const retailInvoiceVoid: AutopilotExecutor = async (ctx) => {
  const invoiceId = str(ctx.payload.invoiceId) ?? str(ctx.payload.id);
  const reason = (str(ctx.payload.reason) ?? "").trim();
  if (!invoiceId) return fail("invoice_required");
  if (reason.length < MIN_REASON_LENGTH) return fail("reason_required");
  if (reason.length > MAX_REASON_LENGTH) return fail("reason_too_long");
  const branch = await chosenLocation(ctx.businessId, str(ctx.payload.locationId));
  if ("error" in branch) return fail(branch.error);
  if (!branch.locationId) return fail("invalid_location");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await voidRetailInvoice(client, {
      businessId: ctx.businessId,
      locationId: branch.locationId,
      orderId: invoiceId,
      actorId: ctx.authorizedByUserId ?? "",
      reason,
    });
    await client.query("COMMIT");
    return { ok: true, result: { ...result } };
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof RetailInvoiceVoidError) {
      // Keep the service's actionable Persian refusal (e.g. «فاکتورهای طلا
      // قابل ابطال… نیست») — the UI's toast text and the audit trail both
      // read it, not just the code.
      return { ok: false, result: { error: "void_failed", message: err.message }, errorCode: "void_failed" };
    }
    if (err instanceof MissingLedgerAccountError) return fail("missing_ledger_account");
    const message = err instanceof Error ? err.message : "";
    if (message === "fiscal_period_locked" || message === "fiscal_period_soft_closed") return fail(message);
    throw err;
  } finally {
    client.release();
  }
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

// ── Batch BH — AEC registers close (54 lanes under /api/aec/**) ─────────────
// Four grouped verbs in front of one uniform route pattern: aecOwner(perm) +
// requireProjectCapability(owner, projectId, tier) + service call +
// handleAecError. Review-side actions ride a separate verb because the routes
// demand workspaceApprove there (the MCP capability mirrors it). Field photo
// upload carries media bytes and stays route-only by design.
function failAec(err: unknown): AutopilotExecutionResult {
  if (err instanceof AecError || err instanceof WorkspaceError) return fail(err.code);
  throw err;
}

type Body = Record<string, unknown>;
type AecOwner = NonNullable<Awaited<ReturnType<typeof workspaceOwnerFor>>>;

/** Service payloads are typed interfaces; the executor result wants a record. */
function aecOk(value: unknown): AutopilotExecutionResult {
  return { ok: true, result: value as Record<string, unknown> };
}

// Create lanes: parent = "project" (projectId payload key), parent = "id"
// (resolve project through the parent entity), parent = null (tenant-level
// checklists, like the route that only calls aecOwner).
const AEC_CREATE = {
  rfi: { parent: "project" as const, run: (o: AecOwner, id: string, b: Body) => createRfi(o, id, b) },
  site_issue: { parent: "project" as const, run: (o: AecOwner, id: string, b: Body) => createSiteIssue(o, id, b) },
  site_log: { parent: "project" as const, run: (o: AecOwner, id: string, b: Body) => createSiteLog(o, id, b) },
  variation: { parent: "project" as const, run: (o: AecOwner, id: string, b: Body) => createVariation(o, id, b) },
  request: { parent: "project" as const, run: (o: AecOwner, id: string, b: Body) => createMaterialRequest(o, id, b) },
  submittal: { parent: "project" as const, run: (o: AecOwner, id: string, b: Body) => createSubmittal(o, id, b) },
  transmittal: { parent: "project" as const, run: (o: AecOwner, id: string, b: Body) => createTransmittal(o, id, b) },
  document: { parent: "project" as const, run: (o: AecOwner, id: string, b: Body) => createDrawing(o, id, b) },
  certificate: { parent: "project" as const, run: (o: AecOwner, id: string, b: Body) => createCertificate(o, id, b) },
  commitment: { parent: "project" as const, run: (o: AecOwner, id: string, b: Body) => createCommitment(o, id, b) },
  estimate: { parent: "project" as const, run: (o: AecOwner, id: string, b: Body) => createEstimate(o, id, b) },
  rfq: { parent: "project" as const, run: (o: AecOwner, id: string, b: Body) => createRfq(o, id, b) },
  checklist: { parent: null, run: (o: AecOwner, _id: string, b: Body) => createChecklist(o, b) },
  quotation: {
    parent: "id" as const,
    projectOfParent: (o: AecOwner, id: string) => rfqProjectId(o.businessId, id),
    run: (o: AecOwner, id: string, b: Body) => recordQuotation(o, id, b),
  },
  estimate_version: {
    parent: "id" as const,
    projectOfParent: (o: AecOwner, id: string) => estimateProjectId(o.businessId, id),
    run: (o: AecOwner, id: string, b: Body) => createEstimateVersion(o, id, b),
  },
  document_revision: {
    parent: "id" as const,
    projectOfParent: (o: AecOwner, id: string) => drawingProjectId(o.businessId, id),
    run: (o: AecOwner, id: string, b: Body) => addRevision(o, id, b),
  },
  commitment_delivery: {
    parent: "id" as const,
    projectOfParent: (o: AecOwner, id: string) => commitmentProjectId(o.businessId, id),
    run: (o: AecOwner, id: string, b: Body) => recordDelivery(o, id, b),
  },
  submittal_revision: {
    parent: "id" as const,
    projectOfParent: (o: AecOwner, id: string) => submittalProjectId(o.businessId, id),
    run: (o: AecOwner, id: string, b: Body) => addSubmittalRevision(o, id, b),
  },
} as const;
type AecCreateEntity = keyof typeof AEC_CREATE;

// Edit lanes: entity id → projectIdOf → capability "manage" → updateX/deleteX
// (checklists are tenant-level, like the route).
const AEC_CUD = {
  rfi: { projectIdOf: rfiProjectId, update: updateRfi, delete: deleteRfi },
  site_issue: { projectIdOf: siteIssueProjectId, update: updateSiteIssue, delete: deleteSiteIssue },
  site_log: { projectIdOf: siteLogProjectId, update: updateSiteLog, delete: deleteSiteLog },
  variation: { projectIdOf: variationProjectId, update: updateVariation, delete: deleteVariation },
  request: { projectIdOf: requestProjectId, update: updateMaterialRequest, delete: deleteMaterialRequest },
  submittal: { projectIdOf: submittalProjectId, update: updateSubmittal, delete: deleteSubmittal },
  transmittal: { projectIdOf: transmittalProjectId, update: updateTransmittal, delete: deleteTransmittal },
  document: { projectIdOf: drawingProjectId, update: updateDrawing, delete: deleteDrawing },
  certificate: { projectIdOf: certificateProjectId, update: updateCertificate, delete: deleteCertificate },
  commitment: { projectIdOf: commitmentProjectId, update: updateCommitment, delete: deleteCommitment },
  estimate: { projectIdOf: estimateProjectId, update: updateEstimate, delete: deleteEstimate },
  rfq: { projectIdOf: rfqProjectId, update: updateRfq, delete: deleteRfq },
  quotation: { projectIdOf: quotationProjectId, update: updateQuotation, delete: deleteQuotation },
  submittal_revision: {
    projectIdOf: submittalRevisionProjectId,
    update: updateSubmittalRevision,
    delete: deleteSubmittalRevision,
  },
  drawing_revision: { projectIdOf: revisionProjectId, update: updateRevision, delete: deleteRevision },
  checklist: { projectIdOf: null, update: updateChecklist, delete: deleteChecklist },
} as const;
type AecCudEntity = keyof typeof AEC_CUD;

// Status lanes: manage-side action verbs. `needsApproval` true means the
// entity's review-side set (aec.record.review) like the routes' split guard.
const AEC_RFI_ACTIONS = ["open", "answer", "close", "cancel"];
const AEC_SITE_LOG_ACTIONS = ["submit", "reopen"];
const AEC_TRANSMITTAL_ACTIONS = ["issue", "acknowledge"];

interface AecActionEntry {
  projectIdOf: (businessId: string, id: string) => Promise<string>;
  isAction: (action: string) => boolean;
  needsApproval: (action: string) => boolean;
  apply: (owner: AecOwner, id: string, action: string, payload: Body) => Promise<unknown>;
}

const AEC_ACTIONS: Record<string, AecActionEntry> = {
  rfi: {
    projectIdOf: rfiProjectId,
    isAction: (a) => AEC_RFI_ACTIONS.includes(a),
    needsApproval: () => false,
    apply: (o, id, a, b) => applyRfiAction(o, id, a as never, b),
  },
  site_issue: {
    projectIdOf: siteIssueProjectId,
    isAction: (a) => isSiteIssueAction(a),
    needsApproval: (a) => siteIssueActionNeedsApproval(a as never),
    apply: (o, id, a, b) =>
      applySiteIssueAction(o, id, a as never, {
        resolutionNote: b.resolutionNote,
        result: b.result,
        closeoutNote: b.closeoutNote,
      }),
  },
  site_log: {
    projectIdOf: siteLogProjectId,
    isAction: (a) => AEC_SITE_LOG_ACTIONS.includes(a),
    needsApproval: () => false,
    apply: (o, id, a) => applySiteLogAction(o, id, a as never),
  },
  variation: {
    projectIdOf: variationProjectId,
    isAction: (a) => isVariationAction(a),
    needsApproval: (a) => variationActionNeedsApproval(a as never),
    apply: (o, id, a, b) =>
      applyVariationAction(o, id, a as never, { approvedAmountRial: b.approvedAmountRial, note: b.note }),
  },
  request: {
    projectIdOf: requestProjectId,
    isAction: (a) => isMaterialRequestAction(a),
    needsApproval: (a) => materialRequestActionNeedsApproval(a as never),
    apply: (o, id, a, b) => applyMaterialRequestAction(o, id, a as never, { note: b.note }),
  },
  certificate: {
    projectIdOf: certificateProjectId,
    isAction: (a) => isCertificateAction(a),
    needsApproval: (a) => certificateActionNeedsApproval(a as never),
    apply: (o, id, a, b) =>
      applyCertificateAction(o, id, a as never, { approvedAmountRial: b.approvedAmountRial, note: b.note }),
  },
  commitment: {
    projectIdOf: commitmentProjectId,
    isAction: (a) => isCommitmentAction(a),
    needsApproval: (a) => commitmentActionNeedsApproval(a as never),
    apply: (o, id, a, b) => applyCommitmentAction(o, id, a as never, { note: b.note, deliveredOn: b.deliveredOn }),
  },
  rfq: {
    projectIdOf: rfqProjectId,
    isAction: (a) => isRfqAction(a),
    needsApproval: () => rfqActionNeedsApproval(),
    apply: (o, id, a) => applyRfqAction(o, id, a as never),
  },
  quotation: {
    projectIdOf: quotationProjectId,
    isAction: (a) => isQuotationAction(a),
    needsApproval: () => quotationActionNeedsApproval(),
    apply: (o, id, a) => applyQuotationAction(o, id, a as never),
  },
  transmittal: {
    projectIdOf: transmittalProjectId,
    isAction: (a) => AEC_TRANSMITTAL_ACTIONS.includes(a),
    needsApproval: () => false,
    apply: (o, id, a, b) => (a === "issue" ? issueTransmittal(o, id) : acknowledgeTransmittal(o, id, b)),
  },
};

// These two workflows split inside a single status lane: their "submit" runs
// manage-side (workspace.manage + capability "manage"), the rest review-side
// (workspace.approve + capability "view"), exactly as the routes gate.
AEC_ACTIONS.submittal_revision = {
  projectIdOf: (b, id) => submittalRevisionProjectId(b, id).then((row) => row.projectId),
  isAction: (a) => ["submit", "start_review", "decide", "close"].includes(a),
  needsApproval: (a) => a !== "submit",
  apply: (o, id, a, b) => {
    if (a === "submit") return submitSubmittalRevision(o, id, b);
    if (a === "start_review") return startSubmittalReview(o, id);
    if (a === "close") return closeSubmittalRevision(o, id);
    const decision = str(b.decision) ?? "";
    if (!isSubmittalDecision(decision)) throw new AecError("invalid_submittal_decision");
    return decideSubmittalRevision(o, id, decision, str(b.note) ?? "");
  },
};
AEC_ACTIONS.boq_version = {
  projectIdOf: (b, id) => versionContextProjectId(b, id).then((row) => row.projectId),
  isAction: (a) => ["submit", "start_review", "approve", "return"].includes(a),
  needsApproval: (a) => a !== "submit",
  apply: (o, id, a, b) => {
    if (a === "submit") return submitEstimateVersion(o, id, b);
    if (a === "start_review") return startEstimateReview(o, id);
    if (a === "approve") return approveEstimateVersion(o, id, str(b.note) ?? "");
    return returnEstimateVersion(o, id, str(b.note) ?? "");
  },
};

// Review-side lanes: routes demand workspaceApprove + capability "view".
const AEC_REVIEW: Record<string, AecActionEntry> = {
  site_issue: AEC_ACTIONS.site_issue,
  variation: AEC_ACTIONS.variation,
  request: AEC_ACTIONS.request,
  certificate: AEC_ACTIONS.certificate,
  commitment: AEC_ACTIONS.commitment,
  quotation: AEC_ACTIONS.quotation,
  submittal_revision: AEC_ACTIONS.submittal_revision,
  boq_version: AEC_ACTIONS.boq_version,
};

function aecSideRefuse(entry: AecActionEntry, action: string, side: "manage" | "review"): string | null {
  const reviewSide = entry.needsApproval(action);
  if (side === "manage" && reviewSide) return "use_review_verb";
  if (side === "review" && !reviewSide) return "use_action_verb";
  return null;
}

const aecRecordCreate: AutopilotExecutor = async (ctx) => {
  const entity = str(ctx.payload.entity) as AecCreateEntity | null;
  const entry = entity ? AEC_CREATE[entity] : undefined;
  if (!entry) return fail("bad_entity");
  const body = (ctx.payload.record ?? {}) as Body;
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    if (entry.parent === "project") {
      const projectId = str(ctx.payload.projectId);
      if (!projectId) return fail("project_required");
      await requireProjectCapability(owner, projectId, "manage");
      return aecOk(await entry.run(owner, projectId, body));
    }
    if (entry.parent === "id") {
      const parentId = str(ctx.payload.parentId);
      if (!parentId) return fail("parent_required");
      const projectId = await entry.projectOfParent(owner, parentId);
      await requireProjectCapability(owner, projectId, "manage");
      return aecOk(await entry.run(owner, parentId, body));
    }
    return aecOk(await entry.run(owner, "", body));
  } catch (err) {
    return failAec(err);
  }
};

const aecRecordUpdate: AutopilotExecutor = async (ctx) => {
  const entity = str(ctx.payload.entity) as AecCudEntity | null;
  const entry = entity ? AEC_CUD[entity] : undefined;
  const id = str(ctx.payload.id);
  if (!entry || !id) return fail("missing_fields");
  const patch = (ctx.payload.patch ?? {}) as Body;
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    if (entry.projectIdOf) {
      const found = await entry.projectIdOf(ctx.businessId, id);
      await requireProjectCapability(owner, typeof found === "string" ? found : found.projectId, "manage");
    }
    return aecOk(await entry.update(owner, id, patch));
  } catch (err) {
    return failAec(err);
  }
};

const aecRecordDelete: AutopilotExecutor = async (ctx) => {
  const entity = str(ctx.payload.entity) as AecCudEntity | null;
  const entry = entity ? AEC_CUD[entity] : undefined;
  const id = str(ctx.payload.id);
  if (!entry || !id) return fail("missing_fields");
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    if (entry.projectIdOf) {
      const found = await entry.projectIdOf(ctx.businessId, id);
      await requireProjectCapability(owner, typeof found === "string" ? found : found.projectId, "manage");
    }
    await entry.delete(owner, id);
    return { ok: true, result: { ok: true } };
  } catch (err) {
    return failAec(err);
  }
};

const aecRecordAction: AutopilotExecutor = async (ctx) => {
  const entry = AEC_ACTIONS[str(ctx.payload.entity) ?? ""];
  const id = str(ctx.payload.id);
  const action = str(ctx.payload.action) ?? "";
  if (!entry || !id) return fail("missing_fields");
  if (!entry.isAction(action)) return fail("invalid_action");
  const refuse = aecSideRefuse(entry, action, "manage");
  if (refuse) return fail(refuse);
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    const projectId = await entry.projectIdOf(ctx.businessId, id);
    await requireProjectCapability(owner, projectId, "manage");
    return aecOk(await entry.apply(owner, id, action, ctx.payload as Body));
  } catch (err) {
    return failAec(err);
  }
};

const aecRecordReview: AutopilotExecutor = async (ctx) => {
  const entry = AEC_REVIEW[str(ctx.payload.entity) ?? ""];
  const id = str(ctx.payload.id);
  const action = str(ctx.payload.action) ?? "";
  if (!entry || !id) return fail("missing_fields");
  if (!entry.isAction(action)) return fail("invalid_action");
  const refuse = aecSideRefuse(entry, action, "review");
  if (refuse) return fail(refuse);
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    const projectId = await entry.projectIdOf(ctx.businessId, id);
    await requireProjectCapability(owner, projectId, "view");
    return aecOk(await entry.apply(owner, id, action, ctx.payload as Body));
  } catch (err) {
    return failAec(err);
  }
};

const aecContractCommercialSave: AutopilotExecutor = async (ctx) => {
  const contractId = str(ctx.payload.contractId) ?? str(ctx.payload.id);
  if (!contractId) return fail("missing_fields");
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    // The route only gates when the contract resolves to a project.
    const projectId = await contractProjectId(ctx.businessId, contractId);
    if (projectId) await requireProjectCapability(owner, projectId, "manage");
    const commercial = await saveContractCommercial(owner, contractId, (ctx.payload.commercial ?? {}) as Body);
    return { ok: true, result: { commercial } };
  } catch (err) {
    return failAec(err);
  }
};

const aecBoqVersionSave: AutopilotExecutor = async (ctx) => {
  const versionId = str(ctx.payload.versionId) ?? str(ctx.payload.id);
  if (!versionId) return fail("missing_fields");
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    const { projectId } = await versionContextProjectId(ctx.businessId, versionId);
    await requireProjectCapability(owner, projectId, "manage");
    const tree = await saveDraftVersion(owner, versionId, (ctx.payload.tree ?? {}) as Body);
    return { ok: true, result: { tree } };
  } catch (err) {
    return failAec(err);
  }
};

const aecProfileSave: AutopilotExecutor = async (ctx) => {
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    const profile = await saveBusinessAecProfile(owner, (ctx.payload.profile ?? {}) as Body);
    return { ok: true, result: { profile } };
  } catch (err) {
    return failAec(err);
  }
};

const aecProjectProfileSave: AutopilotExecutor = async (ctx) => {
  const projectId = str(ctx.payload.projectId) ?? str(ctx.payload.id);
  if (!projectId) return fail("missing_fields");
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    await requireProjectCapability(owner, projectId, "manage");
    const profile = await saveProjectAecProfile(owner, projectId, (ctx.payload.profile ?? {}) as Body);
    return { ok: true, result: { profile } };
  } catch (err) {
    return failAec(err);
  }
};

const aecParticipantAdd: AutopilotExecutor = async (ctx) => {
  const projectId = str(ctx.payload.projectId);
  if (!projectId) return fail("missing_fields");
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    await requireProjectCapability(owner, projectId, "manage");
    const participants = await addProjectParticipant(owner, projectId, (ctx.payload.participant ?? {}) as Body);
    return { ok: true, result: { participants } };
  } catch (err) {
    return failAec(err);
  }
};

const aecParticipantUpdate: AutopilotExecutor = async (ctx) => {
  const projectId = str(ctx.payload.projectId);
  const participantId = str(ctx.payload.participantId);
  if (!projectId || !participantId) return fail("missing_fields");
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    await requireProjectCapability(owner, projectId, "manage");
    const participants = await updateProjectParticipant(
      owner,
      projectId,
      participantId,
      (ctx.payload.participant ?? {}) as Body,
    );
    return { ok: true, result: { participants } };
  } catch (err) {
    return failAec(err);
  }
};

const aecParticipantRemove: AutopilotExecutor = async (ctx) => {
  const projectId = str(ctx.payload.projectId);
  const participantId = str(ctx.payload.participantId);
  if (!projectId || !participantId) return fail("missing_fields");
  const owner = await workspaceOwnerFor(ctx);
  if (!owner) return fail("member_not_found");
  try {
    await requireProjectCapability(owner, projectId, "manage");
    const participants = await removeProjectParticipant(owner, projectId, participantId);
    return { ok: true, result: { participants } };
  } catch (err) {
    return failAec(err);
  }
};

// ── Batch BJ — pos.orders money lanes that sit on extracted services ────────
// Amend/re-settle posts a ledger correction against a closed order; a
// customer return refunds + restocks. Always_approve/high like every posting
// lane. Pay/settle itself is still inline orchestration in the route — it
// stays route-only until a manager-service extraction lands (issue #883
// follow-up), which the row note documents.
const ORDER_AMEND_KNOWN_FAILURES = new Set([
  "order_not_found",
  "order_not_completed",
  "order_has_returns",
  "item_not_found",
  "duplicate_item",
  "invalid_item",
  "no_items",
  "menu_item_not_found",
  "modifier_not_found",
  "consumption_layer_settled",
  "consumption_reversal_inconsistent",
  "fiscal_period_locked",
  "fiscal_period_soft_closed",
  "negative_ingredient_requirement",
]);

const orderAmendApply: AutopilotExecutor = async (ctx) => {
  const orderId = str(ctx.payload.orderId) ?? str(ctx.payload.id);
  if (!orderId) return fail("missing_fields");
  if (!ctx.authorizedByUserId) return fail("unauthenticated");
  const location = await settingsActiveLocation(ctx);
  if (!location) return fail("no_location");
  const { orderId: _ignored, id: _ignoredToo, ...body } = ctx.payload;
  const validated = validateAmendment(body as unknown as AmendmentInput);
  if (!validated.ok) return fail(validated.error);
  const { rows: roleRows } = await query<{ role: string }>(
    `SELECT role FROM users WHERE id = $1`,
    [ctx.authorizedByUserId],
  );
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await amendClosedOrder(client, {
      businessId: ctx.businessId,
      locationId: location.id,
      orderId,
      actorId: ctx.authorizedByUserId,
      input: validated.value,
    });
    // Same delivery the route commits: the paired peer replays the correction
    // (migration 0190), so the outbox event lands in this transaction.
    await appendSyncOutboxEvent(client, {
      locationId: location.id,
      clientEventId: `order-amendment:${result.id}`,
      eventType: "order.amendment.posted",
      payload: { orderId, input: body as Record<string, unknown>, newItemIds: result.addedItemIds },
      actorUserId: ctx.authorizedByUserId,
      actorRole: (roleRows[0]?.role ?? "Owner") as Role,
    });
    await client.query("COMMIT");
    broadcast(location.id, { type: "order.updated", orderId });
    return aecOk(result);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err instanceof OrderAmendmentError) return fail(err.message);
    if (err instanceof MissingLedgerAccountError) return fail("ledger_account_missing");
    const message = err instanceof Error ? err.message : "";
    if (ORDER_AMEND_KNOWN_FAILURES.has(message)) return fail(message);
    if (message.startsWith("inventory_exact_cutover_required")) return fail("inventory_exact_cutover_required");
    throw err;
  } finally {
    client.release();
  }
};

const orderReturnCreate: AutopilotExecutor = async (ctx) => {
  const orderId = str(ctx.payload.orderId) ?? str(ctx.payload.id);
  if (!orderId) return fail("missing_fields");
  if (!ctx.authorizedByUserId) return fail("unauthenticated");
  const location = await settingsActiveLocation(ctx);
  if (!location) return fail("no_location");
  const refundMethod = (str(ctx.payload.refundMethod) ?? "cash") as
    | "cash"
    | "card"
    | "card_to_card"
    | "online";
  if (!["cash", "card", "card_to_card", "online"].includes(refundMethod)) {
    return fail("invalid_refund_method");
  }
  if (!str(ctx.payload.refundAmountRial)) return fail("invalid_rial");
  const rawLines = Array.isArray(ctx.payload.lines) ? (ctx.payload.lines as Record<string, unknown>[]) : [];
  const lines = rawLines.map((line) => ({
    orderItemId: str(line.orderItemId) ?? "",
    quantity: positiveQuantityText(str(line.quantity) ?? ""),
    disposition: (line.disposition === "restockable" ? "restockable" : "discarded") as
      | "restockable"
      | "discarded",
  }));
  const { rows: roleRows } = await query<{ role: string }>(
    `SELECT role FROM users WHERE id = $1`,
    [ctx.authorizedByUserId],
  );
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await createCustomerReturn(client, {
      businessId: ctx.businessId,
      locationId: location.id,
      orderId,
      refundMethod,
      refundAmount: rialText(str(ctx.payload.refundAmountRial) ?? ""),
      reason: str(ctx.payload.reason) ?? "",
      idempotencyKey: str(ctx.payload.idempotencyKey) ?? "",
      createdBy: ctx.authorizedByUserId,
      sync: { actorRole: (roleRows[0]?.role ?? "Owner") as Role },
      lines,
    });
    await client.query("COMMIT");
    // The route's owner-facing card rides `duplicate === false` only — an
    // idempotent replay must not claim a second refund happened.
    if (!(result as { duplicate?: boolean }).duplicate) {
      await recordNotification({
        businessId: ctx.businessId,
        locationId: location.id,
        eventKey: "payment.refunded",
        severity: "important",
        title: "برگشت وجه به مشتری",
        body: `${tomanText((result as { refundAmount?: string }).refundAmount ?? "0")}${str(ctx.payload.reason)?.trim() ? ` — ${str(ctx.payload.reason)?.trim()}` : ""}`,
        url: "/accounting/orders",
        amountRial: (result as { refundAmount?: string }).refundAmount ?? "0",
        dedupeKey: notificationDedupeKey("payment.refunded", (result as { id: string }).id),
        payload: { orderId, returnId: (result as { id: string }).id },
      });
    }
    return aecOk(result);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // The route's catch straight-returns err.message; keep that code surface.
    if (err instanceof Error && err.message) return fail(err.message);
    throw err;
  } finally {
    client.release();
  }
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
  workspaceDocumentCreate,
  workspaceDocumentUpdate,
  workspaceDocumentDelete,
  workspaceTemplateSave,
  workspaceTemplateArchive,
  workspaceEventCreate,
  workspaceEventUpdate,
  workspaceEventDelete,
  workspaceCommentAdd,
  priceListCreate,
  priceListRename,
  priceListDelete,
  priceListEntriesSave,
  priceListQuickUpdate,
  retailInvoiceVoid,
  websiteOrderStatus,
  websiteDomainSet,
  accountDelete,
  fixedAssetSetAcquisition,
  payrollSettingsUpdate,
  payrollStaffTerms,
  reconciliationLineClear,
  journalEntryReverse,
  inventoryCountEdit,
  inventoryCountReverse,
  jewelryItemSell,
  jewelryBuybackCreate,
  jewelryLayawayCreate,
  jewelryLayawayPay,
  jewelryLayawayComplete,
  jewelryConsignorPayout,
  jewelryPriceRecord,
  jewelryConsignorCreate,
  cosmeticsBrandCreate,
  cosmeticsItemCreate,
  cosmeticsBatchReceive,
  cosmeticsStockUpdate,
  cosmeticsTesterOpen,
  cosmeticsProfileUpdate,
  cosmeticsMatrixCreate,
  accessoriesItemCreate,
  accessoriesItemSell,
  accessoriesStockUpdate,
  wholesaleItemCreate,
  wholesaleItemSell,
  wholesaleStockUpdate,
  toolsFittingsItemCreate,
  toolsFittingsItemSell,
  toolsFittingsStockUpdate,
  haberdasheryItemCreate,
  haberdasheryItemSell,
  haberdasheryStockUpdate,
  dataScheduleCreate,
  dataScheduleUpdate,
  dataScheduleRun,
  dataScheduleDelete,
  dataTemplateCreate,
  dataTemplateUpdate,
  dataTemplateDelete,
  dataImportRun,
  projectMemberSet,
  projectMemberRemove,
  projectPhaseCreate,
  contractCreate,
  contractUpdate,
  contractDelete,
  contractLifecycle,
  crmCustomFieldSave,
  crmCustomFieldArchive,
  barcodeBulkMint,
  purchaseUpdate,
  purchaseLifecycle,
  purchaseReceive,
  purchaseDelete,
  supplierUpdate,
  supplierArchive,
  tableEdit,
  tableStatus,
  tableDelete,
  reservationCreate,
  reservationEdit,
  reservationLifecycle,
  reservationDelete,
  floorSectionCreate,
  floorSectionUpdate,
  floorSectionDelete,
  kitchenItemStatus,
  wasteRecord,
  writeDownCreate,
  writeDownReverse,
  aiAutomationSave,
  aiAutomationDelete,
  aiAutomationRun,
  coworkerJobSave,
  coworkerJobDelete,
  coworkerJobRun,
  memoryAdd,
  memoryDelete,
  settingsBusinessSave,
  settingsPricingSave,
  settingsTaxSave,
  settingsOnlinePlatformsSave,
  settingsMfaPolicySave,
  settingsAccountsSave,
  paymentMethodCreate,
  paymentMethodUpdate,
  paymentMethodDelete,
  paymentMethodReorder,
  printerCreate,
  printerUpdate,
  printerDelete,
  printTemplateSave,
  printTemplateDelete,
  settingsPrintRulesSave,
  integrationsSyncProducts,
  integrationsSyncOrders,
  integrationsSyncCustomers,
  integrationsSyncInventory,
  integrationsConnectionTest,
  websiteSetupSave,
  websiteDesignThemeSave,
  websiteCdnPurge,
  websiteProductCreate,
  websiteProductUpdate,
  websiteProductDelete,
  websitePostDelete,
  websiteMediaUpdate,
  websiteMediaDelete,
  wpContentSync,
  wpPostSave,
  wpMediaCreate,
  commissionRuleSave,
  commissionRuleSetActive,
  courierCreate,
  courierSetActive,
  deliveryAssign,
  deliveryStatusSet,
  businessDayClose,
  businessDayReopen,
  businessDayConfigSave,
  rollupPush,
  rollupLocationSetActive,
  inventoryItemSave,
  inventoryItemDelete,
  aecRecordCreate,
  aecRecordUpdate,
  aecRecordDelete,
  aecRecordAction,
  aecRecordReview,
  aecContractCommercialSave,
  aecBoqVersionSave,
  aecProfileSave,
  aecProjectProfileSave,
  aecParticipantAdd,
  aecParticipantUpdate,
  aecParticipantRemove,
  orderAmendApply,
  orderReturnCreate,
  jewelryItemCreate,
  jewelryItemUpdate,
  jewelryStoneAdd,
  jewelryStoneDelete,
  jewelryItemConsign,
  workspaceApprovalRequest,
  workspaceApprovalDecide,
  productAttributeUpdate,
  productAttributeDelete,
  barcodeTemplateDelete,
  deviceRename,
  deviceRevoke,
  backupConfigSet,
  backupRunNow,
  backupRestoreApply,
  tableSessionOpen,
  tableSessionUpdate,
  loyaltyPointsRedeem,
  loyaltyStoreCreditIssue,
  loyaltyStoreCreditUse,
  loyaltyProgramUpsert,
  crmDealDelete,
  crmCaseDelete,
  giftCardRedeem,
  giftCardExpireRun,
  messagingTemplateSave,
  messagingCampaignPause,
  messagingCampaignResume,
  messagingCampaignLaunch,
  fiscalYearCreate,
  fiscalPeriodSetStatus,
  fiscalYearClose,
  mediaCollectionCreate,
  mediaCollectionRename,
  mediaCollectionDelete,
  mediaAssetSetCollection,
  mediaAssetTrash,
  mediaAssetRestore,
  productAttributeCreate,
  barcodeTemplateCreate,
  wpQueueRetry,
  wpQueueRetryAllFailed,
  wpQueueFlush,
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
  const actor = await orderActorForAutopilot(ctx);
  if (!actor) return fail("no_authorizing_user");
  const applied = await applyOrderDiscount({ locationId, orderId, discount, actor });
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
  // Same audience as the forward write (issue #947, item 2): a revert is a write, and a
  // narrower member must not be able to undo somebody else's protected edit either.
  const audience = await partyWriteAudienceForActor(ctx.businessId, ctx.authorizedByUserId);
  const restored = await updateCustomer(
    ctx.businessId,
    customerId,
    { notes: typeof prior === "string" ? prior : "" },
    { actorId: ctx.authorizedByUserId, ...(audience ? { audience } : {}) },
  );
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
