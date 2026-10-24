/**
 * Issue #1001 — print IPC is not a raw TCP primitive.
 *
 * The desktop app prints to saved network ESC/POS printers directly from the
 * main process, which is the point. What it must not do is dial any address and
 * port a renderer names: loopback services (the app's own server, PostgreSQL),
 * public hosts, or an arbitrary port. These cases pin the narrowing — RFC1918 on
 * a local subnet, the raw-print port allow-list, and the payload cap — plus the
 * fact that a refusal uses an error code the existing UI already renders.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  ALLOWED_NETWORK_PRINT_PORTS,
  MAX_RAW_PAYLOAD_BYTES,
  ipInInterfaceSubnet,
  validatePrintTarget,
  readPrintPayload,
} = require("../../electron/print-target-guard.js") as {
  ALLOWED_NETWORK_PRINT_PORTS: number[];
  MAX_RAW_PAYLOAD_BYTES: number;
  ipInInterfaceSubnet: (ip: string, item: { address: string; netmask?: string }) => boolean;
  validatePrintTarget: (
    target: unknown,
    options?: { listInterfaces?: () => Array<{ address: string; netmask?: string }>; allowedPorts?: number[] },
  ) => { ok: boolean; target?: { type: string; ip?: string; port?: number; systemName?: string }; error?: string; detail?: string };
  readPrintPayload: (data: string, options?: { maxBytes?: number }) => { ok: boolean; bytes?: Buffer; error?: string; detail?: string };
};

// The café's own LAN: 192.168.1.0/24 and a 10.20.0.0/16 branch segment.
const INTERFACES = [
  { address: "192.168.1.24", netmask: "255.255.255.0" },
  { address: "10.20.5.10", netmask: "255.255.0.0" },
];
const local = { listInterfaces: () => INTERFACES };

describe("validatePrintTarget", () => {
  it("accepts a saved network printer on this machine's own subnet", () => {
    expect(validatePrintTarget({ type: "network", ip: "192.168.1.45", port: 9100 }, local)).toEqual({
      ok: true,
      target: { type: "network", ip: "192.168.1.45", port: 9100 },
    });
    expect(validatePrintTarget({ type: "network", ip: "10.20.31.7" }, local)).toEqual({
      ok: true,
      target: { type: "network", ip: "10.20.31.7", port: 9100 },
    });
  });

  it("accepts a Windows queue by name (the spooler is the OS boundary)", () => {
    expect(validatePrintTarget({ type: "windows", systemName: "  EPSON TM-T88VI  " }, local)).toEqual({
      ok: true,
      target: { type: "windows", systemName: "EPSON TM-T88VI" },
    });
    expect(validatePrintTarget({ type: "windows", systemName: "   " }, local).ok).toBe(false);
  });

  it("refuses loopback, public, link-local and malformed addresses", () => {
    for (const ip of ["127.0.0.1", "0.0.0.0", "8.8.8.8", "169.254.10.10", "172.32.0.1", "192.168.1", "192.168.1.1.1", "localhost"]) {
      const result = validatePrintTarget({ type: "network", ip, port: 9100 }, local);
      expect(result.ok, ip).toBe(false);
      expect(result.error, ip).toBe("invalid_printer");
    }
  });

  it("refuses an RFC1918 address that is not on a local subnet", () => {
    // Private, but the coffee-shop Wi-Fi's other customer segment, not ours.
    expect(validatePrintTarget({ type: "network", ip: "192.168.9.20", port: 9100 }, local).ok).toBe(false);
    expect(validatePrintTarget({ type: "network", ip: "10.21.0.5", port: 9100 }, local).ok).toBe(false);
  });

  it("refuses any port outside the raw-print allow-list, and a non-integer port", () => {
    for (const port of [9200, 5432, 3000, 80, 0, -1, 9100.5, 91_000]) {
      expect(validatePrintTarget({ type: "network", ip: "192.168.1.45", port }, local).ok, String(port)).toBe(false);
    }
    for (const port of ALLOWED_NETWORK_PRINT_PORTS) {
      expect(validatePrintTarget({ type: "network", ip: "192.168.1.45", port }, local).ok, String(port)).toBe(true);
    }
    // 9100 by default, never "whatever the OS picks".
    expect(validatePrintTarget({ type: "network", ip: "192.168.1.45" }, local).target).toEqual({
      type: "network",
      ip: "192.168.1.45",
      port: 9100,
    });
    expect(validatePrintTarget({ type: "network", ip: "192.168.1.45", port: null }, local).ok).toBe(true);
  });

  it("refuses an unknown or missing connection type", () => {
    for (const target of [null, undefined, "192.168.1.45", {}, { type: "usb", ip: "192.168.1.45" }]) {
      expect(validatePrintTarget(target, local).ok).toBe(false);
    }
  });

  it("falls back to the interface's /24 when Windows reports no netmask", () => {
    expect(ipInInterfaceSubnet("192.168.1.200", { address: "192.168.1.24" })).toBe(true);
    expect(ipInInterfaceSubnet("192.168.2.200", { address: "192.168.1.24" })).toBe(false);
    expect(ipInInterfaceSubnet("192.168.1.200", { address: "192.168.1.24", netmask: "255.255.255.128" })).toBe(false);
    expect(ipInInterfaceSubnet("nope", { address: "192.168.1.24", netmask: "255.255.255.0" })).toBe(false);
  });
});

describe("readPrintPayload", () => {
  const bytes = Buffer.from([0x1b, 0x40, 0x41]);
  const base64 = bytes.toString("base64");

  it("decodes valid base64 and preserves the bytes", () => {
    const result = readPrintPayload(base64);
    expect(result.ok).toBe(true);
    expect(result.bytes?.equals(bytes)).toBe(true);
  });

  it("refuses empty, non-base64 and oversized payloads", () => {
    expect(readPrintPayload("").ok).toBe(false);
    expect(readPrintPayload(undefined as unknown as string).ok).toBe(false);
    expect(readPrintPayload("@@@@" ).ok).toBe(false);
    expect(readPrintPayload("abc").ok).toBe(false); // not a multiple of 4
    expect(readPrintPayload("A".repeat(MAX_RAW_PAYLOAD_BYTES * 2)).ok).toBe(false);
    expect(readPrintPayload(base64, { maxBytes: 2 }).ok).toBe(false);
  });

  it("checks the declared length before decoding, so a huge string is never buffered", () => {
    const huge = "A".repeat(Math.ceil((MAX_RAW_PAYLOAD_BYTES * 4) / 3) + 8);
    const result = readPrintPayload(huge);
    expect(result.ok).toBe(false);
    expect(String(result.detail)).toContain(String(MAX_RAW_PAYLOAD_BYTES));
  });
});
