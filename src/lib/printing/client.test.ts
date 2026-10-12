/**
 * client.ts — the browser's printing client. What must never regress:
 *
 *  - the local connector is the ONE hardware backend: health, discovery,
 *    probe and raw delivery all go to 127.0.0.1:9123 and nowhere else;
 *  - hardware jobs are printerId-scoped and document-referenced: the client
 *    POSTs a printer ID plus the id of a stored document to
 *    /api/printing/print and then forwards the returned canonical bytes to
 *    the connector — it never builds a connection object, and never a
 *    document, of its own;
 *  - an outdated connector (pre-v3) is reported as connector_outdated, the
 *    reinstall-upgrade path;
 *  - errors surface as canonical codes with Persian, human sentences — never
 *    a raw ECONNREFUSED-style exception;
 *  - an attempt's history row is closed on every DELIVERY path — success
 *    becomes `handed_off`, a failed handoff becomes `failed` — against the id
 *    the server opened the row with, so two prints of one bill are two rows;
 *    a request that never got an answer is left to the server's stale sweep;
 *  - the request is an intent (a document reference + a document type), never
 *    rendered HTML and never document content.
 *
 * fetch is mocked per-URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allowConnectorRetry,
  connectorHealth,
  discoverNetworkPrinters,
  kickDrawer,
  listWindowsPrinters,
  printKitchenTicket,
  printLabel,
  printSaleInvoice,
  printSaleReceipt,
  printTemplateSample,
  probePrinterTarget,
  testPrintDraft,
} from "./client";
import { printerErrorMessage } from "./errors";
import * as client from "./client";

const CONNECTOR = "http://127.0.0.1:9123";

type Responder = (url: string, init?: RequestInit) => Promise<Response> | Response;

function respondJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Route fetch by URL prefix; anything unrouted rejects like a dead host. */
function mockFetch(routes: Record<string, Responder>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [prefix, responder] of Object.entries(routes)) {
      if (url.startsWith(prefix) || url === prefix) return responder(url, init);
    }
    throw new TypeError("fetch failed"); // unreachable host
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

/** Real-shaped ids: the endpoint validates them, so a fake like "order-1" is not a valid test input. */
const ORDER_ID = "1f3d5b70-2c94-4a1e-8f6d-0b2c4e6a8d10";
const ITEM_ID = "2a4e6c81-3d05-4b2f-9a7e-1c3d5f7b9e21";
const JOB_ID = "5d719f14-6a38-4e52-8da1-4f608c0e2b54";

const WINDOWS_TARGET = { type: "windows" as const, systemName: "EPSON TM-T20III" };
const NETWORK_TARGET = { type: "network" as const, ip: "10.0.0.5", port: 9100 };

/** Bytes for the raw-delivery assertions, and the b64 round-trip they ride in. */
const RENDERED = new Uint8Array([0x1b, 0x40, 0x01, 0x02, 0x03]);
const RENDERED_B64 = Buffer.from(RENDERED).toString("base64");

beforeEach(() => {
  vi.clearAllMocks();
  allowConnectorRetry();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connector health", () => {
  it("reports a healthy current connector", async () => {
    mockFetch({
      [`${CONNECTOR}/health`]: () => respondJson({ ok: true, service: "cafe-pos-print-connector", version: 3, platform: "windows" }),
    });
    const result = await connectorHealth({ force: true });
    expect(result.ok).toBe(true);
    expect(result.data?.version).toBe(3);
  });

  it("treats a pre-v3 connector as outdated — the reinstall is the upgrade", async () => {
    mockFetch({
      [`${CONNECTOR}/health`]: () => respondJson({ ok: true, service: "cafe-pos-print-connector", version: 2 }),
    });
    const result = await connectorHealth({ force: true });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("connector_outdated");
    expect(printerErrorMessage(result.error)).toContain("قدیمی");
  });

  it("reports connector_not_installed when nothing answers on loopback", async () => {
    mockFetch({});
    const result = await connectorHealth({ force: true });
    expect(result.ok).toBe(false);
    expect(result.unreachable).toBe(true);
    expect(result.error).toBe("connector_not_installed");
    expect(printerErrorMessage(result.error)).toContain("سرویس چاپ اشوبه");
  });
});

describe("connector discovery & probing", () => {
  it("lists Windows queues from the connector only", async () => {
    const { calls } = mockFetch({
      [`${CONNECTOR}/printers/windows`]: () =>
        respondJson({ ok: true, printers: [{ name: "EPSON TM-T20III", driver: "ESC/POS", isDefault: true, likelyThermal: true }] }),
    });
    const result = await listWindowsPrinters();
    expect(result.ok).toBe(true);
    expect(result.data?.printers[0].name).toBe("EPSON TM-T20III");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${CONNECTOR}/printers/windows`);
  });

  it("discovers network printers through the connector, never the app server", async () => {
    const { calls } = mockFetch({
      [`${CONNECTOR}/printers/network/discover`]: () =>
        respondJson({ ok: true, printers: [{ ip: "192.168.1.45", port: 9100, latencyMs: 12 }] }),
    });
    const result = await discoverNetworkPrinters();
    expect(result.ok).toBe(true);
    expect(result.data?.printers[0].ip).toBe("192.168.1.45");
    expect(calls.map((c) => c.url)).not.toContain("/api/print/scan");
  });

  it("probes a network target and maps an unreachable one to network_unreachable", async () => {
    mockFetch({
      [`${CONNECTOR}/printers/probe`]: () => respondJson({ ok: true, reachable: false, detail: "timeout" }),
    });
    const result = await probePrinterTarget(NETWORK_TARGET);
    expect(result.ok).toBe(true);
    expect(result.data?.reachable).toBe(false);
    expect(result.error).toBe("network_unreachable");
    expect(printerErrorMessage(result.error)).toContain("همان شبکه");
  });

  it("probes a Windows target and maps a missing queue to printer_offline", async () => {
    mockFetch({
      [`${CONNECTOR}/printers/probe`]: () => respondJson({ ok: true, reachable: false, detail: "printer_not_found" }),
    });
    const result = await probePrinterTarget(WINDOWS_TARGET);
    expect(result.error).toBe("printer_offline");
    expect(printerErrorMessage(result.error)).toContain("روشن");
  });
});

describe("hardware jobs are printerId-scoped", () => {
  it("renders on the server by ID, then delivers the returned bytes through the connector", async () => {
    const { calls } = mockFetch({
      "/api/printing/print": () =>
        respondJson({ ok: true, jobId: JOB_ID, target: WINDOWS_TARGET, dataBase64: RENDERED_B64 }),
      [`${CONNECTOR}/print/raw`]: () => respondJson({ ok: true }),
    });

    const result = await printSaleReceipt("printer-1", ORDER_ID);
    expect(result.ok).toBe(true);

    const render = calls.find((c) => c.url === "/api/printing/print");
    expect(render).toBeDefined();
    expect(JSON.parse(String(render!.init!.body))).toEqual({
      printerId: "printer-1",
      documentType: "receipt",
      document: { kind: "order-receipt", orderId: ORDER_ID },
    });
    // The client sends an INTENT: a document reference, no HTML, no data, no
    // target, no template body.
    expect(String(render!.init!.body)).not.toContain("html");
    expect(String(render!.init!.body)).not.toContain("receipt\":{");
    // No hardware target ever travels to the app server.
    expect(String(render!.init!.body)).not.toContain("systemName");
    expect(String(render!.init!.body)).not.toContain("10.0.0.5");

    const delivery = calls.find((c) => c.url === `${CONNECTOR}/print/raw`);
    expect(delivery).toBeDefined();
    const payload = JSON.parse(String(delivery!.init!.body)) as { target: typeof WINDOWS_TARGET; dataBase64: string };
    expect(payload.target).toEqual(WINDOWS_TARGET);
    expect(payload.dataBase64).toBe(RENDERED_B64);
  });

  it("maps a server refusal to its canonical code without attempting delivery", async () => {
    const { calls } = mockFetch({
      "/api/printing/print": () => respondJson({ ok: false, error: "printer_inactive" }, 409),
    });
    const result = await printSaleReceipt("printer-1", ORDER_ID);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("printer_inactive");
    expect(calls.find((c) => c.url === `${CONNECTOR}/print/raw`)).toBeUndefined();
  });

  it("closes the job as failed on every local delivery failure — never leaving «در حال ارسال»", async () => {
    const { calls } = mockFetch({
      "/api/printing/print": () => respondJson({ ok: true, jobId: JOB_ID, target: WINDOWS_TARGET, dataBase64: RENDERED_B64 }),
      [`${CONNECTOR}/print/raw`]: () => respondJson({ ok: false, error: "spooler_rejected" }, 502),
      "/api/printing/jobs": () => respondJson({ ok: true }),
    });
    const result = await printSaleReceipt("printer-1", ORDER_ID, { requestId: "req-1" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("spooler_rejected");
    const patch = calls.find((c) => c.url === "/api/printing/jobs");
    expect(patch).toBeDefined();
    expect(patch!.init!.method).toBe("PATCH");
    // Addressed by the attempt the server opened, not by the caller's own
    // request id — the id two prints of one bill would share.
    expect(JSON.parse(String(patch!.init!.body))).toEqual({
      jobId: JOB_ID,
      status: "failed",
      errorCode: "spooler_rejected",
    });
  });

  it("closes the job as handed_off on success", async () => {
    const { calls } = mockFetch({
      "/api/printing/print": () => respondJson({ ok: true, jobId: JOB_ID, target: WINDOWS_TARGET, dataBase64: RENDERED_B64 }),
      [`${CONNECTOR}/print/raw`]: () => respondJson({ ok: true }),
      "/api/printing/jobs": () => respondJson({ ok: true }),
    });
    const result = await printSaleReceipt("printer-1", ORDER_ID, { requestId: "req-2" });
    expect(result.ok).toBe(true);
    const patch = calls.find((c) => c.url === "/api/printing/jobs");
    expect(JSON.parse(String(patch!.init!.body))).toEqual({ jobId: JOB_ID, status: "handed_off" });
  });

  it("leaves a request that never answered to the server's own sweep — there is no row id to close", async () => {
    const { calls } = mockFetch({
      "/api/printing/jobs": () => respondJson({ ok: true }),
    });
    const result = await printSaleReceipt("printer-1", ORDER_ID, { requestId: "req-3" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("render_failed");
    // No attempt id came back, so nothing is PATCHed: the server either
    // refused before opening a row or closed it itself, and an orphaned
    // `sending` row is swept to `job_timeout` when history is read.
    expect(calls.find((c) => c.url === "/api/printing/jobs")).toBeUndefined();
  });

  it("a printer from another branch is simply not found", async () => {
    mockFetch({
      "/api/printing/print": () => respondJson({ ok: false, error: "printer_not_found" }, 404),
    });
    const result = await kickDrawer("someone-elses-printer");
    expect(result.error).toBe("printer_not_found");
  });

  it("classifies a failed delivery from the connector's error code", async () => {
    mockFetch({
      "/api/printing/print": () => respondJson({ ok: true, jobId: JOB_ID, target: NETWORK_TARGET, dataBase64: RENDERED_B64 }),
      [`${CONNECTOR}/print/raw`]: () => respondJson({ ok: false, error: "network_unreachable", detail: "connect timed out" }, 502),
    });
    const result = await printSaleReceipt("printer-1", ORDER_ID);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("network_unreachable");
    expect(printerErrorMessage(result.error)).not.toContain("ECONNREFUSED");
  });

  it("reports connector_not_installed when the connector is down, without calling the server for hardware", async () => {
    const { calls } = mockFetch({
      "/api/printing/print": () => respondJson({ ok: true, jobId: JOB_ID, target: WINDOWS_TARGET, dataBase64: RENDERED_B64 }),
    });
    const result = await printSaleReceipt("printer-1", ORDER_ID);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("connector_not_installed");
    // The render happened and the connector was tried; the only other
    // app-server call is closing the attempt's history row — there is no
    // server-side hardware path to fall back to.
    const serverCalls = calls.filter((c) => c.url.startsWith("/api/"));
    expect(serverCalls.map((c) => c.url)).toEqual(["/api/printing/print", "/api/printing/jobs"]);
    expect(JSON.parse(String(serverCalls[1].init!.body))).toEqual({
      jobId: JOB_ID,
      status: "failed",
      errorCode: "connector_not_installed",
    });
  });
});

describe("the wizard's draft test print", () => {
  it("renders the sample for the chosen width and delivers to the picked target", async () => {
    const { calls } = mockFetch({
      "/api/printing/test-draft": () => respondJson({ ok: true, dataBase64: RENDERED_B64 }),
      [`${CONNECTOR}/print/raw`]: () => respondJson({ ok: true }),
    });
    const result = await testPrintDraft(NETWORK_TARGET, "receipt", "thermal80");
    expect(result.ok).toBe(true);
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ purpose: "receipt", paper: "thermal80" });
    const payload = JSON.parse(String(calls[1].init!.body)) as { target: typeof NETWORK_TARGET };
    expect(payload.target).toEqual(NETWORK_TARGET);
  });
});

describe("the desktop app's native printing bridge (no loopback connector at all)", () => {
  /**
   * This suite's default (node) environment has no `window`, so every test
   * above exercises the loopback-connector branch. These tests stub a
   * `window.businessSuiteDesktop.printing` exactly like `electron/preload.js`
   * exposes it, and assert the client prefers it over ever touching
   * 127.0.0.1:9123 — see client.ts's header for why the desktop app skips
   * the connector entirely.
   */
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubDesktopBridge(bridge: Record<string, ReturnType<typeof vi.fn>>) {
    vi.stubGlobal("window", { businessSuiteDesktop: { isDesktop: true, printing: bridge } });
  }

  it("reports connector health as always-ready — there is nothing to install", async () => {
    stubDesktopBridge({});
    const result = await connectorHealth({ force: true });
    expect(result.ok).toBe(true);
    expect(result.data?.service).toBe("cafe-pos-desktop-native");
  });

  it("lists Windows queues through the bridge, never fetching 127.0.0.1", async () => {
    const { fetchMock } = mockFetch({});
    const listWindowsPrintersMock = vi.fn().mockResolvedValue({ ok: true, printers: [{ name: "EPSON TM-T20III", isDefault: true, likelyThermal: true }] });
    stubDesktopBridge({ listWindowsPrinters: listWindowsPrintersMock });
    const result = await listWindowsPrinters();
    expect(result.ok).toBe(true);
    expect(result.data?.printers[0].name).toBe("EPSON TM-T20III");
    expect(listWindowsPrintersMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("discovers network printers through the bridge", async () => {
    const { fetchMock } = mockFetch({});
    const discoverMock = vi.fn().mockResolvedValue({ ok: true, printers: [{ ip: "192.168.1.45", port: 9100, latencyMs: 5 }] });
    stubDesktopBridge({ discoverNetworkPrinters: discoverMock });
    const result = await discoverNetworkPrinters();
    expect(result.ok).toBe(true);
    expect(result.data?.printers).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("probes a target through the bridge and maps an unreachable one to the canonical code", async () => {
    const probeMock = vi.fn().mockResolvedValue({ ok: true, reachable: false });
    stubDesktopBridge({ probe: probeMock });
    const result = await probePrinterTarget(WINDOWS_TARGET);
    expect(result.ok).toBe(true);
    expect(result.data?.reachable).toBe(false);
    expect(result.error).toBe("printer_offline");
    expect(probeMock).toHaveBeenCalledWith(WINDOWS_TARGET);
  });

  it("renders on the server, then delivers through the bridge instead of the connector", async () => {
    const { calls, fetchMock } = mockFetch({
      "/api/printing/print": () => respondJson({ ok: true, jobId: JOB_ID, target: NETWORK_TARGET, dataBase64: RENDERED_B64 }),
    });
    const sendRawMock = vi.fn().mockResolvedValue({ ok: true });
    stubDesktopBridge({ sendRaw: sendRawMock });

    const result = await printSaleReceipt("printer-1", ORDER_ID);
    expect(result.ok).toBe(true);
    expect(sendRawMock).toHaveBeenCalledWith(NETWORK_TARGET, RENDERED_B64);
    // The only network call is the render request; the connector's loopback
    // origin is never touched.
    expect(calls.every((c) => !c.url.startsWith(CONNECTOR))).toBe(true);
    void fetchMock;
  });

  it("classifies a bridge delivery failure into the canonical code", async () => {
    mockFetch({
      "/api/printing/print": () => respondJson({ ok: true, jobId: JOB_ID, target: WINDOWS_TARGET, dataBase64: RENDERED_B64 }),
    });
    const sendRawMock = vi.fn().mockResolvedValue({ ok: false, error: "printer_not_found", detail: "OpenPrinter failed" });
    stubDesktopBridge({ sendRaw: sendRawMock });
    const result = await printSaleReceipt("printer-1", ORDER_ID);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("printer_not_found");
  });
});

describe("labels, kitchen tickets, invoices and template samples", () => {
  it("a label with no printer id names the item and asks the server to resolve the label rule", async () => {
    const { calls } = mockFetch({
      "/api/printing/print": () => respondJson({ ok: false, error: "printer_not_configured" }, 409),
    });
    const result = await printLabel(null, { itemId: ITEM_ID, code: "2000000000015" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("printer_not_configured");
    const render = calls.find((call) => call.url === "/api/printing/print");
    expect(JSON.parse(String(render!.init!.body))).toMatchObject({
      documentType: "label",
      document: { kind: "item-label", itemId: ITEM_ID, code: "2000000000015" },
    });
  });

  it("a kitchen ticket names the sale rather than carrying its lines", async () => {
    const { calls } = mockFetch({
      "/api/printing/print": () => respondJson({ ok: true, jobId: JOB_ID, target: WINDOWS_TARGET, dataBase64: RENDERED_B64 }),
      [`${CONNECTOR}/print/raw`]: () => respondJson({ ok: true }),
    });
    const result = await printKitchenTicket(null, ORDER_ID, { requestId: "kitchen:1" });
    expect(result.ok).toBe(true);
    const render = calls.find((c) => c.url === "/api/printing/print");
    const body = JSON.parse(String(render!.init!.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      documentType: "kitchen",
      document: { kind: "kitchen-ticket", orderId: ORDER_ID },
      printRequestId: "kitchen:1",
    });
    expect(String(render!.init!.body)).not.toContain("lines");
  });

  it("an invoice is an explicit document type, not a receipt by another name", async () => {
    const { calls } = mockFetch({
      "/api/printing/print": () => respondJson({ ok: true, jobId: JOB_ID, target: WINDOWS_TARGET, dataBase64: RENDERED_B64, delivery: "page" }),
      [`${CONNECTOR}/print/page`]: () => respondJson({ ok: true }),
    });
    const result = await printSaleInvoice("printer-1", ORDER_ID, { requestId: "inv-1" });
    expect(result.ok).toBe(true);
    const render = calls.find((c) => c.url === "/api/printing/print");
    expect(JSON.parse(String(render!.init!.body))).toMatchObject({
      documentType: "invoice",
      printerId: "printer-1",
      document: { kind: "order-receipt", orderId: ORDER_ID },
    });
    // A4 goes to the Windows driver, never to the raw ESC/POS port.
    expect(calls.find((c) => c.url === `${CONNECTOR}/print/page`)).toBeDefined();
  });

  it("a template sample pins the exact template revision through the operational pipeline", async () => {
    const { calls } = mockFetch({
      "/api/printing/print": () => respondJson({ ok: true, jobId: JOB_ID, target: WINDOWS_TARGET, dataBase64: RENDERED_B64 }),
      [`${CONNECTOR}/print/raw`]: () => respondJson({ ok: true }),
    });
    const result = await printTemplateSample({ id: "template-9", docType: "receipt" });
    expect(result.ok).toBe(true);
    const render = calls.find((c) => c.url === "/api/printing/print");
    expect(JSON.parse(String(render!.init!.body))).toMatchObject({
      templateId: "template-9",
      documentType: "receipt",
      job: { type: "test", kind: "receipt" },
    });
  });

  it("has no way to send raw HTML to the server", () => {
    // The export simply does not exist any more: nothing a browser can build
    // may be rendered by the server's Chromium.
    expect((client as unknown as Record<string, unknown>).printDocument).toBeUndefined();
  });
});
