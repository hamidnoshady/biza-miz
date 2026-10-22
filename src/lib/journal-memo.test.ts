/**
 * Issue #1060 — شرح فارسی اسناد سیستمی.
 *
 * The contract, stated as tests: historical system documents read in Persian
 * without their stored memo changing; a person's own English note is never
 * "translated" for them; new postings take their memo from the same table by
 * key; and no posting path in `src/` may scatter a fresh English memo again.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  LEGACY_SYSTEM_JOURNAL_MEMOS,
  SYSTEM_JOURNAL_MEMOS,
  journalMemoForDisplay,
  journalMemoSearchAliases,
  systemJournalMemo,
  type SystemJournalMemoKey,
} from "./journal-memo";

const KEYS = Object.keys(SYSTEM_JOURNAL_MEMOS) as SystemJournalMemoKey[];

describe("journalMemoForDisplay — the two documents in the bug report", () => {
  it("shows «پرداخت سفارش» for a historical Order payment", () => {
    expect(journalMemoForDisplay("Order payment", "order")).toBe("پرداخت سفارش");
    // An amendment replay posts the same memo under its own source.
    expect(journalMemoForDisplay("Order payment", "order_amendment")).toBe("پرداخت سفارش");
  });

  it("shows «بهای تمام‌شده کالای فروش‌رفته» for a historical Cost of goods sold", () => {
    expect(journalMemoForDisplay("Cost of goods sold", "order")).toBe("بهای تمام‌شده کالای فروش‌رفته");
    expect(journalMemoForDisplay("Cost of goods sold", "order_amendment")).toBe(
      "بهای تمام‌شده کالای فروش‌رفته",
    );
  });
});

describe("journalMemoForDisplay — every audited English posting path", () => {
  it("localizes each legacy system memo under each of its sources, to text with no Latin in it", () => {
    for (const key of KEYS) {
      const def = SYSTEM_JOURNAL_MEMOS[key];
      if (def.legacyEn === null) continue;
      for (const sourceType of def.sourceTypes) {
        const shown = journalMemoForDisplay(def.legacyEn, sourceType);
        expect(shown, `${key} under ${sourceType}`).toBe(systemJournalMemo(key));
        expect(shown, `${key} under ${sourceType}`).not.toMatch(/[A-Za-z]/);
      }
    }
  });

  it("covers the audited set of historical English memos", () => {
    expect([...LEGACY_SYSTEM_JOURNAL_MEMOS].sort()).toEqual(
      [
        "Cost of goods sold",
        "Customer refund",
        "Customer return inventory recovery",
        "Inventory NRV reversal",
        "Inventory NRV write-down",
        "Inventory transfer cancellation",
        "Inventory transfer received",
        "Inventory transfer shipped",
        "Negative stock cost settlement",
        "Order payment",
        "Purchase receipt",
        "Supplier return",
      ].sort(),
    );
  });

  it("tolerates stored surrounding whitespace when matching", () => {
    expect(journalMemoForDisplay("  Order payment  ", "order")).toBe("پرداخت سفارش");
  });
});

describe("journalMemoForDisplay — what it must never touch", () => {
  it("leaves a manual journal's memo alone, even when it spells a system string", () => {
    // A person typed this into a manual document; it is their note, not a label.
    expect(journalMemoForDisplay("Order payment", "manual")).toBe("Order payment");
    expect(journalMemoForDisplay("Cost of goods sold", "manual")).toBe("Cost of goods sold");
  });

  it("leaves other user-authored sources alone — the source must be the posting's own", () => {
    expect(journalMemoForDisplay("Order payment", "expense")).toBe("Order payment");
    expect(journalMemoForDisplay("Order payment", "ar_receipt")).toBe("Order payment");
    expect(journalMemoForDisplay("Supplier return", "order")).toBe("Supplier return");
  });

  it("leaves unknown and free-form memos byte-for-byte unchanged", () => {
    expect(journalMemoForDisplay("Order payment for invoice 12", "order")).toBe(
      "Order payment for invoice 12",
    );
    expect(journalMemoForDisplay("پرداخت قسط اول — Order 42", "order")).toBe("پرداخت قسط اول — Order 42");
    expect(journalMemoForDisplay("  یادداشت حسابدار  ", "order")).toBe("  یادداشت حسابدار  ");
  });

  it("cannot localize without provenance: a missing source returns the raw memo", () => {
    expect(journalMemoForDisplay("Order payment", null)).toBe("Order payment");
    expect(journalMemoForDisplay("Order payment", undefined)).toBe("Order payment");
    expect(journalMemoForDisplay("Order payment", "")).toBe("Order payment");
    expect(journalMemoForDisplay("Order payment")).toBe("Order payment");
  });

  it("passes missing memos through so each surface keeps its own «بدون شرح» fallback", () => {
    expect(journalMemoForDisplay(null, "order")).toBeNull();
    expect(journalMemoForDisplay(undefined, "order")).toBeNull();
    expect(journalMemoForDisplay("", "order")).toBe("");
  });

  it("is idempotent for documents persisted after the fix (already Persian)", () => {
    for (const key of KEYS) {
      const def = SYSTEM_JOURNAL_MEMOS[key];
      if (def.legacyEn === null) continue;
      const persisted = systemJournalMemo(key);
      expect(journalMemoForDisplay(persisted, def.sourceTypes[0])).toBe(persisted);
    }
  });
});

describe("systemJournalMemo — what new postings persist", () => {
  it("gives every key a Persian text with no Latin prose in it", () => {
    for (const key of KEYS) {
      const text = systemJournalMemo(key, { originalMemo: "شرح سند اصلی" });
      expect(text, key).not.toMatch(/[A-Za-z]/);
      expect(text.length, key).toBeGreaterThan(0);
    }
  });

  it("carries the RTL text exactly, ZWNJ included", () => {
    expect(systemJournalMemo("order_cogs")).toBe("بهای تمام‌شده کالای فروش‌رفته");
    expect(systemJournalMemo("order_cogs")).toContain("\u200c");
  });

  it("interpolates template parameters (the reversal default quotes the original)", () => {
    expect(systemJournalMemo("journal_reversal", { originalMemo: "اجارهٔ بهمن" })).toBe(
      "برگشت سند: اجارهٔ بهمن",
    );
    // Mixed-direction parameters (a Latin reference) pass through verbatim;
    // the surrounding Persian template owns the direction of the sentence.
    expect(systemJournalMemo("journal_reversal", { originalMemo: "Invoice A-1042" })).toBe(
      "برگشت سند: Invoice A-1042",
    );
  });

  it("never leaks a placeholder into a posted document when a parameter is missing", () => {
    expect(systemJournalMemo("journal_reversal")).toBe("برگشت سند:");
    expect(systemJournalMemo("journal_reversal", { originalMemo: null })).not.toContain("{");
  });
});

describe("journalMemoSearchAliases — search follows the words on screen", () => {
  it("bridges a Persian query to the historical English rows", () => {
    expect(journalMemoSearchAliases("پرداخت سفارش")).toContain("Order payment");
    expect(journalMemoSearchAliases("بهای تمام‌شده")).toContain("Cost of goods sold");
  });

  it("accepts the space-typed spelling of a ZWNJ label", () => {
    expect(journalMemoSearchAliases("تمام شده کالای")).toContain("Cost of goods sold");
  });

  it("bridges an English query to rows persisted in Persian after the fix", () => {
    expect(journalMemoSearchAliases("order pay")).toContain("پرداخت سفارش");
    expect(journalMemoSearchAliases("COST OF GOODS")).toContain("بهای تمام‌شده کالای فروش‌رفته");
  });

  it("adds nothing for unrelated, blank or missing queries", () => {
    expect(journalMemoSearchAliases("اجاره دفتر")).toEqual([]);
    expect(journalMemoSearchAliases("")).toEqual([]);
    expect(journalMemoSearchAliases("   ")).toEqual([]);
    expect(journalMemoSearchAliases(null)).toEqual([]);
    expect(journalMemoSearchAliases(undefined)).toEqual([]);
  });
});

/**
 * The audit that keeps the fix fixed — the `ledger-source-labels.test.ts`
 * move, applied to memos: grep every `memo: "…"` literal in `src/` and fail
 * if one holds English prose. A new automatic posting takes its memo from
 * `systemJournalMemo(...)` (or plain Persian prose, like the posting rules),
 * never from a fresh English literal.
 */
const SRC_DIR = resolve(fileURLToPath(new URL("./", import.meta.url)), "..");

/** Files whose `memo:` is not a journal memo at all. */
const NOT_A_JOURNAL_MEMO = new Set([
  // Holoo's external schema profile: `memo:` names the *remote column*
  // ("Description") a voucher's memo maps to, not text anyone reads here.
  join(SRC_DIR, "lib/integrations/holoo/schema-profile.ts"),
]);

function collectEnglishMemoLiterals(): string[] {
  const found: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(?:ts|tsx)$/.test(entry) || entry.includes(".test.")) continue;
      if (NOT_A_JOURNAL_MEMO.has(full)) continue;
      const source = readFileSync(full, "utf8");
      for (const match of source.matchAll(/\bmemo:\s*"([A-Za-z][^"]*)"/g)) {
        found.push(`${full.slice(SRC_DIR.length + 1)} — memo: "${match[1]}"`);
      }
    }
  }
  walk(SRC_DIR);
  return found.sort();
}

describe("the posting paths — no English memo literals left in src/", () => {
  it("finds none (new system postings persist journal-memo.ts Persian by key)", () => {
    expect(
      collectEnglishMemoLiterals().join("\n"),
      [
        "An automatic posting persists an English journal memo.",
        "Add a key to SYSTEM_JOURNAL_MEMOS in journal-memo.ts and post",
        "systemJournalMemo(key) instead — the journal, exports and search",
        "all read that one table.",
      ].join("\n"),
    ).toBe("");
  });
});
