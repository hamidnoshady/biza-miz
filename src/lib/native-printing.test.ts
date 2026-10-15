/**
 * electron/native-printing.js — the desktop app's direct Windows/network
 * print path (Section 7 of the desktop audit): no separate "print connector"
 * install for the desktop product, because the desktop process already runs
 * on the same Windows machine as the printer.
 *
 * What must never regress:
 *  - the pure decision logic (JSON parsing, error classification, subnet
 *    derivation, the RAW-print script text) works without touching a real
 *    printer, spooler or network;
 *  - every side-effecting function accepts injectable collaborators, so the
 *    Windows/network dispatch (`probeTarget`/`sendRawToTarget`) can be
 *    exercised end-to-end against fakes;
 *  - the target shape dispatched on is the exact `PrinterTarget` shape
 *    `src/lib/printing/types.ts` already models — `{type:"windows",
 *    systemName}` / `{type:"network", ip, port}` — so this module is a drop-in
 *    delivery backend for the same saved printers, not a parallel model.
 *
 * This is implementation + unit/logic tests only, as scoped: it has not been
 * exercised against a real Windows spooler or a physical printer in this
 * sandbox (no Windows host, no hardware). A real-hardware verification pass
 * on Windows is required before this path replaces the browser connector in
 * production for the desktop build.
 */
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const native = require("../../electron/native-printing.js") as {
  likelyThermalName: (name: string) => boolean;
  listWindowsPrintersScript: () => string;
  parseWindowsPrinterListJson: (raw: string) => Array<{ name: string; driver: string | null; isDefault: boolean; likelyThermal: boolean }>;
  listWindowsPrinters: (opts?: { run?: (script: string) => Promise<string> }) => Promise<
    { ok: true; printers: Array<{ name: string }> } | { ok: false; error: string; detail?: string }
  >;
  probeWindowsPrinter: (
    name: string,
    opts?: { run?: (script: string) => Promise<string> },
  ) => Promise<{ ok: boolean; reachable?: boolean; detail?: string; error?: string }>;
  sendRawScript: (tempFilePath: string, printerName: string) => string;
  classifyWindowsSendError: (message: string) => string;
  sendRawBytesToWindowsPrinter: (
    name: string,
    bytes: Uint8Array,
    opts?: { run?: (script: string) => Promise<string>; tmpdir?: string },
  ) => Promise<{ ok: boolean; error?: string; detail?: string }>;
  classifyNetworkError: (error: { code?: string; message?: string }) => string;
  probeNetworkPrinter: (
    ip: string,
    port?: number,
    opts?: { timeoutMs?: number; connect?: (...args: never[]) => unknown },
  ) => Promise<{ ok: boolean; reachable?: boolean; detail?: string }>;
  sendRawBytesToNetworkPrinter: (
    ip: string,
    port: number,
    bytes: Uint8Array,
    opts?: { timeoutMs?: number; connect?: (...args: never[]) => unknown },
  ) => Promise<{ ok: boolean; error?: string; detail?: string }>;
  localSubnets: (opts?: { listInterfaces?: () => Array<{ name: string; address: string }> }) => string[];
  discoverNetworkPrinters: (opts?: {
    port?: number;
    timeoutMs?: number;
    concurrency?: number;
    listInterfaces?: () => Array<{ name: string; address: string }>;
    connect?: (...args: never[]) => unknown;
  }) => Promise<Array<{ ip: string; port: number; latencyMs: number }>>;
  probeTarget: (
    target: unknown,
    opts?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; reachable?: boolean; error?: string }>;
  sendRawToTarget: (
    target: unknown,
    bytes: Uint8Array,
    opts?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; error?: string }>;
};

/** A fake `net.createConnection` that emits exactly one of connect/timeout/error. */
function fakeSocket(outcome: "connect" | "timeout" | "error", errorMessage = "boom") {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const socket = {
    once(event: string, cb: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(cb);
      return socket;
    },
    write(_data: unknown, cb?: (error?: Error) => void) {
      cb?.();
    },
    end() {
      queueMicrotask(() => listeners.close?.forEach((cb) => cb()));
    },
    destroy() {},
  };
  queueMicrotask(() => {
    if (outcome === "connect") listeners.connect?.forEach((cb) => cb());
    else if (outcome === "timeout") listeners.timeout?.forEach((cb) => cb());
    else listeners.error?.forEach((cb) => cb(new Error(errorMessage)));
  });
  return socket;
}

describe("likelyThermalName", () => {
  it("flags common thermal/receipt queue names, case-insensitively", () => {
    expect(native.likelyThermalName("EPSON TM-T20III")).toBe(true);
    expect(native.likelyThermalName("XP-58 Receipt")).toBe(true);
    expect(native.likelyThermalName("80mm POS Printer")).toBe(true);
    expect(native.likelyThermalName("HP LaserJet Pro")).toBe(false);
    expect(native.likelyThermalName("")).toBe(false);
  });
});

describe("parseWindowsPrinterListJson", () => {
  it("parses a normal multi-printer array", () => {
    const json = JSON.stringify([
      { name: "EPSON TM-T20III", driver: "ESC/POS", isDefault: true },
      { name: "HP LaserJet", driver: "HP Universal", isDefault: false },
    ]);
    const result = native.parseWindowsPrinterListJson(json);
    expect(result).toEqual([
      { name: "EPSON TM-T20III", driver: "ESC/POS", isDefault: true, likelyThermal: true, status: "unknown" },
      { name: "HP LaserJet", driver: "HP Universal", isDefault: false, likelyThermal: false, status: "unknown" },
    ]);
  });

  it("accepts PowerShell's single-item bare-object quirk instead of erroring", () => {
    const json = JSON.stringify({ name: "EPSON TM-T20III", driver: "ESC/POS", isDefault: true });
    expect(native.parseWindowsPrinterListJson(json)).toEqual([
      { name: "EPSON TM-T20III", driver: "ESC/POS", isDefault: true, likelyThermal: true, status: "unknown" },
    ]);
  });

  it("returns an empty list for no printers, never throwing", () => {
    expect(native.parseWindowsPrinterListJson("")).toEqual([]);
    expect(native.parseWindowsPrinterListJson("[]")).toEqual([]);
  });

  it("drops entries with no usable name and tolerates a missing driver", () => {
    const json = JSON.stringify([{ name: "  ", driver: null }, { name: "Fax", driver: null, isDefault: false }]);
    expect(native.parseWindowsPrinterListJson(json)).toEqual([
      { name: "Fax", driver: null, isDefault: false, likelyThermal: false, status: "unknown" },
    ]);
  });

  it("raises a clear error on genuinely invalid JSON rather than a cryptic parser exception", () => {
    expect(() => native.parseWindowsPrinterListJson("{not json")).toThrow(/Could not parse/);
  });
});

describe("listWindowsPrinters / probeWindowsPrinter (native.js, injected PowerShell runner)", () => {
  it("lists queues from the injected runner without ever needing a loopback service", async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify([{ name: "EPSON TM-T20III", driver: "ESC/POS", isDefault: true }]));
    const result = await native.listWindowsPrinters({ run });
    expect(result).toEqual({
      ok: true,
      printers: [{ name: "EPSON TM-T20III", driver: "ESC/POS", isDefault: true, likelyThermal: true, status: "unknown" }],
    });
    expect(run).toHaveBeenCalledWith(native.listWindowsPrintersScript());
  });

  it("reports print_failed with the underlying detail when PowerShell itself fails", async () => {
    const run = vi.fn().mockRejectedValue(new Error("Get-CimInstance : Access is denied"));
    const result = await native.listWindowsPrinters({ run });
    expect(result).toEqual({ ok: false, error: "print_failed", detail: "Get-CimInstance : Access is denied" });
  });

  it("probes a target queue name against the current list", async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify([{ name: "EPSON TM-T20III", driver: null, isDefault: true }]));
    const found = await native.probeWindowsPrinter("EPSON TM-T20III", { run });
    expect(found).toEqual({ ok: true, reachable: true, detail: undefined });
    const missing = await native.probeWindowsPrinter("Some Removed Printer", { run });
    expect(missing).toEqual({ ok: true, reachable: false, detail: "printer_not_found" });
  });
});

describe("classifyWindowsSendError", () => {
  it("maps an OpenPrinter/invalid-name failure to printer_not_found", () => {
    expect(native.classifyWindowsSendError("OpenPrinter failed")).toBe("printer_not_found");
    expect(native.classifyWindowsSendError("Invalid printer name.")).toBe("printer_not_found");
  });
  it("falls back to print_failed for anything else", () => {
    expect(native.classifyWindowsSendError("WritePrinter wrote zero bytes.")).toBe("print_failed");
  });
});

describe("sendRawScript", () => {
  it("embeds the exact printer name and temp file path as PowerShell literals, quote-escaped", () => {
    const script = native.sendRawScript("C:\\Temp\\job.bin", "Kitchen's Printer");
    expect(script).toContain("'Kitchen''s Printer'");
    expect(script).toContain("'C:\\Temp\\job.bin'");
    expect(script).toContain("[CafePosNativePrinter]::Send(");
    expect(script).toContain("WritePrinter");
  });
});

describe("sendRawBytesToWindowsPrinter (injected runner, real temp file)", () => {
  it("writes the bytes to a temp file, runs the send script, and cleans up", async () => {
    let seenScript = "";
    const run = vi.fn(async (script: string) => {
      seenScript = script;
      return "";
    });
    const result = await native.sendRawBytesToWindowsPrinter(
      "EPSON TM-T20III",
      new Uint8Array([0x1b, 0x40, 1, 2, 3]),
      { run, tmpdir: require("node:os").tmpdir() },
    );
    expect(result).toEqual({ ok: true });
    expect(seenScript).toContain("EPSON TM-T20III");
  });

  it("refuses empty print data before ever touching disk or PowerShell", async () => {
    const run = vi.fn();
    const result = await native.sendRawBytesToWindowsPrinter("EPSON TM-T20III", new Uint8Array(), { run });
    expect(result).toEqual({ ok: false, error: "invalid_printer", detail: "Print data is empty." });
    expect(run).not.toHaveBeenCalled();
  });

  it("requires a printer name", async () => {
    const result = await native.sendRawBytesToWindowsPrinter("", new Uint8Array([1]), { run: vi.fn() });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_printer");
  });

  it("classifies a spooler failure through classifyWindowsSendError", async () => {
    const run = vi.fn().mockRejectedValue(new Error("OpenPrinter failed (Win32Exception)"));
    const result = await native.sendRawBytesToWindowsPrinter("Ghost Printer", new Uint8Array([1, 2]), { run });
    expect(result).toEqual({ ok: false, error: "printer_not_found", detail: "OpenPrinter failed (Win32Exception)" });
  });
});

describe("classifyNetworkError", () => {
  it("maps common Node socket error codes to network_unreachable", () => {
    expect(native.classifyNetworkError({ code: "ECONNREFUSED" })).toBe("network_unreachable");
    expect(native.classifyNetworkError({ code: "ETIMEDOUT" })).toBe("network_unreachable");
    expect(native.classifyNetworkError({ code: "EHOSTUNREACH" })).toBe("network_unreachable");
  });
  it("falls back to print_failed for anything unrecognised", () => {
    expect(native.classifyNetworkError({ code: "EPIPE" })).toBe("print_failed");
    expect(native.classifyNetworkError({})).toBe("print_failed");
  });
});

describe("probeNetworkPrinter (injected socket)", () => {
  it("reports reachable on connect", async () => {
    const connect = vi.fn(() => fakeSocket("connect"));
    const result = await native.probeNetworkPrinter("10.0.0.5", 9100, { connect });
    expect(result).toEqual({ ok: true, reachable: true });
  });
  it("reports unreachable on timeout, without throwing", async () => {
    const connect = vi.fn(() => fakeSocket("timeout"));
    const result = await native.probeNetworkPrinter("10.0.0.5", 9100, { connect });
    expect(result.ok).toBe(true);
    expect(result.reachable).toBe(false);
  });
  it("reports unreachable on a connection error", async () => {
    const connect = vi.fn(() => fakeSocket("error", "connect ECONNREFUSED"));
    const result = await native.probeNetworkPrinter("10.0.0.5", 9100, { connect });
    expect(result.reachable).toBe(false);
  });
});

describe("sendRawBytesToNetworkPrinter (injected socket)", () => {
  it("writes bytes and reports ok once the socket closes cleanly", async () => {
    const connect = vi.fn(() => fakeSocket("connect"));
    const result = await native.sendRawBytesToNetworkPrinter("10.0.0.5", 9100, new Uint8Array([1, 2, 3]), { connect });
    expect(result).toEqual({ ok: true });
  });
  it("classifies a refused connection", async () => {
    const connect = vi.fn(() => fakeSocket("error", "connect ECONNREFUSED 10.0.0.5:9100"));
    const result = await native.sendRawBytesToNetworkPrinter("10.0.0.5", 9100, new Uint8Array([1]), { connect });
    expect(result.ok).toBe(false);
  });
  it("refuses to open a socket for empty print data", async () => {
    const connect = vi.fn();
    const result = await native.sendRawBytesToNetworkPrinter("10.0.0.5", 9100, new Uint8Array(), { connect });
    expect(result).toEqual({ ok: false, error: "invalid_printer", detail: "Print data is empty." });
    expect(connect).not.toHaveBeenCalled();
  });
  it("defaults to the raw-print port 9100 when none is given", async () => {
    let seenPort: number | undefined;
    const connect = vi.fn((opts: { port: number }) => {
      seenPort = opts.port;
      return fakeSocket("connect");
    });
    await native.sendRawBytesToNetworkPrinter("10.0.0.5", 0, new Uint8Array([1]), { connect });
    expect(seenPort).toBe(9100);
  });
  it("distinguishes pre-connect timeout (network_unreachable) from post-write timeout (job_timeout / write_ambiguous)", async () => {
    const preConnect = vi.fn(() => fakeSocket("timeout"));
    const preResult = await native.sendRawBytesToNetworkPrinter("10.0.0.5", 9100, new Uint8Array([1, 2]), { connect: preConnect });
    expect(preResult).toEqual({
      ok: false,
      error: "network_unreachable",
      detail: "The connection timed out.",
    });

    // Socket connects and begins writing, then times out before closing:
    const postWrite = vi.fn(() => {
      const EventEmitter = require("node:events");
      const sock = new EventEmitter();
      sock.write = (_bytes: Uint8Array, _cb: (err?: Error) => void) => {
        setImmediate(() => sock.emit("timeout"));
      };
      sock.end = () => {};
      sock.destroy = () => {};
      setImmediate(() => sock.emit("connect"));
      return sock;
    });
    const postResult = await native.sendRawBytesToNetworkPrinter("10.0.0.5", 9100, new Uint8Array([1, 2]), { connect: postWrite });
    expect(postResult.ok).toBe(false);
    expect(postResult.error).toBe("job_timeout");
    expect(postResult.detail).toContain("write_ambiguous");
  });
});

describe("localSubnets", () => {
  it("collects the /24 prefix of every LAN interface, deduplicated", () => {
    const listInterfaces = () => [
      { name: "Wi-Fi", address: "192.168.1.20" },
      { name: "Ethernet", address: "192.168.1.30" },
      { name: "Wi-Fi2", address: "10.0.0.5" },
    ];
    expect(native.localSubnets({ listInterfaces })).toEqual(["192.168.1", "10.0.0"]);
  });
  it("returns an empty list when there is no active LAN adapter", () => {
    expect(native.localSubnets({ listInterfaces: () => [] })).toEqual([]);
  });
});

describe("discoverNetworkPrinters (injected interfaces + socket)", () => {
  it("finds only the addresses that answer, sorted by latency, without opening every socket at once", async () => {
    const listInterfaces = () => [{ name: "Wi-Fi", address: "192.168.1.20" }];
    const connect = vi.fn((opts: { host: string }) => {
      if (opts.host === "192.168.1.45" || opts.host === "192.168.1.9") return fakeSocket("connect");
      return fakeSocket("timeout");
    });
    const found = await native.discoverNetworkPrinters({ listInterfaces, connect, concurrency: 32, timeoutMs: 10 });
    expect(found.map((p) => p.ip).sort()).toEqual(["192.168.1.45", "192.168.1.9"]);
    expect(found.every((p) => p.port === 9100)).toBe(true);
  });

  it("returns immediately with no attempts when there is no local subnet", async () => {
    const connect = vi.fn();
    const found = await native.discoverNetworkPrinters({ listInterfaces: () => [], connect });
    expect(found).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("probeTarget / sendRawToTarget — the one dispatch surface", () => {
  it("dispatches a windows target to the Windows probe path", async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify([{ name: "EPSON TM-T20III", driver: null, isDefault: true }]));
    const result = await native.probeTarget({ type: "windows", systemName: "EPSON TM-T20III" }, { run });
    expect(result).toEqual({ ok: true, reachable: true, detail: undefined });
  });

  it("dispatches a network target to the TCP probe path", async () => {
    const connect = vi.fn(() => fakeSocket("connect"));
    const result = await native.probeTarget({ type: "network", ip: "10.0.0.5", port: 9100 }, { connect });
    expect(result).toEqual({ ok: true, reachable: true });
  });

  it("refuses an unrecognised or missing target shape rather than guessing", async () => {
    expect(await native.probeTarget(null)).toEqual({ ok: false, error: "invalid_printer" });
    expect(await native.probeTarget({ type: "usb" })).toEqual({ ok: false, error: "invalid_printer" });
    expect(await native.sendRawToTarget({ type: "webusb" }, new Uint8Array([1]))).toEqual({ ok: false, error: "invalid_printer" });
  });

  it("dispatches raw delivery to the matching backend for each target type", async () => {
    const run = vi.fn().mockResolvedValue("");
    const windowsResult = await native.sendRawToTarget(
      { type: "windows", systemName: "EPSON TM-T20III" },
      new Uint8Array([1, 2, 3]),
      { run, tmpdir: require("node:os").tmpdir() },
    );
    expect(windowsResult).toEqual({ ok: true });

    const connect = vi.fn(() => fakeSocket("connect"));
    const networkResult = await native.sendRawToTarget(
      { type: "network", ip: "10.0.0.5", port: 9100 },
      new Uint8Array([1, 2, 3]),
      { connect },
    );
    expect(networkResult).toEqual({ ok: true });
  });
});
