import { describe, it, expect, vi, beforeEach } from "vitest";
import { calculateClosingLines, closeFiscalYear } from "./closing-service";
import * as db from "./db";
import { PoolClient } from "pg";

vi.mock("./db", () => ({
  getPool: vi.fn(),
}));

describe("closing-service", () => {
  describe("calculateClosingLines", () => {
    it("closes balances above Number.MAX_SAFE_INTEGER without losing a Rial", () => {
      const calculated = calculateClosingLines([
        {
          account_id: "revenue-account",
          account_type: "revenue",
          debit: "0",
          credit: "9007199254740993",
        },
        {
          account_id: "expense-account",
          account_type: "expense",
          debit: "2",
          credit: "0",
        },
      ]);

      expect(calculated.netIncome).toBe(9007199254740991n);
      expect(calculated.lines).toEqual([
        { accountId: "revenue-account", debit: "9007199254740993", credit: "0" },
        { accountId: "expense-account", debit: "0", credit: "2" },
      ]);
    });

    it("keeps an exact loss signed and closes debit-normal accounts in the right direction", () => {
      const calculated = calculateClosingLines([
        {
          account_id: "revenue-account",
          account_type: "revenue",
          debit: "5",
          credit: "0",
        },
        {
          account_id: "expense-account",
          account_type: "expense",
          debit: "9007199254740993",
          credit: "0",
        },
      ]);

      expect(calculated.netIncome).toBe(-9007199254740998n);
      expect(calculated.lines).toEqual([
        { accountId: "revenue-account", debit: "0", credit: "5" },
        { accountId: "expense-account", debit: "0", credit: "9007199254740993" },
      ]);
    });
  });

  describe("closeFiscalYear", () => {
    let mockClient: any;

    beforeEach(() => {
      mockClient = {
        query: vi.fn(),
        release: vi.fn(),
      };
      vi.mocked(db.getPool).mockReturnValue({
        connect: vi.fn().mockResolvedValue(mockClient),
      } as any);
    });

    it("rolls back transaction on error", async () => {
      // Make the very first query (BEGIN) fail to trigger the catch block.
      // Or we can let BEGIN pass and make the SELECT fail.
      mockClient.query.mockImplementation((queryText: string) => {
        if (queryText === "BEGIN") return Promise.resolve();
        return Promise.reject(new Error("DB error"));
      });

      await expect(
        closeFiscalYear(
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000002",
          "00000000-0000-4000-8000-000000000003",
        ),
      ).rejects.toThrow("DB error");

      expect(mockClient.query).toHaveBeenCalledWith("ROLLBACK");
      expect(mockClient.release).toHaveBeenCalled();
    });
  });
});
