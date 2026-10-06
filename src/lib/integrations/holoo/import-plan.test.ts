import { describe, expect, it } from "vitest";
import { holooAccountType, planAccountImport, planGoods, planPersons } from "./import-plan";
import type { MappedAccount, MappedGoods, MappedPerson } from "./mappers";

const goods = (id: string): MappedGoods => ({ remoteId: id, name: `کالای ${id}`, sku: null, priceRial: 1000n, unit: null });
const person = (id: string): MappedPerson => ({ remoteId: id, name: `شخص ${id}`, phone: null, address: null, isSupplier: false });
const account = (code: string, parentCode?: string, nature?: string): MappedAccount => ({
  remoteId: `a-${code}`,
  code,
  name: `حساب ${code}`,
  nature: nature ?? null,
  parentCode: parentCode ?? null,
});

describe("planGoods / planPersons", () => {
  it("splits new from already-mapped", () => {
    const result = planGoods([goods("1"), goods("2"), goods("3")], new Set(["2"]));
    expect(result.toCreate.map((g) => g.remoteId)).toEqual(["1", "3"]);
    expect(result.skipped).toBe(1);
  });
  it("skips everything when all mapped", () => {
    expect(planPersons([person("p1")], new Set(["p1"])).toCreate).toEqual([]);
  });
});

describe("holooAccountType", () => {
  it("follows the Iranian coding convention", () => {
    expect(holooAccountType("1101")).toBe("asset");
    expect(holooAccountType("2101")).toBe("liability");
    expect(holooAccountType("3101")).toBe("equity");
    expect(holooAccountType("4101")).toBe("revenue");
    expect(holooAccountType("5101")).toBe("expense");
    expect(holooAccountType("6101")).toBe("expense");
  });
  it("honours an explicit credit nature for a custom code", () => {
    expect(holooAccountType("9", "credit")).toBe("revenue");
    expect(holooAccountType("3", "credit")).toBe("equity");
  });
  it("defaults to asset for an unknown code", () => {
    expect(holooAccountType("x")).toBe("asset");
  });
});

describe("planAccountImport", () => {
  const seed = new Set(["1101", "2101", "4101"]);

  it("maps codes already in the seed chart instead of recreating them", () => {
    const plan = planAccountImport([account("1101"), account("9999")], seed);
    expect(plan.mappedToSeed.map((a) => a.code)).toEqual(["1101"]);
    expect(plan.toCreate.map((a) => a.code)).toEqual(["9999"]);
    expect(plan.orphaned).toEqual([]);
  });

  it("orders a created parent before its child regardless of workbook row order", () => {
    const plan = planAccountImport([account("8101", "8100"), account("8100")], seed);
    expect(plan.toCreate.map((a) => a.code)).toEqual(["8100", "8101"]);
    expect(plan.orphaned).toEqual([]);
  });

  it("skips remote identities already mapped by a previous import run", () => {
    const plan = planAccountImport([account("1101"), account("9999")], seed, new Set(["a-9999"]));
    expect(plan.mappedToSeed.map((a) => a.code)).toEqual(["1101"]);
    expect(plan.toCreate).toEqual([]);
    expect(plan.skipped).toBe(1);
  });

  it("flags missing parents and cyclic account graphs instead of detaching them", () => {
    const missing = planAccountImport([account("8101", "8100")], seed);
    expect(missing.toCreate).toEqual([]);
    expect(missing.orphaned.map((a) => a.code)).toEqual(["8101"]);

    const cyclic = planAccountImport([account("8101", "8100"), account("8100", "8101")], seed);
    expect(cyclic.toCreate).toEqual([]);
    expect(cyclic.orphaned.map((a) => a.code)).toEqual(["8101", "8100"]);
  });
});
