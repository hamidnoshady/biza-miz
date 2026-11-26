import { describe, expect, it } from "vitest";
import {
  actionAllowed,
  applyProgress,
  applyRework,
  DEFAULT_FASHION_STAGES,
  materialCoversReceipt,
  materialReturnValue,
  normaliseStages,
  outstandingUnits,
  positiveQuantity,
  receiptValue,
  receivableQuantity,
  requiredQuantity,
  shortages,
  unitCost,
  wipBalance,
  type StageState,
} from "./fashion-production";

const fresh = (): StageState[] => DEFAULT_FASHION_STAGES.map((s, i) => ({ seq: i + 1, code: s.code, completed: "0", scrapped: "0" }));

describe("fashion production rules (GH #1567 6B)", () => {
  it("defaults to cut → sew → finish → QC → pack and validates custom stage lists", () => {
    expect(normaliseStages(null).map((s) => s.code)).toEqual(["cut", "sew", "finish", "qc", "pack"]);
    expect(normaliseStages([{ code: "embroider", label: "گلدوزی" }])).toEqual([{ code: "embroider", label: "گلدوزی" }]);
    expect(() => normaliseStages([{ code: "a", label: "x" }, { code: "a", label: "y" }])).toThrow("duplicate_stage");
    expect(() => normaliseStages([{ code: "Bad Code", label: "x" }])).toThrow("invalid_stage_code");
    expect(() => normaliseStages(Array.from({ length: 13 }, (_, i) => ({ code: `s${i}`, label: "x" })))).toThrow("too_many_stages");
  });

  it("parses quantities strictly and scales material per unit", () => {
    expect(positiveQuantity("2.5")).toBe("2.5");
    for (const bad of ["0", "-1", "abc", "1.0000000001"]) expect(() => positiveQuantity(bad)).toThrow("invalid_quantity");
    expect(requiredQuantity("1.35", "10")).toBe("13.5");
    expect(requiredQuantity("0.3333333333", "3")).toBe("1");
  });

  it("never lets a stage complete or scrap more than it received", () => {
    let stages = applyProgress(fresh(), "10", "cut", { completed: "10" });
    stages = applyProgress(stages, "10", "sew", { completed: "8", scrapped: "1" });
    expect(() => applyProgress(stages, "10", "sew", { completed: "2" })).toThrow("stage_quantity_exceeded");
    expect(() => applyProgress(stages, "10", "finish", { completed: "9" })).toThrow("stage_quantity_exceeded");
    expect(() => applyProgress(stages, "10", "nope", { completed: "1" })).toThrow("stage_not_found");
    expect(() => applyProgress(stages, "10", "finish", {})).toThrow("invalid_quantity");
  });

  it("rework moves waiting units back and only backwards", () => {
    let stages = fresh();
    for (const code of ["cut", "sew", "finish"]) stages = applyProgress(stages, "4", code, { completed: "4" });
    stages = applyProgress(stages, "4", "qc", { completed: "2" });
    const back = applyRework(stages, "4", "qc", "sew", "2");
    expect(back.map((s) => s.completed)).toEqual(["4", "2", "2", "2", "0"]);
    expect(() => applyRework(stages, "4", "qc", "sew", "3")).toThrow("rework_quantity_exceeded");
    expect(() => applyRework(stages, "4", "sew", "qc", "1")).toThrow("rework_must_go_back");
  });

  it("values receipts proportionally with the last one taking the remainder", () => {
    expect(receiptValue(1_550_000n, "4", "9")).toBe(688_889n);
    expect(receiptValue(861_111n, "5", "5")).toBe(861_111n);
    expect(receiptValue(0n, "1", "2")).toBe(0n);
    expect(() => receiptValue(100n, "3", "2")).toThrow("receipt_exceeds_outstanding");
    expect(outstandingUnits("10", "1", "4")).toBe("5");
    expect(receivableQuantity([{ seq: 1, code: "pack", completed: "9", scrapped: "0" }], "4")).toBe("5");
    expect(wipBalance({ materialCost: 10n, conversionCost: 5n, receivedValue: 6n, returnedValue: 2n, writtenOff: 1n })).toBe(6n);
    expect(unitCost(1_550_000n, "9")).toBe("172222.22");
    expect(unitCost(0n, "0")).toBeNull();
  });

  it("returns material at its issue value, never more than issued", () => {
    const line = { issuedQuantity: "20", issuedValue: 1_000_001n, returnedQuantity: "0", returnedValue: 0n };
    expect(materialReturnValue(line, "12")).toBe(600_001n);
    expect(materialReturnValue({ ...line, returnedQuantity: "12", returnedValue: 600_001n }, "8")).toBe(400_000n);
    expect(() => materialReturnValue(line, "21")).toThrow("return_exceeds_issued");
  });

  it("reports shortages against free stock (on hand − other orders' reservations)", () => {
    expect(shortages([
      { materialItemId: "f", name: "پارچه", need: "50", onHand: "100", reservedElsewhere: "60" },
      { materialItemId: "z", name: "زیپ", need: "5", onHand: "5", reservedElsewhere: "0" },
    ])).toEqual([{ materialItemId: "f", name: "پارچه", need: "50", available: "40", missing: "10" }]);
  });

  it("finished units cannot outrun issued material, and closed orders accept nothing", () => {
    const lines = [{ materialItemId: "z", quantityPerUnit: "1", issuedQuantity: "2", returnedQuantity: "0" }];
    expect(materialCoversReceipt(lines, "2")).toBeNull();
    expect(materialCoversReceipt(lines, "3")).toEqual({ materialItemId: "z", missing: "1" });
    expect(actionAllowed("draft", "release")).toBe(true);
    expect(actionAllowed("released", "progress")).toBe(false);
    expect(actionAllowed("completed", "cancel")).toBe(false);
    expect(actionAllowed("cancelled", "issue")).toBe(false);
  });
});
