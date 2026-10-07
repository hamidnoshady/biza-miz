/**
 * plan.ts — the ONE print-plan resolver. This is the regression suite for the
 * audit's central defect: a saved custom template, selected in Settings →
 * Rules, previewed and test-printed, used to print as a built-in at the till
 * because the renderer read a template key off the printer row and fell back
 * to a preset. What must never regress:
 *
 *  - a rule's saved template wins and is what production renders;
 *  - a rule's built-in key wins over the branch default;
 *  - the branch's saved default template is used when no rule names one;
 *  - an explicit template id (the settings test print) is honoured, and
 *    refused when it belongs to another document type or another branch;
 *  - a template that cannot be rendered by the printer is a refusal, never a
 *    silent substitution;
 *  - the resolver never picks a printer the rule did not name when the rule
 *    names one that is unavailable — it reports `printer_unavailable`;
 *  - the fallback printer is used exactly when the primary cannot take the
 *    document, and the plan records where it fell back from;
 *  - the plan carries the template REVISION that produced the job.
 *
 * Pure resolution is tested directly; the database loading is tested with the
 * `query` module stubbed, so no live database is required.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../db";
import { builtInFor, resolvePrintPlan, resolveTemplateChoice, selectableTemplates, toRoutingPrinter } from "./plan";
import { printerAcceptsPaper, printerClassFor } from "./routing";
import type { SavedPrintTemplate } from "../print-templates-service";
import type { StoredPrinter } from "./types";

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return { ...actual, query: vi.fn() };
});

vi.mock("../settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../settings")>();
  return { ...actual, getSetting: vi.fn(async () => null) };
});

function savedTemplate(overrides: Partial<SavedPrintTemplate> = {}): SavedPrintTemplate {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    key: "11111111-1111-1111-1111-111111111111",
    name: "فیش اختصاصی",
    docType: "receipt",
    paper: "thermal80",
    version: 7,
    isDefault: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    options: { fontScale: 1, lineHeight: 1.5, marginMm: 3, bodyWeight: 500, showUnit: true, copies: 1 },
    blocks: [{ id: "b1", type: "businessName", visible: true }],
    ...overrides,
  } as SavedPrintTemplate;
}

describe("resolveTemplateChoice — precedence", () => {
  it("uses the rule's saved template and keeps its revision", () => {
    const template = savedTemplate();
    const result = resolveTemplateChoice({
      documentType: "receipt",
      printerPaper: "thermal80",
      printerClass: "thermal",
      rule: { documentType: "receipt", printerId: "p1", fallbackPrinterId: null, templateKey: null, templateId: template.id },
      saved: [template],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.choice.templateId).toBe(template.id);
    expect(result.choice.templateKey).toBe(template.id);
    expect(result.choice.templateVersion).toBe(7);
    expect(result.choice.source).toBe("rule");
    expect(result.choice.template.name).toBe("فیش اختصاصی");
  });

  it("uses the rule's built-in key when no saved template is named", () => {
    const result = resolveTemplateChoice({
      documentType: "kitchen",
      printerPaper: "thermal80",
      printerClass: "thermal",
      rule: { documentType: "kitchen", printerId: "p1", fallbackPrinterId: null, templateKey: "thermal80-kitchen", templateId: null },
      saved: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.choice.templateKey).toBe("thermal80-kitchen");
    expect(result.choice.templateId).toBeNull();
    expect(result.choice.source).toBe("rule");
  });

  it("prefers the branch's saved default template over a built-in when no rule names one", () => {
    const template = savedTemplate({ isDefault: true });
    const result = resolveTemplateChoice({
      documentType: "receipt",
      printerPaper: "thermal80",
      printerClass: "thermal",
      saved: [template],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.choice.templateId).toBe(template.id);
    expect(result.choice.source).toBe("default");
  });

  it("honours an explicit template id above everything else", () => {
    const explicit = savedTemplate({ id: "explicit", name: "نمونه" });
    const def = savedTemplate({ id: "default", isDefault: true });
    const result = resolveTemplateChoice({
      documentType: "receipt",
      printerPaper: "thermal80",
      printerClass: "thermal",
      requestedTemplateId: "explicit",
      rule: { documentType: "receipt", printerId: "p1", fallbackPrinterId: null, templateKey: null, templateId: "default" },
      saved: [explicit, def],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.choice.templateId).toBe("explicit");
    expect(result.choice.source).toBe("explicit");
  });

  it("falls back to the printer's paper built-in when nothing else chooses", () => {
    const result = resolveTemplateChoice({
      documentType: "receipt",
      printerPaper: "thermal58",
      printerClass: "thermal",
      saved: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.choice.templateKey).toBe("thermal58-receipt");
    expect(result.choice.source).toBe("builtin");
  });

  it("still prints what an un-migrated printer row named, as the last resort only", () => {
    const legacy = resolveTemplateChoice({
      documentType: "receipt",
      printerPaper: "thermal80",
      printerClass: "thermal",
      saved: [],
      legacyPrinterTemplateKey: "thermal58-receipt",
    });
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    expect(legacy.choice.templateKey).toBe("thermal58-receipt");
    expect(legacy.choice.source).toBe("printer");

    // …and loses to a rule, which is the whole point of the promotion.
    const ruled = resolveTemplateChoice({
      documentType: "receipt",
      printerPaper: "thermal80",
      printerClass: "thermal",
      rule: { documentType: "receipt", printerId: "p1", fallbackPrinterId: null, templateKey: "thermal80-receipt", templateId: null },
      saved: [],
      legacyPrinterTemplateKey: "thermal58-receipt",
    });
    if (!ruled.ok) throw new Error("expected a rule template");
    expect(ruled.choice.templateKey).toBe("thermal80-receipt");
    expect(ruled.choice.source).toBe("rule");
  });
});

describe("resolveTemplateChoice — refusals, never silent substitution", () => {
  it("refuses an explicit template that does not exist in this branch", () => {
    const result = resolveTemplateChoice({
      documentType: "receipt",
      printerPaper: "thermal80",
      printerClass: "thermal",
      requestedTemplateId: "another-branch-template",
      saved: [],
    });
    expect(result).toEqual({ ok: false, error: "template_not_found" });
  });

  it("refuses a template whose document type does not match the job", () => {
    const label = savedTemplate({ docType: "label", paper: "label57x40" });
    const result = resolveTemplateChoice({
      documentType: "receipt",
      printerPaper: "thermal80",
      printerClass: "thermal",
      requestedTemplateId: label.id,
      saved: [label],
    });
    expect(result).toEqual({ ok: false, error: "template_invalid" });
  });

  it("refuses a rule template the printer cannot render (A4 layout on a roll)", () => {
    const a4 = savedTemplate({ docType: "invoice", paper: "a4" });
    const result = resolveTemplateChoice({
      documentType: "invoice",
      printerPaper: "a4",
      printerClass: "thermal",
      rule: { documentType: "invoice", printerId: "p1", fallbackPrinterId: null, templateKey: null, templateId: a4.id },
      saved: [a4],
    });
    expect(result).toEqual({ ok: false, error: "template_invalid" });
  });

  it("refuses a rule key that names nothing at all", () => {
    const result = resolveTemplateChoice({
      documentType: "receipt",
      printerPaper: "thermal80",
      printerClass: "thermal",
      rule: { documentType: "receipt", printerId: "p1", fallbackPrinterId: null, templateKey: "gone", templateId: null },
      saved: [],
    });
    expect(result).toEqual({ ok: false, error: "template_not_found" });
  });
});

describe("builtInFor / printerAcceptsPaper", () => {
  it("picks the built-in for the printer's own paper", () => {
    expect(builtInFor("receipt", "thermal58").key).toBe("thermal58-receipt");
    expect(builtInFor("invoice", "a5").key).toBe("a5-invoice");
    expect(builtInFor("kitchen", "thermal80").key).toBe("thermal80-kitchen");
    expect(builtInFor("label", "label57x40").key).toBe("label57x40-label");
  });

  it("never crosses document types to match a paper — a label stays a label", () => {
    // A label-purpose printer loaded with a thermal roll prints a STICKER:
    // the label layout re-widths onto the roll. Answering with the receipt
    // preset because it happens to be thermal80 is the silent wrong-layout
    // the unified resolver exists to prevent.
    expect(builtInFor("label", "thermal80").key).toBe("label57x40-label");
    expect(builtInFor("label", "thermal58").key).toBe("label57x40-label");
    expect(builtInFor("kitchen", "a4").docType).toBe("kitchen");
    expect(builtInFor("receipt", "label57x40").docType).toBe("receipt");
    // Same-kind papers still match by width within the document type.
    expect(builtInFor("receipt", "thermal80").key).toBe("thermal80-receipt");
  });

  it("knows which template papers each printer class can render", () => {
    expect(printerAcceptsPaper("thermal", "thermal80")).toBe(true);
    expect(printerAcceptsPaper("thermal", "label57x40")).toBe(true);
    expect(printerAcceptsPaper("thermal", "a4")).toBe(false);
    expect(printerAcceptsPaper("page", "a4")).toBe(true);
    expect(printerAcceptsPaper("page", "thermal80")).toBe(false);
    expect(printerAcceptsPaper("label", "label57x40")).toBe(true);
    expect(printerAcceptsPaper("label", "a4")).toBe(false);
  });

  it("lists only the templates a printer can actually render", () => {
    const saved = [
      savedTemplate({ id: "a", docType: "receipt", paper: "thermal80" }),
      savedTemplate({ id: "b", docType: "receipt", paper: "a5" }),
    ];
    const selectable = selectableTemplates(saved, "receipt", "thermal");
    expect(selectable.saved.map((t) => t.id)).toEqual(["a"]);
    expect(selectable.builtIns.every((t) => t.docType === "receipt")).toBe(true);
  });
});

describe("toRoutingPrinter — the relational columns decide", () => {
  function printerRow(overrides: Partial<StoredPrinter> = {}): StoredPrinter {
    return {
      id: "p1",
      name: "صندوق",
      kind: "receipt",
      connection: { type: "windows", systemName: "EPSON" },
      is_active: true,
      paper: "thermal80",
      paper_width_mm: 80,
      printer_class: "thermal",
      supports_drawer: true,
      is_default: true,
      ...overrides,
    };
  }

  it("reads purpose, paper, class, drawer and defaultness from the columns", () => {
    const routing = toRoutingPrinter(printerRow());
    expect(routing.purpose).toBe("receipt");
    expect(routing.paper).toBe("thermal80");
    expect(routing.printerClass).toBe("thermal");
    expect(routing.supportsDrawer).toBe(true);
    expect(routing.isDefault).toBe(true);
  });

  it("ignores behavioural keys left in the jsonb of an un-migrated row when the columns speak", () => {
    const routing = toRoutingPrinter(
      printerRow({
        paper: "thermal58",
        supports_drawer: false,
        is_default: false,
        connection: {
          type: "windows",
          systemName: "EPSON",
          // The pre-0211 duplicates; they must not win over the columns.
          paper: "thermal80",
          openDrawer: true,
          isDefault: true,
        },
      }),
    );
    expect(routing.paper).toBe("thermal58");
    expect(routing.supportsDrawer).toBe(false);
    expect(routing.isDefault).toBe(false);
  });

  it("still reads an un-migrated row's behaviour when the columns are NULL (bounded transition)", () => {
    const routing = toRoutingPrinter(
      printerRow({
        paper: null,
        paper_width_mm: null,
        supports_drawer: null,
        is_default: null,
        connection: { type: "network", ip: "10.0.0.5", paper: "thermal58", openDrawer: true, isDefault: true },
      }),
    );
    expect(routing.paper).toBe("thermal58");
    expect(routing.supportsDrawer).toBe(true);
    expect(routing.isDefault).toBe(true);
  });

  it("marks a reconnect-required row unusable even when its columns look fine", () => {
    const routing = toRoutingPrinter(
      printerRow({ connection: { needsReconnect: true, legacyTransport: "webusb" } }),
    );
    expect(routing.needsReconnect).toBe(true);
  });
});

/* ────────────────────────── database-backed resolution ────────────────────────── */

function mockDb(input: {
  printers?: Record<string, unknown>[];
  rules?: Record<string, unknown>[];
  templates?: Record<string, unknown>[];
}) {
  vi.mocked(db.query).mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes("FROM printers")) return { rows: (input.printers ?? []) as never[], rowCount: 0 } as never;
    if (text.includes("FROM print_rules")) return { rows: (input.rules ?? []) as never[], rowCount: 0 } as never;
    if (text.includes("FROM print_templates")) return { rows: (input.templates ?? []) as never[], rowCount: 0 } as never;
    if (text.includes("FROM locations")) {
      return { rows: [{ business_id: "biz-1", name: "شعبه", address: "تهران", phone: "021" }] as never[], rowCount: 0 } as never;
    }
    if (text.includes("FROM businesses")) return { rows: [{ name: "کافه تست" }] as never[], rowCount: 0 } as never;
    return { rows: [] as never[], rowCount: 0 } as never;
  });
}

function dbPrinter(overrides: Record<string, unknown> = {}) {
  return {
    id: "p-receipt",
    name: "چاپگر صندوق",
    kind: "receipt",
    connection: { type: "windows", systemName: "EPSON TM-T20III" },
    is_active: true,
    printer_class: "thermal",
    paper: "thermal80",
    paper_width_mm: 80,
    supports_drawer: true,
    supports_cut: true,
    is_default: true,
    ...overrides,
  };
}

function dbTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: "template-1",
    name: "فیش اختصاصی",
    doc_type: "receipt",
    paper: "thermal80",
    layout: { options: {}, blocks: [{ id: "b1", type: "businessName", visible: true }] },
    is_default: false,
    version: 4,
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("resolvePrintPlan — the till's answer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prints the rule's saved template, with its revision and the resolved branding", async () => {
    mockDb({
      printers: [dbPrinter()],
      rules: [
        { document_type: "receipt", printer_id: "p-receipt", fallback_printer_id: null, template_key: null, template_id: "template-1" },
      ],
      templates: [dbTemplate()],
    });
    const result = await resolvePrintPlan({ locationId: "loc-1", documentType: "receipt" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.printer.id).toBe("p-receipt");
    expect(result.plan.templateId).toBe("template-1");
    expect(result.plan.templateVersion).toBe(4);
    expect(result.plan.templateSource).toBe("rule");
    expect(result.plan.template.name).toBe("فیش اختصاصی");
    expect(result.plan.branding.name).toBe("کافه تست");
    expect(result.plan.branding.address).toBe("تهران");
    expect(result.plan.paper).toBe("thermal80");
  });

  it("uses the rule's printer and reports `rule` as the route", async () => {
    mockDb({
      printers: [dbPrinter({ is_default: false }), dbPrinter({ id: "p2", name: "پشتیبان", is_default: false })],
      rules: [
        { document_type: "receipt", printer_id: "p2", fallback_printer_id: null, template_key: null, template_id: null },
      ],
      templates: [],
    });
    const result = await resolvePrintPlan({ locationId: "loc-1", documentType: "receipt" });
    if (!result.ok) throw new Error("expected a plan");
    expect(result.plan.printer.id).toBe("p2");
    expect(result.plan.reason).toBe("rule");
  });

  it("falls back to the rule's fallback printer and records where it came from", async () => {
    mockDb({
      printers: [
        dbPrinter({ id: "p-primary", name: "اصلی", is_active: false }),
        dbPrinter({ id: "p-backup", name: "پشتیبان", is_default: false }),
      ],
      rules: [
        {
          document_type: "receipt",
          printer_id: "p-primary",
          fallback_printer_id: "p-backup",
          template_key: null,
          template_id: null,
        },
      ],
      templates: [],
    });
    const result = await resolvePrintPlan({ locationId: "loc-1", documentType: "receipt" });
    if (!result.ok) throw new Error("expected a plan");
    expect(result.plan.printer.id).toBe("p-backup");
    expect(result.plan.fallbackPrinter?.id).toBe("p-primary");
    expect(result.plan.reason).toBe("fallback");
  });

  it("refuses rather than printing somewhere the rule never named", async () => {
    mockDb({
      printers: [dbPrinter({ id: "p-other", name: "چاپگر دیگر", is_default: true })],
      rules: [
        { document_type: "receipt", printer_id: "p-primary", fallback_printer_id: null, template_key: null, template_id: null },
      ],
      templates: [],
    });
    const result = await resolvePrintPlan({ locationId: "loc-1", documentType: "receipt" });
    expect(result).toEqual({ ok: false, error: "printer_unavailable" });
  });

  it("refuses an explicit printer that belongs to another branch", async () => {
    mockDb({ printers: [dbPrinter()], rules: [], templates: [] });
    const result = await resolvePrintPlan({
      locationId: "loc-1",
      documentType: "receipt",
      requestedPrinterId: "another-branch",
    });
    expect(result).toEqual({ ok: false, error: "printer_not_found" });
  });

  it("refuses an explicit template that belongs to another branch", async () => {
    mockDb({ printers: [dbPrinter()], rules: [], templates: [] });
    const result = await resolvePrintPlan({
      locationId: "loc-1",
      documentType: "receipt",
      requestedTemplateId: "someone-elses-template",
    });
    expect(result).toEqual({ ok: false, error: "template_not_found" });
  });

  it("never routes a document to a printer of another purpose", async () => {
    mockDb({
      printers: [dbPrinter({ id: "p-kitchen", kind: "kitchen" })],
      rules: [],
      templates: [],
    });
    expect(await resolvePrintPlan({ locationId: "loc-1", documentType: "invoice" })).toEqual({
      ok: false,
      error: "printer_not_configured",
    });
    // A kitchen printer is not a fallback for a customer receipt either —
    // the till says so instead of printing a receipt in the kitchen.
    expect(await resolvePrintPlan({ locationId: "loc-1", documentType: "receipt" })).toEqual({
      ok: false,
      error: "printer_not_configured",
    });
  });

  it("refuses an explicit printer of the wrong purpose with a precise code", async () => {
    mockDb({ printers: [dbPrinter({ id: "p-kitchen", kind: "kitchen" })], rules: [], templates: [] });
    expect(
      await resolvePrintPlan({ locationId: "loc-1", documentType: "receipt", requestedPrinterId: "p-kitchen" }),
    ).toEqual({ ok: false, error: "incompatible_printer" });
  });

  it("refuses an explicit inactive printer, naming the reason", async () => {
    mockDb({ printers: [dbPrinter({ is_active: false })], rules: [], templates: [] });
    expect(
      await resolvePrintPlan({ locationId: "loc-1", documentType: "receipt", requestedPrinterId: "p-receipt" }),
    ).toEqual({ ok: false, error: "printer_inactive" });
  });

  it("serves document and label purposes end to end", async () => {
    mockDb({
      printers: [
        dbPrinter({
          id: "p-a4",
          kind: "document",
          printer_class: "page",
          paper: "a4",
          paper_width_mm: null,
          supports_drawer: false,
          connection: { type: "windows", systemName: "HP LaserJet" },
        }),
        dbPrinter({
          id: "p-label",
          kind: "label",
          printer_class: "label",
          paper: "label57x40",
          paper_width_mm: null,
          supports_drawer: false,
          connection: { type: "network", ip: "10.0.0.7", port: 9100 },
        }),
      ],
      rules: [],
      templates: [],
    });
    const invoice = await resolvePrintPlan({ locationId: "loc-1", documentType: "invoice" });
    if (!invoice.ok) throw new Error("expected an invoice plan");
    expect(invoice.plan.printer.id).toBe("p-a4");
    expect(invoice.plan.templateKey).toBe("a4-invoice");
    expect(invoice.plan.paper).toBe("a4");

    const label = await resolvePrintPlan({ locationId: "loc-1", documentType: "label" });
    if (!label.ok) throw new Error("expected a label plan");
    expect(label.plan.printer.id).toBe("p-label");
    expect(label.plan.templateKey).toBe("label57x40-label");
  });
});

describe("printerClassFor — purpose and paper decide the class", () => {
  it("maps every supported pair", () => {
    expect(printerClassFor("receipt", "thermal80")).toBe("thermal");
    expect(printerClassFor("kitchen", "thermal58")).toBe("thermal");
    expect(printerClassFor("document", "a4")).toBe("page");
    expect(printerClassFor("label", "label57x40")).toBe("label");
    expect(printerClassFor("label", "thermal80")).toBe("label");
  });
});
