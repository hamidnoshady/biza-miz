import { describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("./db", () => ({ query: (...args: unknown[]) => queryMock(...args) }));

import { resolveBusinessMoneyUnit } from "./ai-money-unit";

describe("issue #812 §15 — the business's own money unit", () => {
  it("reads the unit the owner chose", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ value: { currencyDisplay: "rial" } }] });
    await expect(resolveBusinessMoneyUnit("biz-1")).resolves.toBe("rial");
  });

  it("falls back to Toman when the preference is absent", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(resolveBusinessMoneyUnit("biz-1")).resolves.toBe("toman");
  });

  it("falls back to Toman on an unrecognised unit", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ value: { currencyDisplay: "dollars" } }] });
    await expect(resolveBusinessMoneyUnit("biz-1")).resolves.toBe("toman");
  });

  it("falls back to Toman when the read throws — never fails the turn", async () => {
    queryMock.mockRejectedValueOnce(new Error("db down"));
    await expect(resolveBusinessMoneyUnit("biz-1")).resolves.toBe("toman");
  });

  it("queries the business-scoped preference row only", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ value: { currencyDisplay: "toman" } }] });
    await resolveBusinessMoneyUnit("biz-9");
    const [sql, params] = queryMock.mock.calls.at(-1)!;
    expect(String(sql)).toContain("location_id IS NULL");
    expect(String(sql)).toContain("business.prefs");
    expect(params).toEqual(["biz-9"]);
  });
});
