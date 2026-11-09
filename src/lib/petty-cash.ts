export const PETTY_CASH_APPROVER_ROLES = ["owner", "admin", "manager", "accountant"] as const;
export type PettyCashApproverRole = (typeof PETTY_CASH_APPROVER_ROLES)[number];
export type PettyCashPolicy = "fixed" | "variable";
export type PettyCashOperationKind = "fund" | "submit" | "replenish" | "reconcile" | "close";
export type PettyCashOperationStatus = "posted" | "pending" | "approved" | "rejected" | "matched" | "discrepancy";

export function pettyCashCanDecide(
  actorId: string,
  submitterId: string | null,
  role: string,
  allowedRoles: readonly string[],
  canApproveLedger: boolean,
): boolean {
  return canApproveLedger && actorId !== submitterId && allowedRoles.includes(role);
}

export function pettyCashMovementProblem(
  kind: "fund" | "replenish" | "approve" | "close",
  policy: PettyCashPolicy,
  ceilingText: string,
  balanceText: string,
  amountText: string,
): string | null {
  const ceiling = BigInt(ceilingText);
  const balance = BigInt(balanceText);
  const amount = BigInt(amountText);
  if (kind === "close") return amount === balance ? null : "float_count_mismatch";
  if (kind === "approve") return amount <= balance ? null : "insufficient_float";
  if (balance + amount > ceiling) return "float_ceiling_exceeded";
  if (policy === "fixed" && balance + amount !== ceiling) return "fixed_float_must_fill";
  return null;
}

export interface PettyCashFund {
  id: string;
  accountId: string;
  accountName: string;
  locationId: string;
  locationName: string;
  custodianId: string;
  custodianName: string;
  fundingAccountId: string;
  fundingAccountName: string;
  ceiling: string;
  balance: string;
  policy: PettyCashPolicy;
  categoryAccountIds: string[];
  approvalRoles: PettyCashApproverRole[];
  fundedAt: string | null;
  closedAt: string | null;
  canSubmit: boolean;
  canDecide: boolean;
}

export type PettyCashOperation = {
  id: string;
  fundId: string;
  kind: PettyCashOperationKind;
  status: PettyCashOperationStatus;
  businessDate: string;
  amount: string;
  ledgerBalance: string | null;
  note: string;
  categoryAccountId: string | null;
  categoryName: string | null;
  receiptAssetId: string | null;
  receiptFileName: string | null;
  transferId: string | null;
  expenseId: string | null;
  actorId: string | null;
  actorName: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
};
