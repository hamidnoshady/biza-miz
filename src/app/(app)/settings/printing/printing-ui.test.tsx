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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PrintingManager } from "./printing-manager";
import { AddPrinterDialog } from "./add-printer-flow";
import type { PrinterRow, SavedTemplateRow } from "./use-printing";

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

function routeApi() {
  apiMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    if (url === "/api/settings/print-rules" && init?.method === "PUT") return { ok: true, data: {} };
    if (url === "/api/settings/print-rules") return { ok: true, data: { rules: RULES, resolved: RESOLVED } };
    if (url === "/api/settings/printers") return { ok: true, data: { printers: [RECEIPT_PRINTER, KITCHEN_PRINTER, A4_PRINTER] } };
    if (url === "/api/settings/print-templates") return { ok: true, data: { templates: [savedTemplate()] } };
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
  await screen.findByText("رسید فروش");
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

  it("shows what would actually print now, revision included, and says why nothing would", async () => {
    await openRules();
    expect(bodyText()).toContain("اکنون: قالب «قالب سفارشی من» (نسخهٔ ۳) روی «صندوق» — مسیر: قانون این سند");
    // The label rule has no printer: the screen says why instead of pretending.
    expect(bodyText()).toContain("اکنون چاپ نمی‌شود:");
  });

  it("sends the saved template as templateId and a built-in as templateKey", async () => {
    await openRules();
    const receiptSelect = templateSelects()[0];

    fireEvent.change(receiptSelect, { target: { value: "key:thermal58-receipt" } });
    fireEvent.click(screen.getAllByRole("button", { name: "ذخیره" })[0]);
    await waitFor(() => expect(putBodyOf("receipt")).toMatchObject({ templateId: null, templateKey: "thermal58-receipt" }));

    apiMock.mockClear();
    routeApi();
    fireEvent.change(receiptSelect, { target: { value: "id:tpl-1" } });
    fireEvent.click(screen.getAllByRole("button", { name: "ذخیره" })[0]);
    await waitFor(() => expect(putBodyOf("receipt")).toMatchObject({ templateId: "tpl-1", templateKey: null }));
  });
});

describe("Rules screen — printers", () => {
  it("offers only printers that can print that document type, and says when there is none", async () => {
    await openRules();
    const selects = printerSelects();
    expect(selects).toHaveLength(4);
    const receiptOptions = optionTexts(selects[0]);
    expect(receiptOptions.some((label) => label.includes("صندوق"))).toBe(true);
    expect(receiptOptions.some((label) => label.includes("A4 اداری"))).toBe(false);
    expect(receiptOptions.some((label) => label.includes("آشپزخانه"))).toBe(false);

    // The label rule has no compatible printer at all — the screen says so
    // instead of offering a bad choice.
    expect(screen.getAllByText(/چاپگر سازگاری برای این نوع سند ثبت نشده است/)).toHaveLength(1);
    const labelOptions = optionTexts(selects[3]);
    expect(labelOptions).toEqual(["انتخاب خودکار"]);
  });

  it("never offers the primary printer as its own fallback", async () => {
    await openRules();
    const fallbacks = fallbackSelects();
    expect(fallbacks).toHaveLength(4);
    const receiptFallback = optionTexts(fallbacks[0]);
    expect(receiptFallback[0]).toBe("بدون جانشین");
    expect(receiptFallback.some((label) => label.includes("صندوق"))).toBe(false);
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
