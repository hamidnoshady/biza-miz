"use strict";

/**
 * Native Windows printing for the desktop app — the audit fix for Section 7.
 *
 * The browser/cloud product reaches hardware through the Cafe POS Windows
 * Print Connector (public/windows/cafe-pos-print-connector.ps1): a small
 * loopback helper a cashier installs once, because a plain browser tab has
 * no OS access of its own. The DESKTOP app is not a browser tab — it is
 * already a Node/Electron process running on the same Windows machine as the
 * printer, with `child_process` and raw sockets available directly. Asking a
 * desktop install to also install a *second*, separate print helper next to
 * itself was the bug: a needless extra step, a second thing to go stale, and
 * a second install log to debug. This module is that direct path instead:
 * the same two connection types (`windows` queue name / `network` ip:port)
 * the product already models in `src/lib/printing/types.ts`, delivered
 * without any loopback HTTP hop.
 *
 * `windows` targets go through the exact same technique the connector uses —
 * `winspool.drv`'s `WritePrinter` RAW path via a tiny embedded C# helper,
 * because Node has no built-in Windows spooler binding — just invoked
 * in-process via PowerShell rather than requiring a separate always-running
 * service. `network` targets are a plain Node TCP socket; Electron's main
 * process needs no PowerShell at all for those.
 *
 * Every exported side-effecting function accepts its collaborators
 * (`run`, `connect`, `listInterfaces`, `tmpdir`) as overridable options
 * so the pure decision logic (JSON parsing, error classification, script
 * building, subnet derivation) is unit-testable without touching a real
 * printer, spooler or network — see src/lib/native-printing.test.ts.
 */

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { listLanInterfaces } = require("./network-interfaces");

/** Same heuristic the browser connector uses, kept identical on purpose. */
const LIKELY_THERMAL_RE = /(thermal|receipt|pos|xp-|rp-|tm-|80mm|58mm)/i;

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Run one PowerShell command and return stdout, or reject with stderr/timeout. Windows-only. */
function runPowerShell(script, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("PowerShell timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `PowerShell exited ${code}`));
    });
  });
}

function likelyThermalName(name) {
  return LIKELY_THERMAL_RE.test(String(name || ""));
}

/* ─────────────────────────── Windows queues ─────────────────────────── */

function listWindowsPrintersScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$items = @(Get-CimInstance -ClassName Win32_Printer -ErrorAction Stop)",
    "$result = foreach ($p in $items) { [PSCustomObject]@{ name = [string]$p.Name; driver = [string]$p.DriverName; isDefault = [bool]$p.Default; printerStatus = [int]$p.PrinterStatus; workOffline = [bool]$p.WorkOffline } }",
    "ConvertTo-Json -InputObject @($result) -Depth 4 -Compress",
  ].join("; ");
}

/**
 * `ConvertTo-Json -InputObject @($x)` still serialises a *one-item* array as
 * a bare object, not `[{...}]` — a well-known PowerShell quirk. Both shapes
 * are accepted here so a machine with exactly one printer is not mistaken
 * for a parse failure.
 */
function windowsQueueStatus(item) {
  if (item.workOffline === true) return "offline";
  const code = Number(item.printerStatus);
  if (code === 7) return "offline";
  if (code === 6) return "paused";
  if (code === 3 || code === 4 || code === 5) return "ready";
  if (item.printerStatus == null && item.workOffline == null) return "unknown";
  return "available";
}

function parseWindowsPrinterListJson(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return [];
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Could not parse the Windows printer list: ${error.message}`);
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items
    .filter((item) => item && typeof item.name === "string" && item.name.trim() !== "")
    .map((item) => ({
      name: item.name,
      driver: typeof item.driver === "string" && item.driver.trim() !== "" ? item.driver : null,
      isDefault: Boolean(item.isDefault),
      likelyThermal: likelyThermalName(item.name),
      status: windowsQueueStatus(item),
    }));
}

/** The queues installed in Windows' own «Printers & scanners» — no helper process required. */
async function listWindowsPrinters({ run = runPowerShell } = {}) {
  try {
    const stdout = await run(listWindowsPrintersScript());
    return { ok: true, printers: parseWindowsPrinterListJson(stdout) };
  } catch (error) {
    return { ok: false, error: "print_failed", detail: error.message };
  }
}

/** Is this queue name currently installed? Used to probe a saved `windows` target. */
async function probeWindowsPrinter(printerName, opts = {}) {
  const result = await listWindowsPrinters(opts);
  if (!result.ok) return { ok: false, error: result.error, detail: result.detail };
  const reachable = result.printers.some((printer) => printer.name === printerName);
  return { ok: true, reachable, detail: reachable ? undefined : "printer_not_found" };
}

/**
 * The same native winspool RAW bridge the browser connector embeds
 * (`OpenPrinter` → `StartDocPrinter` → `StartPagePrinter` → `WritePrinter`
 * loop → matching `End*`/`Close*`), reused verbatim because it is the one
 * correct way to send raw ESC/POS bytes through Windows' own spooler.
 */
const RAW_PRINT_CSHARP = `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class CafePosNativePrinter
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private class DOC_INFO_1
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName = "Cafe POS";
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile = null;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype = "RAW";
    }

    [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool OpenPrinter(string printerName, out IntPtr printer, IntPtr defaults);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool ClosePrinter(IntPtr printer);

    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern int StartDocPrinter(IntPtr printer, int level, [In] DOC_INFO_1 info);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndDocPrinter(IntPtr printer);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool AbortPrinter(IntPtr printer);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool StartPagePrinter(IntPtr printer);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndPagePrinter(IntPtr printer);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool WritePrinter(IntPtr printer, IntPtr bytes, int count, out int written);

    private static void ThrowLastError(string operation)
    {
        throw new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
    }

    public static void Send(string printerName, byte[] data)
    {
        if (String.IsNullOrWhiteSpace(printerName)) throw new ArgumentException("Printer name is required.");
        if (data == null || data.Length == 0) throw new ArgumentException("Print data is empty.");

        IntPtr printer = IntPtr.Zero;
        IntPtr unmanaged = IntPtr.Zero;
        bool documentStarted = false;
        bool pageStarted = false;
        bool completed = false;

        try
        {
            if (!OpenPrinter(printerName, out printer, IntPtr.Zero)) ThrowLastError("OpenPrinter");
            if (StartDocPrinter(printer, 1, new DOC_INFO_1()) == 0) ThrowLastError("StartDocPrinter");
            documentStarted = true;
            if (!StartPagePrinter(printer)) ThrowLastError("StartPagePrinter");
            pageStarted = true;

            unmanaged = Marshal.AllocCoTaskMem(data.Length);
            Marshal.Copy(data, 0, unmanaged, data.Length);
            int offset = 0;
            while (offset < data.Length)
            {
                int written;
                IntPtr cursor = new IntPtr(unmanaged.ToInt64() + offset);
                if (!WritePrinter(printer, cursor, data.Length - offset, out written)) ThrowLastError(offset > 0 ? "WritePrinterPartial" : "WritePrinter");
                if (written <= 0) throw new Win32Exception("WritePrinter wrote zero bytes.");
                offset += written;
            }
            completed = true;
        }
        finally
        {
            if (unmanaged != IntPtr.Zero) Marshal.FreeCoTaskMem(unmanaged);
            if (pageStarted && completed) EndPagePrinter(printer);
            if (documentStarted)
            {
                if (completed) EndDocPrinter(printer);
                else AbortPrinter(printer);
            }
            if (printer != IntPtr.Zero) ClosePrinter(printer);
        }
    }
}
`.trim();

function sendRawScript(tempFilePath, printerName) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$queue = @(Get-CimInstance -ClassName Win32_Printer -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq ${psQuote(printerName)} }) | Select-Object -First 1`,
    "if ($null -ne $queue -and ($queue.WorkOffline -eq $true -or [int]$queue.PrinterStatus -eq 7)) { throw 'printer_offline' }",
    `Add-Type -TypeDefinition @'\n${RAW_PRINT_CSHARP}\n'@ -Language CSharp`,
    `$bytes = [IO.File]::ReadAllBytes(${psQuote(tempFilePath)})`,
    `[CafePosNativePrinter]::Send(${psQuote(printerName)}, $bytes)`,
  ].join("\r\n");
}

function classifyWindowsSendError(message) {
  const text = String(message || "").toLowerCase();
  if (text.includes("openprinter") || text.includes("invalid printer") || text.includes("printer name") || text.includes("printer_not_found")) {
    return "printer_not_found";
  }
  if (text.includes("printer_offline") || text.includes("workoffline") || text.includes("offline")) {
    return "printer_offline";
  }
  if (text.includes("powershell timed out") || text.includes("writeprinterpartial") || text.includes("write_ambiguous")) {
    return "job_timeout";
  }
  if (text.includes("writeprinter") || text.includes("print_document_ambiguous") || text.includes("printdocument.print")) {
    return "print_failed";
  }
  if (text.includes("startdocprinter") || text.includes("startpageprinter") || text.includes("spooler")) {
    return "spooler_rejected";
  }
  return "print_failed";
}

/** Deliver raw ESC/POS bytes to an installed Windows queue — no connector, no network hop. */
async function sendRawBytesToWindowsPrinter(printerName, bytes, { run = runPowerShell, tmpdir = os.tmpdir() } = {}) {
  if (!printerName || !String(printerName).trim()) return { ok: false, error: "invalid_printer", detail: "Printer name is required." };
  if (!bytes || bytes.length === 0) return { ok: false, error: "invalid_printer", detail: "Print data is empty." };

  const tempPath = path.join(tmpdir, `cafe-pos-native-print-${crypto.randomBytes(8).toString("hex")}.bin`);
  await fs.promises.writeFile(tempPath, bytes);
  try {
    await run(sendRawScript(tempPath, printerName));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: classifyWindowsSendError(error.message), detail: error.message };
  } finally {
    fs.promises.unlink(tempPath).catch(() => {});
  }
}

/* ─────────────────────────── network printers ─────────────────────────── */

function classifyNetworkError(error) {
  const code = error && error.code;
  if (code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return "network_unreachable";
  }
  const message = String((error && error.message) || "").toLowerCase();
  if (message.includes("timed out") || message.includes("refused") || message.includes("unreachable")) {
    return "network_unreachable";
  }
  return "print_failed";
}

/** Is a raw-print TCP port (9100 by convention) answering at this address? */
function probeNetworkPrinter(ip, port = 9100, { timeoutMs = 2000, connect = net.createConnection } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let socket;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { socket?.destroy(); } catch { /* already gone */ }
      resolve(result);
    };
    try {
      socket = connect({ host: ip, port, timeout: timeoutMs });
    } catch (error) {
      finish({ ok: true, reachable: false, detail: error.message });
      return;
    }
    socket.once("connect", () => finish({ ok: true, reachable: true }));
    socket.once("timeout", () => finish({ ok: true, reachable: false, detail: "The connection timed out." }));
    socket.once("error", (error) => finish({ ok: true, reachable: false, detail: error.message }));
  });
}

/** Deliver raw ESC/POS bytes to a LAN/Wi-Fi ESC/POS printer over TCP — no connector needed. */
function sendRawBytesToNetworkPrinter(ip, port, bytes, { timeoutMs = 15_000, connect = net.createConnection } = {}) {
  return new Promise((resolve) => {
    if (!bytes || bytes.length === 0) {
      resolve({ ok: false, error: "invalid_printer", detail: "Print data is empty." });
      return;
    }
    let settled = false;
    let writeStarted = false;
    let socket;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { socket?.destroy(); } catch { /* already gone */ }
      resolve(result);
    };
    try {
      socket = connect({ host: ip, port: port || 9100, timeout: timeoutMs });
    } catch (error) {
      finish({ ok: false, error: classifyNetworkError(error), detail: error.message });
      return;
    }
    socket.once("connect", () => {
      writeStarted = true;
      socket.write(bytes, (writeError) => {
        if (writeError) {
          finish({ ok: false, error: "job_timeout", detail: `write_ambiguous: ${writeError.message}` });
          return;
        }
        socket.end();
      });
    });
    socket.once("close", () => finish({ ok: true }));
    socket.once("timeout", () => {
      if (writeStarted) {
        finish({
          ok: false,
          error: "job_timeout",
          detail: "write_ambiguous: The connection timed out after sending print data.",
        });
        return;
      }
      finish({ ok: false, error: "network_unreachable", detail: "The connection timed out." });
    });
    socket.once("error", (error) => {
      if (writeStarted) {
        finish({ ok: false, error: "job_timeout", detail: `write_ambiguous: ${error.message}` });
        return;
      }
      finish({ ok: false, error: classifyNetworkError(error), detail: error.message });
    });
  });
}

/** The /24 prefixes this machine sits on — the same subnets a person on this LAN could reach. */
function localSubnets({ listInterfaces = listLanInterfaces } = {}) {
  const prefixes = new Set();
  for (const item of listInterfaces()) {
    const parts = String(item.address || "").split(".");
    if (parts.length === 4) prefixes.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
  }
  return [...prefixes];
}

/**
 * Sweep this machine's own local subnets for an open raw-print port, in
 * bounded concurrency windows — the same idea as the browser connector's
 * `Find-NetworkPrinters`, run here in Node instead of PowerShell because the
 * desktop app already has direct socket access.
 */
async function discoverNetworkPrinters({
  port = 9100,
  timeoutMs = 400,
  concurrency = 64,
  listInterfaces,
  connect,
} = {}) {
  const subnets = localSubnets({ listInterfaces });
  if (subnets.length === 0) return [];

  const targets = [];
  for (const subnet of subnets) {
    for (let host = 1; host <= 254; host += 1) targets.push(`${subnet}.${host}`);
  }

  const found = [];
  for (let index = 0; index < targets.length; index += concurrency) {
    const batch = targets.slice(index, index + concurrency);
    const results = await Promise.all(
      batch.map(async (ip) => {
        const start = Date.now();
        const probe = await probeNetworkPrinter(ip, port, { timeoutMs, connect });
        if (!probe.reachable) return null;
        return { ip, port, latencyMs: Date.now() - start };
      }),
    );
    for (const entry of results) if (entry) found.push(entry);
  }
  return found.sort((a, b) => a.latencyMs - b.latencyMs);
}

/* ─────────────────────────── one entry point ─────────────────────────── */

/** Dispatch a probe by the same `{type, systemName}` / `{type, ip, port}` shape the app already models. */
async function probeTarget(target, opts = {}) {
  if (!target || typeof target !== "object") return { ok: false, error: "invalid_printer" };
  if (target.type === "windows") return probeWindowsPrinter(target.systemName, opts);
  if (target.type === "network") return probeNetworkPrinter(target.ip, target.port || 9100, opts);
  return { ok: false, error: "invalid_printer" };
}

/**
 * Silent page print: draw a PNG through the Windows driver with
 * StandardPrintController so no print dialog appears. Returns when the
 * spooler accepts the job, not when paper finishes.
 */
function sendPageScript(tempFilePath, printerName, pageGeometry) {
  if (pageGeometry && (!Number.isFinite(pageGeometry.widthMm) || !Number.isFinite(pageGeometry.heightMm) ||
      pageGeometry.widthMm < 25 || pageGeometry.widthMm > 500 || pageGeometry.heightMm < 25 || pageGeometry.heightMm > 500)) throw new Error("invalid_printer");
  const width = pageGeometry ? Math.round(pageGeometry.widthMm * 100 / 25.4) : 0;
  const height = pageGeometry ? Math.round(pageGeometry.heightMm * 100 / 25.4) : 0;
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'Stop'",
    `$queue = @(Get-CimInstance -ClassName Win32_Printer -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq ${psQuote(printerName)} }) | Select-Object -First 1`,
    "if ($null -ne $queue -and ($queue.WorkOffline -eq $true -or [int]$queue.PrinterStatus -eq 7)) { throw 'printer_offline' }",
    "Add-Type -AssemblyName System.Drawing",
    `Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Printing;
public static class CafePosPagePrinter {
  public static void Send(string printerName, string imagePath, int width, int height) {
    if (String.IsNullOrWhiteSpace(printerName)) throw new ArgumentException("printer_not_found");
    using (var image = Image.FromFile(imagePath))
    using (var doc = new PrintDocument()) {
      doc.PrinterSettings.PrinterName = printerName;
      if (!doc.PrinterSettings.IsValid) throw new ArgumentException("printer_not_found");
      doc.PrintController = new StandardPrintController();
      doc.DocumentName = "Eshobe";
      if (width > 0 && height > 0) {
        doc.DefaultPageSettings.PaperSize = new PaperSize("Eshobe", width, height);
        doc.DefaultPageSettings.Margins = new Margins(0, 0, 0, 0);
        doc.DefaultPageSettings.Landscape = false;
      }
      int offset = 0;
      doc.PrintPage += (sender, e) => {
        var bounds = width > 0 ? e.PageBounds : e.MarginBounds;
        if (width > 0) e.Graphics.TranslateTransform(-e.PageSettings.HardMarginX, -e.PageSettings.HardMarginY);
        float scale = bounds.Width / (float)image.Width;
        // Fixed page mm -> CSS px rounding must not create a blank second sheet.
        int slice = width > 0 ? (int)Math.Ceiling(bounds.Height / scale) : (int)(bounds.Height / scale);
        if (slice < 1) slice = image.Height;
        int take = Math.Min(slice, image.Height - offset);
        int destH = (int)Math.Min(bounds.Height, take * scale);
        e.Graphics.DrawImage(image, new Rectangle(bounds.X, bounds.Y, bounds.Width, destH), new Rectangle(0, offset, image.Width, take), GraphicsUnit.Pixel);
        offset += take;
        e.HasMorePages = offset < image.Height;
      };
      try {
        doc.Print();
      } catch (Exception ex) {
        throw new InvalidOperationException("print_document_ambiguous: " + ex.Message, ex);
      }
    }
  }
}
'@`,
    `[CafePosPagePrinter]::Send(${psQuote(printerName)}, ${psQuote(tempFilePath)}, ${width}, ${height})`,
  ].join("\n");
}

async function sendPageToWindowsPrinter(printerName, bytes, { run = runPowerShell, tmpdir = os.tmpdir(), pageGeometry } = {}) {
  if (!printerName || !String(printerName).trim()) return { ok: false, error: "invalid_printer", detail: "Printer name is required." };
  if (!bytes || bytes.length === 0) return { ok: false, error: "invalid_printer", detail: "Print data is empty." };
  const tempPath = path.join(tmpdir, `cafe-pos-page-${crypto.randomBytes(8).toString("hex")}.png`);
  await fs.promises.writeFile(tempPath, bytes);
  try {
    await run(sendPageScript(tempPath, printerName, pageGeometry), { timeoutMs: 45_000 });
    return { ok: true };
  } catch (error) {
    const message = error.message || "";
    const errorCode = /printer_not_found|Invalid printer/i.test(message)
      ? "printer_not_found"
      : /printer_offline|workoffline/i.test(message)
        ? "printer_offline"
        : /powershell timed out/i.test(message)
          ? "job_timeout"
          : /print_document_ambiguous|PrintDocument\.Print/i.test(message)
            ? "print_failed"
            : /pre_handoff_spooler_rejected|StartDocPrinter|StartPagePrinter/i.test(message)
              ? "spooler_rejected"
              : "print_failed";
    return { ok: false, error: errorCode, detail: message };
  } finally {
    fs.promises.unlink(tempPath).catch(() => {});
  }
}

/** Dispatch raw byte delivery by the same target shape. */
async function sendRawToTarget(target, bytes, opts = {}) {
  if (!target || typeof target !== "object") return { ok: false, error: "invalid_printer" };
  if (target.type === "windows") return sendRawBytesToWindowsPrinter(target.systemName, bytes, opts);
  if (target.type === "network") return sendRawBytesToNetworkPrinter(target.ip, target.port || 9100, bytes, opts);
  return { ok: false, error: "invalid_printer" };
}

module.exports = {
  likelyThermalName,
  listWindowsPrintersScript,
  parseWindowsPrinterListJson,
  listWindowsPrinters,
  probeWindowsPrinter,
  sendRawScript,
  classifyWindowsSendError,
  sendRawBytesToWindowsPrinter,
  classifyNetworkError,
  probeNetworkPrinter,
  sendRawBytesToNetworkPrinter,
  localSubnets,
  discoverNetworkPrinters,
  probeTarget,
  sendRawToTarget,
  sendPageScript,
  sendPageToWindowsPrinter,
  runPowerShell,
};
