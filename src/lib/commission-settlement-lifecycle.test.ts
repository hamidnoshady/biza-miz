import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "./permissions";
import {
  COMMISSION_RUN_ACTIONS,
  COMMISSION_RUN_STATUSES,
  actionAllowedInStatus,
  availableRunActions,
  isCommissionRunStatus,
  mayApproveRun,
  requiredPermissionFor,
  statusForPaidTotal,
  type CommissionRunStatus,
} from "./commission-settlement-lifecycle";

const ALL = new Set<string>([
  PERMISSIONS.commissionView,
  PERMISSIONS.commissionCalculate,
  PERMISSIONS.commissionApprove,
  PERMISSIONS.commissionPayout,
  PERMISSIONS.commissionReverse,
]);
const has = (set: Set<string>) => (permission: string) => set.has(permission);

describe("the settlement lifecycle", () => {
  it("walks the forward path one step at a time", () => {
    expect(availableRunActions("draft", 0n, has(ALL))).toEqual(["calculate", "void"]);
    expect(availableRunActions("calculated", 0n, has(ALL))).toEqual(["review", "reject", "void"]);
    expect(availableRunActions("reviewed", 0n, has(ALL))).toEqual(["approve", "reject", "void"]);
    expect(availableRunActions("approved", 0n, has(ALL))).toEqual(["reject", "release", "void"]);
    expect(availableRunActions("payable", 0n, has(ALL))).toEqual(["reject", "void", "pay"]);
  });

  it("offers payment and closing only once money has moved, and reversal only then too", () => {
    expect(availableRunActions("partially_paid", 500n, has(ALL))).toEqual(["pay", "reverse_payout", "close"]);
    expect(availableRunActions("paid", 1000n, has(ALL))).toEqual(["reverse_payout", "close"]);
    expect(availableRunActions("closed", 1000n, has(ALL))).toEqual([]);
    expect(availableRunActions("voided", 0n, has(ALL))).toEqual([]);
  });

  it("never allows a reject or a void once any payout exists", () => {
    expect(actionAllowedInStatus("reject", "partially_paid", 1n)).toBe(false);
    expect(actionAllowedInStatus("void", "partially_paid", 1n)).toBe(false);
    expect(actionAllowedInStatus("reject", "payable", 0n)).toBe(true);
  });

  it("refuses every action out of order", () => {
    expect(actionAllowedInStatus("approve", "calculated", 0n)).toBe(false);
    expect(actionAllowedInStatus("release", "reviewed", 0n)).toBe(false);
    expect(actionAllowedInStatus("pay", "approved", 0n)).toBe(false);
    expect(actionAllowedInStatus("calculate", "calculated", 0n)).toBe(false);
  });

  it("gives each action the permission its step needs", () => {
    expect(requiredPermissionFor("calculate", "draft")).toBe(PERMISSIONS.commissionCalculate);
    expect(requiredPermissionFor("review", "calculated")).toBe(PERMISSIONS.commissionApprove);
    expect(requiredPermissionFor("approve", "reviewed")).toBe(PERMISSIONS.commissionApprove);
    expect(requiredPermissionFor("release", "approved")).toBe(PERMISSIONS.commissionPayout);
    expect(requiredPermissionFor("pay", "payable")).toBe(PERMISSIONS.commissionPayout);
    expect(requiredPermissionFor("close", "paid")).toBe(PERMISSIONS.commissionPayout);
    expect(requiredPermissionFor("reverse_payout", "paid")).toBe(PERMISSIONS.commissionReverse);
  });

  it("voids a draft or calculated run as calculation work, and a later one as approval work", () => {
    expect(requiredPermissionFor("void", "draft")).toBe(PERMISSIONS.commissionCalculate);
    expect(requiredPermissionFor("void", "calculated")).toBe(PERMISSIONS.commissionCalculate);
    expect(requiredPermissionFor("void", "approved")).toBe(PERMISSIONS.commissionApprove);
    expect(requiredPermissionFor("void", "payable")).toBe(PERMISSIONS.commissionApprove);
  });

  it("hides every action from a person who holds none of the keys (the split is real)", () => {
    const viewOnly = new Set<string>([PERMISSIONS.commissionView]);
    expect(availableRunActions("calculated", 0n, has(viewOnly))).toEqual([]);
    expect(availableRunActions("approved", 0n, has(viewOnly))).toEqual([]);
    // Calculating does not let someone approve or pay.
    const calculatorOnly = new Set<string>([PERMISSIONS.commissionView, PERMISSIONS.commissionCalculate]);
    expect(availableRunActions("calculated", 0n, has(calculatorOnly))).toEqual(["void"]);
    expect(availableRunActions("draft", 0n, has(calculatorOnly))).toEqual(["calculate", "void"]);
    // Approving does not let someone pay.
    const approverOnly = new Set<string>([PERMISSIONS.commissionView, PERMISSIONS.commissionApprove]);
    expect(availableRunActions("payable", 0n, has(approverOnly))).toEqual(["reject", "void"]);
  });
});

describe("separation of duties", () => {
  it("refuses the calculator's own approval, with no owner exemption", () => {
    expect(mayApproveRun("user-a", "user-a")).toBe(false);
    expect(mayApproveRun("user-a", "user-b")).toBe(true);
  });

  it("lets a run whose calculator no longer exists be approved by someone present", () => {
    expect(mayApproveRun(null, "user-b")).toBe(true);
  });
});

describe("statuses after money moves", () => {
  it("is payable with nothing paid, partially paid in between, and paid in full", () => {
    expect(statusForPaidTotal(0n, 1000n)).toBe("payable");
    expect(statusForPaidTotal(400n, 1000n)).toBe("partially_paid");
    expect(statusForPaidTotal(1000n, 1000n)).toBe("paid");
  });

  it("walks back down on a reversal, so a reversal of the last payout is payable again", () => {
    expect(statusForPaidTotal(0n, 1000n)).toBe("payable");
    expect(statusForPaidTotal(600n, 1000n)).toBe("partially_paid");
  });
});

describe("the status and action vocabulary", () => {
  it("names every status and action the API can return", () => {
    expect(COMMISSION_RUN_STATUSES).toEqual([
      "draft",
      "calculated",
      "reviewed",
      "approved",
      "payable",
      "partially_paid",
      "paid",
      "closed",
      "voided",
    ]);
    expect(COMMISSION_RUN_ACTIONS).toHaveLength(9);
  });

  it("recognises only real statuses", () => {
    expect(isCommissionRunStatus("paid" satisfies CommissionRunStatus)).toBe(true);
    expect(isCommissionRunStatus("pending")).toBe(false);
    expect(isCommissionRunStatus(undefined)).toBe(false);
  });
});
