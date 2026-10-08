/**
 * The browser's printing client — one hardware backend per surface.
 *
 * Two products, two ways to reach a printer, same `PrinterTarget` shape and
 * same canonical error codes either way:
 *
 *  - the browser/cloud product has no OS access of its own, so it hands the
 *    canonical bytes to the local Cafe POS Windows Print Connector on
 *    loopback — a small helper the operator installs once, which owns every
 *    printer the cashier's machine can reach (Windows queues and network TCP
 *    alike);
 *  - the DESKTOP app (Electron) already runs as a process on the same
 *    Windows machine as the printer, so it never needs that connector: the
 *    preload bridge (`window.businessSuiteDesktop.printing`, backed by
 *    `electron/native-printing.js`) talks to `winspool.drv` and raw TCP
 *    sockets directly from the app's own main process. Section 7 of the
 *    desktop audit was exactly this — the desktop build should not force an
 *    unrelated second installer next to itself.
 *
 * `desktopPrintingBridge()` is the one place that decides which backend a
 * given browser tab has available; every exported function below is written
 * against it so callers (the settings UI, the POS, labels) never branch on
 * "am I inside Electron?" themselves.
 *
 * A missing printer is `printer_not_configured`. Operational printing does not
 * open the browser print dialog.
 */
import type { DocType, PaperKey } from "../print-template";
import { CONNECTOR_PROTOCOL_VERSION, CONNECTOR_PORT } from "./connector-release";
import type { PrintDocumentRef, PrintSampleJob } from "./document-request";
import { classifyDeliveryError, type PrinterErrorCode } from "./errors";
import type { PrinterPurpose, PrinterTarget } from "./types";
import type { DesktopPrintingBridge } from "../desktop-bridge";
import "../desktop-bridge"; // registers the `Window.businessSuiteDesktop` global augmentation

/** What a caller asks the server to print: a stored document, or the product's own sample. */
export type PrintRequestPayload = { document: PrintDocumentRef } | { job: PrintSampleJob };

/** The connector protocol version this client speaks — shared with the installer and docs. */
const CONNECTOR_VERSION = CONNECTOR_PROTOCOL_VERSION;

function connectorBaseUrl(): string {
  return process.env.NEXT_PUBLIC_PRINT_CONNECTOR_URL || `http://127.0.0.1:${CONNECTOR_PORT}`;
}

/** Are we inside the desktop app, with its direct native-printing bridge available? */
function desktopPrintingBridge(): DesktopPrintingBridge | null {
  if (typeof window === "undefined") return null;
  return window.businessSuiteDesktop?.printing ?? null;
}


// A cloud page must not hammer a missing loopback service: one failed health
// attempt suppresses further calls for a short window, and the explicit
// «بررسی دوباره» action clears the backoff immediately after the operator
// installs the connector.
const CONNECTOR_RETRY_DELAY_MS = 15_000;
let connectorRetryAfter = 0;
let healthInFlight: Promise<ConnectorResult<ConnectorHealth>> | null = null;

/** Let an explicit user action retry the connector immediately. */
export function allowConnectorRetry(): void {
  connectorRetryAfter = 0;
}

export interface ConnectorResult<T = { ok: boolean }> {
  ok: boolean;
  /** The connector process itself was not reachable (not installed/not running). */
  unreachable?: boolean;
  error?: PrinterErrorCode;
  /** Technical detail for logs/diagnostics — never shown in the primary UI. */
  detail?: string;
  data?: T;
}

export interface ConnectorHealth {
  ok: boolean;
  service?: string;
  version?: number;
  release?: string;
  platform?: string;
  /** The primary origin the connector serves (kept from protocol v3). */
  allowedOrigin?: string;
  /** Every origin the connector serves — primary plus aliases (release 3.1+). */
  allowedOrigins?: string[];
  printSubsystem?: {
    winspool?: string;
    networkDiscovery?: string;
    spooler?: string;
  };
}

async function callConnector<T = { ok: boolean }>(
  path: string,
  body: Record<string, unknown>,
  opts: { timeoutMs?: number; method?: "GET" | "POST"; force?: boolean } = {},
): Promise<ConnectorResult<T>> {
  if (!opts.force && Date.now() < connectorRetryAfter) {
    return { ok: false, unreachable: true, error: "connector_not_installed" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    const method = opts.method ?? "POST";
    // The literal 127.0.0.1 target lets current Chromium identify this as a
    // loopback request before mixed-content checks and show its one-time
    // «Apps on device / Local network access» permission when needed.
    const res = await fetch(`${connectorBaseUrl()}${path}`, {
      method,
      headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
      body: method === "POST" ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    connectorRetryAfter = 0;
    let data: { ok?: boolean; error?: string; detail?: string } & Record<string, unknown> = {};
    try {
      data = (await res.json()) as typeof data;
    } catch {
      // no body
    }
    if (!res.ok) {
      return {
        ok: false,
        error: (data.error as PrinterErrorCode) ?? "print_failed",
        detail: typeof data.detail === "string" ? data.detail : undefined,
        data: data as T,
      };
    }
    return { ok: true, data: data as T };
  } catch {
    connectorRetryAfter = Date.now() + CONNECTOR_RETRY_DELAY_MS;
    return { ok: false, unreachable: true, error: "connector_not_installed" };
  } finally {
    clearTimeout(timeout);
  }
}

/* ─────────────────────────── connector API ─────────────────────────── */

/**
 * Is the local Cafe POS connector installed, running and current? A health
 * answer from an older connector version (pre-3) is `connector_outdated`:
 * the one-click reinstall upgrades it.
 */
export async function connectorHealth(opts: { force?: boolean } = {}): Promise<ConnectorResult<ConnectorHealth>> {
  // The desktop app never needs the loopback connector — its native bridge
  // is part of the app process itself, so there is nothing to "install" and
  // nothing that can be "outdated" independently of the app build itself.
  if (desktopPrintingBridge()) {
    return { ok: true, data: { ok: true, service: "cafe-pos-desktop-native", version: CONNECTOR_VERSION, platform: "windows" } };
  }
  if (healthInFlight && !opts.force) return healthInFlight;
  const probe = (async (): Promise<ConnectorResult<ConnectorHealth>> => {
    const result = await callConnector<ConnectorHealth>("/health", {}, {
      method: "GET",
      // A first cloud → loopback request may wait while Chrome/Edge shows
      // the one-time Local Network Access prompt. Give the operator time to
      // read and allow it; a genuinely closed port still refuses instantly.
      timeoutMs: 12_000,
      force: opts.force,
    });
    if (result.ok && typeof result.data?.version === "number" && result.data.version < CONNECTOR_VERSION) {
      return { ok: false, error: "connector_outdated", data: result.data };
    }
    return result;
  })();
  if (opts.force) return probe;
  healthInFlight = probe;
  void probe.finally(() => {
    if (healthInFlight === probe) healthInFlight = null;
  });
  return probe;
}

export interface WindowsPrinter {
  name: string;
  driver?: string | null;
  isDefault: boolean;
  likelyThermal: boolean;
}

/** The print queues installed on this Windows machine (Printers & scanners). Desktop bridge first, connector otherwise. */
export async function listWindowsPrinters(): Promise<ConnectorResult<{ printers: WindowsPrinter[] }>> {
  const bridge = desktopPrintingBridge();
  if (bridge) {
    const result = await bridge.listWindowsPrinters();
    if (!result.ok) return { ok: false, error: (result.error as PrinterErrorCode) ?? "print_failed", detail: result.detail };
    return { ok: true, data: { printers: result.printers ?? [] } };
  }
  return callConnector<{ printers: WindowsPrinter[] }>("/printers/windows", {}, { method: "GET", timeoutMs: 20_000 });
}

export interface DiscoveredPrinter {
  ip: string;
  port: number;
  latencyMs: number;
}

/** Sweep this machine's local subnets for network printers (port 9100). Desktop bridge first, else the connector — never the app server. */
export async function discoverNetworkPrinters(): Promise<ConnectorResult<{ printers: DiscoveredPrinter[] }>> {
  const bridge = desktopPrintingBridge();
  if (bridge) {
    const result = await bridge.discoverNetworkPrinters();
    if (!result.ok) return { ok: false, error: (result.error as PrinterErrorCode) ?? "print_failed", detail: result.detail };
    return { ok: true, data: { printers: result.printers ?? [] } };
  }
  return callConnector<{ printers: DiscoveredPrinter[] }>("/printers/network/discover", {}, { timeoutMs: 60_000 });
}

/** Is this printer answering right now, as seen from the cashier's machine? Desktop bridge first, else the connector. */
export async function probePrinterTarget(
  target: PrinterTarget,
): Promise<ConnectorResult<{ reachable: boolean; detail?: string }>> {
  const bridge = desktopPrintingBridge();
  if (bridge) {
    const result = await bridge.probe(target);
    if (!result.ok) return { ok: false, error: (result.error as PrinterErrorCode) ?? "print_failed", detail: result.detail };
    const reachable = result.reachable === true;
    return {
      ok: true,
      data: { reachable, detail: result.detail },
      error: reachable ? undefined : target.type === "network" ? "network_unreachable" : "printer_offline",
    };
  }
  const result = await callConnector<{ reachable: boolean; detail?: string }>("/printers/probe", { target }, { timeoutMs: 10_000 });
  if (result.ok && !result.data?.reachable) {
    return { ...result, error: target.type === "network" ? "network_unreachable" : "printer_offline" };
  }
  return result;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)));
  }
  return btoa(chunks.join(""));
}

function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Deliver raw ESC/POS bytes to a printer through the local connector. */
export async function sendRawToPrinter(target: PrinterTarget, bytes: Uint8Array): Promise<ConnectorResult> {
  const bridge = desktopPrintingBridge();
  if (bridge) {
    const result = await bridge.sendRaw(target, bytesToBase64(bytes));
    if (!result.ok) {
      return { ok: false, error: (result.error as PrinterErrorCode) ?? classifyDeliveryError(result.detail, target), detail: result.detail };
    }
    return { ok: true };
  }
  const result = await callConnector("/print/raw", { target, dataBase64: bytesToBase64(bytes) }, { timeoutMs: 30_000 });
  if (!result.ok && !result.unreachable) {
    // A refused queue or an unanswered TCP dial is a different sentence in
    // the operator's world; classify from the connector's detail.
    return { ...result, error: result.error ?? classifyDeliveryError(result.detail, target) };
  }
  return result;
}

/* ─────────────────────── job rendering (app server) ─────────────────────── */

export interface PrintResult {
  ok: boolean;
  error?: PrinterErrorCode;
  detail?: string;
  printerId?: string;
  /** The history row this attempt opened — the server's id for it. */
  jobId?: string | null;
  supportsDrawer?: boolean;
  /** The template revision that actually rendered this job — for diagnostics. */
  templateId?: string | null;
  templateKey?: string;
  templateVersion?: number;
}

interface RenderedJob {
  target: PrinterTarget;
  dataBase64: string;
  delivery: "raw" | "page";
  jobId: string | null;
  printerName?: string;
  printerId?: string;
  supportsDrawer?: boolean;
  templateId?: string | null;
  templateKey?: string;
  templateVersion?: number;
}

const inflightPrints = new Map<string, Promise<PrintResult>>();

export interface PrintProgress {
  phase: "preparing" | "routing" | "sending" | "handed_off" | "failed";
  title: string;
  printerName?: string;
  message?: string;
  error?: PrinterErrorCode;
}

type ProgressListener = (state: PrintProgress | null) => void;
const progressListeners = new Set<ProgressListener>();

export function subscribePrintProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

function reportProgress(state: PrintProgress | null): void {
  for (const listener of progressListeners) listener(state);
}

/**
 * Close **this attempt's** history row, by the id the print endpoint opened it
 * with. Every terminal delivery path calls this — success and failure alike —
 * because a job that never leaves `sending` shows as «در حال ارسال» forever,
 * which is how a broken printer used to look like a busy one.
 *
 * The row is addressed by id rather than by the caller's own request id: the
 * screens derive that id from the document (`receipt:{orderId}`), so two prints
 * of the same bill used to write to the same row and a retry left no trace at
 * all (migration 0213).
 */
function reportJobOutcome(
  jobId: string | null | undefined,
  status: "handed_off" | "failed",
  errorCode?: PrinterErrorCode,
): void {
  if (!jobId) return;
  void fetch("/api/printing/jobs", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId, status, errorCode }),
  }).catch(() => undefined);
}

/** Deliver a page image through the Windows driver. Network raw ports are not page printers. */
export async function sendPageToPrinter(target: PrinterTarget, bytes: Uint8Array): Promise<ConnectorResult> {
  if (target.type !== "windows" || !target.systemName) {
    return { ok: false, error: "incompatible_printer" };
  }
  const bridge = desktopPrintingBridge();
  if (bridge?.sendPage) {
    const result = await bridge.sendPage(target.systemName, bytesToBase64(bytes));
    if (!result.ok) return { ok: false, error: (result.error as PrinterErrorCode) ?? "spooler_rejected", detail: result.detail };
    return { ok: true };
  }
  const result = await callConnector("/print/page", { target, dataBase64: bytesToBase64(bytes) }, { timeoutMs: 45_000 });
  if (!result.ok && result.error === "print_failed" && result.detail?.includes("not_found")) {
    return { ok: false, error: "connector_outdated", detail: result.detail };
  }
  return result.ok ? result : { ...result, error: result.error ?? "spooler_rejected" };
}

/**
 * Render a document for a resolved printer on the authenticated app server and
 * deliver the canonical bytes through the local backend.
 *
 * The server receives the printer ID, the document type, an optional template
 * ID and a **reference to a stored document** — which it loads from the
 * caller's own branch. It is not sent the document's contents: that is the
 * whole point of the audit (see api/printing/print/route.ts), and it is why a
 * print function here takes an order id rather than a receipt.
 *
 * Failure is a first-class outcome. The server closes the attempt's history row
 * for anything it saw fail (a refused printer, a failed render); this side
 * closes it once the local spooler has answered — success or failure — so a
 * receipt that never reaches paper is never left as «در حال ارسال».
 */
export async function printJob(
  printerId: string | null,
  payload: PrintRequestPayload,
  opts: {
    requestId?: string;
    title?: string;
    /** The document type to print as; omitted means the document's own default. */
    documentType?: DocType;
    /** Pin the exact template (the settings "print sample" button). */
    templateId?: string | null;
  } = {},
): Promise<PrintResult> {
  const key = opts.requestId;
  if (key) {
    const existing = inflightPrints.get(key);
    if (existing) return existing;
  }
  const run = executePrintJob(printerId, payload, opts.title ?? "چاپ", opts);
  if (!key) return run;
  inflightPrints.set(key, run);
  try {
    return await run;
  } finally {
    inflightPrints.delete(key);
  }
}

async function executePrintJob(
  printerId: string | null,
  payload: PrintRequestPayload,
  title: string,
  opts: { requestId?: string; documentType?: DocType; templateId?: string | null },
): Promise<PrintResult> {
  reportProgress({ phase: "preparing", title });
  let rendered: RenderedJob;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    let res: Response;
    try {
      res = await fetch("/api/printing/print", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          printerId: printerId || undefined,
          templateId: opts.templateId || undefined,
          printRequestId: opts.requestId,
          documentType: opts.documentType,
          ...payload,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      target?: PrinterTarget;
      dataBase64?: string;
      delivery?: "raw" | "page";
      printerName?: string;
      printerId?: string;
      jobId?: string | null;
      supportsDrawer?: boolean;
      templateId?: string | null;
      templateKey?: string;
      templateVersion?: number;
    };
    if (!res.ok || !data.ok || !data.target || !data.dataBase64) {
      // Nothing to close here: the server refused before opening a row, or
      // closed the attempt itself when the render failed.
      const error = (data.error as PrinterErrorCode) ?? "render_failed";
      reportProgress({ phase: "failed", title, error });
      return {
        ok: false,
        error,
        printerId: data.printerId,
        jobId: data.jobId ?? null,
        supportsDrawer: data.supportsDrawer,
      };
    }
    rendered = {
      target: data.target,
      jobId: data.jobId ?? null,
      dataBase64: data.dataBase64,
      delivery: data.delivery === "page" ? "page" : "raw",
      printerName: data.printerName,
      printerId: data.printerId,
      supportsDrawer: data.supportsDrawer,
      templateId: data.templateId ?? null,
      templateKey: data.templateKey,
      templateVersion: data.templateVersion,
    };
  } catch (err) {
    // The request never completed — the caller navigated away, the network
    // dropped, the server restarted. This side has no row id to close, so the
    // attempt (if the server opened one) is closed by the stale-`sending`
    // sweep on the next history read rather than left as «در حال ارسال».
    const error: PrinterErrorCode = (err as { name?: string })?.name === "AbortError" ? "job_timeout" : "render_failed";
    reportProgress({ phase: "failed", title, error });
    return { ok: false, error };
  }
  reportProgress({ phase: "sending", title, printerName: rendered.printerName });
  const bytes = base64ToBytes(rendered.dataBase64);
  const delivered = rendered.delivery === "page"
    ? await sendPageToPrinter(rendered.target, bytes)
    : await sendRawToPrinter(rendered.target, bytes);
  if (!delivered.ok) {
    const error = delivered.error ?? "print_failed";
    reportProgress({ phase: "failed", title, printerName: rendered.printerName, error });
    reportJobOutcome(rendered.jobId, "failed", error);
    return {
      ok: false,
      error,
      detail: delivered.detail,
      printerId: rendered.printerId,
      jobId: rendered.jobId,
      supportsDrawer: rendered.supportsDrawer,
    };
  }
  reportProgress({ phase: "handed_off", title, printerName: rendered.printerName });
  reportJobOutcome(rendered.jobId, "handed_off");
  return {
    ok: true,
    printerId: rendered.printerId,
    jobId: rendered.jobId,
    supportsDrawer: rendered.supportsDrawer,
    templateId: rendered.templateId,
    templateKey: rendered.templateKey,
    templateVersion: rendered.templateVersion,
  };
}

/**
 * The test print for a printer that is not saved yet (the add-printer
 * wizard's «چاپ آزمایشی»): the server renders the sample document for the
 * chosen purpose and paper, delivery happens locally against the chosen
 * target.
 */
export async function testPrintDraft(
  target: PrinterTarget,
  purpose: PrinterPurpose,
  paper: PaperKey,
): Promise<PrintResult> {
  let prepared: { dataBase64: string; delivery: "raw" | "page" };
  try {
    const res = await fetch("/api/printing/test-draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ purpose, paper }),
    });
    const data = (await res.json()) as { ok?: boolean; error?: string; dataBase64?: string; delivery?: "raw" | "page" };
    if (!res.ok || !data.ok || !data.dataBase64) {
      return { ok: false, error: (data.error as PrinterErrorCode) ?? "render_failed" };
    }
    prepared = { dataBase64: data.dataBase64, delivery: data.delivery === "page" ? "page" : "raw" };
  } catch {
    return { ok: false, error: "render_failed" };
  }
  const bytes = base64ToBytes(prepared.dataBase64);
  const delivered = prepared.delivery === "page" ? await sendPageToPrinter(target, bytes) : await sendRawToPrinter(target, bytes);
  return delivered.ok ? { ok: true } : { ok: false, error: delivered.error, detail: delivered.detail };
}

/* ────────────────────────── ready-made jobs ────────────────────────── */

/**
 * The customer receipt for a stored sale — the document the «رسید فروش» rule
 * routes to a thermal printer.
 *
 * `orderId` is the whole input. The server loads the sale in the caller's own
 * branch and builds the receipt from its rows, so the printed lines, prices,
 * totals and letterhead are the sale's own — the browser has nothing to say
 * about them (that was the audit's finding, see api/printing/print/route.ts).
 * A retail sale resolves through its own invoice builder, so the same call
 * prints the same paper the retail screens print.
 *
 * `documentType` is explicit on purpose: a thermal receipt and a formal A4/A5
 * invoice are two different products with two different rules, two different
 * printers and two different templates. The same sale may need both, so both
 * are named actions — never inferred from which screen is open, which is how
 * the retail invoice briefly printed as a receipt and re-printed as an invoice
 * from its own detail modal.
 */
export function printSaleReceipt(
  printerId: string | null,
  orderId: string,
  opts: { requestId?: string; title?: string; templateId?: string | null } = {},
): Promise<PrintResult> {
  return printJob(
    printerId,
    { document: { kind: "order-receipt", orderId } },
    { ...opts, title: opts.title ?? "چاپ رسید", documentType: "receipt" },
  );
}

/** The formal invoice (A4/A5) for the same stored sale — the «فاکتور» rule. */
export function printSaleInvoice(
  printerId: string | null,
  orderId: string,
  opts: { requestId?: string; title?: string; templateId?: string | null } = {},
): Promise<PrintResult> {
  return printJob(
    printerId,
    { document: { kind: "order-receipt", orderId } },
    { ...opts, title: opts.title ?? "چاپ فاکتور", documentType: "invoice" },
  );
}

/** The kitchen ticket for a stored sale: what to make, loaded from the order's lines. */
export function printKitchenTicket(
  printerId: string | null,
  orderId: string,
  opts: { requestId?: string; title?: string } = {},
): Promise<PrintResult> {
  return printJob(
    printerId,
    { document: { kind: "kitchen-ticket", orderId } },
    { ...opts, title: opts.title ?? "چاپ آشپزخانه", documentType: "kitchen" },
  );
}

/** The saved printer's own test print — the product's sample document, on its own paper. */
export function testPrint(printerId: string, kind: DocType): Promise<PrintResult> {
  return printJob(printerId, { job: { type: "test", kind } }, { title: "چاپ آزمایشی", documentType: kind });
}

/**
 * Print one template's sample document through the operational pipeline — the
 * gallery's «چاپ نمونه». The template is pinned by id, so what leaves the
 * printer is exactly the template the card previewed, on the branch's printer
 * for that document type.
 */
export function printTemplateSample(
  template: { id?: string | null; docType: DocType },
): Promise<PrintResult> {
  const kind = template.docType;
  return printJob(null, { job: { type: "test", kind } }, {
    title: "چاپ نمونه",
    documentType: kind,
    templateId: template.id ?? null,
  });
}

/** Open the till drawer through the printer it is wired to (ESC p). */
export function kickDrawer(printerId: string): Promise<PrintResult> {
  return printJob(printerId, { job: { type: "drawer-kick" } }, { title: "بازکردن کشو" });
}

/**
 * Print an item's label through the label rule's printer and template. The
 * bars and the fields come from the branch's barcode row, so the printed code
 * is the code the scanner will read back — `code` pins one when the item has
 * several.
 */
export function printLabel(
  printerId: string | null,
  item: { itemId: string; code?: string | null },
  opts: { requestId?: string; title?: string } = {},
): Promise<PrintResult> {
  const document: PrintDocumentRef = { kind: "item-label", itemId: item.itemId };
  if (item.code) document.code = item.code;
  return printJob(printerId, { document }, { ...opts, documentType: "label", title: opts.title ?? "چاپ برچسب" });
}
