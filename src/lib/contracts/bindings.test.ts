/**
 * Issue #908 — autofill, and the lineage the epic demands for it.
 *
 * "Visible source lineage, manual override and stale-source detection" is three
 * separate promises, and each has a test below:
 *
 *  - a bound field reports `binding` when nobody typed over it;
 *  - typing over it reports `override` **and** keeps the bound value, so the UI
 *    can show what the record says under the manual value;
 *  - a record that changed after review produces a non-empty `changedBindings`.
 *
 * The catalogue is also pinned: it is the allow-list of what a contract may
 * disclose, so a path added for convenience should have to fail a test first.
 */
import { describe, expect, it } from "vitest";
import {
  CONTRACT_BINDING_CATALOGUE,
  bindingGroups,
  bindingLabel,
  bindingSupported,
  changedBindings,
  emptyBindingContext,
  isBindingSource,
  resolveBindings,
  type ContractBindingContext,
} from "./bindings";
import {
  normalizeContractContent,
  type ContractDocumentContent,
  type ContractField,
} from "./blocks";

const field = (input: Partial<ContractField> & { key: string }): ContractField => ({
  key: input.key,
  label: input.label ?? input.key,
  type: input.type ?? "text",
  required: input.required ?? false,
  binding: input.binding ?? null,
  options: input.options ?? [],
  value: input.value ?? "",
});

const content = (fields: ContractField[], body = "{{party_name}}"): ContractDocumentContent =>
  normalizeContractContent({
    title: "قرارداد",
    blocks: [{ id: "b1", type: "paragraph", text: body }],
    fields,
  });

const context = (overrides: Partial<ContractBindingContext> = {}): ContractBindingContext => ({
  ...emptyBindingContext("قرارداد پیمان", "2026-11-01"),
  contract: {
    ...emptyBindingContext().contract,
    title: "قرارداد پیمان",
    contractType: "contractor",
    contractTypeLabel: "پیمانکاری",
    valueRial: 1_250_000_000,
    today: "2026-11-01",
  },
  party: { name: "شرکت الف", role: "تأمین‌کننده", phone: "09123456789", nationalId: "10101010101" },
  business: { name: "کسب‌وکار من", phone: "02112345678", address: "تهران" },
  ...overrides,
});

describe("the binding catalogue", () => {
  it("only offers source/path pairs the shape check accepts", () => {
    for (const entry of CONTRACT_BINDING_CATALOGUE) {
      expect(bindingSupported({ source: entry.source, path: entry.path })).toBe(true);
      expect(isBindingSource(entry.source)).toBe(true);
      expect(entry.label.trim()).not.toBe("");
      expect(entry.group.trim()).not.toBe("");
    }
  });

  it("keeps an unknown path unsupported rather than silently reading it", () => {
    expect(bindingSupported({ source: "party", path: "internal_notes" })).toBe(false);
    expect(bindingSupported({ source: "bank_account", path: "iban" })).toBe(false);
    expect(bindingSupported(null)).toBe(false);
  });

  it("labels a binding with its group, and nothing with none", () => {
    expect(bindingLabel({ source: "party", path: "name" })).toBe("طرف حساب · نام طرف حساب");
    expect(bindingLabel({ source: "party", path: "nope" })).toBeNull();
    expect(bindingLabel(null)).toBeNull();
  });

  it("groups in catalogue order without losing an entry", () => {
    const groups = bindingGroups();
    const flat = groups.flatMap((group) => group.entries);
    expect(flat).toHaveLength(CONTRACT_BINDING_CATALOGUE.length);
    expect(groups.map((group) => group.group)).toEqual([
      "قرارداد",
      "پروژه",
      "طرف حساب",
      "کسب‌وکار",
      "اطلاعات پیمان (AEC)",
    ]);
  });
});

describe("resolveBindings", () => {
  it("fills a bound field from the record and marks the lineage", () => {
    const resolved = resolveBindings(
      content([field({ key: "party_name", binding: { source: "party", path: "name" } })]),
      context(),
    );
    expect(resolved.values.party_name).toBe("شرکت الف");
    expect(resolved.fields[0]).toMatchObject({
      provenance: "binding",
      boundValue: "شرکت الف",
      bindingSupported: true,
    });
  });

  it("resolves authorized AEC commercial values with lineage, formatting money and detecting source changes", () => {
    const aec = {
      ...emptyBindingContext().aec,
      revisedValueRial: "1250000000",
      advancePercent: "20",
      advanceAmountRial: "250000000",
      retentionPercent: "10",
      paymentTerms: "صورت‌وضعیت ماهانه",
      defectsLiabilityMonths: "12",
      approvedVariationsRial: "50000000",
      certifiedAmountRial: "300000000",
      guaranteeType: "ضمانت‌نامه بانکی",
      guaranteeReference: "G-123",
      guaranteeAmountRial: "100000000",
      guaranteeExpiry: "2027-03-21",
      insuranceReference: "I-456",
      insuranceExpiry: "2027-04-02",
    };
    const fields = [
      field({ key: "revised", type: "money", binding: { source: "aec", path: "revised_value" } }),
      field({ key: "terms", type: "multiline", binding: { source: "aec", path: "payment_terms" } }),
      field({ key: "guarantee_expiry", type: "date", binding: { source: "aec", path: "guarantee_expiry" } }),
    ];
    const first = resolveBindings(content(fields), context({ aec }), {
      formatMoney: (rial) => `${rial} ریال`,
      formatDate: (iso) => `تاریخ ${iso}`,
    });
    expect(first.values).toMatchObject({
      revised: "1250000000 ریال",
      terms: "صورت‌وضعیت ماهانه",
      guarantee_expiry: "تاریخ 2027-03-21",
    });
    expect(first.fields[0]).toMatchObject({ provenance: "binding", boundValue: "1250000000 ریال" });
    const second = resolveBindings(content(fields), context({ aec: { ...aec, revisedValueRial: "1300000000" } }), {
      formatMoney: (rial) => `${rial} ریال`,
      formatDate: (iso) => `تاریخ ${iso}`,
    });
    expect(changedBindings(first.values, second.values)).toContain("revised");
  });

  it("prefers a manual value but keeps the bound value beside it", () => {
    const resolved = resolveBindings(
      content([
        field({ key: "party_name", value: "شرکت ب", binding: { source: "party", path: "name" } }),
      ]),
      context(),
    );
    expect(resolved.values.party_name).toBe("شرکت ب");
    expect(resolved.fields[0].provenance).toBe("override");
    expect(resolved.fields[0].boundValue).toBe("شرکت الف");
  });

  it("treats a typed value with no binding as a literal", () => {
    const resolved = resolveBindings(content([field({ key: "party_name", value: "دستی" })]), context());
    expect(resolved.fields[0]).toMatchObject({ provenance: "literal", boundValue: null });
  });

  it("resolves an unavailable record to empty instead of failing", () => {
    const resolved = resolveBindings(
      content([field({ key: "party_name", binding: { source: "project", path: "party_name" } })]),
      context({ project: null }),
    );
    expect(resolved.values.party_name).toBe("");
    expect(resolved.fields[0].provenance).toBe("empty");
  });

  it("does not read a binding that is not in the catalogue", () => {
    const resolved = resolveBindings(
      content([field({ key: "party_name", binding: { source: "party", path: "secret" } })]),
      context(),
    );
    expect(resolved.fields[0]).toMatchObject({ provenance: "empty", bindingSupported: false });
  });

  it("formats money through the injected formatter and dates through the injected formatter", () => {
    const resolved = resolveBindings(
      content([
        field({ key: "amount", type: "money", binding: { source: "contract", path: "value" } }),
        field({ key: "today", type: "date", binding: { source: "contract", path: "today" } }),
      ]),
      context(),
      { formatMoney: (rial) => `${Number(rial).toLocaleString("en-US")} ریال`, formatDate: () => "۱۰ آبان ۱۴۰۵" },
    );
    expect(resolved.values.amount).toBe("1,250,000,000 ریال");
    expect(resolved.values.today).toBe("۱۰ آبان ۱۴۰۵");
  });

  it("reports tokens with no field definition", () => {
    const resolved = resolveBindings(content([], "{{a}} {{b}}"), context());
    expect(resolved.undefinedTokens).toEqual(["a", "b"]);
    expect(resolved.values).toEqual({});
  });
});

describe("changedBindings", () => {
  it("names only the keys whose resolved value moved", () => {
    expect(
      changedBindings({ a: "۱", b: "۲", c: "" }, { a: "۱", b: "۳", c: "۴" }),
    ).toEqual(["b", "c"]);
  });

  it("treats a missing key as empty and reports nothing for two empty maps", () => {
    expect(changedBindings({}, { a: "" })).toEqual([]);
    expect(changedBindings({ a: "" }, {})).toEqual([]);
    expect(changedBindings({ a: "x" }, {})).toEqual(["a"]);
  });
});
