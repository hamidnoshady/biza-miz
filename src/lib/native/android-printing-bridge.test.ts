import { describe, expect, it, vi } from "vitest";
import { createAndroidPrintingBridge } from "./android-printing-bridge";
import type { NativeRequest } from "@/components/native/native-provider";

describe("createAndroidPrintingBridge", () => {
  it("discovers system and Bluetooth printers without requesting Bluetooth permissions by default", async () => {
    const request = vi.fn(async () => ({
      printers: [
        {
          id: "system_print",
          name: "Android Print Manager",
          transport: "system_print" as const,
          address: null,
          paperWidthMm: 80 as const,
          online: true,
        },
        {
          id: "bt:AA:BB:CC:DD:EE:FF",
          name: "Bixolon SPP-R200III",
          transport: "bluetooth" as const,
          address: "AA:BB:CC:DD:EE:FF",
          paperWidthMm: 58 as const,
          online: true,
        },
      ],
      bluetoothPermission: "granted" as const,
    })) as unknown as NativeRequest;

    const bridge = createAndroidPrintingBridge(request);
    const res = await bridge.listWindowsPrinters();
    expect(res.ok).toBe(true);
    expect(res.printers).toEqual([
      {
        name: "system_print",
        driver: "Android Print Manager (system_print)",
        isDefault: true,
        likelyThermal: true,
      },
      {
        name: "bt:AA:BB:CC:DD:EE:FF",
        driver: "Bixolon SPP-R200III (bluetooth)",
        isDefault: false,
        likelyThermal: true,
      },
    ]);
    expect(request).toHaveBeenCalledWith("printer.discover", {
      requestBluetoothPermission: false,
      includeNetwork: false,
    });
  });

  it("routes raw ESC/POS bytes to network TCP and Bluetooth printers via printer.print", async () => {
    const request = vi.fn(async () => ({
      printed: true,
      transport: "network_tcp" as const,
      jobId: "job-101",
      bytesSent: 64,
    })) as unknown as NativeRequest;

    const bridge = createAndroidPrintingBridge(request);
    const networkRes = await bridge.sendRaw({ type: "network", ip: "192.168.1.50", port: 9100 }, "AQID");
    expect(networkRes.ok).toBe(true);
    expect(request).toHaveBeenCalledWith(
      "printer.print",
      expect.objectContaining({
        transport: "network_tcp",
        targetAddress: "192.168.1.50:9100",
        dataBase64: "AQID",
        delivery: "raw",
      }),
    );

    const btRes = await bridge.sendRaw({ type: "windows", systemName: "bt:AA:BB:CC:DD:EE:FF" }, "BAUG");
    expect(btRes.ok).toBe(true);
    expect(request).toHaveBeenCalledWith(
      "printer.print",
      expect.objectContaining({
        transport: "bluetooth",
        targetAddress: "bt:AA:BB:CC:DD:EE:FF",
        dataBase64: "BAUG",
        delivery: "raw",
      }),
    );
  });
});
