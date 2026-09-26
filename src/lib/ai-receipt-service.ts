/**
 * Standalone (non-chat) receipt OCR for Accounting's direct "upload a photo of
 * a receipt" flow — `POST /api/ai/receipt-ocr`.
 *
 * This is a SIBLING of two things that already existed, not a replacement for
 * either:
 *   - `ai-receipt.ts` — the pure prompt/parser pair
 *     (`RECEIPT_EXTRACTION_SYSTEM_PROMPT`/`parseReceiptExtractionReply`) the
 *     AI Chat assistant's `draft_expense_from_receipt` tool already uses
 *     (`ai-service.ts`'s private `extractReceiptDraft`). Both callers share
 *     the exact same prompt and parser — there is exactly one definition of
 *     "what a receipt-extraction JSON reply looks like" in this codebase, not
 *     two independently-drifting ones.
 *   - `ai-invoice-ocr-service.ts` — the sibling supplier-invoice OCR service.
 *     Both now call the same `runAiVisionExtraction` (`ai-vision-extraction.ts`)
 *     for the actual provider request/timeout/error-mapping shell, extracted
 *     this session because the two services had hand-duplicated it byte-for-
 *     byte; only the prompt pair, timeout, and token ceiling ever differed.
 *
 * What's actually new here: unlike both `ai-service.ts`'s chat-turn call and
 * the standalone invoice-ocr route ("the image is a one-shot data URL — never
 * persisted"), the route built on top of this module DOES persist the
 * receipt photo into the canonical Media Library after a successful
 * extraction — closing the "OCR inputs" gap named in MEDIA_LIBRARY_REPORT.md
 * Section V. This module itself stays storage-agnostic (no `media-service.ts`
 * import) — persistence is the route's job, exactly like `runMediaEnhance`
 * only returns bytes and lets its route call `storeMediaAsset`.
 */

import type { AiConfig } from "./ai";
import type { AiTokenUsage } from "./ai-billing";
import {
  RECEIPT_EXTRACTION_SYSTEM_PROMPT,
  RECEIPT_EXTRACTION_USER_PROMPT,
  parseReceiptExtractionReply,
  type ReceiptDraftFields,
} from "./ai-receipt";
import { runAiVisionExtraction } from "./ai-vision-extraction";

const REQUEST_TIMEOUT_MS = 60_000;
const MIN_OUTPUT_TOKENS = 1024;

export class ReceiptOcrError extends Error {
  constructor(
    public code: string,
    message: string,
    public detail?: string,
  ) {
    super(message);
    this.name = "ReceiptOcrError";
  }
}

export interface ReceiptOcrResult {
  fields: ReceiptDraftFields;
  usage: AiTokenUsage;
  costUsd: number | null;
}

/**
 * One isolated, non-streaming, tool-less vision call. Throws `ReceiptOcrError`
 * on a provider/network/timeout failure or an unparseable reply — the caller
 * settles the wallet only when this resolves, never on a throw.
 */
export async function runReceiptOcr(input: { config: AiConfig; dataUrl: string }): Promise<ReceiptOcrResult> {
  const { text, usage, costUsd } = await runAiVisionExtraction({
    config: input.config,
    systemPrompt: RECEIPT_EXTRACTION_SYSTEM_PROMPT,
    userPrompt: RECEIPT_EXTRACTION_USER_PROMPT,
    dataUrl: input.dataUrl,
    timeoutMs: REQUEST_TIMEOUT_MS,
    minOutputTokens: MIN_OUTPUT_TOKENS,
    createError: (code, message, detail) => new ReceiptOcrError(code, message, detail),
  });

  const fields = parseReceiptExtractionReply(text);
  if (!fields) {
    throw new ReceiptOcrError(
      "extraction_failed",
      "استخراج اطلاعات از تصویر رسید ممکن نشد. تصویر واضح‌تری بگیرید یا مقادیر را دستی وارد کنید.",
    );
  }

  return { fields, usage, costUsd };
}
