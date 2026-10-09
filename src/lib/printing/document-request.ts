/**
 * What a caller may ask the print endpoint for — parsed and validated, once.
 *
 * The contract is deliberately narrow, and it is the printing audit's central
 * change: **the browser names a stored document, it does not ship one.**
 *
 *     { document: { kind: "order-receipt", orderId: "…" }, documentType: "receipt" }
 *
 * The server then loads that order in the caller's own branch, builds the
 * receipt from its rows (printing/order-print-data.ts, or the retail
 * invoice's own builder for a retail sale) and renders it. A document is
 * therefore never a claim the client makes about money, items, prices or the
 * branch letterhead.
 *
 * Two things this module refuses outright:
 *
 *   - **a data payload for a persisted document.** A `receipt`, `kitchen-ticket`
 *     or `label` job built in the browser is the pre-audit path; it is refused
 *     with `document_required` rather than silently trusted or silently
 *     ignored. Every screen in the product was moved to a document reference in
 *     the same change; the only way to reach this branch is a browser tab that
 *     has been open across the deployment, and reloading it fixes it (the error
 *     says so in Persian);
 *   - **anything not strictly shaped.** Ids must be uuids, `documentType` a
 *     known type, strings bounded. This is what keeps a malformed uuid from
 *     reaching Postgres as an `invalid input syntax for type uuid` 500 — the
 *     route's job is to answer 400, not to explain a driver error.
 *
 * Sample jobs (`test`, `drawer-kick`) have no stored document to name: a test
 * print is the product's own sample document and a drawer kick carries no
 * content at all. They stay, and they are the whole remaining `job` surface.
 */
import type { DocType } from "../print-template";
import type { PrinterErrorCode } from "./errors";
import { MAX_PRINT_REQUEST_ID, isDocType } from "./routing";

/** The kinds of stored document a caller may name. */
export const PRINT_DOCUMENT_KINDS = ["order-receipt", "kitchen-ticket", "item-label"] as const;
export type PrintDocumentKind = (typeof PRINT_DOCUMENT_KINDS)[number];

export interface PrintDocumentRef {
  kind: PrintDocumentKind;
  /** `order-receipt` and `kitchen-ticket`: the sale's order id. */
  orderId?: string;
  /** `item-label`: the item the label documents. */
  itemId?: string;
  /** `item-label`: the exact barcode value to print; omitted means the item's own code. */
  code?: string;
}

export type PrintSampleJob = { type: "test"; kind: DocType } | { type: "drawer-kick" };

export type PrintRequestSource =
  | { kind: "document"; document: PrintDocumentRef }
  | { kind: "sample"; job: PrintSampleJob };

export interface ParsedPrintRequest {
  ok: true;
  printerId: string | null;
  templateId: string | null;
  printRequestId: string | null;
  /** The document type the caller asked for; null means "the kind's own default". */
  documentType: DocType | null;
  source: PrintRequestSource;
}

export type PrintRequestError = PrinterErrorCode | "bad_request";

export interface PrintRequestFailure {
  ok: false;
  status: number;
  error: PrintRequestError;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A barcode as stored: digits, or the letters a supplier code may carry. */
const BARCODE = /^[0-9A-Za-z-]{1,64}$/;
/** Opaque correlation ids the screens mint (`receipt:{orderId}`, `reprint:invoice:{uuid}`). */
const REQUEST_ID = new RegExp("^[\\x20-\\x7E]{1," + MAX_PRINT_REQUEST_ID + "}$");

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function id(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

function badRequest(): PrintRequestFailure {
  return { ok: false, status: 400, error: "bad_request" };
}

export function parsePrintRequest(body: unknown): ParsedPrintRequest | PrintRequestFailure {
  if (!isRecord(body)) return badRequest();

  // Hardware ids the caller may name: resolved against the caller's own
  // branch, so an id from anywhere else simply does not resolve.
  const printerId = body.printerId == null ? null : id(body.printerId);
  const templateId = body.templateId == null ? null : id(body.templateId);
  if ((body.printerId != null && !printerId) || (body.templateId != null && !templateId)) return badRequest();

  const documentType = body.documentType == null ? null : body.documentType;
  if (documentType !== null && !isDocType(documentType)) return badRequest();

  const printRequestId = body.printRequestId == null ? null : body.printRequestId;
  if (printRequestId !== null && (typeof printRequestId !== "string" || !REQUEST_ID.test(printRequestId))) {
    return badRequest();
  }

  const source = parseSource(body);
  if (!source) return badRequest();
  if ("ok" in source) return source;

  return { ok: true, printerId, templateId, printRequestId, documentType, source };
}

function parseSource(body: Record<string, unknown>): PrintRequestSource | PrintRequestFailure | null {
  if (body.document != null) {
    if (body.job != null) return badRequest();
    return parseDocument(body.document);
  }
  if (body.job == null) return null;
  return parseLegacyJob(body.job);
}

function parseDocument(raw: unknown): PrintRequestSource | PrintRequestFailure {
  if (!isRecord(raw)) return badRequest();
  const kind = raw.kind;
  if (!PRINT_DOCUMENT_KINDS.includes(kind as PrintDocumentKind)) return badRequest();

  if (kind === "item-label") {
    const itemId = id(raw.itemId);
    if (!itemId) return badRequest();
    const code = raw.code == null ? null : raw.code;
    if (code !== null && (typeof code !== "string" || !BARCODE.test(code))) return badRequest();
    const document: PrintDocumentRef = { kind, itemId };
    if (code) document.code = code;
    return { kind: "document", document };
  }

  const orderId = id(raw.orderId);
  if (!orderId) return badRequest();
  return { kind: "document", document: { kind: kind as PrintDocumentKind, orderId } };
}

/**
 * The only `job` shapes that still exist: the product's own sample document and
 * a drawer kick. Everything else is a document, and a document is named by
 * reference — see this module's header.
 */
function parseLegacyJob(raw: unknown): PrintRequestSource | PrintRequestFailure {
  if (!isRecord(raw)) return badRequest();
  if (raw.type === "drawer-kick") return { kind: "sample", job: { type: "drawer-kick" } };
  if (raw.type === "test") {
    if (!isDocType(raw.kind)) return badRequest();
    return { kind: "sample", job: { type: "test", kind: raw.kind } };
  }
  if (raw.type === "receipt" || raw.type === "kitchen-ticket" || raw.type === "label") {
    return { ok: false, status: 400, error: "document_required" };
  }
  return badRequest();
}

/** The document type a stored document prints as when the caller does not say. */
export function defaultDocumentTypeFor(document: PrintDocumentRef): DocType {
  switch (document.kind) {
    case "order-receipt":
      return "receipt";
    case "kitchen-ticket":
      return "kitchen";
    case "item-label":
      return "label";
  }
}

/**
 * Which document types a stored document may be printed as. A sale's data is
 * one document with two formal shapes — the thermal customer receipt and the
 * A4/A5 invoice — and the caller picks one explicitly (the two named buttons
 * in the invoice modal); a kitchen ticket is only ever a kitchen ticket, and a
 * label only ever a label. Nothing here infers intent from the screen that
 * happened to be open.
 */
export function documentTypesFor(document: PrintDocumentRef): DocType[] {
  switch (document.kind) {
    case "order-receipt":
      return ["receipt", "invoice"];
    case "kitchen-ticket":
      return ["kitchen"];
    case "item-label":
      return ["label"];
  }
}
