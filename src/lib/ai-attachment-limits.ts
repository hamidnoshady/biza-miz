/**
 * Shared attachment limits for the AI chat (Wave 5 extension).
 *
 * Pure constants, safe to import from both the browser bundle (composer
 * validation) and the server bundle (route validation) — no Node-only or
 * DOM-only code may live here. The image ceiling matches the original
 * receipt-photo flow (`MAX_RECEIPT_IMAGE_BYTES` in ai-receipt.ts); PDFs get
 * a larger one because a text invoice document is rarely a single photo.
 */

/** ~5MB of original file bytes: generous for a phone photo of a receipt. */
export const MAX_ATTACHMENT_IMAGE_BYTES = 5 * 1024 * 1024;

/** 10MB per PDF document. */
export const MAX_ATTACHMENT_PDF_BYTES = 10 * 1024 * 1024;

/** Small, UTF-8-only text/CSV files passed to the model with bounded text. */
export const MAX_ATTACHMENT_TEXT_BYTES = 1 * 1024 * 1024;

/** 5MB per Word/Excel file; the archive is also bounded once inflated (ai-office-extract.ts). */
export const MAX_ATTACHMENT_OFFICE_BYTES = 5 * 1024 * 1024;

/** How many attachments one message may carry. */
export const MAX_ATTACHMENTS = 4;

/**
 * Server-side ceiling on how much PDF text is handed to the model, so a huge
 * document can never silently inflate the turn. The model gets a truncation
 * note when this is hit.
 */
export const MAX_PDF_TEXT_CHARS = 24_000;

/** How many PDF pages are read before the rest is dropped. */
export const MAX_PDF_PAGES = 30;

/** A custom task description may not exceed this after sanitising. */
export const MAX_CUSTOM_TASK_CHARS = 400;
