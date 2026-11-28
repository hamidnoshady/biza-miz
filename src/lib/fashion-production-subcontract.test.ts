import { describe, expect, it } from "vitest";
import { actionAllowed, wipBalance } from "./fashion-production";
import {
  assertCustodyReturn,
  cancelBlocker,
  closeBlockers,
  custodyBalance,
  custodyMovements,
  heldAtStage,
  inspectReceipt,
  isSubcontractAction,
  subcontractActionAllowed,
  subcontractCharge,
  subcontractHeld,
} from "./fashion-production-subcontract";

const units = (sent: string, accepted = "0", scrapped = "0", shortage = "0") => ({ sent, accepted, scrapped, shortage });

describe("GH #1567 6.3 — subcontract rules", () => {
  it("counts held units as sent minus every inspected outcome except rework", () => {
    expect(subcontractHeld(units("10", "4", "1", "1"))).toBe("4");
    // Rework units are inspected but stay held, so they never leave the count.
    const inspection = inspectReceipt(units("10"), { accepted: "6", rework: "2", scrapped: "1", shortage: "1" });
    expect(inspection).toEqual({ accepted: "6", rework: "2", scrapped: "1", shortage: "1" });
  });

  it("refuses an inspection of more units than the subcontractor holds, or of nothing", () => {
    expect(() => inspectReceipt(units("10", "8"), { accepted: "3" })).toThrow("subcontract_quantity_exceeded");
    expect(() => inspectReceipt(units("10"), {})).toThrow("invalid_quantity");
    expect(() => inspectReceipt(units("10"), { accepted: "-1" })).toThrow("invalid_quantity");
    expect(() => inspectReceipt(units("10"), { accepted: "1.0000000001" })).toThrow("invalid_quantity");
  });

  it("charges only accepted units, rounded half-up to whole Rial", () => {
    expect(subcontractCharge(150_000n, "4")).toBe(600_000n);
    expect(subcontractCharge(3n, "0.5")).toBe(2n);
    expect(subcontractCharge(150_000n, "0")).toBe(0n);
    expect(subcontractCharge(0n, "5")).toBe(0n);
  });

  it("sums held units per stage across open subcontracts only", () => {
    const list = [
      { ...units("5", "1"), stageCode: "sew", status: "approved" as const },
      { ...units("3"), stageCode: "sew", status: "disputed" as const },
      { ...units("9"), stageCode: "sew", status: "closed" as const },
      { ...units("2"), stageCode: "finish", status: "approved" as const },
    ];
    expect(heldAtStage(list, "sew")).toBe("7");
    expect(heldAtStage(list, "finish")).toBe("2");
    expect(heldAtStage(list, "cut")).toBe("0");
  });

  it("moves custody: worked units consume, missing units lose, capped at what is held", () => {
    const lines = [
      { materialItemId: "fabric", quantityPerUnit: "2.5", sent: "20", returned: "0", consumed: "0", lost: "0" },
      { materialItemId: "zip", quantityPerUnit: "1", sent: "3", returned: "1", consumed: "0", lost: "0" },
    ];
    const moves = custodyMovements(lines, { accepted: "4", rework: "1", scrapped: "1", shortage: "1" });
    expect(moves).toEqual([
      { materialItemId: "fabric", consumed: "12.5", lost: "2.5" },
      // Only 2 zips were left with the subcontractor: both consumed, none to lose.
      { materialItemId: "zip", consumed: "2", lost: "0" },
    ]);
    expect(custodyBalance({ sent: "20", returned: "2", consumed: "12.5", lost: "2.5" })).toBe("3");
  });

  it("caps a custody return at what the subcontractor still holds", () => {
    const line = { sent: "10", returned: "2", consumed: "5", lost: "0" };
    expect(() => assertCustodyReturn(line, "3")).not.toThrow();
    expect(() => assertCustodyReturn(line, "3.5")).toThrow("custody_return_exceeds_held");
  });

  it("closes only when nothing is left outside — or the remaining custody is declared lost", () => {
    const custody = [{ materialItemId: "fabric", sent: "10", returned: "0", consumed: "8", lost: "0" }];
    expect(closeBlockers(units("5", "5"), custody, false)).toEqual({ unitsHeld: "0", custody: [{ materialItemId: "fabric", held: "2" }] });
    expect(closeBlockers(units("5", "5"), custody, true)).toBeNull();
    expect(closeBlockers(units("5", "4"), [], true)).toEqual({ unitsHeld: "1", custody: [] });
  });

  it("cancels only a clean job, recalling units but never with accepted work or custody out", () => {
    expect(cancelBlocker({ ...units("5"), accrued: 0n, custodyHeld: false })).toBeNull();
    expect(cancelBlocker({ ...units("5", "1"), accrued: 100n, custodyHeld: false })).toBe("subcontract_has_accepted_work");
    expect(cancelBlocker({ ...units("5"), accrued: 0n, custodyHeld: true })).toBe("subcontract_custody_held");
  });

  it("gates each step by subcontract status and by order status", () => {
    expect(subcontractActionAllowed("draft", "subcontract_send")).toBe(false);
    expect(subcontractActionAllowed("draft", "subcontract_approve")).toBe(true);
    expect(subcontractActionAllowed("approved", "subcontract_send")).toBe(true);
    expect(subcontractActionAllowed("disputed", "subcontract_send")).toBe(false);
    expect(subcontractActionAllowed("disputed", "subcontract_close")).toBe(false);
    expect(subcontractActionAllowed("disputed", "subcontract_receive")).toBe(true);
    expect(subcontractActionAllowed("closed", "subcontract_receive")).toBe(false);
    expect(actionAllowed("draft", "subcontract_create")).toBe(true);
    expect(actionAllowed("draft", "subcontract_send")).toBe(false);
    expect(actionAllowed("released", "subcontract_send")).toBe(true);
    expect(actionAllowed("completed", "subcontract_close")).toBe(false);
    expect(isSubcontractAction("subcontract_close")).toBe(true);
    expect(isSubcontractAction("receive")).toBe(false);
  });

  it("subtracts recoveries from WIP", () => {
    expect(wipBalance({ materialCost: 1000n, conversionCost: 500n, receivedValue: 600n, returnedValue: 100n, writtenOff: 0n, recovered: 200n })).toBe(600n);
    expect(wipBalance({ materialCost: 1000n, conversionCost: 0n, receivedValue: 0n, returnedValue: 0n, writtenOff: 0n })).toBe(1000n);
  });
});
