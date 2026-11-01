/**
 * Issue #908 — the starter templates are content, not code paths.
 *
 * They ship inside the app, so a mistake in one is a contract a tenant will
 * print without ever opening this file. The tests therefore check the structural
 * promises the epic makes about any template a business can start from:
 * it has a title, its block and slot ids are unique, every `{{variable}}` it
 * prints is defined, and it has at least one signature line to sign on.
 *
 * The blank template is the deliberate exception: it is *meant* to be an empty
 * page, and validation (not the template) is what stops it being sent.
 */
import { describe, expect, it } from "vitest";
import {
  CONTRACT_BLOCK_TYPES,
  CONTRACT_FIELD_TYPES,
  referencedTokens,
  renderTemplate,
  signatureSlots,
  validateContractContent,
} from "./blocks";
import {
  BUILTIN_CONTRACT_TEMPLATES,
  builtinContractTemplate,
  contentFromTemplate,
} from "./templates";

const CONTRACT_TYPES = [
  "contractor",
  "supplier",
  "consultant",
  "subcontractor",
  "vendor",
  "developer",
  "service",
  "other",
];

describe("BUILTIN_CONTRACT_TEMPLATES", () => {
  it("has unique keys, names and a supported contract type", () => {
    const keys = BUILTIN_CONTRACT_TEMPLATES.map((template) => template.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const template of BUILTIN_CONTRACT_TEMPLATES) {
      expect(template.name.trim()).not.toBe("");
      expect(template.description.trim()).not.toBe("");
      expect(CONTRACT_TYPES).toContain(template.contractType);
    }
  });

  it("uses only block and field types the editor can render and edit", () => {
    for (const template of BUILTIN_CONTRACT_TEMPLATES) {
      for (const block of template.content.blocks) {
        expect(CONTRACT_BLOCK_TYPES).toContain(block.type);
      }
      for (const field of template.content.fields) {
        expect(CONTRACT_FIELD_TYPES).toContain(field.type);
      }
    }
  });

  it("gives every ready-made template a title, unique ids, defined variables and a signature line", () => {
    for (const template of BUILTIN_CONTRACT_TEMPLATES) {
      if (template.key === "blank") continue;
      const { content } = template;
      expect(content.title.trim()).not.toBe("");
      const blockIds = content.blocks.map((block) => block.id);
      expect(new Set(blockIds).size).toBe(blockIds.length);
      const slots = signatureSlots(content).map((slot) => slot.slotId);
      expect(new Set(slots).size).toBe(slots.length);
      expect(slots.length).toBeGreaterThan(0);

      const defined = new Set(content.fields.map((field) => field.key));
      for (const token of referencedTokens(content)) {
        expect(defined.has(token)).toBe(true);
      }
      const fieldKeys = content.fields.map((field) => field.key);
      expect(new Set(fieldKeys).size).toBe(fieldKeys.length);
    }
  });

  it("never ships a template that is already sendable without the sender filling it", () => {
    // A template with no unresolved variables would freeze the moment it is
    // created, which would let a business send a contract for the wrong project.
    for (const template of BUILTIN_CONTRACT_TEMPLATES) {
      if (template.key === "blank") continue;
      const issues = validateContractContent(template.content, {});
      expect(issues.some((issue) => issue.code === "field_required")).toBe(true);
    }
  });

  it("reports the blank template as unsendable rather than letting it through", () => {
    const blank = builtinContractTemplate("blank");
    expect(blank).not.toBeNull();
    if (!blank) return;
    const codes = validateContractContent(blank.content, {}).map((issue) => issue.code);
    expect(codes).toContain("signature_slot_missing");
    expect(codes).toContain("document_title_required");
  });
});

describe("builtinContractTemplate", () => {
  it("finds a template by key and returns null for anything else", () => {
    expect(builtinContractTemplate("blank")?.name).toBe("سند سفید");
    expect(builtinContractTemplate("nope")).toBeNull();
    expect(builtinContractTemplate("")).toBeNull();
  });
});

describe("contentFromTemplate", () => {
  const source = BUILTIN_CONTRACT_TEMPLATES.find(
    (template) => template.key === "construction_subcontract",
  );

  it("hands out a copy, so editing a contract cannot mutate the template", () => {
    if (!source) throw new Error("expected the subcontract template");
    const first = contentFromTemplate(source);
    const second = contentFromTemplate(source);
    const paragraph = first.blocks.find((block) => block.type === "paragraph");
    if (paragraph?.type === "paragraph") paragraph.text = "تغییر یافته";
    expect(second.blocks).not.toEqual(first.blocks);
    expect(JSON.stringify(source.content)).not.toContain("تغییر یافته");
  });

  it("applies an explicit title without touching the body", () => {
    if (!source) throw new Error("expected the subcontract template");
    const content = contentFromTemplate(source, "پیمان پروژهٔ الف");
    expect(content.title).toBe("پیمان پروژهٔ الف");
    expect(content.blocks.length).toBe(source.content.blocks.length);
  });

  it("renders its party article once the sender fills the counterparty", () => {
    if (!source) throw new Error("expected the subcontract template");
    const content = contentFromTemplate(source);
    const article = content.blocks.find(
      (block) => block.type === "article" && block.text.includes("{{counterparty_name}}"),
    );
    if (!article || article.type !== "article") throw new Error("expected the party article");
    const rendered = renderTemplate(article.text, {
      today: "۱۰ آبان ۱۴۰۵",
      employer_name: "کسب‌وکار من",
      business_address: "تهران",
      counterparty_name: "شرکت الف",
      counterparty_national_id: "۱۰۱۰۱۰۱۰۱۰۱",
    });
    expect(rendered).toContain("شرکت الف");
    expect(rendered).not.toContain("{{");
  });
});
