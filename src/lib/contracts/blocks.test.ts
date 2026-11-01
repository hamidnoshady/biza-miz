/**
 * Issue #908 — the contract document model is the boundary between a client
 * that may send anything and a signer who must read exactly one document.
 *
 * These tests are the ones that matter for that boundary:
 *
 *  - normalisation drops what it does not understand instead of rendering it;
 *  - a duplicated signature placement is renumbered, never merged, because two
 *    signers cannot share one line;
 *  - validation refuses to freeze a document with an undefined `{{token}}` or
 *    an empty required value;
 *  - money and dates are formatted through injected formatters, so the module
 *    stays database-free and the display unit is never guessed.
 */
import { describe, expect, it } from "vitest";
import {
  CONTRACT_ISSUE_MESSAGES,
  CONTRACT_LIMITS,
  documentSummary,
  formatFieldValue,
  normalizeContractContent,
  referencedTokens,
  renderTemplate,
  signatureSlots,
  tokenizeTemplate,
  validateContractContent,
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

describe("normalizeContractContent", () => {
  it("drops unknown block types and keeps the recognised ones in order", () => {
    const content = normalizeContractContent({
      title: "  قرارداد  ",
      blocks: [
        { id: "b1", type: "heading", text: "عنوان" },
        { id: "b2", type: "iframe", src: "javascript:alert(1)" },
        { id: "b3", type: "paragraph", text: "متن" },
      ],
    });
    expect(content.blocks.map((block) => block.type)).toEqual(["heading", "paragraph"]);
    expect(content.title).toBe("  قرارداد  ");
    expect(content.version).toBe(1);
  });

  it("pads and trims ragged table rows so every consumer sees a rectangle", () => {
    const content = normalizeContractContent({
      blocks: [
        {
          id: "t1",
          type: "table",
          caption: "",
          columns: ["a", "b", "c"],
          rows: [["1"], ["1", "2", "3", "4"]],
        },
      ],
    });
    const table = content.blocks[0];
    expect(table?.type).toBe("table");
    if (table?.type !== "table") throw new Error("expected table");
    expect(table.rows).toEqual([
      ["1", "", ""],
      ["1", "2", "3"],
    ]);
  });

  it("renumbers a duplicated signature placement instead of losing a signature line", () => {
    const content = normalizeContractContent({
      blocks: [
        { id: "s1", type: "signature", slotId: "employer", label: "امضای کارفرما", caption: "" },
        { id: "s2", type: "signature", slotId: "employer", label: "امضای پیمان‌کار", caption: "" },
      ],
    });
    const slots = signatureSlots(content);
    expect(slots.map((slot) => slot.slotId)).toEqual(["employer", "employer_2"]);
  });

  it("folds duplicate field keys and rejects keys that are not identifiers", () => {
    const content = normalizeContractContent({
      fields: [
        { key: "party_name", label: "اول" },
        { key: "party_name", label: "دوم" },
        { key: "Party Name", label: "سوم" },
        { key: "1abc", label: "چهارم" },
      ],
    });
    expect(content.fields.map((entry) => entry.key)).toEqual(["party_name"]);
    expect(content.fields[0].label).toBe("اول");
  });

  it("caps lengths instead of throwing on a hostile payload", () => {
    const content = normalizeContractContent({
      title: "x".repeat(CONTRACT_LIMITS.titleMax + 50),
      blocks: Array.from({ length: CONTRACT_LIMITS.blocksMax + 20 }, (_, index) => ({
        id: `b${index}`,
        type: "paragraph",
        text: "y".repeat(CONTRACT_LIMITS.textMax + 100),
      })),
    });
    expect(content.title).toHaveLength(CONTRACT_LIMITS.titleMax);
    expect(content.blocks).toHaveLength(CONTRACT_LIMITS.blocksMax);
    expect(content.blocks[0]?.type === "paragraph" && content.blocks[0].text.length).toBe(
      CONTRACT_LIMITS.textMax,
    );
  });

  it("returns an empty, valid-shape document for junk", () => {
    for (const junk of [null, undefined, 42, "text", [], { blocks: "nope" }]) {
      const content = normalizeContractContent(junk);
      expect(content.blocks).toEqual([]);
      expect(content.fields).toEqual([]);
    }
  });
});

describe("tokens", () => {
  it("finds tokens anywhere in a text value, once each", () => {
    expect(referencedTokens(normalizeContractContent({
      blocks: [
        { id: "b1", type: "paragraph", text: "{{a}} و {{ b }} و {{a}}" },
        { id: "b2", type: "table", columns: ["{{c}}"], rows: [["{{d}}"]] , caption: "" },
      ],
    }))).toEqual(["a", "b", "c", "d"]);
  });

  it("renders a resolved value and leaves an unresolved token empty", () => {
    expect(renderTemplate("نام: {{party_name}}", { party_name: "شرکت الف" })).toBe("نام: شرکت الف");
    expect(renderTemplate("نام: {{party_name}}", {})).toBe("نام: ");
  });

  it("splits text into literal runs and token segments, marking unresolved ones", () => {
    const segments = tokenizeTemplate("الف {{a}} ب {{b}}", { a: "۱" });
    expect(segments).toEqual([
      { kind: "text", text: "الف " },
      { kind: "token", key: "a", raw: "{{a}}", value: "۱" },
      { kind: "text", text: " ب " },
      { kind: "token", key: "b", raw: "{{b}}", value: null },
    ]);
  });
});

describe("validateContractContent", () => {
  const base = (overrides: Partial<ContractDocumentContent> = {}): ContractDocumentContent => ({
    version: 1,
    title: "قرارداد",
    headerText: "",
    footerText: "",
    blocks: [
      { id: "b1", type: "paragraph", text: "متن {{party_name}}" },
      { id: "s1", type: "signature", slotId: "sig_a", label: "امضا", caption: "" },
    ],
    fields: [field({ key: "party_name", required: true, binding: { source: "party", path: "name" } })],
    ...overrides,
  });

  it("reports an empty document and a missing title", () => {
    const codes = validateContractContent(
      normalizeContractContent({ title: "", blocks: [] }),
    ).map((issue) => issue.code);
    expect(codes).toContain("document_empty");
    expect(codes).toContain("document_title_required");
  });

  it("reports a token that has no field definition", () => {
    const content = base({ fields: [] });
    const issues = validateContractContent(content);
    expect(issues.map((issue) => [issue.code, issue.fieldKey])).toContainEqual([
      "field_undefined",
      "party_name",
    ]);
    expect(issues[0].message).toBe(CONTRACT_ISSUE_MESSAGES.field_undefined);
  });

  it("refuses a required value that resolved to nothing, and requires a placement", () => {
    const content = base();
    const issues = validateContractContent(content, { party_name: "  " });
    expect(issues.map((issue) => issue.code)).toContain("field_required");
    const withoutSlots = base({
      blocks: [{ id: "b1", type: "paragraph", text: "{{party_name}}" }],
    });
    expect(
      validateContractContent(withoutSlots, { party_name: "شرکت الف" }).map((issue) => issue.code),
    ).toContain("signature_slot_missing");
  });

  it("passes a fully resolved document with a placement", () => {
    expect(validateContractContent(base(), { party_name: "شرکت الف" })).toEqual([]);
  });

  it("refuses a select value outside its options", () => {
    const content = base({
      blocks: [{ id: "b1", type: "paragraph", text: "{{mode}}" }],
      fields: [field({ key: "mode", type: "select", options: ["الف", "ب"] })],
    });
    const issues = validateContractContent(content, { mode: "ج" });
    expect(issues.map((issue) => issue.code)).toContain("field_select_invalid");
  });

  it("flags an empty table", () => {
    const content = base({
      blocks: [{ id: "t1", type: "table", caption: "", columns: [], rows: [] }],
      fields: [],
    });
    expect(validateContractContent(content).map((issue) => issue.code)).toContain("table_empty");
  });
});

describe("formatFieldValue", () => {
  it("formats money through the injected formatter and never invents a unit", () => {
    const money = field({ key: "value", type: "money" });
    expect(formatFieldValue(money, "1250000", { formatMoney: (rial) => `${rial} formatted` })).toBe(
      "1250000 formatted",
    );
    expect(formatFieldValue(money, "1250000")).toBe("1250000");
  });

  it("formats dates through the injected formatter and falls back to the raw value", () => {
    const date = field({ key: "date", type: "date" });
    expect(formatFieldValue(date, "2026-11-01", { formatDate: () => "۱۰ آبان ۱۴۰۵" })).toBe(
      "۱۰ آبان ۱۴۰۵",
    );
    expect(formatFieldValue(date, "not-a-date", { formatDate: () => null as unknown as string })).toBe(
      "not-a-date",
    );
  });

  it("renders a checkbox as بله/خیر", () => {
    const checkbox = field({ key: "flag", type: "checkbox" });
    expect(formatFieldValue(checkbox, "true")).toBe("بله");
    expect(formatFieldValue(checkbox, "false")).toBe("خیر");
  });
});

describe("documentSummary", () => {
  it("prefers the first heading, then the first text, and never shows raw tokens", () => {
    expect(
      documentSummary(
        normalizeContractContent({
          title: "{{party_name}}",
          blocks: [{ id: "b1", type: "heading", text: "پیمان اجرا" }],
        }),
      ),
    ).toBe("پیمان اجرا");
    expect(
      documentSummary(
        normalizeContractContent({ blocks: [{ id: "b1", type: "paragraph", text: "بند {{x}}" }] }),
      ),
    ).toBe("بند");
  });
});
