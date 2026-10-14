/**
 * سیستم ادواری — the two periodic posting functions in ledger-service.ts,
 * pinned through a scripted PoolClient: which account each leg lands on,
 * which side, and that the compound closing entry stays balanced and
 * correctly signed in every direction (positive COGS, negative COGS,
 * shrinking inventory, zero legs dropped).
 */
import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import type { RialText } from "./inventory-exact";
import {
  MissingLedgerAccountError,
  postPeriodicClosingEntry,
  postPeriodicPurchaseEntry,
} from "./ledger-service";

interface Call {
  sql: string;
  params: unknown[];
}

const ACCOUNTS: Record<string, string> = {
  "5105": "acc-5105",
  "2100": "acc-ap",
  "1100": "acc-cash",
  "1120": "acc-bank",
  "5100": "acc-cogs",
  "1300": "acc-inventory",
};

function scriptedClient(accounts: Record<string, string> = ACCOUNTS) {
  const calls: Call[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      const flat = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql: flat, params });
      if (flat.includes("SELECT code, id FROM accounts")) {
        const requested = params[1] as string[];
        return { rows: requested.filter((code) => accounts[code]).map((code) => ({ code, id: accounts[code] })) };
      }
      // The entry's own date is what its voucher number is derived from, so
      // the RETURNING carries it the way the real column does.
      if (flat.includes("INSERT INTO journal_entries")) {
        return { rows: [{ id: "entry-1", entry_date: "2026-01-31" }] };
      }
      if (flat.includes("INSERT INTO journal_lines")) return { rows: [] };
      // Issue #867 — every posting numbers its entry in-transaction.
      if (flat.includes("SELECT id FROM fiscal_years")) return { rows: [] };
      if (flat.includes("INSERT INTO voucher_sequences")) return { rows: [] };
      if (flat.includes("FROM voucher_sequences")) return { rows: [{ last_number: "0" }] };
      if (flat.includes("UPDATE voucher_sequences")) return { rows: [] };
      if (flat.includes("UPDATE journal_entries")) return { rows: [] };
      if (flat.includes("SELECT set_config('app.fiscal_constructing_entry_id'")) return { rows: [] };
      throw new Error(`unexpected query: ${flat}`);
    },
  } as unknown as PoolClient;
  return { client, calls };
}

function journalLines(calls: Call[]) {
  return calls
    .filter((call) => call.sql.includes("INSERT INTO journal_lines"))
    .map((call) => ({ accountId: call.params[1], debit: call.params[2], credit: call.params[3] }));
}

function entryHeader(calls: Call[]) {
  return calls.find((call) => call.sql.includes("INSERT INTO journal_entries"))?.params;
}

const rial = (value: string) => value as RialText;

describe("postPeriodicPurchaseEntry", () => {
  const base = {
    businessId: "biz-1",
    locationId: "loc-1",
    purchaseId: "purchase-1",
    createdBy: "user-1",
    total: rial("5000"),
  };

  it("debits 5105 and credits AP for a credit purchase", async () => {
    const { client, calls } = scriptedClient();
    const id = await postPeriodicPurchaseEntry(client, { ...base, settlementMethod: "credit" });
    expect(id).toBe("entry-1");
    expect(journalLines(calls)).toEqual([
      { accountId: "acc-5105", debit: "5000", credit: "0" },
      { accountId: "acc-ap", debit: "0", credit: "5000" },
    ]);
  });

  it("credits cash for a cash purchase and bank clearing for a bank purchase", async () => {
    const cash = scriptedClient();
    await postPeriodicPurchaseEntry(cash.client, { ...base, settlementMethod: "cash" });
    expect(journalLines(cash.calls)[1]).toEqual({ accountId: "acc-cash", debit: "0", credit: "5000" });

    const bank = scriptedClient();
    await postPeriodicPurchaseEntry(bank.client, { ...base, settlementMethod: "bank" });
    expect(journalLines(bank.calls)[1]).toEqual({ accountId: "acc-bank", debit: "0", credit: "5000" });
  });

  it("wears the purchase source and the periodic_purchase posting kind", async () => {
    const { client, calls } = scriptedClient();
    await postPeriodicPurchaseEntry(client, { ...base, settlementMethod: "credit" });
    const header = entryHeader(calls)!;
    expect(header[4]).toBe("purchase"); // source_type
    expect(header[5]).toBe("purchase-1"); // source_id
    expect(header[7]).toBe("periodic_purchase"); // posting_kind
  });

  it("posts nothing for a zero-total purchase (all lines dropped)", async () => {
    const { client, calls } = scriptedClient();
    const id = await postPeriodicPurchaseEntry(client, { ...base, total: rial("0"), settlementMethod: "credit" });
    expect(id).toBeNull();
    expect(entryHeader(calls)).toBeUndefined();
  });

  it("throws MissingLedgerAccountError when 5105 is absent from the chart", async () => {
    const { client } = scriptedClient({ ...ACCOUNTS, "5105": undefined as unknown as string });
    await expect(postPeriodicPurchaseEntry(client, { ...base, settlementMethod: "credit" })).rejects.toThrow(
      MissingLedgerAccountError,
    );
  });
});

describe("postPeriodicClosingEntry", () => {
  const base = {
    businessId: "biz-1",
    locationId: "loc-1",
    closingId: "closing-1",
    createdBy: "user-1",
    entryDate: "2026-01-31",
  };

  it("positive COGS, growing inventory: Dr 5100, Dr 1300 net, Cr 5105", async () => {
    const { client, calls } = scriptedClient();
    // B=0, P=1000, E=400 → COGS 600, restatement +400.
    const id = await postPeriodicClosingEntry(client, {
      ...base,
      beginningValue: rial("0"),
      purchasesValue: rial("1000"),
      endingValue: rial("400"),
    });
    expect(id).toBe("entry-1");
    expect(journalLines(calls)).toEqual([
      { accountId: "acc-cogs", debit: "600", credit: "0" },
      { accountId: "acc-inventory", debit: "400", credit: "0" },
      { accountId: "acc-5105", debit: "0", credit: "1000" },
    ]);
  });

  it("shrinking inventory: the 1300 leg flips to a credit and the entry still balances", async () => {
    const { client, calls } = scriptedClient();
    // B=900, P=100, E=300 → COGS 700, restatement −600.
    await postPeriodicClosingEntry(client, {
      ...base,
      beginningValue: rial("900"),
      purchasesValue: rial("100"),
      endingValue: rial("300"),
    });
    const lines = journalLines(calls);
    expect(lines).toEqual([
      { accountId: "acc-cogs", debit: "700", credit: "0" },
      { accountId: "acc-inventory", debit: "0", credit: "600" },
      { accountId: "acc-5105", debit: "0", credit: "100" },
    ]);
    const debits = lines.reduce((sum, l) => sum + BigInt(l.debit as string), 0n);
    const credits = lines.reduce((sum, l) => sum + BigInt(l.credit as string), 0n);
    expect(debits).toBe(credits);
  });

  it("negative COGS (counted more than B + P): the COGS leg flips to a credit", async () => {
    const { client, calls } = scriptedClient();
    // B=0, P=200, E=300 → COGS −100.
    await postPeriodicClosingEntry(client, {
      ...base,
      beginningValue: rial("0"),
      purchasesValue: rial("200"),
      endingValue: rial("300"),
    });
    expect(journalLines(calls)).toEqual([
      { accountId: "acc-cogs", debit: "0", credit: "100" },
      { accountId: "acc-inventory", debit: "300", credit: "0" },
      { accountId: "acc-5105", debit: "0", credit: "200" },
    ]);
  });

  it("no purchases this period: the 5105 leg drops, COGS against the restatement alone", async () => {
    const { client, calls } = scriptedClient();
    // B=500, P=0, E=200 → COGS 300, restatement −300, no 5105 line.
    await postPeriodicClosingEntry(client, {
      ...base,
      beginningValue: rial("500"),
      purchasesValue: rial("0"),
      endingValue: rial("200"),
    });
    expect(journalLines(calls)).toEqual([
      { accountId: "acc-cogs", debit: "300", credit: "0" },
      { accountId: "acc-inventory", debit: "0", credit: "300" },
    ]);
  });

  it("a fully idle period (all zeros) posts nothing", async () => {
    const { client, calls } = scriptedClient();
    const id = await postPeriodicClosingEntry(client, {
      ...base,
      beginningValue: rial("0"),
      purchasesValue: rial("0"),
      endingValue: rial("0"),
    });
    expect(id).toBeNull();
    expect(entryHeader(calls)).toBeUndefined();
  });

  it("an unchanged count (E = B, no purchases) posts nothing — zero COGS, zero restatement", async () => {
    const { client, calls } = scriptedClient();
    const id = await postPeriodicClosingEntry(client, {
      ...base,
      beginningValue: rial("400"),
      purchasesValue: rial("0"),
      endingValue: rial("400"),
    });
    expect(id).toBeNull();
    expect(entryHeader(calls)).toBeUndefined();
  });

  it("dates the entry at the period end and wears the periodic_closing source and kind", async () => {
    const { client, calls } = scriptedClient();
    await postPeriodicClosingEntry(client, {
      ...base,
      beginningValue: rial("0"),
      purchasesValue: rial("1000"),
      endingValue: rial("400"),
    });
    const header = entryHeader(calls)!;
    expect(header[2]).toBe("2026-01-31"); // entry_date
    expect(header[4]).toBe("periodic_closing"); // source_type
    expect(header[5]).toBe("closing-1"); // source_id
    expect(header[7]).toBe("periodic_closing"); // posting_kind
  });

  it("throws MissingLedgerAccountError when the COGS account is absent", async () => {
    const { client } = scriptedClient({ ...ACCOUNTS, "5100": undefined as unknown as string });
    await expect(
      postPeriodicClosingEntry(client, {
        ...base,
        beginningValue: rial("0"),
        purchasesValue: rial("1000"),
        endingValue: rial("400"),
      }),
    ).rejects.toThrow(MissingLedgerAccountError);
  });
});
