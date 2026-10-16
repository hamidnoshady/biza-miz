import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONNECTOR_RELEASE, CONNECTOR_PROTOCOL_VERSION } from "./printing/connector-release";
import {
  buildWindowsPrintConnectorInstaller,
  CONNECTOR_PAYLOAD_MARKER,
  type WindowsPrintConnectorInstallSpec,
} from "./windows-print-connector";

const connectorSource = readFileSync(
  join(process.cwd(), "public/windows/cafe-pos-print-connector.ps1"),
  "utf8",
);

function specFor(overrides: Partial<WindowsPrintConnectorInstallSpec> = {}): WindowsPrintConnectorInstallSpec {
  return {
    allowedOrigins: ["https://cafe.example.com"],
    downloadUrl: "https://pos.example.com/windows/cafe-pos-print-connector.ps1",
    minVersion: CONNECTOR_PROTOCOL_VERSION,
    release: CONNECTOR_RELEASE,
    ...overrides,
  };
}

describe("Windows print connector installer", () => {
  it("installs per-user, starts immediately, and registers Windows-login startup", () => {
    const installer = buildWindowsPrintConnectorInstaller(specFor());

    expect(installer).toContain("Invoke-WebRequest");
    expect(installer).toContain("$env:LOCALAPPDATA");
    expect(installer).toContain('SpecialFolders.Item("Startup")');
    expect(installer).toContain("Start-Process");
    expect(installer).toContain("http://127.0.0.1:9123/health");
    expect(installer.match(/# CAFE_POS_INSTALLER_PAYLOAD/g)).toHaveLength(1);
  });

  it("pins the connector's CORS policy to the Cafe POS origin, and only that origin", () => {
    const installer = buildWindowsPrintConnectorInstaller(
      specFor({ allowedOrigins: ["https://zaniziba.pos.example.com"] }),
    );
    expect(installer).toContain("$allowedOrigin = 'https://zaniziba.pos.example.com'");
    expect(installer).toContain("-AllowedOrigin");
  });

  it("supports several legitimate origins: the request origin first, aliases after", () => {
    const installer = buildWindowsPrintConnectorInstaller(
      specFor({
        allowedOrigins: ["https://zaniziba.pos.example.com", "https://zaniziba-old.pos.example.com"],
      }),
    );
    expect(installer).toContain("$allowedOrigin = 'https://zaniziba.pos.example.com'");
    expect(installer).toContain("$extraOrigins = @('https://zaniziba-old.pos.example.com')");
    expect(installer).toContain("-AllowedOrigins");
  });

  it("downloads the payload from the resolved download URL — independently of the tenant origin", () => {
    // The zaniziba first-install bug: the download host MUST NOT derive from
    // the tenant origin. This spec names tenant and base that share no host.
    const installer = buildWindowsPrintConnectorInstaller(
      specFor({
        allowedOrigins: ["https://zaniziba.incredible-pos.example"],
        downloadUrl: "https://stable-platform.example/windows/cafe-pos-print-connector.ps1",
      }),
    );
    expect(installer).toContain("$scriptUrl = 'https://stable-platform.example/windows/cafe-pos-print-connector.ps1'");
    // Nothing in the installer may invent a tenant-shaped hostname.
    expect(installer).not.toContain("zaniziba.incredible-pos.example/windows");
    expect(installer).not.toMatch(/zaniziba\.app\./);
  });

  it("escapes values before embedding them in PowerShell", () => {
    const installer = buildWindowsPrintConnectorInstaller(
      specFor({ allowedOrigins: ["https://example.com", "https://o'clock.example"] }),
    );
    expect(installer).toContain("https://o''clock.example");
    expect(installer).not.toContain("o'clock");
  });

  it("rejects non-HTTP origins and download URLs", () => {
    expect(() => buildWindowsPrintConnectorInstaller(specFor({ allowedOrigins: ["file:///tmp/app"] }))).toThrow(
      "unsupported_installer_origin",
    );
    expect(() => buildWindowsPrintConnectorInstaller(specFor({ allowedOrigins: [] }))).toThrow(
      "unsupported_installer_origin",
    );
    expect(() => buildWindowsPrintConnectorInstaller(specFor({ downloadUrl: "file:///tmp/x.ps1" }))).toThrow(
      "unsupported_connector_download_url",
    );
  });

  it("downloads with bounded retries and a classified failure instead of a raw exception", () => {
    const installer = buildWindowsPrintConnectorInstaller(specFor());
    expect(installer).toContain("function Invoke-ConnectorDownload");
    expect(installer).toContain("-Attempts 3");
    expect(installer).toContain("-TimeoutSeconds 30");
    // Error classification for the friendly dialog.
    expect(installer).toContain("function Get-DownloadFailure");
    expect(installer).toContain("DNS lookup failed.");
    expect(installer).toContain("timed out");
    // The failure dialog names the server and keeps technical detail in a log.
    expect(installer).toContain("Cafe POS could not download the Windows Print Connector.");
    expect(installer).toContain("install.log");
  });

  it("logs diagnostics to the install directory without secrets", () => {
    const installer = buildWindowsPrintConnectorInstaller(specFor());
    expect(installer).toContain("function Write-InstallLog");
    expect(installer).toContain("install.log");
    expect(installer).toContain("OSVersion");
    // There are no credentials in an installer, and none may appear in the log either.
    expect(installer).not.toContain("authorization");
    expect(installer).not.toContain("cookie");
  });

  it("verifies the downloaded connector instead of running whatever answered", () => {
    const installer = buildWindowsPrintConnectorInstaller(
      specFor({ expectedSha256: "AB12CD34", expectedMinBytes: 20000 }),
    );
    // Marker + HTML rejection + size window + PowerShell parse…
    expect(installer).toContain("function Test-ConnectorPayload");
    expect(installer).toContain("<html|<!doctype");
    expect(installer).toContain("$expectedMinBytes = 20000");
    expect(installer).toContain("PSParser");
    // …and the SHA-256 pin when the deployment can vouch for the payload bytes.
    expect(installer).toContain("$expectedSha256 = 'AB12CD34'");
    expect(installer).toContain("Get-FileHash");
  });

  it("a plain spec without a hash still runs the structural checks", () => {
    const installer = buildWindowsPrintConnectorInstaller(specFor());
    expect(installer).toContain(`$expectedSha256 = ''`);
    expect(installer).toContain("Test-ConnectorPayload");
  });

  it("handles a port conflict by identifying the owner, not by telling the user to guess", () => {
    const installer = buildWindowsPrintConnectorInstaller(specFor());
    expect(installer).toContain("function Get-PortOwner");
    expect(installer).toContain("Get-NetTCPConnection");
    expect(installer).toContain("function Get-ProcessSummary");
    expect(installer).toContain("Another program is already using the connector port");
  });

  it("only ever kills processes that are verifiably Cafe POS connectors", () => {
    const installer = buildWindowsPrintConnectorInstaller(specFor());
    expect(installer).toContain("Stop-RunningConnector");
    expect(installer).toContain('CommandLine -like "*cafe-pos-print-*"');
    // The installer's own PowerShell process is explicitly excluded.
    expect(installer).toContain("$_.ProcessId -ne $PID");
  });

  it("reinstalling is the upgrade path: it stops the current connector and the older print agent", () => {
    const installer = buildWindowsPrintConnectorInstaller(specFor());
    expect(installer).toContain("Stop-RunningConnector");
    expect(installer).toContain('"connector.pid"');
    expect(installer).toContain('"agent.pid"');
    expect(installer).toContain('"cafe-pos-print-connector.ps1"');
    expect(installer).toContain('"cafe-pos-print-agent.ps1"');
    expect(installer).toContain('cafe-pos-print-agent.ps1") -Force');
    // The health gate accepts only a current connector for one of OUR origins.
    expect(installer).toContain("$reportedVersion -lt $minVersion");
  });

  it("explains a connector already running for a different Cafe POS address", () => {
    const installer = buildWindowsPrintConnectorInstaller(specFor());
    expect(installer).toContain("A Cafe POS Print Connector for a different address is already running");
    expect(installer).toMatch(/\$health\.allowedOrigins/);
  });
});

describe("the dependency-free Windows print connector", () => {
  it("carries the payload marker the installer verifies", () => {
    expect(connectorSource.startsWith(CONNECTOR_PAYLOAD_MARKER)).toBe(true);
  });

  it("reports the shared protocol version and release", () => {
    expect(connectorSource).toContain("version = 3");
    expect(connectorSource).toContain(`release = "${CONNECTOR_RELEASE}"`);
  });

  it("binds only to loopback and restricts browser requests to the installed origin(s)", () => {
    expect(connectorSource).toContain("[Net.IPAddress]::Loopback");
    expect(connectorSource).toContain("$originSet.ContainsKey($origin)");
    expect(connectorSource).toContain("Access-Control-Allow-Origin: $RequestOrigin");
    expect(connectorSource).not.toContain("IPAddress]::Any");
    // Never a wildcard CORS: local printer access is not for arbitrary websites.
    expect(connectorSource).not.toContain("Access-Control-Allow-Origin: *");
  });

  it("accepts the primary origin plus additional validated origins", () => {
    expect(connectorSource).toContain("[string[]]$AllowedOrigins = @()");
    expect(connectorSource).toContain("function ConvertTo-NormalizedOrigin");
    expect(connectorSource).toContain("allowedOrigins = $AllowedOriginList");
  });

  it("enumerates Windows queues and writes RAW data through the native spooler", () => {
    expect(connectorSource).toContain("Win32_Printer");
    expect(connectorSource).toContain("driver = [string]$printer.DriverName");
    expect(connectorSource).toContain("port = [string]$printer.PortName");
    expect(connectorSource).toContain("likelyThermal = [bool]");
    expect(connectorSource).toContain('DllImport("winspool.drv"');
    expect(connectorSource).toContain("OpenPrinter");
    expect(connectorSource).toContain("WritePrinter");
    expect(connectorSource).not.toMatch(/npm\s+(?:ci|install)/i);
    expect(connectorSource).not.toContain("node.exe");
  });

  it("addresses printers only through the canonical target shape", () => {
    expect(connectorSource).toContain('-Name "target"');
    expect(connectorSource).toContain('-Name "type"');
    expect(connectorSource).toContain('-Name "systemName"');
    expect(connectorSource).toContain('-Name "ip"');
    expect(connectorSource).not.toContain('-Name "connection"');
    expect(connectorSource).not.toContain("systemPrinterName");
  });

  it("speaks the one coherent protocol: health, windows list, network discovery, probe, raw", () => {
    expect(connectorSource).toContain('"/health"');
    expect(connectorSource).toContain('"/printers/windows"');
    expect(connectorSource).toContain('"/printers/network/discover"');
    expect(connectorSource).toContain('"/printers/probe"');
    expect(connectorSource).toContain('"/print/raw"');
    expect(connectorSource).not.toContain('"/printers/system"');
    expect(connectorSource).not.toContain('"/printers/scan"');
    expect(connectorSource).not.toContain("render_required");
    expect(connectorSource).not.toContain('/print/" -like');
  });

  it("health reports what an installer or the app needs to decide with", () => {
    expect(connectorSource).toContain("allowedOrigins = $AllowedOriginList");
    expect(connectorSource).toContain("release = ");
    expect(connectorSource).toContain("printSubsystem");
    expect(connectorSource).toContain("spooler");
  });

  it("discovers network printers locally: local subnets, bounded windows, port 9100", () => {
    expect(connectorSource).toContain("function Get-LocalSubnets");
    expect(connectorSource).toContain("NetworkInterfaceType]::Loopback");
    expect(connectorSource).toContain("169.254.*");
    expect(connectorSource).toContain("function Find-NetworkPrinters");
    expect(connectorSource).toContain("ConnectAsync");
    expect(connectorSource).toContain("$Concurrency");
    expect(connectorSource).toContain("latencyMs");
    // Only the raw-print port is swept; fallback ports stay out of the scan.
    expect(connectorSource).toMatch(/\$TargetPort = 9100/);
    expect(connectorSource).not.toContain("9101");
    expect(connectorSource).not.toContain("515");
  });

  it("returns canonical error codes, not raw exceptions", () => {
    expect(connectorSource).toContain('"printer_not_found"');
    expect(connectorSource).toContain('"network_unreachable"');
    expect(connectorSource).toContain('"invalid_target"');
    expect(connectorSource).toContain('"print_failed"');
  });

  it("logs startup, print attempts and failures without receipt content", () => {
    expect(connectorSource).toContain("Connector v3 (release");
    expect(connectorSource).toContain('Write-ConnectorLog ("Printed " + $bytes.Length + " bytes to "');
  });

  it("classifies WritePrinter, PrintDocument.Print, and unknown failures as ambiguous and aborts incomplete raw documents", () => {
    expect(connectorSource).toContain("AbortPrinter");
    expect(connectorSource).toContain("print_document_ambiguous:");
    expect(connectorSource).toContain("ambiguous = $ambiguous");
  });
});
