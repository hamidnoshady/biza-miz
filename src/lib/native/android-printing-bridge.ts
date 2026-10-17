/**
 * Adapter that bridges Biza Miz's canonical printing client (`src/lib/printing/client.ts`)
 * to the Android TWA `printer.discover` and `printer.print` commands (issue #884).
 *
 * By implementing `DesktopPrintingBridge`, every existing Biza Miz print flow
 * (`printSaleReceipt`, `printSaleInvoice`, `printKitchenTicket`, `printLabel`,
 * `printTemplateSample`, `testPrintDraft`) reuses the server-rendered templates,
 * routing rules, and job history without a second print template engine.
 *
 * Bluetooth permissions are requested ONLY when the user explicitly triggers
 * Bluetooth discovery (`requestBluetoothPermission: true`) or prints to a
 * `bt:` printer target.
 */
import type { DesktopDiscoveredPrinter, DesktopPrintingBridge, DesktopWindowsPrinter } from "../desktop-bridge";
import type { PrinterTarget } from "../printing/types";
import type { NativePrinterDiscoverResult, NativePrinterPrintResult, NativePrinterTransport } from "./bridge-contract";
import type { NativeRequest } from "@/components/native/native-provider";

export interface AndroidPrintingBridge extends DesktopPrintingBridge {
  discoverAndroidPrinters(options?: {
    requestBluetoothPermission?: boolean;
    includeNetwork?: boolean;
  }): Promise<NativePrinterDiscoverResult>;
  printAndroidDocument(input: {
    transport: NativePrinterTransport;
    targetAddress: string | null;
    dataBase64: string;
    delivery: "raw" | "page";
    jobName?: string;
    paperWidthMm?: 58 | 80 | 210;
  }): Promise<NativePrinterPrintResult>;
}

let activeAndroidPrintingBridge: AndroidPrintingBridge | null = null;

export function getActiveAndroidPrintingBridge(): AndroidPrintingBridge | null {
  return activeAndroidPrintingBridge;
}

export function setActiveAndroidPrintingBridge(bridge: AndroidPrintingBridge | null): void {
  activeAndroidPrintingBridge = bridge;
}

function parseHostPort(address: string | null): { ip: string; port: number } | null {
  if (!address) return null;
  const idx = address.lastIndexOf(":");
  if (idx <= 0) return { ip: address, port: 9100 };
  const ip = address.slice(0, idx);
  const port = Number(address.slice(idx + 1)) || 9100;
  return { ip, port };
}

export function createAndroidPrintingBridge(request: NativeRequest): AndroidPrintingBridge {
  async function discoverAndroidPrinters(
    options: { requestBluetoothPermission?: boolean; includeNetwork?: boolean } = {},
  ): Promise<NativePrinterDiscoverResult> {
    return request("printer.discover", {
      requestBluetoothPermission: options.requestBluetoothPermission === true,
      includeNetwork: options.includeNetwork !== false,
    });
  }

  async function printAndroidDocument(input: {
    transport: NativePrinterTransport;
    targetAddress: string | null;
    dataBase64: string;
    delivery: "raw" | "page";
    jobName?: string;
    paperWidthMm?: 58 | 80 | 210;
  }): Promise<NativePrinterPrintResult> {
    return request("printer.print", {
      transport: input.transport,
      targetAddress: input.targetAddress,
      dataBase64: input.dataBase64,
      delivery: input.delivery,
      jobName: input.jobName ?? "BizaMiz Print Job",
      paperWidthMm: input.paperWidthMm ?? 80,
    });
  }

  return {
    discoverAndroidPrinters,
    printAndroidDocument,

    async listWindowsPrinters() {
      try {
        const discovered = await discoverAndroidPrinters({
          requestBluetoothPermission: false,
          includeNetwork: false,
        });
        const printers: DesktopWindowsPrinter[] = discovered.printers
          .filter((p) => p.transport !== "network_tcp")
          .map((p) => ({
            name: p.id,
            driver: `${p.name} (${p.transport})`,
            isDefault: p.transport === "system_print",
            likelyThermal: p.paperWidthMm <= 80,
          }));
        return { ok: true, printers };
      } catch (err) {
        return {
          ok: false,
          error: "print_failed",
          detail: err instanceof Error ? err.message : "android_printer_discovery_failed",
        };
      }
    },

    async discoverNetworkPrinters() {
      try {
        const discovered = await discoverAndroidPrinters({
          requestBluetoothPermission: false,
          includeNetwork: true,
        });
        const printers: DesktopDiscoveredPrinter[] = [];
        for (const p of discovered.printers) {
          if (p.transport !== "network_tcp") continue;
          const parsed = parseHostPort(p.address);
          if (!parsed) continue;
          printers.push({
            ip: parsed.ip,
            port: parsed.port,
            latencyMs: 12,
          });
        }
        return { ok: true, printers };
      } catch (err) {
        return {
          ok: false,
          error: "print_failed",
          detail: err instanceof Error ? err.message : "android_network_discovery_failed",
        };
      }
    },

    async probe(target: PrinterTarget) {
      try {
        const systemName = target.type === "windows" ? (target.systemName ?? "") : "";
        const isBluetooth = target.type === "windows" && systemName.startsWith("bt:");
        const discovered = await discoverAndroidPrinters({
          requestBluetoothPermission: isBluetooth,
          includeNetwork: target.type === "network",
        });
        if (target.type === "network") {
          const expected = `${target.ip}:${target.port}`;
          const match = discovered.printers.find(
            (p) => p.transport === "network_tcp" && (p.address === expected || p.address === target.ip),
          );
          return {
            ok: true,
            reachable: match ? match.online : true,
          };
        }
        const match = discovered.printers.find(
          (p) => p.id === systemName || p.name === systemName,
        );
        return {
          ok: true,
          reachable: match ? match.online : systemName === "system_print" || systemName === "pdf_share",
        };
      } catch (err) {
        return {
          ok: false,
          reachable: false,
          error: "printer_offline",
          detail: err instanceof Error ? err.message : "android_probe_failed",
        };
      }
    },

    async sendRaw(target: PrinterTarget, dataBase64: string) {
      try {
        const systemName = target.type === "windows" ? (target.systemName ?? "") : "";
        const transport: NativePrinterTransport =
          target.type === "network"
            ? "network_tcp"
            : systemName.startsWith("bt:")
              ? "bluetooth"
              : systemName === "pdf_share"
                ? "pdf_share"
                : "system_print";
        const targetAddress =
          target.type === "network" ? `${target.ip}:${target.port}` : (systemName || null);
        const result = await printAndroidDocument({
          transport,
          targetAddress,
          dataBase64,
          delivery: "raw",
        });
        if (!result.printed) {
          return { ok: false, error: "print_failed", detail: "android_print_not_completed" };
        }
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: target.type === "network" ? "network_unreachable" : "print_failed",
          detail: err instanceof Error ? err.message : "android_raw_print_failed",
        };
      }
    },

    async sendPage(printerName: string, dataBase64: string) {
      try {
        const transport: NativePrinterTransport = printerName.startsWith("bt:")
          ? "bluetooth"
          : printerName === "pdf_share"
            ? "pdf_share"
            : "system_print";
        const result = await printAndroidDocument({
          transport,
          targetAddress: printerName,
          dataBase64,
          delivery: "page",
          paperWidthMm: 210,
        });
        if (!result.printed) {
          return { ok: false, error: "spooler_rejected", detail: "android_page_print_not_completed" };
        }
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: "spooler_rejected",
          detail: err instanceof Error ? err.message : "android_page_print_failed",
        };
      }
    },
  };
}
