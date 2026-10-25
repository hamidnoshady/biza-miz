/**
 * One-click Windows connector end-to-end contract. The pieces of the new
 * architecture that must stay aligned across separately-deployed files:
 *
 *  - browser client ↔ connector protocol: the same endpoint names and the
 *    same target shape, in both src/lib/printing/client.ts and
 *    public/windows/cafe-pos-print-connector.ps1;
 *  - installer ↔ connector: the installer downloads the connector file that
 *    actually exists in public/windows and accepts only a v3+ health answer;
 *  - UI: the printer screens never expose a legacy transport, WebUSB, a raw
 *    USB path, or a manual IP outside Advanced settings — and the setup
 *    wizard embeds the SAME printer panel Settings uses.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONNECTOR_PROTOCOL_VERSION, CONNECTOR_RELEASE } from "./printing/connector-release";
import { buildWindowsPrintConnectorInstaller } from "./windows-print-connector";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

/** The spec a tenant at https://shop.example.com receives when the platform base is the same origin. */
function installerFor(origin: string, downloadBase?: string): string {
  return buildWindowsPrintConnectorInstaller({
    allowedOrigins: [origin],
    downloadUrl: `${downloadBase ?? origin}/windows/cafe-pos-print-connector.ps1`,
    minVersion: CONNECTOR_PROTOCOL_VERSION,
    release: CONNECTOR_RELEASE,
  });
}

const connector = source("public/windows/cafe-pos-print-connector.ps1");
const client = source("src/lib/printing/client.ts");
const addFlow = source("src/app/(app)/settings/printing/add-printer-flow.tsx");
const printersPanel = source("src/app/(app)/settings/printing/printers-panel.tsx");
const setupHardware = source("src/app/setup/hardware/page.tsx");

describe("browser ↔ connector protocol alignment", () => {
  it("speaks the same five endpoints", () => {
    for (const endpoint of ["/health", "/printers/windows", "/printers/network/discover", "/printers/probe", "/print/raw"]) {
      expect(client, `browser client is missing ${endpoint}`).toContain(`"${endpoint}"`);
      expect(connector, `Windows connector is missing ${endpoint}`).toContain(`"${endpoint}"`);
    }
  });

  it("addresses printers through the same canonical target shape", () => {
    // The wire fields both sides must spell identically.
    for (const field of ["target", "type", "ip", "port", "dataBase64"]) {
      expect(client, `browser client is missing ${field}`).toContain(field);
      expect(connector, `Windows connector is missing ${field}`).toContain(field);
    }
    // The Windows queue name field, and the model both sides share it from.
    expect(connector).toContain('-Name "systemName"');
    expect(source("src/lib/printing/types.ts")).toContain("systemName?: string");
    // The full saved connection never travels to the connector.
    expect(connector).not.toContain('-Name "connection"');
    expect(connector).not.toContain('-Name "transport"');
  });

  it("the client knows the connector's protocol version", () => {
    expect(client).toContain("CONNECTOR_PROTOCOL_VERSION");
    expect(connector).toContain("version = 3");
    expect(CONNECTOR_PROTOCOL_VERSION).toBe(3);
  });

  it("the client and the connector agree on the release identifier", () => {
    expect(connector).toContain(`release = "${CONNECTOR_RELEASE}"`);
  });
});

describe("installer ↔ connector alignment", () => {
  it("extracts a complete PowerShell setup payload from the downloaded command file", () => {
    const commandFile = installerFor("https://shop.example.com");
    const marker = "# CAFE_POS_INSTALLER_PAYLOAD";
    const markerOffset = commandFile.indexOf(marker);

    expect(markerOffset).toBeGreaterThan(0);
    expect(commandFile.indexOf(marker, markerOffset + marker.length)).toBe(-1);
    const payload = commandFile.slice(markerOffset + marker.length);
    expect(payload).toContain("$allowedOrigin = 'https://shop.example.com'");
    expect(payload).toContain("Invoke-WebRequest");
    expect(payload).toContain('SpecialFolders.Item("Startup")');
    expect(payload).toContain("Start-Process");
    expect(payload).toContain("http://127.0.0.1:9123/health");
    expect(payload).toContain("cafe-pos-print-connector.ps1");
    expect(payload.trimEnd()).toMatch(/exit 1\s*}\s*$/);
  });

  it("the installer verifies the payload with the marker the connector file carries", () => {
    const installer = installerFor("https://shop.example.com");
    expect(installer).toContain("$payloadMarker = '# CAFE_POS_PRINT_CONNECTOR_V3'");
    expect(connector.startsWith("# CAFE_POS_PRINT_CONNECTOR_V3")).toBe(true);
  });

  it("the installer's download URL matches the file served from public/windows", () => {
    const installer = installerFor("https://shop.example.com");
    expect(installer).toContain("/windows/cafe-pos-print-connector.ps1");
    expect(connector).toContain("Bizamiz Windows Print Connector (protocol v3)");
  });

  it("the installer's health gate accepts the protocol the connector reports", () => {
    const installer = installerFor("https://shop.example.com");
    expect(installer).toContain("$minVersion = 3");
    expect(connector).toContain("version = 3");
  });
});

describe("printer UI contract — the product rule", () => {
  it("offers exactly the two hardware choices, in the user's language", () => {
    expect(addFlow).toContain("چاپگر ویندوز");
    expect(addFlow).toContain("چاپگر شبکه");
    expect(addFlow).toContain("چاپگر کجاست");
  });

  it("never shows a legacy transport, WebUSB, or a raw USB path", () => {
    for (const ui of [addFlow, printersPanel, setupHardware]) {
      expect(ui).not.toContain("webusb");
      expect(ui).not.toContain("WebUSB");
      expect(ui).not.toContain("devicePath");
      expect(ui).not.toContain("USB001");
      expect(ui).not.toContain("/dev/usb/lp0");
      expect(ui).not.toContain("transport");
      expect(ui).not.toContain("render_required");
      expect(ui).not.toContain("npm run print-agent");
    }
  });

  it("keeps manual IP/port behind Advanced, never on the happy path", () => {
    // The manual form renders only inside the «چاپگرتان پیدا نشد؟» expansion.
    expect(addFlow).toContain("چاپگرتان پیدا نشد؟");
    expect(addFlow).toContain("اتصال پیشرفته");
    const manualForm = addFlow.slice(addFlow.indexOf("function ManualNetworkForm"));
    expect(manualForm).toContain("نشانی IP");
    expect(manualForm).toContain("۹۱۰۰");
    // And the discovery list itself shows plain IPs, no ports or latency.
    const networkStep = addFlow.slice(addFlow.indexOf("function NetworkStep"), addFlow.indexOf("function ManualNetworkForm"));
    expect(networkStep).not.toContain("latencyMs");
    expect(networkStep).not.toContain("پورت");
  });

  it("tests before saving — the wizard's save runs the test print first", () => {
    expect(addFlow).toContain("چاپ آزمایشی و ذخیره");
    expect(addFlow).toContain("testPrintDraft");
    expect(addFlow).toContain("ذخیره بدون آزمایش");
  });

  it("the setup wizard embeds the SAME printer panel Settings uses", () => {
    expect(setupHardware).toContain('from "@/app/(app)/settings/printing/printers-panel"');
    expect(setupHardware).toContain("<PrintersPanel");
    expect(setupHardware).not.toContain("addPrinter");
    expect(setupHardware).not.toContain("escpos-stub");
    expect(setupHardware).not.toContain("فاز ۵");
    expect(setupHardware).not.toContain("شبیه‌سازی");
  });

  it("the connector install card offers the authenticated installer download", () => {
    const connectorCard = source("src/app/(app)/settings/printing/connector-status.tsx");
    expect(connectorCard).toContain('href="/api/printing/connector/installer"');
    expect(connectorCard).toContain("راه‌اندازی سرویس چاپ");
    // The operator is never asked to understand an "agent".
    expect(connectorCard).not.toContain("عامل چاپ");
  });
});
