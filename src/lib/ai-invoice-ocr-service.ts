/**
 * DB-touching half of supplier-invoice OCR: call the vision model, match
 * extracted lines against this branch's inventory (by barcode then by name),
 * and run the pure validator. The image never leaves this request.
 */

import type { AiConfig } from "./ai";
import type { AiTokenUsage } from "./ai-billing";
import {
  INVOICE_EXTRACTION_SYSTEM_PROMPT,
  INVOICE_EXTRACTION_USER_PROMPT,
  parseInvoiceExtractionReply,
  pickBestInventoryMatch,
  scoreNameMatch,
  validateExtractedInvoice,
  type ExtractedInvoice,
  type InvoiceMatchStatus,
  type InvoiceValidationResult,
} from "./ai-invoice-ocr";
import { runAiVisionExtraction } from "./ai-vision-extraction";
import { query } from "./db";

const REQUEST_TIMEOUT_MS = 90_000;
const MIN_OUTPUT_TOKENS = 2048;

export interface MatchedInvoiceLine {
  /** Stable key for the review UI (index-based). */
  key: string;
  name: string;
  quantity: string | null;
  unit: string | null;
  lineTotalRial: number | null;
  barcode: string | null;
  confidence: number | null;
  matchStatus: InvoiceMatchStatus;
  matchScore: number;
  /** Set when matchStatus === "matched". */
  inventoryItemId: string | null;
  inventoryItemName: string | null;
  purchaseUnit: string | null;
  /** Candidates the operator can pick from when ambiguous/unmatched. */
  candidates: Array<{ id: string; name: string; unit: string; purchaseUnit: string | null }>;
}

export interface InvoiceOcrResult {
  extraction: ExtractedInvoice;
  lines: MatchedInvoiceLine[];
  validation: InvoiceValidationResult;
  /** Best-effort supplier id when vendor name matches an active supplier. */
  supplierId: string | null;
  supplierName: string | null;
  usage: AiTokenUsage;
  /**
   * Phase 38b — the gateway's own cost figure for the vision call (USD),
   * null when the responder did not report one. Settlement falls back to the
   * token rates without it.
   */
  costUsd: number | null;
}

/**
 * Thin wrapper over the shared `runAiVisionExtraction` (`ai-vision-extraction.ts`):
 * this service's own prompt pair, timeout, and token ceiling, mapped onto its
 * own `InvoiceOcrError` so every existing `instanceof InvoiceOcrError` check
 * (route, tests) keeps working unchanged.
 */
async function callVision(
  config: AiConfig,
  dataUrl: string,
): Promise<{ text: string; usage: AiTokenUsage; costUsd: number | null }> {
  return runAiVisionExtraction({
    config,
    systemPrompt: INVOICE_EXTRACTION_SYSTEM_PROMPT,
    userPrompt: INVOICE_EXTRACTION_USER_PROMPT,
    dataUrl,
    timeoutMs: REQUEST_TIMEOUT_MS,
    minOutputTokens: MIN_OUTPUT_TOKENS,
    createError: (code, message, detail) => new InvoiceOcrError(code, message, detail),
  });
}

export class InvoiceOcrError extends Error {
  constructor(
    public code: string,
    message: string,
    public detail?: string,
  ) {
    super(message);
    this.name = "InvoiceOcrError";
  }
}

interface InventoryCandidate {
  id: string;
  name: string;
  unit: string;
  purchase_unit: string | null;
  code: string | null;
}

async function loadInventoryCandidates(locationId: string): Promise<InventoryCandidate[]> {
  // One row per (item, code). Items without a barcode still appear once with
  // code=null so name matching can find them.
  const { rows } = await query<{
    id: string;
    name: string;
    unit: string;
    purchase_unit: string | null;
    code: string | null;
  }>(
    `SELECT i.id, i.name, i.unit, i.purchase_unit, b.code
       FROM inventory_items i
       LEFT JOIN inventory_item_barcodes b
         ON b.inventory_item_id = i.id AND b.location_id = i.location_id
      WHERE i.location_id = $1 AND i.is_active = true
      ORDER BY i.name`,
    [locationId],
  );
  return rows;
}

async function matchSupplier(
  locationId: string,
  vendor: string | null,
): Promise<{ id: string | null; name: string | null }> {
  if (!vendor) return { id: null, name: null };
  const { rows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM suppliers
      WHERE location_id = $1 AND is_active = true
      ORDER BY name`,
    [locationId],
  );
  if (rows.length === 0) return { id: null, name: null };

  let best: { id: string; name: string; score: number } | null = null;
  for (const row of rows) {
    const score = scoreNameMatch(vendor, row.name);
    if (!best || score > best.score) best = { id: row.id, name: row.name, score };
  }
  if (best && best.score >= 0.72) return { id: best.id, name: best.name };
  return { id: null, name: null };
}

function collapseCandidates(
  rows: InventoryCandidate[],
): Array<{ id: string; name: string; unit: string; purchaseUnit: string | null; code: string | null }> {
  const byId = new Map<
    string,
    { id: string; name: string; unit: string; purchaseUnit: string | null; code: string | null }
  >();
  const withCodes: Array<{
    id: string;
    name: string;
    unit: string;
    purchaseUnit: string | null;
    code: string | null;
  }> = [];

  for (const row of rows) {
    const shaped = {
      id: row.id,
      name: row.name,
      unit: row.unit,
      purchaseUnit: row.purchase_unit,
      code: row.code,
    };
    if (row.code) withCodes.push(shaped);
    if (!byId.has(row.id)) byId.set(row.id, { ...shaped, code: null });
  }
  return [...byId.values(), ...withCodes];
}

/**
 * Run one metered invoice OCR turn: vision extract → catalogue match → AI
 * validation summary. Throws InvoiceOcrError on provider/auth failures;
 * returns a structured fail validation when the model reply is empty.
 */
export async function runInvoiceOcr(input: {
  config: AiConfig;
  locationId: string;
  dataUrl: string;
}): Promise<InvoiceOcrResult> {
  const { text, usage, costUsd } = await callVision(input.config, input.dataUrl);
  const extraction = parseInvoiceExtractionReply(text);
  if (!extraction) {
    throw new InvoiceOcrError(
      "extraction_failed",
      "استخراج اطلاعات از تصویر فاکتور ممکن نشد. تصویر واضح‌تری بگیرید یا اقلام را دستی وارد کنید.",
    );
  }

  const inventoryRows = await loadInventoryCandidates(input.locationId);
  const catalogue = collapseCandidates(inventoryRows);

  const lines: MatchedInvoiceLine[] = extraction.lines.map((line, index) => {
    const picked = pickBestInventoryMatch(
      { name: line.name, barcode: line.barcode },
      catalogue,
    );
    const candidateList = (
      picked.status === "matched" && picked.item
        ? [picked.item, ...picked.candidates.filter((c) => c.id !== picked.item!.id)]
        : picked.candidates
    )
      .filter((c, i, arr) => arr.findIndex((x) => x.id === c.id) === i)
      .slice(0, 8)
      .map((c) => ({
        id: c.id,
        name: c.name,
        unit: c.unit,
        purchaseUnit: c.purchaseUnit,
      }));

    return {
      key: `line-${index}`,
      name: line.name,
      quantity: line.quantity,
      unit: line.unit,
      lineTotalRial: line.lineTotalRial,
      barcode: line.barcode,
      confidence: line.confidence,
      matchStatus: picked.status,
      matchScore: picked.score,
      inventoryItemId: picked.item?.id ?? null,
      inventoryItemName: picked.item?.name ?? null,
      purchaseUnit: picked.item?.purchaseUnit ?? picked.item?.unit ?? null,
      candidates: candidateList,
    };
  });

  const matchedLinesTotalRial = lines.reduce((sum, line) => {
    if (line.matchStatus !== "matched" || line.lineTotalRial == null) return sum;
    return sum + line.lineTotalRial;
  }, 0);

  const validation = validateExtractedInvoice({
    extraction,
    lines: lines.map((l) => ({
      name: l.name,
      quantity: l.quantity,
      unit: l.unit,
      lineTotalRial: l.lineTotalRial,
      barcode: l.barcode,
      confidence: l.confidence,
      matchStatus: l.matchStatus,
      matchedItemName: l.inventoryItemName,
      candidateCount: l.candidates.length,
    })),
    matchedLinesTotalRial: matchedLinesTotalRial > 0 ? matchedLinesTotalRial : null,
  });

  const supplier = await matchSupplier(input.locationId, extraction.vendor);

  return {
    extraction,
    lines,
    validation,
    supplierId: supplier.id,
    supplierName: supplier.name ?? extraction.vendor,
    usage,
    costUsd,
  };
}
