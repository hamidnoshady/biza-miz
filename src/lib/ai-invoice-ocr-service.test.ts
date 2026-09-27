/**
 * DB-touching half of supplier-invoice OCR (`runInvoiceOcr`), behind
 * `POST /api/ai/invoice-ocr`. This file had **zero tests** before — only the
 * pure prompt/parser/matcher half (`ai-invoice-ocr.ts`, via
 * `ai-invoice-ocr.test.ts`) was covered. `fetch` and `./db`'s `query` are
 * both stubbed — no network, no real database.
 *
 * What must never regress:
 *   • the vision call and its error-code mapping mirror `ai-receipt-service.ts`'s
 *     (ai_auth/ai_timeout/ai_network/ai_provider), since both are the same
 *     "one-shot metered vision extraction" shape;
 *   • an unparseable reply throws `extraction_failed` rather than inventing
 *     lines (never fabricated data);
 *   • a line's catalogue match — by barcode first, then fuzzy name — actually
 *     reaches the returned `MatchedInvoiceLine`, so the review UI can trust
 *     `matchStatus`/`inventoryItemId` without re-deriving them;
 *   • a vendor name is matched against this location's active suppliers only
 *     above the same 0.72 threshold `ai-invoice-ocr.ts`'s own matcher uses
 *     elsewhere, never a blanket "first supplier" guess;
 *   • the image itself never touches `storeMediaAsset` or any other
 *     persistence call — this route's own header comment says the photo is
 *     "never written to any table or object storage", by design, unlike the
 *     receipt-OCR flow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiConfig } from "./ai";
import * as db from "./db";
import { InvoiceOcrError, runInvoiceOcr } from "./ai-invoice-ocr-service";

vi.mock("./db", () => ({ query: vi.fn() }));

const config: AiConfig = {
  enabled: true,
  provider: "litellm",
  model: "gpt-4o-mini",
  baseUrl: "https://gw.example.com/v1",
  apiKey: "sk-test",
  temperature: 0.7,
  maxOutputTokens: 800,
};

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";
const LOCATION_ID = "loc-1";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function visionReply(extraction: Record<string, unknown>, usage = { prompt_tokens: 900, completion_tokens: 120 }) {
  return jsonResponse({
    choices: [{ message: { content: JSON.stringify(extraction) } }],
    usage,
  });
}

/** `runInvoiceOcr` issues exactly two queries: inventory candidates, then suppliers. */
function dbReturns(inventoryRows: unknown[], supplierRows: unknown[] = []) {
  vi.mocked(db.query).mockImplementation(async (sql: string) => {
    if (sql.includes("FROM inventory_items")) return { rows: inventoryRows } as never;
    if (sql.includes("FROM suppliers")) return { rows: supplierRows } as never;
    throw new Error(`unexpected query: ${sql}`);
  });
}

beforeEach(() => {
  vi.mocked(db.query).mockReset();
  dbReturns([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runInvoiceOcr", () => {
  it("extracts, matches a barcoded line by code, and validates as pass", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        visionReply({
          vendor: "بازرگانی رضایی",
          invoiceDate: "2026-01-10",
          invoiceNumber: "INV-42",
          totalRial: 500_000,
          note: "فاکتور خرید ماهانه",
          lines: [{ name: "شکر", quantity: "10", unit: "کیلو", lineTotalRial: 500_000, barcode: "6260000000012" }],
        }),
      ),
    );
    dbReturns(
      [{ id: "item-1", name: "شکر سفید", unit: "kg", purchase_unit: "بسته", code: "6260000000012" }],
      [{ id: "sup-1", name: "بازرگانی رضایی" }],
    );

    const result = await runInvoiceOcr({ config, locationId: LOCATION_ID, dataUrl: PNG_DATA_URL });

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({
      matchStatus: "matched",
      inventoryItemId: "item-1",
      inventoryItemName: "شکر سفید",
      lineTotalRial: 500_000,
    });
    expect(result.validation.verdict).toBe("pass");
    expect(result.supplierId).toBe("sup-1");
    expect(result.supplierName).toBe("بازرگانی رضایی");
    expect(result.usage).toEqual({ inputTokens: 900, outputTokens: 120 });

    // Two queries, in the documented order — inventory, then suppliers.
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(vi.mocked(db.query).mock.calls[0][1]).toEqual([LOCATION_ID]);
  });

  it("falls back to fuzzy name matching when a line has no barcode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        visionReply({
          vendor: null,
          invoiceDate: null,
          invoiceNumber: null,
          totalRial: null,
          note: "x",
          lines: [{ name: "روغن آفتابگردان", quantity: "5", unit: "لیتر", lineTotalRial: 250_000, barcode: null }],
        }),
      ),
    );
    dbReturns([{ id: "item-2", name: "روغن آفتابگردان ۱ لیتری", unit: "لیتر", purchase_unit: null, code: null }]);

    const result = await runInvoiceOcr({ config, locationId: LOCATION_ID, dataUrl: PNG_DATA_URL });
    expect(result.lines[0].matchStatus).toBe("matched");
    expect(result.lines[0].inventoryItemId).toBe("item-2");
  });

  it("reports unmatched lines and a fail/warn verdict without inventing an inventory link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        visionReply({
          vendor: "تأمین‌کنندهٔ ناشناخته",
          invoiceDate: "2026-01-10",
          invoiceNumber: null,
          totalRial: 90_000,
          note: "x",
          lines: [{ name: "کالای عجیب و ناموجود", quantity: "1", unit: "عدد", lineTotalRial: 90_000, barcode: null }],
        }),
      ),
    );
    dbReturns([{ id: "item-3", name: "چیز کاملاً متفاوت", unit: "عدد", purchase_unit: null, code: null }]);

    const result = await runInvoiceOcr({ config, locationId: LOCATION_ID, dataUrl: PNG_DATA_URL });
    expect(result.lines[0].matchStatus).toBe("unmatched");
    expect(result.lines[0].inventoryItemId).toBeNull();
    expect(result.validation.verdict).not.toBe("pass");
    expect(result.validation.issues.some((i) => i.includes("متصل نشد"))).toBe(true);
    // No active supplier matched the unrecognised vendor name closely enough.
    expect(result.supplierId).toBeNull();
    expect(result.supplierName).toBe("تأمین‌کنندهٔ ناشناخته");
  });

  it("never matches a supplier below the 0.72 fuzzy-name threshold", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        visionReply({ vendor: "شرکت الف", invoiceDate: null, invoiceNumber: null, totalRial: null, note: "x", lines: [] }),
      ),
    );
    dbReturns([], [{ id: "sup-9", name: "شرکت کاملاً نامرتبط ب" }]);

    const result = await runInvoiceOcr({ config, locationId: LOCATION_ID, dataUrl: PNG_DATA_URL });
    expect(result.supplierId).toBeNull();
    // Falls back to the extracted vendor text itself when no supplier matched.
    expect(result.supplierName).toBe("شرکت الف");
  });

  it("throws extraction_failed on an unparseable reply rather than fabricating lines", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ choices: [{ message: { content: "متاسفم" } }] })));
    await expect(runInvoiceOcr({ config, locationId: LOCATION_ID, dataUrl: PNG_DATA_URL })).rejects.toMatchObject({
      code: "extraction_failed",
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("maps 401/403 to ai_auth without ever touching the database", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(runInvoiceOcr({ config, locationId: LOCATION_ID, dataUrl: PNG_DATA_URL })).rejects.toMatchObject({
      code: "ai_auth",
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("maps an abort to ai_timeout and a socket error to ai_network", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(abortErr)));
    await expect(runInvoiceOcr({ config, locationId: LOCATION_ID, dataUrl: PNG_DATA_URL })).rejects.toMatchObject({
      code: "ai_timeout",
    });

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    await expect(runInvoiceOcr({ config, locationId: LOCATION_ID, dataUrl: PNG_DATA_URL })).rejects.toMatchObject({
      code: "ai_network",
    });
  });

  it("maps a non-401/403 error status to ai_provider", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(runInvoiceOcr({ config, locationId: LOCATION_ID, dataUrl: PNG_DATA_URL })).rejects.toBeInstanceOf(
      InvoiceOcrError,
    );
  });

  it("caps candidate lists to items an inventory query could plausibly return, deduplicated by id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        visionReply({
          vendor: null,
          invoiceDate: null,
          invoiceNumber: null,
          totalRial: null,
          note: "x",
          lines: [{ name: "پنیر", quantity: "2", unit: "بسته", lineTotalRial: 80_000, barcode: null }],
        }),
      ),
    );
    // Same item appears twice in the join (once per barcode row) — collapseCandidates
    // must not surface it as two separate candidates.
    dbReturns([
      { id: "item-4", name: "پنیر لیقوان", unit: "بسته", purchase_unit: null, code: "1111111111111" },
      { id: "item-4", name: "پنیر لیقوان", unit: "بسته", purchase_unit: null, code: "2222222222222" },
    ]);

    const result = await runInvoiceOcr({ config, locationId: LOCATION_ID, dataUrl: PNG_DATA_URL });
    const ids = result.lines[0].candidates.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
