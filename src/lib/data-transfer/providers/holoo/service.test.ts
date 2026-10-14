import { describe, expect, it } from "vitest";
import type { BaseImportInput } from "@/lib/integrations/holoo/import-service";
import { holooBaseInputFingerprint, validateHolooScopes } from "./service";

const base: BaseImportInput = {
  goods: [
    { remoteId: "G-2", name: "دوم", sku: null, priceRial: 2n, unit: null },
    { remoteId: "G-1", name: "اول", sku: null, priceRial: 1n, unit: null },
  ],
  persons: [],
  accounts: [],
};

describe("Holoo Data Transfer provider", () => {
  it("keeps unsupported financial scopes fail-closed, restricts journals to paired XLSX sheets, and enforces dependencies", () => {
    expect(validateHolooScopes(["sales"])).toEqual({ ok: false, error: "unsupported_scope" });
    expect(validateHolooScopes(["journal"])).toEqual({ ok: false, error: "unsupported_scope" });
    expect(validateHolooScopes(["openingInventory"])).toEqual({ ok: false, error: "scope_dependency_missing" });
    expect(validateHolooScopes(["journal"], "xlsx")).toEqual({ ok: false, error: "scope_dependency_missing" });
    expect(validateHolooScopes(["journal", "journalLines"], "xlsx")).toEqual({
      ok: true,
      scopes: ["journal", "journalLines"],
    });
    expect(validateHolooScopes(["accounts", "journal", "journalLines"], "xlsx")).toEqual({
      ok: true,
      scopes: ["accounts", "journal", "journalLines"],
    });
  });

  it("fingerprints approved source values independently of row ordering", () => {
    const reversed = { ...base, goods: [...base.goods].reverse() };
    expect(holooBaseInputFingerprint(base, ["goods"])).toBe(holooBaseInputFingerprint(reversed, ["goods"]));
    expect(holooBaseInputFingerprint(base, ["goods"])).not.toBe(holooBaseInputFingerprint(base, ["persons"]));
    expect(holooBaseInputFingerprint(base, ["goods"])).not.toBe(
      holooBaseInputFingerprint({ ...base, goods: base.goods.map((row) => ({ ...row, name: `${row.name}!` })) }, ["goods"]),
    );
    const scopes = ["accounts", "journal", "journalLines"] as const;
    const journal = [{ remoteId: "J-1", entryDate: "2025-01-02", memo: null, lines: [
      { accountCode: "101", debitRial: "9007199254740993", creditRial: "0" },
      { accountCode: "201", debitRial: "0", creditRial: "9007199254740993" },
    ] }];
    const fingerprint = holooBaseInputFingerprint(base, scopes, journal);
    expect(fingerprint).not.toBe(holooBaseInputFingerprint(base, scopes, journal.map((voucher) => ({
      ...voucher,
      lines: voucher.lines.map((line) => ({ ...line, debitRial: line.debitRial === "0" ? "1" : line.debitRial })),
    }))));
  });
});
