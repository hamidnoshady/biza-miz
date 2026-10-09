/**
 * Issue #821 — «خروجی دفتر روزنامه».
 *
 * The export's contract, stated as tests: one row per journal *line*, exact
 * BIGINT amounts (the screen's old `Number(...)` rounding must not reappear in
 * the file an auditor reconciles against), Shamsi dates, Persian labels, and
 * the audit columns that make a journal export worth having.
 */
import { describe, expect, it } from "vitest";
import { buildJournalExportTable, JOURNAL_EXPORT_COLUMNS, journalStatusLabel } from "./journal-export";
import { rowsToCsv } from "./report-export";
import type { JournalEntryRecord } from "./journal-service";

function entry(overrides: Partial<JournalEntryRecord> = {}): JournalEntryRecord {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    entryDate: "2026-02-14",
    postedAt: "2026-02-14T09:30:00.000Z",
    memo: "اجارهٔ بهمن",
    sourceType: "manual",
    sourceId: null,
    locationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    locationName: "شعبهٔ مرکزی",
    projectId: null,
    projectName: null,
    createdBy: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    createdByName: "حسابدار",
    reversesEntryId: null,
    reversedByEntryId: null,
    reversedAt: null,
    reversedBy: null,
    reversedByName: null,
    totalDebit: "9007199254740993",
    currencyCode: null,
    baseCurrencyCode: null,
    exchangeRateId: null,
    exchangeRate: null,
    roundingVersion: null,
    roundingDelta: null,
    lines: [
      {
        entryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        accountId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        accountCode: "5100",
        accountName: "هزینهٔ اجاره",
        debit: "9007199254740993",
        credit: "0",
        foreignDebit: "0",
        foreignCredit: "0",
        partyId: null,
      },
      {
        entryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        accountId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        accountCode: "1100",
        accountName: "صندوق",
        debit: "0",
        credit: "9007199254740993",
        foreignDebit: "0",
        foreignCredit: "0",
        partyId: null,
      },
    ],
    ...overrides,
  };
}

describe("buildJournalExportTable", () => {
  it("emits one row per journal line, repeating the document's own columns", () => {
    const table = buildJournalExportTable([entry()]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows.map((row) => row.accountCode)).toEqual(["5100", "1100"]);
    expect(new Set(table.rows.map((row) => row.entryId)).size).toBe(1);
  });

  it("keeps amounts as exact Rial strings — the whole reason this export exists", () => {
    const table = buildJournalExportTable([entry()]);
    expect(table.rows[0].debit).toBe("9007199254740993");
    expect(table.rows[0].entryTotal).toBe("9007199254740993");
    // Through the shared CSV codec, intact.
    expect(rowsToCsv(table)).toContain("9007199254740993");
  });

  it("writes dates in Shamsi, never the stored Gregorian value", () => {
    const table = buildJournalExportTable([entry()]);
    expect(String(table.rows[0].entryDate)).toBe("۱۴۰۴/۱۱/۲۵");
    expect(String(table.rows[0].entryDate)).not.toContain("2026");
  });

  it("labels the source in Persian rather than exporting the raw code", () => {
    const table = buildJournalExportTable([entry({ sourceType: "retail_invoice" })]);
    expect(table.rows[0].source).toBe("فاکتور فروش");
    expect(table.rows[0].source).not.toBe("retail_invoice");
  });

  it("carries the audit columns an auditor needs", () => {
    const reversed = entry({
      reversedByEntryId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      reversedAt: "2026-02-20T11:00:00.000Z",
      reversedByName: "مالک",
    });
    const row = buildJournalExportTable([reversed]).rows[0];
    expect(row.status).toBe("برگشت‌خورده");
    expect(row.reversedByEntryId).toBe("ffffffff-ffff-4fff-8fff-ffffffffffff");
    expect(row.reversedByName).toBe("مالک");
    expect(String(row.reversedAt)).toContain("۱۴۰۴");
  });

  it("keeps a corrupt, line-less document visible instead of dropping it", () => {
    const table = buildJournalExportTable([entry({ lines: [], totalDebit: "0" })]);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].accountCode).toBe("");
  });

  it("uses the full column set, with Persian headers", () => {
    const table = buildJournalExportTable([]);
    expect(table.columns).toHaveLength(JOURNAL_EXPORT_COLUMNS.length);
    expect(table.columns.every((column) => /[\u0600-\u06FF]/.test(column.label))).toBe(true);
  });
});

describe("journalStatusLabel", () => {
  it("names which side of a reversal pair a document is on", () => {
    expect(journalStatusLabel({ reversesEntryId: "x", reversedAt: null })).toBe("سند برگشتی");
    expect(journalStatusLabel({ reversesEntryId: null, reversedAt: "2026-01-01" })).toBe("برگشت‌خورده");
    expect(journalStatusLabel({ reversesEntryId: null, reversedAt: null })).toBe("عادی");
  });
});
