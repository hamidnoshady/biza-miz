import { query, withTenantTransaction } from "./db";
import { getBusinessIndustry } from "./industry-guard";
import { nextBusinessRegisterNumber } from "./register-numbering";
import { requireProjectCapability, WorkspaceError, type WorkspaceOwner } from "./workspace";
import { approvalDecisionError, type WorkspaceApprovalDecision } from "./workspace-shared";
import { normalizeAgencyCostAmount, normalizeAgencyCostDate } from "./agency-reimbursable-cost";
import { createAgencyReimbursableCost } from "./agency-reimbursable-cost-service";
import { VendorPurchaseError, type VendorPurchaseStatus } from "./agency-vendor-purchase";

const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const text = (value: unknown, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new VendorPurchaseError("invalid_purchase");
  return value.trim();
};
async function activity(owner: WorkspaceOwner, row: VendorPurchase, action: string) {
  await query(`INSERT INTO workspace_activity (business_id,project_id,subject_type,subject_id,action,summary,actor_id,actor_name)
    VALUES ($1,$2,'vendor_purchase',$3,$4,$5,$6,$7)`,
    [owner.businessId,row.project_id,row.id,action,`${row.purchase_number} — ${action}`,owner.actorUserId,owner.actorName ?? ""]);
}
async function agency(businessId: string) {
  if (await getBusinessIndustry(businessId) !== "advertising_agency") throw new VendorPurchaseError("not_agency");
}
export type VendorPurchase = {
  id: string; purchase_number: string; project_id: string; party_id: string; vendor_party_id: string;
  quote_reference: string; description: string; amount_rial: string; quoted_on: string;
  status: VendorPurchaseStatus; cost_id: string | null; created_by: string;
};
const columns = "id, purchase_number, project_id, party_id, vendor_party_id, quote_reference, description, amount_rial::text, quoted_on::text, status, cost_id, created_by";

export async function listVendorPurchases(owner: WorkspaceOwner, projectId: string): Promise<(VendorPurchase & {client_name: string; vendor_name: string})[]> {
  await agency(owner.businessId);
  if (!uuid(projectId)) throw new VendorPurchaseError("invalid_purchase");
  await requireProjectCapability(owner, projectId, "view");
  return (await query<VendorPurchase & {client_name: string; vendor_name: string}>(`SELECT ${columns},
    (SELECT p.name FROM parties p WHERE p.business_id=$1 AND p.id=agency_vendor_purchases.party_id) AS client_name,
    (SELECT p.name FROM parties p WHERE p.business_id=$1 AND p.id=agency_vendor_purchases.vendor_party_id) AS vendor_name
    FROM agency_vendor_purchases WHERE business_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 200`, [owner.businessId, projectId])).rows;
}

export async function createVendorPurchase(owner: WorkspaceOwner, input: Record<string, unknown>): Promise<VendorPurchase> {
  await agency(owner.businessId);
  if (!uuid(input.projectId) || !uuid(input.partyId) || !uuid(input.vendorPartyId)) throw new VendorPurchaseError("invalid_purchase");
  await requireProjectCapability(owner, input.projectId, "manage");
  const description = text(input.description, 500), reference = text(input.quoteReference, 200);
  const amount = normalizeAgencyCostAmount(input.amountRial), date = normalizeAgencyCostDate(input.quotedOn);
  if (amount === null || !date) throw new VendorPurchaseError("invalid_purchase");
  return withTenantTransaction(owner.businessId, async () => {
    const parties = await query<{ id: string }>(`SELECT id FROM parties WHERE business_id=$1 AND is_active AND merged_into_id IS NULL
      AND ((id=$2 AND 'customer'=ANY(roles)) OR (id=$3 AND 'supplier'=ANY(roles))) FOR SHARE`, [owner.businessId, input.partyId, input.vendorPartyId]);
    if (!parties.rows.some(p => p.id === input.partyId) || !parties.rows.some(p => p.id === input.vendorPartyId)) throw new VendorPurchaseError("invalid_purchase");
    const number = await nextBusinessRegisterNumber("agency_vendor_purchases", owner.businessId, "VP");
    const row = (await query<VendorPurchase>(`INSERT INTO agency_vendor_purchases
      (business_id,project_id,party_id,vendor_party_id,purchase_number,quote_reference,description,amount_rial,quoted_on,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${columns}`,
      [owner.businessId, input.projectId, input.partyId, input.vendorPartyId, number, reference, description, amount, date, owner.actorUserId])).rows[0];
    await activity(owner,row,"ثبت پیشنهاد فروشنده");
    return row;
  });
}

async function lockedPurchase(owner: WorkspaceOwner, id: string): Promise<VendorPurchase> {
  if (!uuid(id)) throw new VendorPurchaseError("purchase_not_found");
  const row = (await query<VendorPurchase>(`SELECT ${columns} FROM agency_vendor_purchases WHERE business_id=$1 AND id=$2 FOR UPDATE`, [owner.businessId, id])).rows[0];
  if (!row) throw new VendorPurchaseError("purchase_not_found");
  return row;
}

export async function submitVendorPurchase(owner: WorkspaceOwner, id: string): Promise<void> {
  await agency(owner.businessId);
  await withTenantTransaction(owner.businessId, async () => {
    const row = await lockedPurchase(owner, id);
    await requireProjectCapability(owner, row.project_id, "manage");
    if (row.status !== "draft") throw new VendorPurchaseError("invalid_purchase_state");
    await query(`INSERT INTO workspace_approvals (business_id,subject_type,subject_id,project_id,title,requested_by)
      VALUES ($1,'vendor_purchase',$2,$3,$4,$5)`, [owner.businessId, id, row.project_id, `${row.purchase_number} — ${row.description}`.slice(0,200), owner.actorUserId]);
    await query(`UPDATE agency_vendor_purchases SET status='submitted' WHERE business_id=$1 AND id=$2`, [owner.businessId, id]);
    await activity(owner,row,"ارسال برای تأیید خرید");
  });
}

/** The shared queue owns the decision. Approving never posts an expense. */
export async function decideVendorPurchaseApproval(owner: WorkspaceOwner, approvalId: string, decision: WorkspaceApprovalDecision, note = ""): Promise<{ purchaseId: string; applied: boolean }> {
  await agency(owner.businessId);
  if (!uuid(approvalId)) throw new VendorPurchaseError("purchase_not_found");
  if (!["approved","rejected","changes_requested","cancelled"].includes(decision)) throw new VendorPurchaseError("invalid_purchase");
  return withTenantTransaction(owner.businessId, async () => {
    const a = (await query<{ subject_id: string; requested_by: string | null; approver_user_id: string | null; status: string }>(
      `SELECT subject_id,requested_by,approver_user_id,status FROM workspace_approvals
       WHERE business_id=$1 AND id=$2 AND subject_type='vendor_purchase' FOR UPDATE`, [owner.businessId, approvalId])).rows[0];
    if (!a) throw new VendorPurchaseError("purchase_not_found");
    const row = await lockedPurchase(owner, a.subject_id);
    await requireProjectCapability(owner, row.project_id, "view");
    if (a.status !== "pending") return { purchaseId: row.id, applied: false };
    let canManage = false;
    try { await requireProjectCapability(owner, row.project_id, "manage"); canManage = true; }
    catch (err) { if (!(err instanceof WorkspaceError)) throw err; }
    const refusal = approvalDecisionError({ decision, actorUserId: owner.actorUserId, requestedBy: a.requested_by,
      approverUserId: a.approver_user_id, isAdministrator: owner.access?.override === "administer", canManageSubject: canManage });
    if (refusal) throw new WorkspaceError(refusal);
    if (row.status !== "submitted") throw new VendorPurchaseError("invalid_purchase_state");
    await query(`UPDATE workspace_approvals SET status=$3,decided_by=$4,decided_at=now(),note=$5,updated_at=now()
      WHERE business_id=$1 AND id=$2`, [owner.businessId, approvalId, decision, owner.actorUserId, note.slice(0,1000)]);
    const status = decision === "approved" ? "approved" : decision === "cancelled" ? "draft" : "rejected";
    await query(`UPDATE agency_vendor_purchases SET status=$3 WHERE business_id=$1 AND id=$2`, [owner.businessId, row.id, status]);
    await activity(owner,row,`تصمیم خرید: ${decision}`);
    return { purchaseId: row.id, applied: true };
  });
}

/** Explicit accounting act; caller must additionally hold finance.expenses_manage. */
export async function bookVendorPurchase(owner: WorkspaceOwner, id: string, spentOn: unknown): Promise<{ costId: string }> {
  await agency(owner.businessId);
  const date = normalizeAgencyCostDate(spentOn);
  if (!date) throw new VendorPurchaseError("invalid_purchase");
  return withTenantTransaction(owner.businessId, async () => {
    const row = await lockedPurchase(owner, id);
    await requireProjectCapability(owner, row.project_id, "manage");
    if (row.status === "booked" && row.cost_id) return { costId: row.cost_id };
    if (row.status !== "approved") throw new VendorPurchaseError("invalid_purchase_state");
    const cost = await createAgencyReimbursableCost(owner.businessId, { userId: owner.actorUserId, name: owner.actorName ?? "" }, {
      partyId: row.party_id, projectId: row.project_id, vendorPartyId: row.vendor_party_id,
      description: `${row.purchase_number} — ${row.description}`.slice(0,500), amountRial: row.amount_rial,
      spentOn: date, settledBy: "payable", note: `پیشنهاد فروشنده: ${row.quote_reference}`,
      // Presentation intentionally omitted: apply the adopted business policy.
    });
    if (!cost.posted) throw new VendorPurchaseError("purchase_not_posted");
    await query(`UPDATE agency_vendor_purchases SET status='booked',cost_id=$3 WHERE business_id=$1 AND id=$2`, [owner.businessId, row.id, cost.id]);
    await activity(owner,row,"ثبت هزینه در پرداختنی");
    return { costId: cost.id };
  });
}
