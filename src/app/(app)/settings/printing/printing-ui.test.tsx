// @vitest-environment jsdom

/**
 * The rules screen and the add-printer wizard are the two places a person can
 * make printing impossible or wrong, so these tests drive them as a user does
 * (issue #815's component list):
 *
 *  - the Rules UI lists saved custom templates next to the built-ins, and
 *    never a template the chosen printer cannot carry;
 *  - it offers only printers that can print that document type, and never the
 *    primary printer as its own fallback;
 *  - it shows what would actually print now (template revision and route);
 *  - «چاپ نمونه» goes through the operational pipeline with the rule's own
 *    template pinned by id;
 *  - the wizard offers the four purposes, follows the purpose with its papers,
 *    blocks A4/A5 over the network, and asks about hardware only — there is no
 *    template control anywhere in it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PrintingManager } from "./printing-manager";
import { AddPrinterDialog } from "./add-printer-flow";
import { sampleForTemplate } from "./template-gallery";
import type { PrinterRow, SavedTemplateRow } from "./use-printing";
import { MoneyProvider } from "@/components/money/money-context";
import { samplePrintDocument } from "@/lib/print-sample";
import { BUILT_IN_TEMPLATES, type PrintTemplate } from "@/lib/print-template";
import { availableBuiltInTemplates, availableDocumentTypes } from "@/lib/printing/template-catalog";
import type { Industry } from "@/lib/industries";

const FOOD_SERVICE_BUILT_INS = availableBuiltInTemplates({ industry: "food_service", wooEnabled: false });
const JEWELRY_BUILT_INS = availableBuiltInTemplates({ industry: "jewelry", wooEnabled: false });
const FOOD_SERVICE_DOCUMENT_TYPES = availableDocumentTypes(FOOD_SERVICE_BUILT_INS);

const apiMock = vi.fn();
const printTemplateSampleMock = vi.fn();

vi.mock("@/app/dashboard/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/dashboard/ui")>();
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});

vi.mock("@/lib/printing/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/printing/client")>();
  return {
    ...actual,
    printTemplateSample: (...args: unknown[]) => printTemplateSampleMock(...args),
    connectorHealth: vi.fn(async () => ({ ok: true, data: { ok: true, service: "connector", version: 4 } })),
    allowConnectorRetry: vi.fn(),
  };
});

/* ── fixtures ─────────────────────────────────────────────────────────── */

const RECEIPT_PRINTER: PrinterRow = {
  id: "p-receipt",
  name: "صندوق",
  kind: "receipt",
  connection: { type: "windows", systemName: "EPSON TM-T20III" },
  is_active: true,
  printer_class: "thermal",
  paper: "thermal80",
  paper_width_mm: 80,
  supports_drawer: true,
  supports_cut: true,
  is_default: true,
};

const KITCHEN_PRINTER: PrinterRow = {
  id: "p-kitchen",
  name: "آشپزخانه",
  kind: "kitchen",
  connection: { type: "windows", systemName: "POS-80" },
  is_active: true,
  printer_class: "thermal",
  paper: "thermal80",
  paper_width_mm: 80,
  supports_drawer: false,
  supports_cut: true,
  is_default: false,
};

const A4_PRINTER: PrinterRow = {
  id: "p-a4",
  name: "A4 اداری",
  kind: "document",
  connection: { type: "windows", systemName: "HP LaserJet" },
  is_active: true,
  printer_class: "page",
  paper: "a4",
  paper_width_mm: null,
  supports_drawer: false,
  supports_cut: true,
  is_default: false,
};

function savedTemplate(overrides: Partial<SavedTemplateRow> = {}): SavedTemplateRow {
  return {
    id: "tpl-1",
    // A saved row carries its own id as the template key (see the service's
    // `mapRow`); the id is what pins it.
    key: "tpl-1",
    name: "قالب سفارشی من",
    docType: "receipt",
    paper: "thermal80",
    isDefault: true,
    version: 3,
    updatedAt: "2026-01-01T00:00:00Z",
    options: { fontScale: 1, lineHeight: 1.5, marginMm: 3, bodyWeight: 400, showUnit: true, copies: 1 },
    blocks: [{ id: "b1", type: "businessName", visible: true }],
    ...overrides,
  };
}

const RULES = [
  {
    document_type: "receipt",
    template_key: null,
    template_id: "tpl-1",
    printer_id: "p-receipt",
    fallback_printer_id: null,
  },
];

const RESOLVED = {
  receipt: {
    ok: true,
    printerName: "صندوق",
    route: "rule",
    fallbackPrinterName: null,
    templateKey: "tpl-1",
    templateId: "tpl-1",
    templateName: "قالب سفارشی من",
    templateVersion: 3,
    templateSource: "rule",
  },
  label: { ok: false, error: "printer_not_configured" },
};

function routeApi(
  builtIns: PrintTemplate[] = FOOD_SERVICE_BUILT_INS,
  industry: Industry = "food_service",
) {
  apiMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    if (url === "/api/settings/print-rules" && init?.method === "PUT") return { ok: true, data: {} };
    if (url === "/api/settings/print-rules") return { ok: true, data: { rules: RULES, resolved: RESOLVED, supportedDocumentTypes: availableDocumentTypes(builtIns) } };
    if (url === "/api/settings/printers") return { ok: true, data: { printers: [RECEIPT_PRINTER, KITCHEN_PRINTER, A4_PRINTER] } };
    if (url === "/api/settings/print-templates") return { ok: true, data: { templates: [savedTemplate()], builtIns, unavailableTemplates: [], industry } };
    if (url === "/api/printing/jobs") return { ok: true, data: { jobs: [] } };
    if (url === "/api/settings/business") return { ok: true, data: { business: { name: "کافه تست" }, location: null, profile: null } };
    if (url === "/api/settings/business/logo") return { ok: true, data: { logo: null } };
    return { ok: true, data: {} };
  });
}

/** The rendered screen's whole text — the honest way to assert a JSX-fragmented sentence. */
function bodyText(): string {
  return document.body.textContent ?? "";
}

async function openRules() {
  render(<PrintingManager />);
  await waitFor(() => expect(screen.getByRole("tab", { name: "قوانین چاپ" })).toBeTruthy());
  fireEvent.click(screen.getByRole("tab", { name: "قوانین چاپ" }));
  await screen.findAllByText("رسید فروش");
}

async function openTemplates() {
  render(<PrintingManager />);
  await waitFor(() => expect(screen.getByRole("tab", { name: "قالب‌ها" })).toBeTruthy());
  fireEvent.click(screen.getByRole("tab", { name: "قالب‌ها" }));
  await screen.findByText("قالب‌های آماده");
}

/**
 * The rule cards' selects, in document order (receipt, kitchen, invoice,
 * label). Found by the caption span that precedes each select rather than by
 * label association: a card with no compatible printer renders its warning
 * inside the same `<label>`, which changes that label's text.
 */
function selectsWithCaption(match: (caption: string) => boolean): HTMLSelectElement[] {
  return [...document.querySelectorAll("select")].filter((select) =>
    match(select.previousElementSibling?.textContent ?? ""),
  ) as HTMLSelectElement[];
}

function templateSelects(): HTMLSelectElement[] {
  return selectsWithCaption((caption) => caption === "قالب");
}

function printerSelects(): HTMLSelectElement[] {
  return selectsWithCaption((caption) => caption === "چاپگر");
}

function fallbackSelects(): HTMLSelectElement[] {
  return selectsWithCaption((caption) => caption.startsWith("چاپگر جانشین"));
}

function optionTexts(select: HTMLSelectElement): string[] {
  return [...select.querySelectorAll("option")].map((option) => option.textContent ?? "");
}

function putBodyOf(documentType: string): Record<string, unknown> {
  const call = apiMock.mock.calls.find(
    ([url, init]) => url === "/api/settings/print-rules" && (init as { method?: string })?.method === "PUT",
  );
  expect(call, "a rule was saved").toBeDefined();
  const body = JSON.parse(String((call?.[1] as { body?: string })?.body)) as { documentType: string };
  expect(body.documentType).toBe(documentType);
  return body;
}

beforeEach(() => {
  apiMock.mockReset();
  printTemplateSampleMock.mockReset();
  printTemplateSampleMock.mockResolvedValue({ ok: true });
  routeApi();
});

afterEach(() => {
  cleanup();
});

/* ── the rules screen ─────────────────────────────────────────────────── */

describe("Rules screen — templates", () => {
  it("offers the branch's saved templates next to the built-ins for each document type", async () => {
    await openRules();
    const options = optionTexts(templateSelects()[0]);
    expect(options).toContain("قالب سفارشی من — پیش‌فرض");
    expect(options).toContain("فیش فروش ۸۰ میلی‌متری");
    expect(options).toContain("فیش فشردهٔ ۵۸ میلی‌متری");
    // Nothing of another document type leaks into this rule.
    expect(options).not.toContain("فاکتور رسمی A4");
    expect(options).not.toContain("برچسب ۵۷×۴۰ میلی‌متری");
  });

  it("keeps templates of the wrong paper out of a rule whose printer cannot carry them", async () => {
    await openRules();
    // The invoice rule's printer is a page printer: the receipt template is
    // not a choice there, and the sheet templates are.
    const invoiceOptions = optionTexts(templateSelects()[2]);
    expect(invoiceOptions).toContain("فاکتور رسمی A4");
    expect(invoiceOptions).toContain("فاکتور A5 (پیک و تحویل)");
    expect(invoiceOptions).not.toContain("قالب سفارشی من — پیش‌فرض");
  });

  it("shows the resolved print plan and template revision for every supported document", async () => {
    await openRules();
    expect(bodyText()).toContain("اکنون: قالب «قالب سفارشی من» (نسخهٔ ۳) روی «صندوق» — مسیر: قانون این سند");
    expect(bodyText()).toContain("فعالیت اخیر");
  });

  it("sends the saved template as templateId and a built-in as templateKey", async () => {
    await openRules();
    const receiptSelect = templateSelects()[0];

    fireEvent.change(receiptSelect, { target: { value: "key:thermal58-receipt" } });
    fireEvent.click(screen.getAllByRole("button", { name: "ذخیره" })[0]);
    await waitFor(() => expect(putBodyOf("receipt")).toMatchObject({ templateKey: "thermal58-receipt" }));

    apiMock.mockClear();
    routeApi();
    fireEvent.change(receiptSelect, { target: { value: "id:tpl-1" } });
    fireEvent.click(screen.getAllByRole("button", { name: "ذخیره" })[0]);
    await waitFor(() => expect(putBodyOf("receipt")).toMatchObject({ templateId: "tpl-1", templateKey: null }));
  });
});

describe("Template gallery — preview and selection", () => {
  it("shows only built-ins and document filters allowed by this business type and its capabilities", async () => {
    await openTemplates();
    expect(screen.queryByText("فاکتور تفصیلی طلا و جواهر A4")).toBeNull();
    expect(screen.queryByText("تگ جواهر ۵۷×۴۰")).toBeNull();
    expect(screen.queryByRole("tab", { name: "برچسب" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "فاکتور سفارش آنلاین" })).toBeNull();
    expect(screen.getByRole("tab", { name: "رسید فروش" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "سفارش آشپزخانه" })).toBeTruthy();
  });

  it("uses the business-selected Rial unit in gallery previews", async () => {
    routeApi(JEWELRY_BUILT_INS, "jewelry");
    render(
      <MoneyProvider unit="rial">
        <PrintingManager />
      </MoneyProvider>,
    );
    await waitFor(() => expect(screen.getByRole("tab", { name: "قالب‌ها" })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "قالب‌ها" }));
    await screen.findByText("فاکتور تفصیلی طلا و جواهر A4");

    await waitFor(() => {
      const sourceDocuments = [...document.querySelectorAll<HTMLIFrameElement>('iframe[srcdoc]')]
        .map((frame) => frame.getAttribute("srcdoc") ?? "");
      expect(sourceDocuments.some((html) => html.includes("۸۴٬۰۰۰٬۰۰۰ ریال"))).toBe(true);
    });
    const sourceDocuments = [...document.querySelectorAll<HTMLIFrameElement>('iframe[srcdoc]')]
      .map((frame) => frame.getAttribute("srcdoc") ?? "");
    expect(sourceDocuments.some((html) => html.includes("۸۴٬۰۰۰٬۰۰۰ تومان"))).toBe(false);
  });

  it("offers only supported document types when creating a custom template", async () => {
    await openTemplates();
    fireEvent.click(screen.getByRole("button", { name: "قالب جدید" }));
    const documentTypePicker = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "رسید فروش");
    expect(documentTypePicker).toBeTruthy();
    fireEvent.click(documentTypePicker!);
    const options = within(await screen.findByRole("listbox")).getAllByRole("option").map((option) => option.textContent?.trim());
    expect(options).toEqual(["رسید فروش", "فاکتور", "سفارش آشپزخانه"]);
  });

  it("uses a fixed scroll-free thumbnail stage and opens a monitor-only preview", async () => {
    await openTemplates();
    const stages = [...document.querySelectorAll<HTMLElement>("[aria-label^='تصویر کامل قالب']")];
    expect(stages.length).toBeGreaterThan(0);
    for (const stage of stages) {
      expect(stage.className).toContain("overflow-hidden");
      expect(stage.querySelectorAll(".overflow-auto")).toHaveLength(0);
    }
    await waitFor(() => expect(document.querySelectorAll('iframe[srcdoc]').length).toBeGreaterThan(0));
    const sampleFrame = document.querySelector<HTMLIFrameElement>('iframe[srcdoc]')!;
    expect(sampleFrame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(sampleFrame.getAttribute("srcdoc")).toContain("default-src 'none'");
    expect(sampleFrame.getAttribute("srcdoc")).toContain("connect-src 'none'");

    const previewButtons = screen.getAllByRole("button", { name: "پیش‌نمایش دیجیتال" });
    expect(previewButtons.length).toBeGreaterThan(1);
    fireEvent.click(previewButtons[0]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/پیش‌نمایش روی صفحه با داده‌های ساختگی/)).toBeTruthy();
    expect(printTemplateSampleMock).not.toHaveBeenCalled();
  });

  it("selects a built-in directly through the authoritative branch print rule", async () => {
    await openTemplates();
    const cards = [...document.querySelectorAll<HTMLElement>("article")];
    const target = cards.find((card) => card.textContent?.includes("فیش فشردهٔ ۵۸ میلی‌متری"));
    expect(target).toBeTruthy();
    await waitFor(() => expect((within(target!).getByRole("button", { name: "انتخاب قالب" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(target!).getByRole("button", { name: "انتخاب قالب" }));
    await waitFor(() => expect(putBodyOf("receipt")).toMatchObject({ templateKey: "thermal58-receipt" }));
    expect(putBodyOf("receipt").templateId).toBeUndefined();
    expect(printTemplateSampleMock).not.toHaveBeenCalled();
  });
});

describe("Template gallery — sample price units", () => {
  function samplePrice(templateKey: string, industry: Industry, unit: "toman" | "rial"): string {
    const template = BUILT_IN_TEMPLATES.find((candidate) => candidate.key === templateKey);
    if (!template) throw new Error(`Missing built-in template fixture: ${templateKey}`);
    const field = sampleForTemplate(template, samplePrintDocument({}, { unit }), industry)
      .labelFields?.find((item) => item.label === "قیمت نمونه");
    if (!field) throw new Error(`No sample-price label for template: ${templateKey}`);
    return field.value;
  }

  it("formats every hard-coded Rial sample amount in Toman when selected", () => {
    expect([
      samplePrice("a4-invoice-jewelry", "jewelry", "toman"),
      samplePrice("label57x40-label", "wholesale", "toman"),
      samplePrice("a4-invoice", "wholesale", "toman"),
    ]).toEqual(["۸٬۴۰۰٬۰۰۰ تومان", "۱۲۵٬۰۰۰ تومان", "۳۶۵٬۰۰۰ تومان"]);
  });

  it("formats every hard-coded Rial sample amount in Rial when selected", () => {
    expect([
      samplePrice("a4-invoice-jewelry", "jewelry", "rial"),
      samplePrice("label57x40-label", "wholesale", "rial"),
      samplePrice("a4-invoice", "wholesale", "rial"),
    ]).toEqual(["۸۴٬۰۰۰٬۰۰۰ ریال", "۱٬۲۵۰٬۰۰۰ ریال", "۳٬۶۵۰٬۰۰۰ ریال"]);
  });
});

describe("Rules screen — printers", () => {
  it("filters unsupported document types for the active business and offers only physically compatible printers", async () => {
    await openRules();
    const selects = printerSelects();
    expect(selects).toHaveLength(3);
    const receiptOptions = optionTexts(selects[0]);
    expect(receiptOptions.some((label) => label.includes("صندوق"))).toBe(true);
    expect(receiptOptions.some((label) => label.includes("A4 اداری"))).toBe(false);
    expect(receiptOptions.some((label) => label.includes("آشپزخانه"))).toBe(false);

    // Food-service branches do not get barcode labels or WooCommerce rules.
    expect(screen.queryByText("برچسب")).toBeNull();
    expect(screen.queryByText("برچسب ارسال")).toBeNull();
    expect(screen.queryByText("فاکتور سفارش آنلاین")).toBeNull();
    expect(screen.queryByText(/چاپگر سازگاری برای این نوع سند ثبت نشده است/)).toBeNull();
  });

  it("never offers the primary printer as its own fallback", async () => {
    await openRules();
    const fallbacks = fallbackSelects();
    expect(fallbacks).toHaveLength(3);
    const receiptFallback = optionTexts(fallbacks[0]);
    expect(receiptFallback[0]).toBe("بدون جانشین");
    expect(receiptFallback.some((label) => label.includes("صندوق"))).toBe(false);
  });

  it("clears fallback_printer_id when switching primary printer to automatic («انتخاب خودکار») and handles stale automatic rules", async () => {
    const backupReceiptPrinter: PrinterRow = {
      ...RECEIPT_PRINTER,
      id: "p-receipt-backup",
      name: "صندوق پشتیبان",
      is_default: false,
    };
    apiMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (url === "/api/settings/print-rules" && init?.method === "PUT") return { ok: true, data: {} };
      if (url === "/api/settings/print-rules") {
        return {
          ok: true,
          data: {
            rules: [
              {
                document_type: "receipt",
                template_key: null,
                template_id: "tpl-1",
                printer_id: "p-receipt",
                fallback_printer_id: "p-receipt-backup",
              },
              {
                document_type: "kitchen",
                template_key: "thermal80-kitchen",
                template_id: null,
                printer_id: null,
                fallback_printer_id: "p-kitchen",
              },
            ],
            resolved: RESOLVED,
            supportedDocumentTypes: FOOD_SERVICE_DOCUMENT_TYPES,
          },
        };
      }
      if (url === "/api/settings/printers") {
        return {
          ok: true,
          data: { printers: [RECEIPT_PRINTER, backupReceiptPrinter, KITCHEN_PRINTER, A4_PRINTER] },
        };
      }
      if (url === "/api/settings/print-templates") return { ok: true, data: { templates: [savedTemplate()], builtIns: FOOD_SERVICE_BUILT_INS, unavailableTemplates: [], industry: "food_service" } };
      if (url === "/api/printing/jobs") return { ok: true, data: { jobs: [] } };
      if (url === "/api/settings/business") return { ok: true, data: { business: { name: "کافه تست" }, location: null, profile: null } };
      if (url === "/api/settings/business/logo") return { ok: true, data: { logo: null } };
      return { ok: true, data: {} };
    });

    await openRules();
    const primaries = printerSelects();
    const fallbacks = fallbackSelects();

    // Initially receipt has fixed primary and fallback configured:
    expect(primaries[0].value).toBe("p-receipt");
    expect(fallbacks[0].value).toBe("p-receipt-backup");
    expect(fallbacks[0].disabled).toBe(false);

    // Stale kitchen rule with printer_id: null and fallback_printer_id: "p-kitchen"
    // is normalized in the UI so fallback is cleared and disabled:
    expect(primaries[1].value).toBe("");
    expect(fallbacks[1].value).toBe("");
    expect(fallbacks[1].disabled).toBe(true);

    // Switching receipt primary to «انتخاب خودکار» clears and disables fallback:
    fireEvent.change(primaries[0], { target: { value: "" } });
    expect(primaries[0].value).toBe("");
    expect(fallbacks[0].value).toBe("");
    expect(fallbacks[0].disabled).toBe(true);

    fireEvent.click(screen.getAllByRole("button", { name: "ذخیره" })[0]);
    await waitFor(() =>
      expect(putBodyOf("receipt")).toMatchObject({
        documentType: "receipt",
        templateId: "tpl-1",
        printerId: null,
        fallbackPrinterId: null,
      }),
    );
  });

  it("prints a sample on the operational path, pinned to the rule's own template", async () => {
    await openRules();
    fireEvent.click(screen.getAllByRole("button", { name: "چاپ نمونه روی همین مسیر" })[0]);
    await waitFor(() => expect(printTemplateSampleMock).toHaveBeenCalledWith({ id: "tpl-1", docType: "receipt" }));
    expect(await screen.findByText("نمونه از همان مسیر چاپ واقعی ارسال شد.")).toBeTruthy();
  });

  it("tells the operator what to do when the local print service is missing", async () => {
    printTemplateSampleMock.mockResolvedValue({ ok: false, error: "connector_not_installed" });
    await openRules();
    fireEvent.click(screen.getAllByRole("button", { name: "چاپ نمونه روی همین مسیر" })[0]);
    expect(await screen.findByText(/سرویس چاپ را از تب «چاپگرها» نصب کنید/)).toBeTruthy();
  });

  it("shows linked attempts, routing reason, fallback origin, template revision, and spooler-handoff vs physical-output semantics in recent activity", async () => {
    apiMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (url === "/api/settings/print-rules" && init?.method === "PUT") return { ok: true, data: {} };
      if (url === "/api/settings/print-rules") return { ok: true, data: { rules: RULES, resolved: RESOLVED, supportedDocumentTypes: FOOD_SERVICE_DOCUMENT_TYPES } };
      if (url === "/api/settings/printers") return { ok: true, data: { printers: [RECEIPT_PRINTER, KITCHEN_PRINTER, A4_PRINTER] } };
      if (url === "/api/settings/print-templates") return { ok: true, data: { templates: [savedTemplate()], builtIns: FOOD_SERVICE_BUILT_INS, unavailableTemplates: [], industry: "food_service" } };
      if (url === "/api/printing/jobs") {
        return {
          ok: true,
          data: {
            jobs: [
              {
                id: "job-2",
                documentType: "receipt",
                status: "handed_off",
                errorCode: null,
                deliveryOutcome: "handed_off",
                routeReason: "runtime_fallback",
                attemptNumber: 2,
                previousJobId: "job-1",
                printerName: "صندوق پشتیبان",
                fallbackFromPrinterName: "صندوق",
                templateName: "قالب سفارشی من",
                templateKey: "tpl-1",
                templateVersion: 3,
                printRequestId: "receipt:order-1",
                when: "۱۴۰۴/۱۰/۲۵ ۱۰:۰۰",
              },
              {
                id: "job-1",
                documentType: "receipt",
                status: "failed",
                errorCode: "printer_offline",
                deliveryOutcome: "not_delivered",
                routeReason: "rule",
                attemptNumber: 1,
                previousJobId: null,
                printerName: "صندوق",
                fallbackFromPrinterName: null,
                templateName: "قالب سفارشی من",
                templateKey: "tpl-1",
                templateVersion: 3,
                printRequestId: "receipt:order-1",
                when: "۱۴۰۴/۱۰/۲۵ ۱۰:۰۰",
              },
            ],
          },
        };
      }
      if (url === "/api/settings/business") return { ok: true, data: { business: { name: "کافه تست" }, location: null, profile: null } };
      if (url === "/api/settings/business/logo") return { ok: true, data: { logo: null } };
      return { ok: true, data: {} };
    });

    await openRules();
    const text = bodyText();
    expect(text).toContain("تحویل به صف سیستم‌عامل یا درگاه شبکه انجام شده است و به‌تنهایی خروج فیزیکی کاغذ را تضمین نمی‌کند");
    expect(text).toContain("تلاش ۲ (مرتبط با تلاش ۱)");
    expect(text).toContain("تلاش ۱");
    expect(text).toContain("(جانشین «صندوق»)");
    expect(text).toContain("مسیر: چاپگر جانشین (تلاش مجدد خودکار)");
    expect(text).toContain("قالب سفارشی من · نسخهٔ ۳ (v۳)");
    expect(text).toContain("تحویل به صف سیستم‌عامل (خروجی کاغذ بررسی شود)");
    expect(text).toContain("عدم تحویل پیش از ارسال");
  });

  it("does not display intentional reprints sharing printRequestId as linked fallback attempts, and shows ambiguous/historical labels", async () => {
    apiMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (url === "/api/settings/print-rules" && init?.method === "PUT") return { ok: true, data: {} };
      if (url === "/api/settings/print-rules") return { ok: true, data: { rules: RULES, resolved: RESOLVED, supportedDocumentTypes: FOOD_SERVICE_DOCUMENT_TYPES } };
      if (url === "/api/settings/printers") return { ok: true, data: { printers: [RECEIPT_PRINTER, KITCHEN_PRINTER, A4_PRINTER] } };
      if (url === "/api/settings/print-templates") return { ok: true, data: { templates: [savedTemplate()], builtIns: FOOD_SERVICE_BUILT_INS, unavailableTemplates: [], industry: "food_service" } };
      if (url === "/api/printing/jobs") {
        return {
          ok: true,
          data: {
            jobs: [
              {
                id: "reprint-2",
                documentType: "receipt",
                status: "handed_off",
                errorCode: null,
                deliveryOutcome: "handed_off",
                routeReason: "unknown",
                attemptNumber: 1,
                previousJobId: null,
                printerName: "صندوق",
                fallbackFromPrinterName: null,
                templateName: "رسید",
                templateKey: "receipt-standard",
                templateVersion: 1,
                printRequestId: "receipt:order-99",
                when: "۱۴۰۴/۱۰/۲۵ ۱۰:۰۵",
              },
              {
                id: "reprint-1",
                documentType: "receipt",
                status: "failed",
                errorCode: "job_timeout",
                deliveryOutcome: "ambiguous",
                routeReason: "rule",
                attemptNumber: 1,
                previousJobId: null,
                printerName: "صندوق",
                fallbackFromPrinterName: null,
                templateName: "رسید",
                templateKey: "receipt-standard",
                templateVersion: 1,
                printRequestId: "receipt:order-99",
                when: "۱۴۰۴/۱۰/۲۵ ۱۰:۰۰",
              },
            ],
          },
        };
      }
      if (url === "/api/settings/business") return { ok: true, data: { business: { name: "کافه تست" }, location: null, profile: null } };
      if (url === "/api/settings/business/logo") return { ok: true, data: { logo: null } };
      return { ok: true, data: {} };
    });

    await openRules();
    const text = bodyText();
    expect(text).not.toContain("تلاش ۲");
    expect(text).not.toContain("مرتبط با تلاش ۱");
    expect(text).toContain("مسیر: نامشخص (تاریخی)");
    expect(text).toContain("وضعیت تحویل نامشخص — بدون ارسال مجدد خودکار (بررسی چاپگر و چاپ مجدد دستی لازم است)");
  });
});

/* ── the add-printer wizard ───────────────────────────────────────────── */

describe("Add-printer wizard — hardware only", () => {
  function openEditing(printer: PrinterRow) {
    render(<AddPrinterDialog open onOpenChange={() => undefined} editing={printer} onSaved={() => undefined} />);
  }

  it("offers all four purposes for a Windows queue, and no template control", async () => {
    openEditing({ ...RECEIPT_PRINTER, id: "p-new", name: "چاپگر" });
    await screen.findByText("کاربرد این چاپگر");
    for (const label of ["رسید مشتری", "بلیت آشپزخانه", "فاکتور (A4/A5)", "برچسب"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    // Hardware only: no select of any kind, no picker of any kind.
    expect(document.querySelector("select")).toBeNull();
    expect(bodyText()).toContain("ظاهر چاپ در «قالب‌ها» و مسیر چاپ هر سند در «قوانین چاپ» تعیین می‌شود");
  });

  it("follows the purpose with its own papers and never keeps a stale one", async () => {
    openEditing({ ...RECEIPT_PRINTER, id: "p-new", name: "چاپگر" });
    await screen.findByText("کاربرد این چاپگر");

    // Receipt ⇒ rolls.
    expect(screen.getByText("فیش حرارتی ۸۰ میلی‌متری")).toBeTruthy();
    expect(screen.queryByText("کاغذ A4")).toBeNull();

    // Invoice ⇒ sheets, and the receipt roll is gone rather than silently kept.
    fireEvent.click(screen.getByText("فاکتور (A4/A5)"));
    expect(screen.getByText("کاغذ A4")).toBeTruthy();
    expect(screen.queryByText("فیش حرارتی ۸۰ میلی‌متری")).toBeNull();

    // Label ⇒ the label roll.
    fireEvent.click(screen.getByText("برچسب"));
    expect(screen.getByText("برچسب ۵۷×۴۰ میلی‌متر")).toBeTruthy();
    expect(screen.queryByText("کاغذ A4")).toBeNull();
  });

  it("blocks A4/A5 over a network target — page jobs go through the Windows driver", async () => {
    openEditing({
      ...RECEIPT_PRINTER,
      id: "p-net",
      name: "چاپگر شبکه",
      kind: "document",
      printer_class: "page",
      paper: "a4",
      connection: { type: "network", ip: "10.0.0.9", port: 9100 },
    });
    expect(await screen.findByText(/فقط از طریق صف ویندوز چاپ می‌شود/)).toBeTruthy();
    const save = screen.getByRole("button", { name: /چاپ آزمایشی و ذخیره|ذخیرهٔ چاپگر/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("shows the cash drawer toggle for a receipt printer only", async () => {
    openEditing(KITCHEN_PRINTER);
    await screen.findByText("کاربرد این چاپگر");
    expect(screen.queryByText(/بازکردن کشوی پول/)).toBeNull();

    cleanup();
    openEditing(RECEIPT_PRINTER);
    await screen.findByText("کاربرد این چاپگر");
    expect(screen.getByText(/بازکردن کشوی پول/)).toBeTruthy();
  });
});
